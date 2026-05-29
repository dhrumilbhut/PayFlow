const db = require('../database/connection');
const paymentRepo = require('../repositories/paymentRepository');
const webhookRepo = require('../repositories/webhookRepository');
const { record, AUDIT_EVENTS } = require('../audit/auditService');
const { withLock } = require('../locks/redisLock');
const { canTransition, isTerminal, STATES } = require('../state-machine/paymentStateMachine');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Process an incoming webhook from the gateway.
 *
 * Must be idempotent: processing the same webhook twice = same outcome.
 * Must handle race conditions with the worker (Redis lock).
 * Must handle out-of-order delivery (state machine guards).
 *
 * Conflict resolution:
 *   - Duplicate webhook (same externalEventId): ignore, return success
 *   - Payment already SUCCESS: ignore additional webhooks
 *   - Webhook SUCCESS arrives after FAILED: allow reconciliation
 *     (Gateway says it succeeded even though we marked it failed)
 *   - Webhook FAILED arrives after SUCCESS: ignore (trust SUCCESS)
 *
 * Why allow SUCCESS after FAILED?
 *   A FAILED state usually means our retries were exhausted.
 *   But if the GATEWAY says it succeeded (webhook), the money moved.
 *   We should reconcile to SUCCESS to avoid customer confusion.
 *   This is documented behavior, not a bug.
 */
async function processWebhook({ externalEventId, paymentId, status, payload }) {
  logger.info({ externalEventId, paymentId, status }, 'Webhook received');

  // ── Step 1: Deduplication ────────────────────────────────────────────────
  // Check if this exact webhook event was already processed
  const existing = await webhookRepo.findByExternalEventId(externalEventId);
  if (existing) {
    logger.info({ externalEventId, paymentId }, 'Duplicate webhook — already processed, ignoring');
    return { duplicate: true, payment: null };
  }

  // ── Step 2: Acquire lock and process ────────────────────────────────────
  // Use same Redis lock key as worker to prevent race condition:
  // webhook arrives while worker is still processing
  const lockKey = `payment:${paymentId}:lock`;

  return withLock(lockKey, config.redis.lockTtl, async () => {
    return db.withTransaction(async (client) => {
      // Lock the payment row for this transaction
      const payment = await paymentRepo.lockForUpdate(paymentId, client);

      if (!payment) {
        logger.warn({ paymentId }, 'Payment not found for webhook');
        const err = new Error(`Payment not found: ${paymentId}`);
        err.statusCode = 404;
        throw err;
      }

      // Record receipt in webhook deduplication table
      // Insert FIRST — if the webhook is a duplicate this will throw a unique violation
      // (race between the check above and this insert)
      try {
        await webhookRepo.create({ externalEventId, paymentId, payload }, client);
      } catch (err) {
        if (err.code === '23505') {
          // Another concurrent request already inserted this webhook
          logger.info({ externalEventId }, 'Webhook duplicate insert race — already handled');
          return { duplicate: true, payment: null };
        }
        throw err;
      }

      // Record the webhook arrival in audit trail
      await record({
        paymentId,
        eventType: AUDIT_EVENTS.WEBHOOK_RECEIVED,
        metadata: { externalEventId, webhookStatus: status, currentPaymentStatus: payment.status },
      }, client);

      // ── Step 3: Determine what to do based on current state ─────────────
      const desiredStatus = status === 'SUCCESS' ? STATES.SUCCESS : STATES.FAILED;

      if (isTerminal(payment.status)) {
        if (payment.status === desiredStatus) {
          // Already in desired state — webhook confirms what we know
          logger.info({ paymentId, status: payment.status }, 'Webhook confirms existing terminal state');
          return { duplicate: false, payment, action: 'CONFIRMED' };
        }

        if (payment.status === STATES.FAILED && desiredStatus === STATES.SUCCESS) {
          // Reconciliation: gateway says SUCCESS but we marked FAILED.
          // The money moved — we must reconcile to SUCCESS.
          logger.warn({ paymentId }, 'Reconciling FAILED payment to SUCCESS based on gateway webhook');
          const updated = await paymentRepo.updateStatus(
            paymentId, STATES.SUCCESS,
            { lastError: null, nextRetryAt: null },
            client
          );
          await record({
            paymentId,
            eventType: AUDIT_EVENTS.PAYMENT_SUCCESS,
            metadata: { reconciled: true, via: 'webhook', externalEventId },
          }, client);
          return { duplicate: false, payment: updated, action: 'RECONCILED' };
        }

        // SUCCESS + FAILED webhook or SUCCESS + SUCCESS webhook already handled above
        logger.info({ paymentId, current: payment.status, webhook: desiredStatus },
          'Webhook ignored — conflicting terminal state');
        return { duplicate: false, payment, action: 'IGNORED' };
      }

      // ── Step 4: Payment not yet terminal — apply webhook status ─────────
      // This handles the case where the webhook arrives before the worker finishes
      if (canTransition(payment.status, desiredStatus)) {
        const updated = await paymentRepo.updateStatus(paymentId, desiredStatus, {}, client);
        const eventType = desiredStatus === STATES.SUCCESS
          ? AUDIT_EVENTS.PAYMENT_SUCCESS
          : AUDIT_EVENTS.PAYMENT_FAILED;

        await record({
          paymentId,
          eventType,
          metadata: { via: 'webhook', externalEventId },
        }, client);

        logger.info({ paymentId, desiredStatus }, 'Payment updated via webhook');
        return { duplicate: false, payment: updated, action: 'UPDATED' };
      }

      // Can't transition to desired state from current state
      logger.info(
        { paymentId, current: payment.status, desired: desiredStatus },
        'Webhook received but cannot transition in current state — will be handled by worker'
      );
      return { duplicate: false, payment, action: 'DEFERRED' };
    });
  });
}

module.exports = { processWebhook };
