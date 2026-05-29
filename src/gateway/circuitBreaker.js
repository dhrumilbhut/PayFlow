const CircuitBreaker = require('opossum');
const { charge } = require('./gatewaySimulator');
const { record, AUDIT_EVENTS } = require('../audit/auditService');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Circuit Breaker wrapping the gateway charge function.
 *
 * States:
 *   CLOSED    → Normal operation. Calls pass through to gateway.
 *   OPEN      → Too many failures. Calls fail immediately (fast fail).
 *   HALF_OPEN → Testing recovery. One call allowed through.
 *
 * Configuration:
 *   errorThresholdPercentage: open circuit when >50% of calls fail
 *   volumeThreshold: don't open until at least 5 calls have been made
 *   resetTimeout: after 30s in OPEN state, try HALF_OPEN
 *   timeout: if the action takes longer than this, count it as a failure
 */
const breaker = new CircuitBreaker(charge, {
  errorThresholdPercentage: config.circuitBreaker.failureThreshold,
  volumeThreshold: config.circuitBreaker.volumeThreshold,
  resetTimeout: config.circuitBreaker.resetTimeout,
  timeout: config.gateway.timeoutMs,
  name: 'payment-gateway',
});

// ── Circuit breaker event listeners ───────────────────────────────────────

breaker.on('open', async () => {
  logger.warn('Circuit breaker OPENED — gateway calls will fail fast');
  // Record in audit without a paymentId (system-level event)
  // We use a synthetic payment ID for the audit event
  try {
    await record({
      paymentId: '00000000-0000-0000-0000-000000000000',
      eventType: AUDIT_EVENTS.CIRCUIT_BREAKER_OPENED,
      metadata: { state: 'OPEN', reason: 'Failure threshold exceeded' },
    });
  } catch (_err) {
    // Non-critical
  }
});

breaker.on('close', async () => {
  logger.info('Circuit breaker CLOSED — normal operation resumed');
  try {
    await record({
      paymentId: '00000000-0000-0000-0000-000000000000',
      eventType: AUDIT_EVENTS.CIRCUIT_BREAKER_CLOSED,
      metadata: { state: 'CLOSED' },
    });
  } catch (_err) {
    // Non-critical
  }
});

breaker.on('halfOpen', async () => {
  logger.info('Circuit breaker HALF-OPEN — testing recovery');
  try {
    await record({
      paymentId: '00000000-0000-0000-0000-000000000000',
      eventType: AUDIT_EVENTS.CIRCUIT_BREAKER_HALF_OPEN,
      metadata: { state: 'HALF_OPEN' },
    });
  } catch (_err) {
    // Non-critical
  }
});

breaker.on('fallback', (result) => {
  logger.warn({ result }, 'Circuit breaker fallback triggered');
});

breaker.on('reject', () => {
  logger.warn('Circuit breaker rejected call — circuit is OPEN');
});

/**
 * Execute a gateway charge through the circuit breaker.
 * The breaker wraps the underlying charge() function.
 */
async function executeCharge(paymentId, amount, attempt) {
  return breaker.fire(paymentId, amount, attempt);
}

function getState() {
  return {
    state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
    stats: breaker.stats,
  };
}

module.exports = { executeCharge, getState, breaker };
