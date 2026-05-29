const logger = require('../utils/logger');

/**
 * Global Express error handling middleware.
 *
 * Express identifies error handlers by their 4-argument signature (err, req, res, next).
 * Any unhandled error thrown in a route handler reaches here.
 *
 * Why centralize error handling?
 * - Consistent error format across all endpoints
 * - One place to add error monitoring (Sentry, etc.)
 * - Controllers stay clean — just throw, don't format errors
 */
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || err.status || 500;
  const isOperational = statusCode < 500;

  // Log all errors, but only include stack for 5xx
  if (isOperational) {
    logger.warn({ err, method: req.method, url: req.url }, 'Operational error');
  } else {
    logger.error({ err, method: req.method, url: req.url }, 'Unexpected server error');
  }

  // Never leak internal details (stack traces, DB errors) to the client
  const response = {
    error: isOperational ? err.message : 'Internal server error',
    code: err.code || 'INTERNAL_ERROR',
  };

  // In development, include the stack for easier debugging
  if (process.env.NODE_ENV === 'development' && !isOperational) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

/**
 * 404 handler — must come AFTER all routes.
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.url}`,
    code: 'NOT_FOUND',
  });
}

module.exports = { errorHandler, notFoundHandler };
