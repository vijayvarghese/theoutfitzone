/**
 * Cart management and live synchronization module.
 * Persists cart items in signed cookie session as { sku, qty }.
 * Re-validates prices and available inventory directly against shop-api
 * on every view, auto-clamping out-of-stock items and generating friendly notices.
 */
const api = require('./api');
const config = require('./config');

function getRawCart(req) {
  if (!req.session) return [];
  if (!Array.isArray(req.session.cart)) {
    req.session.cart = [];
  }
  return req.session.cart;
}

/**
 * Re-synchronizes cart against live backend stock and prices.
 * Updates session in-place and calculates totals.
 */
async function syncCart(req) {
  const rawItems = getRawCart(req);
  const syncedItems = [];
  const notices = [];

  for (const item of rawItems) {
    const sku = String(item.sku || '').trim();
    let qty = parseInt(item.qty, 10);
    if (!sku || isNaN(qty) || qty <= 0) continue;

    try {
      const stock = await api.getStock(sku);
      if (!stock || stock.active === false) {
        notices.push(`An item (${sku}) is no longer available and was removed.`);
        continue;
      }

      const available = Math.max(0, parseInt(stock.available, 10) || 0);

      if (available <= 0) {
        notices.push(`"${stock.product} (${stock.size})" is now sold out and was removed from your cart.`);
        continue;
      }

      if (qty > available) {
        notices.push(`"${stock.product} (${stock.size})" quantity was reduced to ${available} based on remaining stock.`);
        qty = available;
      }

      syncedItems.push({
        sku: stock.sku,
        product: stock.product,
        price_inr: stock.price_inr,
        size: stock.size,
        colour: stock.colour,
        image_url: stock.image_url || stock.variant_image_url || null,
        qty,
        available,
        line_total: stock.price_inr * qty
      });

    } catch (err) {
      if (err.status === 404) {
        notices.push(`Item ${sku} was removed because it is no longer in catalog.`);
      } else {
        // If API fails temporarily, retain item with last known info
        console.warn(`[cart] Could not verify stock for ${sku}:`, err.message);
        syncedItems.push(item);
      }
    }
  }

  // Update session to reflect validated state
  req.session.cart = syncedItems.map(it => ({ sku: it.sku, qty: it.qty }));

  const subtotal = syncedItems.reduce((acc, it) => acc + (it.line_total || (it.price_inr * it.qty) || 0), 0);
  const itemCount = syncedItems.reduce((acc, it) => acc + it.qty, 0);
  const isFreeShipping = subtotal >= config.freeShippingAbove || subtotal === 0;
  const shipping = isFreeShipping ? 0 : config.shippingFlat;
  const total = subtotal + shipping;
  const freeShippingDelta = Math.max(0, config.freeShippingAbove - subtotal);

  return {
    items: syncedItems,
    itemCount,
    subtotal,
    shipping,
    total,
    freeShippingDelta,
    isFreeShipping,
    notices
  };
}

async function addItem(req, sku, qtyToAdd = 1) {
  const skuClean = String(sku || '').trim();
  const qty = Math.max(1, parseInt(qtyToAdd, 10) || 1);
  if (!skuClean) throw new Error('Valid SKU is required');

  const stock = await api.getStock(skuClean);
  if (!stock || stock.available <= 0) {
    throw new Error(`"${stock?.product || skuClean}" is currently out of stock`);
  }

  const rawCart = getRawCart(req);
  const existing = rawCart.find(it => it.sku === skuClean);

  if (existing) {
    const desired = existing.qty + qty;
    existing.qty = Math.min(desired, stock.available);
  } else {
    rawCart.push({
      sku: skuClean,
      qty: Math.min(qty, stock.available)
    });
  }

  req.session.cart = rawCart;
  return await syncCart(req);
}

async function updateItem(req, sku, newQty) {
  const skuClean = String(sku || '').trim();
  const qty = parseInt(newQty, 10);
  let rawCart = getRawCart(req);

  if (isNaN(qty) || qty <= 0) {
    rawCart = rawCart.filter(it => it.sku !== skuClean);
  } else {
    const item = rawCart.find(it => it.sku === skuClean);
    if (item) item.qty = qty;
  }

  req.session.cart = rawCart;
  return await syncCart(req);
}

async function removeItem(req, sku) {
  const skuClean = String(sku || '').trim();
  const rawCart = getRawCart(req);
  req.session.cart = rawCart.filter(it => it.sku !== skuClean);
  return await syncCart(req);
}

function clearCart(req) {
  if (req.session) {
    req.session.cart = [];
  }
}

module.exports = {
  syncCart,
  addItem,
  updateItem,
  removeItem,
  clearCart
};
