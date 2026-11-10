ALTER TABLE variants ADD COLUMN IF NOT EXISTS image_url text;

DROP VIEW IF EXISTS v_stock CASCADE;

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
       p.active,
       COALESCE(v.image_url, p.image_url)        AS image_url,
       v.image_url                               AS variant_image_url
FROM variants v
JOIN products p ON p.id = v.product_id;
