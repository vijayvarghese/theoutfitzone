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

  // Only the dedicated "Quick View" button opens the preview modal.
  // Product image and title links navigate directly to the standalone /product/:id page.
  const triggers = document.querySelectorAll('.quickview-trigger');
  triggers.forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();

      const card = trigger.closest('.product-card');
      const productId = card?.dataset?.productId;
      if (!productId) return;

      const dataScript = document.getElementById(`product-data-${productId}`);
      if (!dataScript) {
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

  if (titleEl) {
    titleEl.innerHTML = `<a href="/product/${p.id}" style="color: inherit; text-decoration: none;">${p.name}</a>`;
  }
  if (priceEl) priceEl.textContent = formatCurrency(p.price_inr);
  if (descEl) descEl.textContent = p.description || 'Exclusive handcrafted silhouette from our atelier collection.';

  // Media rendering: image or initials placeholder
  if (mediaContainer) {
    const initialImg = p.image_url;
    if (initialImg) {
      mediaContainer.innerHTML = `<img src="${initialImg}" alt="${p.name}" class="modal-product-img" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'product-placeholder\\'><span class=\\'placeholder-initials\\'>${getInitials(p.name)}</span></div>';" />`;
    } else {
      mediaContainer.innerHTML = `<div class="product-placeholder"><span class="placeholder-initials">${getInitials(p.name)}</span><span class="placeholder-tag">Aura & Thread</span></div>`;
    }
  }

  // Setup variants
  let selectedSku = null;
  let maxAvailable = 0;

  function getVariantImage(v) {
    if (!v) return p.image_url;
    if (v.image_url && v.image_url.trim()) return v.image_url.trim();
    // Fallback: check if another variant with the same colour has an image
    if (v.colour) {
      const colMatch = (p.variants || []).find(other => other.colour && other.colour.trim().toLowerCase() === v.colour.trim().toLowerCase() && other.image_url && other.image_url.trim());
      if (colMatch) return colMatch.image_url.trim();
    }
    return p.image_url;
  }

  function updateModalImage(v) {
    if (!mediaContainer) return;
    const targetUrl = getVariantImage(v);
    if (targetUrl && targetUrl.trim()) {
      const existingImg = mediaContainer.querySelector('.modal-product-img');
      if (existingImg) {
        if (existingImg.src !== targetUrl && !existingImg.src.endsWith(targetUrl)) {
          existingImg.style.transition = 'opacity 0.2s ease';
          existingImg.style.opacity = '0.5';
          existingImg.src = targetUrl;
          existingImg.onload = () => { existingImg.style.opacity = '1'; };
        }
      } else {
        mediaContainer.innerHTML = `<img src="${targetUrl}" alt="${p.name}" class="modal-product-img" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'product-placeholder\\'><span class=\\'placeholder-initials\\'>${getInitials(p.name)}</span></div>';" />`;
      }
    } else {
      mediaContainer.innerHTML = `<div class="product-placeholder"><span class="placeholder-initials">${getInitials(p.name)}</span><span class="placeholder-tag">Aura & Thread</span></div>`;
    }
  }

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

    // Group variants by colour to show dedicated Colour Selector chips
    const coloursMap = {};
    variants.forEach(v => {
      const col = (v.colour || 'Standard').trim();
      if (!coloursMap[col]) {
        coloursMap[col] = {
          name: col,
          image_url: v.image_url || null,
          variants: []
        };
      }
      if (v.image_url && !coloursMap[col].image_url) {
        coloursMap[col].image_url = v.image_url;
      }
      coloursMap[col].variants.push(v);
    });
    const colourList = Object.values(coloursMap);

    let activeColourNameEl = null;
    let colourChipsDiv = null;

    if (colourList.length > 1) {
      const colourGroup = document.createElement('div');
      colourGroup.style.cssText = 'margin-bottom: 12px;';

      const colourLabel = document.createElement('div');
      colourLabel.className = 'variant-label';
      colourLabel.style.cssText = 'margin-bottom: 6px;';
      colourLabel.innerHTML = `Select Colour: <strong class="modal-colour-name" style="color: var(--color-text); text-transform: none;">${defaultVariant?.colour || 'Standard'}</strong>`;
      colourGroup.appendChild(colourLabel);
      activeColourNameEl = colourLabel.querySelector('.modal-colour-name');

      colourChipsDiv = document.createElement('div');
      colourChipsDiv.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

      colourList.forEach(c => {
        const chip = document.createElement('button');
        chip.type = 'button';
        const isActive = c.name === (defaultVariant?.colour || '');
        chip.className = `btn-colour-chip ${isActive ? 'is-active' : ''}`;
        chip.dataset.colour = c.name;
        chip.style.cssText = `display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 11px; font-weight: 500; border: 1.5px solid ${isActive ? 'var(--color-oxblood)' : 'var(--color-border)'}; border-radius: var(--radius-xs); background: ${isActive ? 'rgba(94, 27, 38, 0.08)' : 'var(--color-bg)'}; color: var(--color-text); cursor: pointer; transition: all 0.2s;`;

        if (c.image_url) {
          const img = document.createElement('img');
          img.src = c.image_url;
          img.alt = c.name;
          img.style.cssText = 'width: 14px; height: 14px; border-radius: 50%; object-fit: cover;';
          chip.appendChild(img);
        }
        const span = document.createElement('span');
        span.textContent = c.name;
        chip.appendChild(span);

        chip.addEventListener('click', () => {
          colourChipsDiv.querySelectorAll('.btn-colour-chip').forEach(b => {
            b.classList.remove('is-active');
            b.style.borderColor = 'var(--color-border)';
            b.style.background = 'var(--color-bg)';
          });
          chip.classList.add('is-active');
          chip.style.borderColor = 'var(--color-oxblood)';
          chip.style.background = 'rgba(94, 27, 38, 0.08)';
          if (activeColourNameEl) activeColourNameEl.textContent = c.name;

          // Pick matching variant: prefer in stock
          const matchVar = c.variants.find(v => v.available > 0) || c.variants[0];
          if (matchVar) {
            selectedSku = matchVar.sku;
            updateStockDisplay(matchVar);
            updateModalImage(matchVar);
            pillsDiv.querySelectorAll('.variant-pill').forEach(pill => {
              pill.classList.toggle('is-selected', pill.dataset.sku === matchVar.sku);
            });
          }
        });

        colourChipsDiv.appendChild(chip);
      });

      colourGroup.appendChild(colourChipsDiv);
      variantContainer.appendChild(colourGroup);
    }

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
      pill.dataset.sku = v.sku;
      pill.dataset.colour = v.colour || '';
      pill.className = `variant-pill ${v.sku === selectedSku ? 'is-selected' : ''} ${v.available <= 0 ? 'is-disabled' : ''}`;
      pill.textContent = `${v.size} — ${v.colour} ${v.available <= 0 ? '(Sold out)' : ''}`;

      if (v.available > 0) {
        pill.addEventListener('click', () => {
          pillsDiv.querySelectorAll('.variant-pill').forEach(btn => btn.classList.remove('is-selected'));
          pill.classList.add('is-selected');
          selectedSku = v.sku;
          updateStockDisplay(v);
          updateModalImage(v);

          // Update colour chip active state if colour chips exist
          if (colourChipsDiv && v.colour) {
            if (activeColourNameEl) activeColourNameEl.textContent = v.colour;
            colourChipsDiv.querySelectorAll('.btn-colour-chip').forEach(cBtn => {
              const match = cBtn.dataset.colour === v.colour;
              cBtn.classList.toggle('is-active', match);
              cBtn.style.borderColor = match ? 'var(--color-oxblood)' : 'var(--color-border)';
              cBtn.style.background = match ? 'rgba(94, 27, 38, 0.08)' : 'var(--color-bg)';
            });
          }
        });
      }

      pillsDiv.appendChild(pill);
    });

    groupDiv.appendChild(pillsDiv);
    variantContainer.appendChild(groupDiv);

    // Link to standalone product page
    const detailLinkDiv = document.createElement('div');
    detailLinkDiv.style.cssText = 'margin-top: 10px; text-align: right;';
    detailLinkDiv.innerHTML = `<a href="/product/${p.id}" class="animated-link" style="font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-oxblood);">View Full Product Page &rarr;</a>`;
    variantContainer.appendChild(detailLinkDiv);

    if (defaultVariant) {
      updateStockDisplay(defaultVariant);
      updateModalImage(defaultVariant);
    } else {
      updateStockDisplay(null);
      updateModalImage(null);
      const emptyNotice = document.createElement('div');
      emptyNotice.style.cssText = 'font-size: 13px; color: var(--color-text-muted); margin-top: 6px;';
      emptyNotice.textContent = 'This silhouette is currently sold out in all sizes.';
      variantContainer.appendChild(emptyNotice);
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

function closeModal(modal) {
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.removeAttribute('open');
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
