import express from 'express';
import { query, getClient } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { upload } from '../upload.js';

const router = express.Router();

router.use(requireAuth);

const sizePriority = {
  'xs': 1, 's': 2, 'm': 3, 'l': 4, 'xl': 5, 'xxl': 6, '2xl': 6, '3xl': 7,
  'free size': 10, 'free': 10, 'os': 10, 'one size': 10
};

// Main Variant Inventory Matrix
router.get('/', async (req, res, next) => {
  try {
    const { q, category, product_id, stock_status = 'all', size = 'all', sort = 'product-asc' } = req.query;

    const conditions = [];
    const params = [];

    if (product_id && parseInt(product_id, 10)) {
      params.push(parseInt(product_id, 10));
      conditions.push(`p.id = $${params.length}`);
    }

    if (category && category !== 'all') {
      params.push(category);
      conditions.push(`p.category = $${params.length}`);
    }

    if (size && size !== 'all') {
      params.push(size);
      conditions.push(`LOWER(v.size) = LOWER($${params.length})`);
    }

    if (stock_status === 'low') {
      conditions.push(`(v.on_hand - v.reserved) <= v.reorder_level AND (v.on_hand - v.reserved) > 0`);
    } else if (stock_status === 'out') {
      conditions.push(`(v.on_hand - v.reserved) <= 0`);
    } else if (stock_status === 'healthy') {
      conditions.push(`(v.on_hand - v.reserved) > v.reorder_level`);
    }

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      const idx = params.length;
      conditions.push(`(
        v.sku ILIKE $${idx}
        OR v.colour ILIKE $${idx}
        OR v.size ILIKE $${idx}
        OR p.name ILIKE $${idx}
      )`);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    let orderBy = 'p.name ASC, v.sku ASC';
    if (sort === 'product-asc') orderBy = 'p.name ASC, v.sku ASC';
    if (sort === 'sku-asc') orderBy = 'v.sku ASC';
    if (sort === 'available-asc') orderBy = 'available ASC';
    if (sort === 'available-desc') orderBy = 'available DESC';
    if (sort === 'on-hand-desc') orderBy = 'v.on_hand DESC';

    const sql = `
      SELECT
        v.id AS variant_id,
        v.product_id,
        v.sku,
        v.size,
        v.colour,
        v.image_url AS variant_image_url,
        COALESCE(v.image_url, p.image_url) AS image_url,
        v.on_hand,
        v.reserved,
        (v.on_hand - v.reserved) AS available,
        v.reorder_level,
        ((v.on_hand - v.reserved) <= v.reorder_level) AS is_low_stock,
        p.name AS product_name,
        p.category,
        p.price_inr,
        p.image_url AS product_image_url,
        p.active AS product_active
      FROM variants v
      JOIN products p ON p.id = v.product_id
      ${whereClause}
      ORDER BY ${orderBy};
    `;

    const result = await query(sql, params);

    // Filter helpers
    const catRes = await query(`
      SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category ASC;
    `);
    const prodRes = await query(`
      SELECT id, name FROM products ORDER BY name ASC;
    `);

    // Aggregate counts
    let totalOnHand = 0;
    let totalAvailable = 0;
    let totalReserved = 0;
    let lowCount = 0;
    let outCount = 0;

    result.rows.forEach(r => {
      totalOnHand += Number(r.on_hand) || 0;
      totalAvailable += Number(r.available) || 0;
      totalReserved += Number(r.reserved) || 0;
      if (r.available <= 0) outCount++;
      else if (r.available <= r.reorder_level) lowCount++;
    });

    res.render('stock/index', {
      title: 'Variant Inventory Control',
      currentPath: '/stock',
      variants: result.rows,
      categories: catRes.rows.map(r => r.category),
      products: prodRes.rows,
      totals: { totalOnHand, totalAvailable, totalReserved, lowCount, outCount },
      filters: { q: q || '', category: category || 'all', product_id: product_id || '', stock_status, size, sort }
    });
  } catch (err) {
    next(err);
  }
});

// Add New Variant to an Existing Product
router.post('/variants', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res, next) => {
  const redirectTarget = req.headers.referer || '/stock';
  try {
    const { product_id, sku, size, colour, on_hand, reorder_level, manual_image_url } = req.body;

    const prodIdNum = parseInt(product_id, 10);
    if (!prodIdNum) throw new Error('A valid silhouette / product must be selected.');

    const prodRes = await query('SELECT name, category FROM products WHERE id = $1', [prodIdNum]);
    if (!prodRes.rows.length) throw new Error('Product not found.');
    const prod = prodRes.rows[0];

    const sizeVal = (size || '').trim() || 'Free Size';
    const colourVal = (colour || '').trim() || 'Standard';
    const onHandNum = Math.max(0, parseInt(on_hand, 10) || 0);
    const reorderNum = Math.max(0, parseInt(reorder_level, 10) || 2);

    let imageUrl = null;
    if (req.file) {
      imageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url && manual_image_url.trim()) {
      imageUrl = manual_image_url.trim();
    }

    let cleanSku = (sku || '').trim().toUpperCase();
    if (!cleanSku) {
      // Auto-generate SKU based on product name, colour, size
      const words = (prod.name || prod.category || 'SIL').trim().split(/\s+/).filter(Boolean);
      let prefix = '';
      if (words.length >= 2) {
        prefix = words.map(w => w[0].toUpperCase()).join('').slice(0, 4);
      } else if (words.length === 1) {
        prefix = words[0].slice(0, 3).toUpperCase();
      }
      if (!prefix || prefix.length < 2) prefix = 'SIL';

      const colCode = colourVal.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'STD';
      const sizeCode = sizeVal.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'FS';
      cleanSku = `${prefix}-${colCode}-${sizeCode}`;
    }

    // Ensure unique SKU
    let candidateSku = cleanSku;
    let counter = 1;
    while (true) {
      const check = await query('SELECT 1 FROM variants WHERE sku = $1', [candidateSku]);
      if (check.rows.length === 0) break;
      candidateSku = `${cleanSku}-${counter++}`;
    }

    await query(`
      INSERT INTO variants (product_id, sku, size, colour, on_hand, reserved, reorder_level, image_url)
      VALUES ($1, $2, $3, $4, $5, 0, $6, $7);
    `, [prodIdNum, candidateSku, sizeVal, colourVal, onHandNum, reorderNum, imageUrl]);

    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}flash=${encodeURIComponent(`Variant SKU "${candidateSku}" successfully created with ${onHandNum} on-hand stock.`)}`);
  } catch (err) {
    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}error=${encodeURIComponent(err.message)}`);
  }
});

// Standalone Photo Upload for Variant / Colour
router.post('/variants/:id/upload-image', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  const redirectTarget = req.headers.referer || '/stock';
  try {
    const vId = parseInt(req.params.id, 10);
    const { apply_to_color, remove_image, manual_image_url } = req.body;

    const cur = await query(`
      SELECT v.id, v.product_id, v.sku, v.colour, p.name AS product_name
      FROM variants v
      JOIN products p ON p.id = v.product_id
      WHERE v.id = $1
    `, [vId]);
    if (!cur.rows.length) throw new Error('Variant not found.');
    const v = cur.rows[0];

    let finalImageUrl = null;
    if (remove_image === '1') {
      finalImageUrl = null;
    } else if (req.file) {
      finalImageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url && manual_image_url.trim()) {
      finalImageUrl = manual_image_url.trim();
    } else {
      throw new Error('Please select an image file to upload or enter an image URL.');
    }

    if (apply_to_color === '1' && v.colour && v.colour.trim()) {
      await query(`
        UPDATE variants
        SET image_url = $1
        WHERE product_id = $2 AND LOWER(TRIM(colour)) = LOWER(TRIM($3));
      `, [finalImageUrl, v.product_id, v.colour]);
    } else {
      await query(`
        UPDATE variants
        SET image_url = $1
        WHERE id = $2;
      `, [finalImageUrl, vId]);
    }

    const flashMsg = finalImageUrl
      ? `Photo updated for ${apply_to_color === '1' && v.colour ? `colour "${v.colour}" (${v.product_name})` : `SKU ${v.sku}`}.`
      : `Photo removed for ${apply_to_color === '1' && v.colour ? `colour "${v.colour}"` : `SKU ${v.sku}`}.`;

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, image_url: finalImageUrl });
    }
    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}flash=${encodeURIComponent(flashMsg)}`);
  } catch (err) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: err.message });
    }
    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}error=${encodeURIComponent(err.message)}`);
  }
});

// Quick Restock One-Click Action (+5, +10, etc.)
router.post('/quick-adjust', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const { variant_id, delta, reason } = req.body;
    const vId = parseInt(variant_id, 10);
    const deltaNum = parseInt(delta, 10);

    if (!vId || isNaN(deltaNum) || deltaNum === 0) {
      throw new Error('Invalid adjustment parameters.');
    }

    const cur = await query('SELECT on_hand, reserved, sku FROM variants WHERE id = $1', [vId]);
    if (!cur.rows.length) throw new Error('Variant not found.');

    const currentOnHand = cur.rows[0].on_hand;
    const reserved = cur.rows[0].reserved;
    const newOnHand = currentOnHand + deltaNum;

    if (newOnHand < reserved) {
      throw new Error(`Cannot reduce on-hand (${newOnHand}) below reserved quantity (${reserved}) for SKU ${cur.rows[0].sku}.`);
    }

    const auditReason = reason && reason.trim() ? reason.trim() : (deltaNum > 0 ? `Quick restock (+${deltaNum})` : `Stock deduction (${deltaNum})`);

    // Updating on_hand automatically triggers log_stock_change() -> stock_movements!
    await query(`
      UPDATE variants
      SET on_hand = $1
      WHERE id = $2;
    `, [newOnHand, vId]);

    // Update custom reason in stock_movements if specific reason provided
    if (auditReason) {
      await query(`
        UPDATE stock_movements
        SET reason = $1
        WHERE id = (
          SELECT id FROM stock_movements
          WHERE variant_id = $2
          ORDER BY at DESC
          LIMIT 1
        );
      `, [auditReason, vId]);
    }

    const flashMsg = `${cur.rows[0].sku}: On hand changed from ${currentOnHand} to ${newOnHand} (${deltaNum > 0 ? '+' : ''}${deltaNum}).`;
    const redirectUrl = req.headers.referer || '/stock';
    res.redirect(`${redirectUrl.split('?')[0]}?flash=${encodeURIComponent(flashMsg)}`);
  } catch (err) {
    const redirectUrl = req.headers.referer || '/stock';
    res.redirect(`${redirectUrl.split('?')[0]}?error=${encodeURIComponent(err.message)}`);
  }
});

// Full Stock Audit Adjustment (Set Exact or Delta with Mandatory Reason)
router.post('/adjust', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const { variant_id, mode, value, reason, notes } = req.body;
    const vId = parseInt(variant_id, 10);
    const valNum = parseInt(value, 10);

    if (!vId || isNaN(valNum)) {
      throw new Error('Invalid variant or quantity value.');
    }
    if (!reason || !reason.trim()) {
      throw new Error('Audit adjustment reason is required for inventory accuracy.');
    }

    const cur = await query('SELECT on_hand, reserved, sku FROM variants WHERE id = $1', [vId]);
    if (!cur.rows.length) throw new Error('Variant not found.');

    const currentOnHand = cur.rows[0].on_hand;
    const reserved = cur.rows[0].reserved;
    let newOnHand = 0;

    if (mode === 'exact') {
      newOnHand = valNum;
    } else {
      // delta mode
      newOnHand = currentOnHand + valNum;
    }

    if (newOnHand < reserved) {
      throw new Error(`On-hand (${newOnHand}) cannot be less than reserved orders (${reserved}).`);
    }

    const fullReason = notes && notes.trim() ? `${reason.trim()} - ${notes.trim()}` : reason.trim();

    await query(`
      UPDATE variants
      SET on_hand = $1
      WHERE id = $2;
    `, [newOnHand, vId]);

    await query(`
      UPDATE stock_movements
      SET reason = $1
      WHERE id = (
        SELECT id FROM stock_movements
        WHERE variant_id = $2
        ORDER BY at DESC
        LIMIT 1
      );
    `, [fullReason, vId]);

    res.redirect(`/stock?flash=${encodeURIComponent(`Stock for ${cur.rows[0].sku} adjusted to ${newOnHand} pieces (${fullReason}).`)}`);
  } catch (err) {
    res.redirect(`/stock?error=${encodeURIComponent(err.message)}`);
  }
});

// Update Variant Metadata (SKU, Size, Colour, Reorder Level)
router.post('/variants/:id', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const vId = parseInt(req.params.id, 10);
    const { sku, size, colour, reorder_level } = req.body;

    const cleanSku = (sku || '').trim().toUpperCase();
    if (!cleanSku) throw new Error('SKU cannot be blank.');
    const reorderNum = Math.max(0, parseInt(reorder_level, 10) || 2);

    await query(`
      UPDATE variants
      SET sku = $1,
          size = $2,
          colour = $3,
          reorder_level = $4
      WHERE id = $5;
    `, [cleanSku, (size || '').trim() || null, (colour || '').trim() || null, reorderNum, vId]);

    res.redirect(`/stock?flash=${encodeURIComponent(`Variant details for ${cleanSku} updated.`)}`);
  } catch (err) {
    res.redirect(`/stock?error=${encodeURIComponent(err.message)}`);
  }
});

// Delete Variant
router.post('/variants/:id/delete', requireRole('owner'), async (req, res, next) => {
  try {
    const vId = parseInt(req.params.id, 10);

    // Check reserved
    const chk = await query('SELECT sku, reserved FROM variants WHERE id = $1', [vId]);
    if (!chk.rows.length) throw new Error('Variant not found.');
    if (chk.rows[0].reserved > 0) {
      throw new Error(`Cannot delete variant ${chk.rows[0].sku} because it has ${chk.rows[0].reserved} reserved units held for pending orders.`);
    }

    await query('DELETE FROM variants WHERE id = $1', [vId]);
    res.redirect(`/stock?flash=${encodeURIComponent(`Variant ${chk.rows[0].sku} has been removed from inventory.`)}`);
  } catch (err) {
    res.redirect(`/stock?error=${encodeURIComponent(err.message)}`);
  }
});

// Bulk Stock Take / Shelf Count Page
router.get('/bulk', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const { category, product_id } = req.query;
    const conditions = [];
    const params = [];

    if (category && category !== 'all') {
      params.push(category);
      conditions.push(`p.category = $${params.length}`);
    }
    if (product_id) {
      params.push(parseInt(product_id, 10));
      conditions.push(`p.id = $${params.length}`);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const sql = `
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
        p.category
      FROM variants v
      JOIN products p ON p.id = v.product_id
      ${whereClause}
      ORDER BY p.name ASC, v.sku ASC;
    `;

    const result = await query(sql, params);
    const catRes = await query(`SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category ASC;`);
    const prodRes = await query(`SELECT id, name FROM products ORDER BY name ASC;`);

    res.render('stock/bulk', {
      title: 'Bulk Stock Take & Shelf Audit',
      currentPath: '/stock/bulk',
      variants: result.rows,
      categories: catRes.rows.map(r => r.category),
      products: prodRes.rows,
      filters: { category: category || 'all', product_id: product_id || '' }
    });
  } catch (err) {
    next(err);
  }
});

// Process Bulk Stock Take
router.post('/bulk', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  const client = await getClient();
  try {
    const { reason, notes } = req.body;
    const auditReason = (reason && reason.trim()) ? `${reason.trim()}${notes ? ' - ' + notes.trim() : ''}` : 'Bulk Physical Stock Count';

    const variantIds = Array.isArray(req.body.variant_id) ? req.body.variant_id : (req.body.variant_id ? [req.body.variant_id] : []);
    const newCounts = Array.isArray(req.body.count) ? req.body.count : (req.body.count ? [req.body.count] : []);

    await client.query('BEGIN');
    let updatedCount = 0;

    for (let i = 0; i < variantIds.length; i++) {
      const vId = parseInt(variantIds[i], 10);
      const newOnHand = parseInt(newCounts[i], 10);

      if (isNaN(vId) || isNaN(newOnHand) || newOnHand < 0) continue;

      const cur = await client.query('SELECT on_hand, reserved FROM variants WHERE id = $1', [vId]);
      if (!cur.rows.length) continue;

      if (newOnHand < cur.rows[0].reserved) {
        throw new Error(`Variant ID ${vId} count (${newOnHand}) cannot be lower than reserved units (${cur.rows[0].reserved}).`);
      }

      if (cur.rows[0].on_hand !== newOnHand) {
        await client.query('UPDATE variants SET on_hand = $1 WHERE id = $2', [newOnHand, vId]);
        await client.query(`
          UPDATE stock_movements
          SET reason = $1
          WHERE id = (
            SELECT id FROM stock_movements
            WHERE variant_id = $2
            ORDER BY at DESC
            LIMIT 1
          );
        `, [auditReason, vId]);
        updatedCount++;
      }
    }

    await client.query('COMMIT');
    res.redirect(`/stock?flash=${encodeURIComponent(`Bulk audit applied: ${updatedCount} variants updated (${auditReason}).`)}`);
  } catch (err) {
    await client.query('ROLLBACK');
    res.redirect(`/stock/bulk?error=${encodeURIComponent(err.message)}`);
  } finally {
    client.release();
  }
});

export default router;
