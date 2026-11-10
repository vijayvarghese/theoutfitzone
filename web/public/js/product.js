/**
 * Product Page Client Controller.
 * Handles colour chip selection, dynamic variant dropdown synchronization,
 * smooth photography cross-fading, live stock badges, and AJAX cart addition.
 */
import { openCartDrawer } from './main.js';
import { renderDrawerCart } from './cart.js';

export function initProductPage() {
  const mediaContainer = document.getElementById('main-media-container');
  const variantSelect = document.getElementById('variant-select');
  if (!variantSelect) return;

  const chips = document.querySelectorAll('.btn-colour-chip');
  const colourNameEl = document.getElementById('current-colour-name');
  const qtyInput = document.getElementById('product-qty');
  const submitBtn = document.getElementById('product-submit-btn');
  const badgeEl = document.getElementById('main-stock-badge');
  const whatsappLink = document.getElementById('whatsapp-inquiry-link');
  const addForm = document.getElementById('product-add-form');

  const defaultProductImage = mediaContainer ? (mediaContainer.dataset.productImage || '').trim() : '';

  function updateProductState(opt) {
    if (!opt) return;

    const available = parseInt(opt.dataset.available || '0', 10);
    const optImage = (opt.dataset.image || '').trim();
    const optColour = (opt.dataset.colour || '').trim();
    const optSku = (opt.dataset.sku || '').trim();

    // 1. Update Quantity & Submit Button
    if (qtyInput) {
      qtyInput.max = available > 0 ? available : 1;
      if (parseInt(qtyInput.value, 10) > available && available > 0) {
        qtyInput.value = available;
      } else if (available <= 0) {
        qtyInput.value = 1;
      }
    }

    if (submitBtn) {
      if (available <= 0) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sold Out';
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add to Bag';
      }
    }

    // 2. Update Stock Badge
    if (badgeEl) {
      if (available <= 0) {
        badgeEl.className = 'card-badge card-badge-soldout';
        badgeEl.textContent = 'Sold Out';
        badgeEl.style.display = '';
      } else if (available <= 3) {
        badgeEl.className = 'card-badge card-badge-lowstock';
        badgeEl.textContent = `Only ${available} left`;
        badgeEl.style.display = '';
      } else {
        badgeEl.style.display = 'none';
      }
    }

    // 3. Update WhatsApp Inquire Link
    if (whatsappLink && optSku) {
      try {
        const url = new URL(whatsappLink.href);
        const currentText = url.searchParams.get('text') || '';
        const updatedText = currentText.replace(/\(SKU:[^)]*\)/, `(SKU: ${optSku})`);
        url.searchParams.set('text', updatedText);
        whatsappLink.href = url.toString();
      } catch {}
    }

    // 4. Update Colour Chips & Header Label
    if (optColour) {
      if (colourNameEl) colourNameEl.textContent = optColour;
      chips.forEach(chip => {
        const match = (chip.dataset.colour || '').trim().toLowerCase() === optColour.toLowerCase();
        chip.classList.toggle('is-active', match);
        chip.style.borderColor = match ? 'var(--color-oxblood)' : 'var(--color-border)';
        chip.style.backgroundColor = match ? 'rgba(94, 27, 38, 0.08)' : 'var(--color-bg)';
      });
    }

    // 5. Update Photo with Smooth Fade & Fallbacks
    if (mediaContainer) {
      const targetImage = optImage || defaultProductImage;
      let mainImg = document.getElementById('main-product-img');
      const placeholder = document.getElementById('main-placeholder');

      if (targetImage) {
        if (!mainImg) {
          mainImg = document.createElement('img');
          mainImg.id = 'main-product-img';
          mainImg.alt = 'Product photograph';
          mainImg.style.width = '100%';
          mainImg.style.height = '100%';
          mainImg.style.objectFit = 'cover';
          mainImg.style.transition = 'opacity 0.25s ease';
          mediaContainer.appendChild(mainImg);
        }
        if (mainImg.getAttribute('src') !== targetImage) {
          mainImg.style.opacity = '0.3';
          const temp = new Image();
          temp.onload = () => {
            mainImg.src = targetImage;
            mainImg.style.display = '';
            if (placeholder) placeholder.style.display = 'none';
            mainImg.style.opacity = '1';
          };
          temp.onerror = () => {
            if (defaultProductImage && targetImage !== defaultProductImage) {
              mainImg.src = defaultProductImage;
              mainImg.style.display = '';
              if (placeholder) placeholder.style.display = 'none';
              mainImg.style.opacity = '1';
            } else {
              mainImg.style.display = 'none';
              if (placeholder) placeholder.style.display = '';
            }
          };
          temp.src = targetImage;
        } else {
          mainImg.style.display = '';
          if (placeholder) placeholder.style.display = 'none';
        }
      } else {
        if (mainImg) mainImg.style.display = 'none';
        if (placeholder) placeholder.style.display = '';
      }
    }
  }

  // Variant dropdown change listener
  variantSelect.addEventListener('change', function() {
    updateProductState(this.options[this.selectedIndex]);
  });

  // Colour Chips click listener
  chips.forEach(chip => {
    chip.addEventListener('click', function(e) {
      e.preventDefault();
      const targetColour = (this.dataset.colour || '').trim().toLowerCase();
      const options = Array.from(variantSelect.options);

      // Find best match for this colour: prefer in-stock option
      const match = options.find(o => (o.dataset.colour || '').trim().toLowerCase() === targetColour && parseInt(o.dataset.available || '0', 10) > 0)
                 || options.find(o => (o.dataset.colour || '').trim().toLowerCase() === targetColour);

      if (match) {
        variantSelect.value = match.value;
        updateProductState(match);
      }
    });
  });

  // Progressive AJAX Add to Bag: pops open sidebar drawer instead of full-page redirect to /cart
  if (addForm) {
    addForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const selectedOption = variantSelect.options[variantSelect.selectedIndex];
      if (!selectedOption) return;

      const available = parseInt(selectedOption.dataset.available || '0', 10);
      if (available <= 0) return;

      const sku = selectedOption.value;
      const qty = parseInt(qtyInput ? qtyInput.value : '1', 10) || 1;
      const csrfToken = addForm.querySelector('input[name="csrf_token"]')?.value || '';

      const originalBtnText = submitBtn ? submitBtn.textContent : 'Add to Bag';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding to Bag...';
      }

      try {
        const res = await fetch('/cart/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-Token': csrfToken
          },
          body: JSON.stringify({ sku, qty, csrf_token: csrfToken })
        });

        const data = await res.json();
        if (data.success && data.cart) {
          // Update header badges
          document.querySelectorAll('.cart-icon-badge').forEach(b => {
            b.textContent = data.cart.itemCount;
          });

          // Render updated cart in drawer
          renderDrawerCart(data.cart);

          // Open the slide-in cart drawer
          openCartDrawer();

          // Dispatch event for any other listeners
          window.dispatchEvent(new CustomEvent('cart:updated', { detail: data.cart }));

          if (submitBtn) {
            submitBtn.textContent = 'Added to Bag ✓';
            setTimeout(() => {
              submitBtn.disabled = false;
              submitBtn.textContent = originalBtnText;
            }, 1800);
          }
        } else {
          alert(data.error || 'Could not add item to bag.');
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalBtnText;
          }
        }
      } catch (err) {
        console.error('Add to bag request failed:', err);
        // Fallback: standard form submit
        addForm.submit();
      }
    });
  }
}

// Auto-initialize when loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initProductPage);
} else {
  initProductPage();
}
