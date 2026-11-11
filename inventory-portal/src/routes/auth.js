import express from 'express';
import { authenticateUser, signSession, COOKIE_NAME } from '../auth.js';
import { cleanString } from '../sanitize.js';

const router = express.Router();

const loginBuckets = new Map();
function isLoginRateLimited(ip) {
  const now = Date.now();
  let b = loginBuckets.get(ip);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + 15 * 60 * 1000 };
    loginBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count > 10;
}

/**
 * GET /login
 */
router.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/');
  }
  const returnTo = cleanString(req.query.returnTo);
  const error = cleanString(req.query.error);

  res.render('login', {
    title: 'Staff Access Login',
    layout: false,
    returnTo: returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '',
    error: error || null
  });
});

/**
 * POST /login
 */
router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  if (isLoginRateLimited(ip)) {
    return res.status(429).render('login', {
      title: 'Staff Access Login',
      layout: false,
      returnTo: '',
      error: 'Too many login attempts. Please wait 15 minutes before trying again.'
    });
  }

  const username = cleanString(req.body.username, { maxLength: 80 });
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const returnTo = cleanString(req.body.returnTo);

  const user = authenticateUser(username, password);

  if (!user) {
    return res.status(401).render('login', {
      title: 'Staff Access Login',
      layout: false,
      returnTo: returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '',
      error: 'Invalid credentials. Please verify your staff username and password.'
    });
  }

  const token = signSession(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000 // 7 days
  });

  if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.includes('\\')) {
    return res.redirect(returnTo);
  }

  if (user.role === 'stock_adder') {
    return res.redirect('/stock');
  } else if (user.role === 'staff1') {
    return res.redirect('/orders');
  }
  return res.redirect('/');
});

/**
 * POST /logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.redirect('/login');
});

/**
 * GET /logout
 */
router.get('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.redirect('/login');
});

export default router;
