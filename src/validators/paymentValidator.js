const { body, param, query, validationResult } = require('express-validator');

/**
 * Validation middleware using express-validator.
 *
 * Why validate here and not in the service?
 * - Services should receive already-validated data
 * - HTTP-specific validation (format, presence) belongs at the HTTP layer
 * - Services can be called from anywhere (CLI, tests, workers), not just HTTP
 */

const validateCreatePayment = [
  body('amount')
    .isFloat({ gt: 0 })
    .withMessage('amount must be a positive number')
    .isFloat({ max: 999999.99 })
    .withMessage('amount exceeds maximum allowed value'),

  body('idempotencyKey')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('idempotencyKey is required')
    .isLength({ max: 255 })
    .withMessage('idempotencyKey must be 255 characters or fewer'),
];

const validatePaymentId = [
  param('id')
    .isUUID()
    .withMessage('id must be a valid UUID'),
];

const validateListPayments = [
  query('status')
    .optional()
    .isIn(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'])
    .withMessage('status must be one of: PENDING, PROCESSING, SUCCESS, FAILED'),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be between 1 and 100'),

  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('offset must be a non-negative integer'),
];

const validateWebhook = [
  body('eventId').isString().notEmpty().withMessage('eventId is required'),
  body('paymentId').isUUID().withMessage('paymentId must be a valid UUID'),
  body('status').isIn(['SUCCESS', 'FAILED']).withMessage('status must be SUCCESS or FAILED'),
];

/**
 * Middleware that checks validation results and returns 422 if invalid.
 * Use after any of the above validators in a route.
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: 'Validation failed',
      details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

module.exports = {
  validateCreatePayment,
  validatePaymentId,
  validateListPayments,
  validateWebhook,
  handleValidationErrors,
};
