/**
 * Input Sanitization and Attack Prevention Utilities for Staff Inventory Portal.
 * Strips XSS, handles prototype pollution, validates types and ranges.
 */

const TAG_REGEX = /<[^>]*>?/gm;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g;
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function cleanString(val, options = {}) {
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

export function cleanIdentifier(val, allowedChars = '-_') {
  if (val == null) return '';
  const escaped = allowedChars.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`[^a-zA-Z0-9${escaped}]`, 'g');
  return String(val).replace(regex, '').trim().toUpperCase();
}

export function cleanInt(val, min = -Infinity, max = Infinity, defaultValue = 0) {
  if (val == null || val === '') return defaultValue;
  const num = parseInt(val, 10);
  if (!Number.isFinite(num) || isNaN(num)) return defaultValue;
  return Math.max(min, Math.min(max, num));
}

export function cleanFloat(val, min = 0, max = Infinity, precision = 2, defaultValue = 0) {
  if (val == null || val === '') return defaultValue;
  const num = parseFloat(val);
  if (!Number.isFinite(num) || isNaN(num)) return defaultValue;
  const clamped = Math.max(min, Math.min(max, num));
  const factor = Math.pow(10, precision);
  return Math.round(clamped * factor) / factor;
}

export function cleanBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'on' || s === 'yes';
  }
  return Boolean(val);
}

export function cleanUrl(val) {
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

export function cleanPhone(val) {
  if (val == null) return '';
  const digits = String(val).replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

export function cleanEmail(val) {
  if (!val) return null;
  const str = String(val).trim().toLowerCase();
  if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(str)) {
    return str.slice(0, 150);
  }
  return null;
}

export function cleanEnum(val, allowlist, fallback = null) {
  if (val == null) return fallback;
  const str = String(val).trim();
  const found = allowlist.find((item) => item.toLowerCase() === str.toLowerCase());
  return found !== undefined ? found : fallback;
}

export function sanitizeObjectKeys(obj) {
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
