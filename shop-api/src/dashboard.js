/**
 * Operations & Inventory Dashboard analytics service for shop-api.
 * Aggregates KPIs, urgent restock alerts, audit feed, category breakdown,
 * order metrics, and promotional coupon stats in a single protected endpoint.
 */
const { pool } = require('./db');
const { getOrderMetrics } = require('./orders');

async function getDashboardData({ includeOrders = true } = {}) {
  // 1. Core Inventory KPIs
  const kpiRes = await pool.query(`
    SELECT
      COUNT(DISTINCT p.id)::int AS total_products,
      COUNT(DISTINCT v.id)::int AS total_variants,
      COALESCE(SUM(v.on_hand), 0)::int AS total_on_hand,
      COALESCE(SUM(v.reserved), 0)::int AS total_reserved,
      COALESCE(SUM(v.on_hand - v.reserved), 0)::int AS total_available,
      COALESCE(SUM(p.price_inr * v.on_hand), 0)::numeric AS total_valuation,
      COUNT(DISTINCT CASE WHEN (v.on_hand - v.reserved) <= v.reorder_level THEN v.id END)::int AS low_stock_count,
      COUNT(DISTINCT CASE WHEN (v.on_hand - v.reserved) <= 0 THEN v.id END)::int AS out_of_stock_count
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    WHERE p.active = true;
  `);
  const kpis = kpiRes.rows[0] || {};

  // 2. Urgent Low Stock / Reorder Variants (Limit 12)
  const lowStockRes = await pool.query(`
    SELECT
      v.id AS variant_id,
      v.sku,
      v.size,
      v.colour,
      v.on_hand,
      v.reserved,
      (v.on_hand - v.reserved) AS available,
      v.reorder_level,
      p.id AS product_id,
      p.name AS product_name,
      p.category,
      p.image_url
    FROM variants v
    JOIN products p ON p.id = v.product_id
    WHERE (v.on_hand - v.reserved) <= v.reorder_level
      AND p.active = true
    ORDER BY (v.on_hand - v.reserved) ASC, v.reorder_level DESC
    LIMIT 12;
  `);

  // 3. Recent Stock Movements Audit Feed (Limit 8)
  const movementsRes = await pool.query(`
    SELECT
      sm.id,
      sm.delta,
      sm.qty_after,
      sm.reason,
      sm.at,
      sm.ref,
      v.sku,
      v.size,
      v.colour,
      p.name AS product_name
    FROM stock_movements sm
    JOIN variants v ON v.id = sm.variant_id
    JOIN products p ON p.id = v.product_id
    ORDER BY sm.at DESC
    LIMIT 8;
  `);

  // 4. Category breakdown
  const categoryRes = await pool.query(`
    SELECT
      COALESCE(p.category, 'Uncategorized') AS category,
      COUNT(DISTINCT p.id)::int AS product_count,
      COUNT(DISTINCT v.id)::int AS variant_count,
      COALESCE(SUM(v.on_hand - v.reserved), 0)::int AS available_pieces
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    WHERE p.active = true
    GROUP BY p.category
    ORDER BY available_pieces DESC;
  `);

  // 5. Active products for fast modals
  const prodRes = await pool.query(`
    SELECT id, name FROM products WHERE active = true ORDER BY name ASC;
  `);

  // 6. Orders Metrics & Recent Orders
  let orderMetrics = null;
  let recentOrders = [];
  if (includeOrders) {
    try {
      orderMetrics = await getOrderMetrics();
      const recentOrdersRes = await pool.query(`
        SELECT o.order_no, o.status, o.total, o.created_at, c.name AS customer_name,
               (SELECT COALESCE(SUM(qty), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS items_count
          FROM orders o
          LEFT JOIN customers c ON c.id = o.customer_id
         ORDER BY o.id DESC
         LIMIT 5;
      `);
      recentOrders = recentOrdersRes.rows;
    } catch (err) {
      console.error('[Dashboard] Orders metrics query failed:', err.message);
    }
  }

  // 7. Coupon Metrics
  let couponMetrics = { activeCoupons: 0, totalRedemptions: 0, totalDiscountGiven: 0, discountedOrders: 0 };
  try {
    const coupRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE active = true AND (expires_at IS NULL OR expires_at > now()))::int AS active_coupons,
        COALESCE(SUM(usage_count), 0)::int AS total_redemptions
      FROM coupons;
    `);
    const coupDiscountRes = await pool.query(`
      SELECT
        COALESCE(SUM(discount), 0)::numeric AS total_discount_given,
        COUNT(*) FILTER (WHERE coupon_code IS NOT NULL)::int AS discounted_orders
      FROM orders
      WHERE status NOT IN ('CANCELLED', 'REFUNDED');
    `);
    couponMetrics = {
      activeCoupons: coupRes.rows[0]?.active_coupons || 0,
      totalRedemptions: coupRes.rows[0]?.total_redemptions || 0,
      totalDiscountGiven: parseFloat(coupDiscountRes.rows[0]?.total_discount_given || '0'),
      discountedOrders: coupDiscountRes.rows[0]?.discounted_orders || 0,
    };
  } catch (err) {
    console.error('[Dashboard] Coupon metrics query failed:', err.message);
  }

  return {
    kpis,
    lowStockItems: lowStockRes.rows,
    recentMovements: movementsRes.rows,
    categories: categoryRes.rows,
    products: prodRes.rows,
    orderMetrics,
    recentOrders,
    couponMetrics,
  };
}

module.exports = { getDashboardData };
