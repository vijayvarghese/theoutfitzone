/**
 * Cart Drawer and Cart Page Interactive Controller.
 * Handles in-place quantity updates, item deletions,
 * and live totals recalculation via AJAX.
 */

function formatInr(val) {
  return '₹' + Number(val || 0).toLocaleString('en-IN');
}

export function initCartController() {
  const drawerBody = document.querySelector('.drawer-body');
  const drawerFooter = document.querySelector('.drawer-footer');
  const cartTable = document.querySelector('.cart-table-body');

  // Handle click on qty stepper buttons & remove links
  document.addEventListener('click', async (e) => {
    const target = e.target;

    // Cart Drawer Remove
    if (target.matches('.drawer-item-remove, .cart-item-remove')) {
      e.preventDefault();
      const sku = target.dataset.sku;
      if (!sku) return;
      await updateCartRequest('/cart/remove', { sku });
      return;
    }

    // Cart Drawer Qty Stepper
    if (target.matches('.qty-step-btn')) {
      e.preventDefault();
      const sku = target.dataset.sku;
      const current = parseInt(target.dataset.qty, 10) || 1;
      const delta = parseInt(target.dataset.delta, 10) || 0;
      const newQty = current + delta;
      if (!sku) return;

      if (newQty <= 0) {
        await updateCartRequest('/cart/remove', { sku });
      } else {
        await updateCartRequest('/cart/update', { sku, qty: newQty });
      }
    }
  });

  // Listen for global cart update event
  window.addEventListener('cart:updated', (e) => {
    const cart = e.detail;
    renderDrawerCart(cart);
  });
}

async function updateCartRequest(url, payload) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
    document.querySelector('input[name="csrf_token"]')?.value;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ ...payload, csrf_token: csrfToken })
    });

    const data = await res.json();
    if (data.success && data.cart) {
      // Update badges
      document.querySelectorAll('.cart-icon-badge').forEach(b => {
        b.textContent = data.cart.itemCount;
      });

      // Update drawer
      renderDrawerCart(data.cart);

      // If we are on /cart page, reload to show synced order summaries
      if (window.location.pathname === '/cart') {
        window.location.reload();
      }
    }
  } catch (err) {
    console.error('Cart update failed:', err);
  }
}

function renderDrawerCart(cart) {
  const body = document.querySelector('.drawer-body');
  const footer = document.querySelector('.drawer-footer');
  if (!body) return;

  if (!cart.items || cart.items.length === 0) {
    body.innerHTML = `
      <div class="drawer-empty-state">
        <p class="font-serif" style="font-size: 1.25rem; margin-bottom: 8px;">Your bag is currently empty.</p>
        <p style="font-size: 0.85rem; margin-bottom: 20px;">Explore our handcrafted silhouettes and discover your perfect fit.</p>
        <a href="/shop" class="btn btn-secondary btn-sm cart-close-trigger">Explore Collection</a>
      </div>
    `;
    if (footer) footer.style.display = 'none';
    return;
  }

  if (footer) footer.style.display = 'flex';

  let itemsHtml = '';
  cart.items.forEach(it => {
    itemsHtml += `
      <div class="drawer-item" data-sku="${it.sku}">
        <div class="drawer-item-img-wrap">
          <div class="product-placeholder" style="width: 64px; height: 80px; font-size: 1rem;">
            <span class="placeholder-initials" style="font-size: 1.2rem;">${it.size}</span>
          </div>
        </div>
        <div class="drawer-item-details">
          <div>
            <div class="drawer-item-name">${it.product}</div>
            <div class="drawer-item-meta">${it.size} / ${it.colour}</div>
          </div>
          <div class="drawer-item-actions">
            <div class="qty-stepper">
              <button type="button" class="qty-btn qty-step-btn" data-sku="${it.sku}" data-qty="${it.qty}" data-delta="-1" aria-label="Decrease quantity">−</button>
              <span class="qty-val">${it.qty}</span>
              <button type="button" class="qty-btn qty-step-btn" data-sku="${it.sku}" data-qty="${it.qty}" data-delta="1" aria-label="Increase quantity">+</button>
            </div>
            <div class="drawer-item-price">${formatInr(it.price_inr * it.qty)}</div>
            <button type="button" class="drawer-item-remove" data-sku="${it.sku}" aria-label="Remove item">Remove</button>
          </div>
        </div>
      </div>
    `;
  });

  body.innerHTML = itemsHtml;

  // Update Footer totals
  const subtotalEl = document.querySelector('.drawer-subtotal-val');
  const shippingEl = document.querySelector('.drawer-shipping-val');
  const totalEl = document.querySelector('.drawer-total-val');
  const noticeEl = document.querySelector('.drawer-shipping-notice');

  if (subtotalEl) subtotalEl.textContent = formatInr(cart.subtotal);
  if (shippingEl) shippingEl.textContent = cart.shipping === 0 ? 'Free' : formatInr(cart.shipping);
  if (totalEl) totalEl.textContent = formatInr(cart.total);

  if (noticeEl) {
    if (cart.shipping === 0) {
      noticeEl.textContent = '✨ You have earned complimentary domestic shipping!';
    } else {
      noticeEl.textContent = `Add ${formatInr(cart.freeShippingDelta)} more for complimentary shipping.`;
    }
  }
}

document.addEventListener('DOMContentLoaded', initCartController);
