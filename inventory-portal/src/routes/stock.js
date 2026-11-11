import express from 'express';
import { api } from '../api.js';
import { requireAuth, requireRole } from '../auth.js';
import { upload } from '../upload.js';
import {
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanUrl
} from '../sanitize.js';

const router = express.Router();

router.use(requireAuth);

function getActor(req) {
  return req.user ? `${req.user.name} [${req.user.role}]` : 'Staff';
}

// Main Variant Inventory Matrix
router.get('/', async (req, res, next) => {
  try {
    const q = cleanString(req.query.q);
    const category = cleanString(req.query.category);
    const product_id = cleanInt(req.query.product_id, 1, Infinity, 0);
    const stock_status = cleanString(req.query.stock_status, { toLower: true }) || 'all';
    const size = cleanString(req.query.size) || 'all';
    const sort = cleanString(req.query.sort, { toLower: true }) || 'product-asc';

    const [matrixData, categories, products] = await Promise.all([
      api.getStockMatrix({ q, category, product_id, stock_status, size, sort }),
      api.getProductCategories(),
      api.getProductSummary()
    ]);

    res.render('stock/index', {
      title: 'Variant Inventory Control',
      currentPath: '/stock',
      variants: matrixData.variants || [],
      categories,
      products,
      totals: matrixData.totals || { totalOnHand: 0, totalAvailable: 0, totalReserved: 0, lowCount: 0, outCount: 0 },
      filters: { q, category: category || 'all', product_id: product_id || '', stock_status, size, sort }
    });
  } catch (err) {
    next(err);
  }
});

// Add New Variant to an Existing Product
router.post('/variants', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  const redirectTarget = req.headers.referer || '/stock';
  try {
    const prodIdNum = cleanInt(req.body.product_id, 1);
    if (!prodIdNum) throw new Error('A valid silhouette / product must be selected.');

    const cleanSku = cleanIdentifier(req.body.sku, '-_');
    const sizeVal = cleanString(req.body.size, { maxLength: 50 }) || 'Free Size';
    const colourVal = cleanString(req.body.colour, { maxLength: 50 }) || 'Standard';
    const onHandNum = cleanInt(req.body.on_hand, 0, 100000, 0);
    const reorderNum = cleanInt(req.body.reorder_level, 0, 100000, 2);
    const manual_image_url = cleanUrl(req.body.manual_image_url);

    let imageUrl = null;
    if (req.file) {
      imageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url) {
      imageUrl = manual_image_url;
    }

    const created = await api.createVariant({
      product_id: prodIdNum,
      sku: cleanSku,
      size: sizeVal,
      colour: colourVal,
      on_hand: onHandNum,
      reorder_level: reorderNum,
      image_url: imageUrl
    }, getActor(req));

    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}flash=${encodeURIComponent(`Variant SKU "${created.sku}" successfully created with ${onHandNum} on-hand stock.`)}`);
  } catch (err) {
    const sep = redirectTarget.includes('?') ? '&' : '?';
    res.redirect(`${redirectTarget}${sep}error=${encodeURIComponent(err.message)}`);
  }
});

// Standalone Photo Upload for Variant / Colour
router.post('/variants/:id/upload-image', requireRole('owner', 'stock_adder'), upload.single('image'), async (req, res) => {
  const redirectTarget = req.headers.referer || '/stock';
  try {
    const vId = cleanInt(req.params.id, 1);
    if (!vId) throw new Error('Invalid variant ID');

    const apply_to_color = req.body.apply_to_color === '1' || req.body.apply_to_color === 'true';
    const remove_image = req.body.remove_image === '1' || req.body.remove_image === 'true';
    const manual_image_url = cleanUrl(req.body.manual_image_url);

    let finalImageUrl = null;
    if (remove_image) {
      finalImageUrl = null;
    } else if (req.file) {
      finalImageUrl = `/products/${req.file.filename}`;
    } else if (manual_image_url) {
      finalImageUrl = manual_image_url;
    } else {
      throw new Error('Please select an image file to upload or enter an image URL.');
    }

    const result = await api.updateVariantImage(vId, {
      image_url: finalImageUrl,
      remove_image,
      apply_to_color
    }, getActor(req));

    const flashMsg = finalImageUrl
      ? `Photo updated for ${result.appliedToColor ? `colour "${result.colour}"` : `SKU ${result.sku}`}.`
      : `Photo removed for ${result.appliedToColor ? `colour "${result.colour}"` : `SKU ${result.sku}`}.`;

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
router.post('/quick-adjust', requireRole('owner', 'stock_adder'), async (req, res) => {
  const redirectUrl = req.headers.referer || '/stock';
  try {
    const vId = cleanInt(req.body.variant_id, 1);
    const deltaNum = cleanInt(req.body.delta, -100000, 100000, 0);
    const reason = cleanString(req.body.reason, { maxLength: 100 }) || (deltaNum > 0 ? `Quick restock (+${deltaNum})` : `Stock deduction (${deltaNum})`);

    if (!vId || deltaNum === 0) {
      throw new Error('Invalid adjustment parameters.');
    }

    const result = await api.adjustStock({
      variant_id: vId,
      delta: deltaNum,
      reason
    }, getActor(req));

    const flashMsg = `${result.sku}: On hand changed from ${result.previous_on_hand} to ${result.on_hand} (${deltaNum > 0 ? '+' : ''}${deltaNum}).`;
    res.redirect(`${redirectUrl.split('?')[0]}?flash=${encodeURIComponent(flashMsg)}`);
  } catch (err) {
    res.redirect(`${redirectUrl.split('?')[0]}?error=${encodeURIComponent(err.message)}`);
  }
});

// Full Stock Audit Adjustment (Set Exact or Delta with Mandatory Reason)
router.post('/adjust', requireRole('owner', 'stock_adder'), async (req, res) => {
  try {
    const vId = cleanInt(req.body.variant_id, 1);
    const mode = cleanString(req.body.mode, { toLower: true });
    const value = cleanInt(req.body.value, -100000, 100000, 0);
    const reason = cleanString(req.body.reason, { maxLength: 100 });
    const notes = cleanString(req.body.notes, { maxLength: 200 });

    if (!vId) throw new Error('Invalid variant selected.');
    if (!reason) throw new Error('Audit adjustment reason is required for inventory accuracy.');

    let payload;
    if (mode === 'exact') {
      if (value < 0) throw new Error('Exact stock quantity must be non-negative.');
      payload = { variant_id: vId, mode: 'exact', value, reason, notes };
    } else {
      payload = { variant_id: vId, delta: value, reason, notes };
    }

    const result = await api.adjustStock(payload, getActor(req));
    res.redirect(`/stock?flash=${encodeURIComponent(`Stock for ${result.sku} adjusted to ${result.on_hand} pieces (${result.reason}).`)}`);
  } catch (err) {
    res.redirect(`/stock?error=${encodeURIComponent(err.message)}`);
  }
});

// Update Variant Metadata (SKU, Size, Colour, Reorder Level)
router.post('/variants/:id', requireRole('owner', 'stock_adder'), async (req, res) => {
  try {
    const vId = cleanInt(req.params.id, 1);
    if (!vId) throw new Error('Invalid variant ID');

    const cleanSku = cleanIdentifier(req.body.sku, '-_');
    if (!cleanSku) throw new Error('SKU cannot be blank.');

    const size = cleanString(req.body.size, { maxLength: 50 });
    const colour = cleanString(req.body.colour, { maxLength: 50 });
    const reorder_level = cleanInt(req.body.reorder_level, 0, 100000, 2);

    await api.updateVariant(vId, {
      sku: cleanSku,
      size,
      colour,
      reorder_level
    }, getActor(req));

    res.redirect(`/stock?flash=${encodeURIComponent(`Variant details for ${cleanSku} updated.`)}`);
  } catch (err) {
    res.redirect(`/stock?error=${encodeURIComponent(err.message)}`);
  }
});

// Delete Variant
router.post('/variants/:id/delete', requireRole('owner'), async (req, res) => {
  try {
    const vId = cleanInt(req.params.id, 1);
    if (!vId) throw new Error('Invalid variant ID');

    const result = await api.deleteVariant(vId, getActor(req));
    res.redirect(`/stock?flash=${encodeURIComponent(`Variant ${result.sku} has been removed from inventory.`)}`);
  } catch (err) {
    res.redirect(`/stock?error=${encodeURIComponent(err.message)}`);
  }
});

// Bulk Stock Take / Shelf Count Page
router.get('/bulk', requireRole('owner', 'stock_adder'), async (req, res, next) => {
  try {
    const category = cleanString(req.query.category);
    const product_id = cleanInt(req.query.product_id, 1, Infinity, 0);

    const [matrixData, categories, products] = await Promise.all([
      api.getStockMatrix({ category, product_id, sort: 'product-asc' }),
      api.getProductCategories(),
      api.getProductSummary()
    ]);

    res.render('stock/bulk', {
      title: 'Bulk Stock Take & Shelf Audit',
      currentPath: '/stock/bulk',
      variants: matrixData.variants || [],
      categories,
      products,
      filters: { category: category || 'all', product_id: product_id || '' }
    });
  } catch (err) {
    next(err);
  }
});

// Process Bulk Stock Take
router.post('/bulk', requireRole('owner', 'stock_adder'), async (req, res) => {
  try {
    const reason = cleanString(req.body.reason, { maxLength: 100 }) || 'Bulk Physical Stock Count';
    const notes = cleanString(req.body.notes, { maxLength: 200 });

    const variantIds = Array.isArray(req.body.variant_id) ? req.body.variant_id : (req.body.variant_id ? [req.body.variant_id] : []);
    const newCounts = Array.isArray(req.body.count) ? req.body.count : (req.body.count ? [req.body.count] : []);

    const items = [];
    for (let i = 0; i < variantIds.length; i++) {
      const vId = cleanInt(variantIds[i], 1);
      const count = cleanInt(newCounts[i], 0, 100000, -1);
      if (vId && count >= 0) {
        items.push({ variant_id: vId, count });
      }
    }

    const result = await api.bulkAdjustStock({ items, reason, notes }, getActor(req));
    res.redirect(`/stock?flash=${encodeURIComponent(`Bulk audit applied: ${result.updatedCount} variants updated (${result.reason}).`)}`);
  } catch (err) {
    res.redirect(`/stock/bulk?error=${encodeURIComponent(err.message)}`);
  }
});

export default router;
