-- Migration 005: Coupons and Promotional Discounts
CREATE TABLE IF NOT EXISTS coupons (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  description text,
  discount_type text NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent', 'flat')),
  discount_value numeric(10,2) NOT NULL CHECK (discount_value > 0),
  min_order_amount numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  scope text NOT NULL DEFAULT 'unlimited' CHECK (scope IN ('unlimited', 'custom', 'single_use')),
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  active boolean NOT NULL DEFAULT true,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coupons_code_idx ON coupons (LOWER(code));
CREATE INDEX IF NOT EXISTS coupons_active_idx ON coupons (active);

-- Add coupon_code and discount tracking to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount numeric(10,2) NOT NULL DEFAULT 0;

-- Insert elegant default starter coupons
INSERT INTO coupons (code, description, discount_type, discount_value, min_order_amount, scope, usage_limit, usage_count, active, expires_at)
VALUES
  ('AURA-WELCOME-10', 'Welcome to Aura & Thread - 10% off any silhouette', 'percent', 10.00, 0, 'unlimited', NULL, 0, true, now() + interval '90 days'),
  ('AT-FESTIVE-500', 'Festive Celebration - Flat ₹500 off orders over ₹2,500', 'flat', 500.00, 2500, 'custom', 50, 0, true, now() + interval '30 days'),
  ('SILK-VIP-20', 'Atelier Collector Single-Use - 20% off your bespoke order', 'percent', 20.00, 1500, 'single_use', 1, 0, true, now() + interval '60 days')
ON CONFLICT (code) DO NOTHING;
