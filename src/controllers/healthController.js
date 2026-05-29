const db = require('../database/connection');
const { checkHealth: checkRedis } = require('../locks/redisLock');
const { checkHealth: checkRabbitMQ } = require('../messaging/rabbitmq');
const { getState: getCircuitBreakerState } = require('../gateway/circuitBreaker');
const logger = require('../utils/logger');

/**
 * GET /health — fast liveness check
 * Used by Docker healthcheck and load balancers.
 * Must respond in < 100ms. Does NOT check dependencies.
 */
async function liveness(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}

/**
 * GET /health/dependencies — full readiness check
 * Checks all external dependencies.
 * Used by orchestration systems to determine if this instance can serve traffic.
 */
async function dependencies(req, res) {
  const checks = await Promise.allSettled([
    db.checkHealth().then(() => ({ name: 'postgres', status: 'ok' })),
    checkRedis().then(() => ({ name: 'redis', status: 'ok' })),
    checkRabbitMQ().then(() => ({ name: 'rabbitmq', status: 'ok' })),
  ]);

  const results = checks.map((c, i) => {
    const names = ['postgres', 'redis', 'rabbitmq'];
    if (c.status === 'fulfilled') return c.value;
    logger.warn({ dependency: names[i], err: c.reason }, 'Dependency health check failed');
    return { name: names[i], status: 'error', error: c.reason?.message };
  });

  const allHealthy = results.every((r) => r.status === 'ok');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    dependencies: results,
    circuitBreaker: getCircuitBreakerState(),
  });
}

module.exports = { liveness, dependencies };
