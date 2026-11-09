/**
 * Quick View Modal Progressive Enhancement.
 * Intercepts product card clicks, loads variant data,
 * updates browser URL with history.pushState, manages focus trap and ARIA states,
 * and handles variant selection and AJAX cart addition.
 */
import { openCartDrawer } from './main.js';

let lastActiveElement = null;

function formatCurrency(num) {
  return '₹' + Number(num || 0).toLocaleString('en-IN');
}

export function initQuickView() {
  const modal = document.getElementById('quick-view-modal');
  if (!modal) return;

  const triggers = document.querySelectorAll('.quickview-trigger, .product-card-link');
  triggers.forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      // Allow cmd/ctrl + click to open standard /product/:id page in new tab
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();

      const card = trigger.closest('.product-card');
      const productId = card?.dataset?.productId;
      if (!productId) return;

      const dataScript = document.getElementById(`product-data-${productId}`);
      if (!dataScript) {
        // Fallback: navigate to standalone product page
        window.location.href = `/product/${productId}`;
        return;
      }

      try {
        const productData = JSON.parse(dataScript.textContent);
        lastActiveElement = trigger;
        openModalWithProduct(modal, productData);
      } catch (err) {
        console.error('Error parsing product data:', err);
        window.location.href = `/product/${productId}`;
      }
    });
  });

  // Modal close handlers
  const closeBtn = modal.querySelector('.modal-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeModal(modal));
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.hasAttribute('open')) {
      closeModal(modal);
    }
  });

  window.addEventListener('popstate', (e) => {
    if (modal.hasAttribute('open')) {
      closeModal(modal, false); // don't push state on popstate
    }
  });
}

function openModalWithProduct(modal, p) {
  const titleEl = modal.querySelector('.modal-title');
  const priceEl = modal.querySelector('.modal-price');
  const descEl = modal.querySelector('.modal-desc');
  const mediaContainer = modal.querySelector('.modal-product-media');
  const formEl = modal.querySelector('.modal-add-form');
  const variantContainer = modal.querySelector('.modal-variants-container');
  const qtyInput = modal.querySelector('.modal-qty-input');
  const qtyPlus = modal.querySelector('.modal-qty-plus');
  const qtyMinus = modal.querySelector('.modal-qty-minus');
  const submitBtn = modal.querySelector('.modal-submit-btn');
  const stockBadgeEl = modal.querySelector('.modal-stock-badge');

  if (titleEl) titleEl.textContent = p.name;
  if (priceEl) priceEl.textContent = formatCurrency(p.price_inr);
  if (descEl) descEl.textContent = p.description;

  // Media rendering: image or initials placeholder
  if (mediaContainer) {
    if (p.image_url) {
      mediaContainer.innerHTML = `<img src="${p.image_url}" alt="${p.name}" class="modal-product-img" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'product-placeholder\\'><span class=\\'placeholder-initials\\'>${getInitials(p.name)}</span></div>';" />`;
    } else {
      mediaContainer.innerHTML = `<div class="product-placeholder"><span class="placeholder-initials">${getInitials(p.name)}</span><span class="placeholder-tag">Aura & Thread</span></div>`;
    }
  }

  // Setup variants
  let selectedSku = null;
  let maxAvailable = 0;

  function updateStockDisplay(variant) {
    if (!variant || variant.available <= 0) {
      stockBadgeEl.textContent = 'Sold Out';
      stockBadgeEl.className = 'card-badge card-badge-soldout';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sold Out';
      maxAvailable = 0;
      qtyInput.value = 1;
      qtyInput.max = 1;
    } else {
      maxAvailable = variant.available;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add to Bag';
      qtyInput.max = variant.available;

      if (variant.available <= 3) {
        stockBadgeEl.textContent = `Only ${variant.available} left in this size`;
        stockBadgeEl.className = 'card-badge card-badge-lowstock';
      } else {
        stockBadgeEl.textContent = 'In Stock';
        stockBadgeEl.className = 'card-badge card-badge-instock';
      }
    }
  }

  // Render variant buttons
  if (variantContainer) {
    variantContainer.innerHTML = '';
    const variants = p.variants || [];

    // Find first available variant or default to first
    let defaultVariant = variants.find(v => v.available > 0) || variants[0];
    selectedSku = defaultVariant?.sku;

    const groupDiv = document.createElement('div');
    groupDiv.className = 'variant-group';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'variant-label';
    labelDiv.textContent = 'Select Size & Colour:';
    groupDiv.appendChild(labelDiv);

    const pillsDiv = document.createElement('div');
    pillsDiv.className = 'variant-options';

    variants.forEach(v => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `variant-pill ${v.sku === selectedSku ? 'is-selected' : ''} ${v.available <= 0 ? 'is-disabled' : ''}`;
      pill.textContent = `${v.size} — ${v.colour} ${v.available <= 0 ? '(Sold out)' : ''}`;

      if (v.available > 0) {
        pill.addEventListener('click', () => {
          groupDiv.querySelectorAll('.variant-pill').forEach(btn => btn.classList.remove('is-selected'));
          pill.classList.add('is-selected');
          selectedSku = v.sku;
          updateStockDisplay(v);
        });
      }

      pillsDiv.appendChild(pill);
    });

    groupDiv.appendChild(pillsDiv);
    variantContainer.appendChild(groupDiv);

    if (defaultVariant) {
      updateStockDisplay(defaultVariant);
    }
  }

  // Quantity Stepper controls
  if (qtyMinus && qtyPlus && qtyInput) {
    qtyInput.value = 1;
    qtyMinus.onclick = () => {
      let val = parseInt(qtyInput.value, 10) || 1;
      if (val > 1) qtyInput.value = val - 1;
    };
    qtyPlus.onclick = () => {
      let val = parseInt(qtyInput.value, 10) || 1;
      if (val < maxAvailable) qtyInput.value = val + 1;
    };
  }

  // Handle AJAX Form Submit
  if (formEl) {
    formEl.onsubmit = async (e) => {
      e.preventDefault();
      if (!selectedSku || maxAvailable <= 0) return;

      const qty = parseInt(qtyInput.value, 10) || 1;
      const csrfToken = formEl.querySelector('input[name="csrf_token"]')?.value;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding to Bag...';

      try {
        const res = await fetch('/cart/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-Token': csrfToken
          },
          body: JSON.stringify({ sku: selectedSku, qty, csrf_token: csrfToken })
        });

        const data = await res.json();
        if (data.success) {
          closeModal(modal);
          // Update header cart badge
          const badges = document.querySelectorAll('.cart-icon-badge');
          badges.forEach(b => {
            b.textContent = data.cart.itemCount;
          });
          // Update and open cart drawer
          openCartDrawer();
          window.dispatchEvent(new CustomEvent('cart:updated', { detail: data.cart }));
        } else {
          alert(data.error || 'Could not add item to bag.');
        }
      } catch (err) {
        console.error('Add to cart failed:', err);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add to Bag';
      }
    };
  }

  // Push state for shareable URL
  try {
    window.history.pushState({ modalOpen: true, productId: p.id }, '', `/product/${p.id}`);
  } catch {}

  // Open HTML5 Dialog
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }

  // Focus trap: focus close button
  const closeBtn = modal.querySelector('.modal-close-btn');
  if (closeBtn) closeBtn.focus();
}

function closeModal(modal, restoreHistory = true) {
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }

  if (restoreHistory && window.location.pathname.startsWith('/product/')) {
    try {
      window.history.pushState({}, '', '/shop');
    } catch {}
  }

  // Restore focus to clicked card
  if (lastActiveElement && typeof lastActiveElement.focus === 'function') {
    lastActiveElement.focus();
  }
}

function getInitials(name) {
  if (!name) return 'AT';
  const words = name.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'AT';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

document.addEventListener('DOMContentLoaded', initQuickView);
