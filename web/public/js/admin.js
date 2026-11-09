/**
 * Admin portal interactive scripts.
 * Manages action modals for order status transitions,
 * courier/AWB prompts, UTR inputs, and restock confirmations.
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Shipped Action Modal Handler
  const shippedForm = document.getElementById('action-shipped-form');
  if (shippedForm) {
    shippedForm.addEventListener('submit', (e) => {
      const courier = shippedForm.querySelector('input[name="courier"]')?.value?.trim();
      const awb = shippedForm.querySelector('input[name="awb"]')?.value?.trim();
      if (!courier || !awb) {
        e.preventDefault();
        alert('Please provide both Courier Name and AWB Tracking Number to mark as SHIPPED.');
      }
    });
  }

  // 2. Cancellation Confirmation
  const cancelForms = document.querySelectorAll('.action-cancel-form');
  cancelForms.forEach(form => {
    form.addEventListener('submit', (e) => {
      const confirmed = window.confirm('Are you certain you want to CANCEL this order? Reserved stock will be automatically released.');
      if (!confirmed) {
        e.preventDefault();
      }
    });
  });

  // 3. Mark Paid Prompt / Form
  const paidForm = document.getElementById('action-paid-form');
  if (paidForm) {
    paidForm.addEventListener('submit', (e) => {
      const ref = paidForm.querySelector('input[name="payment_ref"]')?.value?.trim();
      if (!ref) {
        const input = window.prompt('Enter Bank UTR / UPI Reference Number (recommended):', 'UPI-MANUAL-VERIFIED');
        if (input === null) {
          e.preventDefault();
          return;
        }
        let hidden = paidForm.querySelector('input[name="payment_ref"]');
        if (!hidden) {
          hidden = document.createElement('input');
          hidden.type = 'hidden';
          hidden.name = 'payment_ref';
          paidForm.appendChild(hidden);
        }
        hidden.value = input;
      }
    });
  }

  // 4. Quick status filter auto-submit
  const statusFilterSelect = document.getElementById('admin-status-filter');
  if (statusFilterSelect) {
    statusFilterSelect.addEventListener('change', () => {
      statusFilterSelect.closest('form')?.submit();
    });
  }

  // 5. Product Variant Inventory Table Controls (Master-Detail System)
  const masterTable = document.getElementById('inventory-master-table');
  const btnExpandAll = document.getElementById('btn-expand-all');
  const btnCollapseAll = document.getElementById('btn-collapse-all');
  const searchInput = document.getElementById('inventory-search');
  const countDisplay = document.getElementById('product-count-display');
  const sortSelect = document.getElementById('inventory-sort-select');

  if (masterTable) {
    const STORAGE_KEY = 'admin_stock_open_groups_v3';

    // Helper to persist currently open product IDs
    const saveOpenState = () => {
      if (searchInput && searchInput.value.trim().length > 0) return;
      const openIds = [];
      document.querySelectorAll('tbody.product-group').forEach(group => {
        const detailRow = group.querySelector('.variants-detail-row');
        if (detailRow && detailRow.classList.contains('is-open')) {
          openIds.push(group.dataset.productId);
        }
      });
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(openIds));
      } catch (_) {}
    };

    // Restore saved open state on page load
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const openSet = new Set(JSON.parse(saved));
        document.querySelectorAll('tbody.product-group').forEach(group => {
          const mRow = group.querySelector('.product-master-row');
          const dRow = group.querySelector('.variants-detail-row');
          const shouldOpen = openSet.has(group.dataset.productId);
          if (mRow && dRow) {
            if (shouldOpen) {
              mRow.classList.add('is-expanded');
              dRow.classList.add('is-open');
            } else {
              mRow.classList.remove('is-expanded');
              dRow.classList.remove('is-open');
            }
          }
        });
      }
    } catch (_) {}

    // Event delegation on table for master row click
    masterTable.addEventListener('click', (e) => {
      // Prevent toggle if clicking on interactive form elements
      if (e.target.closest('button, form, a, input, select, textarea')) return;

      const row = e.target.closest('.product-master-row');
      if (!row) return;

      const targetId = row.dataset.target;
      const detailRow = document.getElementById(targetId);
      if (detailRow) {
        const isOpen = detailRow.classList.contains('is-open');
        if (isOpen) {
          detailRow.classList.remove('is-open');
          row.classList.remove('is-expanded');
        } else {
          detailRow.classList.add('is-open');
          row.classList.add('is-expanded');
        }
        saveOpenState();
      }
    });

    // Expand All Button
    if (btnExpandAll) {
      btnExpandAll.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.product-master-row').forEach(r => r.classList.add('is-expanded'));
        document.querySelectorAll('.variants-detail-row').forEach(r => r.classList.add('is-open'));
        saveOpenState();
      });
    }

    // Collapse All Button
    if (btnCollapseAll) {
      btnCollapseAll.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.product-master-row').forEach(r => r.classList.remove('is-expanded'));
        document.querySelectorAll('.variants-detail-row').forEach(r => r.classList.remove('is-open'));
        saveOpenState();
      });
    }

    // Instant Sort Dropdown Control
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        const val = sortSelect.value;
        const groups = Array.from(masterTable.querySelectorAll('tbody.product-group'));

        groups.sort((a, b) => {
          if (val === 'id-asc') {
            return (parseInt(a.dataset.productId, 10) || 0) - (parseInt(b.dataset.productId, 10) || 0);
          }
          if (val === 'name-asc') {
            return (a.dataset.productName || '').localeCompare(b.dataset.productName || '');
          }
          if (val === 'name-desc') {
            return (b.dataset.productName || '').localeCompare(a.dataset.productName || '');
          }
          if (val === 'category-asc') {
            return (a.dataset.category || '').localeCompare(b.dataset.category || '');
          }
          if (val === 'variants-desc') {
            return (parseInt(b.dataset.variantCount, 10) || 0) - (parseInt(a.dataset.variantCount, 10) || 0);
          }
          if (val === 'stock-desc') {
            return (parseInt(b.dataset.availableStock, 10) || 0) - (parseInt(a.dataset.availableStock, 10) || 0);
          }
          if (val === 'stock-asc') {
            return (parseInt(a.dataset.availableStock, 10) || 0) - (parseInt(b.dataset.availableStock, 10) || 0);
          }
          return 0;
        });

        groups.forEach(g => masterTable.appendChild(g));
      });
    }

    // Client-side Search and Filter
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase().trim();
        let visibleCount = 0;
        const groups = Array.from(masterTable.querySelectorAll('tbody.product-group'));

        groups.forEach(group => {
          const mRow = group.querySelector('.product-master-row');
          const dRow = group.querySelector('.variants-detail-row');

          if (!q) {
            group.style.display = '';
            visibleCount++;
            return;
          }

          const name = group.dataset.productName || '';
          const cat = group.dataset.category || '';
          const skus = group.dataset.skus || '';
          const matches = name.includes(q) || cat.includes(q) || skus.includes(q);

          if (matches) {
            group.style.display = '';
            // Auto-expand detail row so user immediately sees matching SKU/data
            if (mRow && dRow) {
              mRow.classList.add('is-expanded');
              dRow.classList.add('is-open');
            }
            visibleCount++;
          } else {
            group.style.display = 'none';
          }
        });

        if (countDisplay) {
          countDisplay.textContent = q ? `${visibleCount} of ${groups.length}` : `${groups.length}`;
        }
      });
    }

    // Pre-fill SKU into top stock adjustment form
    document.querySelectorAll('.btn-fill-sku').forEach(btn => {
      btn.addEventListener('click', () => {
        const sku = btn.dataset.sku;
        const skuInput = document.getElementById('sku');
        const deltaInput = document.getElementById('delta');
        const formPanel = document.getElementById('stock-adjust-panel');

        if (skuInput) {
          skuInput.value = sku;
        }

        if (formPanel) {
          formPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
          formPanel.classList.remove('form-highlight-pulse');
          void formPanel.offsetWidth;
          formPanel.classList.add('form-highlight-pulse');
        }

        if (deltaInput) {
          setTimeout(() => deltaInput.focus(), 300);
        }
      });
    });
  }
});
