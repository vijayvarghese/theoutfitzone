/**
 * Checkout Form Enhancer.
 * Validates 10-digit Indian phone numbers and 6-digit PIN codes on the client,
 * toggles payment option visuals, and prevents double-submission.
 */

document.addEventListener('DOMContentLoaded', () => {
  const checkoutForm = document.getElementById('checkout-form');
  if (!checkoutForm) return;

  const phoneInput = document.getElementById('phone');
  const pincodeInput = document.getElementById('pincode');
  const submitBtn = checkoutForm.querySelector('button[type="submit"]');

  // Strip non-digits from phone and restrict to 10 chars
  if (phoneInput) {
    phoneInput.addEventListener('input', () => {
      phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 10);
    });
  }

  // Strip non-digits from pincode and restrict to 6 chars
  if (pincodeInput) {
    pincodeInput.addEventListener('input', () => {
      pincodeInput.value = pincodeInput.value.replace(/\D/g, '').slice(0, 6);
    });
  }

  // Visual selection of payment cards
  const paymentCards = document.querySelectorAll('.payment-choice-card');
  paymentCards.forEach(card => {
    card.addEventListener('click', () => {
      paymentCards.forEach(c => c.classList.remove('is-active'));
      card.classList.add('is-active');
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
  });

  // Prevent double submissions
  checkoutForm.addEventListener('submit', () => {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Processing Order...';
    }
  });
});
