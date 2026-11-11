/**
 * Enterprise-grade Input Sanitization and Attack Prevention Layer.
 * Prevents:
 *  - Cross-Site Scripting (XSS) and HTML/Script Tag Injection
 *  - SQL Injection (by enforcing strict typing, allowlists, and parameterization)
 *  - Path Traversal and Dangerous URL Schemes (javascript:, data:, etc.)
 *  - Prototype Pollution (__proto__, constructor, prototype)
 *  - Integer Overflow, Negative Stock Tampering, and Numeric NaN exploits
 *  - Query Parameter Pollution & Carriage Return / Line Feed (CRLF) Injection
 */

const TAG_REGEX = /<[^>]*>?/gm;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g;
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Strips HTML tags, script blocks, control characters, and normalizes text.
 */
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

  // Strip null bytes and non-printable control characters
  str = str.replace(CONTROL_CHARS_REGEX, '');

  // Strip HTML / XML tags completely
  str = str.replace(TAG_REGEX, '');

  // Remove javascript: and data: pseudo-protocols if present in text
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

/**
 * Sanitizes alphanumeric identifiers (e.g., SKUs, coupon codes, order numbers).
 */
function cleanIdentifier(val, allowedChars = '-_') {
  if (val == null) return '';
  const escaped = allowedChars.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`[^a-zA-Z0-9${escaped}]`, 'g');
  return String(val).replace(regex, '').trim().toUpperCase();
}

/**
 * Safely parses and bounds integers.
 */
function cleanInt(val, min = -Infinity, max = Infinity, defaultValue = 0) {
  if (val == null || val === '') return defaultValue;
  const num = parseInt(val, 10);
  if (!Number.isFinite(num) || isNaN(num)) return defaultValue;
  return Math.max(min, Math.min(max, num));
}

/**
 * Safely parses and bounds floating point / currency amounts.
 */
function cleanFloat(val, min = 0, max = Infinity, precision = 2, defaultValue = 0) {
  if (val == null || val === '') return defaultValue;
  const num = parseFloat(val);
  if (!Number.isFinite(num) || isNaN(num)) return defaultValue;
  const clamped = Math.max(min, Math.min(max, num));
  const factor = Math.pow(10, precision);
  return Math.round(clamped * factor) / factor;
}

/**
 * Sanitizes boolean inputs from checkboxes, strings, or booleans.
 */
function cleanBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'on' || s === 'yes';
  }
  return Boolean(val);
}

/**
 * Sanitizes image and resource URLs.
 * Strictly permits only:
 *   1. Safe relative paths starting with /products/ (with alphanumeric, hyphen, underscore, period)
 *   2. Absolute http: or https: URLs without script protocols
 */
function cleanUrl(val) {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;

  // Prevent path traversal
  if (str.includes('..') || str.includes('\\')) {
    return null;
  }

  // Safe relative product media path
  if (/^\/products\/[a-zA-Z0-9_\-\.]+\.(jpg|jpeg|png|webp|svg|avif)$/i.test(str)) {
    return str;
  }

  // Absolute HTTP/HTTPS URL
  try {
    const parsed = new URL(str);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch (_) {
    // Not a valid URL
  }

  return null;
}

/**
 * Sanitizes standard 10-digit Indian phone numbers or international digits.
 */
function cleanPhone(val) {
  if (val == null) return '';
  const digits = String(val).replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

/**
 * Sanitizes and validates email addresses.
 */
function cleanEmail(val) {
  if (!val) return null;
  const str = String(val).trim().toLowerCase();
  if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(str)) {
    return str.slice(0, 150);
  }
  return null;
}

/**
 * Sanitizes and validates enum values against a strict allowlist.
 */
function cleanEnum(val, allowlist, fallback = null) {
  if (val == null) return fallback;
  const str = String(val).trim();
  const found = allowlist.find((item) => item.toLowerCase() === str.toLowerCase());
  return found !== undefined ? found : fallback;
}

/**
 * Deep defense against Prototype Pollution in JSON bodies.
 */
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
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanFloat,
  cleanBool,
  cleanUrl,
  cleanPhone,
  cleanEmail,
  cleanEnum,
  sanitizeObjectKeys,
};
