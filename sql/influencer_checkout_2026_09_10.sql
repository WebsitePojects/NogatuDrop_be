-- Configurable public influencer checkout and durable idempotency.
-- Safe to run repeatedly. Product identity is configured by SKU; no product id is invented.
CREATE TABLE IF NOT EXISTS influencer_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(80) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  canonical_product_sku VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_influencer_links_slug (slug),
  KEY idx_influencer_links_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO influencer_links (slug, enabled, canonical_product_sku)
VALUES ('kawoodee', 1, 'NKT-BND-001')
ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), canonical_product_sku = VALUES(canonical_product_sku);

CREATE TABLE IF NOT EXISTS order_attribution (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  channel VARCHAR(40) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_attribution_order (order_id),
  KEY idx_order_attribution_slug_created (slug, created_at),
  CONSTRAINT fk_order_attribution_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS public_order_idempotency (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope VARCHAR(80) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status ENUM('processing','completed') NOT NULL DEFAULT 'processing',
  order_id BIGINT UNSIGNED NULL,
  response_json JSON NULL,
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_public_order_idempotency (scope, idempotency_key),
  KEY idx_public_order_idempotency_order (order_id),
  CONSTRAINT fk_public_order_idempotency_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(40) NULL AFTER payment_status;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_account_id BIGINT UNSIGNED NULL AFTER payment_provider;
