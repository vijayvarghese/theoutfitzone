/**
 * Configuration module.
 * Loads environment variables, validates required keys, and fails fast at startup
 * with descriptive guidance if any required variable is missing.
 */
const path = require('path');
const fs = require('fs');

const requiredKeys = [
  'SHOP_API_URL',
  'SHOP_API_KEY',
  'SESSION_SECRET',
  'ADMIN_PASSWORD',
  'STORE_NAME',
  'UPI_VPA',
  'UPI_PAYEE_NAME',
  'WHATSAPP_NUMBER'
];

const missing = [];
for (const key of requiredKeys) {
  if (!process.env[key] || !process.env[key].trim()) {
    missing.push(key);
  }
}

if (missing.length > 0) {
  console.error('\n' + '='.repeat(70));
  console.error('FATAL STARTUP ERROR: Missing required environment variable(s):');
  for (const m of missing) {
    console.error(`  - ${m}`);
  }
  console.error('\nPlease set these variables in your .env or Docker Compose environment.');
  console.error('='.repeat(70) + '\n');
  process.exit(1);
}

// Load static site copy from content/site.json
let siteContent = {};
const contentPath = path.resolve(__dirname, '../content/site.json');
try {
  siteContent = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
} catch (err) {
  console.warn(`[config] Notice: Could not read content/site.json from ${contentPath}, using fallbacks:`, err.message);
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  shopApiUrl: process.env.SHOP_API_URL.replace(/\/+$/, ''),
  shopApiKey: process.env.SHOP_API_KEY,
  sessionSecret: process.env.SESSION_SECRET,
  adminPassword: process.env.ADMIN_PASSWORD,
  storeName: process.env.STORE_NAME || 'Aura & Thread Atelier',
  storeTagline: process.env.STORE_TAGLINE || (siteContent.brand && siteContent.brand.tagline) || 'Handcrafted silhouettes for modern living',
  siteUrl: (process.env.SITE_URL || 'http://localhost:8081').replace(/\/+$/, ''),
  upiVpa: process.env.UPI_VPA,
  upiPayeeName: process.env.UPI_PAYEE_NAME,
  whatsappNumber: (() => {
    const raw = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
    if (raw.length === 10) return '91' + raw;
    return raw;
  })(),
  instagramHandle: (process.env.INSTAGRAM_HANDLE || 'aurathread.atelier').replace(/^@/, ''),
  contactPhone: process.env.CONTACT_PHONE || '+91 98765 43210',
  contactEmail: process.env.CONTACT_EMAIL || 'concierge@aurathread.com',
  storeAddress: process.env.STORE_ADDRESS || '42, Khader Nawaz Khan Road, Nungambakkam, Chennai 600006',
  storeHours: process.env.STORE_HOURS || 'Mon – Sat: 10:30 AM – 8:00 PM | Sun: 11:30 AM – 6:00 PM',
  mapsUrl: process.env.MAPS_URL || 'https://maps.google.com/?q=Chennai',
  shippingFlat: Math.max(0, parseFloat(process.env.SHIPPING_FLAT || '100') || 0),
  freeShippingAbove: Math.max(0, parseFloat(process.env.FREE_SHIPPING_ABOVE || '2500') || 2500),
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  siteContent
};

module.exports = config;
