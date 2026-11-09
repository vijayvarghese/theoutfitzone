/**
 * Webhook Dispatcher for n8n Automation Workflows (Inventory Portal).
 * Sends structured, unified order event payloads whenever an order is
 * updated, transitioned, paid, or cancelled.
 */

function buildCustomerMessage(order, storeName, siteUrl) {
  const name = (order.customer && order.customer.name) || order.customer_name || 'Valued Patron';
  const total = Number(order.total || 0).toLocaleString('en-IN');
  const orderNo = order.order_no;
  const digits = String((order.customer && order.customer.phone) || order.customer_phone || '').replace(/\D/g, '');
  const last4 = digits.slice(-4);
  const trackUrl = `${siteUrl}/track?order=${encodeURIComponent(orderNo)}&phone4=${encodeURIComponent(last4)}`;

  switch (order.status) {
    case 'NEW':
    case 'PENDING_PAYMENT':
      if (order.payment_mode === 'COD') {
        return `Hello ${name}! Thank you for placing Cash on Delivery Order #${orderNo} with ${storeName} for ₹${total}. We will verify your delivery details shortly before dispatch.`;
      }
      return `Hello ${name}! Thank you for your order with ${storeName}. Your Order #${orderNo} for ₹${total} is awaiting payment confirmation. Please let us know once transferred!`;
    case 'CONFIRMED':
      return `Hello ${name}! We have confirmed your payment for Order #${orderNo}. Our team has reserved your pieces and is preparing your order for fulfillment.`;
    case 'PACKED':
      return `Hello ${name}! Your Order #${orderNo} has been hand-inspected, packed in our signature boutique bag, and is waiting for courier handover.`;
    case 'SHIPPED':
      return `Hello ${name}! Wonderful news: your Order #${orderNo} has shipped via ${order.courier || 'Express Courier'}${order.awb ? ` (AWB Tracking: ${order.awb})` : ''}. Track delivery anytime: ${trackUrl}`;
    case 'DELIVERED':
      return `Hello ${name}! Your Order #${orderNo} has been delivered. We hope you love your handcrafted piece!`;
    case 'CANCELLED':
      return `Hello ${name}! Your Order #${orderNo} has been cancelled. Please let us know if you need any assistance or would like to re-order.`;
    case 'RETURN_REQUESTED':
      return `Hello ${name}! We have received your return request for Order #${orderNo}. Our team is reviewing the details and will update you shortly.`;
    case 'RETURNED':
      return `Hello ${name}! Your returned pieces for Order #${orderNo} have been received and inspected at our atelier.`;
    case 'REFUNDED':
      return `Hello ${name}! A refund of ₹${total} has been processed for Order #${orderNo}.`;
    default:
      return `Hello ${name}! Order #${orderNo} status is currently ${order.status}. Track progress: ${trackUrl}`;
  }
}

function normalizeWhatsAppNumber(rawPhone) {
  if (!rawPhone) return '';
  const digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

export function formatPayload({ event, source, actor, order, previousStatus }) {
  const storeName = process.env.STORE_NAME || 'The OutFit Zone';
  const siteUrl = (process.env.SITE_URL || 'http://localhost:8081').replace(/\/+$/, '');
  const rawPhone = (order.customer && order.customer.phone) || order.customer_phone || '';
  const digits = String(rawPhone).replace(/\D/g, '');
  const whatsappNumber = normalizeWhatsAppNumber(rawPhone);
  const formattedPhone = digits.length === 10 ? `+91 ${digits}` : (digits ? `+${digits}` : '');
  const last4 = digits.slice(-4);
  const trackingUrl = `${siteUrl}/track?order=${encodeURIComponent(order.order_no)}&phone4=${encodeURIComponent(last4)}`;
  const whatsappMessage = buildCustomerMessage(order, storeName, siteUrl);
  const whatsappUrl = whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappMessage)}` : '';

  return {
    event: event || 'order.updated',
    timestamp: new Date().toISOString(),
    source: source || 'inventory-portal',
    actor: actor || 'staff',
    previous_status: previousStatus || null,
    order: {
      order_no: order.order_no,
      status: order.status,
      channel: order.channel || 'web',
      payment_mode: order.payment_mode || 'COD',
      payment_status: order.payment_status || 'UNPAID',
      payment_ref: order.payment_ref || null,
      total: Number(order.total || 0),
      subtotal: Number(order.subtotal || 0),
      shipping: Number(order.shipping || 0),
      currency: 'INR',
      total_formatted: '₹' + Number(order.total || 0).toLocaleString('en-IN'),
      courier: order.courier || null,
      awb: order.awb || null,
      notes: order.notes || null,
      expires_at: order.expires_at || null,
      customer: {
        name: (order.customer && order.customer.name) || order.customer_name || 'Valued Patron',
        phone: rawPhone,
        email: (order.customer && order.customer.email) || order.customer_email || '',
        formatted_phone: formattedPhone,
        whatsapp_number: whatsappNumber
      },
      shipping_address: {
        address: order.ship_address || order.customer_address || '',
        pincode: order.ship_pincode || order.customer_pincode || ''
      },
      items: (order.items || []).map((it) => ({
        sku: it.sku,
        product: it.product || it.name || it.product_name || '',
        size: it.size || '',
        colour: it.colour || '',
        qty: parseInt(it.qty, 10) || 1,
        unit_price: Number(it.unit_price || 0),
        line_total: Number(it.line_total || (it.unit_price * it.qty) || 0)
      })),
      tracking_url: trackingUrl,
      whatsapp_message: whatsappMessage,
      whatsapp_url: whatsappUrl,
      created_at: order.created_at || new Date().toISOString(),
      updated_at: order.updated_at || new Date().toISOString()
    }
  };
}

export async function dispatchOrderWebhook(options) {
  const webhookUrl = process.env.N8N_ORDER_WEBHOOK_URL || process.env.ORDER_WEBHOOK_URL || '';
  if (!webhookUrl || !webhookUrl.trim()) {
    return { skipped: true, reason: 'N8N_ORDER_WEBHOOK_URL not configured' };
  }

  const payload = formatPayload(options);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TheOutFitZone-InventoryPortal-Webhook/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[webhook] n8n returned HTTP ${res.status} for ${options.event} (Order #${options.order?.order_no})`);
      return { success: false, status: res.status };
    }

    console.log(`[webhook] Delivered ${options.event} for Order #${options.order?.order_no} to n8n successfully.`);
    return { success: true };
  } catch (err) {
    console.error(`[webhook] Failed to dispatch ${options.event} to n8n:`, err.message);
    return { success: false, error: err.message };
  }
}
