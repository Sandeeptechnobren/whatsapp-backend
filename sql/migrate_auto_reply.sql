-- Migration: Add auto-reply columns to instances table
-- Run this once against your live database

ALTER TABLE instances
  ADD COLUMN IF NOT EXISTS auto_reply_enabled TINYINT(1)  NOT NULL DEFAULT 0              AFTER webhook_url,
  ADD COLUMN IF NOT EXISTS auto_reply_scope   ENUM('private','groups','all') NOT NULL DEFAULT 'private' AFTER auto_reply_enabled,
  ADD COLUMN IF NOT EXISTS auto_reply_prompt  TEXT                                         AFTER auto_reply_scope;
