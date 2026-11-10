/**
 * Public storefront routes.
 * Handles Landing, Shop, Product detail, Cart, Checkout,
 * Order confirmation, Order tracking, Editorial pages, and SEO.
 */
const express = require('express');
const crypto = require('crypto');
const api = require('../api');
const cart = require('../cart');
const config = require('../config');
const upiPayment = require('../payments/upi');
const { checkRateLimit, maskPhone } = require('../security');
const { dispatchOrderWebhook } = require('../webhook');

const router = express.Router();

/**
 * Helper to get clean product category list from catalog
 */
function extractCategories(products) {
  const set = new Set();
  for (const p of products) {
    if (p.category) set.add(p.category.trim());
  }
  return Array.from(set).sort();
}

/**
 * 1. Landing Page (/)
 */
router.get('/', async (req, res, next) => {
  try {
    const allProducts = await api.getProducts();
    const categories = extractCategories(allProducts);

    // Filter in-stock first, then take top 8 for New Arrivals
    const sortedForArrivals = [...allProducts].sort((a, b) => {
      if (a.in_stock && !b.in_stock) return -1;
      if (!a.in_stock && b.in_stock) return 1;
      return b.id - a.id;
    });
    const newArrivals = sortedForArrivals.slice(0, 8);

    res.render('pages/index', {
      title: `${config.storeName} | Slow-Crafted Indian Silhouettes`,
      metaDesc: config.storeTagline,
      newArrivals,
      categories,
      site: config.siteContent,
      config
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 2. Shop Page (/shop)
 */
router.get('/shop', async (req, res, next) => {
  try {
    const selectedCategory = req.query.category || '';
    const searchQuery = req.query.q || '';
    const sort = req.query.sort || 'newest';

    const rawProducts = await api.getProducts({
      category: selectedCategory,
      q: searchQuery
    });

    const allProductsForCategories = await api.getProducts();
    const categories = extractCategories(allProductsForCategories);

    let products = [...rawProducts];

    // Server-side sorting
    if (sort === 'price-low') {
      products.sort((a, b) => a.price_inr - b.price_inr);
    } else if (sort === 'price-high') {
      products.sort((a, b) => b.price_inr - a.price_inr);
    } else {
      // Default: in-stock first, newest id desc
      products.sort((a, b) => {
        if (a.in_stock && !b.in_stock) return -1;
        if (!a.in_stock && b.in_stock) return 1;
        return b.id - a.id;
      });
    }

    res.render('pages/shop', {
      title: `Shop the Collection | ${config.storeName}`,
      metaDesc: `Browse handcrafted dresses, kurtas, and artisanal overlay jackets tailored in fine Indian handlooms.`,
      products,
      categories,
      selectedCategory,
      searchQuery,
      sort,
      site: config.siteContent,
      config
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Standalone Shareable Product Page (/product/:id)
 */
router.get('/product/:id', async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id, 10);
    const allProducts = await api.getProducts();
    const product = allProducts.find(p => p.id === productId);

    if (!product) {
      return res.status(404).render('pages/404', {
        title: 'Product Not Found',
        message: 'The requested piece could not be found or has been archived.'
      });
    }

    // Related pieces from same category
    const related = allProducts
      .filter(p => p.id !== product.id && p.category === product.category)
      .slice(0, 4);

    res.render('pages/product', {
      title: `${product.name} | ${config.storeName}`,
      metaDesc: product.description.slice(0, 155),
      product,
      related,
      site: config.siteContent,
      config
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 3. Cart Routes
 */
router.get('/cart/state', async (req, res) => {
  try {
    const cartState = await cart.syncCart(req);
    res.json({ success: true, cart: cartState });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/cart', async (req, res, next) => {
  try {
    const cartState = await cart.syncCart(req);
    res.render('pages/cart', {
      title: `Your Bag | ${config.storeName}`,
      metaDesc: 'Review your selected artisanal pieces before checkout.',
      cart: cartState,
      flashNotice: req.session.cartNotice || null,
      site: config.siteContent,
      config
    });
    delete req.session.cartNotice;
  } catch (err) {
    next(err);
  }
});

router.post('/cart/add', async (req, res) => {
  const { sku, qty } = req.body;
  const isAjax = req.xhr || req.headers.accept?.includes('application/json');

  try {
    const cartState = await cart.addItem(req, sku, qty);
    if (isAjax) {
      return res.json({ success: true, cart: cartState });
    }
    req.session.cartNotice = 'Item added to your shopping bag.';
    res.redirect('/cart');
  } catch (err) {
    if (isAjax) {
      return res.status(400).json({ success: false, error: err.message });
    }
    req.session.cartNotice = `Notice: ${err.message}`;
    res.redirect('back');
  }
});

router.post('/cart/update', async (req, res) => {
  const { sku, qty } = req.body;
  const isAjax = req.xhr || req.headers.accept?.includes('application/json');

  try {
    const cartState = await cart.updateItem(req, sku, qty);
    if (isAjax) {
      return res.json({ success: true, cart: cartState });
    }
    res.redirect('/cart');
  } catch (err) {
    if (isAjax) {
      return res.status(400).json({ success: false, error: err.message });
    }
    res.redirect('/cart');
  }
});

router.post('/cart/remove', async (req, res) => {
  const { sku } = req.body;
  const isAjax = req.xhr || req.headers.accept?.includes('application/json');

  try {
    const cartState = await cart.removeItem(req, sku);
    if (isAjax) {
      return res.json({ success: true, cart: cartState });
    }
    res.redirect('/cart');
  } catch (err) {
    if (isAjax) {
      return res.status(400).json({ success: false, error: err.message });
    }
    res.redirect('/cart');
  }
});

/**
 * Helper to validate session-applied coupon against live cart subtotal
 */
async function getValidatedCoupon(req, subtotal) {
  if (!req.session || !req.session.appliedCoupon) {
    return { coupon: null, discount: 0 };
  }
  try {
    const res = await api.validateCoupon(req.session.appliedCoupon.code, subtotal);
    if (res && res.ok && res.coupon) {
      req.session.appliedCoupon = res.coupon;
      return { coupon: res.coupon, discount: Number(res.coupon.discount || 0) };
    }
  } catch (err) {
    req.session.couponNotice = err.message || 'Coupon is no longer valid.';
  }
  delete req.session.appliedCoupon;
  return { coupon: null, discount: 0 };
}

/**
 * 4. Checkout Routes (/checkout)
 */
router.get('/checkout', async (req, res, next) => {
  try {
    const cartState = await cart.syncCart(req);
    if (!cartState.items.length) {
      return res.redirect('/shop');
    }

    const { coupon, discount } = await getValidatedCoupon(req, cartState.subtotal);
    const grandTotal = Math.max(0, cartState.total - discount);

    // Fresh idempotency key for single-submit form guarantee
    const idempotencyKey = crypto.randomUUID();

    const couponNotice = req.session.couponNotice || null;
    const couponSuccess = req.session.couponSuccess || null;
    delete req.session.couponNotice;
    delete req.session.couponSuccess;

    res.render('pages/checkout', {
      title: `Checkout | ${config.storeName}`,
      metaDesc: 'Complete your order securely.',
      cart: cartState,
      coupon,
      discount,
      grandTotal,
      couponNotice,
      couponSuccess,
      idempotencyKey,
      errors: {},
      form: {},
      site: config.siteContent,
      config
    });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout/apply-coupon', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const isAjax = req.xhr || req.headers.accept?.includes('application/json');

  if (!code) {
    if (isAjax) return res.status(400).json({ success: false, error: 'Please enter a coupon code.' });
    req.session.couponNotice = 'Please enter a coupon code.';
    return res.redirect('/checkout');
  }

  try {
    const cartState = await cart.syncCart(req);
    if (!cartState.items.length) {
      if (isAjax) return res.status(400).json({ success: false, error: 'Your cart is empty.' });
      return res.redirect('/shop');
    }

    const result = await api.validateCoupon(code, cartState.subtotal);
    if (result && result.ok && result.coupon) {
      req.session.appliedCoupon = result.coupon;
      req.session.couponSuccess = `Coupon "${result.coupon.code}" applied! You save ₹${Number(result.coupon.discount).toLocaleString('en-IN')}.`;
      if (isAjax) {
        return res.json({
          success: true,
          coupon: result.coupon,
          discount: result.coupon.discount,
          grandTotal: Math.max(0, cartState.total - result.coupon.discount)
        });
      }
      return res.redirect('/checkout');
    } else {
      throw new Error(result?.error || 'Invalid coupon code.');
    }
  } catch (err) {
    if (isAjax) {
      return res.status(400).json({ success: false, error: err.message || 'Invalid coupon code.' });
    }
    req.session.couponNotice = err.message || 'Invalid coupon code.';
    res.redirect('/checkout');
  }
});

router.post('/checkout/remove-coupon', (req, res) => {
  const isAjax = req.xhr || req.headers.accept?.includes('application/json');
  delete req.session.appliedCoupon;
  req.session.couponNotice = 'Coupon removed.';
  if (isAjax) {
    return res.json({ success: true });
  }
  res.redirect('/checkout');
});

router.post('/checkout', async (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  if (!checkRateLimit(`checkout:${ip}`, 12, 600000)) {
    return res.status(429).render('pages/500', {
      title: 'Too Many Requests',
      message: 'Too many order attempts from your network. Please wait a few minutes before trying again.'
    });
  }

  const {
    name,
    email,
    phone,
    address,
    pincode,
    payment_mode,
    notes,
    idempotency_key
  } = req.body;

  // Strict server-side validation
  const errors = {};
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const cleanAddress = String(address || '').trim();
  const cleanPincode = String(pincode || '').trim();
  const paymentMode = ['UPI', 'COD'].includes(payment_mode) ? payment_mode : 'UPI';

  if (!cleanName || cleanName.length < 2) {
    errors.name = 'Please provide your full name.';
  }
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    errors.email = 'Please enter a valid email address or leave it blank.';
  }
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
    errors.phone = 'Please enter a valid 10-digit Indian mobile number.';
  }
  if (!cleanAddress || cleanAddress.length < 10) {
    errors.address = 'Please enter your complete delivery address including street & house number.';
  }
  if (!/^\d{6}$/.test(cleanPincode)) {
    errors.pincode = 'Please enter a valid 6-digit Indian PIN code.';
  }

  const cartState = await cart.syncCart(req);
  if (!cartState.items.length) {
    if (cartState.notices && cartState.notices.length) {
      req.session.cartNotice = cartState.notices.join(' ');
      return res.redirect('/cart');
    }
    return res.redirect('/shop');
  }

  const { coupon, discount } = await getValidatedCoupon(req, cartState.subtotal);
  const grandTotal = Math.max(0, cartState.total - discount);

  if (Object.keys(errors).length > 0) {
    return res.status(400).render('pages/checkout', {
      title: `Checkout | ${config.storeName}`,
      metaDesc: 'Complete your order securely.',
      cart: cartState,
      coupon,
      discount,
      grandTotal,
      couponNotice: null,
      couponSuccess: null,
      idempotencyKey: idempotency_key || crypto.randomUUID(),
      errors,
      form: {
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        address: cleanAddress,
        pincode: cleanPincode,
        payment_mode: paymentMode,
        notes: notes || ''
      },
      site: config.siteContent,
      config
    });
  }

  const orderPayload = {
    channel: 'web',
    customer: {
      name: cleanName,
      phone: cleanPhone,
      email: cleanEmail || null
    },
    ship_address: cleanAddress,
    ship_pincode: cleanPincode,
    items: cartState.items.map(it => ({ sku: it.sku, qty: it.qty })),
    payment_mode: paymentMode,
    shipping: cartState.shipping,
    notes: String(notes || '').trim(),
    idempotency_key: idempotency_key || crypto.randomUUID(),
    coupon_code: coupon ? coupon.code : null
  };

  try {
    const resData = await api.createOrder(orderPayload);
    const order = resData.order;

    // Track order in customer session
    req.session.recentOrders = req.session.recentOrders || [];
    if (!req.session.recentOrders.includes(order.order_no)) {
      req.session.recentOrders.push(order.order_no);
    }

    // Clear cart and applied coupon upon successful order creation
    cart.clearCart(req);
    delete req.session.appliedCoupon;

    // Asynchronously dispatch webhook to n8n
    dispatchOrderWebhook({
      event: 'order.created',
      source: 'website',
      actor: 'customer',
      order
    }).catch((e) => console.error('[webhook] Error dispatching order.created to n8n:', e.message));

    res.redirect(`/order/${encodeURIComponent(order.order_no)}`);
  } catch (err) {
    if (err.status === 409 && err.code === 'OUT_OF_STOCK') {
      const d = err.details || {};
      const friendlyNotice = `Sorry! "${d.product || d.sku} (${d.size || ''})" only has ${d.available ?? 0} item(s) left in stock (you requested ${d.requested || ''}). Your cart has been updated.`;
      req.session.cartNotice = friendlyNotice;
      return res.redirect('/cart');
    }
    if (err.status === 400 && (err.code === 'INVALID_COUPON' || (typeof err.code === 'string' && err.code.startsWith('COUPON_')))) {
      delete req.session.appliedCoupon;
      req.session.couponNotice = `Coupon notice: ${err.message}`;
      return res.redirect('/checkout');
    }
    next(err);
  }
});

/**
 * 5. Order Confirmation (/order/:orderNo)
 */
router.get('/order/:orderNo', async (req, res, next) => {
  const orderNo = req.params.orderNo.toUpperCase();

  // Visitor must have placed the order in this session, otherwise redirect to public tracking
  const allowedOrders = req.session.recentOrders || [];
  if (!allowedOrders.includes(orderNo)) {
    return res.redirect(`/track?order=${encodeURIComponent(orderNo)}`);
  }

  try {
    const order = await api.getOrder(orderNo);
    if (!order) {
      return res.status(404).render('pages/404', {
        title: 'Order Not Found',
        message: `Order #${orderNo} was not found.`
      });
    }

    let upiDetails = null;
    if (order.payment_mode === 'UPI' && order.status === 'PENDING_PAYMENT') {
      upiDetails = await upiPayment.getPaymentDetails(order);
    }

    res.render('pages/order', {
      title: `Order #${order.order_no} | ${config.storeName}`,
      metaDesc: `Order details and status for #${order.order_no}`,
      order,
      upiDetails,
      site: config.siteContent,
      config
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 6. Order Tracking (/track)
 */
router.get('/track', async (req, res, next) => {
  const orderNo = (req.query.order || '').toUpperCase().trim();
  const phone4 = (req.query.phone4 || '').trim();

  let trackResult = null;
  let trackError = null;

  if (orderNo && phone4) {
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    if (!checkRateLimit(`track:${ip}`, 30, 600000)) {
      trackError = 'Too many tracking inquiries. Please wait a few minutes before trying again.';
    } else {
      try {
        trackResult = await api.trackOrder(orderNo, phone4);
      } catch (err) {
        if (err.status === 404) {
          trackError = 'No order found matching this order number and the last 4 digits of the phone number.';
        } else if (err.status === 429) {
          trackError = 'Too many tracking lookups from your connection. Please wait a moment.';
        } else {
          trackError = err.message || 'Unable to retrieve tracking details at this time.';
        }
      }
    }
  }

  res.render('pages/track', {
    title: `Track Your Order | ${config.storeName}`,
    metaDesc: 'Live tracking timeline for your handcrafted garment shipment.',
    orderNo,
    phone4,
    trackResult,
    trackError,
    site: config.siteContent,
    config
  });
});

router.post('/track', (req, res) => {
  const { order_no, phone4 } = req.body;
  const orderParam = encodeURIComponent(String(order_no || '').trim());
  const phoneParam = encodeURIComponent(String(phone4 || '').trim());
  res.redirect(`/track?order=${orderParam}&phone4=${phoneParam}`);
});

/**
 * 7. About (/about)
 */
router.get('/about', (req, res) => {
  res.render('pages/about', {
    title: `Our Story & Philosophy | ${config.storeName}`,
    metaDesc: config.siteContent.about.lead,
    site: config.siteContent,
    config
  });
});

/**
 * 8. Contact (/contact)
 */
router.get('/contact', (req, res) => {
  res.render('pages/contact', {
    title: `Contact & Atelier Concierge | ${config.storeName}`,
    metaDesc: `Visit our atelier in ${config.storeAddress} or chat directly with our stylists on WhatsApp.`,
    site: config.siteContent,
    config
  });
});

/**
 * 9. SEO: Robots & Sitemap
 */
router.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *\nDisallow: /admin\nDisallow: /admin/\nDisallow: /order/\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', async (req, res) => {
  try {
    const products = await api.getProducts();
    const urls = [
      { loc: `${config.siteUrl}/`, priority: '1.0', changefreq: 'daily' },
      { loc: `${config.siteUrl}/shop`, priority: '0.9', changefreq: 'daily' },
      { loc: `${config.siteUrl}/about`, priority: '0.7', changefreq: 'monthly' },
      { loc: `${config.siteUrl}/contact`, priority: '0.7', changefreq: 'monthly' },
      { loc: `${config.siteUrl}/track`, priority: '0.5', changefreq: 'monthly' }
    ];

    for (const p of products) {
      urls.push({
        loc: `${config.siteUrl}/product/${p.id}`,
        priority: '0.8',
        changefreq: 'weekly'
      });
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

    res.type('application/xml');
    res.send(xml);
  } catch {
    res.status(500).end();
  }
});

/**
 * 10. Health check endpoint
 * Independent of shop-api so Docker healthchecks pass even during backend warmups.
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
