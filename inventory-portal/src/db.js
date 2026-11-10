import pg from 'pg';

const { Pool } = pg;

const poolConfig = process.env.PGHOST
  ? {
      host: process.env.PGHOST,
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'shop',
      password: process.env.PGPASSWORD || 'shopsecret',
      database: process.env.PGDATABASE || 'shop',
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    }
  : {
      connectionString: process.env.DATABASE_URL || 'postgres://shop:shopsecret@db:5432/shop',
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

export const pool = new Pool(poolConfig);

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
