-- Expands notifications.type so production accepts newer operational events.
-- Safe to rerun: it only alters the enum if the newer values are missing.

SET @db_name := DATABASE();

SELECT COLUMN_TYPE
INTO @notifications_type_column
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'notifications'
  AND COLUMN_NAME = 'type'
LIMIT 1;

SET @needs_patch := IF(
  @notifications_type_column IS NULL OR
  @notifications_type_column NOT LIKE '%payment_proof_uploaded%' OR
  @notifications_type_column NOT LIKE '%payment_verified%' OR
  @notifications_type_column NOT LIKE '%rider_dispatched%' OR
  @notifications_type_column NOT LIKE '%order_cancelled%' OR
  @notifications_type_column NOT LIKE '%dta_received%' OR
  @notifications_type_column NOT LIKE '%expiry_alert%',
  1,
  0
);

SET @sql := IF(
  @needs_patch = 1,
  "ALTER TABLE notifications
   MODIFY COLUMN type ENUM(
     'low_stock',
     'no_stock',
     'stock_replenished',
     'order_placed',
     'order_approved',
     'order_rejected',
     'order_paid',
     'order_delivered',
     'po_generated',
     'system',
     'payment_proof_uploaded',
     'payment_verified',
     'rider_dispatched',
     'order_cancelled',
     'dta_received',
     'expiry_alert'
   ) NOT NULL",
  "SELECT 'notifications.type already supports the current app values' AS message"
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
