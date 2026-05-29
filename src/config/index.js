require('dotenv').config();

/**
 * Centralized configuration.
 *
 * Railway injects these standard variables automatically:
 *   PORT         → the port Railway wants the app to bind to
 *   DATABASE_URL → full postgres connection string
 *   REDIS_URL    → full redis connection string
 *
 * We prefer these over individual vars so the same code works
 * locally (with .env) and on Railway (with injected vars).
 */
const config = {
  env:         process.env.NODE_ENV   || 'development',
  serviceName: process.env.SERVICE_NAME || 'payflow-api',

  api: {
    // Railway injects PORT. API_PORT is our local override.
    port: parseInt(process.env.PORT || process.env.API_PORT, 10) || 3000,
  },

  db: {
    // DATABASE_URL takes priority (Railway, Heroku, Render, etc.)
    // Falls back to individual vars for local Docker Compose.
    connectionString: process.env.DATABASE_URL || null,
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    name:     process.env.DB_NAME     || 'payflow',
    user:     process.env.DB_USER     || 'payflow',
    password: process.env.DB_PASSWORD || 'payflow_secret',
    pool: {
      min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
      max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
    },
  },

  redis: {
    // REDIS_URL takes priority (Railway, Upstash, etc.)
    url:      process.env.REDIS_URL      || null,
    host:     process.env.REDIS_HOST     || 'localhost',
    port:     parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    lockTtl:  parseInt(process.env.REDIS_LOCK_TTL, 10) || 30000,
  },

  rabbitmq: {
    // RABBITMQ_URL set manually — use CloudAMQP free tier on Railway
    url:          process.env.RABBITMQ_URL          || 'amqp://guest:guest@localhost:5672',
    exchange:     process.env.RABBITMQ_EXCHANGE      || 'payment.exchange',
    processQueue: process.env.RABBITMQ_PROCESS_QUEUE || 'payment.process.queue',
    retryQueue:   process.env.RABBITMQ_RETRY_QUEUE   || 'payment.retry.queue',
    dlxExchange:  process.env.RABBITMQ_DLX_EXCHANGE  || 'payment.dlx.exchange',
  },

  gateway: {
    timeoutMs:   parseInt(process.env.GATEWAY_TIMEOUT_MS,  10) || 5000,
    successRate: parseInt(process.env.GATEWAY_SUCCESS_RATE, 10) || 70,
    failureRate: parseInt(process.env.GATEWAY_FAILURE_RATE, 10) || 20,
    timeoutRate: parseInt(process.env.GATEWAY_TIMEOUT_RATE, 10) || 10,
    // IMPORTANT: set this to your deployed API URL on Railway
    webhookUrl: process.env.GATEWAY_WEBHOOK_URL || 'http://localhost:3000/webhook',
  },

  circuitBreaker: {
    failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 50,
    volumeThreshold:  parseInt(process.env.CB_VOLUME_THRESHOLD,  10) || 5,
    resetTimeout:     parseInt(process.env.CB_RESET_TIMEOUT,     10) || 30000,
  },

  retry: {
    baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS, 10) || 2000,
    maxRetries:  parseInt(process.env.MAX_RETRIES,          10) || 3,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS,    10) || 60000,
    max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS,  10) || 20,
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

module.exports = config;
