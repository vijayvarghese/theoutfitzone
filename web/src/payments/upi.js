/**
 * UPI Direct Payment Provider.
 * Zero-fee, direct-to-bank UPI payment interface.
 * Implements a standard PaymentProvider interface so third-party gateways
 * (e.g. Razorpay, Cashfree) can replace or complement it if needed.
 */
const QRCode = require('qrcode');
const config = require('../config');

/**
 * Encodes standard National Payments Corporation of India (NPCI) UPI deep-link URI.
 */
function buildUpiUri({ vpa, payeeName, amount, orderNo, note }) {
  const am = Number(amount).toFixed(2);
  const pn = encodeURIComponent(payeeName || config.upiPayeeName);
  const pa = encodeURIComponent(vpa || config.upiVpa);
  const tn = encodeURIComponent(note || `Order ${orderNo}`);

  return `upi://pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`;
}

/**
 * Generates an inline SVG QR code server-side without external dependencies.
 */
async function generateQrCodeSvg(upiUri) {
  return new Promise((resolve, reject) => {
    QRCode.toString(
      upiUri,
      {
        type: 'svg',
        margin: 1,
        width: 240,
        color: {
          dark: '#14110F',
          light: '#00000000' // transparent background
        }
      },
      (err, svg) => {
        if (err) return reject(err);
        resolve(svg);
      }
    );
  });
}

/**
 * Generates formatted WhatsApp verification link for customer screenshot submission.
 */
function buildWhatsAppProofLink(orderNo, amount) {
  const amFormatted = Number(amount).toFixed(2);
  const message = `Hello ${config.storeName}! I have completed the UPI payment of ₹${amFormatted} for Order #${orderNo}. Here is my payment confirmation screenshot:`;
  return `https://wa.me/${config.whatsappNumber}?text=${encodeURIComponent(message)}`;
}

class UpiPaymentProvider {
  constructor() {
    this.name = 'UPI';
    this.label = 'UPI (Instant / Zero Fees)';
  }

  /**
   * Generates all presentation details needed for /order/:orderNo payment screen.
   */
  async getPaymentDetails(order) {
    const total = order.total || 0;
    const orderNo = order.order_no;

    const upiUri = buildUpiUri({
      vpa: config.upiVpa,
      payeeName: config.upiPayeeName,
      amount: total,
      orderNo: orderNo
    });

    const qrCodeSvg = await generateQrCodeSvg(upiUri);
    const whatsappProofUrl = buildWhatsAppProofLink(orderNo, total);

    return {
      provider: this.name,
      vpa: config.upiVpa,
      payeeName: config.upiPayeeName,
      amountFormatted: Number(total).toFixed(2),
      currency: 'INR',
      upiUri,
      qrCodeSvg,
      whatsappProofUrl,
      expiresAt: order.expires_at,
      instructions: [
        'Scan the QR code with any UPI app (Google Pay, PhonePe, Paytm, BHIM, Cred, or your bank app).',
        'Verify that the payee name matches "' + config.upiPayeeName + '".',
        'Once payment is complete, share your payment confirmation or UTR reference on WhatsApp for immediate verification.'
      ]
    };
  }
}

module.exports = new UpiPaymentProvider();
