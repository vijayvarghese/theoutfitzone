import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgres://shop:91b0bea7c90f9d07c53e55d402df4618@db:5432/shop';

export const pool = new Pool({
  connectionString,
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB Pool Error]', err);
});

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.DEBUG_SQL) {
    console.log('[SQL]', { text, duration, rows: res.rowCount });
  }
  return res;
}

export async function getClient() {
  return await pool.connect();
}
