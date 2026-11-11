import express from 'express';
import { api } from '../api.js';
import { requireRole } from '../auth.js';
import {
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanFloat,
  cleanEnum
} from '../sanitize.js';

const router = express.Router();

router.use(requireRole('owner'));

function getActor(req) {
  return req.user ? `${req.user.name} [${req.user.role}]` : 'Staff';
}

/**
 * Generate an elegant, memorable, stylish coupon code
 */
export function generateCouponCode() {
  const prefixes = ['AURA', 'ATELIER', 'SILK', 'FESTIVE', 'BLOOM', 'ROYAL', 'INDIGO', 'THREAD', 'VELVET', 'CHANDERI'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
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
    const data = await api.listCoupons();

    res.render('coupons/index', {
      title: 'Coupon & Promotion Management',
      coupons: data.coupons || [],
      stats: data.stats || { totalCoupons: 0, activeCoupons: 0, totalRedemptions: 0, totalDiscountGiven: 0, discountedOrders: 0 },
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
router.post('/new', async (req, res) => {
  try {
    let code = cleanIdentifier(req.body.code, '-_');
    if (!code) {
      code = generateCouponCode();
    }

    const description = cleanString(req.body.description, { maxLength: 300 });
    const discount_type = cleanEnum(req.body.discount_type, ['percent', 'flat'], 'percent');
    const discount_value = cleanFloat(req.body.discount_value, 0.01, 100000, 2, 10);
    const min_order_amount = cleanFloat(req.body.min_order_amount, 0, 1000000, 2, 0);

    const scope = cleanEnum(req.body.scope, ['unlimited', 'custom', 'single_use'], 'unlimited');
    let usage_limit = null;
    if (scope === 'single_use') {
      usage_limit = 1;
    } else if (scope === 'custom') {
      usage_limit = cleanInt(req.body.custom_usage_limit, 1, 1000000, 50);
    }

    let expires_at = null;
    if (req.body.custom_expires_at && req.body.custom_expires_at.trim()) {
      expires_at = req.body.custom_expires_at.trim();
    } else if (req.body.expires_in_days && parseInt(req.body.expires_in_days, 10) > 0) {
      const days = cleanInt(req.body.expires_in_days, 1, 3650, 0);
      expires_at = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    }

    await api.createCoupon({
      code,
      description,
      discount_type,
      discount_value,
      min_order_amount,
      scope,
      usage_limit,
      expires_at
    }, getActor(req));

    res.redirect(`/coupons?flash=Promotion%20coupon%20"${encodeURIComponent(code)}"%20successfully%20created.`);
  } catch (err) {
    res.redirect(`/coupons?error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /coupons/:id/toggle-status
 */
router.post('/:id/toggle-status', async (req, res) => {
  try {
    const id = cleanInt(req.params.id, 1);
    if (!id) throw new Error('Invalid coupon ID');

    const updated = await api.toggleCouponStatus(id, getActor(req));
    const state = updated.active ? 'activated' : 'deactivated';
    res.redirect(`/coupons?flash=Coupon%20"${encodeURIComponent(updated.code)}"%20has%20been%20${state}.`);
  } catch (err) {
    res.redirect(`/coupons?error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /coupons/:id/extend
 */
router.post('/:id/extend', async (req, res) => {
  try {
    const id = cleanInt(req.params.id, 1);
    if (!id) throw new Error('Invalid coupon ID');

    const days = cleanInt(req.body.days, 1, 3650, 30);
    const new_date = cleanString(req.body.new_date);

    const updated = await api.extendCoupon(id, { days, new_date }, getActor(req));
    res.redirect(`/coupons?flash=Validity%20extended%20for%20"${encodeURIComponent(updated.code)}".`);
  } catch (err) {
    res.redirect(`/coupons?error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /coupons/:id/update
 */
router.post('/:id/update', async (req, res) => {
  try {
    const id = cleanInt(req.params.id, 1);
    if (!id) throw new Error('Invalid coupon ID');

    const code = cleanIdentifier(req.body.code, '-_');
    const description = cleanString(req.body.description, { maxLength: 300 });
    const discount_type = cleanEnum(req.body.discount_type, ['percent', 'flat'], 'percent');
    const discount_value = cleanFloat(req.body.discount_value, 0.01, 100000, 2, 10);
    const min_order_amount = cleanFloat(req.body.min_order_amount, 0, 1000000, 2, 0);

    const scope = cleanEnum(req.body.scope, ['unlimited', 'custom', 'single_use'], 'unlimited');
    let usage_limit = null;
    if (scope === 'single_use') {
      usage_limit = 1;
    } else if (scope === 'custom') {
      usage_limit = cleanInt(req.body.custom_usage_limit, 1, 1000000, 50);
    }

    const expires_at = req.body.expires_at ? cleanString(req.body.expires_at) : null;

    const updated = await api.updateCoupon(id, {
      code,
      description,
      discount_type,
      discount_value,
      min_order_amount,
      scope,
      usage_limit,
      expires_at
    }, getActor(req));

    res.redirect(`/coupons?flash=Coupon%20"${encodeURIComponent(updated.code)}"%20updated%20successfully.`);
  } catch (err) {
    res.redirect(`/coupons?error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /coupons/:id/delete
 */
router.post('/:id/delete', async (req, res) => {
  try {
    const id = cleanInt(req.params.id, 1);
    if (!id) throw new Error('Invalid coupon ID');

    const deleted = await api.deleteCoupon(id, getActor(req));
    res.redirect(`/coupons?flash=Coupon%20"${encodeURIComponent(deleted.code)}"%20deleted.`);
  } catch (err) {
    res.redirect(`/coupons?error=${encodeURIComponent(err.message)}`);
  }
});

export default router;
