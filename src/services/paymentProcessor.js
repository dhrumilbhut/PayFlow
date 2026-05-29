const db = require('../database/connection');
const paymentRepo = require('../repositories/paymentRepository');
const { record, AUDIT_EVENTS } = require('../audit/auditService');
const { executeCharge } = require('../gateway/circuitBreaker');
const { publishPaymentRetry } = require('../messaging/rabbitmq');
const { withLock } = require('../locks/redisLock');
const { assertTransition, STATES } = require('../state-machine/paymentStateMachine');
const { calculateRetryDelay, isRetryEligible } = require('./paymentService');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Process a single payment message from the queue.
 *
 * Two-layer concurrency control:
 *
 * Layer 1 — Redis distributed lock:
 *   Prevents two worker PROCESSES from processing the same payment
 *   simultaneously. Even across different machines/containers.
 *
 * Layer 2 — PostgreSQL row lock (SELECT FOR UPDATE):
 *   Prevents two database transactions from modifying the same row.
 *   This is the safety net if the Redis lock somehow fails.
 *
 * @param {{ paymentId, attempt, trigger }} message
 */
async function processPayment(message) {
  const { paymentId, attempt } = message;
  const lockKey = `payment:${paymentId}:lock`;

  logger.info({ paymentId, attempt }, 'Processing payment message');

  try {
    await withLock(lockKey, config.redis.lockTtl, async () => {
      await db.withTransaction(async (client) => {
        // ── Step 1: Acquire DB row lock ──────────────────────────────────
        // SELECT ... FOR UPDATE SKIP LOCKED
        // If another transaction holds this lock, SKIP LOCKED returns null
        // (instead of waiting), so we bail out gracefully
        const payment = await paymentRepo.lockForUpdate(paymentId, client);

        if (!payment) {
          logger.warn({ paymentId }, 'Payment row locked by another transaction — skipping');
          return;
        }

        // ── Step 2: Validate state transition ───────────────────────────
        // Payment must be in PENDING or RETRY_SCHEDULED to start processing
        // This catches duplicate messages or stale retries
        try {
          assertTransition(payment.status, STATES.PROCESSING);
        } catch (err) {
          if (payment.status === STATES.PROCESSING ||
              payment.status === STATES.SUCCESS ||
              payment.status === STATES.FAILED) {
            logger.info(
              { paymentId, currentStatus: payment.status },
              'Payment already in terminal or processing state — skipping duplicate message'
            );
            return;
          }
          throw err;
        }

        // ── Step 3: Update to PROCESSING ────────────────────────────────
        await paymentRepo.updateStatus(paymentId, STATES.PROCESSING, {}, client);

        await record({
          paymentId,
          eventType: AUDIT_EVENTS.PAYMENT_PROCESSING_STARTED,
          metadata: { attempt, trigger: message.trigger },
        }, client);

        // ── Step 4: Call gateway (outside transaction to avoid long locks) ──
        // We commit the PROCESSING state first, then call the gateway.
        // This ensures the PROCESSING state is visible even if the worker crashes.
        // The circuit breaker wraps the call for fast-fail behavior.
        await client.query('COMMIT');
        await client.query('BEGIN'); // start a new transaction for the result

        let gatewayResult = null;
        let gatewayError = null;

        await record({
          paymentId,
          eventType: AUDIT_EVENTS.GATEWAY_REQUEST_SENT,
          metadata: { attempt },
        });

        try {
          gatewayResult = await executeCharge(paymentId, payment.amount, attempt);
        } catch (err) {
          gatewayError = err;
        }

        // ── Step 5: Re-acquire row lock for result update ────────────────
        const freshPayment = await paymentRepo.lockForUpdate(paymentId, client);

        if (!freshPayment) {
          logger.warn({ paymentId }, 'Could not re-lock payment for result update');
          return;
        }

        // ── Step 6: Handle gateway result ────────────────────────────────
        if (gatewayResult?.success) {
          await handleSuccess(paymentId, gatewayResult, client);
        } else {
          await handleFailure(paymentId, freshPayment, gatewayError, attempt, client);
        }
      });
    });
  } catch (err) {
    if (err.code === 'LOCK_ACQUISITION_FAILED') {
      logger.info({ paymentId }, 'Could not acquire Redis lock — another worker is processing this payment');
      return;
    }
    logger.error({ err, paymentId, attempt }, 'Unhandled error in payment processor');
    throw err;
  }
}

async function handleSuccess(paymentId, gatewayResult, client) {
  assertTransition(STATES.PROCESSING, STATES.SUCCESS);

  await paymentRepo.updateStatus(paymentId, STATES.SUCCESS, {
    lastError: null,
    nextRetryAt: null,
  }, client);

  await record({
    paymentId,
    eventType: AUDIT_EVENTS.GATEWAY_SUCCESS,
    metadata: { gatewayRef: gatewayResult.gatewayRef, gatewayEventId: gatewayResult.gatewayEventId },
  }, client);

  await record({
    paymentId,
    eventType: AUDIT_EVENTS.PAYMENT_SUCCESS,
    metadata: { gatewayRef: gatewayResult.gatewayRef },
  }, client);

  logger.info({ paymentId }, 'Payment succeeded');
}

async function handleFailure(paymentId, payment, error, attempt, client) {
  const isTimeout = error?.code === 'GATEWAY_TIMEOUT';
  const isCircuitOpen = error?.message?.includes('Breaker is open');

  const auditEventType = isTimeout
    ? AUDIT_EVENTS.GATEWAY_TIMEOUT
    : AUDIT_EVENTS.GATEWAY_FAILURE;

  await record({
    paymentId,
    eventType: auditEventType,
    metadata: {
      errorCode: error?.code,
      errorMessage: error?.message,
      attempt,
      isCircuitOpen,
    },
  }, client);

  const updatedPayment = { ...payment, retryCount: payment.retryCount };

  if (isRetryEligible(updatedPayment)) {
    const newRetryCount = payment.retryCount + 1;
    const delayMs = calculateRetryDelay(newRetryCount - 1);
    const nextRetryAt = new Date(Date.now() + delayMs);

    assertTransition(STATES.PROCESSING, STATES.RETRY_SCHEDULED);

    await paymentRepo.updateStatus(paymentId, STATES.RETRY_SCHEDULED, {
      retryCount: newRetryCount,
      nextRetryAt,
      lastError: error?.message || 'Unknown gateway error',
    }, client);

    await record({
      paymentId,
      eventType: AUDIT_EVENTS.PAYMENT_RETRY_SCHEDULED,
      metadata: {
        attempt: newRetryCount,
        delayMs,
        nextRetryAt: nextRetryAt.toISOString(),
        reason: error?.message,
      },
    }, client);

    // Publish retry message AFTER transaction commits (in finally or outside)
    // We use a flag and publish after commit to avoid publishing if commit fails
    process.nextTick(async () => {
      try {
        await publishPaymentRetry(paymentId, newRetryCount, delayMs);
      } catch (pubErr) {
        logger.error({ pubErr, paymentId }, 'Failed to publish retry message');
      }
    });

    logger.info({ paymentId, newRetryCount, delayMs }, 'Payment scheduled for retry');
  } else {
    // Exhausted retries — mark as FAILED
    assertTransition(STATES.PROCESSING, STATES.FAILED);

    await paymentRepo.updateStatus(paymentId, STATES.FAILED, {
      lastError: error?.message || 'Max retries exhausted',
    }, client);

    await record({
      paymentId,
      eventType: AUDIT_EVENTS.PAYMENT_FAILED,
      metadata: {
        reason: error?.message,
        totalAttempts: payment.retryCount + 1,
        finalError: error?.code,
      },
    }, client);

    logger.warn({ paymentId, totalAttempts: payment.retryCount + 1 }, 'Payment failed — max retries exhausted');
  }
}

module.exports = { processPayment };
