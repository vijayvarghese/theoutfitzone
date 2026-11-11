const { pool, tx } = require('./db');
const { ApiError, badRequest, notFound } = require('./errors');
const { setReason } = require('./stock');
const {
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanFloat,
  cleanPhone,
  cleanEmail,
  cleanEnum
} = require('./sanitize');

const PREFIX = (process.env.ORDER_PREFIX || 'DS').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'DS';
const RESERVATION_MINUTES = parseInt(process.env.RESERVATION_MINUTES || '30', 10);

const CHANNELS = ['whatsapp', 'instagram', 'telegram', 'web', 'walkin', 'other'];
const PAY_MODES = ['COD', 'UPI', 'CARD', 'CASH'];

// Allowed status moves. Anything else is rejected.
const TRANSITIONS = {
  NEW: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED'],
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'], // RETURNED here = undelivered, came back to you
  DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'], // DELIVERED = return rejected
  RETURNED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};
const STATUSES = Object.keys(TRANSITIONS);

const round2 = (n) => Math.round(n * 100) / 100;
const text = (v, max = 500) => cleanString(v, { maxLength: max }) || null;

function normPhone(p) {
  const d = cleanPhone(p);
  return d.length >= 10 ? d.slice(-10) : null;
}

/* ---------- reading ---------- */

async function getOrder(db, orderNo) {
  const cleanNo = cleanIdentifier(orderNo, '-');
  const o = await db.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
            c.address AS customer_address, c.pincode AS customer_pincode,
            c.wa_id, c.tg_chat_id, c.ig_scoped_id
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.order_no = $1`,
    [cleanNo]
  );
  if (!o.rowCount) return null;
  const r = o.rows[0];
  const items = await db.query(
    `SELECT oi.id, oi.variant_id, oi.qty, oi.unit_price,
            (oi.qty * oi.unit_price) AS line_total,
            v.sku, v.size, v.colour,
            p.name AS product, p.name AS product_name,
            COALESCE(v.image_url, p.image_url) AS image_url
       FROM order_items oi
       JOIN variants v ON v.id = oi.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id`,
    [r.id]
  );
  const events = await db.query(
    `SELECT id, from_status, to_status, note, actor, at
       FROM order_events WHERE order_id = $1 ORDER BY id ASC`,
    [r.id]
  );
  return {
    id: r.id,
    order_no: r.order_no,
    status: r.status,
    channel: r.channel,
    reply_to: r.reply_to,
    payment_mode: r.payment_mode,
    payment_status: r.payment_status,
    payment_ref: r.payment_ref,
    subtotal: Number(r.subtotal),
    shipping: Number(r.shipping),
    discount: Number(r.discount || 0),
    total: Number(r.total),
    coupon_code: r.coupon_code || null,
    ship_address: r.ship_address || r.customer_address,
    ship_pincode: r.ship_pincode || r.customer_pincode,
    courier: r.courier,
    awb: r.awb,
    notes: r.notes,
    expires_at: r.expires_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    customer: {
      name: r.customer_name || 'Valued Patron',
      phone: r.customer_phone,
      email: r.customer_email || '',
      address: r.customer_address,
      pincode: r.customer_pincode,
      wa_id: r.wa_id,
      tg_chat_id: r.tg_chat_id,
      ig_scoped_id: r.ig_scoped_id,
    },
    items: items.rows.map((it) => ({
      ...it,
      qty: Number(it.qty),
      unit_price: Number(it.unit_price),
      line_total: Number(it.line_total),
    })),
    events: events.rows,
    allowedTransitions: TRANSITIONS[r.status] || [],
    canMarkPaid: r.payment_status !== 'PAID' && !['CANCELLED', 'REFUNDED', 'RETURNED'].includes(r.status),
  };
}

async function listOrders({ status, channel, q, limit, offset }) {
  const where = [];
  const args = [];

  const cleanSt = cleanString(status, { toUpper: true });
  if (cleanSt && STATUSES.includes(cleanSt)) {
    where.push(`o.status = $${args.push(cleanSt)}`);
  }

  const cleanCh = cleanString(channel, { toLower: true });
  if (cleanCh && CHANNELS.includes(cleanCh)) {
    where.push(`o.channel = $${args.push(cleanCh)}`);
  }

  const cleanQ = cleanString(q);
  if (cleanQ) {
    const n = args.push('%' + cleanQ + '%');
    where.push(`(o.order_no ILIKE $${n} OR c.phone LIKE $${n} OR c.name ILIKE $${n} OR c.email ILIKE $${n} OR o.awb ILIKE $${n})`);
  }

  const lim = cleanInt(limit, 1, 200, 50);
  const off = cleanInt(offset, 0, 1000000, 0);

  // Total count for pagination
  const countSql = `
    SELECT COUNT(o.id)::int AS total
      FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  `;
  const countRes = await pool.query(countSql, args);
  const totalCount = countRes.rows[0]?.total || 0;

  args.push(lim, off);
  const { rows } = await pool.query(
    `SELECT o.id, o.order_no, o.status, o.channel, o.payment_mode, o.payment_status, o.payment_ref,
            o.subtotal, o.shipping, o.discount, o.total, o.coupon_code, o.courier, o.awb,
            o.created_at, o.updated_at, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
            (SELECT COALESCE(SUM(qty), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS items,
            (SELECT COALESCE(SUM(qty), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS items_count
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );

  return {
    orders: rows,
    totalCount,
    limit: lim,
    offset: off,
  };
}

async function getOrderMetrics() {
  const statusRes = await pool.query(`
    SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total), 0)::numeric AS revenue
      FROM orders
     GROUP BY status
  `);

  const summary = {
    totalOrders: 0,
    totalRevenue: 0,
    byStatus: {},
  };

  for (const row of statusRes.rows) {
    const cnt = parseInt(row.count, 10);
    const rev = parseFloat(row.revenue);
    summary.totalOrders += cnt;
    summary.totalRevenue += rev;
    summary.byStatus[row.status] = { count: cnt, revenue: rev };
  }

  summary.pendingPayment = (summary.byStatus['PENDING_PAYMENT']?.count || 0) + (summary.byStatus['NEW']?.count || 0);
  summary.toPack = summary.byStatus['CONFIRMED']?.count || 0;
  summary.toShip = summary.byStatus['PACKED']?.count || 0;
  summary.inTransit = summary.byStatus['SHIPPED']?.count || 0;
  summary.delivered = summary.byStatus['DELIVERED']?.count || 0;
  summary.total_orders = summary.totalOrders;
  summary.total_revenue = summary.totalRevenue;

  return summary;
}

// Public lookup: needs order number + last 4 digits of the phone.
async function track(orderNo, phone4) {
  const cleanNo = cleanIdentifier(orderNo, '-');
  const cleanP4 = String(phone4 || '').replace(/\D/g, '');
  if (!/^\d{4}$/.test(cleanP4)) {
    throw badRequest('phone4 (last 4 digits of the phone number) is required');
  }

  const o = await pool.query(
    `SELECT o.id, o.order_no, o.status, o.total, o.payment_mode, o.payment_status,
            o.courier, o.awb, o.created_at, o.updated_at, c.phone
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.order_no = $1`,
    [cleanNo]
  );
  const r = o.rows[0];
  if (!r || !r.phone || !r.phone.endsWith(cleanP4)) throw notFound('Order not found');

  const items = await pool.query(
    `SELECT p.name AS product, v.size, v.colour, oi.qty
       FROM order_items oi JOIN variants v ON v.id = oi.variant_id
       JOIN products p ON p.id = v.product_id WHERE oi.order_id = $1 ORDER BY oi.id`,
    [r.id]
  );
  const events = await pool.query(
    'SELECT to_status AS status, at FROM order_events WHERE order_id = $1 ORDER BY id',
    [r.id]
  );
  return {
    order_no: r.order_no,
    status: r.status,
    total: r.total,
    payment_mode: r.payment_mode,
    payment_status: r.payment_status,
    courier: r.courier,
    awb: r.awb,
    created_at: r.created_at,
    updated_at: r.updated_at,
    items: items.rows,
    history: events.rows,
  };
}

/* ---------- stock helpers (always inside a transaction) ---------- */

async function commitStock(c, items, reason, ref) {
  await setReason(c, reason, ref);
  for (const it of items) {
    const r = await c.query(
      `UPDATE variants SET on_hand = on_hand - $1, reserved = reserved - $1
        WHERE id = $2 AND reserved >= $1 AND on_hand >= $1`,
      [it.qty, it.variant_id]
    );
    if (!r.rowCount) throw inconsistent(it);
  }
}

async function releaseReserved(c, items) {
  for (const it of items) {
    const r = await c.query(
      'UPDATE variants SET reserved = GREATEST(0, reserved - $1) WHERE id = $2',
      [it.qty, it.variant_id]
    );
    if (!r.rowCount) throw inconsistent(it);
  }
}

async function restockItems(c, items, reason, ref) {
  await setReason(c, reason, ref);
  for (const it of items) {
    await c.query('UPDATE variants SET on_hand = on_hand + $1 WHERE id = $2', [it.qty, it.variant_id]);
  }
}

function inconsistent(it) {
  return new ApiError(
    500,
    'STOCK_INCONSISTENT',
    `Stock numbers for variant ${it.variant_id} do not match this order. Was "reserved" edited by hand? Fix it in the admin screen, then retry.`
  );
}

/* ---------- creating ---------- */

function validateCreate(body) {
  const b = body || {};
  const channel = cleanEnum(b.channel, CHANNELS, null);
  if (!channel) throw badRequest(`channel must be one of ${CHANNELS.join(', ')}`);
  const walkin = channel === 'walkin';

  const payMode = cleanEnum(b.payment_mode, PAY_MODES, walkin ? 'CASH' : 'COD');
  if (walkin && payMode === 'COD') throw badRequest('walk-in sales are paid on the spot: use CASH, UPI or CARD');
  if (!walkin && payMode === 'CASH') throw badRequest('CASH is only for walk-in sales; use COD for delivery orders');

  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) {
    throw badRequest('items must be a list of 1 to 50 entries like {"sku":"KUR-RED-M","qty":1}');
  }
  const items = new Map();
  for (const it of b.items) {
    const sku = cleanIdentifier(it && it.sku, '-_');
    const qty = cleanInt(it && it.qty, 1, 100, 0);
    if (!sku || qty < 1) {
      throw badRequest('each item needs a valid sku and an integer qty from 1 to 100');
    }
    items.set(sku, (items.get(sku) || 0) + qty);
  }

  const shipping = cleanFloat(b.shipping, 0, 10000, 2, 0);

  const cust = b.customer || {};
  const phone = normPhone(cust.phone || b.phone);
  const address = text(b.ship_address != null ? b.ship_address : cust.address, 500);
  const pincodeRaw = String(b.ship_pincode != null ? b.ship_pincode : cust.pincode || '').replace(/\D/g, '');
  const pincode = /^\d{6}$/.test(pincodeRaw) ? pincodeRaw : null;

  if (!walkin) {
    if (!phone) throw badRequest('customer.phone (10-digit mobile number) is required');
    if (!address) throw badRequest('ship_address (or customer.address) is required');
    if (!pincode) throw badRequest('ship_pincode must be a 6-digit pincode');
  }

  return {
    channel,
    walkin,
    payMode,
    items,
    shipping,
    phone,
    address,
    pincode,
    customer: {
      name: text(cust.name || b.name, 120),
      email: cleanEmail(cust.email || b.email),
      wa_id: text(cust.wa_id, 60),
      tg_chat_id: text(cust.tg_chat_id, 60),
      ig_scoped_id: text(cust.ig_scoped_id, 60),
    },
    replyTo: text(b.reply_to, 120),
    notes: text(b.notes, 500),
    couponCode: cleanIdentifier(b.coupon_code || b.couponCode, '-_') || null,
    idemKey: text(b.idempotency_key || b.idem_key, 120),
  };
}

async function upsertCustomer(c, input) {
  if (!input.phone) return null;
  const ins = await c.query(
    `INSERT INTO customers (name, phone, address, pincode, email, wa_id, tg_chat_id, ig_scoped_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (phone) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, customers.name),
       address = COALESCE(EXCLUDED.address, customers.address),
       pincode = COALESCE(EXCLUDED.pincode, customers.pincode),
       email = COALESCE(EXCLUDED.email, customers.email),
       wa_id = COALESCE(EXCLUDED.wa_id, customers.wa_id),
       tg_chat_id = COALESCE(EXCLUDED.tg_chat_id, customers.tg_chat_id),
       ig_scoped_id = COALESCE(EXCLUDED.ig_scoped_id, customers.ig_scoped_id)
     RETURNING id`,
    [
      input.customer.name,
      input.phone,
      input.address,
      input.pincode,
      input.customer.email,
      input.customer.wa_id,
      input.customer.tg_chat_id,
      input.customer.ig_scoped_id,
    ]
  );
  return ins.rows[0].id;
}

async function reserveOrCheckStock(c, lines, walkin, orderRef) {
  await setReason(c, walkin ? 'walkin_sale' : 'order_reserve', orderRef || '');
  for (const l of lines) {
    const cur = await c.query('SELECT on_hand, reserved FROM variants WHERE id = $1 FOR UPDATE', [l.id]);
    if (!cur.rowCount) throw badRequest(`Variant ${l.sku} no longer exists`);
    const { on_hand, reserved } = cur.rows[0];
    const avail = on_hand - reserved;
    if (avail < l.qty) {
      throw new ApiError(
        409,
        'OUT_OF_STOCK',
        `Not enough stock for ${l.sku} (${l.product || ''}): ${avail} available, ${l.qty} requested`,
        { sku: l.sku, product: l.product, size: l.size, requested: l.qty, available: Math.max(0, avail) }
      );
    }
    if (!walkin) {
      await c.query('UPDATE variants SET reserved = reserved + $1 WHERE id = $2', [l.qty, l.id]);
    }
  }
}

async function createInTx(c, input, actor) {
  const customerId = await upsertCustomer(c, input);

  const skus = [...input.items.keys()];
  const vres = await c.query(
    `SELECT v.id, v.sku, v.size, v.colour, p.name AS product, p.price_inr, p.active
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.sku = ANY($1::text[])`,
    [skus]
  );
  if (vres.rowCount !== skus.length) {
    const found = new Set(vres.rows.map((r) => r.sku));
    const missing = skus.filter((s) => !found.has(s));
    throw badRequest(`Unknown SKU(s): ${missing.join(', ')}`);
  }
  const inactive = vres.rows.find((r) => !r.active);
  if (inactive) throw badRequest(`Product for SKU ${inactive.sku} is not active`);

  const lines = vres.rows.map((r) => ({
    ...r,
    qty: input.items.get(r.sku),
  }));

  const subtotal = round2(lines.reduce((sum, l) => sum + l.qty * Number(l.price_inr), 0));

  let status = 'NEW';
  let paymentStatus = 'UNPAID';
  let expiresAt = null;

  if (input.walkin) {
    status = 'DELIVERED';
    paymentStatus = 'PAID';
  } else if (input.payMode === 'UPI') {
    status = 'PENDING_PAYMENT';
    expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60000);
  } else if (input.payMode === 'COD') {
    status = 'CONFIRMED';
  }

  await reserveOrCheckStock(c, lines, input.walkin, input.idemKey);

  // Validate coupon and calculate discount if provided
  let coupon = null;
  let discount = 0;
  if (input.couponCode) {
    const cq = await c.query(
      `SELECT * FROM coupons WHERE LOWER(code) = LOWER($1) FOR UPDATE`,
      [input.couponCode]
    );
    if (!cq.rowCount) {
      throw new ApiError(400, 'INVALID_COUPON', `Coupon "${input.couponCode}" is invalid.`);
    }
    coupon = cq.rows[0];
    if (!coupon.active) {
      throw new ApiError(400, 'COUPON_INACTIVE', `Coupon "${coupon.code}" is currently inactive.`);
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      throw new ApiError(400, 'COUPON_EXPIRED', `Coupon "${coupon.code}" has expired.`);
    }
    if (coupon.scope !== 'unlimited' && coupon.usage_limit != null && coupon.usage_count >= coupon.usage_limit) {
      throw new ApiError(400, 'COUPON_EXHAUSTED', `Coupon "${coupon.code}" has reached its maximum redemption limit.`);
    }
    if (subtotal < Number(coupon.min_order_amount)) {
      throw new ApiError(400, 'COUPON_MIN_ORDER', `Coupon "${coupon.code}" requires a minimum order subtotal of ₹${Number(coupon.min_order_amount).toLocaleString('en-IN')}.`);
    }

    if (coupon.discount_type === 'percent') {
      discount = round2(subtotal * (Number(coupon.discount_value) / 100));
    } else {
      discount = round2(Math.min(Number(coupon.discount_value), subtotal));
    }
  }

  const total = round2(Math.max(0, subtotal + input.shipping - discount));

  const ins = await c.query(
    `INSERT INTO orders (order_no, customer_id, channel, reply_to, status, payment_mode, payment_status,
                         subtotal, shipping, discount, total, coupon_code, ship_address, ship_pincode, notes, expires_at, idempotency_key)
     VALUES ($1 || '-' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMM') || '-' ||
             lpad(nextval('order_seq')::text, 5, '0'),
             $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id, order_no`,
    [
      PREFIX,
      customerId,
      input.channel,
      input.replyTo,
      status,
      input.payMode,
      paymentStatus,
      subtotal,
      input.shipping,
      discount,
      total,
      coupon ? coupon.code : null,
      input.address,
      input.pincode,
      input.notes,
      expiresAt,
      input.idemKey,
    ]
  );
  const { id: orderId, order_no: orderNo } = ins.rows[0];

  if (coupon) {
    await c.query(
      `UPDATE coupons SET usage_count = usage_count + 1, updated_at = now() WHERE id = $1`,
      [coupon.id]
    );
  }

  for (const l of lines) {
    await c.query(
      'INSERT INTO order_items (order_id, variant_id, qty, unit_price) VALUES ($1,$2,$3,$4)',
      [orderId, l.id, l.qty, l.price_inr]
    );
  }
  await c.query(
    'INSERT INTO order_events (order_id, from_status, to_status, note, actor) VALUES ($1,NULL,$2,$3,$4)',
    [orderId, status, input.walkin ? 'walk-in sale' : `order placed via ${input.channel}`, cleanString(actor, { maxLength: 80 }) || 'api']
  );

  if (input.walkin) {
    await commitStock(c, lines.map((l) => ({ variant_id: l.id, qty: l.qty })), 'walkin_sale', orderNo);
  }

  return { order: await getOrder(c, orderNo), duplicate: false };
}

async function createOrder(body, actor = 'api') {
  const input = validateCreate(body);
  try {
    return await tx((c) => createInTx(c, input, actor));
  } catch (e) {
    if (e.code === '23505' && /orders_order_no_key/.test(`${e.constraint} ${e.detail}`)) {
      try {
        await pool.query(`
          SELECT setval('order_seq', GREATEST(
            (SELECT COALESCE(MAX(SUBSTRING(order_no FROM '[0-9]+$')::int), 0) FROM orders),
            (SELECT last_value FROM order_seq)
          ))
        `);
        return await tx((c) => createInTx(c, input, actor));
      } catch (retryErr) {
        console.error('Order sequence retry failed:', retryErr);
      }
    }
    if (e.code === '23505' && input.idemKey && /idempotency_key/.test(`${e.constraint} ${e.detail}`)) {
      const r = await pool.query('SELECT order_no FROM orders WHERE idempotency_key = $1', [input.idemKey]);
      if (r.rowCount) return { order: await getOrder(pool, r.rows[0].order_no), duplicate: true };
    }
    throw e;
  }
}

/* ---------- status changes ---------- */

async function applyStatus(c, o, target, opts = {}) {
  const { note, actor = 'api', courier, awb, restock = true } = opts;
  const allowed = TRANSITIONS[o.status] || [];
  if (!allowed.includes(target)) {
    throw new ApiError(409, 'INVALID_TRANSITION', `Cannot move ${o.order_no} from ${o.status} to ${target}`, {
      from: o.status,
      to: target,
      allowed,
    });
  }
  const items = (
    await c.query('SELECT variant_id, qty FROM order_items WHERE order_id = $1 ORDER BY variant_id', [o.id])
  ).rows;

  if (target === 'PACKED') {
    await commitStock(c, items, 'order_packed', o.order_no);
  } else if (target === 'CANCELLED') {
    if (o.status === 'PACKED') await restockItems(c, items, 'cancel_restock', o.order_no);
    else await releaseReserved(c, items);
  } else if (target === 'RETURNED' && restock) {
    await restockItems(c, items, 'return_restock', o.order_no);
  }

  let paymentStatus = o.payment_status;
  if (target === 'DELIVERED' && o.payment_mode === 'COD') paymentStatus = 'PAID';
  if (target === 'REFUNDED') paymentStatus = 'REFUNDED';

  await c.query(
    `UPDATE orders SET status = $2, payment_status = $3,
            courier = COALESCE($4, courier), awb = COALESCE($5, awb),
            expires_at = CASE WHEN $2 = 'PENDING_PAYMENT' THEN expires_at ELSE NULL END,
            updated_at = now()
      WHERE id = $1`,
    [o.id, target, paymentStatus, text(courier, 80), text(awb, 80)]
  );
  await c.query(
    'INSERT INTO order_events (order_id, from_status, to_status, note, actor) VALUES ($1,$2,$3,$4,$5)',
    [o.id, o.status, target, text(note, 500), cleanString(actor, { maxLength: 80 }) || 'api']
  );
}

async function lockOrder(c, orderNo) {
  const cleanNo = cleanIdentifier(orderNo, '-');
  const r = await c.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [cleanNo]);
  if (!r.rowCount) throw notFound(`Order ${orderNo} not found`);
  return r.rows[0];
}

async function changeStatus(orderNo, body, actor = 'api') {
  const target = cleanString(body && body.status, { toUpper: true });
  if (!STATUSES.includes(target)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  return tx(async (c) => {
    const o = await lockOrder(c, orderNo);
    await applyStatus(c, o, target, {
      note: body.note,
      actor,
      courier: body.courier,
      awb: body.awb,
      restock: body.restock !== false && body.restock !== 'false',
    });
    return getOrder(c, o.order_no);
  });
}

async function markPaid(orderNo, body, actor = 'api') {
  return tx(async (c) => {
    let o = await lockOrder(c, orderNo);
    if (o.payment_status === 'PAID') return getOrder(c, o.order_no);
    if (['CANCELLED', 'REFUNDED', 'RETURNED'].includes(o.status)) {
      throw new ApiError(
        409,
        'ORDER_CLOSED',
        `${o.order_no} is ${o.status}. Payment arrived for a closed order: refund it or create a new order.`,
        { status: o.status }
      );
    }
    const cleanRef = text(body && (body.payment_ref || body.paymentRef), 120);
    await c.query(
      `UPDATE orders SET payment_status = 'PAID', payment_ref = COALESCE($2, payment_ref), updated_at = now()
        WHERE id = $1`,
      [o.id, cleanRef]
    );
    o = (await c.query('SELECT * FROM orders WHERE id = $1', [o.id])).rows[0];
    const actorName = cleanString(actor, { maxLength: 80 }) || 'api';
    if (o.status === 'NEW' || o.status === 'PENDING_PAYMENT') {
      await applyStatus(c, o, 'CONFIRMED', { note: `Payment confirmed (Ref: ${cleanRef || 'Verified'})`, actor: actorName });
    } else {
      await c.query(
        'INSERT INTO order_events (order_id, from_status, to_status, note, actor) VALUES ($1,$2,$2,$3,$4)',
        [o.id, o.status, `Payment verified (Ref: ${cleanRef || 'Verified'})`, actorName]
      );
    }
    return getOrder(c, o.order_no);
  });
}

async function expireReservations() {
  return tx(async (c) => {
    const r = await c.query(
      `SELECT * FROM orders WHERE status = 'PENDING_PAYMENT' AND expires_at < now()
        ORDER BY id FOR UPDATE SKIP LOCKED`
    );
    const out = [];
    for (const o of r.rows) {
      await applyStatus(c, o, 'CANCELLED', { note: 'payment window expired', actor: 'system' });
      out.push({ order_no: o.order_no, channel: o.channel, reply_to: o.reply_to });
    }
    return out;
  });
}

module.exports = {
  TRANSITIONS,
  createOrder,
  getOrder,
  listOrders,
  getOrderMetrics,
  track,
  changeStatus,
  markPaid,
  expireReservations,
};
