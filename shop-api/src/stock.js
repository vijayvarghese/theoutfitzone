/**
 * Stock and Inventory Management service for shop-api.
 * Handles variant cataloging, live stock queries, transactional adjustments,
 * bulk shelf audits, and stock movement logs.
 */
const { pool, tx } = require('./db');
const { ApiError, badRequest, notFound } = require('./errors');
const {
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanBool,
  cleanUrl
} = require('./sanitize');

/**
 * Sets session configuration variables read by PostgreSQL stock audit triggers.
 */
async function setReason(c, reason, ref) {
  await c.query("SELECT set_config('shop.reason', $1, true), set_config('shop.ref', $2, true)", [
    cleanString(reason, { maxLength: 100 }),
    cleanString(ref, { maxLength: 100 }) || '',
  ]);
}

/**
 * Public callers see only `available`; callers with the API key also see the raw numbers.
 */
function shapeVariant(v, admin) {
  const out = {
    sku: v.sku,
    size: v.size,
    colour: v.colour,
    image_url: v.variant_image_url || null,
    available: Math.max(v.on_hand - v.reserved, 0),
  };
  if (admin) {
    out.id = v.id || v.variant_id;
    out.product_id = v.product_id;
    out.on_hand = v.on_hand;
    out.reserved = v.reserved;
    out.reorder_level = v.reorder_level;
  }
  return out;
}

/**
 * Storefront catalog listing (products with nested active variants).
 */
async function listProducts({ category, q, admin }) {
  const where = ['p.active'];
  const args = [];
  const cleanCat = cleanString(category);
  const cleanQ = cleanString(q);

  if (cleanCat) where.push(`p.category ILIKE $${args.push(cleanCat)}`);
  if (cleanQ) where.push(`p.name ILIKE $${args.push('%' + cleanQ + '%')}`);

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.category, p.price_inr, p.description, p.image_url,
            v.id AS variant_id, v.sku, v.size, v.colour, v.image_url AS variant_image_url, v.on_hand, v.reserved, v.reorder_level
       FROM products p
       LEFT JOIN variants v ON v.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY p.id, v.id`,
    args
  );

  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) {
      byId.set(r.id, {
        id: r.id,
        name: r.name,
        category: r.category,
        price_inr: r.price_inr,
        description: r.description,
        image_url: r.image_url,
        in_stock: false,
        variants: [],
      });
    }
    if (r.sku) {
      const p = byId.get(r.id);
      const v = shapeVariant({ ...r, id: r.variant_id }, admin);
      p.variants.push(v);
      if (v.available > 0) p.in_stock = true;
    }
  }
  return [...byId.values()];
}

/**
 * Staff Variant Matrix listing with aggregate totals and rich filters.
 */
async function listVariants({ q, category, product_id, stock_status = 'all', size = 'all', sort = 'product-asc' } = {}) {
  const conditions = [];
  const params = [];

  const prodId = cleanInt(product_id, 1);
  if (prodId) {
    params.push(prodId);
    conditions.push(`p.id = $${params.length}`);
  }

  const cleanCat = cleanString(category);
  if (cleanCat && cleanCat !== 'all') {
    params.push(cleanCat);
    conditions.push(`p.category = $${params.length}`);
  }

  const cleanSize = cleanString(size);
  if (cleanSize && cleanSize !== 'all') {
    params.push(cleanSize);
    conditions.push(`LOWER(v.size) = LOWER($${params.length})`);
  }

  const cleanStock = cleanString(stock_status, { toLower: true });
  if (cleanStock === 'low') {
    conditions.push(`(v.on_hand - v.reserved) <= v.reorder_level AND (v.on_hand - v.reserved) > 0`);
  } else if (cleanStock === 'out') {
    conditions.push(`(v.on_hand - v.reserved) <= 0`);
  } else if (cleanStock === 'healthy') {
    conditions.push(`(v.on_hand - v.reserved) > v.reorder_level`);
  }

  const cleanQ = cleanString(q);
  if (cleanQ) {
    params.push(`%${cleanQ}%`);
    const idx = params.length;
    conditions.push(`(
      v.sku ILIKE $${idx}
      OR v.colour ILIKE $${idx}
      OR v.size ILIKE $${idx}
      OR p.name ILIKE $${idx}
    )`);
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const SORT_MAP = {
    'product-asc': 'p.name ASC, v.sku ASC',
    'sku-asc': 'v.sku ASC',
    'available-asc': 'available ASC',
    'available-desc': 'available DESC',
    'on-hand-desc': 'v.on_hand DESC',
  };
  const orderBy = SORT_MAP[sort] || 'p.name ASC, v.sku ASC';

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

  const { rows } = await pool.query(sql, params);

  let totalOnHand = 0;
  let totalAvailable = 0;
  let totalReserved = 0;
  let lowCount = 0;
  let outCount = 0;

  for (const r of rows) {
    totalOnHand += Number(r.on_hand) || 0;
    totalAvailable += Number(r.available) || 0;
    totalReserved += Number(r.reserved) || 0;
    if (r.available <= 0) outCount++;
    else if (r.available <= r.reorder_level) lowCount++;
  }

  return {
    variants: rows,
    totals: {
      totalOnHand,
      totalAvailable,
      totalReserved,
      lowCount,
      outCount
    }
  };
}

/**
 * Retrieves stock details for a single SKU.
 */
async function getStock(rawSku, admin) {
  const sku = cleanIdentifier(rawSku, '-_');
  if (!sku) throw badRequest('SKU is required');

  const { rows } = await pool.query(
    `SELECT v.id AS variant_id, v.product_id, v.sku, v.size, v.colour, v.image_url AS variant_image_url, v.on_hand, v.reserved, v.reorder_level,
            p.name AS product, p.price_inr, p.active
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.sku = $1`,
    [sku]
  );
  if (!rows.length) throw notFound(`Unknown SKU ${sku}`);
  const r = rows[0];
  return { product: r.product, price_inr: r.price_inr, active: r.active, ...shapeVariant(r, admin) };
}

/**
 * Creates a new variant under an existing product.
 */
async function createVariant({ product_id, sku, size, colour, on_hand, reorder_level, image_url }) {
  const prodId = cleanInt(product_id, 1);
  if (!prodId) throw badRequest('Valid product ID is required');

  const prodRes = await pool.query('SELECT id, name, category FROM products WHERE id = $1', [prodId]);
  if (!prodRes.rowCount) throw notFound(`Product #${prodId} not found`);
  const prod = prodRes.rows[0];

  const sizeVal = cleanString(size, { maxLength: 50 }) || 'Free Size';
  const colourVal = cleanString(colour, { maxLength: 50 }) || 'Standard';
  const onHandNum = cleanInt(on_hand, 0, 100000, 0);
  const reorderNum = cleanInt(reorder_level, 0, 100000, 2);
  const imageUrl = cleanUrl(image_url);

  let cleanSku = cleanIdentifier(sku, '-_');
  if (!cleanSku) {
    const { buildBaseSku } = require('./products');
    cleanSku = buildBaseSku(prod.name, prod.category, sizeVal, colourVal);
  }

  // Ensure unique SKU
  let candidateSku = cleanSku;
  let counter = 1;
  while (true) {
    const check = await pool.query('SELECT 1 FROM variants WHERE sku = $1', [candidateSku]);
    if (check.rowCount === 0) break;
    candidateSku = `${cleanSku}-${counter++}`;
  }

  const { rows } = await pool.query(
    `INSERT INTO variants (product_id, sku, size, colour, on_hand, reserved, reorder_level, image_url)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
     RETURNING *;`,
    [prodId, candidateSku, sizeVal, colourVal, onHandNum, reorderNum, imageUrl]
  );

  return rows[0];
}

/**
 * Updates metadata for an existing variant.
 */
async function updateVariant(id, { sku, size, colour, reorder_level }) {
  const vId = cleanInt(id, 1);
  if (!vId) throw badRequest('Valid variant ID is required');

  const cleanSku = cleanIdentifier(sku, '-_');
  if (!cleanSku) throw badRequest('SKU cannot be blank');

  const sizeVal = cleanString(size, { maxLength: 50 }) || null;
  const colourVal = cleanString(colour, { maxLength: 50 }) || null;
  const reorderNum = cleanInt(reorder_level, 0, 100000, 2);

  try {
    const { rows } = await pool.query(
      `UPDATE variants
       SET sku = $1,
           size = $2,
           colour = $3,
           reorder_level = $4
       WHERE id = $5
       RETURNING *;`,
      [cleanSku, sizeVal, colourVal, reorderNum, vId]
    );
    if (!rows.length) throw notFound(`Variant #${vId} not found`);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw new ApiError(409, 'SKU_EXISTS', `SKU "${cleanSku}" is already in use by another variant`);
    }
    throw err;
  }
}

/**
 * Updates image for a variant, optionally propagating to all variants of the same color.
 */
async function updateVariantImage(id, { image_url, remove_image, apply_to_color }) {
  const vId = cleanInt(id, 1);
  if (!vId) throw badRequest('Valid variant ID is required');

  const cur = await pool.query(
    `SELECT v.id, v.product_id, v.sku, v.colour, p.name AS product_name
     FROM variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.id = $1`,
    [vId]
  );
  if (!cur.rowCount) throw notFound(`Variant #${vId} not found`);
  const v = cur.rows[0];

  let finalImageUrl = null;
  if (remove_image === '1' || remove_image === true) {
    finalImageUrl = null;
  } else {
    finalImageUrl = cleanUrl(image_url);
    if (!finalImageUrl) throw badRequest('Valid image URL is required');
  }

  const applyColor = cleanBool(apply_to_color);

  if (applyColor && v.colour && v.colour.trim()) {
    await pool.query(
      `UPDATE variants
       SET image_url = $1
       WHERE product_id = $2 AND LOWER(TRIM(colour)) = LOWER(TRIM($3))`,
      [finalImageUrl, v.product_id, v.colour]
    );
  } else {
    await pool.query(
      `UPDATE variants
       SET image_url = $1
       WHERE id = $2`,
      [finalImageUrl, vId]
    );
  }

  return {
    success: true,
    image_url: finalImageUrl,
    appliedToColor: applyColor && Boolean(v.colour),
    sku: v.sku,
    colour: v.colour
  };
}

/**
 * Deletes a variant, guaranteeing no open reservations are held.
 */
async function deleteVariant(id) {
  const vId = cleanInt(id, 1);
  if (!vId) throw badRequest('Valid variant ID is required');

  const chk = await pool.query('SELECT sku, reserved FROM variants WHERE id = $1', [vId]);
  if (!chk.rowCount) throw notFound(`Variant #${vId} not found`);
  if (chk.rows[0].reserved > 0) {
    throw new ApiError(
      409,
      'VARIANT_RESERVED',
      `Cannot delete variant ${chk.rows[0].sku}: ${chk.rows[0].reserved} units are reserved for open orders.`
    );
  }

  await pool.query('DELETE FROM variants WHERE id = $1', [vId]);
  return { success: true, sku: chk.rows[0].sku };
}

/**
 * Full Stock Audit Adjustment.
 * Supports both:
 *   - Delta mode: relative change (+5, -2) via sku or variant_id
 *   - Exact mode: setting exact on_hand count
 */
async function adjustStock(body) {
  const { sku, variant_id, delta, mode, value, reason, notes } = body || {};

  const cleanReason = cleanString(reason, { maxLength: 100 });
  const cleanNotes = cleanString(notes, { maxLength: 200 });
  const auditReason = cleanNotes ? `${cleanReason} - ${cleanNotes}` : cleanReason;

  if (mode === 'exact') {
    const vId = cleanInt(variant_id, 1);
    if (!vId) throw badRequest('variant_id is required for exact mode');
    const exactOnHand = cleanInt(value, 0, 100000, -1);
    if (exactOnHand < 0) throw badRequest('value must be a non-negative integer for exact mode');
    if (!cleanReason) throw badRequest('Audit adjustment reason is required');

    return tx(async (c) => {
      const cur = await c.query('SELECT id, sku, on_hand, reserved FROM variants WHERE id = $1 FOR UPDATE', [vId]);
      if (!cur.rowCount) throw notFound(`Variant #${vId} not found`);
      const v = cur.rows[0];

      if (exactOnHand < v.reserved) {
        throw new ApiError(
          409,
          'BELOW_RESERVED',
          `On-hand (${exactOnHand}) cannot be less than reserved orders (${v.reserved}) for SKU ${v.sku}.`
        );
      }

      await setReason(c, `adjust: ${auditReason}`, '');
      await c.query('UPDATE variants SET on_hand = $1 WHERE id = $2', [exactOnHand, vId]);

      // Ensure custom audit reason is saved in stock_movements
      await c.query(
        `UPDATE stock_movements
         SET reason = $1
         WHERE id = (SELECT id FROM stock_movements WHERE variant_id = $2 ORDER BY at DESC LIMIT 1)`,
        [auditReason, vId]
      );

      return {
        variant_id: v.id,
        sku: v.sku,
        previous_on_hand: v.on_hand,
        on_hand: exactOnHand,
        reserved: v.reserved,
        available: exactOnHand - v.reserved,
        reason: auditReason
      };
    });
  }

  // Delta adjustment mode
  const deltaNum = cleanInt(delta, -100000, 100000, 0);
  if (deltaNum === 0) {
    throw badRequest('delta must be a non-zero integer (positive to add, negative to deduct)');
  }
  if (!cleanReason) {
    throw badRequest('reason is required (e.g. "restock", "walk-in sale", "damaged")');
  }

  return tx(async (c) => {
    let queryField = 'sku = $1';
    let queryArg = cleanIdentifier(sku, '-_');

    if (!queryArg && variant_id) {
      queryField = 'id = $1';
      queryArg = cleanInt(variant_id, 1);
    }
    if (!queryArg) throw badRequest('sku or variant_id is required');

    const cur = await c.query(`SELECT id, sku, on_hand, reserved FROM variants WHERE ${queryField} FOR UPDATE`, [queryArg]);
    if (!cur.rowCount) throw notFound(`Variant not found (${queryArg})`);
    const v = cur.rows[0];

    const newOnHand = v.on_hand + deltaNum;
    if (newOnHand < v.reserved) {
      throw new ApiError(
        409,
        'BELOW_RESERVED',
        `Cannot reduce ${v.sku} by ${-deltaNum}: ${v.on_hand} on hand, ${v.reserved} reserved for open orders`,
        { on_hand: v.on_hand, reserved: v.reserved }
      );
    }

    await setReason(c, `adjust: ${auditReason}`, '');
    await c.query('UPDATE variants SET on_hand = $1 WHERE id = $2', [newOnHand, v.id]);

    await c.query(
      `UPDATE stock_movements
       SET reason = $1
       WHERE id = (SELECT id FROM stock_movements WHERE variant_id = $2 ORDER BY at DESC LIMIT 1)`,
      [auditReason, v.id]
    );

    return {
      variant_id: v.id,
      sku: v.sku,
      previous_on_hand: v.on_hand,
      on_hand: newOnHand,
      reserved: v.reserved,
      available: newOnHand - v.reserved,
      reason: auditReason
    };
  });
}

/**
 * Bulk Physical Stock Take / Shelf Audit.
 */
async function bulkAdjustStock({ items, reason, notes }) {
  const cleanReason = cleanString(reason, { maxLength: 100 }) || 'Bulk Physical Stock Count';
  const cleanNotes = cleanString(notes, { maxLength: 200 });
  const auditReason = cleanNotes ? `${cleanReason} - ${cleanNotes}` : cleanReason;

  const rawItems = Array.isArray(items) ? items : [];
  if (!rawItems.length) throw badRequest('No inventory count items were provided');

  return tx(async (c) => {
    await setReason(c, `bulk_audit: ${auditReason}`, '');
    let updatedCount = 0;

    for (const item of rawItems) {
      const vId = cleanInt(item.variant_id, 1);
      const newOnHand = cleanInt(item.count != null ? item.count : item.on_hand, 0, 100000, -1);

      if (!vId || newOnHand < 0) continue;

      const cur = await c.query('SELECT on_hand, reserved FROM variants WHERE id = $1 FOR UPDATE', [vId]);
      if (!cur.rowCount) continue;

      if (newOnHand < cur.rows[0].reserved) {
        throw new ApiError(
          409,
          'BELOW_RESERVED',
          `Variant ID ${vId} count (${newOnHand}) cannot be lower than reserved units (${cur.rows[0].reserved}).`
        );
      }

      if (cur.rows[0].on_hand !== newOnHand) {
        await c.query('UPDATE variants SET on_hand = $1 WHERE id = $2', [newOnHand, vId]);
        await c.query(
          `UPDATE stock_movements
           SET reason = $1
           WHERE id = (SELECT id FROM stock_movements WHERE variant_id = $2 ORDER BY at DESC LIMIT 1)`,
          [auditReason, vId]
        );
        updatedCount++;
      }
    }

    return {
      success: true,
      updatedCount,
      reason: auditReason
    };
  });
}

/**
 * Lists stock movements audit history with filters and pagination.
 */
async function listMovements({ sku, reason, direction = 'all', limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  const cleanSku = cleanIdentifier(sku, '-%');
  if (cleanSku) {
    params.push(`%${cleanSku}%`);
    conditions.push(`v.sku ILIKE $${params.length}`);
  }

  const cleanReason = cleanString(reason);
  if (cleanReason && cleanReason !== 'all') {
    params.push(`%${cleanReason}%`);
    conditions.push(`sm.reason ILIKE $${params.length}`);
  }

  const cleanDir = cleanString(direction, { toLower: true });
  if (cleanDir === 'positive') {
    conditions.push('sm.delta > 0');
  } else if (cleanDir === 'negative') {
    conditions.push('sm.delta < 0');
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const lim = cleanInt(limit, 1, 200, 50);
  const off = cleanInt(offset, 0, 1000000, 0);

  // Total count
  const countRes = await pool.query(
    `SELECT COUNT(sm.id)::int AS total
     FROM stock_movements sm
     JOIN variants v ON v.id = sm.variant_id
     JOIN products p ON p.id = v.product_id
     ${whereClause}`,
    params
  );
  const totalCount = countRes.rows[0]?.total || 0;

  params.push(lim, off);
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
    LIMIT $${params.length - 1} OFFSET $${params.length};
  `;

  const { rows } = await pool.query(sql, params);
  return {
    movements: rows,
    totalCount,
    limit: lim,
    offset: off
  };
}

/**
 * Exports up to 1000 recent stock movement audit rows.
 */
async function exportMovements() {
  const { rows } = await pool.query(`
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
  return rows;
}

/**
 * Returns low stock variants below reorder thresholds.
 */
async function lowStock() {
  const { rows } = await pool.query(
    `SELECT sku, product, category, size, colour, on_hand, reserved, available, reorder_level
       FROM v_stock WHERE active AND low_stock ORDER BY available, product, sku`
  );
  return rows;
}

module.exports = {
  setReason,
  listProducts,
  listVariants,
  getStock,
  createVariant,
  updateVariant,
  updateVariantImage,
  deleteVariant,
  adjustStock,
  bulkAdjustStock,
  listMovements,
  exportMovements,
  lowStock,
};
