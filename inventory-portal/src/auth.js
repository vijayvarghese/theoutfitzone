import crypto from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || 'inventory-portal-super-secret-key-at-least-32-chars';
const COOKIE_NAME = 'portal_session';

/**
 * Parse user definitions from environment variables.
 * Expected formats:
 *   AUTH_USER_OWNER="owner:owner123"
 *   AUTH_USER_STAFF1="staff1:staff123"
 *   AUTH_USER_STOCK_ADDER="stock_adder:stock123"
 * Or fallback defaults.
 */
export function getUsersConfig() {
  const users = {};

  function parseEntry(envVal, defaultUser, defaultPass, role, name, badge) {
    let username = defaultUser;
    let password = defaultPass;
    if (envVal) {
      if (envVal.includes(':')) {
        const parts = envVal.split(':');
        username = parts[0].trim();
        password = parts[1].trim();
      } else {
        password = envVal.trim();
      }
    }
    users[username] = {
      username,
      password,
      role,
      name,
      badge
    };
  }

  parseEntry(
    process.env.AUTH_USER_OWNER,
    'owner',
    'owner123',
    'owner',
    'Store Director (Owner)',
    '👑 Owner'
  );

  parseEntry(
    process.env.AUTH_USER_STAFF1,
    'staff1',
    'staff123',
    'staff1',
    'Fulfillment Team (Staff 1)',
    '📦 Staff 1'
  );

  parseEntry(
    process.env.AUTH_USER_STOCK_ADDER,
    'stock_adder',
    'stock123',
    'stock_adder',
    'Catalog Specialist (Stock Adder)',
    '🏷️ Stock Adder'
  );

  // Optional AUTH_USERS CSV: "user1:pass1:role1,user2:pass2:role2"
  if (process.env.AUTH_USERS) {
    const entries = process.env.AUTH_USERS.split(',');
    for (const entry of entries) {
      const parts = entry.trim().split(':');
      if (parts.length >= 2) {
        const u = parts[0].trim();
        const p = parts[1].trim();
        const r = (parts[2] || 'staff1').trim();
        users[u] = {
          username: u,
          password: p,
          role: r,
          name: `${u} (${r})`,
          badge: r === 'owner' ? '👑 Owner' : r === 'stock_adder' ? '🏷️ Stock Adder' : '📦 Staff'
        };
      }
    }
  }

  return users;
}

export function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function authenticateUser(username, password) {
  if (!username || !password) return null;
  const users = getUsersConfig();
  const candidate = users[username.trim()];
  if (!candidate) return null;
  if (!constantTimeCompare(password, candidate.password)) {
    return null;
  }
  return {
    username: candidate.username,
    role: candidate.role,
    name: candidate.name,
    badge: candidate.badge
  };
}

export function signSession(user) {
  const payload = {
    u: user.username,
    r: user.role,
    n: user.name,
    b: user.badge,
    t: Date.now()
  };
  const json = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(json).digest('base64url');
  return `${json}.${hmac}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [json, hmac] = token.split('.');
  if (!json || !hmac) return null;
  const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(json).digest('base64url');
  if (!constantTimeCompare(hmac, expectedHmac)) return null;

  try {
    const raw = Buffer.from(json, 'base64url').toString('utf8');
    const data = JSON.parse(raw);
    if (!data.u || !data.r) return null;
    return {
      username: data.u,
      role: data.r,
      name: data.n,
      badge: data.b,
      issuedAt: data.t
    };
  } catch {
    return null;
  }
}

/**
 * Middleware: populates req.user & template locals
 */
export function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = verifySession(token);

  if (user) {
    req.user = user;
    res.locals.user = user;
    res.locals.isOwner = user.role === 'owner';
    res.locals.canManageOrders = ['owner', 'staff1'].includes(user.role);
    res.locals.canModifyStock = ['owner', 'stock_adder'].includes(user.role);
    res.locals.canManageCatalog = ['owner', 'stock_adder'].includes(user.role);
    res.locals.canDelete = user.role === 'owner';
  } else {
    req.user = null;
    res.locals.user = null;
    res.locals.isOwner = false;
    res.locals.canManageOrders = false;
    res.locals.canModifyStock = false;
    res.locals.canManageCatalog = false;
    res.locals.canDelete = false;
  }
  next();
}

/**
 * Middleware: requires an authenticated session
 */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  const returnTo = req.originalUrl || req.url;
  return res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/**
 * Middleware: requires one of the allowed roles (owner is always allowed)
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      const returnTo = req.originalUrl || req.url;
      return res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    if (req.user.role === 'owner' || allowedRoles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).render('error', {
      title: '403 Forbidden - Role Restricted',
      message: `Your current role [${req.user.badge || req.user.role}] is not authorized to access this operational feature. Allowed roles: ${allowedRoles.join(', ')}.`
    });
  };
}

export { COOKIE_NAME };
