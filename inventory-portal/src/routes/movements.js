import express from 'express';
import { api } from '../api.js';
import { requireAuth } from '../auth.js';
import { cleanString, cleanInt } from '../sanitize.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const sku = cleanString(req.query.sku);
    const reason = cleanString(req.query.reason);
    const direction = cleanString(req.query.direction, { toLower: true }) || 'all';
    const limitNum = cleanInt(req.query.limit, 10, 100, 50);
    const pageNum = cleanInt(req.query.page, 1, 100000, 1);
    const offset = (pageNum - 1) * limitNum;

    const data = await api.getMovements({
      sku,
      reason,
      direction,
      limit: limitNum,
      offset
    });

    const totalCount = data.totalCount || 0;
    const movements = data.movements || [];

    res.render('movements/index', {
      title: 'Stock Movement Audit History',
      currentPath: '/movements',
      movements,
      totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalCount / limitNum) || 1,
      filters: { sku: sku || '', reason: reason || 'all', direction: direction || 'all' }
    });
  } catch (err) {
    next(err);
  }
});

// CSV Export
router.get('/export.csv', async (req, res, next) => {
  try {
    const movements = await api.exportMovements();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-movements-audit.csv"');

    let csv = 'ID,Timestamp,Product,SKU,Size,Colour,Delta,Qty After,Reason\n';
    movements.forEach((r) => {
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
