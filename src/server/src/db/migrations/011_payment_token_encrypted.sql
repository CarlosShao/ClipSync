-- Add payment_token_encrypted column to payment_orders table
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS payment_token_encrypted TEXT;
