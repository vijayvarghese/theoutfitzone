import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import authRouter from './routes/auth.js';
import dashboardRouter from './routes/dashboard.js';
import productsRouter from './routes/products.js';
import stockRouter from './routes/stock.js';
import movementsRouter from './routes/movements.js';
import ordersRouter from './routes/orders.js';
import couponsRouter from './routes/coupons.js';
import { authMiddleware } from './auth.js';
import { uploadDir } from './upload.js';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const STORE_NAME = process.env.STORE_NAME || 'Atelier Inventory HQ';
const PUBLIC_MEDIA_URL = process.env.PUBLIC_MEDIA_URL || '/products';
const NGINX_PREVIEW_URL = process.env.NGINX_PREVIEW_URL || 'http://localhost:8083';

// View engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Standard middleware
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(authMiddleware);

// Static staff portal assets
app.use('/static', express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

// Global view locals
app.use((req, res, next) => {
  const host = (req.get('host') || '').split(':')[0] || 'localhost';
  const proto = req.protocol || 'http';

  // Dynamic storefront URL (defaults to current host at port 8085 if not configured or localhost)
  const storefrontUrl = (process.env.SITE_URL && !process.env.SITE_URL.includes('localhost'))
    ? process.env.SITE_URL.replace(/\/+$/, '')
    : `${proto}://${host}:8085`;

  // Dynamic Nginx Media URL (defaults to current host at port 8083 if not configured or localhost)
  const nginxPreviewUrl = (process.env.NGINX_PREVIEW_URL && !process.env.NGINX_PREVIEW_URL.includes('localhost'))
    ? process.env.NGINX_PREVIEW_URL.replace(/\/+$/, '')
    : `${proto}://${host}:8083`;

  res.locals.storeName = STORE_NAME;
  res.locals.publicMediaUrl = PUBLIC_MEDIA_URL;
  res.locals.storefrontUrl = storefrontUrl;
  res.locals.nginxPreviewUrl = nginxPreviewUrl;
  res.locals.flash = req.query.flash || null;
  res.locals.error = req.query.error || null;
  res.locals.currentPath = req.path;

  // Format INR currency
  res.locals.formatInr = (amount) => {
    const num = Number(amount) || 0;
    return '₹' + num.toLocaleString('en-IN');
  };

  // Format date helper
  res.locals.formatDate = (date) => {
    if (!date) return '-';
    const d = new Date(date);
    return d.toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  next();
});

// Provide all silhouettes to authenticated staff views for universal layout modals
app.use(async (req, res, next) => {
  if (req.user) {
    try {
      const prodRes = await pool.query('SELECT id, name, category, active FROM products ORDER BY name ASC');
      res.locals.allProductList = prodRes.rows;
    } catch {
      res.locals.allProductList = [];
    }
  } else {
    res.locals.allProductList = [];
  }
  next();
});

// Automatic Layout Wrapper middleware
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view, options = {}, callback) => {
    const merged = { ...app.locals, ...res.locals, ...options };

    if (options.layout === false || view === 'layout') {
      return originalRender(view, merged, callback);
    }

    originalRender(view, merged, (err, innerHtml) => {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }
      originalRender('layout', { ...merged, body: innerHtml }, (layoutErr, fullHtml) => {
        if (layoutErr) {
          if (callback) return callback(layoutErr);
          return next(layoutErr);
        }
        if (callback) return callback(null, fullHtml);
        res.send(fullHtml);
      });
    });
  };
  next();
});

// Health check
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1;');
    res.status(200).send('OK');
  } catch (err) {
    res.status(500).send('DB_DOWN');
  }
});

// App routers
app.use('/', authRouter);
app.use('/', dashboardRouter);
app.use('/orders', ordersRouter);
app.use('/products', productsRouter);
// Fallback to serve uploaded product images locally
app.use('/products', express.static(uploadDir, { redirect: false, maxAge: '1d' }));
app.use('/stock', stockRouter);
app.use('/movements', movementsRouter);
app.use('/coupons', couponsRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page Not Found',
    message: `The requested path "${req.path}" does not exist in the staff inventory portal.`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Staff Inventory Error]', err);
  res.status(500).render('error', {
    title: 'Inventory Service Error',
    message: err.message || 'An unexpected internal error occurred.'
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Staff Inventory Portal] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[Staff Inventory Portal] Media directory: ${uploadDir}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server and DB pool');
  server.close(() => {
    pool.end();
  });
});
