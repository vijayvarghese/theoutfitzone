import express from 'express';
import { query, getClient } from '../db.js';
import { upload } from '../upload.js';
import { requireAuth, requireRole } from '../auth.js';
import fs from 'fs';
import path from 'path';

const router = express.Router();

router.use(requireAuth);

// List silhouettes with rich filtering
router.get('/', async (req, res, next) => {
  try {
    const { q, category, status = 'all', image = 'all', sort = 'id-asc' } = req.query;

    const conditions = [];
    const params = [];

    if (status === 'active') {
      conditions.push('p.active = true');
    } else if (status === 'archived') {
      conditions.push('p.active = false');
    }

    if (category && category !== 'all') {
      params.push(category);
      conditions.push(`p.category = $${params.length}`);
    }

    if (image === 'with') {
      conditions.push("p.image_url IS NOT NULL AND p.image_url != ''");
    } else if (image === 'missing') {
      conditions.push("(p.image_url IS NULL OR p.image_url = '')");
    }

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      const idx = params.length;
      conditions.push(`(
        p.name ILIKE $${idx}
        OR p.description ILIKE $${idx}
        OR p.category ILIKE $${idx}
        OR EXISTS (
          SELECT 1 FROM variants v
          WHERE v.product_id = p.id
            AND (v.sku ILIKE $${idx} OR v.colour ILIKE $${idx} OR v.size ILIKE $${idx})
        )
      )`);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    let orderBy = 'p.id ASC';
    if (sort === 'id-desc') orderBy = 'p.id DESC';
    if (sort === 'name-asc') orderBy = 'p.name ASC';
    if (sort === 'name-desc') orderBy = 'p.name DESC';
    if (sort === 'price-asc') orderBy = 'p.price_inr ASC';
    if (sort === 'price-desc') orderBy = 'p.price_inr DESC';
    if (sort === 'stock-desc') orderBy = 'total_available DESC';
    if (sort === 'stock-asc') orderBy = 'total_available ASC';

    const sql = `
      SELECT
        p.id,
        p.name,
        p.category,
        p.price_inr,
        p.description,
        p.image_url,
        p.active,
        p.created_at,
        COUNT(v.id) AS variant_count,
        COALESCE(SUM(v.on_hand), 0) AS total_on_hand,
        COALESCE(SUM(v.reserved), 0) AS total_reserved,
        COALESCE(SUM(v.on_hand - v.reserved), 0) AS total_available,
        BOOL_OR((v.on_hand - v.reserved) <= v.reorder_level) AS has_low_stock
      FROM products p
      LEFT JOIN variants v ON v.product_id = p.id
      ${whereClause}
      GROUP BY p.id
      ORDER BY ${orderBy};
    `;

    const result = await query(sql, params);

    // Get list of existing categories for filter dropdown
    const catRes = await query(`
      SELECT DISTINCT category
      FROM products
      WHERE category IS NOT NULL AND category != ''
      ORDER BY category ASC;
    `);

    res.render('products/index', {
      title: 'Silhouettes & Product Catalog',
      currentPath: '/products',
      products: result.rows,
      categories: catRes.rows.map(r => r.category),
      filters: { q: q || '', category: category || 'all', status, image, sort }
    });
  } catch (err) {
    next(err);
  }
});

// Render Add Product Form
router.get('/new', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const catRes = await query(`
      SELECT DISTINCT category
      FROM products
      WHERE category IS NOT NULL AND category != ''
      ORDER BY category ASC;
    `);

    res.render('products/form', {
      title: 'Add New Silhouette / Product',
      currentPath: '/products',
      isEdit: false,
      product: {
        id: null,
        name: '',
        category: '',
        price_inr: '',
        description: '',
        image_url: '',
        active: true
      },
      categories: catRes.rows.map(r => r.category),
      variants: []
    });
  } catch (err) {
    next(err);
  }
});

// Create New Product
router.post('/', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res, next) => {
  const client = await getClient();
  try {
    const { name, category, custom_category, price_inr, description, active, manual_image_url } = req.body;

    if (!name || !name.trim()) {
      throw new Error('Product name is required.');
    }
    const priceNum = parseFloat(price_inr);
    if (isNaN(priceNum) || priceNum < 0) {
      throw new Error('Please enter a valid base price in INR.');
    }

    const finalCategory = (custom_category && custom_category.trim())
      ? custom_category.trim()
      : (category && category !== '__new__' ? category.trim() : null);

    let imageUrl = null;
    if (req.file) {
      imageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url && manual_image_url.trim()) {
      imageUrl = manual_image_url.trim();
    }

    await client.query('BEGIN');

    const insertRes = await client.query(`
      INSERT INTO products (name, category, price_inr, description, image_url, active)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name;
    `, [
      name.trim(),
      finalCategory,
      priceNum,
      description ? description.trim() : null,
      imageUrl,
      active === 'on' || active === 'true' || active === true
    ]);

    const newProductId = insertRes.rows[0].id;

    // Helper functions for automatic robust SKU generation
    function buildBaseSku(productName, catName, sizeStr, colStr) {
      const words = (productName || catName || 'SIL').trim().split(/\s+/).filter(Boolean);
      let prefix = '';
      if (words.length >= 2) {
        prefix = words.map(w => w[0].toUpperCase()).join('').slice(0, 4);
      } else if (words.length === 1) {
        prefix = words[0].slice(0, 3).toUpperCase();
      }
      if (!prefix || prefix.length < 2) prefix = 'SIL';

      const colCode = (colStr || 'STD').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'STD';
      const sizeCode = (sizeStr || 'FS').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'FS';
      return `${prefix}-${colCode}-${sizeCode}`;
    }

    async function getUniqueSku(pgClient, baseCandidate) {
      let candidate = (baseCandidate || 'SKU').replace(/[^A-Z0-9-]/gi, '').toUpperCase();
      if (!candidate || candidate.length < 2) candidate = 'SKU';
      let current = candidate;
      let counter = 1;
      while (true) {
        const check = await pgClient.query('SELECT 1 FROM variants WHERE sku = $1', [current]);
        if (check.rows.length === 0) return current;
        current = `${candidate}-${counter++}`;
      }
    }

    // Process initial variants if provided in array
    const skus = Array.isArray(req.body['var_sku']) ? req.body['var_sku'] : (req.body['var_sku'] ? [req.body['var_sku']] : []);
    const sizes = Array.isArray(req.body['var_size']) ? req.body['var_size'] : (req.body['var_size'] ? [req.body['var_size']] : []);
    const colours = Array.isArray(req.body['var_colour']) ? req.body['var_colour'] : (req.body['var_colour'] ? [req.body['var_colour']] : []);
    const stocks = Array.isArray(req.body['var_stock']) ? req.body['var_stock'] : (req.body['var_stock'] ? [req.body['var_stock']] : []);
    const reorders = Array.isArray(req.body['var_reorder']) ? req.body['var_reorder'] : (req.body['var_reorder'] ? [req.body['var_reorder']] : []);

    let createdVariantsCount = 0;
    for (let i = 0; i < Math.max(skus.length, sizes.length, colours.length, stocks.length); i++) {
      let rawSku = (skus[i] || '').trim().toUpperCase();
      const rawSize = (sizes[i] || '').trim();
      const rawColour = (colours[i] || '').trim();
      const stockVal = Math.max(0, parseInt(stocks[i], 10) || 0);
      const reorderVal = Math.max(0, parseInt(reorders[i], 10) || 2);

      // Check if row has any content or stock
      const hasContent = rawSku || rawSize || rawColour || stockVal > 0;
      if (!hasContent) continue;

      const sizeVal = rawSize || 'Free Size';
      const colourVal = rawColour || 'Standard';

      let finalSku = rawSku;
      if (!finalSku) {
        const baseCandidate = buildBaseSku(name.trim(), finalCategory, sizeVal, colourVal);
        finalSku = await getUniqueSku(client, baseCandidate);
      } else {
        finalSku = await getUniqueSku(client, finalSku);
      }

      await client.query(`
        INSERT INTO variants (product_id, sku, size, colour, on_hand, reserved, reorder_level)
        VALUES ($1, $2, $3, $4, $5, 0, $6);
      `, [newProductId, finalSku, sizeVal, colourVal, stockVal, reorderVal]);
      createdVariantsCount++;
    }

    // Safety fallback: every purchasable product must have at least 1 variant SKU
    if (createdVariantsCount === 0) {
      const baseCandidate = buildBaseSku(name.trim(), finalCategory, 'FS', 'STD');
      const defSku = await getUniqueSku(client, baseCandidate);
      await client.query(`
        INSERT INTO variants (product_id, sku, size, colour, on_hand, reserved, reorder_level)
        VALUES ($1, $2, $3, $4, 0, 0, 2);
      `, [newProductId, defSku, 'Free Size', 'Standard']);
    }

    await client.query('COMMIT');

    req.session = req.session || {};
    res.redirect(`/products?flash=${encodeURIComponent(`Product "${name.trim()}" created successfully with ID #${newProductId}.`)}`);
  } catch (err) {
    await client.query('ROLLBACK');
    res.redirect(`/products/new?error=${encodeURIComponent(err.message)}`);
  } finally {
    client.release();
  }
});

// Render Edit Product Form
router.get('/:id/edit', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const prodRes = await query(`
      SELECT * FROM products WHERE id = $1;
    `, [productId]);

    if (!prodRes.rows.length) {
      return res.status(404).render('error', { title: 'Product Not Found', message: `Product #${productId} does not exist.` });
    }

    const varRes = await query(`
      SELECT * FROM variants WHERE product_id = $1 ORDER BY id ASC;
    `, [productId]);

    const catRes = await query(`
      SELECT DISTINCT category
      FROM products
      WHERE category IS NOT NULL AND category != ''
      ORDER BY category ASC;
    `);

    res.render('products/form', {
      title: `Edit Silhouette #${productId} - ${prodRes.rows[0].name}`,
      currentPath: '/products',
      isEdit: true,
      product: prodRes.rows[0],
      categories: catRes.rows.map(r => r.category),
      variants: varRes.rows
    });
  } catch (err) {
    next(err);
  }
});

// Update Product
router.post('/:id', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const { name, category, custom_category, price_inr, description, active, remove_image, manual_image_url } = req.body;

    if (!name || !name.trim()) {
      throw new Error('Product name is required.');
    }
    const priceNum = parseFloat(price_inr);
    if (isNaN(priceNum) || priceNum < 0) {
      throw new Error('Please enter a valid base price in INR.');
    }

    const finalCategory = (custom_category && custom_category.trim())
      ? custom_category.trim()
      : (category && category !== '__new__' ? category.trim() : null);

    // Existing product
    const existing = await query('SELECT image_url FROM products WHERE id = $1', [productId]);
    if (!existing.rows.length) {
      throw new Error('Product not found.');
    }

    let finalImageUrl = existing.rows[0].image_url;

    if (remove_image === '1') {
      finalImageUrl = null;
    } else if (req.file) {
      finalImageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url && manual_image_url.trim()) {
      finalImageUrl = manual_image_url.trim();
    }

    await query(`
      UPDATE products
      SET name = $1,
          category = $2,
          price_inr = $3,
          description = $4,
          image_url = $5,
          active = $6
      WHERE id = $7;
    `, [
      name.trim(),
      finalCategory,
      priceNum,
      description ? description.trim() : null,
      finalImageUrl,
      active === 'on' || active === 'true' || active === true,
      productId
    ]);

    res.redirect(`/products?flash=${encodeURIComponent(`Silhouette #${productId} updated successfully.`)}`);
  } catch (err) {
    res.redirect(`/products/${req.params.id}/edit?error=${encodeURIComponent(err.message)}`);
  }
});

// Standalone Fast Image Upload for Product
router.post('/:id/upload-image', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!req.file) {
      return res.status(400).json({ error: 'No image file was provided.' });
    }

    const imageUrl = `/products/${req.file.filename}`;
    await query(`
      UPDATE products
      SET image_url = $1
      WHERE id = $2;
    `, [imageUrl, productId]);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, image_url: imageUrl });
    }
    res.redirect(`/products?flash=${encodeURIComponent(`Image for product #${productId} updated successfully.`)}`);
  } catch (err) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: err.message });
    }
    res.redirect(`/products?error=${encodeURIComponent(err.message)}`);
  }
});

// Upload / Update Photo for all variants of a specific colour for this product
router.post('/:id/color-image', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const redirectTarget = req.headers.referer || `/products/${productId}/edit`;
  try {
    const { colour, remove_image, manual_image_url } = req.body;
    if (!colour || !colour.trim()) {
      throw new Error('Colour name is required.');
    }

    let finalImageUrl = null;
    if (remove_image === '1') {
      finalImageUrl = null;
    } else if (req.file) {
      finalImageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url && manual_image_url.trim()) {
      finalImageUrl = manual_image_url.trim();
    } else {
      throw new Error('No image file or URL was provided.');
    }

    await query(`
      UPDATE variants
      SET image_url = $1
      WHERE product_id = $2 AND LOWER(TRIM(colour)) = LOWER(TRIM($3));
    `, [finalImageUrl, productId, colour.trim()]);

    const msg = finalImageUrl
      ? `Photo updated for colour "${colour.trim()}".`
      : `Photo removed for colour "${colour.trim()}".`;

    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}flash=${encodeURIComponent(msg)}`);
  } catch (err) {
    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}error=${encodeURIComponent(err.message)}`);
  }
});

// Toggle Active / Archived Status
router.post('/:id/toggle-status', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const updated = await query(`
      UPDATE products
      SET active = NOT active
      WHERE id = $1
      RETURNING id, name, active;
    `, [productId]);

    if (!updated.rows.length) {
      throw new Error('Product not found.');
    }

    const row = updated.rows[0];
    const statusText = row.active ? 'activated' : 'archived';
    res.redirect(`/products?flash=${encodeURIComponent(`Silhouette "${row.name}" has been ${statusText}.`)}`);
  } catch (err) {
    next(err);
  }
});

// Delete Product (Cascade)
router.post('/:id/delete', requireRole('owner'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const deleted = await query(`
      DELETE FROM products
      WHERE id = $1
      RETURNING id, name;
    `, [productId]);

    if (!deleted.rows.length) {
      throw new Error('Product not found.');
    }

    res.redirect(`/products?flash=${encodeURIComponent(`Product #${productId} ("${deleted.rows[0].name}") and all its variants have been permanently removed.`)}`);
  } catch (err) {
    next(err);
  }
});

export default router;
