import express from 'express';
import { authenticateUser, signSession, COOKIE_NAME } from '../auth.js';

const router = express.Router();

/**
 * GET /login
 */
router.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/');
  }
  res.render('login', {
    title: 'Staff Access Login',
    layout: false, // Dedicated full-page auth layout
    returnTo: req.query.returnTo || '',
    error: req.query.error || null
  });
});

/**
 * POST /login
 */
router.post('/login', (req, res) => {
  const { username, password, returnTo } = req.body;
  const user = authenticateUser(username, password);

  if (!user) {
    return res.status(401).render('login', {
      title: 'Staff Access Login',
      layout: false,
      returnTo: returnTo || '',
      error: 'Invalid credentials. Please verify your staff username and password.'
    });
  }

  const token = signSession(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000 // 7 days
  });

  // Redirect to requested URL, or role default destination
  if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
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
