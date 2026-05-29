const webhookService = require('../services/webhookService');
const logger = require('../utils/logger');

async function handleWebhook(req, res, next) {
  try {
    const { eventId, paymentId, status, ...rest } = req.body;

    const result = await webhookService.processWebhook({
      externalEventId: eventId,
      paymentId,
      status,
      payload: req.body,
    });

    if (result.duplicate) {
      return res.status(200).json({ message: 'Duplicate webhook — already processed' });
    }

    res.status(200).json({
      message: 'Webhook processed',
      action: result.action,
    });
  } catch (err) {
    // Always return 200 to the gateway (even on errors).
    // If we return 4xx/5xx, the gateway will retry, causing more load.
    // We handle idempotency ourselves; we don't need gateway retries.
    logger.error({ err, body: req.body }, 'Webhook processing error');

    // Exception: return real errors for non-gateway callers (debugging)
    if (err.statusCode === 404) {
      return next(err);
    }

    res.status(200).json({ message: 'Webhook received', error: 'Processing deferred' });
  }
}

module.exports = { handleWebhook };
