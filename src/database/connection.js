const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

let pool;

function getPool() {
  if (!pool) {
    const poolConfig = config.db.connectionString
      ? {
          connectionString: config.db.connectionString,
          ssl: { rejectUnauthorized: false }, // required by Railway / Heroku managed Postgres
        }
      : {
          host: config.db.host,
          port: config.db.port,
          database: config.db.name,
          user: config.db.user,
          password: config.db.password,
        };

    pool = new Pool({
      ...poolConfig,
      min: config.db.pool.min,
      max: config.db.pool.max,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function checkHealth() {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, withTransaction, checkHealth, getPool, close };
