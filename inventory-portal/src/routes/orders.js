import express from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { api } from '../api.js';
import { dispatchOrderWebhook } from '../webhook.js';
import { cleanString, cleanIdentifier, cleanInt } from '../sanitize.js';

const router = express.Router();

export const STATUS_LIST = [
  'NEW',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'RETURN_REQUESTED',
  'RETURNED',
  'CANCELLED',
  'REFUNDED'
];

router.use(requireAuth);
router.use(requireRole('owner', 'staff1'));

function buildCustomerWhatsAppUrl(order, storeName) {
  const phone = (order.customer && order.customer.phone) || '';
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  const cleanPhone = digits.length === 10 ? `91${digits}` : digits;

  let msg = '';
  const name = order.customer.name || 'Valued Patron';

  switch (order.status) {
    case 'NEW':
    case 'PENDING_PAYMENT':
      msg = `Hello ${name}! Thank you for your order with ${storeName}. Your Order #${order.order_no} for ₹${Number(order.total).toLocaleString('en-IN')} is awaiting payment confirmation. Please let us know once transferred!`;
      break;
    case 'CONFIRMED':
      msg = `Hello ${name}! We have confirmed your payment for Order #${order.order_no}. Our team has reserved your pieces and is preparing your order for fulfillment.`;
      break;
    case 'PACKED':
      msg = `Hello ${name}! Your Order #${order.order_no} has been hand-inspected, packed in our signature boutique bag, and is waiting for courier dispatch.`;
      break;
    case 'SHIPPED':
      msg = `Hello ${name}! Wonderful news: your Order #${order.order_no} has shipped via ${order.courier || 'Express Courier'}${order.awb ? ` (AWB Tracking: ${order.awb})` : ''}.`;
      break;
    case 'DELIVERED':
      msg = `Hello ${name}! Your Order #${order.order_no} has been delivered. We hope you love your handcrafted piece!`;
      break;
    default:
      msg = `Hello ${name}! We are contacting you from ${storeName} regarding Order #${order.order_no}. How can we assist you today?`;
  }

  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
}

/**
 * GET /orders
 */
router.get('/', async (req, res, next) => {
  try {
    const status = cleanString(req.query.status, { toUpper: true });
    const q = cleanString(req.query.q);
    const page = cleanInt(req.query.page, 1, 100000, 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const result = await api.listOrders({ status, q, limit, offset });
    const totalCount = result.totalCount || 0;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('orders/index', {
      title: 'Customer Orders Fulfillment Queue',
      orders: result.orders || [],
      totalCount,
      statusList: STATUS_LIST,
      status,
      q,
      page,
      totalPages,
      limit
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /orders/:orderNo
 */
router.get('/:orderNo', async (req, res, next) => {
  try {
    const orderNo = cleanIdentifier(req.params.orderNo, '-');
    const order = await api.getOrder(orderNo);

    if (!order) {
      return res.status(404).render('error', {
        title: 'Order Not Found',
        message: `Order #${orderNo} was not found.`
      });
    }

    const whatsAppUrl = buildCustomerWhatsAppUrl(order, res.locals.storeName);

    res.render('orders/detail', {
      title: `Order #${order.order_no}`,
      order,
      whatsAppUrl
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /orders/:orderNo/status
 */
router.post('/:orderNo/status', async (req, res) => {
  const orderNo = cleanIdentifier(req.params.orderNo, '-');
  const status = cleanString(req.body.status, { toUpper: true });
  const courier = cleanString(req.body.courier, { maxLength: 80 });
  const awb = cleanString(req.body.awb, { maxLength: 80 });
  const note = cleanString(req.body.note, { maxLength: 500 });
  const restock = req.body.restock !== 'false';
  const actor = req.user ? `${req.user.name} [${req.user.role}]` : 'Staff';

  try {
    const prevOrder = await api.getOrder(orderNo);

    await api.updateOrderStatus(orderNo, {
      status,
      courier: courier || undefined,
      awb: awb || undefined,
      note: note || undefined,
      restock
    }, actor);

    const updatedOrder = await api.getOrder(orderNo);
    if (updatedOrder) {
      dispatchOrderWebhook({
        event: status === 'CANCELLED' ? 'order.cancelled' : 'order.status_updated',
        source: 'inventory-portal',
        actor,
        order: updatedOrder,
        previousStatus: prevOrder?.status
      }).catch((err) => console.error('[webhook dispatch error]', err));
    }

    res.redirect(`/orders/${encodeURIComponent(orderNo)}?flash=${encodeURIComponent(`Order #${orderNo} transitioned to ${status}.`)}`);
  } catch (err) {
    res.redirect(`/orders/${encodeURIComponent(orderNo)}?error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * POST /orders/:orderNo/paid
 */
router.post('/:orderNo/paid', async (req, res) => {
  const orderNo = cleanIdentifier(req.params.orderNo, '-');
  const payment_ref = cleanString(req.body.payment_ref, { maxLength: 120 }) || 'Verified by staff';
  const actor = req.user ? `${req.user.name} [${req.user.role}]` : 'Staff';

  try {
    const prevOrder = await api.getOrder(orderNo);

    await api.markOrderPaid(orderNo, payment_ref, actor);

    const updatedOrder = await api.getOrder(orderNo);
    if (updatedOrder) {
      dispatchOrderWebhook({
        event: 'order.paid',
        source: 'inventory-portal',
        actor,
        order: updatedOrder,
        previousStatus: prevOrder?.status
      }).catch((err) => console.error('[webhook dispatch error]', err));
    }

    res.redirect(`/orders/${encodeURIComponent(orderNo)}?flash=${encodeURIComponent(`Payment marked PAID for Order #${orderNo}.`)}`);
  } catch (err) {
    res.redirect(`/orders/${encodeURIComponent(orderNo)}?error=${encodeURIComponent(err.message)}`);
  }
});

export default router;
