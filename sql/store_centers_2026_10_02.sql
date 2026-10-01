-- Company fulfillment centers (Caloocan, Tycoon). Additive and idempotent: safe to re-run.
-- Equivalent to `node scripts/addStoreCenters.js`, which is the preferred way to apply it.
--   partners.stockist_level    += 'center'
--   warehouses.type            += 'center'
--   warehouses.operating_hours VARCHAR(80) NULL
-- Each enum change appends to the CURRENT definition (read from information_schema), preserving
-- nullability, default and comment, and is skipped when 'center' is already present.

SET @partners_level_ddl = (
  SELECT IF(
    LOCATE('''center''', COLUMN_TYPE) > 0,
    'SELECT ''partners.stockist_level already has center - skipping'' AS note',
    CONCAT(
      'ALTER TABLE partners MODIFY COLUMN stockist_level ',
      REPLACE(COLUMN_TYPE, ')', ',''center'')'),
      IF(IS_NULLABLE = 'NO', ' NOT NULL', ' NULL'),
      IF(COLUMN_DEFAULT IS NULL, '', CONCAT(' DEFAULT ''', COLUMN_DEFAULT, ''''))
    )
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'partners' AND COLUMN_NAME = 'stockist_level'
);
PREPARE stmt FROM @partners_level_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @warehouses_type_ddl = (
  SELECT IF(
    LOCATE('''center''', COLUMN_TYPE) > 0,
    'SELECT ''warehouses.type already has center - skipping'' AS note',
    CONCAT(
      'ALTER TABLE warehouses MODIFY COLUMN type ',
      REPLACE(COLUMN_TYPE, ')', ',''center'')'),
      IF(IS_NULLABLE = 'NO', ' NOT NULL', ' NULL'),
      IF(COLUMN_DEFAULT IS NULL, '', CONCAT(' DEFAULT ''', COLUMN_DEFAULT, ''''))
    )
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'warehouses' AND COLUMN_NAME = 'type'
);
PREPARE stmt FROM @warehouses_type_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @operating_hours_ddl = (
  SELECT IF(
    COUNT(*) > 0,
    'SELECT ''warehouses.operating_hours already exists - skipping'' AS note',
    'ALTER TABLE warehouses ADD COLUMN operating_hours VARCHAR(80) NULL'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'warehouses' AND COLUMN_NAME = 'operating_hours'
);
PREPARE stmt FROM @operating_hours_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
