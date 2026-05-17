START TRANSACTION;

ALTER TABLE stock_movements
  MODIFY COLUMN movement_type ENUM(
    'in',
    'out',
    'reserve',
    'release',
    'adjustment',
    'grn',
    'initial_stock',
    'manual_increase',
    'manual_decrease',
    'transfer_out',
    'transfer_in',
    'cycle_count_increase',
    'cycle_count_decrease'
  ) NOT NULL;

UPDATE stock_movements
SET movement_type = 'manual_increase'
WHERE movement_type = ''
  AND reference_type = 'inventory'
  AND notes LIKE 'Manual inventory stock update from 0 to %';

UPDATE stock_movements
SET movement_type = 'adjustment'
WHERE movement_type = '';

COMMIT;

SELECT movement_type, COUNT(*) AS total
FROM stock_movements
GROUP BY movement_type
ORDER BY movement_type;
