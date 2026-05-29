const paymentService = require('../services/paymentService');
const { toExternalState } = require('../state-machine/paymentStateMachine');

/**
 * Payment Controller
 *
 * Responsibilities:
 * - Parse HTTP request (body, params, query)
 * - Call the service
 * - Format and send the HTTP response
 *
 * Must NOT contain business logic.
 * Must NOT contain SQL.
 * If it's more than 10 lines of logic, it probably belongs in a service.
 */

/**
 * Format a payment for the API response.
 * We expose externalStatus (not internal status) to consumers.
 */
function formatPayment(payment) {
  return {
    id: payment.id,
    amount: payment.amount,
    status: payment.externalStatus || toExternalState(payment.status),
    idempotencyKey: payment.idempotencyKey,
    retryCount: payment.retryCount,
    maxRetries: payment.maxRetries,
    lastError: payment.lastError,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

async function createPayment(req, res, next) {
  try {
    const { amount, idempotencyKey } = req.body;
    const { payment, isNew } = await paymentService.createPayment({ amount, idempotencyKey });

    // 201 for new payments, 200 for existing (idempotent return)
    const statusCode = isNew ? 201 : 200;
    res.status(statusCode).json({ data: formatPayment(payment) });
  } catch (err) {
    next(err);
  }
}

async function getPayment(req, res, next) {
  try {
    const payment = await paymentService.getPayment(req.params.id);
    res.json({ data: formatPayment(payment) });
  } catch (err) {
    next(err);
  }
}

async function listPayments(req, res, next) {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const payments = await paymentService.listPayments({
      status,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });
    res.json({ data: payments.map(formatPayment), count: payments.length });
  } catch (err) {
    next(err);
  }
}

async function getPaymentEvents(req, res, next) {
  try {
    const events = await paymentService.getPaymentEvents(req.params.id);
    res.json({ data: events });
  } catch (err) {
    next(err);
  }
}

async function getStats(req, res, next) {
  try {
    const paymentRepo = require('../repositories/paymentRepository');
    const stats = await paymentRepo.getStats();
    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
}

module.exports = { createPayment, getPayment, listPayments, getPaymentEvents, getStats };
