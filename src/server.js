/**
 * PayFlow API Server Entry Point
 *
 * Startup order matters:
 * 1. Load config (env vars)
 * 2. Connect to dependencies
 * 3. Register middleware (order matters in Express)
 * 4. Register routes
 * 5. Register error handlers (must come LAST)
 * 6. Start listening
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const config = require('./config');
const logger = require('./utils/logger');
const requestLogger = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const paymentRoutes = require('./routes/paymentRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const healthRoutes = require('./routes/healthRoutes');

const app = express();

// ── Core Middleware ──────────────────────────────────────────────────────────
// Trust first proxy (for correct IP in rate limiter when behind nginx/load balancer)
app.set('trust proxy', 1);

// Parse JSON bodies — limit prevents JSON bomb attacks
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Log every HTTP request
app.use(requestLogger);

// ── Static Files (Frontend) ──────────────────────────────────────────────────
// Serve the frontend from /public
// index.html will be served at GET /
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Swagger UI ───────────────────────────────────────────────────────────────
try {
  const swaggerDoc = YAML.load(path.join(__dirname, '..', 'openapi.yaml'));
  app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerDoc, {
    customSiteTitle: 'PayFlow API Docs',
    customCss: '.swagger-ui .topbar { background-color: #1a1a2e; }',
  }));
  logger.info('Swagger UI available at /swagger');
} catch (err) {
  logger.warn({ err }, 'Could not load OpenAPI spec — Swagger UI disabled');
}

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/health', healthRoutes);
app.use('/payments', paymentRoutes);
app.use('/webhook', webhookRoutes);

// ── Error Handling (MUST be last) ────────────────────────────────────────────
// 404 for unmatched routes
app.use(notFoundHandler);
// Global error handler — catches everything thrown in route handlers
app.use(errorHandler);

// ── Start Server ─────────────────────────────────────────────────────────────
// `require.main === module` is true only when this file is run directly:
//   node src/server.js       → true  → starts listening
//   require('./server')      → false → exports app without binding a port
//
// This is critical for tests: supertest creates its own ephemeral server
// binding. If server.js also calls listen(), you get EADDRINUSE when
// multiple test files import this module in the same Jest run.
const PORT = config.api.port;
let server;

if (require.main === module) {
  server = app.listen(PORT, () => {
    logger.info({ port: PORT, env: config.env }, 'PayFlow API server started');
    logger.info(`Dashboard: http://localhost:${PORT}`);
    logger.info(`Swagger:   http://localhost:${PORT}/swagger`);
    logger.info(`Health:    http://localhost:${PORT}/health`);
  });
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────
// When Docker stops the container (SIGTERM), finish in-flight requests,
// then close connections cleanly. This prevents dropped requests during deploys.
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutting down API server gracefully...');

  const closeServer = server
    ? new Promise((resolve) => server.close(resolve))
    : Promise.resolve();

  closeServer.then(async () => {
    logger.info('HTTP server closed — no new requests accepted');

    try {
      const { close: closeDb } = require('./database/connection');
      const { close: closeRedis } = require('./locks/redisLock');
      const { close: closeRabbit } = require('./messaging/rabbitmq');

      await Promise.allSettled([closeDb(), closeRedis(), closeRabbit()]);
      logger.info('All connections closed — exiting');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  });

  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection — this is a bug');
});

module.exports = app; // export for testing
