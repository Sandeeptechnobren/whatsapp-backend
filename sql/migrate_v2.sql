-- =============================================================
-- Migration V2: Trial system, payments, superadmin, full schema
-- Run this against express_crud_db
-- =============================================================
USE express_crud_db;

-- Fix admin token column (was CHAR(36), code generates 60-char hex)
ALTER TABLE admins MODIFY COLUMN token VARCHAR(120) NOT NULL;

-- Add superadmin role support (role already exists as VARCHAR)
-- No schema change needed, just insert a superadmin user via:
-- INSERT INTO admins (username,password,name,role,token) VALUES (...)

-- =============================================================
-- Extend instances table
-- =============================================================
ALTER TABLE instances
  ADD COLUMN IF NOT EXISTS uuid         CHAR(36)    UNIQUE DEFAULT (UUID()),
  ADD COLUMN IF NOT EXISTS webhook_url  VARCHAR(500) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS trial_ends_at DATETIME   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS plan         ENUM('trial','active','expired') DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS plan_expires_at DATETIME DEFAULT NULL;

-- Backfill uuid for rows that have NULL
UPDATE instances SET uuid = UUID() WHERE uuid IS NULL;

-- Set trial_ends_at = created_at + 6 days for existing instances
UPDATE instances
SET trial_ends_at = DATE_ADD(created_at, INTERVAL 6 DAY)
WHERE trial_ends_at IS NULL;

-- =============================================================
-- Payments table
-- =============================================================
CREATE TABLE IF NOT EXISTS payments (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  instance_id      INT          NOT NULL,
  admin_id         INT          NOT NULL,
  amount           DECIMAL(10,2) NOT NULL DEFAULT 9.99,
  currency         VARCHAR(10)  DEFAULT 'USD',
  duration_days    INT          DEFAULT 30,
  status           ENUM('pending','approved','rejected') DEFAULT 'pending',
  payment_method   VARCHAR(100) DEFAULT 'manual',
  transaction_id   VARCHAR(255) DEFAULT NULL,
  notes            TEXT,
  approved_by      INT          DEFAULT NULL,
  approved_at      DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pay_instance FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_admin    FOREIGN KEY (admin_id)    REFERENCES admins(id)    ON DELETE CASCADE
) ENGINE=InnoDB;
