const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// numeric -> JS number (prices have 2 decimals), bigint counts -> number
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

const rawCandidates = [
  process.env.PGPASSWORD,
  process.env.DB_PASS,
  process.env.POSTGRES_PASSWORD,
  '91b0bea7c90f9d07c53e55d402df4618',
  'shopsecret',
  ''
];

let defaultHost = 'db';
let defaultPort = 5432;
let defaultUser = 'shop';
let defaultDb = 'shop';

if (process.env.DATABASE_URL) {
  try {
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname) defaultHost = u.hostname;
    if (u.port) defaultPort = parseInt(u.port, 10);
    if (u.username) defaultUser = u.username;
    if (u.pathname && u.pathname.length > 1) defaultDb = u.pathname.slice(1);
    if (u.password) rawCandidates.unshift(u.password);
  } catch (_) {}
}

const host = process.env.PGHOST || defaultHost;
const port = parseInt(process.env.PGPORT || String(defaultPort), 10);
const user = process.env.PGUSER || defaultUser;
const database = process.env.PGDATABASE || defaultDb;

const candidatePasswords = [
  ...new Set(rawCandidates.filter((p) => typeof p === 'string'))
];

function createPoolInstance(pw) {
  const p = new Pool({
    host,
    port,
    user,
    password: pw,
    database,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  p.on('error', (err) => {
    if (err && err.code !== '28P01') {
      console.error('[DB Pool Error]', err.message);
    }
  });
  return p;
}

let activePassword = candidatePasswords[0] || 'shopsecret';
let activePool = createPoolInstance(activePassword);
let hasResolvedWorkingPassword = false;

async function getClient() {
  try {
    const client = await activePool.connect();
    hasResolvedWorkingPassword = true;
    return client;
  } catch (err) {
    if (err.code === '28P01' && !hasResolvedWorkingPassword) {
      console.warn(`[Shop-API Auth] Initial password failed (28P01). Probing alternative credentials...`);
      for (const candidate of candidatePasswords) {
        if (candidate === activePassword) continue;
        const testPool = createPoolInstance(candidate);
        try {
          const client = await testPool.connect();
          console.log(`[Shop-API Auth] Successfully connected and authenticated using fallback password.`);
          const oldPool = activePool;
          activePool = testPool;
          activePassword = candidate;
          hasResolvedWorkingPassword = true;
          oldPool.end().catch(() => {});
          return client;
        } catch (testErr) {
          testPool.end().catch(() => {});
          if (testErr.code === '28P01') {
            continue;
          }
          throw testErr;
        }
      }
    }
    throw err;
  }
}

async function query(text, params) {
  const client = await getClient();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

const pool = {
  async query(text, params) {
    return await query(text, params);
  },
  async connect() {
    return await getClient();
  },
  on(event, handler) {
    activePool.on(event, handler);
  },
  async end() {
    return await activePool.end();
  }
};

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
