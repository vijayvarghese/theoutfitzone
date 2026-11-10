import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { getOrderMetrics } from '../orders-db.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    // 1. Core Inventory KPIs
    const kpiRes = await query(`
      SELECT
        COUNT(DISTINCT p.id) AS total_products,
        COUNT(DISTINCT v.id) AS total_variants,
        COALESCE(SUM(v.on_hand), 0) AS total_on_hand,
        COALESCE(SUM(v.reserved), 0) AS total_reserved,
        COALESCE(SUM(v.on_hand - v.reserved), 0) AS total_available,
        COALESCE(SUM(p.price_inr * v.on_hand), 0) AS total_valuation,
        COUNT(DISTINCT CASE WHEN (v.on_hand - v.reserved) <= v.reorder_level THEN v.id END) AS low_stock_count,
        COUNT(DISTINCT CASE WHEN (v.on_hand - v.reserved) <= 0 THEN v.id END) AS out_of_stock_count
      FROM products p
      LEFT JOIN variants v ON v.product_id = p.id
      WHERE p.active = true;
    `);
    const kpis = kpiRes.rows[0] || {};

    // 2. Urgent Low Stock / Reorder Variants
    const lowStockRes = await query(`
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

    // 3. Recent Stock Movements Audit Feed
    const movementsRes = await query(`
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
    const categoryRes = await query(`
      SELECT
        COALESCE(p.category, 'Uncategorized') AS category,
        COUNT(DISTINCT p.id) AS product_count,
        COUNT(DISTINCT v.id) AS variant_count,
        COALESCE(SUM(v.on_hand - v.reserved), 0) AS available_pieces
      FROM products p
      LEFT JOIN variants v ON v.product_id = p.id
      WHERE p.active = true
      GROUP BY p.category
      ORDER BY available_pieces DESC;
    `);

    // 5. Product list for modal
    const prodRes = await query(`
      SELECT id, name FROM products WHERE active = true ORDER BY name ASC;
    `);

    // 6. Orders Metrics for Owner & Staff1
    let orderMetrics = null;
    let recentOrders = [];
    if (res.locals.canManageOrders) {
      orderMetrics = await getOrderMetrics();
      const recentOrdersRes = await query(`
        SELECT o.order_no, o.status, o.total, o.created_at, c.name AS customer_name,
               (SELECT COALESCE(SUM(qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS items_count
          FROM orders o
          LEFT JOIN customers c ON c.id = o.customer_id
         ORDER BY o.id DESC
         LIMIT 5;
      `);
      recentOrders = recentOrdersRes.rows;
    }

    // 7. Coupon & Promotion Budget Metrics
    let couponMetrics = null;
    try {
      const coupRes = await query(`
        SELECT
          COUNT(*) FILTER (WHERE active = true AND (expires_at IS NULL OR expires_at > now())) AS active_coupons,
          COALESCE(SUM(usage_count), 0) AS total_redemptions
        FROM coupons;
      `);
      const coupDiscountRes = await query(`
        SELECT
          COALESCE(SUM(discount), 0) AS total_discount_given,
          COUNT(*) FILTER (WHERE coupon_code IS NOT NULL) AS discounted_orders
        FROM orders
        WHERE status NOT IN ('CANCELLED', 'REFUNDED');
      `);
      couponMetrics = {
        activeCoupons: parseInt(coupRes.rows[0].active_coupons || '0', 10),
        totalRedemptions: parseInt(coupRes.rows[0].total_redemptions || '0', 10),
        totalDiscountGiven: parseFloat(coupDiscountRes.rows[0].total_discount_given || '0'),
        discountedOrders: parseInt(coupDiscountRes.rows[0].discounted_orders || '0', 10)
      };
    } catch {
      couponMetrics = { activeCoupons: 0, totalRedemptions: 0, totalDiscountGiven: 0, discountedOrders: 0 };
    }

    res.render('dashboard', {
      title: 'Staff Operations & Inventory Dashboard',
      currentPath: '/',
      kpis,
      lowStockItems: lowStockRes.rows,
      recentMovements: movementsRes.rows,
      categories: categoryRes.rows,
      products: prodRes.rows,
      orderMetrics,
      recentOrders,
      couponMetrics
    });
  } catch (err) {
    next(err);
  }
});

export default router;
