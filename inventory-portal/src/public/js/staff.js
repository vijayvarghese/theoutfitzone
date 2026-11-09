/**
 * Staff Inventory Portal Interactive Scripts
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Universal Modal System
  const openModal = (modalId) => {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('is-active');
      document.body.style.overflow = 'hidden';
      const firstInput = modal.querySelector('input:not([type="hidden"]), select, textarea');
      if (firstInput) setTimeout(() => firstInput.focus(), 50);
    }
  };

  const closeModal = (modal) => {
    if (modal) {
      modal.classList.remove('is-active');
      document.body.style.overflow = '';
    }
  };

  // Triggers to open modals
  document.querySelectorAll('[data-modal-target]').forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = trigger.getAttribute('data-modal-target');
      openModal(targetId);
    });
  });

  // Triggers to close modals
  document.querySelectorAll('[data-modal-close], .modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal-overlay');
      closeModal(modal);
    });
  });

  // Close on outside click
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal);
      }
    });
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.is-active').forEach(closeModal);
    }
  });

  // 2. Pre-fill Quick Stock Adjust Modal
  document.querySelectorAll('.btn-open-adjust-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      const vId = btn.dataset.variantId;
      const sku = btn.dataset.sku;
      const prodName = btn.dataset.productName;
      const onHand = btn.dataset.onHand;
      const reserved = btn.dataset.reserved;

      const modal = document.getElementById('modal-stock-adjust');
      if (!modal) return;

      modal.querySelector('input[name="variant_id"]').value = vId;
      modal.querySelector('#modal-adjust-sku').textContent = sku;
      modal.querySelector('#modal-adjust-product').textContent = prodName;
      modal.querySelector('#modal-adjust-onhand').textContent = onHand;
      modal.querySelector('#modal-adjust-reserved').textContent = reserved;

      const valInput = modal.querySelector('input[name="value"]');
      if (valInput) {
        valInput.value = '';
      }

      openModal('modal-stock-adjust');
    });
  });

  // 3. Pre-fill Edit Variant Details Modal
  document.querySelectorAll('.btn-open-edit-variant').forEach(btn => {
    btn.addEventListener('click', () => {
      const vId = btn.dataset.variantId;
      const sku = btn.dataset.sku;
      const size = btn.dataset.size || '';
      const colour = btn.dataset.colour || '';
      const reorder = btn.dataset.reorder || '2';

      const modal = document.getElementById('modal-edit-variant');
      if (!modal) return;

      const form = modal.querySelector('form');
      if (form) form.action = `/stock/variants/${vId}`;

      modal.querySelector('input[name="sku"]').value = sku;
      modal.querySelector('input[name="size"]').value = size;
      modal.querySelector('input[name="colour"]').value = colour;
      modal.querySelector('input[name="reorder_level"]').value = reorder;

      openModal('modal-edit-variant');
    });
  });

  // 4. Pre-fill Fast Image Upload Modal
  document.querySelectorAll('.btn-open-image-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      const pId = btn.dataset.productId;
      const pName = btn.dataset.productName;
      const curImg = btn.dataset.imageUrl;

      const modal = document.getElementById('modal-upload-image');
      if (!modal) return;

      const form = modal.querySelector('form');
      if (form) form.action = `/products/${pId}/upload-image`;

      modal.querySelector('#modal-image-product-name').textContent = pName;

      const curImgElem = modal.querySelector('#modal-image-current');
      if (curImgElem) {
        if (curImg) {
          curImgElem.src = curImg;
          curImgElem.style.display = 'block';
        } else {
          curImgElem.style.display = 'none';
        }
      }

      openModal('modal-upload-image');
    });
  });

  // 5. Drag-and-Drop Image Preview Handler
  document.querySelectorAll('.dropzone').forEach(dropzone => {
    const fileInput = dropzone.querySelector('input[type="file"]');
    const previewContainer = dropzone.querySelector('.dropzone-preview');
    const previewImg = dropzone.querySelector('.preview-img');
    const previewName = dropzone.querySelector('.preview-name');

    if (!fileInput) return;

    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        fileInput.files = e.dataTransfer.files;
        handleFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        handleFile(fileInput.files[0]);
      }
    });

    const handleFile = (file) => {
      if (!file.type.match(/^image\//)) {
        alert('Please choose an image file (PNG, JPG, WebP, SVG, AVIF).');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        if (previewImg) previewImg.src = e.target.result;
        if (previewName) previewName.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
        if (previewContainer) previewContainer.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    };
  });

  // 6. Dynamic Variant Rows Generator for Add Product Page
  const btnAddVarRow = document.getElementById('btn-add-var-row');
  const varRowContainer = document.getElementById('initial-variants-container');
  if (btnAddVarRow && varRowContainer) {
    btnAddVarRow.addEventListener('click', () => {
      const idx = varRowContainer.querySelectorAll('.variant-builder-row').length + 1;
      const row = document.createElement('div');
      row.className = 'variant-builder-row';
      row.style.cssText = 'display: grid; grid-template-columns: 1fr 100px 120px 100px 90px 36px; gap: 8px; margin-bottom: 8px; align-items: center;';
      row.innerHTML = `
        <input type="text" name="var_sku" class="form-input" placeholder="e.g. SILK-BLU-L" style="font-family: var(--font-mono); text-transform: uppercase;">
        <input type="text" name="var_size" class="form-input" placeholder="Size (L)">
        <input type="text" name="var_colour" class="form-input" placeholder="Colour">
        <input type="number" name="var_stock" class="form-input" value="0" min="0">
        <input type="number" name="var_reorder" class="form-input" value="2" min="0">
        <button type="button" class="btn btn-sm btn-outline-danger btn-remove-row" style="padding: 0; width: 34px; height: 38px;" title="Remove row">✕</button>
      `;
      varRowContainer.appendChild(row);
      row.querySelector('.btn-remove-row').addEventListener('click', () => row.remove());
    });
  }

  // 7. Dangerous Actions Confirmation
  document.querySelectorAll('.confirm-action').forEach(form => {
    form.addEventListener('submit', (e) => {
      const msg = form.getAttribute('data-confirm-message') || 'Are you sure you want to perform this action?';
      if (!window.confirm(msg)) {
        e.preventDefault();
      }
    });
  });

  // 8. Category Selector Switcher (Select existing vs Type new)
  const catSelect = document.getElementById('category-select');
  const customCatGroup = document.getElementById('custom-category-group');
  if (catSelect && customCatGroup) {
    catSelect.addEventListener('change', () => {
      if (catSelect.value === '__new__') {
        customCatGroup.style.display = 'block';
        customCatGroup.querySelector('input')?.focus();
      } else {
        customCatGroup.style.display = 'none';
      }
    });
  }
});
