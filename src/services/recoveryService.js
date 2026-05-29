/**
 * Stuck Payment Recovery Service
 *
 * Problem this solves:
 * The worker does: write PROCESSING → call gateway → write SUCCESS/FAILED
 *
 * If the worker crashes between step 1 and step 3, the payment stays in
 * PROCESSING forever. No retry is ever published. Customer never hears back.
 *
 * This is a well-known distributed systems problem called a "stuck saga".
 *
 * Solution — Recovery Watchdog:
 * Periodically scan for payments that have been in PROCESSING (or
 * RETRY_SCHEDULED) for longer than a safe threshold. These are candidates
 * for recovery. Re-publish them to the process queue so the worker retries.
 *
 * Safe threshold:
 * max gateway timeout (5s) + max processing overhead (~2s) = ~10s
 * We use 2× that = 20s to be safe and avoid false positives.
 *
 * Idempotency:
 * Re-publishing a PROCESSING payment is safe because the processor checks
 * the state machine on pickup. If it's already PROCESSING, it skips.
 * The real concern is RETRY_SCHEDULED payments whose retry message was
 * lost — those we re-queue immediately.
 *
 * Run this from the worker process on a fixed interval.
 */

const db = require('../database/connection');
const { publishPaymentProcess } = require('../messaging/rabbitmq');
const logger = require('../utils/logger');

// How long a payment can be in PROCESSING before we consider it stuck
const STUCK_THRESHOLD_MS = 20000; // 20 seconds

/**
 * Find and recover payments stuck in PROCESSING or RETRY_SCHEDULED.
 * Returns the number of payments recovered.
 */
async function recoverStuckPayments() {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();

  // Find payments stuck in PROCESSING longer than the threshold.
  // updated_at is set to NOW() on every status change (trigger), so
  // updated_at < threshold means nothing has happened for > 20s.
  const { rows } = await db.query(`
    SELECT id, status, retry_count, updated_at
    FROM payments
    WHERE status IN ('PROCESSING', 'RETRY_SCHEDULED')
      AND updated_at < $1
    ORDER BY updated_at ASC
    LIMIT 50
  `, [threshold]);

  if (rows.length === 0) return 0;

  logger.warn({ count: rows.length }, 'Found stuck payments — recovering');

  let recovered = 0;
  for (const row of rows) {
    try {
      await publishPaymentProcess(row.id, row.retry_count, 'RECOVERY');
      logger.info(
        { paymentId: row.id, status: row.status, stuckSince: row.updated_at },
        'Re-queued stuck payment for recovery'
      );
      recovered++;
    } catch (err) {
      logger.error({ err, paymentId: row.id }, 'Failed to re-queue stuck payment');
    }
  }

  return recovered;
}

/**
 * Start the watchdog on a fixed interval.
 * Called from the worker process after it connects.
 *
 * @param {number} intervalMs  How often to scan (default: 30s)
 * @returns {NodeJS.Timeout} interval handle (call clearInterval to stop)
 */
function startWatchdog(intervalMs = 30000) {
  logger.info({ intervalMs, thresholdMs: STUCK_THRESHOLD_MS }, 'Recovery watchdog started');

  // Run once immediately on startup to catch anything from a previous crash
  recoverStuckPayments().catch((err) =>
    logger.error({ err }, 'Recovery watchdog initial scan failed')
  );

  return setInterval(() => {
    recoverStuckPayments().catch((err) =>
      logger.error({ err }, 'Recovery watchdog scan failed')
    );
  }, intervalMs);
}

module.exports = { recoverStuckPayments, startWatchdog };
