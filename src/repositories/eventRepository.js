const db = require('../database/connection');

/**
 * Audit events are append-only — we never UPDATE or DELETE them.
 * They form a complete, immutable history of everything that happened
 * to a payment. This is essential for debugging, compliance, and support.
 */

function mapRow(row) {
  return {
    id: row.id,
    paymentId: row.payment_id,
    eventType: row.event_type,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/**
 * Insert an audit event. Accepts an optional client for transactions
 * so the event and the status update are atomic (both commit or both roll back).
 */
async function create({ paymentId, eventType, metadata = {} }, client = null) {
  const executor = client || db;
  const sql = `
    INSERT INTO payment_events (payment_id, event_type, metadata)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
  const { rows } = await executor.query(sql, [
    paymentId,
    eventType,
    JSON.stringify(metadata),
  ]);
  return mapRow(rows[0]);
}

async function findByPaymentId(paymentId) {
  const { rows } = await db.query(
    'SELECT * FROM payment_events WHERE payment_id = $1 ORDER BY created_at ASC',
    [paymentId]
  );
  return rows.map(mapRow);
}

module.exports = { create, findByPaymentId };
