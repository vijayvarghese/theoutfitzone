import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { sku, reason, direction, limit = 50, page = 1 } = req.query;

    const conditions = [];
    const params = [];

    if (sku && sku.trim()) {
      params.push(`%${sku.trim()}%`);
      conditions.push(`v.sku ILIKE $${params.length}`);
    }

    if (reason && reason !== 'all') {
      params.push(`%${reason.trim()}%`);
      conditions.push(`sm.reason ILIKE $${params.length}`);
    }

    if (direction === 'positive') {
      conditions.push('sm.delta > 0');
    } else if (direction === 'negative') {
      conditions.push('sm.delta < 0');
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const limitNum = Math.min(100, Math.max(10, parseInt(limit, 10) || 50));
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * limitNum;

    // Total count
    const countRes = await query(`
      SELECT COUNT(sm.id) AS total
      FROM stock_movements sm
      JOIN variants v ON v.id = sm.variant_id
      JOIN products p ON p.id = v.product_id
      ${whereClause};
    `, params);
    const totalCount = parseInt(countRes.rows[0].total, 10) || 0;

    const sql = `
      SELECT
        sm.id,
        sm.delta,
        sm.qty_after,
        sm.reason,
        sm.at,
        sm.ref,
        v.id AS variant_id,
        v.sku,
        v.size,
        v.colour,
        p.id AS product_id,
        p.name AS product_name,
        p.category
      FROM stock_movements sm
      JOIN variants v ON v.id = sm.variant_id
      JOIN products p ON p.id = v.product_id
      ${whereClause}
      ORDER BY sm.at DESC
      LIMIT ${limitNum} OFFSET ${offset};
    `;

    const result = await query(sql, params);

    res.render('movements/index', {
      title: 'Stock Movement Audit History',
      currentPath: '/movements',
      movements: result.rows,
      totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalCount / limitNum),
      filters: { sku: sku || '', reason: reason || 'all', direction: direction || 'all' }
    });
  } catch (err) {
    next(err);
  }
});

// CSV Export
router.get('/export.csv', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        sm.id,
        sm.at,
        p.name AS product_name,
        v.sku,
        v.size,
        v.colour,
        sm.delta,
        sm.qty_after,
        sm.reason
      FROM stock_movements sm
      JOIN variants v ON v.id = sm.variant_id
      JOIN products p ON p.id = v.product_id
      ORDER BY sm.at DESC
      LIMIT 1000;
    `);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-movements-audit.csv"');

    let csv = 'ID,Timestamp,Product,SKU,Size,Colour,Delta,Qty After,Reason\n';
    result.rows.forEach(r => {
      const ts = new Date(r.at).toISOString();
      const prod = `"${(r.product_name || '').replace(/"/g, '""')}"`;
      const sku = `"${(r.sku || '').replace(/"/g, '""')}"`;
      const size = `"${(r.size || '').replace(/"/g, '""')}"`;
      const colour = `"${(r.colour || '').replace(/"/g, '""')}"`;
      const reason = `"${(r.reason || '').replace(/"/g, '""')}"`;
      csv += `${r.id},${ts},${prod},${sku},${size},${colour},${r.delta},${r.qty_after},${reason}\n`;
    });

    res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default router;
