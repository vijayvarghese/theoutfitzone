import express from 'express';
import { pool } from '../db.js';
import { requireRole } from '../auth.js';

const router = express.Router();

// All coupon management routes require owner role
router.use(requireRole('owner'));

/**
 * Generate an elegant, memorable, stylish coupon code
 */
export function generateCouponCode() {
  const prefixes = ['AURA', 'ATELIER', 'SILK', 'FESTIVE', 'BLOOM', 'ROYAL', 'INDIGO', 'THREAD', 'VELVET', 'CHANDERI'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // readable without 0/O, 1/I confusion
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}-${suffix}`;
}

/**
 * GET /coupons/generate-code (API helper for interactive UI generation)
 */
router.get('/generate-code', (req, res) => {
  res.json({ code: generateCouponCode() });
});

/**
 * GET /coupons
 */
router.get('/', async (req, res, next) => {
  try {
    const couponsRes = await pool.query(
      `SELECT * FROM coupons ORDER BY created_at DESC`
    );

    // Compute metrics
    const statsRes = await pool.query(`
      SELECT
        COUNT(*) AS total_coupons,
        COUNT(*) FILTER (WHERE active = true AND (expires_at IS NULL OR expires_at > now())) AS active_coupons,
        COALESCE(SUM(usage_count), 0) AS total_redemptions
      FROM coupons
    `);

    // Budget/discounts given from orders table
    const orderDiscountRes = await pool.query(`
      SELECT
        COALESCE(SUM(discount), 0) AS total_discount_given,
        COUNT(*) FILTER (WHERE coupon_code IS NOT NULL) AS discounted_orders
      FROM orders
      WHERE status NOT IN ('CANCELLED', 'REFUNDED')
    `);

    const stats = {
      totalCoupons: parseInt(statsRes.rows[0].total_coupons || '0', 10),
      activeCoupons: parseInt(statsRes.rows[0].active_coupons || '0', 10),
      totalRedemptions: parseInt(statsRes.rows[0].total_redemptions || '0', 10),
      totalDiscountGiven: parseFloat(orderDiscountRes.rows[0].total_discount_given || '0'),
      discountedOrders: parseInt(orderDiscountRes.rows[0].discounted_orders || '0', 10)
    };

    res.render('coupons/index', {
      title: 'Coupon & Promotion Management',
      coupons: couponsRes.rows,
      stats,
      sampleCode: generateCouponCode(),
      flash: req.query.flash || null,
      error: req.query.error || null
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /coupons/new
 */
router.post('/new', async (req, res, next) => {
  try {
    let {
      code,
      description,
      discount_type,
      discount_value,
      min_order_amount,
      scope,
      custom_usage_limit,
      expires_in_days,
      custom_expires_at
    } = req.body;

    // Clean code: uppercase, strip extra spaces
    code = String(code || '').trim().toUpperCase();
    if (!code) {
      code = generateCouponCode();
    }

    const desc = String(description || '').trim() || null;
    const type = ['percent', 'flat'].includes(discount_type) ? discount_type : 'percent';
    const value = Math.max(0.01, parseFloat(discount_value) || 10);
    const minOrder = Math.max(0, parseFloat(min_order_amount) || 0);

    const scopeChoice = ['unlimited', 'custom', 'single_use'].includes(scope) ? scope : 'unlimited';
    let usageLimit = null;
    if (scopeChoice === 'single_use') {
      usageLimit = 1;
    } else if (scopeChoice === 'custom') {
      usageLimit = Math.max(1, parseInt(custom_usage_limit, 10) || 50);
    }

    let expiresAt = null;
    if (custom_expires_at && custom_expires_at.trim()) {
      expiresAt = new Date(custom_expires_at.trim());
    } else if (expires_in_days && parseInt(expires_in_days, 10) > 0) {
      const days = parseInt(expires_in_days, 10);
      expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
    }

    await pool.query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_amount, scope, usage_limit, usage_count, active, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, true, $8)`,
      [code, desc, type, value, minOrder, scopeChoice, usageLimit, expiresAt]
    );

    res.redirect(`/coupons?flash=Promotion%20coupon%20"${encodeURIComponent(code)}"%20successfully%20created.`);
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect(`/coupons?error=A%20coupon%20with%20code%20"${encodeURIComponent(req.body.code)}"%20already%20exists.`);
    }
    next(err);
  }
});

/**
 * POST /coupons/:id/toggle-status
 */
router.post('/:id/toggle-status', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      `UPDATE coupons
          SET active = NOT active, updated_at = now()
        WHERE id = $1
        RETURNING code, active`,
      [id]
    );
    if (!r.rowCount) {
      return res.redirect('/coupons?error=Coupon%20not%20found.');
    }
    const state = r.rows[0].active ? 'activated' : 'deactivated';
    res.redirect(`/coupons?flash=Coupon%20"${encodeURIComponent(r.rows[0].code)}"%20has%20been%20${state}.`);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /coupons/:id/extend
 */
router.post('/:id/extend', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { days, new_date } = req.body;

    let updateQuery;
    let queryArgs;

    if (new_date && new_date.trim()) {
      updateQuery = `UPDATE coupons SET expires_at = $1, updated_at = now() WHERE id = $2 RETURNING code, expires_at`;
      queryArgs = [new Date(new_date.trim()), id];
    } else {
      const addDays = Math.max(1, parseInt(days, 10) || 30);
      updateQuery = `
        UPDATE coupons
           SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + ($1 || ' days')::interval,
               updated_at = now()
         WHERE id = $2
         RETURNING code, expires_at
      `;
      queryArgs = [addDays, id];
    }

    const r = await pool.query(updateQuery, queryArgs);
    if (!r.rowCount) {
      return res.redirect('/coupons?error=Coupon%20not%20found.');
    }
    res.redirect(`/coupons?flash=Validity%20extended%20for%20"${encodeURIComponent(r.rows[0].code)}".`);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /coupons/:id/update
 */
router.post('/:id/update', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    let {
      code,
      description,
      discount_type,
      discount_value,
      min_order_amount,
      scope,
      custom_usage_limit,
      expires_at
    } = req.body;

    code = String(code || '').trim().toUpperCase();
    const desc = String(description || '').trim() || null;
    const type = ['percent', 'flat'].includes(discount_type) ? discount_type : 'percent';
    const value = Math.max(0.01, parseFloat(discount_value) || 10);
    const minOrder = Math.max(0, parseFloat(min_order_amount) || 0);

    const scopeChoice = ['unlimited', 'custom', 'single_use'].includes(scope) ? scope : 'unlimited';
    let usageLimit = null;
    if (scopeChoice === 'single_use') {
      usageLimit = 1;
    } else if (scopeChoice === 'custom') {
      usageLimit = Math.max(1, parseInt(custom_usage_limit, 10) || 50);
    }

    const expDate = expires_at && expires_at.trim() ? new Date(expires_at.trim()) : null;

    await pool.query(
      `UPDATE coupons
          SET code = $1,
              description = $2,
              discount_type = $3,
              discount_value = $4,
              min_order_amount = $5,
              scope = $6,
              usage_limit = $7,
              expires_at = $8,
              updated_at = now()
        WHERE id = $9`,
      [code, desc, type, value, minOrder, scopeChoice, usageLimit, expDate, id]
    );

    res.redirect(`/coupons?flash=Coupon%20"${encodeURIComponent(code)}"%20updated%20successfully.`);
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect(`/coupons?error=Coupon%20code%20already%20in%20use.`);
    }
    next(err);
  }
});

/**
 * POST /coupons/:id/delete
 */
router.post('/:id/delete', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(`DELETE FROM coupons WHERE id = $1 RETURNING code`, [id]);
    if (!r.rowCount) {
      return res.redirect('/coupons?error=Coupon%20not%20found.');
    }
    res.redirect(`/coupons?flash=Coupon%20"${encodeURIComponent(r.rows[0].code)}"%20deleted.`);
  } catch (err) {
    next(err);
  }
});

export default router;
