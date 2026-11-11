/**
 * Coupon and Promotion Management service for shop-api.
 * Provides validation for checkout, full administrative CRUD, and usage analytics.
 */
const { pool } = require('./db');
const { ApiError, badRequest, notFound } = require('./errors');
const {
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanFloat,
  cleanBool,
  cleanEnum
} = require('./sanitize');

/**
 * Validates a coupon code against a subtotal amount.
 */
async function validateCoupon(rawCode, rawSubtotal) {
  const code = cleanIdentifier(rawCode, '-_');
  const subtotal = cleanFloat(rawSubtotal, 0, 10000000, 2, 0);

  if (!code) throw badRequest('Coupon code is required');

  const q = await pool.query(
    'SELECT * FROM coupons WHERE LOWER(code) = LOWER($1)',
    [code]
  );
  if (!q.rowCount) {
    throw new ApiError(404, 'COUPON_NOT_FOUND', `Coupon "${code}" was not found or is invalid.`);
  }

  const coupon = q.rows[0];
  if (!coupon.active) {
    throw new ApiError(400, 'COUPON_INACTIVE', `Coupon "${coupon.code}" is currently disabled.`);
  }

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    throw new ApiError(400, 'COUPON_EXPIRED', `Coupon "${coupon.code}" has expired.`);
  }

  if (coupon.scope !== 'unlimited' && coupon.usage_limit != null && coupon.usage_count >= coupon.usage_limit) {
    throw new ApiError(400, 'COUPON_LIMIT_REACHED', `Coupon "${coupon.code}" has reached its maximum usage limit.`);
  }

  if (subtotal < Number(coupon.min_order_amount)) {
    throw new ApiError(
      400,
      'COUPON_MIN_ORDER',
      `Coupon "${coupon.code}" requires a minimum subtotal of ₹${Number(coupon.min_order_amount).toLocaleString('en-IN')}.`
    );
  }

  let discount = 0;
  if (coupon.discount_type === 'percent') {
    discount = Math.round(subtotal * (Number(coupon.discount_value) / 100) * 100) / 100;
  } else {
    discount = Math.round(Math.min(Number(coupon.discount_value), subtotal) * 100) / 100;
  }

  return {
    ok: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      description: coupon.description,
      discount_type: coupon.discount_type,
      discount_value: Number(coupon.discount_value),
      min_order_amount: Number(coupon.min_order_amount),
      discount
    }
  };
}

/**
 * Lists all coupons and calculates summary metrics.
 */
async function listCoupons() {
  const couponsRes = await pool.query(
    'SELECT * FROM coupons ORDER BY created_at DESC'
  );

  const statsRes = await pool.query(`
    SELECT
      COUNT(*)::int AS total_coupons,
      COUNT(*) FILTER (WHERE active = true AND (expires_at IS NULL OR expires_at > now()))::int AS active_coupons,
      COALESCE(SUM(usage_count), 0)::int AS total_redemptions
    FROM coupons
  `);

  const orderDiscountRes = await pool.query(`
    SELECT
      COALESCE(SUM(discount), 0)::numeric AS total_discount_given,
      COUNT(*) FILTER (WHERE coupon_code IS NOT NULL)::int AS discounted_orders
    FROM orders
    WHERE status NOT IN ('CANCELLED', 'REFUNDED')
  `);

  const stats = {
    totalCoupons: statsRes.rows[0]?.total_coupons || 0,
    activeCoupons: statsRes.rows[0]?.active_coupons || 0,
    totalRedemptions: statsRes.rows[0]?.total_redemptions || 0,
    totalDiscountGiven: parseFloat(orderDiscountRes.rows[0]?.total_discount_given || '0'),
    discountedOrders: orderDiscountRes.rows[0]?.discounted_orders || 0,
  };

  return {
    coupons: couponsRes.rows,
    stats
  };
}

/**
 * Creates a new coupon with strict sanitization.
 */
async function createCoupon(body) {
  const code = cleanIdentifier(body.code, '-_');
  if (!code || code.length < 3) {
    throw badRequest('Coupon code must be at least 3 alphanumeric characters long');
  }

  const desc = cleanString(body.description, { maxLength: 300 }) || null;
  const type = cleanEnum(body.discount_type, ['percent', 'flat'], 'percent');
  const value = cleanFloat(body.discount_value, 0.01, 100000, 2, 10);
  const minOrder = cleanFloat(body.min_order_amount, 0, 1000000, 2, 0);

  const scope = cleanEnum(body.scope, ['unlimited', 'custom', 'single_use'], 'unlimited');
  let usageLimit = null;
  if (scope === 'single_use') {
    usageLimit = 1;
  } else if (scope === 'custom') {
    usageLimit = cleanInt(body.usage_limit || body.custom_usage_limit, 1, 1000000, 50);
  }

  let expiresAt = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at);
    if (!isNaN(d.getTime())) expiresAt = d.toISOString();
  } else if (body.expires_in_days) {
    const days = cleanInt(body.expires_in_days, 1, 3650, 0);
    if (days > 0) {
      expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    }
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_amount, scope, usage_limit, usage_count, active, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, true, $8)
       RETURNING *;`,
      [code, desc, type, value, minOrder, scope, usageLimit, expiresAt]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw new ApiError(409, 'COUPON_EXISTS', `A coupon with code "${code}" already exists.`);
    }
    throw err;
  }
}

/**
 * Toggles active state of a coupon.
 */
async function toggleCouponStatus(id) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid coupon ID is required');

  const { rows } = await pool.query(
    `UPDATE coupons
     SET active = NOT active, updated_at = now()
     WHERE id = $1
     RETURNING *;`,
    [numId]
  );
  if (!rows.length) throw notFound(`Coupon #${numId} not found`);
  return rows[0];
}

/**
 * Extends the expiration date of a coupon.
 */
async function extendCoupon(id, { days, new_date }) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid coupon ID is required');

  let updateQuery;
  let queryArgs;

  if (new_date) {
    const d = new Date(new_date);
    if (isNaN(d.getTime())) throw badRequest('Invalid target expiration date');
    updateQuery = `UPDATE coupons SET expires_at = $1, updated_at = now() WHERE id = $2 RETURNING *;`;
    queryArgs = [d.toISOString(), numId];
  } else {
    const addDays = cleanInt(days, 1, 3650, 30);
    updateQuery = `
      UPDATE coupons
         SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + ($1 || ' days')::interval,
             updated_at = now()
       WHERE id = $2
       RETURNING *;
    `;
    queryArgs = [addDays, numId];
  }

  const { rows } = await pool.query(updateQuery, queryArgs);
  if (!rows.length) throw notFound(`Coupon #${numId} not found`);
  return rows[0];
}

/**
 * Updates coupon configuration.
 */
async function updateCoupon(id, body) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid coupon ID is required');

  const code = cleanIdentifier(body.code, '-_');
  if (!code || code.length < 3) {
    throw badRequest('Coupon code must be at least 3 alphanumeric characters long');
  }

  const desc = cleanString(body.description, { maxLength: 300 }) || null;
  const type = cleanEnum(body.discount_type, ['percent', 'flat'], 'percent');
  const value = cleanFloat(body.discount_value, 0.01, 100000, 2, 10);
  const minOrder = cleanFloat(body.min_order_amount, 0, 1000000, 2, 0);

  const scope = cleanEnum(body.scope, ['unlimited', 'custom', 'single_use'], 'unlimited');
  let usageLimit = null;
  if (scope === 'single_use') {
    usageLimit = 1;
  } else if (scope === 'custom') {
    usageLimit = cleanInt(body.usage_limit || body.custom_usage_limit, 1, 1000000, 50);
  }

  let expDate = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at);
    if (!isNaN(d.getTime())) expDate = d.toISOString();
  }

  try {
    const { rows } = await pool.query(
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
        WHERE id = $9
        RETURNING *;`,
      [code, desc, type, value, minOrder, scope, usageLimit, expDate, numId]
    );
    if (!rows.length) throw notFound(`Coupon #${numId} not found`);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw new ApiError(409, 'COUPON_EXISTS', 'Coupon code already in use by another promotion.');
    }
    throw err;
  }
}

/**
 * Deletes a coupon.
 */
async function deleteCoupon(id) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid coupon ID is required');

  const { rows } = await pool.query(
    'DELETE FROM coupons WHERE id = $1 RETURNING code',
    [numId]
  );
  if (!rows.length) throw notFound(`Coupon #${numId} not found`);
  return rows[0];
}

module.exports = {
  validateCoupon,
  listCoupons,
  createCoupon,
  toggleCouponStatus,
  extendCoupon,
  updateCoupon,
  deleteCoupon,
};
