/**
 * Application entry point for independent dress store storefront & admin container.
 * Configures Express 5, EJS templating, Helmet CSP, signed session cookies,
 * CSRF protection, and graceful shutdown.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');

// Loading config validates required environment variables and fails fast at startup
const config = require('./src/config');
const { csrfMiddleware, verifyCsrf } = require('./src/security');
const cart = require('./src/cart');
const storeRouter = require('./src/routes/store');
const adminRouter = require('./src/routes/admin');

const app = express();
app.disable('x-powered-by');

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// Security headers with dynamic CSP (only force HTTPS/upgrade when SITE_URL is https)
const isHttps = Boolean(config.siteUrl && config.siteUrl.startsWith('https'));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isHttps ? [] : null
      }
    },
    hsts: isHttps ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false
  })
);

// Signed HTTP-only session cookies (secure only when TRUST_PROXY is set)
app.use(
  cookieSession({
    name: 'atelier_sess',
    keys: [config.sessionSecret],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: config.trustProxy === true
  })
);

// Body parsing with strict size limits
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(express.json({ limit: '50kb' }));

// View engine configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Application-wide helpers
app.locals.storeName = config.storeName;
app.locals.storeTagline = config.storeTagline;
app.locals.site = config.siteContent;
app.locals.config = config;

app.locals.formatInr = (n) => {
  const num = Number(n || 0);
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
};

app.locals.getInitials = (name) => {
  if (!name) return 'AT';
  const words = name.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'AT';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
};

// Dedicated Nginx Media proxy: serves uploaded product photos via Nginx to the main storefront
const NGINX_MEDIA_HOST = process.env.NGINX_MEDIA_HOST || 'nginx-media';
const NGINX_MEDIA_PORT = process.env.NGINX_MEDIA_PORT || 80;

app.use('/products', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const options = {
    hostname: NGINX_MEDIA_HOST,
    port: NGINX_MEDIA_PORT,
    path: `/products${req.url}`,
    method: req.method,
    headers: { ...req.headers, host: req.headers.host }
  };
  const proxyReq = http.request(options, (proxyRes) => {
    if (proxyRes.statusCode === 200 || proxyRes.statusCode === 304) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    } else {
      next(); // fallback to local volume mount
    }
  });
  proxyReq.on('error', () => next());
  proxyReq.end();
});

// Static assets with cache headers
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.woff2')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.match(/\.(css|js|mjs)$/)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (filePath.match(/\.(svg|png|jpg|jpeg|webp)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  })
);

// Static vendor fallbacks from node_modules for Lenis and Fontsource
app.use('/vendor/lenis', express.static(path.join(__dirname, 'node_modules/lenis/dist')));
app.use('/vendor/@fontsource/playfair-display', express.static(path.join(__dirname, 'node_modules/@fontsource/playfair-display')));
app.use('/vendor/@fontsource/inter', express.static(path.join(__dirname, 'node_modules/@fontsource/inter')));

// Global middleware for CSRF and session locals
app.use(csrfMiddleware);
app.use(async (req, res, next) => {
  res.locals.currentPath = req.path;
  try {
    const rawCart = (req.session && Array.isArray(req.session.cart)) ? req.session.cart : [];
    if (rawCart.length > 0) {
      const cartState = await cart.syncCart(req);
      res.locals.cart = cartState;
      res.locals.cartItemCount = cartState.itemCount;
    } else {
      res.locals.cart = { items: [], itemCount: 0, subtotal: 0, shipping: 0, total: 0, freeShippingDelta: config.freeShippingAbove, isFreeShipping: true };
      res.locals.cartItemCount = 0;
    }
  } catch (err) {
    res.locals.cart = { items: [], itemCount: 0, subtotal: 0, shipping: 0, total: 0, freeShippingDelta: config.freeShippingAbove, isFreeShipping: true };
    res.locals.cartItemCount = 0;
  }
  next();
});

// Automatic Layout Wrapper middleware (no extra npm packages required)
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view, options = {}, callback) => {
    const merged = { ...app.locals, ...res.locals, ...options };

    if (view === 'admin/login' || options.layout === false) {
      return originalRender(view, merged, callback);
    }

    const layout = view.startsWith('admin/') ? 'admin/layout' : 'layout';

    originalRender(view, merged, (err, innerHtml) => {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }
      originalRender(layout, { ...merged, body: innerHtml }, (layoutErr, fullHtml) => {
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

// CSRF validation on all state-changing requests
app.use(verifyCsrf);

// Mount routes
app.use('/', storeRouter);

// Storefront is customer-only. All back-office operations (inventory, orders, catalog)
// are handled by the standalone inventory-portal service.
app.use('/admin', (req, res) => {
  res.status(404).render('pages/404', {
    title: 'Page Not Found | ' + config.storeName,
    message: 'The requested administrative resource does not exist on the customer storefront.'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).render('pages/404', {
    title: 'Page Not Found | ' + config.storeName,
    message: 'The page or artisanal piece you are looking for does not exist or has been relocated.'
  });
});

// 500 / Error Handler (graceful degraded mode when shop-api is unreachable)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server error]', err.name, err.message, err.status || 500);

  const status = err.status || 500;
  res.status(status);

  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.json({
      error: {
        code: err.code || 'SERVER_ERROR',
        message: err.message || 'An unexpected error occurred.'
      }
    });
  }

  const isApiOutage = err.status === 503 || err.status === 504 || err.code === 'ECONNREFUSED';
  res.render('pages/500', {
    title: isApiOutage ? "We'll Be Right Back" : 'Something Went Wrong',
    message: isApiOutage
      ? "Our studio inventory system is momentarily synchronizing with our master weavers. Please refresh in a moment."
      : (err.message || "An unexpected error occurred while processing your request.")
  });
});

// Startup and process signal handling
const server = app.listen(config.port, () => {
  console.log(`\n-------------------------------------------------------------`);
  console.log(`  ${config.storeName} storefront online`);
  console.log(`  Listening on http://0.0.0.0:${config.port}`);
  console.log(`  Connected to shop-api at ${config.shopApiUrl}`);
  console.log(`-------------------------------------------------------------\n`);
});

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Gracefully stopping server...`);
  server.close(() => {
    console.log('HTTP server closed. Exiting process.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forcefully terminating after 8s timeout.');
    process.exit(1);
  }, 8000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
