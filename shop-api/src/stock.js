const { pool, tx } = require('./db');
const { ApiError, badRequest, notFound } = require('./errors');

// Records why stock moved; read by the audit trigger (see migration 002).
async function setReason(c, reason, ref) {
  await c.query("SELECT set_config('shop.reason', $1, true), set_config('shop.ref', $2, true)", [
    reason,
    ref || '',
  ]);
}

// Public callers see only `available`; callers with the API key also see the raw numbers.
function shapeVariant(v, admin) {
  const out = {
    sku: v.sku,
    size: v.size,
    colour: v.colour,
    available: Math.max(v.on_hand - v.reserved, 0),
  };
  if (admin) {
    out.on_hand = v.on_hand;
    out.reserved = v.reserved;
    out.reorder_level = v.reorder_level;
  }
  return out;
}

async function listProducts({ category, q, admin }) {
  const where = ['p.active'];
  const args = [];
  if (category) where.push(`p.category ILIKE $${args.push(String(category))}`);
  if (q) where.push(`p.name ILIKE $${args.push('%' + String(q) + '%')}`);

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.category, p.price_inr, p.description, p.image_url,
            v.sku, v.size, v.colour, v.on_hand, v.reserved, v.reorder_level
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
      const v = shapeVariant(r, admin);
      p.variants.push(v);
      if (v.available > 0) p.in_stock = true;
    }
  }
  return [...byId.values()];
}

async function getStock(sku, admin) {
  const { rows } = await pool.query(
    `SELECT v.sku, v.size, v.colour, v.on_hand, v.reserved, v.reorder_level,
            p.name AS product, p.price_inr, p.active
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.sku = $1`,
    [sku]
  );
  if (!rows.length) throw notFound(`Unknown SKU ${sku}`);
  const r = rows[0];
  return { product: r.product, price_inr: r.price_inr, active: r.active, ...shapeVariant(r, admin) };
}

async function adjustStock({ sku, delta, reason }) {
  if (typeof sku !== 'string' || !sku) throw badRequest('sku is required');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
    throw badRequest('delta must be a non-zero integer (positive = add stock, negative = remove)');
  }
  const why = String(reason || '').trim().slice(0, 100);
  if (!why) throw badRequest('reason is required (e.g. "restock", "walk-in sale", "damaged")');

  return tx(async (c) => {
    await setReason(c, `adjust: ${why}`, '');
    const r = await c.query(
      `UPDATE variants SET on_hand = on_hand + $2
        WHERE sku = $1 AND on_hand + $2 >= reserved
        RETURNING sku, on_hand, reserved, reorder_level`,
      [sku, delta]
    );
    if (!r.rowCount) {
      const cur = await c.query('SELECT sku, on_hand, reserved FROM variants WHERE sku = $1', [sku]);
      if (!cur.rowCount) throw notFound(`Unknown SKU ${sku}`);
      throw new ApiError(
        409,
        'BELOW_RESERVED',
        `Cannot reduce ${sku} by ${-delta}: ${cur.rows[0].on_hand} on hand, ${cur.rows[0].reserved} reserved for open orders`,
        { on_hand: cur.rows[0].on_hand, reserved: cur.rows[0].reserved }
      );
    }
    const v = r.rows[0];
    return { sku: v.sku, on_hand: v.on_hand, reserved: v.reserved, available: v.on_hand - v.reserved };
  });
}

async function lowStock() {
  const { rows } = await pool.query(
    `SELECT sku, product, category, size, colour, on_hand, reserved, available, reorder_level
       FROM v_stock WHERE active AND low_stock ORDER BY available, product, sku`
  );
  return rows;
}

module.exports = { setReason, listProducts, getStock, adjustStock, lowStock };
