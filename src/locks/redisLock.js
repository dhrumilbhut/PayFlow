const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

// Single Redis client shared across the process.
// ioredis handles reconnects automatically.
let client;

function getClient() {
  if (!client) {
    const sharedOptions = {
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: false,
    };

    // REDIS_URL (Railway / Upstash) takes priority; fall back to individual vars
    client = config.redis.url
      ? new Redis(config.redis.url, sharedOptions)
      : new Redis({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password || undefined,
          ...sharedOptions,
        });

    client.on('error', (err) => logger.error({ err }, 'Redis client error'));
    client.on('connect', () => logger.info('Redis connected'));
  }
  return client;
}

/**
 * Acquire a distributed lock using SET NX EX (atomic operation).
 *
 * SET NX = "set only if Not eXists" — prevents two workers from
 * acquiring the same lock simultaneously. This is ATOMIC in Redis,
 * meaning no race condition is possible at the Redis level.
 *
 * We store a unique lockValue so only the owner can release it.
 * Without this, Worker A could accidentally release Worker B's lock.
 *
 * @returns {string|null} lockValue if acquired, null if already locked
 */
async function acquireLock(lockKey, ttlMs) {
  const redis = getClient();
  // Generate a unique token for this lock acquisition
  const lockValue = `${process.pid}:${Date.now()}:${Math.random()}`;
  const ttlSeconds = Math.ceil(ttlMs / 1000);

  // SET key value NX EX ttl
  // NX = only set if key does not exist
  // EX = expire after ttlSeconds
  const result = await redis.set(lockKey, lockValue, 'NX', 'EX', ttlSeconds);

  if (result === 'OK') {
    logger.debug({ lockKey, ttlMs }, 'Lock acquired');
    return lockValue;
  }

  logger.debug({ lockKey }, 'Lock already held by another worker');
  return null;
}

/**
 * Release a lock ONLY if we own it.
 *
 * We use a Lua script because we need check-then-delete to be ATOMIC.
 * Without Lua: check ownership → lock expires → another worker acquires →
 * we delete the new lock. Disaster. Lua runs atomically inside Redis.
 */
async function releaseLock(lockKey, lockValue) {
  const redis = getClient();

  // Lua script: only delete if the value matches (we own it)
  const luaScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  const result = await redis.eval(luaScript, 1, lockKey, lockValue);

  if (result === 1) {
    logger.debug({ lockKey }, 'Lock released');
  } else {
    logger.warn({ lockKey }, 'Lock was not owned by us (already expired or stolen)');
  }
}

/**
 * Convenience wrapper: acquire lock, run fn, always release.
 * If lock cannot be acquired, throws immediately (fail fast).
 */
async function withLock(lockKey, ttlMs, fn) {
  const lockValue = await acquireLock(lockKey, ttlMs);

  if (!lockValue) {
    const err = new Error(`Could not acquire lock for key: ${lockKey}`);
    err.code = 'LOCK_ACQUISITION_FAILED';
    throw err;
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockKey, lockValue);
  }
}

async function checkHealth() {
  const redis = getClient();
  await redis.ping();
  return true;
}

async function close() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = { acquireLock, releaseLock, withLock, checkHealth, getClient, close };
