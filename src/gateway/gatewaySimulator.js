const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Simulated external payment gateway.
 *
 * In production this would be an HTTP call to Stripe/Adyen/etc.
 * Here we simulate realistic behavior:
 *   70% → SUCCESS
 *   20% → FAILURE (declined, insufficient funds, etc.)
 *   10% → TIMEOUT (worst case: we don't know what happened)
 *
 * The gateway also sends webhook callbacks asynchronously.
 * This simulates how real gateways work — they send webhooks
 * AFTER processing, independently of the API response.
 */

const OUTCOMES = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  TIMEOUT: 'TIMEOUT',
};

/**
 * Simulate processing delay (network latency + gateway processing time).
 */
function simulateDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine the outcome based on configured probabilities.
 * Using cumulative probability ranges:
 *   0-69  → SUCCESS (70%)
 *   70-89 → FAILURE (20%)
 *   90-99 → TIMEOUT (10%)
 */
function determineOutcome() {
  const roll = Math.floor(Math.random() * 100);
  const { successRate, failureRate } = config.gateway;

  if (roll < successRate) return OUTCOMES.SUCCESS;
  if (roll < successRate + failureRate) return OUTCOMES.FAILURE;
  return OUTCOMES.TIMEOUT;
}

/**
 * Send a webhook callback to our own API.
 * This is fire-and-forget (no await) to simulate async real-world behavior.
 * The webhook may arrive before or after the gateway call resolves.
 */
function sendWebhookAsync(paymentId, eventId, outcome) {
  // Random delay before sending webhook (0–4 seconds)
  // This tests out-of-order delivery and race conditions
  const webhookDelay = Math.floor(Math.random() * 4000);

  setTimeout(() => {
    const payload = JSON.stringify({
      eventId,
      paymentId,
      status: outcome === OUTCOMES.SUCCESS ? 'SUCCESS' : 'FAILED',
      timestamp: new Date().toISOString(),
      gatewayReference: `GW-${uuidv4().slice(0, 8).toUpperCase()}`,
    });

    const webhookUrl = config.gateway.webhookUrl;
    const isHttps = webhookUrl.startsWith('https');
    const urlObj = new URL(webhookUrl);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Gateway-Signature': `sha256=${eventId}`, // simulated signature
      },
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      logger.info(
        { paymentId, eventId, statusCode: res.statusCode },
        'Webhook delivered'
      );
    });

    req.on('error', (err) => {
      logger.warn({ err, paymentId, eventId }, 'Webhook delivery failed');
    });

    req.write(payload);
    req.end();
  }, webhookDelay);
}

/**
 * Main gateway charge function.
 *
 * @param {string} paymentId
 * @param {number} amount
 * @param {number} attempt - which retry attempt this is
 * @returns {{ success: boolean, gatewayRef: string|null, error: string|null }}
 */
async function charge(paymentId, amount, attempt = 0) {
  const gatewayEventId = uuidv4();

  // Simulate network + processing delay (0–3 seconds)
  const delay = Math.floor(Math.random() * 3000);
  await simulateDelay(delay);

  const outcome = determineOutcome();

  logger.info(
    { paymentId, amount, attempt, outcome, gatewayEventId, delayMs: delay },
    'Gateway charge attempt'
  );

  if (outcome === OUTCOMES.TIMEOUT) {
    // For timeouts we still send a webhook eventually (gateway processed it
    // but our connection timed out). This is the most dangerous scenario.
    sendWebhookAsync(paymentId, gatewayEventId, OUTCOMES.SUCCESS);

    const err = new Error('Gateway timeout');
    err.code = 'GATEWAY_TIMEOUT';
    err.gatewayEventId = gatewayEventId;
    throw err;
  }

  if (outcome === OUTCOMES.FAILURE) {
    sendWebhookAsync(paymentId, gatewayEventId, OUTCOMES.FAILURE);
    const err = new Error('Payment declined by gateway');
    err.code = 'GATEWAY_FAILURE';
    err.gatewayEventId = gatewayEventId;
    throw err;
  }

  // SUCCESS — send webhook and return result
  sendWebhookAsync(paymentId, gatewayEventId, OUTCOMES.SUCCESS);

  return {
    success: true,
    gatewayRef: `GW-${uuidv4().slice(0, 8).toUpperCase()}`,
    gatewayEventId,
  };
}

module.exports = { charge, OUTCOMES };
