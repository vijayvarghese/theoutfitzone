/**
 * Security and sanitization utilities.
 * Includes CSRF protection, constant-time authentication,
 * in-memory rate limiting, and PII masking.
 */
const crypto = require('crypto');

// In-memory sliding rate limit buckets
const rateBuckets = new Map();

/**
 * Checks and increments rate limit counter for a given key.
 * @param {string} key Identifier (e.g. ip + action)
 * @param {number} max Maximum allowed hits
 * @param {number} windowMs Sliding window in milliseconds
 * @returns {boolean} True if within limit, False if rate limited
 */
function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  return b.count <= max;
}

// Clean up stale rate buckets every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of rateBuckets) {
    if (b.resetAt < now) rateBuckets.delete(key);
  }
}, 120000).unref();

/**
 * Constant-time comparison of two strings using SHA-256 digests.
 * Prevents timing attacks on passwords and tokens.
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Initializes CSRF token in session and exposes it to templates.
 */
function csrfMiddleware(req, res, next) {
  if (!req.session) {
    return next();
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

/**
 * Validates CSRF token on mutating HTTP methods (POST, PUT, DELETE).
 */
function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const sessionToken = req.session && req.session.csrfToken;
  const submittedToken = (req.body && req.body.csrf_token) ||
    req.headers['x-csrf-token'] ||
    req.headers['x-xsrf-token'];

  if (!sessionToken || !submittedToken || !constantTimeCompare(sessionToken, submittedToken)) {
    res.status(403);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ error: 'Invalid or missing CSRF security token. Please refresh the page.' });
    }
    return res.render('pages/500', {
      title: 'Security Validation Failed',
      message: 'Your session token has expired or is invalid. Please refresh the page and try again.'
    });
  }
  next();
}

/**
 * Masks a phone number for logs and display (shows only last 4 digits).
 */
function maskPhone(phone) {
  if (!phone) return '****';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length < 4) return '****';
  return '*'.repeat(clean.length - 4) + clean.slice(-4);
}

module.exports = {
  checkRateLimit,
  constantTimeCompare,
  csrfMiddleware,
  verifyCsrf,
  maskPhone
};
