/**
 * Products and Variants management service for shop-api.
 * Provides complete CRUD, catalog search, SKU generation, and sanitization.
 */
const { pool, tx } = require('./db');
const { ApiError, badRequest, notFound } = require('./errors');
const {
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanFloat,
  cleanBool,
  cleanUrl
} = require('./sanitize');

/**
 * Builds a clean base candidate SKU from product metadata.
 */
function buildBaseSku(productName, catName, sizeStr, colStr) {
  const words = (productName || catName || 'SIL').trim().split(/\s+/).filter(Boolean);
  let prefix = '';
  if (words.length >= 2) {
    prefix = words.map((w) => w[0].toUpperCase()).join('').slice(0, 4);
  } else if (words.length === 1) {
    prefix = words[0].slice(0, 3).toUpperCase();
  }
  if (!prefix || prefix.length < 2) prefix = 'SIL';

  const colCode = (colStr || 'STD').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'STD';
  const sizeCode = (sizeStr || 'FS').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'FS';
  return `${prefix}-${colCode}-${sizeCode}`;
}

/**
 * Finds a guaranteed unique SKU within a database client transaction or pool.
 */
async function getUniqueSku(client, baseCandidate) {
  let candidate = (baseCandidate || 'SKU').replace(/[^A-Z0-9-]/gi, '').toUpperCase();
  if (!candidate || candidate.length < 2) candidate = 'SKU';
  let current = candidate;
  let counter = 1;
  while (true) {
    const check = await client.query('SELECT 1 FROM variants WHERE sku = $1', [current]);
    if (check.rowCount === 0) return current;
    current = `${candidate}-${counter++}`;
  }
}

/**
 * Lists products for staff inventory portal with aggregation and rich filtering.
 */
async function listStaffProducts({ q, category, status = 'all', image = 'all', sort = 'id-asc' } = {}) {
  const conditions = [];
  const params = [];

  const cleanStatus = cleanString(status, { toLower: true });
  if (cleanStatus === 'active') {
    conditions.push('p.active = true');
  } else if (cleanStatus === 'archived') {
    conditions.push('p.active = false');
  }

  const cleanCat = cleanString(category);
  if (cleanCat && cleanCat !== 'all') {
    params.push(cleanCat);
    conditions.push(`p.category = $${params.length}`);
  }

  const cleanImg = cleanString(image, { toLower: true });
  if (cleanImg === 'with') {
    conditions.push("p.image_url IS NOT NULL AND p.image_url != ''");
  } else if (cleanImg === 'missing') {
    conditions.push("(p.image_url IS NULL OR p.image_url = '')");
  }

  const cleanQ = cleanString(q);
  if (cleanQ) {
    params.push(`%${cleanQ}%`);
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

  // Strict sorting allowlist to eliminate SQL injection vectors
  const SORT_MAP = {
    'id-asc': 'p.id ASC',
    'id-desc': 'p.id DESC',
    'name-asc': 'p.name ASC',
    'name-desc': 'p.name DESC',
    'price-asc': 'p.price_inr ASC',
    'price-desc': 'p.price_inr DESC',
    'stock-desc': 'total_available DESC',
    'stock-asc': 'total_available ASC',
  };
  const orderBy = SORT_MAP[sort] || 'p.id ASC';

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
      COUNT(v.id)::int AS variant_count,
      COALESCE(SUM(v.on_hand), 0)::int AS total_on_hand,
      COALESCE(SUM(v.reserved), 0)::int AS total_reserved,
      COALESCE(SUM(v.on_hand - v.reserved), 0)::int AS total_available,
      BOOL_OR((v.on_hand - v.reserved) <= v.reorder_level) AS has_low_stock
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id
    ${whereClause}
    GROUP BY p.id
    ORDER BY ${orderBy};
  `;

  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Returns distinct active and non-empty categories.
 */
async function getCategories() {
  const { rows } = await pool.query(`
    SELECT DISTINCT category
    FROM products
    WHERE category IS NOT NULL AND category != ''
    ORDER BY category ASC;
  `);
  return rows.map((r) => r.category);
}

/**
 * Returns lightweight summary of all products for staff navigation and modals.
 */
async function getProductSummary() {
  const { rows } = await pool.query(`
    SELECT id, name, category, active
    FROM products
    ORDER BY name ASC;
  `);
  return rows;
}

/**
 * Retrieves a single product by ID along with its variant inventory.
 */
async function getProductById(id) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid product ID is required');

  const pRes = await pool.query('SELECT * FROM products WHERE id = $1', [numId]);
  if (!pRes.rowCount) throw notFound(`Product #${numId} not found`);

  const vRes = await pool.query(
    'SELECT * FROM variants WHERE product_id = $1 ORDER BY id ASC',
    [numId]
  );

  return {
    product: pRes.rows[0],
    variants: vRes.rows,
  };
}

/**
 * Creates a new product and initial variants transactionally.
 */
async function createProduct(payload) {
  const name = cleanString(payload.name, { maxLength: 200 });
  if (!name || name.length < 2) {
    throw badRequest('Product name must be at least 2 characters long');
  }

  const category = cleanString(payload.category, { maxLength: 100 }) || null;
  if (!category) {
    throw badRequest('Category is required');
  }

  const price = cleanFloat(payload.price_inr, 0, 10000000, 2, -1);
  if (price < 0) {
    throw badRequest('Please enter a valid base price in INR (non-negative number)');
  }

  const description = cleanString(payload.description, { maxLength: 5000, allowNewlines: true }) || null;
  if (!description) {
    throw badRequest('Description is required');
  }
  const imageUrl = cleanUrl(payload.image_url);
  const active = cleanBool(payload.active);

  return tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO products (name, category, price_inr, description, image_url, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *;`,
      [name, category, price, description, imageUrl, active]
    );
    const newProduct = ins.rows[0];
    const newProductId = newProduct.id;

    // Handle initial variants
    const rawVariants = Array.isArray(payload.variants) ? payload.variants : [];
    let createdCount = 0;

    for (const v of rawVariants) {
      const rawSku = cleanIdentifier(v.sku, '-_');
      const rawSize = cleanString(v.size, { maxLength: 50 });
      const rawColour = cleanString(v.colour, { maxLength: 50 });
      const stockVal = cleanInt(v.on_hand != null ? v.on_hand : v.stock, 0, 100000, 0);
      const reorderVal = cleanInt(v.reorder_level != null ? v.reorder_level : v.reorder, 0, 100000, 2);
      const varImageUrl = cleanUrl(v.image_url);

      const hasContent = rawSku || rawSize || rawColour || stockVal > 0;
      if (!hasContent) continue;

      const sizeVal = rawSize || 'Free Size';
      const colourVal = rawColour || 'Standard';

      let finalSku = rawSku;
      if (!finalSku) {
        const baseCandidate = buildBaseSku(name, category, sizeVal, colourVal);
        finalSku = await getUniqueSku(c, baseCandidate);
      } else {
        finalSku = await getUniqueSku(c, finalSku);
      }

      await c.query(
        `INSERT INTO variants (product_id, sku, size, colour, on_hand, reserved, reorder_level, image_url)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7);`,
        [newProductId, finalSku, sizeVal, colourVal, stockVal, reorderVal, varImageUrl]
      );
      createdCount++;
    }

    // Safety fallback: Every product must have at least one variant
    if (createdCount === 0) {
      const baseCandidate = buildBaseSku(name, category, 'FS', 'STD');
      const defSku = await getUniqueSku(c, baseCandidate);
      await c.query(
        `INSERT INTO variants (product_id, sku, size, colour, on_hand, reserved, reorder_level)
         VALUES ($1, $2, $3, $4, 0, 0, 2);`,
        [newProductId, defSku, 'Free Size', 'Standard']
      );
    }

    const { rows: variants } = await c.query(
      'SELECT * FROM variants WHERE product_id = $1 ORDER BY id ASC',
      [newProductId]
    );

    return { product: newProduct, variants };
  });
}

/**
 * Updates an existing product's metadata.
 */
async function updateProduct(id, payload) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid product ID is required');

  const existing = await pool.query('SELECT * FROM products WHERE id = $1', [numId]);
  if (!existing.rowCount) throw notFound(`Product #${numId} not found`);

  const name = cleanString(payload.name, { maxLength: 200 });
  if (!name || name.length < 2) {
    throw badRequest('Product name must be at least 2 characters long');
  }

  const category = cleanString(payload.category, { maxLength: 100 }) || null;
  if (!category) {
    throw badRequest('Category is required');
  }

  const price = cleanFloat(payload.price_inr, 0, 10000000, 2, -1);
  if (price < 0) {
    throw badRequest('Please enter a valid base price in INR (non-negative number)');
  }

  const description = cleanString(payload.description, { maxLength: 5000, allowNewlines: true }) || null;
  if (!description) {
    throw badRequest('Description is required');
  }

  let finalImageUrl = existing.rows[0].image_url;
  if (payload.remove_image === '1' || payload.remove_image === true) {
    finalImageUrl = null;
  } else if (payload.image_url !== undefined) {
    finalImageUrl = cleanUrl(payload.image_url);
  }

  const active = payload.active !== undefined ? cleanBool(payload.active) : existing.rows[0].active;

  const { rows } = await pool.query(
    `UPDATE products
     SET name = $1,
         category = $2,
         price_inr = $3,
         description = $4,
         image_url = $5,
         active = $6
     WHERE id = $7
     RETURNING *;`,
    [name, category, price, description, finalImageUrl, active, numId]
  );

  return rows[0];
}

/**
 * Toggles product active/archived state.
 */
async function toggleProductStatus(id) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid product ID is required');

  const { rows } = await pool.query(
    `UPDATE products
     SET active = NOT active
     WHERE id = $1
     RETURNING id, name, active;`,
    [numId]
  );
  if (!rows.length) throw notFound(`Product #${numId} not found`);
  return rows[0];
}

/**
 * Updates image for all variants of a specified colour under a product.
 */
async function updateColorImage(id, { colour, image_url, remove_image }) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid product ID is required');

  const cleanCol = cleanString(colour, { maxLength: 50 });
  if (!cleanCol) throw badRequest('Colour name is required');

  let finalImageUrl = null;
  if (remove_image === '1' || remove_image === true) {
    finalImageUrl = null;
  } else {
    finalImageUrl = cleanUrl(image_url);
    if (!finalImageUrl) throw badRequest('Valid image URL is required');
  }

  const { rowCount } = await pool.query(
    `UPDATE variants
     SET image_url = $1
     WHERE product_id = $2 AND LOWER(TRIM(colour)) = LOWER(TRIM($3));`,
    [finalImageUrl, numId, cleanCol]
  );

  return { updated: rowCount, image_url: finalImageUrl };
}

/**
 * Deletes a product and all of its associated variants (cascade).
 */
async function deleteProduct(id) {
  const numId = cleanInt(id, 1);
  if (!numId) throw badRequest('Valid product ID is required');

  // Check if any variant is held for pending orders
  const holdCheck = await pool.query(
    'SELECT sku, reserved FROM variants WHERE product_id = $1 AND reserved > 0',
    [numId]
  );
  if (holdCheck.rowCount > 0) {
    const list = holdCheck.rows.map((r) => `${r.sku} (${r.reserved} reserved)`).join(', ');
    throw new ApiError(
      409,
      'RESERVED_STOCK_ACTIVE',
      `Cannot delete product #${numId}: active reservations exist on variants: ${list}`
    );
  }

  const { rows } = await pool.query(
    'DELETE FROM products WHERE id = $1 RETURNING id, name',
    [numId]
  );
  if (!rows.length) throw notFound(`Product #${numId} not found`);
  return rows[0];
}

module.exports = {
  buildBaseSku,
  getUniqueSku,
  listStaffProducts,
  getCategories,
  getProductSummary,
  getProductById,
  createProduct,
  updateProduct,
  toggleProductStatus,
  updateColorImage,
  deleteProduct,
};
