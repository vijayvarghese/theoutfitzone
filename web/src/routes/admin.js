/**
 * Administrator portal routes.
 * Secure back-office operations for order fulfillment, status progression,
 * payment verification, customer WhatsApp messaging, and stock adjustments.
 */
const express = require('express');
const api = require('../api');
const config = require('../config');
const {
  constantTimeCompare,
  checkRateLimit,
  maskPhone,
  cleanString,
  cleanIdentifier,
  cleanInt,
  cleanBool
} = require('../security');
const { dispatchOrderWebhook } = require('../webhook');

const router = express.Router();

// Always send X-Robots-Tag: noindex on all admin pages
router.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect('/admin/login');
}

/**
 * 1. Admin Authentication
 */
router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin/orders');
  }
  res.render('admin/login', {
    title: 'Staff Login | Atelier Back-Office',
    error: null,
    config
  });
});

router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  if (!checkRateLimit(`admin-login:${ip}`, 5, 900000)) {
    return res.status(429).render('admin/login', {
      title: 'Staff Login | Atelier Back-Office',
      error: 'Too many failed login attempts. Please wait 15 minutes before retrying.',
      config
    });
  }

  const submittedPass = String(req.body.password || '');
  if (constantTimeCompare(submittedPass, config.adminPassword)) {
    req.session.isAdmin = true;
    return res.redirect('/admin/orders');
  }

  res.status(401).render('admin/login', {
    title: 'Staff Login | Atelier Back-Office',
    error: 'Invalid administrator password.',
    config
  });
});

router.post('/logout', (req, res) => {
  if (req.session) {
    req.session.isAdmin = false;
  }
  res.redirect('/admin/login');
});

// All subsequent routes require valid administrator session
router.use(requireAdmin);

/**
 * Redirect /admin to /admin/orders
 */
router.get('/', (req, res) => {
  res.redirect('/admin/orders');
});

/**
 * 2. Orders Listing (/admin/orders)
 */
router.get('/orders', async (req, res, next) => {
  try {
    const status = cleanString(req.query.status, { toUpper: true });
    const q = cleanString(req.query.q);
    const page = cleanInt(req.query.page, 1, 100000, 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const orders = await api.listOrders({ status, q, limit, offset });

    res.render('admin/orders', {
      title: 'Orders Management | Atelier Admin',
      orders,
      status,
      q,
      page,
      limit,
      flashNotice: req.session.adminNotice || null,
      flashError: req.session.adminError || null,
      config
    });
    delete req.session.adminNotice;
    delete req.session.adminError;
  } catch (err) {
    next(err);
  }
});

const LEGAL_TRANSITIONS = {
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

/**
 * WhatsApp message generator helper for boutique managers
 */
function buildCustomerWhatsAppUrl(order) {
  const phone = (order.customer && order.customer.phone) || '';
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  const cleanPhone = digits.length === 10 ? `91${digits}` : digits;

  let msg = '';
  const name = order.customer.name || 'Valued Patron';

  switch (order.status) {
    case 'NEW':
    case 'PENDING_PAYMENT':
      msg = `Hello ${name}! Thank you for your order with ${config.storeName}. Your Order #${order.order_no} for ₹${Number(order.total).toFixed(2)} is awaiting payment confirmation. You can complete payment via UPI to ${config.upiVpa}. Please let us know once transferred!`;
      break;
    case 'CONFIRMED':
      msg = `Hello ${name}! We have confirmed your payment for Order #${order.order_no}. Our atelier team has reserved your pieces and is preparing your order for tailoring and inspection.`;
      break;
    case 'PACKED':
      msg = `Hello ${name}! Your Order #${order.order_no} has been hand-inspected, packed in our signature cloth bag, and is waiting for courier handover.`;
      break;
    case 'SHIPPED':
      msg = `Hello ${name}! Wonderful news: your Order #${order.order_no} has shipped via ${order.courier || 'Express Courier'}${order.awb ? ` (Tracking AWB: ${order.awb})` : ''}. You can track delivery anytime at ${config.siteUrl}/track`;
      break;
    case 'DELIVERED':
      msg = `Hello ${name}! Your Order #${order.order_no} has been delivered. We hope you cherish wearing your handcrafted silhouette. If you have any feedback or fit queries, we are always here.`;
      break;
    default:
      msg = `Hello ${name}! We are contacting you from ${config.storeName} regarding your Order #${order.order_no}. How can we assist you today?`;
  }

  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
}

/**
 * 3. Order Detail (/admin/orders/:orderNo)
 */
router.get('/orders/:orderNo', async (req, res, next) => {
  try {
    const orderNo = req.params.orderNo.toUpperCase();
    const order = await api.getOrder(orderNo);

    if (!order) {
      req.session.adminError = `Order ${orderNo} not found.`;
      return res.redirect('/admin/orders');
    }

    const allowedTransitions = LEGAL_TRANSITIONS[order.status] || [];
    const canMarkPaid = order.payment_status !== 'PAID' && !['CANCELLED', 'REFUNDED', 'RETURNED'].includes(order.status);
    const customerWhatsAppUrl = buildCustomerWhatsAppUrl(order);

    res.render('admin/order-detail', {
      title: `Order #${order.order_no} | Admin`,
      order,
      allowedTransitions,
      canMarkPaid,
      customerWhatsAppUrl,
      flashNotice: req.session.adminNotice || null,
      flashError: req.session.adminError || null,
      config
    });
    delete req.session.adminNotice;
    delete req.session.adminError;
  } catch (err) {
    next(err);
  }
});

/**
 * 4. Status Transition Action
 */
router.post('/orders/:orderNo/status', async (req, res) => {
  const orderNo = cleanIdentifier(req.params.orderNo, '-');
  const status = cleanString(req.body.status, { toUpper: true });
  const courier = cleanString(req.body.courier, { maxLength: 80 });
  const awb = cleanString(req.body.awb, { maxLength: 80 });
  const note = cleanString(req.body.note, { maxLength: 500 });
  const restock = cleanBool(req.body.restock !== 'false');

  try {
    const prevOrder = await api.getOrder(orderNo);
    await api.updateOrderStatus(orderNo, {
      status,
      courier: courier || undefined,
      awb: awb || undefined,
      note: note || undefined,
      restock
    });

    const updatedOrder = await api.getOrder(orderNo);

    // Asynchronously dispatch webhook to n8n
    dispatchOrderWebhook({
      event: status === 'CANCELLED' ? 'order.cancelled' : 'order.status_updated',
      source: 'website-admin',
      actor: 'Store Admin',
      order: updatedOrder || prevOrder,
      previousStatus: prevOrder ? prevOrder.status : null
    }).catch((e) => console.error('[webhook] Error dispatching status update to n8n:', e.message));

    req.session.adminNotice = `Order #${orderNo} moved to ${status}.`;
  } catch (err) {
    if (err.status === 409 && err.details?.allowed) {
      req.session.adminError = `Cannot transition to ${status}. Allowed: ${err.details.allowed.join(', ') || 'None'}`;
    } else {
      req.session.adminError = `Status change failed: ${err.message}`;
    }
  }

  res.redirect(`/admin/orders/${encodeURIComponent(orderNo)}`);
});

/**
 * 5. Mark Paid Action
 */
router.post('/orders/:orderNo/paid', async (req, res) => {
  const orderNo = cleanIdentifier(req.params.orderNo, '-');
  const payment_ref = cleanString(req.body.payment_ref, { maxLength: 120 });

  try {
    const prevOrder = await api.getOrder(orderNo);
    await api.markOrderPaid(orderNo, payment_ref || 'Manual Verification');
    const updatedOrder = await api.getOrder(orderNo);

    // Asynchronously dispatch webhook to n8n
    dispatchOrderWebhook({
      event: 'order.paid',
      source: 'website-admin',
      actor: 'Store Admin',
      order: updatedOrder || prevOrder,
      previousStatus: prevOrder ? prevOrder.status : null
    }).catch((e) => console.error('[webhook] Error dispatching paid event to n8n:', e.message));

    req.session.adminNotice = `Payment marked PAID for Order #${orderNo}.`;
  } catch (err) {
    req.session.adminError = `Mark paid failed: ${err.message}`;
  }

  res.redirect(`/admin/orders/${encodeURIComponent(orderNo)}`);
});

/**
 * 6. Stock & Inventory Management (/admin/stock)
 */
router.get('/stock', async (req, res, next) => {
  try {
    const products = await api.getProducts({ admin: true });
    const lowStockItems = await api.getLowStock();

    res.render('admin/stock', {
      title: 'Inventory & Stock Control | Admin',
      products,
      lowStockItems,
      flashNotice: req.session.adminNotice || null,
      flashError: req.session.adminError || null,
      config
    });
    delete req.session.adminNotice;
    delete req.session.adminError;
  } catch (err) {
    next(err);
  }
});

/**
 * 7. Stock Adjustment Action
 */
router.post('/stock/adjust', async (req, res) => {
  const sku = cleanIdentifier(req.body.sku, '-_');
  const numDelta = cleanInt(req.body.delta, -100000, 100000, 0);
  const reason = cleanString(req.body.reason, { maxLength: 100 });

  if (!sku || numDelta === 0 || !reason) {
    req.session.adminError = 'SKU, non-zero integer adjustment, and audit reason are required.';
    return res.redirect('/admin/stock');
  }

  try {
    const result = await api.adjustStock({
      sku,
      delta: numDelta,
      reason
    });
    req.session.adminNotice = `Stock adjusted for ${result.sku}: on hand now ${result.on_hand}, available ${result.available}.`;
  } catch (err) {
    if (err.status === 409 && err.code === 'BELOW_RESERVED') {
      req.session.adminError = `Adjustment rejected: ${err.message}`;
    } else {
      req.session.adminError = `Adjust failed: ${err.message}`;
    }
  }

  res.redirect('/admin/stock');
});

module.exports = router;
