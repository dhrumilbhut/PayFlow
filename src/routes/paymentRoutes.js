const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { paymentRateLimiter } = require('../middleware/rateLimiter');
const {
  validateCreatePayment,
  validatePaymentId,
  validateListPayments,
  handleValidationErrors,
} = require('../validators/paymentValidator');

/**
 * Routes follow the pattern:
 * [middleware...] → [validation...] → handleValidationErrors → controller
 *
 * Rate limiter on POST /payments only — read endpoints don't need rate limiting.
 */

router.post(
  '/',
  paymentRateLimiter,
  validateCreatePayment,
  handleValidationErrors,
  paymentController.createPayment
);

// Stats endpoint must be declared BEFORE /:id so Express doesn't
// treat "stats" as a payment UUID. Route ordering matters in Express.
router.get('/stats', paymentController.getStats);

router.get(
  '/',
  validateListPayments,
  handleValidationErrors,
  paymentController.listPayments
);

router.get(
  '/:id',
  validatePaymentId,
  handleValidationErrors,
  paymentController.getPayment
);

router.get(
  '/:id/events',
  validatePaymentId,
  handleValidationErrors,
  paymentController.getPaymentEvents
);

module.exports = router;
