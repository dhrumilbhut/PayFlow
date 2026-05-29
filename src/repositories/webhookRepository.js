const db = require('../database/connection');

/**
 * Webhook deduplication table.
 *
 * Why do we need this?
 * External payment gateways use "at-least-once delivery" for webhooks.
 * This means the same webhook event may arrive 2, 3, or even 10 times
 * (network retries, gateway bugs, etc.)
 *
 * Our system must be IDEMPOTENT: processing the same webhook twice
 * must produce the same result as processing it once.
 *
 * The external_event_id has a UNIQUE constraint in the DB.
 * First insert succeeds. Duplicate insert throws a unique violation.
 * We catch that and treat it as "already processed" — safe to ignore.
 */

function mapRow(row) {
  return {
    id: row.id,
    externalEventId: row.external_event_id,
    paymentId: row.payment_id,
    payload: row.payload,
    processedAt: row.processed_at,
  };
}

async function create({ externalEventId, paymentId, payload }, client = null) {
  const executor = client || db;
  const sql = `
    INSERT INTO webhook_events (external_event_id, payment_id, payload)
    VALUES ($1, $2, $3)
    RETURNING *
  `;
  const { rows } = await executor.query(sql, [
    externalEventId,
    paymentId,
    JSON.stringify(payload),
  ]);
  return mapRow(rows[0]);
}

async function findByExternalEventId(externalEventId) {
  const { rows } = await db.query(
    'SELECT * FROM webhook_events WHERE external_event_id = $1',
    [externalEventId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

module.exports = { create, findByExternalEventId };
