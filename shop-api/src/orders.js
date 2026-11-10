const { pool, tx } = require('./db');
const { ApiError, badRequest, notFound } = require('./errors');
const { setReason } = require('./stock');

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
const text = (v, max = 500) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

function normPhone(p) {
  const d = String(p == null ? '' : p).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/* ---------- reading ---------- */

async function getOrder(db, orderNo) {
  const o = await db.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
            c.wa_id, c.tg_chat_id, c.ig_scoped_id
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.order_no = $1`,
    [orderNo]
  );
  if (!o.rowCount) return null;
  const r = o.rows[0];
  const items = await db.query(
    `SELECT v.sku, p.name AS product, v.size, v.colour, oi.qty, oi.unit_price,
            oi.qty * oi.unit_price AS line_total
       FROM order_items oi
       JOIN variants v ON v.id = oi.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id`,
    [r.id]
  );
  const events = await db.query(
    `SELECT from_status, to_status, note, actor, at
       FROM order_events WHERE order_id = $1 ORDER BY id`,
    [r.id]
  );
  return {
    order_no: r.order_no,
    status: r.status,
    channel: r.channel,
    reply_to: r.reply_to,
    payment_mode: r.payment_mode,
    payment_status: r.payment_status,
    payment_ref: r.payment_ref,
    subtotal: r.subtotal,
    shipping: r.shipping,
    discount: r.discount || 0,
    total: r.total,
    coupon_code: r.coupon_code || null,
    ship_address: r.ship_address,
    ship_pincode: r.ship_pincode,
    courier: r.courier,
    awb: r.awb,
    notes: r.notes,
    expires_at: r.expires_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    customer: {
      name: r.customer_name,
      phone: r.customer_phone,
      email: r.customer_email || '',
      wa_id: r.wa_id,
      tg_chat_id: r.tg_chat_id,
      ig_scoped_id: r.ig_scoped_id,
    },
    items: items.rows,
    events: events.rows,
  };
}

async function listOrders({ status, channel, q, limit, offset }) {
  const where = [];
  const args = [];
  if (status) {
    const s = String(status).toUpperCase();
    if (!STATUSES.includes(s)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    where.push(`o.status = $${args.push(s)}`);
  }
  if (channel) where.push(`o.channel = $${args.push(String(channel).toLowerCase())}`);
  if (q) {
    const n = args.push('%' + String(q).trim() + '%');
    where.push(`(o.order_no ILIKE $${n} OR c.phone LIKE $${n} OR c.name ILIKE $${n} OR c.email ILIKE $${n})`);
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  args.push(lim, off);
  const { rows } = await pool.query(
    `SELECT o.order_no, o.status, o.channel, o.payment_mode, o.payment_status, o.total, o.discount, o.coupon_code,
            o.created_at, o.updated_at, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
            (SELECT COALESCE(SUM(qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  return rows;
}

// Public lookup: needs order number + last 4 digits of the phone. Wrong answers look like "not found".
async function track(orderNo, phone4) {
  if (!/^\d{4}$/.test(String(phone4 || ''))) throw badRequest('phone4 (last 4 digits of the phone number) is required');
  const o = await pool.query(
    `SELECT o.id, o.order_no, o.status, o.total, o.payment_mode, o.payment_status,
            o.courier, o.awb, o.created_at, o.updated_at, c.phone
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.order_no = $1`,
    [String(orderNo).toUpperCase()]
  );
  const r = o.rows[0];
  if (!r || !r.phone || !r.phone.endsWith(String(phone4))) throw notFound('Order not found');
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
      'UPDATE variants SET reserved = reserved - $1 WHERE id = $2 AND reserved >= $1',
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
  const channel = String(b.channel || '').toLowerCase();
  if (!CHANNELS.includes(channel)) throw badRequest(`channel must be one of ${CHANNELS.join(', ')}`);
  const walkin = channel === 'walkin';

  const payMode = String(b.payment_mode || (walkin ? 'CASH' : 'COD')).toUpperCase();
  if (!PAY_MODES.includes(payMode)) throw badRequest(`payment_mode must be one of ${PAY_MODES.join(', ')}`);
  if (walkin && payMode === 'COD') throw badRequest('walk-in sales are paid on the spot: use CASH, UPI or CARD');
  if (!walkin && payMode === 'CASH') throw badRequest('CASH is only for walk-in sales; use COD for delivery orders');

  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) {
    throw badRequest('items must be a list of 1 to 50 entries like {"sku":"KUR-RED-M","qty":1}');
  }
  const items = new Map();
  for (const it of b.items) {
    const sku = text(it && it.sku, 80);
    const qty = it && it.qty;
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 100) {
      throw badRequest('each item needs a sku and an integer qty from 1 to 100');
    }
    items.set(sku, (items.get(sku) || 0) + qty);
  }

  const shipping = b.shipping == null ? 0 : Number(b.shipping);
  if (!Number.isFinite(shipping) || shipping < 0) throw badRequest('shipping must be a number >= 0');

  const cust = b.customer || {};
  const phone = normPhone(cust.phone);
  const address = text(b.ship_address != null ? b.ship_address : cust.address, 500);
  const pincode = text(b.ship_pincode != null ? b.ship_pincode : cust.pincode, 20);
  if (!walkin) {
    if (!phone) throw badRequest('customer.phone (10-digit mobile number) is required');
    if (!address) throw badRequest('ship_address (or customer.address) is required');
    if (!/^\d{6}$/.test(pincode || '')) throw badRequest('ship_pincode must be a 6-digit pincode');
  }

  return {
    channel,
    walkin,
    payMode,
    items,
    shipping,
    phone,
    address,
    pincode: pincode && /^\d{6}$/.test(pincode) ? pincode : null,
    customer: {
      name: text(cust.name, 120),
      email: text(cust.email || b.email, 150),
      wa_id: text(cust.wa_id, 60),
      tg_chat_id: text(cust.tg_chat_id, 60),
      ig_scoped_id: text(cust.ig_scoped_id, 60),
    },
    replyTo: text(b.reply_to, 120),
    notes: text(b.notes, 1000),
    idemKey: text(b.idempotency_key, 120),
    couponCode: text(b.coupon_code, 50),
  };
}

async function createInTx(c, input, actor) {
  if (input.idemKey) {
    // identical retries wait here for the first one to finish, then see its order
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['idem:' + input.idemKey]);
    const dup = await c.query('SELECT order_no FROM orders WHERE idempotency_key = $1', [input.idemKey]);
    if (dup.rowCount) return { order: await getOrder(c, dup.rows[0].order_no), duplicate: true };
  }

  // resolve SKUs
  const skus = [...input.items.keys()];
  const found = await c.query(
    `SELECT v.id, v.sku, v.size, v.colour, p.name, p.price_inr, p.active
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.sku = ANY($1::text[])`,
    [skus]
  );
  const known = new Set(found.rows.map((r) => r.sku));
  const unknown = skus.filter((s) => !known.has(s));
  if (unknown.length) throw new ApiError(422, 'UNKNOWN_SKU', `Unknown SKU: ${unknown.join(', ')}`, { skus: unknown });
  const inactive = found.rows.filter((r) => !r.active).map((r) => r.sku);
  if (inactive.length) throw new ApiError(422, 'PRODUCT_INACTIVE', `Not for sale: ${inactive.join(', ')}`, { skus: inactive });

  const lines = found.rows
    .map((r) => ({ ...r, qty: input.items.get(r.sku) }))
    .sort((a, b) => a.id - b.id); // consistent lock order avoids deadlocks

  // reserve stock first: atomic "only if enough is available"
  for (const l of lines) {
    const r = await c.query(
      `UPDATE variants SET reserved = reserved + $1
        WHERE id = $2 AND on_hand - reserved >= $1`,
      [l.qty, l.id]
    );
    if (!r.rowCount) {
      const cur = await c.query('SELECT on_hand - reserved AS available FROM variants WHERE id = $1', [l.id]);
      const available = Math.max(cur.rows[0].available, 0);
      throw new ApiError(
        409,
        'OUT_OF_STOCK',
        available > 0
          ? `Only ${available} left of ${l.name} (${l.sku}), you asked for ${l.qty}`
          : `${l.name} (${l.sku}) is out of stock`,
        { sku: l.sku, product: l.name, size: l.size, colour: l.colour, requested: l.qty, available }
      );
    }
  }

  // customer
  let customerId = null;
  if (input.phone) {
    const cu = await c.query(
      `INSERT INTO customers (name, phone, email, address, pincode, wa_id, tg_chat_id, ig_scoped_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (phone) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, customers.name),
         email = COALESCE(EXCLUDED.email, customers.email),
         address = COALESCE(EXCLUDED.address, customers.address),
         pincode = COALESCE(EXCLUDED.pincode, customers.pincode),
         wa_id = COALESCE(EXCLUDED.wa_id, customers.wa_id),
         tg_chat_id = COALESCE(EXCLUDED.tg_chat_id, customers.tg_chat_id),
         ig_scoped_id = COALESCE(EXCLUDED.ig_scoped_id, customers.ig_scoped_id)
       RETURNING id`,
      [
        input.customer.name,
        input.phone,
        input.customer.email,
        input.address,
        input.pincode,
        input.customer.wa_id,
        input.customer.tg_chat_id,
        input.customer.ig_scoped_id,
      ]
    );
    customerId = cu.rows[0].id;
  }

  // status
  let status = 'NEW';
  let paymentStatus = 'UNPAID';
  let expiresAt = null;
  if (input.walkin) {
    status = 'DELIVERED';
    paymentStatus = 'PAID';
  } else if (input.payMode !== 'COD') {
    status = 'PENDING_PAYMENT';
    expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60000);
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.price_inr * l.qty, 0));

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
    [orderId, status, input.walkin ? 'walk-in sale' : `order placed via ${input.channel}`, actor]
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
    // If order_seq collided with an existing order_no, synchronize sequence past max and retry
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
    // two identical webhook retries racing: the loser returns the winner's order
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
  if (target === 'DELIVERED' && o.payment_mode === 'COD') paymentStatus = 'PAID'; // cash collected
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
    [o.id, o.status, target, text(note, 500), actor]
  );
}

async function lockOrder(c, orderNo) {
  const r = await c.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [String(orderNo).toUpperCase()]);
  if (!r.rowCount) throw notFound(`Order ${orderNo} not found`);
  return r.rows[0];
}

async function changeStatus(orderNo, body, actor = 'api') {
  const target = String((body && body.status) || '').toUpperCase();
  if (!STATUSES.includes(target)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  return tx(async (c) => {
    const o = await lockOrder(c, orderNo);
    await applyStatus(c, o, target, {
      note: body.note,
      actor,
      courier: body.courier,
      awb: body.awb,
      restock: body.restock !== false,
    });
    return getOrder(c, o.order_no);
  });
}

async function markPaid(orderNo, body, actor = 'api') {
  return tx(async (c) => {
    let o = await lockOrder(c, orderNo);
    if (o.payment_status === 'PAID') return getOrder(c, o.order_no); // already done (webhook retry)
    if (['CANCELLED', 'REFUNDED', 'RETURNED'].includes(o.status)) {
      throw new ApiError(
        409,
        'ORDER_CLOSED',
        `${o.order_no} is ${o.status}. Payment arrived for a closed order: refund it or create a new order.`,
        { status: o.status }
      );
    }
    await c.query(
      `UPDATE orders SET payment_status = 'PAID', payment_ref = COALESCE($2, payment_ref), updated_at = now()
        WHERE id = $1`,
      [o.id, text(body && body.payment_ref, 120)]
    );
    o = (await c.query('SELECT * FROM orders WHERE id = $1', [o.id])).rows[0];
    if (o.status === 'NEW' || o.status === 'PENDING_PAYMENT') {
      await applyStatus(c, o, 'CONFIRMED', { note: 'payment received', actor });
    } else {
      await c.query(
        'INSERT INTO order_events (order_id, from_status, to_status, note, actor) VALUES ($1,$2,$2,$3,$4)',
        [o.id, o.status, 'payment received', actor]
      );
    }
    return getOrder(c, o.order_no);
  });
}

// Cancels unpaid orders whose hold ran out and gives the stock back.
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
  track,
  changeStatus,
  markPaid,
  expireReservations,
};
