-- Duplicate-safe quick receive: goods_receipts.client_ref carries a per-user hash of the request's
-- Idempotency-Key, and its UNIQUE index is what makes a double-fired POST /grn/quick-receive
-- produce exactly one receipt. NULL for every pre-existing/draft GRN (a UNIQUE index allows many NULLs).
-- Safe to run repeatedly. Equivalent runner: node --env-file=.env.dev scripts/addGrnClientRef.js
SET @db := DATABASE();

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'goods_receipts' AND column_name = 'client_ref'
);
SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE goods_receipts ADD COLUMN client_ref VARCHAR(64) NULL AFTER notes',
  'SELECT "goods_receipts.client_ref already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'goods_receipts' AND index_name = 'uq_grn_client_ref'
);
SET @sql := IF(
  @idx_exists = 0,
  'ALTER TABLE goods_receipts ADD UNIQUE INDEX uq_grn_client_ref (client_ref)',
  'SELECT "uq_grn_client_ref already exists"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
