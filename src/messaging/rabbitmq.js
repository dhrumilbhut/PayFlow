const amqp = require('amqplib');
const config = require('../config');
const logger = require('../utils/logger');

let connection = null;
let channel = null;

/**
 * Connect to RabbitMQ and declare all exchanges, queues, and bindings.
 *
 * This is idempotent — calling it multiple times is safe because
 * assertExchange/assertQueue won't recreate existing resources.
 *
 * Topology (draw this out to understand the retry flow):
 *
 *  [API] ──publish──► payment.exchange ──routing_key: payment.process──► payment.process.queue
 *                                                                               │
 *                                                              Worker consumes  │
 *                                                                               ▼
 *                                                                          [Worker]
 *                                                                               │
 *                                                               on retry, publish to:
 *                                                                               │
 *                    payment.exchange ──routing_key: payment.retry──► payment.retry.queue
 *                                                                               │
 *                                                              TTL expires      │
 *                                                                               ▼
 *                                                              payment.dlx.exchange
 *                                                                               │
 *                                                                               ▼
 *                                                                    payment.process.queue (again!)
 */
async function connect() {
  if (channel) return channel;

  logger.info('Connecting to RabbitMQ...');
  connection = await amqp.connect(config.rabbitmq.url);

  connection.on('error', (err) => {
    logger.error({ err }, 'RabbitMQ connection error');
    connection = null;
    channel = null;
  });

  connection.on('close', () => {
    logger.warn('RabbitMQ connection closed');
    connection = null;
    channel = null;
  });

  channel = await connection.createChannel();

  // Prefetch 1: worker handles one message at a time.
  // Without this, RabbitMQ would push ALL queued messages to the worker at once.
  // With prefetch(1), RabbitMQ only sends the next message after the worker acks.
  channel.prefetch(1);

  await setupTopology(channel);

  logger.info('RabbitMQ connected and topology set up');
  return channel;
}

async function setupTopology(ch) {
  const { exchange, dlxExchange, processQueue, retryQueue } = config.rabbitmq;

  // ── Main exchange (direct type: route by exact routing key) ──────────────
  await ch.assertExchange(exchange, 'direct', { durable: true });

  // ── Dead Letter Exchange (catches expired retry messages) ────────────────
  await ch.assertExchange(dlxExchange, 'direct', { durable: true });

  // ── Process queue (main work queue) ─────────────────────────────────────
  // Messages that expire from retry queue get routed here via DLX
  await ch.assertQueue(processQueue, {
    durable: true, // survives RabbitMQ restart
    arguments: {
      // No TTL on process queue — messages wait here until worker picks them up
    },
  });
  await ch.bindQueue(processQueue, exchange, 'payment.process');

  // ── Retry queue (holding area for delayed retries) ───────────────────────
  // Messages go here with a TTL. When TTL expires, they're dead-lettered
  // to dlxExchange → routed back to processQueue. This IS the delay mechanism.
  await ch.assertQueue(retryQueue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': dlxExchange,
      'x-dead-letter-routing-key': 'payment.process',
      // Note: we do NOT set x-message-ttl here. Instead we set per-message
      // TTL when publishing (expiration property). This lets each retry
      // have a different delay (exponential backoff).
    },
  });
  await ch.bindQueue(retryQueue, exchange, 'payment.retry');

  // ── DLX → process queue binding ─────────────────────────────────────────
  // When retry TTL expires, message goes to DLX with routing key 'payment.process'
  // This binding routes it back to the process queue
  await ch.bindQueue(processQueue, dlxExchange, 'payment.process');
}

/**
 * Publish a message to start processing a payment.
 * Called by the API immediately after creating a payment.
 */
async function publishPaymentProcess(paymentId, attempt = 0, trigger = 'INITIAL') {
  const ch = await connect();
  const message = { paymentId, attempt, trigger };

  ch.publish(
    config.rabbitmq.exchange,
    'payment.process',
    Buffer.from(JSON.stringify(message)),
    {
      persistent: true,       // message survives RabbitMQ restart
      contentType: 'application/json',
      messageId: `${paymentId}-${attempt}-${Date.now()}`,
    }
  );

  logger.info({ paymentId, attempt, trigger }, 'Published payment.process message');
}

/**
 * Publish a retry message with TTL = the exponential backoff delay.
 *
 * The message goes to the retry queue and sits there for `delayMs`.
 * When TTL expires, RabbitMQ moves it via DLX back to the process queue.
 * The worker then picks it up as a normal message — no setTimeout needed.
 *
 * @param {string} paymentId
 * @param {number} attempt - current attempt number
 * @param {number} delayMs - how long to wait before retrying
 */
async function publishPaymentRetry(paymentId, attempt, delayMs) {
  const ch = await connect();
  const message = { paymentId, attempt, trigger: 'RETRY' };

  ch.publish(
    config.rabbitmq.exchange,
    'payment.retry',
    Buffer.from(JSON.stringify(message)),
    {
      persistent: true,
      contentType: 'application/json',
      messageId: `${paymentId}-retry-${attempt}-${Date.now()}`,
      expiration: String(delayMs), // per-message TTL in milliseconds (as string!)
    }
  );

  logger.info({ paymentId, attempt, delayMs }, 'Published payment.retry message');
}

async function checkHealth() {
  const ch = await connect();
  return ch !== null;
}

async function close() {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}

module.exports = { connect, publishPaymentProcess, publishPaymentRetry, checkHealth, close };
