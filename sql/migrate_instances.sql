-- Migration: Add missing columns to instances table
USE express_crud_db;

-- Add uuid column (used in getInstanceDetails route)
ALTER TABLE instances
  ADD COLUMN IF NOT EXISTS uuid CHAR(36) UNIQUE DEFAULT (UUID());

-- Add webhook_url column (used for incoming message forwarding)
ALTER TABLE instances
  ADD COLUMN IF NOT EXISTS webhook_url VARCHAR(500) DEFAULT NULL;

-- Backfill uuid for existing rows that have NULL uuid
UPDATE instances SET uuid = UUID() WHERE uuid IS NULL;
