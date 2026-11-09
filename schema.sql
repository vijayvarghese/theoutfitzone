-- Dress store inventory schema (runs once, on first start of an empty database)
-- Orders tables will be added later; on_hand/reserved are already here so orders slot in.

CREATE TABLE products (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  category    text,
  price_inr   numeric(10,2) NOT NULL CHECK (price_inr >= 0),
  description text,
  image_url   text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE variants (
  id            serial PRIMARY KEY,
  product_id    int  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           text NOT NULL UNIQUE,            -- e.g. KUR-RED-M
  size          text,
  colour        text,
  on_hand       int  NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved      int  NOT NULL DEFAULT 0 CHECK (reserved >= 0),   -- held for unpaid/unpacked orders (used by orders later)
  reorder_level int  NOT NULL DEFAULT 2,
  CHECK (reserved <= on_hand)
);
CREATE INDEX variants_product_idx ON variants(product_id);

-- Audit trail: every change to on_hand is logged automatically, whoever makes it.
CREATE TABLE stock_movements (
  id         serial PRIMARY KEY,
  variant_id int NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  delta      int NOT NULL,
  qty_after  int NOT NULL,
  reason     text NOT NULL,                      -- initial | edit
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_variant_idx ON stock_movements(variant_id, at DESC);

CREATE FUNCTION log_stock_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.on_hand > 0 THEN
      INSERT INTO stock_movements(variant_id, delta, qty_after, reason)
      VALUES (NEW.id, NEW.on_hand, NEW.on_hand, 'initial');
    END IF;
  ELSIF NEW.on_hand IS DISTINCT FROM OLD.on_hand THEN
    INSERT INTO stock_movements(variant_id, delta, qty_after, reason)
    VALUES (NEW.id, NEW.on_hand - OLD.on_hand, NEW.on_hand, 'edit');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER variants_stock_log
AFTER INSERT OR UPDATE ON variants
FOR EACH ROW EXECUTE FUNCTION log_stock_change();

-- Read-only overview for the admin UI and for the website/automation later.
CREATE VIEW v_stock AS
SELECT v.id        AS variant_id,
       v.sku,
       p.name      AS product,
       p.category,
       v.size,
       v.colour,
       p.price_inr,
       v.on_hand,
       v.reserved,
       (v.on_hand - v.reserved)                  AS available,
       v.reorder_level,
       ((v.on_hand - v.reserved) <= v.reorder_level) AS low_stock,
       p.active
FROM variants v
JOIN products p ON p.id = v.product_id;

-- Sample data: delete these rows from the UI once you add your own.
INSERT INTO products (name, category, price_inr, description) VALUES
  ('Cotton Kurti',      'Kurtis',   799,  'Sample product'),
  ('Floral Maxi Dress', 'Dresses', 1299,  'Sample product'),
  ('Denim Jacket',      'Jackets', 1599,  'Sample product');

INSERT INTO variants (product_id, sku, size, colour, on_hand, reorder_level) VALUES
  (1, 'KUR-RED-M',  'M', 'Red',  6, 2),
  (1, 'KUR-RED-L',  'L', 'Red',  4, 2),
  (1, 'KUR-BLU-M',  'M', 'Blue', 1, 2),
  (2, 'MAX-FLO-S',  'S', 'Floral', 3, 2),
  (2, 'MAX-FLO-M',  'M', 'Floral', 5, 2),
  (3, 'JKT-DEN-L',  'L', 'Denim', 2, 1);
