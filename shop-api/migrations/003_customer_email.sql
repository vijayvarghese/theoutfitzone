-- 003: Add email column to customers table for n8n automation & receipts
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email text;
