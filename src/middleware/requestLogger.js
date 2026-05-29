const logger = require('../utils/logger');

/**
 * HTTP request/response logger middleware.
 *
 * Logs every request with method, url, status, and duration.
 * Duration is measured from when the request arrives to when the response is sent.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]({
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      durationMs: duration,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    }, 'HTTP request');
  });

  next();
}

module.exports = requestLogger;
