/**
 * Payment Worker Process
 *
 * This process runs independently from the API server.
 * It consumes messages from the payment.process.queue and processes payments.
 *
 * Why separate process (not just a background task in the API)?
 * - Independent scaling: more load = more worker containers
 * - Fault isolation: worker crash doesn't affect API
 * - Different operational concern: no HTTP, just message consumption
 * - Clean separation of concerns
 */

require('dotenv').config();

const { connect } = require('../messaging/rabbitmq');
const { processPayment } = require('../services/paymentProcessor');
const { startWatchdog } = require('../services/recoveryService');
const config = require('../config');
const logger = require('../utils/logger');

const QUEUE = config.rabbitmq.processQueue;

let watchdogTimer = null;

async function startWorker() {
  logger.info('Starting payment worker...');

  // RabbitMQ will retry connection with backoff
  let channel;
  while (!channel) {
    try {
      channel = await connect();
    } catch (err) {
      logger.error({ err }, 'Failed to connect to RabbitMQ, retrying in 5s...');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  logger.info({ queue: QUEUE }, 'Worker consuming from queue');

  channel.consume(QUEUE, async (msg) => {
    if (!msg) {
      // Null message = consumer cancelled by RabbitMQ (server-side)
      logger.warn('Consumer cancelled by RabbitMQ');
      return;
    }

    let message;
    try {
      message = JSON.parse(msg.content.toString());
    } catch (err) {
      // Malformed message — reject without requeue (it will never parse)
      logger.error({ err, content: msg.content.toString() }, 'Malformed message — dead-lettering');
      channel.nack(msg, false, false); // false, false = don't requeue
      return;
    }

    logger.info({ message }, 'Received payment message');

    try {
      await processPayment(message);
      // ack = tell RabbitMQ the message was processed successfully
      // RabbitMQ will remove it from the queue
      channel.ack(msg);
      logger.info({ paymentId: message.paymentId }, 'Message acknowledged');
    } catch (err) {
      logger.error({ err, message }, 'Failed to process payment message');

      // nack with requeue=false: don't put it back in the queue
      // In production you'd want a separate dead-letter queue for poison messages
      // For now we reject to avoid infinite redelivery loops
      channel.nack(msg, false, false);
    }
  });

  logger.info('Worker is ready and listening for messages');

  // Start recovery watchdog — scans every 30s for payments stuck in
  // PROCESSING/RETRY_SCHEDULED due to worker crashes. Re-queues them.
  watchdogTimer = startWatchdog(30000);
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
// When Docker stops the container, it sends SIGTERM.
// We finish current message processing, then exit cleanly.
async function shutdown(signal) {
  logger.info({ signal }, 'Worker shutting down gracefully...');
  if (watchdogTimer) clearInterval(watchdogTimer);
  const { close: closeRabbit } = require('../messaging/rabbitmq');
  const { close: closeRedis } = require('../locks/redisLock');
  const { close: closeDb } = require('../database/connection');

  try {
    await closeRabbit();
    await closeRedis();
    await closeDb();
    logger.info('Worker shut down cleanly');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Unhandled promise rejection — log and continue (don't crash the worker)
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection in worker');
});

startWorker().catch((err) => {
  logger.error({ err }, 'Worker startup failed');
  process.exit(1);
});
