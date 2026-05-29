const eventRepo = require('../repositories/eventRepository');
const logger = require('../utils/logger');

/**
 * All possible audit event types.
 * Using constants prevents typos and makes event names grep-able.
 */
const AUDIT_EVENTS = {
  PAYMENT_CREATED: 'PAYMENT_CREATED',
  PAYMENT_PROCESSING_STARTED: 'PAYMENT_PROCESSING_STARTED',
  GATEWAY_REQUEST_SENT: 'GATEWAY_REQUEST_SENT',
  GATEWAY_SUCCESS: 'GATEWAY_SUCCESS',
  GATEWAY_FAILURE: 'GATEWAY_FAILURE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
  PAYMENT_RETRY_SCHEDULED: 'PAYMENT_RETRY_SCHEDULED',
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  WEBHOOK_RECEIVED: 'WEBHOOK_RECEIVED',
  WEBHOOK_DUPLICATE: 'WEBHOOK_DUPLICATE',
  CIRCUIT_BREAKER_OPENED: 'CIRCUIT_BREAKER_OPENED',
  CIRCUIT_BREAKER_CLOSED: 'CIRCUIT_BREAKER_CLOSED',
  CIRCUIT_BREAKER_HALF_OPEN: 'CIRCUIT_BREAKER_HALF_OPEN',
};

/**
 * Record an audit event. Never throws — audit failures must not
 * crash the main payment flow. We log the error instead.
 *
 * @param {object} params
 * @param {string} params.paymentId
 * @param {string} params.eventType  - one of AUDIT_EVENTS
 * @param {object} params.metadata   - any additional context
 * @param {object} [client]          - optional DB transaction client
 */
async function record({ paymentId, eventType, metadata = {} }, client = null) {
  try {
    const event = await eventRepo.create({ paymentId, eventType, metadata }, client);
    logger.info({ paymentId, eventType, metadata }, 'Audit event recorded');
    return event;
  } catch (err) {
    // Audit failures should NOT crash payment processing.
    // Log and continue. In a real system you'd also send to a dead-letter queue.
    logger.error({ err, paymentId, eventType }, 'Failed to record audit event');
  }
}

module.exports = { record, AUDIT_EVENTS };
