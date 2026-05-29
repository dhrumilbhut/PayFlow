/**
 * Database Seed Script
 *
 * Inserts realistic sample data for development and demos.
 *
 * Why seed data matters:
 * When you open the dashboard for the first time, you want to see
 * payments in different states, timelines with multiple events,
 * and retried payments — not an empty table.
 *
 * Seeds are idempotent: they use INSERT ... ON CONFLICT DO NOTHING
 * so running them twice won't duplicate data.
 *
 * Run with:
 *   node src/database/seed.js
 *   npm run db:seed
 */

require('dotenv').config();

const { Pool } = require('pg');
const config = require('../config');

const poolConfig = config.db.connectionString
  ? { connectionString: config.db.connectionString, ssl: { rejectUnauthorized: false } }
  : { host: config.db.host, port: config.db.port, database: config.db.name, user: config.db.user, password: config.db.password };

const pool = new Pool({ ...poolConfig, connectionTimeoutMillis: 10000 });

const GREEN  = '\x1b[32m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

function log(color, msg) { process.stdout.write(`${color}${msg}${RESET}\n`); }
function ago(ms) { return new Date(Date.now() - ms).toISOString(); }

// ── Seed Data ────────────────────────────────────────────────────────────────
//
// We create payments in every state so the dashboard shows a full picture:
// PENDING   → just created, not yet processed
// PROCESSING → worker is currently handling it (unlikely in seed, but realistic)
// SUCCESS   → normal happy path
// FAILED    → all retries exhausted
// SUCCESS w/ retries → succeeded on 2nd or 3rd attempt (shows retry in timeline)
//

const payments = [
  {
    id:              'aaaaaaaa-0001-4000-a000-000000000001',
    amount:          250.00,
    status:          'SUCCESS',
    idempotency_key: 'seed-order-1001',
    retry_count:     0,
    created_at:      ago(3600000), // 1 hour ago
    events: [
      { type: 'PAYMENT_CREATED',            meta: { amount: 250.00 },                   delay: 0 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 0, trigger: 'INITIAL' },  delay: 1000 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 0 },                       delay: 1200 },
      { type: 'GATEWAY_SUCCESS',            meta: { gatewayRef: 'GW-A1B2C3D4' },       delay: 2500 },
      { type: 'PAYMENT_SUCCESS',            meta: { gatewayRef: 'GW-A1B2C3D4' },       delay: 2600 },
    ],
  },
  {
    id:              'aaaaaaaa-0002-4000-a000-000000000002',
    amount:          89.99,
    status:          'SUCCESS',
    idempotency_key: 'seed-order-1002',
    retry_count:     2,
    created_at:      ago(7200000), // 2 hours ago
    events: [
      { type: 'PAYMENT_CREATED',            meta: { amount: 89.99 },                    delay: 0 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 0 },                       delay: 500 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 0 },                       delay: 700 },
      { type: 'GATEWAY_TIMEOUT',            meta: { errorCode: 'GATEWAY_TIMEOUT' },     delay: 5700 },
      { type: 'PAYMENT_RETRY_SCHEDULED',    meta: { attempt: 1, delayMs: 2000 },        delay: 5800 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 1, trigger: 'RETRY' },    delay: 7800 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 1 },                       delay: 8000 },
      { type: 'GATEWAY_FAILURE',            meta: { errorCode: 'GATEWAY_FAILURE' },     delay: 9500 },
      { type: 'PAYMENT_RETRY_SCHEDULED',    meta: { attempt: 2, delayMs: 4000 },        delay: 9600 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 2, trigger: 'RETRY' },   delay: 13600 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 2 },                      delay: 13800 },
      { type: 'GATEWAY_SUCCESS',            meta: { gatewayRef: 'GW-E5F6G7H8' },      delay: 15200 },
      { type: 'PAYMENT_SUCCESS',            meta: { gatewayRef: 'GW-E5F6G7H8' },      delay: 15300 },
    ],
  },
  {
    id:              'aaaaaaaa-0003-4000-a000-000000000003',
    amount:          1500.00,
    status:          'FAILED',
    idempotency_key: 'seed-order-1003',
    retry_count:     3,
    last_error:      'Payment declined by gateway',
    created_at:      ago(1800000), // 30 mins ago
    events: [
      { type: 'PAYMENT_CREATED',            meta: { amount: 1500.00 },                  delay: 0 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 0 },                       delay: 400 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 0 },                       delay: 600 },
      { type: 'GATEWAY_FAILURE',            meta: { errorCode: 'GATEWAY_FAILURE' },     delay: 2100 },
      { type: 'PAYMENT_RETRY_SCHEDULED',    meta: { attempt: 1, delayMs: 2000 },        delay: 2200 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 1 },                       delay: 4200 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 1 },                       delay: 4400 },
      { type: 'GATEWAY_FAILURE',            meta: { errorCode: 'GATEWAY_FAILURE' },     delay: 6000 },
      { type: 'PAYMENT_RETRY_SCHEDULED',    meta: { attempt: 2, delayMs: 4000 },        delay: 6100 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 2 },                      delay: 10100 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 2 },                      delay: 10300 },
      { type: 'GATEWAY_FAILURE',            meta: { errorCode: 'GATEWAY_FAILURE', reason: 'Insufficient funds' }, delay: 12000 },
      { type: 'PAYMENT_FAILED',             meta: { reason: 'Max retries exhausted', totalAttempts: 3 }, delay: 12100 },
    ],
  },
  {
    id:              'aaaaaaaa-0004-4000-a000-000000000004',
    amount:          45.50,
    status:          'PENDING',
    idempotency_key: 'seed-order-1004',
    retry_count:     0,
    created_at:      ago(5000), // 5 seconds ago
    events: [
      { type: 'PAYMENT_CREATED', meta: { amount: 45.50 }, delay: 0 },
    ],
  },
  {
    id:              'aaaaaaaa-0005-4000-a000-000000000005',
    amount:          320.75,
    status:          'PROCESSING',
    idempotency_key: 'seed-order-1005',
    retry_count:     1,
    created_at:      ago(15000), // 15 seconds ago
    events: [
      { type: 'PAYMENT_CREATED',            meta: { amount: 320.75 }, delay: 0 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 0 },     delay: 2000 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 0 },     delay: 2200 },
      { type: 'GATEWAY_TIMEOUT',            meta: { errorCode: 'GATEWAY_TIMEOUT' }, delay: 7200 },
      { type: 'PAYMENT_RETRY_SCHEDULED',    meta: { attempt: 1, delayMs: 2000 },   delay: 7300 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 1 },    delay: 9300 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 1 },    delay: 9500 },
    ],
  },
  {
    id:              'aaaaaaaa-0006-4000-a000-000000000006',
    amount:          9999.99,
    status:          'SUCCESS',
    idempotency_key: 'seed-order-1006',
    retry_count:     0,
    created_at:      ago(86400000), // 1 day ago
    events: [
      { type: 'PAYMENT_CREATED',            meta: { amount: 9999.99 },              delay: 0 },
      { type: 'PAYMENT_PROCESSING_STARTED', meta: { attempt: 0 },                   delay: 800 },
      { type: 'GATEWAY_REQUEST_SENT',       meta: { attempt: 0 },                   delay: 1000 },
      { type: 'GATEWAY_SUCCESS',            meta: { gatewayRef: 'GW-Z9Y8X7W6' },   delay: 3200 },
      { type: 'PAYMENT_SUCCESS',            meta: { gatewayRef: 'GW-Z9Y8X7W6' },   delay: 3300 },
    ],
  },
];

// ── Insert Functions ─────────────────────────────────────────────────────────

async function insertPayment(client, payment) {
  await client.query(`
    INSERT INTO payments
      (id, amount, status, idempotency_key, retry_count, last_error, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
    ON CONFLICT (idempotency_key) DO NOTHING
  `, [
    payment.id,
    payment.amount,
    payment.status,
    payment.idempotency_key,
    payment.retry_count,
    payment.last_error || null,
    payment.created_at,
  ]);
}

async function insertEvents(client, payment) {
  const baseTime = new Date(payment.created_at).getTime();

  for (const event of payment.events) {
    const eventTime = new Date(baseTime + event.delay).toISOString();
    await client.query(`
      INSERT INTO payment_events (payment_id, event_type, metadata, created_at)
      VALUES ($1, $2, $3, $4)
    `, [payment.id, event.type, JSON.stringify(event.meta), eventTime]);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  log(CYAN, '\n╔══════════════════════════════════╗');
  log(CYAN, '║   PayFlow Database Seed          ║');
  log(CYAN, '╚══════════════════════════════════╝\n');

  const client = await pool.connect();

  try {
    log(CYAN, `Seeding ${payments.length} payments...\n`);

    for (const payment of payments) {
      await insertPayment(client, payment);
      await insertEvents(client, payment);
      log(GREEN, `  ✓ ${payment.idempotency_key}  [${payment.status}]  $${payment.amount}  (${payment.events.length} events)`);
    }

    // Show summary
    const { rows } = await client.query(`
      SELECT status, COUNT(*) as count
      FROM payments
      GROUP BY status
      ORDER BY status
    `);

    log(CYAN, '\n──────────────────────────────────────');
    log(CYAN, 'Payment counts by status:');
    rows.forEach((r) => log(GREEN, `  ${r.status.padEnd(18)} ${r.count}`));
    log(GREEN, '\n  ✓ Seed complete!\n');

  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  process.stdout.write(`\x1b[31m✗ Seed failed: ${err.message}\n\x1b[0m`);
  process.exit(1);
});
