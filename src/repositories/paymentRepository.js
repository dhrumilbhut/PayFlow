const db = require('../database/connection');
const { toExternalState } = require('../state-machine/paymentStateMachine');

/**
 * Shapes a raw DB row into the object our application works with.
 * We map internal state → external state for API responses.
 * snake_case DB columns → camelCase JS properties.
 */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    amount: parseFloat(row.amount),
    status: row.status,               // internal status (used by services)
    externalStatus: toExternalState(row.status), // API-visible status
    idempotencyKey: row.idempotency_key,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a new payment record.
 * RETURNING * avoids a second SELECT after INSERT.
 */
async function create({ amount, idempotencyKey, maxRetries = 3 }) {
  const sql = `
    INSERT INTO payments (amount, idempotency_key, max_retries)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
  const { rows } = await db.query(sql, [amount, idempotencyKey, maxRetries]);
  return mapRow(rows[0]);
}

async function findById(id) {
  const { rows } = await db.query('SELECT * FROM payments WHERE id = $1', [id]);
  return mapRow(rows[0]);
}

async function findByIdempotencyKey(key) {
  const { rows } = await db.query(
    'SELECT * FROM payments WHERE idempotency_key = $1',
    [key]
  );
  return mapRow(rows[0]);
}

/**
 * List payments with optional status filter.
 * We check both internal and external status so callers can filter
 * by either "PROCESSING" (which includes RETRY_SCHEDULED internally).
 */
async function findAll({ status, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM payments';
  const params = [];

  if (status) {
    // Allow filtering by external status — PROCESSING covers RETRY_SCHEDULED too
    if (status === 'PROCESSING') {
      sql += ` WHERE status IN ('PROCESSING', 'RETRY_SCHEDULED')`;
    } else {
      params.push(status);
      sql += ` WHERE status = $${params.length}`;
    }
  }

  params.push(limit, offset);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await db.query(sql, params);
  return rows.map(mapRow);
}

/**
 * Update payment status with an optional DB client for transactions.
 *
 * Why accept a client parameter?
 * When we need to update status AND insert an audit event in one
 * atomic transaction, we pass the transaction client so both
 * operations share the same connection and transaction scope.
 */
async function updateStatus(id, status, extras = {}, client = null) {
  const executor = client || db;
  const sets = ['status = $2', 'updated_at = NOW()'];
  const params = [id, status];

  if (extras.retryCount !== undefined) {
    params.push(extras.retryCount);
    sets.push(`retry_count = $${params.length}`);
  }
  if (extras.nextRetryAt !== undefined) {
    params.push(extras.nextRetryAt);
    sets.push(`next_retry_at = $${params.length}`);
  }
  if (extras.lastError !== undefined) {
    params.push(extras.lastError);
    sets.push(`last_error = $${params.length}`);
  }

  const sql = `
    UPDATE payments
    SET ${sets.join(', ')}
    WHERE id = $1
    RETURNING *
  `;

  const { rows } = await executor.query(sql, params);
  return mapRow(rows[0]);
}

/**
 * SELECT ... FOR UPDATE — database row lock.
 *
 * This is the second layer of concurrency control (Redis lock is first).
 * FOR UPDATE acquires an exclusive row lock inside a transaction.
 * Any other transaction trying to update this row will BLOCK until
 * the lock holder commits or rolls back.
 *
 * SKIP LOCKED: if the row is already locked, skip it rather than
 * waiting. This is for future horizontal worker scaling.
 *
 * Must be called inside a transaction (pass the client).
 */
async function lockForUpdate(id, client) {
  const { rows } = await client.query(
    'SELECT * FROM payments WHERE id = $1 FOR UPDATE SKIP LOCKED',
    [id]
  );
  return mapRow(rows[0]);
}

/**
 * Aggregate payment counts per external status in one DB query.
 *
 * Why do this in SQL instead of JS?
 * Fetching all payments to count them in JS breaks when you have
 * 10,000+ payments — you'd page through all of them just to get counts.
 * A single GROUP BY runs in milliseconds regardless of table size.
 *
 * RETRY_SCHEDULED is mapped to PROCESSING (it's an internal state).
 */
async function getStats() {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)                                              AS total,
      COUNT(*) FILTER (WHERE status = 'PENDING')           AS pending,
      COUNT(*) FILTER (WHERE status IN ('PROCESSING', 'RETRY_SCHEDULED')) AS processing,
      COUNT(*) FILTER (WHERE status = 'SUCCESS')           AS success,
      COUNT(*) FILTER (WHERE status = 'FAILED')            AS failed
    FROM payments
  `);

  const r = rows[0];
  return {
    total:      parseInt(r.total, 10),
    pending:    parseInt(r.pending, 10),
    processing: parseInt(r.processing, 10),
    success:    parseInt(r.success, 10),
    failed:     parseInt(r.failed, 10),
  };
}

module.exports = { create, findById, findByIdempotencyKey, findAll, updateStatus, lockForUpdate, getStats };
