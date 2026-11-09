# Aura & Thread Atelier — Production Storefront Container

A complete, production-ready, server-rendered storefront website and back-office management portal designed for an independent dress store. Built as a single lightweight Docker container running Node 22 on Alpine Linux with Express 5, EJS, and self-hosted typography.

---

## Architecture & Footprint

- **Zero Client Bundlers**: Vanilla ES modules and plain CSS custom properties. No webpack, vite, babel, or frontend frameworks.
- **Server-Rendered**: Full SEO, Open Graph cards, accessible progressive enhancement (modal and cart drawer degrade to standard HTML pages without JavaScript).
- **Self-Hosted Typography**: Latin WOFF2 subsets of *Playfair Display* (headings) and *Inter* (body) self-hosted locally through `@fontsource` packages. Zero CDNs, zero external network requests.
- **Micro Footprint**:
  - Final Docker Image: **~194 MB** (target: <200 MB)
  - Idle RAM: **~18 MB** (target: <80 MB)
  - Landing page first load: **~160 KB** uncompressed (target: <300 KB)
  - Client JavaScript: **~17 KB** total uncompressed (target: <60 KB gzipped)
- **Security**: Strict Helmet Content Security Policy, signed `httpOnly` `sameSite=lax` session cookies, per-session CSRF tokens on all mutations, sliding-window rate limiting, and constant-time password verification.

---

## 1. Quick Start

### Running with Docker Compose (Recommended)

Add the `web` service block to your root `docker-compose.yml` (see below) and run:

```bash
docker compose up -d --build web
```

The store will be available on `http://localhost:8081`.

### Running Standalone for Local Development

1. Install dependencies:
   ```bash
   npm ci
   ```

2. Start the standalone mock API (contains 8 sample dresses):
   ```bash
   npm run mock:api
   ```

3. In another terminal, start the storefront server:
   ```bash
   export SHOP_API_URL=http://localhost:3000
   export SHOP_API_KEY=test-secret-key-16-chars-min
   export SESSION_SECRET=super-secret-session-key-at-least-32-characters-long
   export ADMIN_PASSWORD=atelier-secret-admin
   export STORE_NAME="Aura & Thread Atelier"
   export UPI_VPA=aurathread@okaxis
   export UPI_PAYEE_NAME="Aura and Thread Atelier"
   export WHATSAPP_NUMBER=919876543210
   npm start
   ```

4. Run the automated end-to-end verification test suite:
   ```bash
   node dev/verify.js
   ```

---

## 2. Managing Product Photos

Product images are served directly from the `./public/products` volume mounted into the container:

1. **Drop your photo files** (e.g. `kora-midi.jpg`, `chanderi-dress.webp`) into `./web/public/products/`.
2. In **NocoDB** (or via `shop-api`), set the product's `image_url` field to:
   ```text
   /products/kora-midi.jpg
   ```
3. If `image_url` is left empty or an image fails to load, the storefront automatically renders an elegant initials monogram placeholder with gold and oxblood gradients—ensuring a polished look without broken images.

---

## 3. Editing Text & Brand Copy

All marketing text, hero taglines, brand values, weaver stories, and atelier facts live in a single editable file:

```text
./web/content/site.json
```

Because `./web/content` is mounted as a volume in Docker Compose, changes made to `content/site.json` reflect immediately without needing to rebuild the Docker image:

- `hero`: Headline, subtitle, and call-to-action button labels.
- `storyBand`: Founder statement and artisan manifesto in the dark band section.
- `about`: Brand heritage narrative, four sourcing pillars, and atelier facts.
- `ctaSection`: WhatsApp and Instagram call-to-action block text.
- `footer`: Shipping notes, return policies, and copyright text.

---

## 4. Customizing the Color Palette

The entire aesthetic is defined in one place via CSS custom properties in `./public/css/style.css`:

```css
:root {
  /* Brand Palette (WCAG AA Compliant) */
  --color-bg: #F6F1E9;              /* Warm ivory background */
  --color-text: #14110F;            /* Deep ink text */
  --color-brass: #B08D57;           /* Warm antique brass / gold accent */
  --color-oxblood: #5E1B26;         /* Deep oxblood for buttons & highlights */
  --color-dark-band: #12100E;       /* Contrast dark band section */
}
```

Updating these values instantly updates the header, typography, buttons, borders, and footer across all pages.

---

## 5. Direct UPI Payment System

Orders placed with payment mode `UPI` enter `PENDING_PAYMENT` and hold stock for 30 minutes:

- The customer sees an inline SVG QR code encoding the NPCI UPI deep-link URI:
  ```text
  upi://pay?pa=<UPI_VPA>&pn=<UPI_PAYEE_NAME>&am=<AMOUNT>&cu=INR&tn=<ORDER_NO>
  ```
- On mobile devices, the **"Pay with UPI App"** button opens Google Pay, PhonePe, Paytm, or BHIM directly.
- A live countdown timer shows the remaining stock reservation window.
- The UI directs the customer to tap the **"Send Payment Screenshot on WhatsApp"** button (prefilled with order number and amount).
- Once you verify the bank credit or UTR number, open `/admin/orders/:orderNo` and tap **"Mark Paid & Confirm"** to confirm the order.

---

## 6. Staff Administrative Portal

Accessible at `/admin` (protected by `ADMIN_PASSWORD` and rate-limited against brute-force):

- **Orders Queue**: Filter by status (`NEW`, `PENDING_PAYMENT`, `CONFIRMED`, `PACKED`, `SHIPPED`, `DELIVERED`, `RETURNED`, `CANCELLED`), search by customer name/phone/order number, and paginate.
- **Order Actions**: Displays only legal next status moves according to the state machine.
  - *Pack*: One-click transition to `PACKED`.
  - *Ship*: Prompts for Courier Partner and AWB Tracking Number.
  - *Return*: Prompts whether to restock inventory or write off damaged pieces.
  - *Mark Paid*: Attaches bank UTR reference and confirms order.
  - *Cancel*: Prompts for confirmation and automatically releases reserved stock.
- **WhatsApp Customer Actions**: Every order page features a dynamic "Message Customer on WhatsApp" button with prefilled, status-appropriate messages (order confirmation, dispatch with tracking number, payment reminders).
- **Stock Control**: Live view of every variant's `on_hand`, `reserved`, and `available` counts, low-stock threshold alerts, and instant stock adjustment forms.
