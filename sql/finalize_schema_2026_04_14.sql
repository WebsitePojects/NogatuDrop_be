-- NOGATU NCDMS FINALIZATION MIGRATION
-- Date: 2026-04-14
-- Purpose: Align deployed DB schema with backend controllers and public tracking flow.
-- Safe to run multiple times.

SET @db := DATABASE();

-- ---------------------------------------------------------
-- 1) warehouses.partner_id for stockist scoping and source lookup
-- ---------------------------------------------------------
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS partner_id BIGINT(20) UNSIGNED NULL AFTER id;

-- Backfill warehouses.partner_id from inventories.partner_id when available
SET @has_inv_partner := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'inventories' AND column_name = 'partner_id'
);
SET @sql := IF(
  @has_inv_partner = 1,
  'UPDATE warehouses w
     JOIN (
       SELECT i.warehouse_id, MIN(i.partner_id) AS partner_id
       FROM inventories i
       WHERE i.partner_id IS NOT NULL
       GROUP BY i.warehouse_id
     ) src ON src.warehouse_id = w.id
   SET w.partner_id = src.partner_id
   WHERE w.partner_id IS NULL',
  'SELECT "skip warehouses.partner_id backfill (inventories.partner_id missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Clean invalid partner references before adding FK
UPDATE warehouses w
LEFT JOIN partners p ON p.id = w.partner_id
SET w.partner_id = NULL
WHERE w.partner_id IS NOT NULL AND p.id IS NULL;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'warehouses' AND index_name = 'idx_warehouses_partner_id'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE warehouses ADD INDEX idx_warehouses_partner_id (partner_id)',
  'SELECT "idx_warehouses_partner_id already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = @db AND constraint_name = 'fk_warehouses_partner'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE warehouses
     ADD CONSTRAINT fk_warehouses_partner
     FOREIGN KEY (partner_id) REFERENCES partners(id)
     ON DELETE SET NULL',
  'SELECT "fk_warehouses_partner already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------
-- 2) mobile_stockists.last_login for UI field compatibility
-- ---------------------------------------------------------
ALTER TABLE mobile_stockists
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMP NULL DEFAULT NULL AFTER updated_at;

-- ---------------------------------------------------------
-- 3) stock_movements soft-delete compatibility
-- ---------------------------------------------------------
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS is_deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER created_at;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'stock_movements' AND index_name = 'idx_sm_is_deleted'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE stock_movements ADD INDEX idx_sm_is_deleted (is_deleted)',
  'SELECT "idx_sm_is_deleted already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------
-- 4) dta_applications legacy-compatible fields
-- ---------------------------------------------------------
ALTER TABLE dta_applications
  ADD COLUMN IF NOT EXISTS full_name VARCHAR(150) NULL AFTER id,
  ADD COLUMN IF NOT EXISTS stockist_level ENUM('provincial_stockist','city_stockist') NULL AFTER address,
  ADD COLUMN IF NOT EXISTS id_front_url VARCHAR(500) NULL AFTER stockist_level,
  ADD COLUMN IF NOT EXISTS id_back_url VARCHAR(500) NULL AFTER id_front_url,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL AFTER id_back_url,
  ADD COLUMN IF NOT EXISTS is_deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER notes;

SET @has_applicant_name := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'dta_applications' AND column_name = 'applicant_name'
);
SET @sql := IF(
  @has_applicant_name = 1,
  'UPDATE dta_applications SET full_name = COALESCE(full_name, applicant_name) WHERE full_name IS NULL',
  'SELECT "skip full_name backfill (applicant_name missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_requested_level := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'dta_applications' AND column_name = 'requested_level'
);
SET @sql := IF(
  @has_requested_level = 1,
  'UPDATE dta_applications SET stockist_level = COALESCE(stockist_level, requested_level) WHERE stockist_level IS NULL',
  'SELECT "skip stockist_level backfill (requested_level missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_id_document_url := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'dta_applications' AND column_name = 'id_document_url'
);
SET @sql := IF(
  @has_id_document_url = 1,
  'UPDATE dta_applications SET id_front_url = COALESCE(id_front_url, id_document_url) WHERE id_front_url IS NULL',
  'SELECT "skip id_front_url backfill (id_document_url missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_business_permit_url := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'dta_applications' AND column_name = 'business_permit_url'
);
SET @sql := IF(
  @has_business_permit_url = 1,
  'UPDATE dta_applications SET id_back_url = COALESCE(id_back_url, business_permit_url) WHERE id_back_url IS NULL',
  'SELECT "skip id_back_url backfill (business_permit_url missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_message := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'dta_applications' AND column_name = 'message'
);
SET @sql := IF(
  @has_message = 1,
  'UPDATE dta_applications SET notes = COALESCE(notes, message) WHERE notes IS NULL',
  'SELECT "skip notes backfill (message missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'dta_applications' AND index_name = 'idx_dta_is_deleted'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE dta_applications ADD INDEX idx_dta_is_deleted (is_deleted)',
  'SELECT "idx_dta_is_deleted already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------
-- 5) grn_items qty aliases used by current API payloads
-- ---------------------------------------------------------
ALTER TABLE grn_items
  ADD COLUMN IF NOT EXISTS expected_qty INT(10) UNSIGNED NOT NULL DEFAULT 0 AFTER product_id,
  ADD COLUMN IF NOT EXISTS received_qty INT(10) UNSIGNED NOT NULL DEFAULT 0 AFTER expected_qty;

SET @has_expected_quantity := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'grn_items' AND column_name = 'expected_quantity'
);
SET @sql := IF(
  @has_expected_quantity = 1,
  'UPDATE grn_items SET expected_qty = COALESCE(NULLIF(expected_qty, 0), expected_quantity)',
  'SELECT "skip expected_qty backfill (expected_quantity missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_received_quantity := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'grn_items' AND column_name = 'received_quantity'
);
SET @sql := IF(
  @has_received_quantity = 1,
  'UPDATE grn_items SET received_qty = COALESCE(NULLIF(received_qty, 0), received_quantity)',
  'SELECT "skip received_qty backfill (received_quantity missing)"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------
-- 6) Soft-delete columns for operational master tables
-- ---------------------------------------------------------
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS is_deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;

ALTER TABLE couriers
  ADD COLUMN IF NOT EXISTS is_deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'bank_accounts' AND index_name = 'idx_bank_accounts_is_deleted'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE bank_accounts ADD INDEX idx_bank_accounts_is_deleted (is_deleted)',
  'SELECT "idx_bank_accounts_is_deleted already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'couriers' AND index_name = 'idx_couriers_is_deleted'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE couriers ADD INDEX idx_couriers_is_deleted (is_deleted)',
  'SELECT "idx_couriers_is_deleted already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Done
SELECT 'finalize_schema_2026_04_14 completed' AS migration_status;
