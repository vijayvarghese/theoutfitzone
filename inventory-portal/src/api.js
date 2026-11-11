/**
 * Store API client for Staff Inventory Portal.
 * Connects exclusively to shop-api (store-api) for all data queries and mutations.
 * NO direct database connections exist in this service.
 * All requests are signed with the internal API token.
 */

const SHOP_API_URL = (process.env.SHOP_API_URL || 'http://shop-api:3000').replace(/\/+$/, '');
const SHOP_API_KEY = process.env.SHOP_API_KEY || process.env.API_KEY || '';

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(endpoint, options = {}) {
  const url = `${SHOP_API_URL}${endpoint}`;
  const headers = {
    'Accept': 'application/json',
    'X-API-Key': SHOP_API_KEY,
    ...(options.headers || {})
  };

  if (options.actor) {
    headers['X-Actor'] = options.actor;
  }

  let body = options.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      body,
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ApiError(504, 'GATEWAY_TIMEOUT', 'The store API did not respond in time (10s timeout).');
    }
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', `Unable to reach store API at ${SHOP_API_URL}: ${err.message}`);
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
    const errMsg = (typeof (data && data.error) === 'string'
      ? data.error
      : (data && data.error && data.error.message)) || `Store API returned HTTP ${res.status}`;
    const errDetails = data && data.error && data.error.details;
    throw new ApiError(res.status, errCode, errMsg, errDetails);
  }

  return data;
}

export const api = {
  // Container & Dependency Health
  async checkHealth() {
    try {
      const res = await fetch(`${SHOP_API_URL}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  // Dashboard & Metrics
  async getDashboardData({ includeOrders = true } = {}) {
    const res = await request(`/api/dashboard?include_orders=${includeOrders ? 'true' : 'false'}`);
    return res;
  },

  // Products & Catalog
  async listStaffProducts(filters = {}) {
    const params = new URLSearchParams();
    params.set('staff', 'true');
    if (filters.q) params.set('q', filters.q);
    if (filters.category && filters.category !== 'all') params.set('category', filters.category);
    if (filters.status && filters.status !== 'all') params.set('status', filters.status);
    if (filters.image && filters.image !== 'all') params.set('image', filters.image);
    if (filters.sort) params.set('sort', filters.sort);

    const res = await request(`/api/products?${params.toString()}`);
    return (res && res.products) || [];
  },

  async getProductCategories() {
    const res = await request('/api/products/categories');
    return (res && res.categories) || [];
  },

  async getProductSummary() {
    const res = await request('/api/products/summary');
    return (res && res.products) || [];
  },

  async getProduct(id) {
    return await request(`/api/products/${encodeURIComponent(id)}`);
  },

  async createProduct(payload, actor) {
    return await request('/api/products', {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async updateProduct(id, payload, actor) {
    return await request(`/api/products/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: payload,
      actor
    });
  },

  async toggleProductStatus(id, actor) {
    return await request(`/api/products/${encodeURIComponent(id)}/toggle-status`, {
      method: 'POST',
      actor
    });
  },

  async updateColorImage(id, payload, actor) {
    return await request(`/api/products/${encodeURIComponent(id)}/color-image`, {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async deleteProduct(id, actor) {
    return await request(`/api/products/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      actor
    });
  },

  // Variants & Stock Matrix
  async getStockMatrix(filters = {}) {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.category && filters.category !== 'all') params.set('category', filters.category);
    if (filters.product_id) params.set('product_id', String(filters.product_id));
    if (filters.stock_status && filters.stock_status !== 'all') params.set('stock_status', filters.stock_status);
    if (filters.size && filters.size !== 'all') params.set('size', filters.size);
    if (filters.sort) params.set('sort', filters.sort);

    return await request(`/api/stock?${params.toString()}`);
  },

  async createVariant(payload, actor) {
    return await request('/api/variants', {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async updateVariant(id, payload, actor) {
    return await request(`/api/variants/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async updateVariantImage(id, payload, actor) {
    return await request(`/api/variants/${encodeURIComponent(id)}/image`, {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async deleteVariant(id, actor) {
    return await request(`/api/variants/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      actor
    });
  },

  async adjustStock(payload, actor) {
    return await request('/api/stock/adjust', {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async bulkAdjustStock(payload, actor) {
    return await request('/api/stock/bulk', {
      method: 'POST',
      body: payload,
      actor
    });
  },

  // Stock Movements Audit
  async getMovements(filters = {}) {
    const params = new URLSearchParams();
    if (filters.sku) params.set('sku', filters.sku);
    if (filters.reason && filters.reason !== 'all') params.set('reason', filters.reason);
    if (filters.direction && filters.direction !== 'all') params.set('direction', filters.direction);
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.offset != null) params.set('offset', String(filters.offset));

    return await request(`/api/movements?${params.toString()}`);
  },

  async exportMovements() {
    const res = await request('/api/movements/export');
    return (res && res.movements) || [];
  },

  // Orders Management
  async listOrders({ status, channel, q, limit = 25, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (channel) params.set('channel', channel);
    if (q) params.set('q', q);
    params.set('limit', String(limit));
    params.set('offset', String(offset));

    return await request(`/api/orders?${params.toString()}`);
  },

  async getOrder(orderNo) {
    const res = await request(`/api/orders/${encodeURIComponent(orderNo)}`);
    return res && res.order;
  },

  async updateOrderStatus(orderNo, payload, actor) {
    const res = await request(`/api/orders/${encodeURIComponent(orderNo)}/status`, {
      method: 'POST',
      body: payload,
      actor
    });
    return res && res.order;
  },

  async markOrderPaid(orderNo, paymentRef, actor) {
    const res = await request(`/api/orders/${encodeURIComponent(orderNo)}/paid`, {
      method: 'POST',
      body: { payment_ref: paymentRef },
      actor
    });
    return res && res.order;
  },

  // Coupons Management
  async listCoupons() {
    return await request('/api/coupons');
  },

  async createCoupon(payload, actor) {
    return await request('/api/coupons', {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async toggleCouponStatus(id, actor) {
    return await request(`/api/coupons/${encodeURIComponent(id)}/toggle-status`, {
      method: 'POST',
      actor
    });
  },

  async extendCoupon(id, payload, actor) {
    return await request(`/api/coupons/${encodeURIComponent(id)}/extend`, {
      method: 'POST',
      body: payload,
      actor
    });
  },

  async updateCoupon(id, payload, actor) {
    return await request(`/api/coupons/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: payload,
      actor
    });
  },

  async deleteCoupon(id, actor) {
    return await request(`/api/coupons/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      actor
    });
  }
};
