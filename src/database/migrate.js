/**
 * Database Migration Runner
 *
 * Supports both forward migrations (up) and rollbacks (down).
 *
 * Each .sql file contains two sections separated by marker comments:
 *   -- migrate:up    → the schema change to apply
 *   -- migrate:down  → the exact reversal of the up section
 *
 * The schema_migrations table tracks what has been applied:
 *   - filename  : e.g. '001_initial_schema.sql'
 *   - checksum  : MD5 of the full file (detects accidental edits)
 *   - executed_at
 *
 * Commands:
 *   node src/database/migrate.js            → apply all pending migrations (up)
 *   node src/database/migrate.js --rollback → roll back the LAST applied migration
 *   node src/database/migrate.js --rollback --steps=2 → roll back last 2 migrations
 *   node src/database/migrate.js --reset    → drop everything, re-run all migrations
 *   node src/database/migrate.js --status   → show what's applied vs pending
 *
 * npm shortcuts (defined in package.json):
 *   npm run db:migrate   → apply
 *   npm run db:rollback  → roll back last migration
 *   npm run db:reset     → reset + re-migrate
 *   npm run db:status    → show migration status
 */

require('dotenv').config();

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('../config');

// ── CLI argument parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const IS_ROLLBACK = args.includes('--rollback');
const IS_RESET    = args.includes('--reset');
const IS_STATUS   = args.includes('--status');

// --steps=N  (how many migrations to roll back, default 1)
const stepsArg = args.find((a) => a.startsWith('--steps='));
const ROLLBACK_STEPS = stepsArg ? parseInt(stepsArg.split('=')[1], 10) : 1;

// ── Database connection ───────────────────────────────────────────────────────
const pool = new Pool({
  host:                    config.db.host,
  port:                    config.db.port,
  database:                config.db.name,
  user:                    config.db.user,
  password:                config.db.password,
  connectionTimeoutMillis: 10000,
});

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// ── Terminal colors ───────────────────────────────────────────────────────────
const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};
const log = (msg) => process.stdout.write(msg + '\n');

// ── SQL section parser ────────────────────────────────────────────────────────

/**
 * Parse a migration file into its up and down SQL sections.
 *
 * File format:
 *   -- migrate:up
 *   CREATE TABLE ...
 *
 *   -- migrate:down
 *   DROP TABLE ...
 *
 * @returns {{ up: string, down: string }}
 */
function parseMigrationFile(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');

  const upMarker   = /--\s*migrate:up\s*/i;
  const downMarker = /--\s*migrate:down\s*/i;

  const upIndex   = content.search(upMarker);
  const downIndex = content.search(downMarker);

  if (upIndex === -1) {
    throw new Error(`Migration file missing "-- migrate:up" marker: ${filepath}`);
  }
  if (downIndex === -1) {
    throw new Error(`Migration file missing "-- migrate:down" marker: ${filepath}`);
  }
  if (upIndex > downIndex) {
    throw new Error(`"-- migrate:up" must come before "-- migrate:down" in: ${filepath}`);
  }

  // Extract the SQL between the markers
  const upEnd   = downIndex;
  const upSQL   = content.slice(upIndex, upEnd).replace(upMarker, '').trim();
  const downSQL = content.slice(downIndex).replace(downMarker, '').trim();

  if (!upSQL) {
    throw new Error(`Empty "migrate:up" section in: ${filepath}`);
  }
  if (!downSQL) {
    throw new Error(`Empty "migrate:down" section in: ${filepath}`);
  }

  return { up: upSQL, down: downSQL, full: content };
}

function computeChecksum(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

// ── Migration tracking table ──────────────────────────────────────────────────

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL       PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      checksum    VARCHAR(64)  NOT NULL,
      direction   VARCHAR(4)   NOT NULL DEFAULT 'up',
      executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query(
    'SELECT filename, checksum FROM schema_migrations ORDER BY id ASC'
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function getLastAppliedMigrations(client, steps) {
  const { rows } = await client.query(
    'SELECT filename FROM schema_migrations ORDER BY id DESC LIMIT $1',
    [steps]
  );
  return rows.map((r) => r.filename);
}

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

// ── Execute a migration in a transaction ─────────────────────────────────────

async function execUp(client, filename, sql, checksum) {
  log(C.cyan(`\n  ▲ Applying: ${C.bold(filename)}`));

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, direction)
       VALUES ($1, $2, 'up')`,
      [filename, checksum]
    );
    await client.query('COMMIT');
    log(C.green(`  ✓ Applied:  ${filename}`));
  } catch (err) {
    await client.query('ROLLBACK');
    log(C.red(`  ✗ Failed:   ${filename}`));
    log(C.red(`    → ${err.message}`));
    throw err;
  }
}

async function execDown(client, filename, sql) {
  log(C.yellow(`\n  ▼ Rolling back: ${C.bold(filename)}`));

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'DELETE FROM schema_migrations WHERE filename = $1',
      [filename]
    );
    await client.query('COMMIT');
    log(C.green(`  ✓ Rolled back: ${filename}`));
  } catch (err) {
    await client.query('ROLLBACK');
    log(C.red(`  ✗ Rollback failed: ${filename}`));
    log(C.red(`    → ${err.message}`));
    throw err;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function migrateUp(client) {
  const applied = await getAppliedMigrations(client);
  const files   = getMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    log(C.green('\n  ✓ Already up to date — no pending migrations.'));
    return;
  }

  log(C.cyan(`\n  ${pending.length} pending migration(s) to apply:\n`));

  for (const filename of pending) {
    const filepath = path.join(MIGRATIONS_DIR, filename);
    const parsed   = parseMigrationFile(filepath);
    const checksum = computeChecksum(parsed.full);

    // Warn if a previously-applied migration was edited
    if (applied.has(filename) && applied.get(filename) !== checksum) {
      log(C.yellow(`  ⚠  Warning: ${filename} was modified after being applied!`));
      log(C.yellow(`     Migrations should be immutable. Add a new migration instead.`));
    }

    await execUp(client, filename, parsed.up, checksum);
  }

  log(C.green(`\n  ✓ ${pending.length} migration(s) applied successfully.`));
}

async function migrateDown(client, steps) {
  const filenames = await getLastAppliedMigrations(client, steps);

  if (filenames.length === 0) {
    log(C.yellow('\n  Nothing to roll back — no applied migrations found.'));
    return;
  }

  log(C.yellow(`\n  Rolling back ${filenames.length} migration(s):\n`));

  // filenames are already in DESC order (last applied first)
  for (const filename of filenames) {
    const filepath = path.join(MIGRATIONS_DIR, filename);

    if (!fs.existsSync(filepath)) {
      throw new Error(
        `Cannot roll back "${filename}" — migration file not found.\n` +
        `  The file must exist to read its migrate:down section.`
      );
    }

    const parsed = parseMigrationFile(filepath);
    await execDown(client, filename, parsed.down);
  }

  log(C.green(`\n  ✓ ${filenames.length} migration(s) rolled back.`));
}

async function showStatus(client) {
  const applied = await getAppliedMigrations(client);
  const files   = getMigrationFiles();

  log('');
  log(C.bold('  Migration Status'));
  log(C.dim('  ─────────────────────────────────────────────'));
  log(C.dim('  Status    Filename'));
  log(C.dim('  ─────────────────────────────────────────────'));

  for (const filename of files) {
    if (applied.has(filename)) {
      const filepath = path.join(MIGRATIONS_DIR, filename);
      const content  = fs.readFileSync(filepath, 'utf8');
      const checksum = computeChecksum(content);
      const modified = applied.get(filename) !== checksum ? C.yellow(' ⚠ modified') : '';
      log(`  ${C.green('✓ applied')}  ${filename}${modified}`);
    } else {
      log(`  ${C.yellow('○ pending')}  ${filename}`);
    }
  }

  log(C.dim('  ─────────────────────────────────────────────'));
  log(`  Applied: ${C.green(String(applied.size))}  |  Pending: ${C.yellow(String(files.length - applied.size))}\n`);
}

async function resetDatabase(client) {
  log(C.yellow('\n  ⚠  Resetting database — all data will be destroyed!\n'));

  // Hard drop everything — used in development only
  // Never run --reset in production
  await client.query('DROP TABLE IF EXISTS webhook_events   CASCADE');
  await client.query('DROP TABLE IF EXISTS payment_events   CASCADE');
  await client.query('DROP TABLE IF EXISTS payments         CASCADE');
  await client.query('DROP TABLE IF EXISTS schema_migrations CASCADE');
  await client.query('DROP FUNCTION IF EXISTS set_updated_at CASCADE');

  log(C.green('  ✓ All tables dropped. Running migrations from scratch...\n'));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const banner = IS_ROLLBACK ? 'Rollback' : IS_RESET ? 'Reset + Migrate' : IS_STATUS ? 'Status' : 'Migrate';

  log('');
  log(C.cyan('╔══════════════════════════════════════╗'));
  log(C.cyan(`║   PayFlow Database — ${banner.padEnd(15)}║`));
  log(C.cyan('╚══════════════════════════════════════╝'));

  if (IS_RESET && process.env.NODE_ENV === 'production') {
    log(C.red('\n  ✗ --reset is not allowed in NODE_ENV=production. Aborting.\n'));
    process.exit(1);
  }

  log(C.dim(`\n  Host: ${config.db.host}:${config.db.port}/${config.db.name}`));

  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);

    if (IS_STATUS) {
      await showStatus(client);
    } else if (IS_RESET) {
      await resetDatabase(client);
      await migrateUp(client);
    } else if (IS_ROLLBACK) {
      await migrateDown(client, ROLLBACK_STEPS);
    } else {
      await migrateUp(client);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  log(C.red(`\n  ✗ Migration error: ${err.message}\n`));
  process.exit(1);
});
