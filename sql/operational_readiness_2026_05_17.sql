-- Operational readiness foundations: cycle counts, settlements, governed exports, POD signatures.
-- Run after the core operational schema repairs.

CREATE TABLE IF NOT EXISTS cycle_counts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  count_number VARCHAR(50) NOT NULL UNIQUE,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  status ENUM('draft','submitted','approved','rejected','cancelled') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NOT NULL,
  submitted_by BIGINT UNSIGNED NULL,
  submitted_at TIMESTAMP NULL DEFAULT NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  notes TEXT NULL,
  review_notes TEXT NULL,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cycle_counts_warehouse (warehouse_id),
  KEY idx_cycle_counts_status (status),
  CONSTRAINT fk_cycle_counts_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_cycle_counts_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_cycle_counts_submitted_by FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_cycle_counts_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cycle_count_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cycle_count_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  inventory_id BIGINT UNSIGNED NULL,
  system_qty INT NOT NULL DEFAULT 0,
  counted_qty INT NOT NULL DEFAULT 0,
  variance_qty INT GENERATED ALWAYS AS (counted_qty - system_qty) STORED,
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cci_count (cycle_count_id),
  KEY idx_cci_product (product_id),
  CONSTRAINT fk_cci_count FOREIGN KEY (cycle_count_id) REFERENCES cycle_counts(id) ON DELETE CASCADE,
  CONSTRAINT fk_cci_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_cci_inventory FOREIGN KEY (inventory_id) REFERENCES inventories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_number VARCHAR(50) NOT NULL UNIQUE,
  order_id BIGINT UNSIGNED NOT NULL,
  partner_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  method ENUM('bank_transfer','cod','courier_remittance','manual') NOT NULL DEFAULT 'bank_transfer',
  status ENUM('draft','pending','reconciled','disputed','cancelled') NOT NULL DEFAULT 'pending',
  expected_at TIMESTAMP NULL DEFAULT NULL,
  reconciled_at TIMESTAMP NULL DEFAULT NULL,
  reconciled_by BIGINT UNSIGNED NULL,
  reference_number VARCHAR(100) NULL,
  variance_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  notes TEXT NULL,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_settlements_order (order_id),
  KEY idx_settlements_partner (partner_id),
  KEY idx_settlements_status (status),
  CONSTRAINT fk_settlements_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_settlements_partner FOREIGN KEY (partner_id) REFERENCES partners(id),
  CONSTRAINT fk_settlements_reconciled_by FOREIGN KEY (reconciled_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  export_number VARCHAR(50) NOT NULL UNIQUE,
  export_type VARCHAR(50) NOT NULL,
  format ENUM('json','csv') NOT NULL DEFAULT 'csv',
  filters_json JSON NULL,
  row_count INT UNSIGNED NOT NULL DEFAULT 0,
  content_sha256 CHAR(64) NOT NULL,
  signed_by BIGINT UNSIGNED NOT NULL,
  signed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status ENUM('generated','voided') NOT NULL DEFAULT 'generated',
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_export_jobs_type (export_type),
  KEY idx_export_jobs_signed_by (signed_by),
  CONSTRAINT fk_export_jobs_signed_by FOREIGN KEY (signed_by) REFERENCES users(id)
);

ALTER TABLE proof_of_delivery
  ADD COLUMN IF NOT EXISTS recipient_signature TEXT NULL AFTER recipient_name,
  ADD COLUMN IF NOT EXISTS signature_hash CHAR(64) NULL AFTER recipient_signature,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMP NULL DEFAULT NULL AFTER signature_hash;

