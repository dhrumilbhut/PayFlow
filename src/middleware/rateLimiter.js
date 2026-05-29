const rateLimit = require('express-rate-limit');
const config = require('../config');

/**
 * Rate limiter for POST /payments.
 *
 * Why rate limit payment creation specifically?
 * - Prevents automated abuse (card testing attacks, fraudulent submissions)
 * - Protects the gateway from being overwhelmed
 * - Typical production limit: 20 payments/min per IP
 *
 * In production you'd use Redis as the store (express-rate-limit/redis)
 * so limits work correctly across multiple API instances.
 * For this implementation, in-memory is fine for a single API container.
 */
const paymentRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,   // Include RateLimit-* headers in response
  legacyHeaders: false,
  message: {
    error: 'Too many payment requests. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  keyGenerator: (req) => req.ip, // rate limit per IP address
});

module.exports = { paymentRateLimiter };
