const paymentRepo = require('../repositories/paymentRepository');
const { record, AUDIT_EVENTS } = require('../audit/auditService');
const { publishPaymentProcess } = require('../messaging/rabbitmq');
const { assertTransition, isTerminal, STATES } = require('../state-machine/paymentStateMachine');
const logger = require('../utils/logger');

/**
 * Payment Service — owns the business logic for payment creation and retrieval.
 * The worker owns the processing logic (see paymentProcessor.js).
 *
 * Controller → Service → Repository
 * Services orchestrate, repositories persist, controllers handle HTTP.
 */

/**
 * Create a payment or return existing if idempotency key already used.
 *
 * Idempotency guarantee:
 * The DB has a UNIQUE constraint on idempotency_key.
 * We check BEFORE inserting for a fast path (returns existing payment immediately).
 * Even if two requests race past the check simultaneously, the UNIQUE constraint
 * ensures only one INSERT succeeds — the loser gets a DB conflict error, which
 * we handle by returning the existing record.
 */
async function createPayment({ amount, idempotencyKey }) {
  logger.info({ idempotencyKey, amount }, 'Creating payment');

  // Fast-path: check if this key was already used
  const existing = await paymentRepo.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info({ paymentId: existing.id, idempotencyKey }, 'Returning existing payment (idempotency)');
    return { payment: existing, isNew: false };
  }

  let payment;
  try {
    payment = await paymentRepo.create({ amount, idempotencyKey });
  } catch (err) {
    // Unique constraint violation — another concurrent request won the race
    if (err.code === '23505') {
      const existing2 = await paymentRepo.findByIdempotencyKey(idempotencyKey);
      logger.info({ paymentId: existing2?.id }, 'Idempotency key race — returning existing');
      return { payment: existing2, isNew: false };
    }
    throw err;
  }

  // Audit event: payment born
  await record({
    paymentId: payment.id,
    eventType: AUDIT_EVENTS.PAYMENT_CREATED,
    metadata: { amount, idempotencyKey },
  });

  // Publish to RabbitMQ — worker will pick this up and process asynchronously
  await publishPaymentProcess(payment.id, 0, 'INITIAL');

  logger.info({ paymentId: payment.id }, 'Payment created and queued for processing');
  return { payment, isNew: true };
}

async function getPayment(id) {
  const payment = await paymentRepo.findById(id);
  if (!payment) {
    const err = new Error(`Payment not found: ${id}`);
    err.statusCode = 404;
    throw err;
  }
  return payment;
}

async function listPayments({ status, limit, offset }) {
  return paymentRepo.findAll({ status, limit, offset });
}

async function getPaymentEvents(id) {
  // Verify payment exists first
  await getPayment(id);
  const eventRepo = require('../repositories/eventRepository');
  return eventRepo.findByPaymentId(id);
}

/**
 * Calculate exponential backoff delay.
 *
 * Formula: baseDelay * (2 ^ retryCount)
 * Attempt 1: 2000 * 2^0 = 2s
 * Attempt 2: 2000 * 2^1 = 4s
 * Attempt 3: 2000 * 2^2 = 8s
 *
 * Why exponential? If the gateway is struggling, hammering it at fixed
 * intervals makes it worse. Exponential backoff gives it breathing room.
 */
function calculateRetryDelay(retryCount) {
  const config = require('../config');
  return config.retry.baseDelayMs * Math.pow(2, retryCount);
}

/**
 * Check if payment is eligible for retry.
 */
function isRetryEligible(payment) {
  return (
    !isTerminal(payment.status) &&
    payment.retryCount < payment.maxRetries
  );
}

module.exports = {
  createPayment,
  getPayment,
  listPayments,
  getPaymentEvents,
  calculateRetryDelay,
  isRetryEligible,
};
