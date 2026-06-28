// Seed stock for EVERY active product in the main warehouse (Goldenstar,
// type='manufacturer'). Public orders source from this warehouse, so any
// product missing an inventory row here shows "Out of Stock" on the public shop.
// Idempotent: only inserts a row for products that don't already have one in
// the main warehouse; existing stock is left untouched.
// Run: node --env-file=.env.dev scripts/seedMainWarehouseStock.js
const mysql = require('mysql2/promise');

const SEED_QTY = 10000;

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });

  const [[wh]] = await pool.execute(
    "SELECT id, name FROM warehouses WHERE type = 'manufacturer' AND is_deleted = 0 ORDER BY id LIMIT 1"
  );
  if (!wh) { console.error('No manufacturer (main) warehouse found.'); process.exit(1); }
  console.log(`Main warehouse: #${wh.id} ${wh.name}`);

  // Insert a stocked row for every product that lacks one in the main warehouse.
  // status is a generated/default column — omit it so the DB computes it.
  let result;
  try {
    [result] = await pool.execute(
      `INSERT INTO inventories (product_id, warehouse_id, current_stock, reserved_stock, is_active)
       SELECT pr.id, ?, ?, 0, 1
       FROM products pr
       WHERE pr.is_deleted = 0
         AND NOT EXISTS (
           SELECT 1 FROM inventories i WHERE i.product_id = pr.id AND i.warehouse_id = ?
         )`,
      [wh.id, SEED_QTY, wh.id]
    );
  } catch (err) {
    // Fallback if the schema requires an explicit status value.
    [result] = await pool.execute(
      `INSERT INTO inventories (product_id, warehouse_id, current_stock, reserved_stock, is_active, status)
       SELECT pr.id, ?, ?, 0, 1, 'in_stock'
       FROM products pr
       WHERE pr.is_deleted = 0
         AND NOT EXISTS (
           SELECT 1 FROM inventories i WHERE i.product_id = pr.id AND i.warehouse_id = ?
         )`,
      [wh.id, SEED_QTY, wh.id]
    );
  }
  console.log(`Seeded ${result.affectedRows} new inventory rows (${SEED_QTY} each) in main warehouse.`);

  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS stocked FROM inventories WHERE warehouse_id = ? AND current_stock > 0`,
    [wh.id]
  );
  console.log(`Products with stock in main warehouse now: ${rows[0].stocked}`);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
