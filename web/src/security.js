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

const TAG_REGEX = /<[^>]*>?/gm;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g;
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cleanString(val, options = {}) {
  const {
    maxLength = 500,
    allowNewlines = false,
    trim = true,
    toUpper = false,
    toLower = false
  } = options;

  if (val == null) return '';
  let str = String(val);

  str = str.replace(CONTROL_CHARS_REGEX, '');
  str = str.replace(TAG_REGEX, '');
  str = str.replace(/javascript\s*:/gi, '').replace(/data\s*:\s*text\/html/gi, '');

  if (!allowNewlines) {
    str = str.replace(/[\r\n\t]+/g, ' ');
  }

  if (trim) {
    str = str.trim();
  }

  if (toUpper) {
    str = str.toUpperCase();
  } else if (toLower) {
    str = str.toLowerCase();
  }

  if (maxLength && str.length > maxLength) {
    str = str.slice(0, maxLength);
  }

  return str;
}

function cleanIdentifier(val, allowedChars = '-_') {
  if (val == null) return '';
  const escaped = allowedChars.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`[^a-zA-Z0-9${escaped}]`, 'g');
  return String(val).replace(regex, '').trim().toUpperCase();
}

function cleanInt(val, min = -Infinity, max = Infinity, defaultValue = 0) {
  if (val == null || val === '') return defaultValue;
  const num = parseInt(val, 10);
  if (!Number.isFinite(num) || isNaN(num)) return defaultValue;
  return Math.max(min, Math.min(max, num));
}

function cleanFloat(val, min = 0, max = Infinity, precision = 2, defaultValue = 0) {
  if (val == null || val === '') return defaultValue;
  const num = parseFloat(val);
  if (!Number.isFinite(num) || isNaN(num)) return defaultValue;
  const clamped = Math.max(min, Math.min(max, num));
  const factor = Math.pow(10, precision);
  return Math.round(clamped * factor) / factor;
}

function cleanBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'on' || s === 'yes';
  }
  return Boolean(val);
}

function cleanUrl(val) {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;

  if (str.includes('..') || str.includes('\\')) {
    return null;
  }

  const relativeMatch = str.match(/^\/?(products\/[a-zA-Z0-9_\-\.]+\.(jpg|jpeg|png|webp|svg|avif))$/i);
  if (relativeMatch) {
    return '/' + relativeMatch[1];
  }

  try {
    const parsed = new URL(str);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch (_) {}

  return null;
}

function cleanPhone(val) {
  if (val == null) return '';
  const digits = String(val).replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

function cleanEmail(val) {
  if (!val) return null;
  const str = String(val).trim().toLowerCase();
  if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(str)) {
    return str.slice(0, 150);
  }
  return null;
}

function cleanEnum(val, allowlist, fallback = null) {
  if (val == null) return fallback;
  const str = String(val).trim();
  const found = allowlist.find((item) => item.toLowerCase() === str.toLowerCase());
  return found !== undefined ? found : fallback;
}

function sanitizeObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObjectKeys);
  }
  const cleanObj = {};
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_PROTO_KEYS.has(key)) {
      continue;
    }
    cleanObj[key] = sanitizeObjectKeys(obj[key]);
  }
  return cleanObj;
}

module.exports = {
  checkRateLimit,
  constantTimeCompare,
  csrfMiddleware,
  verifyCsrf,
  maskPhone,
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanFloat,
  cleanBool,
  cleanUrl,
  cleanPhone,
  cleanEmail,
  cleanEnum,
  sanitizeObjectKeys
};
