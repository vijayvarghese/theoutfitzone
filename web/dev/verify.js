/**
 * Comprehensive End-to-End Verification Test Suite
 * Spins up dev/mock-api.js on :3001 and server.js on :8081.
 * Tests every requirement, page, state transition, edge case, and security check.
 */
const { spawn } = require('child_process');

const MOCK_PORT = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : 3001;
const APP_PORT = process.env.APP_PORT ? parseInt(process.env.APP_PORT, 10) : 8081;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('--- Starting Mock API and Storefront Server ---');

  const mockApi = spawn('node', ['dev/mock-api.js'], {
    env: { ...process.env, PORT: String(MOCK_PORT), API_KEY: 'test-secret-key-16-chars-min' },
    stdio: 'inherit'
  });

  const appEnv = {
    ...process.env,
    PORT: String(APP_PORT),
    NODE_ENV: 'test',
    SHOP_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
    SHOP_API_KEY: 'test-secret-key-16-chars-min',
    SESSION_SECRET: 'super-secret-session-key-at-least-32-characters-long',
    ADMIN_PASSWORD: 'atelier-secret-admin',
    STORE_NAME: 'Aura & Thread Atelier',
    STORE_TAGLINE: 'Slow-crafted Indian silhouettes in fine handloom cottons and mulberry silks',
    SITE_URL: `http://localhost:${APP_PORT}`,
    UPI_VPA: 'aurathread@okaxis',
    UPI_PAYEE_NAME: 'Aura and Thread Atelier',
    WHATSAPP_NUMBER: '919876543210',
    INSTAGRAM_HANDLE: 'aurathread.atelier',
    CONTACT_PHONE: '+91 98765 43210',
    CONTACT_EMAIL: 'concierge@aurathread.com',
    STORE_ADDRESS: '42, Khader Nawaz Khan Road, Nungambakkam, Chennai 600006',
    STORE_HOURS: 'Mon – Sat: 10:30 AM – 8:00 PM | Sun: 11:30 AM – 6:00 PM',
    MAPS_URL: 'https://maps.google.com/?q=Chennai',
    SHIPPING_FLAT: '100',
    FREE_SHIPPING_ABOVE: '2500',
    TRUST_PROXY: '0'
  };

  const appServer = spawn('node', ['server.js'], {
    env: appEnv,
    stdio: 'inherit'
  });

  const cleanup = () => {
    try { mockApi.kill(); } catch {}
    try { appServer.kill(); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

  await sleep(1500);

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} ${detail}`);
      failed++;
    }
  }

  // Cookie Jar helper
  let cookieJar = new Map();
  function updateCookies(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    for (const c of raw) {
      if (!c) continue;
      const parts = c.split(';')[0].split('=');
      if (parts.length >= 2) {
        cookieJar.set(parts[0].trim(), parts.slice(1).join('=').trim());
      }
    }
  }

  function getCookieHeader() {
    return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  try {
    // 1. Health check (independent of API)
    const healthRes = await fetch(`${BASE_URL}/health`);
    const healthJson = await healthRes.json();
    assert(healthRes.status === 200 && healthJson.status === 'ok', 'GET /health returns 200 ok');

    // 2. Landing Page (/)
    const homeRes = await fetch(`${BASE_URL}/`);
    updateCookies(homeRes);
    const homeHtml = await homeRes.text();
    assert(homeRes.status === 200, 'GET / returns 200');
    assert(homeHtml.includes('Aura & Thread Atelier') || homeHtml.includes('Aura &amp; Thread Atelier'), 'Landing contains store name');
    assert(homeHtml.includes('Shop by Category'), 'Landing contains category section');
    assert(homeHtml.includes('New Arrivals'), 'Landing contains New Arrivals section');
    assert(homeHtml.includes('Slow Fashion Manifesto'), 'Landing contains Dark Band story strip');

    // Extract CSRF token
    const csrfMatch = homeHtml.match(/name="csrf-token" content="([a-f0-9]+)"/) || homeHtml.match(/name="csrf_token" value="([a-f0-9]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    assert(csrfToken.length === 64, `CSRF token initialized in session (found ${csrfToken.length} chars)`);

    // 3. Shop Page (/shop)
    const shopRes = await fetch(`${BASE_URL}/shop`, { headers: { 'Cookie': getCookieHeader() } });
    updateCookies(shopRes);
    const shopHtml = await shopRes.text();
    assert(shopRes.status === 200, 'GET /shop returns 200');
    assert(shopHtml.includes('The Dress Collection'), 'Shop page title present');
    assert(shopHtml.includes('Kora Handloom Tiered Midi Dress'), 'Product listing present');
    assert(shopHtml.includes('Sold Out'), 'Sold Out badge appears on out-of-stock piece');
    assert(shopHtml.includes('Only 1 left') || shopHtml.includes('Only 2 left') || shopHtml.includes('Only 3 left') || shopHtml.includes('Only 4 left'), 'Low stock badge appears');

    // Test Search filter
    const searchRes = await fetch(`${BASE_URL}/shop?q=Angrakha`, { headers: { 'Cookie': getCookieHeader() } });
    const searchHtml = await searchRes.text();
    assert(searchHtml.includes('Chanderi Floral Angrakha'), 'Search filter works server-side');

    // 4. Standalone Product Page (/product/1)
    const prodRes = await fetch(`${BASE_URL}/product/1`, { headers: { 'Cookie': getCookieHeader() } });
    const prodHtml = await prodRes.text();
    assert(prodRes.status === 200, 'GET /product/1 returns 200');
    assert(prodHtml.includes('Kora Handloom Tiered Midi Dress'), 'Product details present');
    assert(prodHtml.includes('Choose Size &amp; Colour:') || prodHtml.includes('Choose Size & Colour:'), 'Variant picker present');

    // 5. Add to Cart (AJAX)
    const addRes = await fetch(`${BASE_URL}/cart/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': getCookieHeader(),
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ sku: 'KOR-IVR-M', qty: 1, csrf_token: csrfToken })
    });
    updateCookies(addRes);
    const addData = await addRes.json();
    assert(addData.success === true, `POST /cart/add succeeds: ${addData.error || 'ok'}`);
    assert(addData.cart && addData.cart.itemCount >= 1, 'Cart count incremented');
    assert(addData.cart && addData.cart.subtotal === 4250, 'Price fetched strictly from API (₹4250)');

    // 6. View Cart (/cart)
    const cartRes = await fetch(`${BASE_URL}/cart`, { headers: { 'Cookie': getCookieHeader() } });
    updateCookies(cartRes);
    const cartHtml = await cartRes.text();
    assert(cartRes.status === 200, 'GET /cart returns 200');
    assert(cartHtml.includes('KOR-IVR-M'), 'Cart contains added SKU');
    assert(cartHtml.includes('Complimentary'), 'Orders > 2500 get free shipping');

    // 7. Checkout Page (/checkout)
    const checkoutRes = await fetch(`${BASE_URL}/checkout`, { headers: { 'Cookie': getCookieHeader() } });
    updateCookies(checkoutRes);
    const checkoutHtml = await checkoutRes.text();
    assert(checkoutRes.status === 200, 'GET /checkout returns 200');
    assert(checkoutHtml.includes('idempotency_key'), 'Checkout contains idempotency key');

    const idemMatch = checkoutHtml.match(/name="idempotency_key" value="([^"]+)"/);
    const idemKey = idemMatch ? idemMatch[1] : 'test-idem-key';

    // 8. Checkout Validation Fail (invalid phone & pincode)
    const invalidCheckoutRes = await fetch(`${BASE_URL}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookieHeader()
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        idempotency_key: idemKey,
        name: 'A',
        phone: '123',
        address: 'Short',
        pincode: '99',
        payment_mode: 'UPI'
      }).toString()
    });
    updateCookies(invalidCheckoutRes);
    const invalidHtml = await invalidCheckoutRes.text();
    assert(invalidCheckoutRes.status === 400, 'Invalid checkout returns 400');
    assert(invalidHtml.includes('Please enter a valid 10-digit Indian mobile number'), 'Inline phone error displayed');
    assert(invalidHtml.includes('Please enter a valid 6-digit Indian PIN code'), 'Inline pincode error displayed');

    // 9. Successful Order Placement
    const validCheckoutRes = await fetch(`${BASE_URL}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookieHeader()
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        idempotency_key: idemKey,
        name: 'Asha Sundaram',
        phone: '9876543210',
        address: 'Villa 12, Palm Meadows, Whitefield, Bengaluru',
        pincode: '560066',
        payment_mode: 'UPI',
        notes: 'Fragile handloom package'
      }).toString(),
      redirect: 'manual'
    });
    updateCookies(validCheckoutRes);

    assert(validCheckoutRes.status === 302, 'Successful checkout redirects (302)');
    const orderLocation = validCheckoutRes.headers.get('location');
    assert(orderLocation.startsWith('/order/DS-2611-'), `Redirected to order URL: ${orderLocation}`);
    const orderNo = orderLocation.replace('/order/', '');

    // 10. Order Page with UPI Payment Panel
    const orderRes = await fetch(`${BASE_URL}${orderLocation}`, { headers: { 'Cookie': getCookieHeader() } });
    updateCookies(orderRes);
    const orderHtml = await orderRes.text();
    assert(orderRes.status === 200, 'GET /order/:orderNo returns 200');
    assert(orderHtml.includes('Complete Your UPI Payment'), 'UPI Payment title displayed');
    assert(orderHtml.includes('upi://pay?pa=aurathread%40okaxis'), 'NPCI UPI URI correctly encoded');
    assert(orderHtml.includes('<svg'), 'Inline SVG QR Code rendered');
    assert(orderHtml.includes('Send Payment Screenshot on WhatsApp'), 'Honest manual verification CTA present');
    assert(orderHtml.includes('id="upi-countdown"'), 'Live countdown timer present');

    // 10b. Verify 409 OUT_OF_STOCK handling during checkout
    // Add item to cart in a fresh session
    const oosSessionCookies = new Map();
    const initOosRes = await fetch(`${BASE_URL}/shop`);
    const oosRawCookies = typeof initOosRes.headers.getSetCookie === 'function' ? initOosRes.headers.getSetCookie() : [initOosRes.headers.get('set-cookie')];
    for (const c of oosRawCookies) {
      if (!c) continue;
      const parts = c.split(';')[0].split('=');
      if (parts.length >= 2) oosSessionCookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
    }
    let oosCookieHeader = Array.from(oosSessionCookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const oosShopHtml = await initOosRes.text();
    const oosCsrfMatch = oosShopHtml.match(/name="csrf-token" content="([a-f0-9]+)"/);
    const oosCsrf = oosCsrfMatch ? oosCsrfMatch[1] : '';

    // Add 1 piece of KOR-IND-L while it is in stock
    const oosAddRes = await fetch(`${BASE_URL}/cart/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': oosCookieHeader,
        'X-CSRF-Token': oosCsrf
      },
      body: JSON.stringify({ sku: 'KOR-IND-L', qty: 1, csrf_token: oosCsrf })
    });
    const addRawCookies = typeof oosAddRes.headers.getSetCookie === 'function' ? oosAddRes.headers.getSetCookie() : [oosAddRes.headers.get('set-cookie')];
    for (const c of addRawCookies) {
      if (!c) continue;
      const parts = c.split(';')[0].split('=');
      if (parts.length >= 2) oosSessionCookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
    }
    oosCookieHeader = Array.from(oosSessionCookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

    // Now simulate race condition: backend stock is purchased by another channel right before checkout submit!
    await fetch(`http://127.0.0.1:${MOCK_PORT}/api/stock/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-secret-key-16-chars-min'
      },
      body: JSON.stringify({ sku: 'KOR-IND-L', delta: -1, reason: 'Walkin sale race condition' })
    });

    const oosSubmitRes = await fetch(`${BASE_URL}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': oosCookieHeader
      },
      body: new URLSearchParams({
        csrf_token: oosCsrf,
        idempotency_key: 'test-race-oos-idem',
        name: 'Sunita Rao',
        phone: '9811223344',
        address: '10 Richmond Road, Bengaluru',
        pincode: '560025',
        payment_mode: 'UPI'
      }).toString(),
      redirect: 'manual'
    });
    assert(oosSubmitRes.status === 302, 'Race condition 409 redirects (302)');
    console.log('ACTUAL REDIRECT:', oosSubmitRes.headers.get('location')); assert(oosSubmitRes.headers.get('location') === '/cart', '409 OUT_OF_STOCK returns visitor to /cart');

    const oosCartRes = await fetch(`${BASE_URL}/cart`, { headers: { 'Cookie': oosCookieHeader } });
    const oosCartHtml = await oosCartRes.text();
    assert(oosCartHtml.includes('left in stock') || oosCartHtml.includes('sold out'), 'Friendly out-of-stock notification displayed');

    // 11. Tracking (/track)
    const trackRes = await fetch(`${BASE_URL}/track?order=${orderNo}&phone4=3210`);
    const trackHtml = await trackRes.text();
    assert(trackRes.status === 200, 'GET /track with valid phone4 returns 200');
    assert(trackHtml.includes('PENDING_PAYMENT') || trackHtml.includes('Order Received'), 'Tracking displays order status');

    const wrongTrackRes = await fetch(`${BASE_URL}/track?order=${orderNo}&phone4=9999`);
    const wrongTrackHtml = await wrongTrackRes.text();
    assert(wrongTrackHtml.includes('No order found matching this order number'), 'Wrong phone4 displays friendly 404 message');

    // 12. Admin Login & Order Operations
    const adminLoginRes = await fetch(`${BASE_URL}/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookieHeader()
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        password: 'atelier-secret-admin'
      }).toString(),
      redirect: 'manual'
    });
    updateCookies(adminLoginRes);
    assert(adminLoginRes.status === 302, 'Admin login with correct password succeeds (302)');

    // Admin Orders List
    const adminOrdersRes = await fetch(`${BASE_URL}/admin/orders`, { headers: { 'Cookie': getCookieHeader() } });
    updateCookies(adminOrdersRes);
    const adminOrdersHtml = await adminOrdersRes.text();
    assert(adminOrdersRes.status === 200, 'GET /admin/orders returns 200');
    assert(adminOrdersHtml.includes(orderNo), 'Placed order visible in admin queue');

    // Admin Order Detail
    const adminDetailRes = await fetch(`${BASE_URL}/admin/orders/${orderNo}`, { headers: { 'Cookie': getCookieHeader() } });
    const adminDetailHtml = await adminDetailRes.text();
    assert(adminDetailRes.status === 200, 'GET /admin/orders/:orderNo returns 200');
    assert(adminDetailHtml.includes('Mark Paid &amp; Confirm') || adminDetailHtml.includes('Mark Paid & Confirm'), 'Mark Paid button visible for unpaid order');

    // Admin Action: Mark Paid
    const markPaidRes = await fetch(`${BASE_URL}/admin/orders/${orderNo}/paid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookieHeader()
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        payment_ref: 'BANK-UTR-99887766'
      }).toString(),
      redirect: 'manual'
    });
    updateCookies(markPaidRes);
    assert(markPaidRes.status === 302, 'POST /admin/orders/:orderNo/paid succeeds');

    // Verify status moved to CONFIRMED
    const updatedDetailRes = await fetch(`${BASE_URL}/admin/orders/${orderNo}`, { headers: { 'Cookie': getCookieHeader() } });
    const updatedDetailHtml = await updatedDetailRes.text();
    assert(updatedDetailHtml.includes('CONFIRMED'), 'Order status automatically moved to CONFIRMED');
    assert(updatedDetailHtml.includes('Mark Packed'), 'Allowed action now includes Mark Packed');

    // Admin Action: Mark Packed
    await fetch(`${BASE_URL}/admin/orders/${orderNo}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': getCookieHeader() },
      body: new URLSearchParams({ csrf_token: csrfToken, status: 'PACKED' }).toString(),
      redirect: 'manual'
    });

    // Admin Action: Mark Shipped (with Courier & AWB)
    await fetch(`${BASE_URL}/admin/orders/${orderNo}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': getCookieHeader() },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        status: 'SHIPPED',
        courier: 'BlueDart Express',
        awb: 'BD88776655IN'
      }).toString(),
      redirect: 'manual'
    });

    // Verify Tracking page now shows Courier & AWB!
    const trackShippedRes = await fetch(`${BASE_URL}/track?order=${orderNo}&phone4=3210`);
    const trackShippedHtml = await trackShippedRes.text();
    assert(trackShippedHtml.includes('BlueDart Express'), 'Tracking shows courier');
    assert(trackShippedHtml.includes('BD88776655IN'), 'Tracking shows AWB code');

    // 13. Admin Stock Management
    const stockRes = await fetch(`${BASE_URL}/admin/stock`, { headers: { 'Cookie': getCookieHeader() } });
    const stockHtml = await stockRes.text();
    assert(stockRes.status === 200, 'GET /admin/stock returns 200');
    assert(stockHtml.includes('Stock Levels &amp; Auditing') || stockHtml.includes('Stock Levels & Auditing'), 'Stock overview loaded');
    assert(stockHtml.includes('Rule on Reserved Stock'), 'Warning about reserved stock present');

    // Admin Stock Adjustment (+10 pieces)
    const adjustRes = await fetch(`${BASE_URL}/admin/stock/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': getCookieHeader() },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        sku: 'KOR-IVR-M',
        delta: '10',
        reason: 'New loom batch delivery'
      }).toString(),
      redirect: 'manual'
    });
    assert(adjustRes.status === 302, 'POST /admin/stock/adjust succeeds');

    // 14. Editorial & SEO Routes
    const aboutRes = await fetch(`${BASE_URL}/about`);
    assert(aboutRes.status === 200, 'GET /about returns 200');

    const contactRes = await fetch(`${BASE_URL}/contact`);
    assert(contactRes.status === 200, 'GET /contact returns 200');

    const robotsRes = await fetch(`${BASE_URL}/robots.txt`);
    const robotsText = await robotsRes.text();
    assert(robotsText.includes('Disallow: /admin'), 'robots.txt disallows /admin');

    const sitemapRes = await fetch(`${BASE_URL}/sitemap.xml`);
    const sitemapText = await sitemapRes.text();
    assert(sitemapText.includes('<urlset'), 'sitemap.xml returns valid XML');

    // 15. 404 Page
    const notFoundRes = await fetch(`${BASE_URL}/nonexistent-page-slug`);
    assert(notFoundRes.status === 404, 'GET /nonexistent returns 404');

    console.log('\n----------------------------------------');
    console.log(`Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('----------------------------------------\n');

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    cleanup();
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
