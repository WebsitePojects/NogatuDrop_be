-- NOGATU NCDMS CORE OPERATIONAL SCHEMA REPAIR
-- Date: 2026-05-07
-- Purpose: Add v2 operational columns required by live controllers.
-- Safe to run multiple times on MariaDB/MySQL variants that support IF NOT EXISTS.

SET @db := DATABASE();

-- ---------------------------------------------------------
-- partners: stockist hierarchy fields used by stockist/order controllers
-- ---------------------------------------------------------
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS stockist_level ENUM('provincial_stockist','city_stockist') NOT NULL DEFAULT 'city_stockist' AFTER region,
  ADD COLUMN IF NOT EXISTS parent_partner_id BIGINT(20) UNSIGNED NULL AFTER stockist_level,
  ADD COLUMN IF NOT EXISTS discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER parent_partner_id;

UPDATE partners
SET stockist_level = COALESCE(stockist_level, 'city_stockist')
WHERE stockist_level IS NULL;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'partners' AND index_name = 'idx_parent'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE partners ADD INDEX idx_parent (parent_partner_id)',
  'SELECT "idx_parent already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = @db AND constraint_name = 'fk_partner_parent'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE partners ADD CONSTRAINT fk_partner_parent FOREIGN KEY (parent_partner_id) REFERENCES partners(id) ON DELETE SET NULL',
  'SELECT "fk_partner_parent already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------
-- orders: payment proof, public-order, source warehouse, and delivery fields
-- ---------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source_warehouse_id BIGINT(20) UNSIGNED NULL AFTER partner_id,
  ADD COLUMN IF NOT EXISTS payment_deadline TIMESTAMP NULL DEFAULT NULL AFTER payment_status,
  ADD COLUMN IF NOT EXISTS payment_proof_url VARCHAR(500) NULL AFTER payment_deadline,
  ADD COLUMN IF NOT EXISTS payment_proof_uploaded_at TIMESTAMP NULL DEFAULT NULL AFTER payment_proof_url,
  ADD COLUMN IF NOT EXISTS payment_proof_verified_by BIGINT(20) UNSIGNED NULL AFTER payment_proof_uploaded_at,
  ADD COLUMN IF NOT EXISTS payment_proof_verified_at TIMESTAMP NULL DEFAULT NULL AFTER payment_proof_verified_by,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT NULL AFTER payment_proof_verified_at,
  ADD COLUMN IF NOT EXISTS cancelled_by BIGINT(20) UNSIGNED NULL AFTER cancellation_reason,
  ADD COLUMN IF NOT EXISTS courier_id BIGINT(20) UNSIGNED NULL AFTER cancelled_by,
  ADD COLUMN IF NOT EXISTS cod_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00 AFTER courier_id,
  ADD COLUMN IF NOT EXISTS placed_by_type ENUM('user','public') NOT NULL DEFAULT 'user' AFTER cod_amount,
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(150) NULL AFTER placed_by_type,
  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30) NULL AFTER customer_name,
  ADD COLUMN IF NOT EXISTS customer_email VARCHAR(150) NULL AFTER customer_phone,
  ADD COLUMN IF NOT EXISTS customer_address TEXT NULL AFTER customer_email;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'orders' AND index_name = 'idx_source_warehouse'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE orders ADD INDEX idx_source_warehouse (source_warehouse_id)',
  'SELECT "idx_source_warehouse already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'orders' AND index_name = 'idx_payment_deadline'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE orders ADD INDEX idx_payment_deadline (payment_deadline)',
  'SELECT "idx_payment_deadline already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = @db AND constraint_name = 'fk_orders_source_wh'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE orders ADD CONSTRAINT fk_orders_source_wh FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL',
  'SELECT "fk_orders_source_wh already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = @db AND constraint_name = 'fk_orders_proof_verifier'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE orders ADD CONSTRAINT fk_orders_proof_verifier FOREIGN KEY (payment_proof_verified_by) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT "fk_orders_proof_verifier already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = @db AND constraint_name = 'fk_orders_cancelled_by'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE orders ADD CONSTRAINT fk_orders_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL',
  'SELECT "fk_orders_cancelled_by already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------
-- order_items: preserve source warehouse at item level
-- ---------------------------------------------------------
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS source_warehouse_id BIGINT(20) UNSIGNED NULL AFTER product_id;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'order_items' AND index_name = 'idx_oi_source_warehouse'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE order_items ADD INDEX idx_oi_source_warehouse (source_warehouse_id)',
  'SELECT "idx_oi_source_warehouse already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = @db AND constraint_name = 'fk_oi_source_wh'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE order_items ADD CONSTRAINT fk_oi_source_wh FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL',
  'SELECT "fk_oi_source_wh already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------
-- inventories: reservation and operational movement fields
-- ---------------------------------------------------------
ALTER TABLE inventories
  ADD COLUMN IF NOT EXISTS reserved_stock INT(10) UNSIGNED NOT NULL DEFAULT 0 AFTER current_stock,
  ADD COLUMN IF NOT EXISTS warning_threshold INT(10) UNSIGNED NOT NULL DEFAULT 0 AFTER reorder_threshold,
  ADD COLUMN IF NOT EXISTS last_movement_at TIMESTAMP NULL DEFAULT NULL AFTER is_active;

UPDATE inventories
SET reserved_stock = COALESCE(reserved_stock, 0),
    warning_threshold = COALESCE(warning_threshold, 0);

-- ---------------------------------------------------------
-- delivery_tracking and gps_pings: courier and map fields used by tracking APIs
-- ---------------------------------------------------------
ALTER TABLE delivery_tracking
  ADD COLUMN IF NOT EXISTS courier_id BIGINT(20) UNSIGNED NULL AFTER rider_user_id,
  ADD COLUMN IF NOT EXISTS courier_tracking_number VARCHAR(100) NULL AFTER courier_id;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'delivery_tracking' AND index_name = 'idx_dt_courier'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE delivery_tracking ADD INDEX idx_dt_courier (courier_id)',
  'SELECT "idx_dt_courier already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.referential_constraints
  WHERE constraint_schema = @db AND constraint_name = 'fk_dt_courier'
);
SET @sql := IF(
  @fk_exists = 0,
  'ALTER TABLE delivery_tracking ADD CONSTRAINT fk_dt_courier FOREIGN KEY (courier_id) REFERENCES couriers(id) ON DELETE SET NULL',
  'SELECT "fk_dt_courier already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE gps_pings
  ADD COLUMN IF NOT EXISTS speed_kmh DECIMAL(6,2) NULL AFTER lng,
  ADD COLUMN IF NOT EXISTS accuracy_meters DECIMAL(8,2) NULL AFTER speed_kmh;

SELECT 'repair_core_operational_schema_2026_05_07 completed' AS migration_status;
