const crypto = require('crypto');
const express = require('express');
const { pool, waitForDb, migrate } = require('./db');
const { ApiError, badRequest } = require('./errors');
const { sanitizeObjectKeys } = require('./sanitize');
const stock = require('./stock');
const orders = require('./orders');
const products = require('./products');
const coupons = require('./coupons');
const dashboard = require('./dashboard');

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
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Protect against object prototype pollution attacks across all endpoints
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObjectKeys(req.body);
  }
  next();
});

// Optional browser access for public read endpoints (list origins in CORS_ORIGINS)
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Actor');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function extractToken(req) {
  const xKey = req.get('x-api-key');
  if (xKey) return xKey.trim();
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

function keyOk(req) {
  const token = extractToken(req);
  const given = Buffer.from(token);
  const real = Buffer.from(API_KEY);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function requireKey(req, res, next) {
  if (!keyOk(req)) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API token'));
  }
  next();
}

// In-memory sliding rate limiter for lookup protection
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

/* ---------- Healthcheck (public for container orchestrators) ---------- */

app.get('/health', h(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, status: 'healthy', timestamp: new Date().toISOString() });
}));

/* ---------- All /api endpoints are strictly protected by API Key ---------- */

app.use('/api', requireKey);

/* ---------- 1. Products & Silhouettes ---------- */

app.get('/api/products', h(async (req, res) => {
  if (req.query.staff === 'true' || req.query.staff === '1' || req.query.status || req.query.sort || req.query.image) {
    const productsList = await products.listStaffProducts(req.query);
    return res.json({ products: productsList });
  }
  const productsList = await stock.listProducts({
    category: req.query.category,
    q: req.query.q,
    admin: true,
  });
  res.json({ products: productsList });
}));

app.get('/api/products/categories', h(async (req, res) => {
  res.json({ categories: await products.getCategories() });
}));

app.get('/api/products/summary', h(async (req, res) => {
  res.json({ products: await products.getProductSummary() });
}));

app.get('/api/products/:id', h(async (req, res) => {
  res.json(await products.getProductById(req.params.id));
}));

app.post('/api/products', h(async (req, res) => {
  res.status(201).json(await products.createProduct(req.body));
}));

app.put('/api/products/:id', h(async (req, res) => {
  res.json({ product: await products.updateProduct(req.params.id, req.body) });
}));
app.post('/api/products/:id', h(async (req, res) => {
  res.json({ product: await products.updateProduct(req.params.id, req.body) });
}));

app.post('/api/products/:id/toggle-status', h(async (req, res) => {
  res.json(await products.toggleProductStatus(req.params.id));
}));

app.post('/api/products/:id/color-image', h(async (req, res) => {
  res.json(await products.updateColorImage(req.params.id, req.body));
}));

app.delete('/api/products/:id', h(async (req, res) => {
  res.json(await products.deleteProduct(req.params.id));
}));

/* ---------- 2. Variants & Stock Control ---------- */

app.get('/api/stock', h(async (req, res) => {
  res.json(await stock.listVariants(req.query));
}));

app.get('/api/stock/:sku', h(async (req, res) => {
  res.json(await stock.getStock(req.params.sku, true));
}));

app.post('/api/variants', h(async (req, res) => {
  res.status(201).json(await stock.createVariant(req.body));
}));

app.post('/api/variants/:id', h(async (req, res) => {
  res.json(await stock.updateVariant(req.params.id, req.body));
}));

app.post('/api/variants/:id/image', h(async (req, res) => {
  res.json(await stock.updateVariantImage(req.params.id, req.body));
}));

app.delete('/api/variants/:id', h(async (req, res) => {
  res.json(await stock.deleteVariant(req.params.id));
}));

app.post('/api/stock/adjust', h(async (req, res) => {
  res.json(await stock.adjustStock(req.body || {}));
}));

app.post('/api/stock/bulk', h(async (req, res) => {
  res.json(await stock.bulkAdjustStock(req.body || {}));
}));

app.get('/api/low-stock', h(async (req, res) => {
  res.json({ items: await stock.lowStock() });
}));

/* ---------- 3. Stock Movements Audit Feed ---------- */

app.get('/api/movements', h(async (req, res) => {
  res.json(await stock.listMovements(req.query));
}));

app.get('/api/movements/export', h(async (req, res) => {
  res.json({ movements: await stock.exportMovements() });
}));

/* ---------- 4. Dashboard Metrics ---------- */

app.get('/api/dashboard', h(async (req, res) => {
  const includeOrders = req.query.include_orders !== 'false';
  res.json(await dashboard.getDashboardData({ includeOrders }));
}));

/* ---------- 5. Orders & Fulfillment ---------- */

app.post('/api/orders', h(async (req, res) => {
  const actor = req.get('x-actor') || 'api';
  const { order, duplicate } = await orders.createOrder(req.body, actor);
  res.status(duplicate ? 200 : 201).json({ duplicate, order });
}));

app.get('/api/orders', h(async (req, res) => {
  res.json(await orders.listOrders(req.query));
}));

app.get('/api/orders/metrics', h(async (req, res) => {
  res.json(await orders.getOrderMetrics());
}));

app.get('/api/orders/:orderNo', h(async (req, res) => {
  const o = await orders.getOrder(pool, req.params.orderNo);
  if (!o) throw new ApiError(404, 'NOT_FOUND', `Order ${req.params.orderNo} not found`);
  res.json({ order: o });
}));

app.post('/api/orders/:orderNo/status', h(async (req, res) => {
  const actor = req.get('x-actor') || 'api';
  res.json({ order: await orders.changeStatus(req.params.orderNo, req.body || {}, actor) });
}));

app.post('/api/orders/:orderNo/paid', h(async (req, res) => {
  const actor = req.get('x-actor') || 'api';
  res.json({ order: await orders.markPaid(req.params.orderNo, req.body || {}, actor) });
}));

app.get('/api/track/:orderNo', h(async (req, res) => {
  const ip = req.get('cf-connecting-ip') || req.ip;
  if (limited(`ip:${ip}`, 30, 60000) || limited(`order:${req.params.orderNo}`, 10, 15 * 60000)) {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Too many lookups, try again in a few minutes');
  }
  res.json(await orders.track(req.params.orderNo, req.query.phone4));
}));

app.post('/api/admin/expire-reservations', h(async (req, res) => {
  res.json({ cancelled: await orders.expireReservations() });
}));

/* ---------- 6. Coupons & Promotions ---------- */

app.get('/api/coupons', h(async (req, res) => {
  res.json(await coupons.listCoupons());
}));

app.get('/api/coupons/validate', h(async (req, res) => {
  res.json(await coupons.validateCoupon(req.query.code, req.query.subtotal));
}));

app.post('/api/coupons', h(async (req, res) => {
  res.status(201).json(await coupons.createCoupon(req.body));
}));

app.post('/api/coupons/:id/toggle-status', h(async (req, res) => {
  res.json(await coupons.toggleCouponStatus(req.params.id));
}));

app.post('/api/coupons/:id/extend', h(async (req, res) => {
  res.json(await coupons.extendCoupon(req.params.id, req.body));
}));

app.put('/api/coupons/:id', h(async (req, res) => {
  res.json(await coupons.updateCoupon(req.params.id, req.body));
}));
app.post('/api/coupons/:id', h(async (req, res) => {
  res.json(await coupons.updateCoupon(req.params.id, req.body));
}));

app.delete('/api/coupons/:id', h(async (req, res) => {
  res.json(await coupons.deleteCoupon(req.params.id));
}));

/* ---------- Error Handling ---------- */

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
  if (err.code === '23505') {
    return res.status(409).json({ error: { code: 'UNIQUE_VIOLATION', message: 'A record with that unique value already exists' } });
  }
  console.error('[shop-api unhandled error]:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on the store API' } });
});

/* ---------- Start Server ---------- */

async function main() {
  await waitForDb();
  await migrate();

  // Ensure order sequence is synchronized with highest existing order number
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

  // Release stock held by unpaid orders whose hold window expired
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
