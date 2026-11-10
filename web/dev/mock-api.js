/**
 * Standalone mock of shop-api for local development, testing, and CI.
 * Implements the complete shop-api contract, error schemas, state transitions,
 * and stock management rules. Excluded from production Docker images.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || 'test-secret-key-16-chars-min';

// In-memory data store with 8 realistic products for an independent dress store
const PRODUCTS = [
  {
    id: 1,
    name: "Kora Handloom Tiered Midi Dress",
    category: "Midi Dresses",
    price_inr: 4250,
    description: "Crafted from unbleached Kora organic handspun cotton with delicate pintuck bodice detailing, side inseam pockets, and mother-of-pearl closures. A relaxed, breezy silhouette cut for effortless warm-weather elegance.",
    image_url: "/products/kora-tiered-midi.jpg",
    active: true,
    variants: [
      { sku: "KOR-IVR-XS", size: "XS", colour: "Ivory White", on_hand: 5, reserved: 0, reorder_level: 2 },
      { sku: "KOR-IVR-S",  size: "S",  colour: "Ivory White", on_hand: 8, reserved: 1, reorder_level: 2 },
      { sku: "KOR-IVR-M",  size: "M",  colour: "Ivory White", on_hand: 6, reserved: 0, reorder_level: 2 },
      { sku: "KOR-IVR-L",  size: "L",  colour: "Ivory White", on_hand: 4, reserved: 0, reorder_level: 1 },
      { sku: "KOR-IND-M",  size: "M",  colour: "Natural Indigo", on_hand: 3, reserved: 0, reorder_level: 2 },
      { sku: "KOR-IND-L",  size: "L",  colour: "Natural Indigo", on_hand: 1, reserved: 0, reorder_level: 1 }
    ]
  },
  {
    id: 2,
    name: "Maheshwari Silk-Cotton Overlay Dress",
    category: "Maxi Gowns",
    price_inr: 5800,
    description: "Woven in historical Maheshwar with a tissue zari border and sheer silk-cotton body. Comes with a separate breathable modal slip. Floor-skimming length with soft gather pleats at the waist.",
    image_url: "/products/maheshwari-silk-overlay.jpg",
    active: true,
    variants: [
      { sku: "MAH-OXB-S", size: "S", colour: "Deep Oxblood", on_hand: 4, reserved: 0, reorder_level: 2 },
      { sku: "MAH-OXB-M", size: "M", colour: "Deep Oxblood", on_hand: 2, reserved: 0, reorder_level: 2 },
      { sku: "MAH-OXB-L", size: "L", colour: "Deep Oxblood", on_hand: 0, reserved: 0, reorder_level: 1 },
      { sku: "MAH-EMR-S", size: "S", colour: "Emerald Green", on_hand: 3, reserved: 0, reorder_level: 1 },
      { sku: "MAH-EMR-M", size: "M", colour: "Emerald Green", on_hand: 5, reserved: 1, reorder_level: 2 }
    ]
  },
  {
    id: 3,
    name: "Chanderi Floral Angrakha Wrap Dress",
    category: "Midi Dresses",
    price_inr: 4950,
    description: "Classic asymmetrical angrakha wrap silhouette with braided textile ties and handmade tassel finishes. Hand-block printed with archival floral motifs using fermented jaggery and iron vat dye.",
    image_url: "/products/chanderi-angrakha.jpg",
    active: true,
    variants: [
      { sku: "ANG-TER-XS", size: "XS", colour: "Terracotta Rose", on_hand: 3, reserved: 0, reorder_level: 2 },
      { sku: "ANG-TER-S",  size: "S",  colour: "Terracotta Rose", on_hand: 4, reserved: 0, reorder_level: 2 },
      { sku: "ANG-TER-M",  size: "M",  colour: "Terracotta Rose", on_hand: 2, reserved: 0, reorder_level: 2 },
      { sku: "ANG-TER-L",  size: "L",  colour: "Terracotta Rose", on_hand: 3, reserved: 0, reorder_level: 1 }
    ]
  },
  {
    id: 4,
    name: "Mulberry Silk Lantern-Sleeve Column Gown",
    category: "Maxi Gowns",
    price_inr: 7200,
    description: "Architectural minimalism meets rich Indian luster. Pure unadulterated mulberry raw silk cut in a clean column silhouette with voluminous lantern sleeves and a discreet back zipper closure.",
    image_url: "/products/mulberry-column-gown.jpg",
    active: true,
    variants: [
      { sku: "MUL-GLD-S", size: "S", colour: "Antique Brass", on_hand: 1, reserved: 0, reorder_level: 1 },
      { sku: "MUL-GLD-M", size: "M", colour: "Antique Brass", on_hand: 1, reserved: 0, reorder_level: 1 },
      { sku: "MUL-GLD-L", size: "L", colour: "Antique Brass", on_hand: 0, reserved: 0, reorder_level: 1 }
    ]
  },
  {
    id: 5,
    name: "Jamdani Woven Peplum Kurta Dress",
    category: "Handloom Kurtas",
    price_inr: 3900,
    description: "Authentic supplementary weft Jamdani motifs woven by hand on an Egyptian cotton base. Flattering flared peplum waistline designed to be worn either as a mini dress or layered over straight trousers.",
    image_url: "/products/jamdani-peplum-kurta.jpg",
    active: true,
    variants: [
      { sku: "JAM-WHT-S", size: "S", colour: "Cloud White", on_hand: 6, reserved: 0, reorder_level: 2 },
      { sku: "JAM-WHT-M", size: "M", colour: "Cloud White", on_hand: 5, reserved: 1, reorder_level: 2 },
      { sku: "JAM-WHT-L", size: "L", colour: "Cloud White", on_hand: 3, reserved: 0, reorder_level: 1 }
    ]
  },
  {
    id: 6,
    name: "Ajrakh Resist-Dyed Pleated Shirt Dress",
    category: "Midi Dresses",
    price_inr: 4600,
    description: "Sixteen-stage heritage Ajrakh mud-resist block printing from Kutch. Features a sharp bandh gala collar, hidden front placket, deep side pockets, and an optional matching fabric sash belt.",
    image_url: "/products/ajrakh-pleated-shirtdress.jpg",
    active: true,
    variants: [
      { sku: "AJR-BLU-XS", size: "XS", colour: "Indigo Black", on_hand: 2, reserved: 0, reorder_level: 1 },
      { sku: "AJR-BLU-S",  size: "S",  colour: "Indigo Black", on_hand: 5, reserved: 0, reorder_level: 2 },
      { sku: "AJR-BLU-M",  size: "M",  colour: "Indigo Black", on_hand: 3, reserved: 0, reorder_level: 1 },
      { sku: "AJR-BLU-L",  size: "L",  colour: "Indigo Black", on_hand: 2, reserved: 0, reorder_level: 1 }
    ]
  },
  {
    id: 7,
    name: "Tussar Silk Reversible Kimono Wrap Jacket",
    category: "Atelier Sets",
    price_inr: 6400,
    description: "Dual-sided handspun Ghicha Tussar silk outer with a fine mulmul cotton lining. Wide drop shoulders and deep pockets make this the quintessential layering piece across seasons.",
    image_url: "/products/tussar-kimono-jacket.jpg",
    active: true,
    variants: [
      { sku: "TUS-RST-FREE", size: "Free Size", colour: "Rust Ochre", on_hand: 4, reserved: 0, reorder_level: 2 },
      { sku: "TUS-IND-FREE", size: "Free Size", colour: "Midnight Navy", on_hand: 3, reserved: 0, reorder_level: 1 }
    ]
  },
  {
    id: 8,
    name: "Kalamkari Botanical Tiered Sundress",
    category: "Midi Dresses",
    price_inr: 3750,
    description: "Freehand pen Kalamkari drawing rendered with organic alum and vegetable extracts on soft 60s count cambric cotton. Features adjustable shoulder ties and a sweeping ruffled hem.",
    image_url: "", // intentionally empty image_url to test elegant initials placeholder!
    active: true,
    variants: [
      { sku: "KAL-BOT-S", size: "S", colour: "Sage Umber", on_hand: 0, reserved: 0, reorder_level: 2 },
      { sku: "KAL-BOT-M", size: "M", colour: "Sage Umber", on_hand: 0, reserved: 0, reorder_level: 2 },
      { sku: "KAL-BOT-L", size: "L", colour: "Sage Umber", on_hand: 0, reserved: 0, reorder_level: 1 }
    ]
  }
];

// In-memory orders store seeded with realistic tracking and admin samples
const ORDERS = new Map();
const IDEMPOTENCY_MAP = new Map();
let orderSequence = 1;

function seedInitialOrders() {
  const o1 = {
    id: 1,
    order_no: "DS-2611-00001",
    status: "SHIPPED",
    channel: "web",
    payment_mode: "UPI",
    payment_status: "PAID",
    payment_ref: "UPI-REF-98712345",
    subtotal: 4250,
    shipping: 0,
    total: 4250,
    ship_address: "14/A, Rosewood Heights, Lavelle Road, Bengaluru",
    ship_pincode: "560001",
    courier: "Delhivery Express",
    awb: "DEL789456123IN",
    notes: "Leave with front desk if not reachable",
    expires_at: null,
    created_at: new Date(Date.now() - 48 * 3600000).toISOString(),
    updated_at: new Date(Date.now() - 6 * 3600000).toISOString(),
    customer: {
      name: "Meera Krishnan",
      phone: "9876543210"
    },
    items: [
      {
        sku: "KOR-IVR-M",
        product: "Kora Handloom Tiered Midi Dress",
        size: "M",
        colour: "Ivory White",
        qty: 1,
        unit_price: 4250,
        line_total: 4250
      }
    ],
    events: [
      { from_status: "NEW", to_status: "PENDING_PAYMENT", note: "Order placed via website", actor: "web", at: new Date(Date.now() - 48 * 3600000).toISOString() },
      { from_status: "PENDING_PAYMENT", to_status: "CONFIRMED", note: "Payment verified via UTR UPI-REF-98712345", actor: "admin", at: new Date(Date.now() - 44 * 3600000).toISOString() },
      { from_status: "CONFIRMED", to_status: "PACKED", note: "Packed in handmade cotton textile bag", actor: "admin", at: new Date(Date.now() - 24 * 3600000).toISOString() },
      { from_status: "PACKED", to_status: "SHIPPED", note: "Dispatched via Delhivery Express", actor: "admin", at: new Date(Date.now() - 6 * 3600000).toISOString() }
    ]
  };

  const o2 = {
    id: 2,
    order_no: "DS-2611-00002",
    status: "PENDING_PAYMENT",
    channel: "web",
    payment_mode: "UPI",
    payment_status: "PENDING",
    payment_ref: null,
    subtotal: 5800,
    shipping: 0,
    total: 5800,
    ship_address: "Flat 402, Sea Green Apts, Worli, Mumbai",
    ship_pincode: "400018",
    courier: null,
    awb: null,
    notes: "",
    expires_at: new Date(Date.now() + 25 * 60000).toISOString(),
    created_at: new Date(Date.now() - 5 * 60000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 60000).toISOString(),
    customer: {
      name: "Rohini Sen",
      phone: "9123456789"
    },
    items: [
      {
        sku: "MAH-EMR-M",
        product: "Maheshwari Silk-Cotton Overlay Dress",
        size: "M",
        colour: "Emerald Green",
        qty: 1,
        unit_price: 5800,
        line_total: 5800
      }
    ],
    events: [
      { from_status: "NEW", to_status: "PENDING_PAYMENT", note: "Order placed via website, awaiting UPI confirmation", actor: "web", at: new Date(Date.now() - 5 * 60000).toISOString() }
    ]
  };

  ORDERS.set(o1.order_no, o1);
  ORDERS.set(o2.order_no, o2);
  orderSequence = 3;
}
seedInitialOrders();

const TRANSITIONS = {
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

function isKeyValid(req) {
  const given = req.headers['x-api-key'] || '';
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 200000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, code, message, details = null) {
  sendJson(res, statusCode, {
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  });
}

// Minimal in-memory rate limiter for tracking lookups
const rateBuckets = new Map();
function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  return b.count > limit;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const isAdmin = isKeyValid(req);

  try {
    /* 1. Health check */
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime() });
    }

    /* 2. Public products list */
    if (req.method === 'GET' && pathname === '/api/products') {
      const categoryFilter = url.searchParams.get('category');
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();

      let filtered = PRODUCTS.filter(p => p.active);
      if (categoryFilter) {
        filtered = filtered.filter(p => p.category.toLowerCase() === categoryFilter.toLowerCase());
      }
      if (q) {
        filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
      }

      const productsOut = filtered.map(p => {
        let hasInStock = false;
        const variantsOut = p.variants.map(v => {
          const available = Math.max(0, v.on_hand - v.reserved);
          if (available > 0) hasInStock = true;
          const vObj = {
            sku: v.sku,
            size: v.size,
            colour: v.colour,
            image_url: v.image_url || null,
            available
          };
          if (isAdmin) {
            vObj.on_hand = v.on_hand;
            vObj.reserved = v.reserved;
            vObj.reorder_level = v.reorder_level;
          }
          return vObj;
        });

        return {
          id: p.id,
          name: p.name,
          category: p.category,
          price_inr: p.price_inr,
          description: p.description,
          image_url: p.image_url,
          in_stock: hasInStock,
          variants: variantsOut
        };
      });

      return sendJson(res, 200, { products: productsOut });
    }

    /* 3. Public single SKU lookup */
    if (req.method === 'GET' && pathname.startsWith('/api/stock/')) {
      const sku = decodeURIComponent(pathname.replace('/api/stock/', '')).trim();
      let found = null;
      for (const p of PRODUCTS) {
        for (const v of p.variants) {
          if (v.sku === sku) {
            const available = Math.max(0, v.on_hand - v.reserved);
            found = {
              sku: v.sku,
              product: p.name,
              price_inr: p.price_inr,
              size: v.size,
              colour: v.colour,
              available
            };
            if (isAdmin) {
              found.on_hand = v.on_hand;
              found.reserved = v.reserved;
              found.reorder_level = v.reorder_level;
            }
            break;
          }
        }
        if (found) break;
      }
      if (!found) return sendError(res, 404, 'NOT_FOUND', `Unknown SKU ${sku}`);
      return sendJson(res, 200, found);
    }

    /* 4. Public order tracking */
    if (req.method === 'GET' && pathname.startsWith('/api/track/')) {
      const orderNo = decodeURIComponent(pathname.replace('/api/track/', '')).toUpperCase().trim();
      const phone4 = url.searchParams.get('phone4') || '';
      const clientIp = req.socket.remoteAddress || '127.0.0.1';

      if (isRateLimited(`track:${clientIp}`, 40, 60000)) {
        return sendError(res, 429, 'TOO_MANY_REQUESTS', 'Too many lookups, try again in a few minutes');
      }

      if (!/^\d{4}$/.test(phone4)) {
        return sendError(res, 400, 'BAD_REQUEST', 'phone4 (last 4 digits of the phone number) is required');
      }

      const order = ORDERS.get(orderNo);
      if (!order || !order.customer.phone || !order.customer.phone.endsWith(phone4)) {
        return sendError(res, 404, 'NOT_FOUND', 'Order not found');
      }

      return sendJson(res, 200, {
        order_no: order.order_no,
        status: order.status,
        total: order.total,
        payment_mode: order.payment_mode,
        payment_status: order.payment_status,
        courier: order.courier,
        awb: order.awb,
        created_at: order.created_at,
        updated_at: order.updated_at,
        items: order.items.map(it => ({
          product: it.product,
          size: it.size,
          colour: it.colour,
          qty: it.qty
        })),
        history: order.events.map(ev => ({
          status: ev.to_status,
          at: ev.at
        }))
      });
    }

    /* --- Protected Endpoints (require X-API-Key) --- */
    if (!isAdmin) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Missing or wrong X-API-Key');
    }

    /* 5. Create Order */
    if (req.method === 'POST' && pathname === '/api/orders') {
      const body = await parseJsonBody(req);
      const idemKey = body.idempotency_key;

      if (idemKey && IDEMPOTENCY_MAP.has(idemKey)) {
        const existingNo = IDEMPOTENCY_MAP.get(idemKey);
        const existing = ORDERS.get(existingNo);
        if (existing) {
          return sendJson(res, 200, { duplicate: true, order: existing });
        }
      }

      const channel = String(body.channel || 'web').toLowerCase();
      const itemsReq = Array.isArray(body.items) ? body.items : [];
      if (!itemsReq.length) {
        return sendError(res, 400, 'BAD_REQUEST', 'items array cannot be empty');
      }

      // Check stock availability atomically
      const enrichedItems = [];
      let subtotal = 0;

      for (const item of itemsReq) {
        const sku = String(item.sku || '').trim();
        const qty = parseInt(item.qty, 10);
        if (!sku || isNaN(qty) || qty < 1) {
          return sendError(res, 400, 'BAD_REQUEST', 'each item needs valid sku and qty >= 1');
        }

        let variantFound = null;
        let productFound = null;
        for (const p of PRODUCTS) {
          for (const v of p.variants) {
            if (v.sku === sku) {
              variantFound = v;
              productFound = p;
              break;
            }
          }
          if (variantFound) break;
        }

        if (!variantFound) {
          return sendError(res, 422, 'UNKNOWN_SKU', `SKU ${sku} not found`);
        }
        if (!productFound.active) {
          return sendError(res, 422, 'PRODUCT_INACTIVE', `Product ${productFound.name} is inactive`);
        }

        const available = variantFound.on_hand - variantFound.reserved;
        if (qty > available) {
          return sendError(res, 409, 'OUT_OF_STOCK', `Only ${available} left of ${productFound.name} (${variantFound.size}), you asked for ${qty}`, {
            sku: variantFound.sku,
            product: productFound.name,
            size: variantFound.size,
            colour: variantFound.colour,
            requested: qty,
            available
          });
        }

        enrichedItems.push({
          sku: variantFound.sku,
          product: productFound.name,
          size: variantFound.size,
          colour: variantFound.colour,
          qty,
          unit_price: productFound.price_inr,
          line_total: productFound.price_inr * qty,
          _variantRef: variantFound
        });
        subtotal += productFound.price_inr * qty;
      }

      // Reserve stock
      for (const it of enrichedItems) {
        it._variantRef.reserved += it.qty;
      }

      const orderNo = `DS-2611-${String(orderSequence++).padStart(5, '0')}`;
      const shipping = Number(body.shipping) || 0;
      const total = subtotal + shipping;
      const paymentMode = String(body.payment_mode || 'UPI').toUpperCase();
      const status = paymentMode === 'UPI' ? 'PENDING_PAYMENT' : 'NEW';
      const expiresAt = paymentMode === 'UPI' ? new Date(Date.now() + 30 * 60000).toISOString() : null;

      const order = {
        id: orderSequence,
        order_no: orderNo,
        status,
        channel,
        payment_mode: paymentMode,
        payment_status: 'PENDING',
        payment_ref: null,
        subtotal,
        shipping,
        total,
        ship_address: body.ship_address || '',
        ship_pincode: body.ship_pincode || '',
        courier: null,
        awb: null,
        notes: body.notes || '',
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        customer: {
          name: (body.customer && body.customer.name) || 'Guest Patron',
          phone: (body.customer && body.customer.phone) || ''
        },
        items: enrichedItems.map(it => ({
          sku: it.sku,
          product: it.product,
          size: it.size,
          colour: it.colour,
          qty: it.qty,
          unit_price: it.unit_price,
          line_total: it.line_total
        })),
        events: [
          {
            from_status: null,
            to_status: status,
            note: 'Order created',
            actor: 'web',
            at: new Date().toISOString()
          }
        ]
      };

      ORDERS.set(orderNo, order);
      if (idemKey) IDEMPOTENCY_MAP.set(idemKey, orderNo);

      return sendJson(res, 201, { duplicate: false, order });
    }

    /* 6. List orders */
    if (req.method === 'GET' && pathname === '/api/orders') {
      const statusFilter = url.searchParams.get('status');
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      let list = Array.from(ORDERS.values());
      if (statusFilter) {
        list = list.filter(o => o.status === statusFilter.toUpperCase());
      }
      if (q) {
        list = list.filter(o =>
          o.order_no.toLowerCase().includes(q) ||
          (o.customer.name && o.customer.name.toLowerCase().includes(q)) ||
          (o.customer.phone && o.customer.phone.includes(q))
        );
      }

      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const page = list.slice(offset, offset + limit).map(o => ({
        order_no: o.order_no,
        status: o.status,
        channel: o.channel,
        payment_mode: o.payment_mode,
        payment_status: o.payment_status,
        total: o.total,
        created_at: o.created_at,
        customer_name: o.customer.name,
        customer_phone: o.customer.phone,
        items: o.items.reduce((acc, it) => acc + it.qty, 0)
      }));

      return sendJson(res, 200, { orders: page });
    }

    /* 7. Single order detail */
    if (req.method === 'GET' && pathname.startsWith('/api/orders/')) {
      const orderNo = decodeURIComponent(pathname.replace('/api/orders/', '')).toUpperCase().trim();
      const order = ORDERS.get(orderNo);
      if (!order) return sendError(res, 404, 'NOT_FOUND', `Order ${orderNo} not found`);
      return sendJson(res, 200, { order });
    }

    /* 8. Change order status */
    if (req.method === 'POST' && pathname.endsWith('/status')) {
      const parts = pathname.split('/');
      const orderNo = decodeURIComponent(parts[3] || '').toUpperCase().trim();
      const order = ORDERS.get(orderNo);
      if (!order) return sendError(res, 404, 'NOT_FOUND', `Order ${orderNo} not found`);

      const body = await parseJsonBody(req);
      const targetStatus = String(body.status || '').toUpperCase();
      const allowed = TRANSITIONS[order.status] || [];

      if (!allowed.includes(targetStatus)) {
        return sendError(res, 409, 'INVALID_TRANSITION', `Cannot move ${order.order_no} from ${order.status} to ${targetStatus}`, {
          from: order.status,
          to: targetStatus,
          allowed
        });
      }

      // Stock adjustment according to state transition rules
      if (targetStatus === 'PACKED') {
        // on_hand - qty and reserved - qty
        for (const it of order.items) {
          for (const p of PRODUCTS) {
            const v = p.variants.find(x => x.sku === it.sku);
            if (v) {
              v.on_hand = Math.max(0, v.on_hand - it.qty);
              v.reserved = Math.max(0, v.reserved - it.qty);
            }
          }
        }
      } else if (targetStatus === 'CANCELLED') {
        if (order.status === 'PACKED') {
          // restock on_hand
          for (const it of order.items) {
            for (const p of PRODUCTS) {
              const v = p.variants.find(x => x.sku === it.sku);
              if (v) v.on_hand += it.qty;
            }
          }
        } else {
          // release reserved
          for (const it of order.items) {
            for (const p of PRODUCTS) {
              const v = p.variants.find(x => x.sku === it.sku);
              if (v) v.reserved = Math.max(0, v.reserved - it.qty);
            }
          }
        }
      } else if (targetStatus === 'RETURNED' && body.restock !== false) {
        for (const it of order.items) {
          for (const p of PRODUCTS) {
            const v = p.variants.find(x => x.sku === it.sku);
            if (v) v.on_hand += it.qty;
          }
        }
      }

      if (targetStatus === 'DELIVERED' && order.payment_mode === 'COD') {
        order.payment_status = 'PAID';
      }

      const prevStatus = order.status;
      order.status = targetStatus;
      if (body.courier) order.courier = body.courier;
      if (body.awb) order.awb = body.awb;
      if (targetStatus !== 'PENDING_PAYMENT') order.expires_at = null;
      order.updated_at = new Date().toISOString();

      order.events.push({
        from_status: prevStatus,
        to_status: targetStatus,
        note: body.note || `Status changed to ${targetStatus}`,
        actor: req.headers['x-actor'] || 'admin',
        at: new Date().toISOString()
      });

      return sendJson(res, 200, { order });
    }

    /* 9. Mark Paid */
    if (req.method === 'POST' && pathname.endsWith('/paid')) {
      const parts = pathname.split('/');
      const orderNo = decodeURIComponent(parts[3] || '').toUpperCase().trim();
      const order = ORDERS.get(orderNo);
      if (!order) return sendError(res, 404, 'NOT_FOUND', `Order ${orderNo} not found`);

      if (['CANCELLED', 'REFUNDED', 'RETURNED'].includes(order.status)) {
        return sendError(res, 409, 'ORDER_CLOSED', `${order.order_no} is ${order.status}. Payment arrived for a closed order.`, { status: order.status });
      }

      const body = await parseJsonBody(req);
      order.payment_status = 'PAID';
      if (body.payment_ref) order.payment_ref = body.payment_ref;
      order.updated_at = new Date().toISOString();

      const prevStatus = order.status;
      if (order.status === 'NEW' || order.status === 'PENDING_PAYMENT') {
        order.status = 'CONFIRMED';
        order.expires_at = null;
        order.events.push({
          from_status: prevStatus,
          to_status: 'CONFIRMED',
          note: `Payment confirmed (Ref: ${order.payment_ref || 'manual'})`,
          actor: req.headers['x-actor'] || 'admin',
          at: new Date().toISOString()
        });
      } else {
        order.events.push({
          from_status: prevStatus,
          to_status: prevStatus,
          note: `Payment reference attached: ${order.payment_ref || 'manual'}`,
          actor: req.headers['x-actor'] || 'admin',
          at: new Date().toISOString()
        });
      }

      return sendJson(res, 200, { order });
    }

    /* 10. Adjust stock */
    if (req.method === 'POST' && pathname === '/api/stock/adjust') {
      const body = await parseJsonBody(req);
      const sku = String(body.sku || '').trim();
      const delta = parseInt(body.delta, 10);
      const reason = String(body.reason || '').trim();

      if (!sku || isNaN(delta) || delta === 0) {
        return sendError(res, 400, 'BAD_REQUEST', 'sku and non-zero integer delta are required');
      }
      if (!reason) {
        return sendError(res, 400, 'BAD_REQUEST', 'reason is required (e.g. restock, count correction)');
      }

      let variantFound = null;
      for (const p of PRODUCTS) {
        const v = p.variants.find(x => x.sku === sku);
        if (v) { variantFound = v; break; }
      }

      if (!variantFound) return sendError(res, 404, 'NOT_FOUND', `Unknown SKU ${sku}`);

      if (variantFound.on_hand + delta < variantFound.reserved) {
        return sendError(res, 409, 'BELOW_RESERVED', `Cannot reduce ${sku} by ${-delta}: ${variantFound.on_hand} on hand, ${variantFound.reserved} reserved for open orders`, {
          on_hand: variantFound.on_hand,
          reserved: variantFound.reserved
        });
      }

      variantFound.on_hand += delta;
      const available = variantFound.on_hand - variantFound.reserved;

      return sendJson(res, 200, {
        sku: variantFound.sku,
        on_hand: variantFound.on_hand,
        reserved: variantFound.reserved,
        available
      });
    }

    /* 11. Low stock variants */
    if (req.method === 'GET' && pathname === '/api/low-stock') {
      const items = [];
      for (const p of PRODUCTS) {
        if (!p.active) continue;
        for (const v of p.variants) {
          const available = Math.max(0, v.on_hand - v.reserved);
          if (available <= v.reorder_level) {
            items.push({
              sku: v.sku,
              product: p.name,
              category: p.category,
              size: v.size,
              colour: v.colour,
              on_hand: v.on_hand,
              reserved: v.reserved,
              available,
              reorder_level: v.reorder_level
            });
          }
        }
      }
      items.sort((a, b) => a.available - b.available);
      return sendJson(res, 200, { items });
    }

    /* 12. Expire reservations */
    if (req.method === 'POST' && pathname === '/api/admin/expire-reservations') {
      const cancelled = [];
      const now = new Date();
      for (const o of ORDERS.values()) {
        if (o.status === 'PENDING_PAYMENT' && o.expires_at && new Date(o.expires_at) <= now) {
          o.status = 'CANCELLED';
          o.updated_at = now.toISOString();
          // release reserved
          for (const it of o.items) {
            for (const p of PRODUCTS) {
              const v = p.variants.find(x => x.sku === it.sku);
              if (v) v.reserved = Math.max(0, v.reserved - it.qty);
            }
          }
          o.events.push({
            from_status: 'PENDING_PAYMENT',
            to_status: 'CANCELLED',
            note: 'Reservation window expired without payment',
            actor: 'system',
            at: now.toISOString()
          });
          cancelled.push({ order_no: o.order_no });
        }
      }
      return sendJson(res, 200, { cancelled });
    }

    // 404 fallback
    return sendError(res, 404, 'NOT_FOUND', 'No such endpoint');

  } catch (err) {
    console.error('Mock API Error:', err);
    return sendError(res, 500, 'INTERNAL', 'Internal server error in mock api');
  }
});

server.listen(PORT, () => {
  console.log(`[mock-api] Standalone shop-api mock listening on http://localhost:${PORT}`);
  console.log(`[mock-api] API_KEY: ${API_KEY}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
