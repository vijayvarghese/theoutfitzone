const crypto = require('crypto');
const express = require('express');
const { pool, waitForDb, migrate } = require('./db');
const { ApiError, badRequest } = require('./errors');
const stock = require('./stock');
const orders = require('./orders');

const API_KEY = process.env.API_KEY || '';
const PORT = parseInt(process.env.PORT || '3000', 10);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

if (API_KEY.length < 16) {
  console.error('API_KEY must be set and at least 16 characters long');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Optional browser access for public read endpoints (list origins in CORS_ORIGINS)
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function keyOk(req) {
  const given = Buffer.from(req.get('x-api-key') || '');
  const real = Buffer.from(API_KEY);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}
function requireKey(req, res, next) {
  if (!keyOk(req)) return next(new ApiError(401, 'UNAUTHORIZED', 'Missing or wrong X-API-Key'));
  next();
}

// tiny in-memory rate limiter (protects the public tracking lookup)
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { n: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.n += 1;
  return b.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60000).unref();

/* ---------- public ---------- */

app.get('/health', h(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// Customers see only "available"; with the API key you also get on_hand / reserved / reorder_level.
app.get('/api/products', h(async (req, res) => {
  const products = await stock.listProducts({
    category: req.query.category,
    q: req.query.q,
    admin: keyOk(req),
  });
  res.json({ products });
}));

app.get('/api/stock/:sku', h(async (req, res) => {
  res.json(await stock.getStock(req.params.sku, keyOk(req)));
}));

app.get('/api/track/:orderNo', h(async (req, res) => {
  const ip = req.get('cf-connecting-ip') || req.ip;
  if (limited(`ip:${ip}`, 30, 60000) || limited(`order:${req.params.orderNo}`, 10, 15 * 60000)) {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Too many lookups, try again in a few minutes');
  }
  res.json(await orders.track(req.params.orderNo, req.query.phone4));
}));

/* ---------- needs X-API-Key ---------- */

app.use('/api', requireKey);

app.post('/api/orders', h(async (req, res) => {
  const { order, duplicate } = await orders.createOrder(req.body, req.get('x-actor') || 'api');
  res.status(duplicate ? 200 : 201).json({ duplicate, order });
}));

app.get('/api/orders', h(async (req, res) => {
  res.json({ orders: await orders.listOrders(req.query) });
}));

app.get('/api/orders/:orderNo', h(async (req, res) => {
  const o = await orders.getOrder(pool, req.params.orderNo.toUpperCase());
  if (!o) throw new ApiError(404, 'NOT_FOUND', `Order ${req.params.orderNo} not found`);
  res.json({ order: o });
}));

app.post('/api/orders/:orderNo/status', h(async (req, res) => {
  res.json({ order: await orders.changeStatus(req.params.orderNo, req.body || {}, req.get('x-actor') || 'api') });
}));

app.post('/api/orders/:orderNo/paid', h(async (req, res) => {
  res.json({ order: await orders.markPaid(req.params.orderNo, req.body || {}, req.get('x-actor') || 'api') });
}));

app.post('/api/stock/adjust', h(async (req, res) => {
  const b = req.body || {};
  res.json(await stock.adjustStock({ sku: b.sku, delta: b.delta, reason: b.reason }));
}));

app.get('/api/low-stock', h(async (req, res) => {
  res.json({ items: await stock.lowStock() });
}));

app.post('/api/admin/expire-reservations', h(async (req, res) => {
  res.json({ cancelled: await orders.expireReservations() });
}));

/* ---------- errors ---------- */

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = badRequest('Request body is not valid JSON');
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.code === '23514') {
    return res.status(409).json({ error: { code: 'STOCK_RULE', message: 'That change would break a stock rule (e.g. reserved above on hand)' } });
  }
  console.error('unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
});

/* ---------- start ---------- */

async function main() {
  await waitForDb();
  await migrate();

  // Ensure order sequence is always synchronized with the highest existing order number
  try {
    await pool.query(`
      SELECT setval('order_seq', GREATEST(
        (SELECT COALESCE(MAX(SUBSTRING(order_no FROM '[0-9]+$')::int), 0) FROM orders),
        (SELECT last_value FROM order_seq)
      ))
    `);
  } catch (err) {
    console.error('Failed to sync order_seq on start:', err.message);
  }

  const server = app.listen(PORT, () => console.log(`shop-api listening on :${PORT}`));

  // release stock held by unpaid orders whose window ran out
  const timer = setInterval(async () => {
    try {
      const done = await orders.expireReservations();
      if (done.length) console.log('expired reservations:', done.map((d) => d.order_no).join(', '));
    } catch (e) {
      console.error('expiry job failed:', e.message);
    }
  }, 60000);

  const stop = () => {
    clearInterval(timer);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error('startup failed:', e.message);
  process.exit(1);
});
