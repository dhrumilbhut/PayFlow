/**
 * Wait for PostgreSQL to be ready before starting the application.
 *
 * Why do we need this?
 * Even though Docker Compose has healthchecks, there's a small window
 * between "Postgres accepts connections" and "Postgres is fully ready
 * to execute queries". This script retries with backoff until it works.
 *
 * This is used as the container startup command:
 *   node src/database/wait-for-db.js && node src/server.js
 *
 * Or combined in the Dockerfile CMD.
 */

require('dotenv').config();

const { Pool } = require('pg');
const config = require('../config');

const MAX_ATTEMPTS = 30;
const RETRY_DELAY_MS = 2000;

async function waitForDb() {
  const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    connectionTimeoutMillis: 3000,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      await pool.end();

      process.stdout.write(`✓ PostgreSQL is ready (attempt ${attempt})\n`);
      return true;
    } catch (err) {
      process.stdout.write(
        `  Waiting for PostgreSQL... (attempt ${attempt}/${MAX_ATTEMPTS}) — ${err.message}\n`
      );

      if (attempt === MAX_ATTEMPTS) {
        process.stdout.write('✗ PostgreSQL never became ready. Exiting.\n');
        process.exit(1);
      }

      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

waitForDb();
