/**
 * Core client module.
 * Initialises Lenis smooth scrolling (desktop only, respects prefers-reduced-motion),
 * IntersectionObserver scroll reveals with stagger (--i),
 * hero parallax using requestAnimationFrame, and global Cart Drawer interactions.
 */

// Helper: check if reduced motion is preferred
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 1. Lenis Smooth Scrolling (Desktop only, never on reduced motion or mobile)
async function initSmoothScroll() {
  if (prefersReducedMotion || window.innerWidth < 1024) return;

  try {
    const { default: Lenis } = await import('/vendor/lenis/lenis.mjs');
    const lenis = new Lenis({
      duration: 1.1,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 0.9
    });

    function raf(time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);
  } catch (err) {
    // Graceful fallback to native browser scroll
    console.debug('Lenis smooth scroll skipped or unsupported:', err.message);
  }
}

// 2. IntersectionObserver Scroll Reveals
function initScrollReveals() {
  if (prefersReducedMotion) {
    document.querySelectorAll('.reveal-on-scroll').forEach(el => el.classList.add('is-revealed'));
    return;
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-revealed');
        obs.unobserve(entry.target);
      }
    });
  }, {
    rootMargin: '0px 0px -40px 0px',
    threshold: 0.1
  });

  document.querySelectorAll('.reveal-on-scroll').forEach(el => observer.observe(el));
}

// 3. Subtle Hero Image Parallax (Transform only via requestAnimationFrame)
function initHeroParallax() {
  if (prefersReducedMotion) return;
  const heroImage = document.querySelector('.hero-image');
  if (!heroImage) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        const scrolled = window.scrollY;
        if (scrolled < 900) {
          heroImage.style.transform = `scale(1.02) translateY(${scrolled * 0.12}px)`;
        }
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

// 4. Cart Drawer Global Controls
export function openCartDrawer() {
  const backdrop = document.getElementById('cart-drawer-backdrop');
  if (!backdrop) return;
  backdrop.classList.add('is-open');
  backdrop.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  const closeBtn = backdrop.querySelector('.drawer-close-btn');
  if (closeBtn) closeBtn.focus();

  // Ensure cart items and totals are fresh whenever drawer opens
  import('./cart.js').then(m => m.fetchAndRenderCart?.()).catch(() => {});
}

export function closeCartDrawer() {
  const backdrop = document.getElementById('cart-drawer-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('is-open');
  backdrop.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function initCartDrawerEvents() {
  const openTriggers = document.querySelectorAll('.cart-open-trigger');
  const closeTriggers = document.querySelectorAll('.cart-close-trigger');
  const backdrop = document.getElementById('cart-drawer-backdrop');

  openTriggers.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openCartDrawer();
    });
  });

  closeTriggers.forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (btn.tagName === 'A' && btn.getAttribute('href')) {
        closeCartDrawer();
        return;
      }
      e.preventDefault();
      closeCartDrawer();
    });
  });

  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeCartDrawer();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop?.classList.contains('is-open')) {
      closeCartDrawer();
    }
  });
}

// 5. Mobile Menu Toggle
function initMobileMenu() {
  const toggle = document.querySelector('.mobile-menu-toggle');
  const nav = document.querySelector('.header-nav');
  if (!toggle || !nav) return;
  if (toggle.dataset.menuInit === 'true') return;
  toggle.dataset.menuInit = 'true';

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!isExpanded));
    nav.classList.toggle('is-mobile-open');
  });

  // Close when clicking outside header/nav
  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target) && !toggle.contains(e.target) && nav.classList.contains('is-mobile-open')) {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  // Close when any nav link is tapped
  nav.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });

  // Close on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-mobile-open')) {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });

  // Close on resize to desktop (>= 900px)
  window.addEventListener('resize', () => {
    if (window.innerWidth >= 900 && nav.classList.contains('is-mobile-open')) {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  }, { passive: true });
}

// 6. Contact Page WhatsApp Form Handler
function initContactForm() {
  const form = document.getElementById('contact-whatsapp-form');
  if (!form) return;

  function doWhatsAppRedirect(e) {
    if (e) e.preventDefault();

    const nameInput = document.getElementById('contact-name');
    const topicInput = document.getElementById('contact-inquiry-type');
    const msgInput = document.getElementById('contact-message');

    const name = nameInput ? nameInput.value.trim() : '';
    const topic = topicInput ? topicInput.value : '';
    const msg = msgInput ? msgInput.value.trim() : '';
    const rawNumber = form.dataset.whatsapp || '';
    // Normalize to digits only, ensuring country code 91 for Indian 10-digit numbers
    let whatsappNumber = rawNumber.replace(/\D/g, '');
    if (whatsappNumber.length === 10) {
      whatsappNumber = '91' + whatsappNumber;
    }
    const storeName = form.dataset.storeName || 'The OutFit Zone';

    let formatted = `Hello ${storeName}!`;
    if (name) formatted += ` My name is ${name}.`;
    if (topic) formatted += ` Regarding [${topic}]:`;
    if (msg) {
      formatted += ` ${msg}`;
    } else {
      formatted += ` I would like to inquire about your collection and styling options.`;
    }

    const url = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(formatted)}`;

    // Open WhatsApp in a new tab/window, with fallback to direct redirect if popup is blocked
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win || win.closed || typeof win.closed === 'undefined') {
      window.location.href = url;
    }
  }

  form.addEventListener('submit', doWhatsAppRedirect);
  const submitBtn = document.getElementById('contact-whatsapp-submit') || form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.addEventListener('click', (e) => {
      doWhatsAppRedirect(e);
    });
  }
}

// 7. Order Confirmation Page Helpers (UPI Countdown & Copy Button)
function initOrderPage() {
  const countdownBox = document.getElementById('upi-countdown');
  if (countdownBox) {
    const expiresAtStr = countdownBox.dataset.expires;
    const expiresAt = new Date(expiresAtStr).getTime();
    const textEl = document.getElementById('countdown-text');

    function updateTimer() {
      const now = Date.now();
      const diff = expiresAt - now;

      if (diff <= 0) {
        if (textEl) textEl.textContent = 'Stock reservation window has elapsed.';
        countdownBox.style.background = '#FFEBEE';
        countdownBox.style.color = '#C62828';
        return;
      }

      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      if (textEl) textEl.textContent = `Stock held for ${minutes}m ${seconds}s`;
    }

    updateTimer();
    setInterval(updateTimer, 1000);
  }

  const copyBtn = document.getElementById('copy-vpa-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const vpa = copyBtn.dataset.vpa || '';
      try {
        await navigator.clipboard.writeText(vpa);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = originalText;
        }, 2000);
      } catch (err) {
        prompt('Copy your UPI ID manually:', vpa);
      }
    });
  }

  // Dynamic mobile platform link adaptation for Google Pay, PhonePe, and WhatsApp Pay
  const isAndroid = /android/i.test(navigator.userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isMobile = isAndroid || isIOS;

  const upiButtons = document.querySelectorAll('.upi-pay-btn');
  upiButtons.forEach(btn => {
    if (isAndroid && btn.dataset.android) {
      btn.href = btn.dataset.android;
    } else if (isIOS && btn.dataset.ios) {
      btn.href = btn.dataset.ios;
    } else if (btn.dataset.fallback) {
      btn.href = btn.dataset.fallback;
    }

    if (!isMobile) {
      btn.addEventListener('click', (e) => {
        const qrEl = document.querySelector('.upi-qr-wrapper');
        if (qrEl) {
          e.preventDefault();
          qrEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          qrEl.style.transition = 'transform 0.3s ease, box-shadow 0.3s ease';
          qrEl.style.transform = 'scale(1.05)';
          qrEl.style.boxShadow = '0 0 0 3px var(--color-oxblood)';
          setTimeout(() => {
            qrEl.style.transform = 'scale(1)';
            qrEl.style.boxShadow = 'none';
          }, 1200);
        }
      });
    }
  });
}

// 7. Shop Collection Sort Control
function initSortControl() {
  const sortSelect = document.querySelector('.sort-select');
  if (!sortSelect) return;
  sortSelect.addEventListener('change', () => {
    sortSelect.closest('form')?.submit();
  });
}

function initApp() {
  if (window.__atelierAppInitialized) return;
  window.__atelierAppInitialized = true;

  initSmoothScroll();
  initScrollReveals();
  initHeroParallax();
  initCartDrawerEvents();
  initMobileMenu();
  initContactForm();
  initOrderPage();
  initSortControl();
}

// DOM Ready initialization (handles deferred scripts where DOM is already loaded)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
