/**
 * Internal API client for shop-api.
 * Executes server-to-server requests with strict 5-second timeouts,
 * error mapping, and API key management.
 * The API key is NEVER sent to or accessible by client browsers.
 */
const config = require('./config');

class ShopApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ShopApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(endpoint, options = {}) {
  const url = `${config.shopApiUrl}${endpoint}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  if (options.requireKey) {
    headers['X-API-Key'] = config.shopApiKey;
    headers['X-Actor'] = options.actor || 'web-app';
  }

  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ShopApiError(504, 'GATEWAY_TIMEOUT', 'The inventory service did not respond in time (5s timeout).');
    }
    throw new ShopApiError(503, 'SERVICE_UNAVAILABLE', `Unable to reach inventory service: ${err.message}`);
  }

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const errCode = (data && data.error && data.error.code) || 'API_ERROR';
    const errMsg = (typeof (data && data.error) === 'string' ? data.error : (data && data.error && data.error.message)) || `Inventory API returned HTTP ${res.status}`;
    const errDetails = data && data.error && data.error.details;
    throw new ShopApiError(res.status, errCode, errMsg, errDetails);
  }

  return data;
}

module.exports = {
  ShopApiError,

  // Public (No Key required)
  async getProducts({ category, q, admin = false } = {}) {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    const queryStr = params.toString() ? `?${params.toString()}` : '';
    const res = await request(`/api/products${queryStr}`, {
      method: 'GET',
      requireKey: admin
    });
    return (res && res.products) || [];
  },

  async getStock(sku, admin = false) {
    return await request(`/api/stock/${encodeURIComponent(sku)}`, {
      method: 'GET',
      requireKey: admin
    });
  },

  async trackOrder(orderNo, phone4) {
    const params = new URLSearchParams({ phone4 });
    return await request(`/api/track/${encodeURIComponent(orderNo)}?${params.toString()}`, {
      method: 'GET',
      requireKey: false
    });
  },

  async validateCoupon(code, subtotal) {
    const params = new URLSearchParams({ code: String(code || ''), subtotal: String(subtotal || '0') });
    return await request(`/api/coupons/validate?${params.toString()}`, {
      method: 'GET',
      requireKey: false
    });
  },

  // Private Admin & Order Writes (X-API-Key required)
  async createOrder(orderPayload) {
    return await request('/api/orders', {
      method: 'POST',
      requireKey: true,
      body: orderPayload,
      actor: 'web-storefront'
    });
  },

  async listOrders({ status, channel, q, limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (channel) params.set('channel', channel);
    if (q) params.set('q', q);
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    const res = await request(`/api/orders?${params.toString()}`, {
      method: 'GET',
      requireKey: true
    });
    return (res && res.orders) || [];
  },

  async getOrder(orderNo) {
    const res = await request(`/api/orders/${encodeURIComponent(orderNo)}`, {
      method: 'GET',
      requireKey: true
    });
    return res && res.order;
  },

  async updateOrderStatus(orderNo, { status, courier, awb, note, restock }) {
    return await request(`/api/orders/${encodeURIComponent(orderNo)}/status`, {
      method: 'POST',
      requireKey: true,
      body: { status, courier, awb, note, restock },
      actor: 'web-admin'
    });
  },

  async markOrderPaid(orderNo, paymentRef) {
    return await request(`/api/orders/${encodeURIComponent(orderNo)}/paid`, {
      method: 'POST',
      requireKey: true,
      body: { payment_ref: paymentRef },
      actor: 'web-admin'
    });
  },

  async adjustStock({ sku, delta, reason }) {
    return await request('/api/stock/adjust', {
      method: 'POST',
      requireKey: true,
      body: { sku, delta, reason }
    });
  },

  async getLowStock() {
    const res = await request('/api/low-stock', {
      method: 'GET',
      requireKey: true
    });
    return (res && res.items) || [];
  }
};
