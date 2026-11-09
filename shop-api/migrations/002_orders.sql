-- 002: customers, orders, order items, order events; richer stock audit.
-- Applied automatically by shop-api on start (tracked in schema_migrations).

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS ref text;   -- order number or note

-- Audit trigger now records WHY stock moved when the API says so (shop.reason / shop.ref);
-- plain edits from the NocoDB screen still log as 'edit'.
CREATE OR REPLACE FUNCTION log_stock_change() RETURNS trigger AS $$
DECLARE
  r text := NULLIF(current_setting('shop.reason', true), '');
  f text := NULLIF(current_setting('shop.ref', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.on_hand > 0 THEN
      INSERT INTO stock_movements(variant_id, delta, qty_after, reason, ref)
      VALUES (NEW.id, NEW.on_hand, NEW.on_hand, COALESCE(r, 'initial'), f);
    END IF;
  ELSIF NEW.on_hand IS DISTINCT FROM OLD.on_hand THEN
    INSERT INTO stock_movements(variant_id, delta, qty_after, reason, ref)
    VALUES (NEW.id, NEW.on_hand - OLD.on_hand, NEW.on_hand, COALESCE(r, 'edit'), f);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE customers (
  id            serial PRIMARY KEY,
  name          text,
  phone         text UNIQUE,                       -- last 10 digits, Indian mobile
  address       text,
  pincode       text,
  wa_id         text,                              -- WhatsApp id
  tg_chat_id    text,                              -- Telegram chat id
  ig_scoped_id  text,                              -- Instagram scoped id
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE order_seq START 1;

CREATE TABLE orders (
  id              serial PRIMARY KEY,
  order_no        text NOT NULL UNIQUE,            -- DS-2611-00042
  customer_id     int REFERENCES customers(id),
  channel         text NOT NULL CHECK (channel IN ('whatsapp','instagram','telegram','web','walkin','other')),
  reply_to        text,                            -- chat id to send status updates to
  status          text NOT NULL DEFAULT 'NEW' CHECK (status IN
                    ('NEW','PENDING_PAYMENT','CONFIRMED','PACKED','SHIPPED','DELIVERED',
                     'CANCELLED','RETURN_REQUESTED','RETURNED','REFUNDED')),
  payment_mode    text NOT NULL DEFAULT 'COD' CHECK (payment_mode IN ('COD','UPI','CARD','CASH')),
  payment_status  text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PAID','REFUNDED')),
  payment_ref     text,
  subtotal        numeric(10,2) NOT NULL CHECK (subtotal >= 0),
  shipping        numeric(10,2) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  total           numeric(10,2) NOT NULL CHECK (total >= 0),
  ship_address    text,
  ship_pincode    text,
  courier         text,
  awb             text,
  notes           text,
  expires_at      timestamptz,                     -- reservation hold for PENDING_PAYMENT
  idempotency_key text UNIQUE,                     -- makes webhook retries safe
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_idx   ON orders(status);
CREATE INDEX orders_created_idx  ON orders(created_at DESC);
CREATE INDEX orders_customer_idx ON orders(customer_id);

CREATE TABLE order_items (
  id          serial PRIMARY KEY,
  order_id    int NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id  int NOT NULL REFERENCES variants(id),
  qty         int NOT NULL CHECK (qty > 0),
  unit_price  numeric(10,2) NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX order_items_order_idx ON order_items(order_id);

CREATE TABLE order_events (                        -- audit trail of every status change
  id          serial PRIMARY KEY,
  order_id    int NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  note        text,
  actor       text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id, at);
