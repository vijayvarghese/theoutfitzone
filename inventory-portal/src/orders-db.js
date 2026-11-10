import { pool, getClient } from './db.js';

// Status Transition State Machine
export const TRANSITIONS = {
  NEW: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED'],
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'],
  RETURNED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: []
};

export const STATUS_LIST = Object.keys(TRANSITIONS);

/**
 * Execute a callback within an isolated Postgres transaction
 */
export async function tx(callback) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Sets session configuration variables read by PostgreSQL stock audit triggers
 */
export async function setStockReason(client, reason, ref = '') {
  await client.query(
    "SELECT set_config('shop.reason', $1, true), set_config('shop.ref', $2, true)",
    [reason, ref]
  );
}

/**
 * List orders with search, status filters, and pagination
 */
export async function listOrders({ status, channel, q, limit = 25, offset = 0 } = {}) {
  const where = [];
  const args = [];

  if (status) {
    const s = String(status).toUpperCase();
    if (STATUS_LIST.includes(s)) {
      where.push(`o.status = $${args.push(s)}`);
    }
  }

  if (channel) {
    where.push(`o.channel = $${args.push(String(channel).toLowerCase())}`);
  }

  if (q) {
    const term = `%${String(q).trim()}%`;
    const n = args.push(term);
    where.push(`(o.order_no ILIKE $${n} OR c.phone LIKE $${n} OR c.name ILIKE $${n} OR c.email ILIKE $${n} OR o.awb ILIKE $${n})`);
  }

  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  args.push(lim, off);

  const queryText = `
    SELECT o.id, o.order_no, o.status, o.channel, o.payment_mode, o.payment_status,
           o.payment_ref, o.subtotal, o.shipping, o.discount, o.total, o.coupon_code, o.courier, o.awb,
           o.created_at, o.updated_at,
           c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
           (SELECT COALESCE(SUM(qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS items_count
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}
  `;

  const { rows } = await pool.query(queryText, args);

  // Get total count for pagination
  const countQuery = `
    SELECT COUNT(*) AS total
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  `;
  const countRes = await pool.query(countQuery, args.slice(0, args.length - 2));
  const totalCount = parseInt(countRes.rows[0]?.total || 0, 10);

  return {
    orders: rows,
    totalCount,
    limit: lim,
    offset: off
  };
}

/**
 * Retrieve complete order details including customer, items, and audit timeline
 */
export async function getOrder(orderNo) {
  const o = await pool.query(
    `SELECT o.*,
            c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
            c.address AS customer_address, c.pincode AS customer_pincode,
            c.wa_id, c.tg_chat_id, c.ig_scoped_id
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.order_no = $1`,
    [String(orderNo).toUpperCase().trim()]
  );

  if (!o.rowCount) return null;
  const r = o.rows[0];

  const items = await pool.query(
    `SELECT oi.id, oi.variant_id, oi.qty, oi.unit_price,
            (oi.qty * oi.unit_price) AS line_total,
            v.sku, v.size, v.colour,
            p.name AS product_name, p.image_url
       FROM order_items oi
       JOIN variants v ON v.id = oi.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id`,
    [r.id]
  );

  const events = await pool.query(
    `SELECT id, from_status, to_status, note, actor, at
       FROM order_events
      WHERE order_id = $1
      ORDER BY id ASC`,
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
      wa_id: r.wa_id,
      tg_chat_id: r.tg_chat_id,
      ig_scoped_id: r.ig_scoped_id
    },
    items: items.rows.map(it => ({
      ...it,
      unit_price: Number(it.unit_price),
      line_total: Number(it.line_total)
    })),
    events: events.rows,
    allowedTransitions: TRANSITIONS[r.status] || [],
    canMarkPaid: r.payment_status !== 'PAID' && !['CANCELLED', 'REFUNDED', 'RETURNED'].includes(r.status)
  };
}

/**
 * Update order status with atomic stock reservation/commit/restock
 */
export async function updateOrderStatus(orderNo, { status, courier, awb, note, restock = true }, actor = 'staff') {
  const target = String(status || '').toUpperCase().trim();
  if (!STATUS_LIST.includes(target)) {
    throw new Error(`Invalid status: ${target}. Allowed: ${STATUS_LIST.join(', ')}`);
  }

  return tx(async (client) => {
    // Lock order row
    const lockRes = await client.query(
      `SELECT * FROM orders WHERE order_no = $1 FOR UPDATE`,
      [String(orderNo).toUpperCase().trim()]
    );
    if (!lockRes.rowCount) {
      throw new Error(`Order #${orderNo} not found.`);
    }
    const order = lockRes.rows[0];

    const allowed = TRANSITIONS[order.status] || [];
    if (!allowed.includes(target)) {
      throw new Error(`Cannot transition Order #${order.order_no} from ${order.status} to ${target}. Allowed moves: ${allowed.join(', ') || 'None'}`);
    }

    // Fetch line items for inventory adjustment
    const itemsRes = await client.query(
      `SELECT variant_id, qty FROM order_items WHERE order_id = $1 ORDER BY variant_id`,
      [order.id]
    );
    const items = itemsRes.rows;

    // Stock state transitions
    if (target === 'PACKED') {
      // Order packed: commit stock from on_hand & reserved
      await setStockReason(client, 'order_packed', order.order_no);
      for (const it of items) {
        const upd = await client.query(
          `UPDATE variants
              SET on_hand = on_hand - $1,
                  reserved = reserved - $1
            WHERE id = $2 AND on_hand >= $1 AND reserved >= $1`,
          [it.qty, it.variant_id]
        );
        if (!upd.rowCount) {
          throw new Error(`Variant ID ${it.variant_id} does not have sufficient on_hand or reserved quantity to pack.`);
        }
      }
    } else if (target === 'CANCELLED') {
      // If was packed, stock was already deducted from on_hand; restock it back
      if (order.status === 'PACKED') {
        await setStockReason(client, 'cancel_restock', order.order_no);
        for (const it of items) {
          await client.query(
            `UPDATE variants SET on_hand = on_hand + $1 WHERE id = $2`,
            [it.qty, it.variant_id]
          );
        }
      } else {
        // Was held in reservation: release reservation
        for (const it of items) {
          await client.query(
            `UPDATE variants SET reserved = GREATEST(0, reserved - $1) WHERE id = $2`,
            [it.qty, it.variant_id]
          );
        }
      }
    } else if (target === 'RETURNED' && restock) {
      // Returned item accepted back into inventory
      await setStockReason(client, 'return_restock', order.order_no);
      for (const it of items) {
        await client.query(
          `UPDATE variants SET on_hand = on_hand + $1 WHERE id = $2`,
          [it.qty, it.variant_id]
        );
      }
    }

    let paymentStatus = order.payment_status;
    if (target === 'DELIVERED' && order.payment_mode === 'COD') {
      paymentStatus = 'PAID'; // Cash collected on delivery
    } else if (target === 'REFUNDED') {
      paymentStatus = 'REFUNDED';
    }

    // Update order header
    await client.query(
      `UPDATE orders
          SET status = $2,
              payment_status = $3,
              courier = COALESCE($4, courier),
              awb = COALESCE($5, awb),
              expires_at = CASE WHEN $2 = 'PENDING_PAYMENT' THEN expires_at ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [
        order.id,
        target,
        paymentStatus,
        courier ? String(courier).trim() : null,
        awb ? String(awb).trim() : null
      ]
    );

    // Record audit event
    await client.query(
      `INSERT INTO order_events (order_id, from_status, to_status, note, actor)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        order.id,
        order.status,
        target,
        note ? String(note).trim() : null,
        actor
      ]
    );

    return { orderNo: order.order_no, status: target };
  });
}

/**
 * Mark order payment received
 */
export async function markOrderPaid(orderNo, paymentRef = '', actor = 'staff') {
  return tx(async (client) => {
    const lockRes = await client.query(
      `SELECT * FROM orders WHERE order_no = $1 FOR UPDATE`,
      [String(orderNo).toUpperCase().trim()]
    );
    if (!lockRes.rowCount) {
      throw new Error(`Order #${orderNo} not found.`);
    }
    const order = lockRes.rows[0];

    if (order.payment_status === 'PAID') {
      return { orderNo: order.order_no, alreadyPaid: true };
    }

    if (['CANCELLED', 'REFUNDED', 'RETURNED'].includes(order.status)) {
      throw new Error(`Order #${order.order_no} is ${order.status}; cannot accept payment on closed order.`);
    }

    const ref = paymentRef ? String(paymentRef).trim() : 'Verified by staff';
    await client.query(
      `UPDATE orders
          SET payment_status = 'PAID',
              payment_ref = $2,
              updated_at = now()
        WHERE id = $1`,
      [order.id, ref]
    );

    // If order was NEW or PENDING_PAYMENT, automatically confirm it
    if (order.status === 'NEW' || order.status === 'PENDING_PAYMENT') {
      await client.query(
        `UPDATE orders SET status = 'CONFIRMED', expires_at = NULL, updated_at = now() WHERE id = $1`,
        [order.id]
      );
      await client.query(
        `INSERT INTO order_events (order_id, from_status, to_status, note, actor)
         VALUES ($1, $2, 'CONFIRMED', $3, $4)`,
        [order.id, order.status, `Payment confirmed (Ref: ${ref})`, actor]
      );
    } else {
      await client.query(
        `INSERT INTO order_events (order_id, from_status, to_status, note, actor)
         VALUES ($1, $2, $2, $3, $4)`,
        [order.id, order.status, `Payment verified (Ref: ${ref})`, actor]
      );
    }

    return { orderNo: order.order_no, paymentStatus: 'PAID' };
  });
}

/**
 * Dashboard metrics for back-office overview
 */
export async function getOrderMetrics() {
  const statusRes = await pool.query(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS revenue
      FROM orders
     GROUP BY status
  `);

  const summary = {
    totalOrders: 0,
    totalRevenue: 0,
    byStatus: {}
  };

  for (const row of statusRes.rows) {
    const cnt = parseInt(row.count, 10);
    const rev = parseFloat(row.revenue);
    summary.totalOrders += cnt;
    summary.totalRevenue += rev;
    summary.byStatus[row.status] = { count: cnt, revenue: rev };
  }

  // Pending action counts
  summary.pendingPayment = (summary.byStatus['PENDING_PAYMENT']?.count || 0) + (summary.byStatus['NEW']?.count || 0);
  summary.toPack = summary.byStatus['CONFIRMED']?.count || 0;
  summary.toShip = summary.byStatus['PACKED']?.count || 0;
  summary.inTransit = summary.byStatus['SHIPPED']?.count || 0;
  summary.delivered = summary.byStatus['DELIVERED']?.count || 0;

  return summary;
}
