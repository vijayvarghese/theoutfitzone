const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// numeric -> JS number (prices have 2 decimals), bigint counts -> number
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (e) => console.error('pg pool error', e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run fn inside a transaction; retry on deadlock / serialization failure.
async function tx(fn) {
  for (let attempt = 1; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
      if ((e.code === '40P01' || e.code === '40001') && attempt < 3) {
        await sleep(30 * attempt);
        continue;
      }
      throw e;
    } finally {
      c.release();
    }
  }
}

async function waitForDb() {
  for (let i = 1; i <= 30; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      console.log(`waiting for database (${i}/30): ${e.message}`);
      await sleep(2000);
    }
  }
  throw new Error('database not reachable');
}

// Applies migrations/*.sql in name order, once each, under an advisory lock.
async function migrate() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const f of files) {
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (done.rowCount) continue;
      console.log(`applying migration ${f}`);
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    try { await c.query('SELECT pg_advisory_unlock(727001)'); } catch (_) { /* ignore */ }
    c.release();
  }
}

module.exports = { pool, tx, waitForDb, migrate };
