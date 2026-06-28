// Adds explicit requester/supplier affiliation and approval audit fields to
// purchase orders. Idempotent and preserves legacy pending/approved rows.
const mysql = require('mysql2/promise');

async function columnExists(pool, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = ?`,
    [column]
  );
  return Number(rows[0]?.n || 0) > 0;
}

async function indexExists(pool, indexName) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND INDEX_NAME = ?`,
    [indexName]
  );
  return Number(rows[0]?.n || 0) > 0;
}

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });

  try {
    const columns = [
      ['requester_partner_id', 'BIGINT UNSIGNED NULL'],
      ['supplier_partner_id', 'BIGINT UNSIGNED NULL'],
      ['source_warehouse_id', 'BIGINT UNSIGNED NULL'],
      ['destination_warehouse_id', 'BIGINT UNSIGNED NULL'],
      ['submitted_by', 'BIGINT UNSIGNED NULL'],
      ['submitted_at', 'TIMESTAMP NULL DEFAULT NULL'],
      ['owner_approved_by', 'BIGINT UNSIGNED NULL'],
      ['owner_approved_at', 'TIMESTAMP NULL DEFAULT NULL'],
      ['accepted_by', 'BIGINT UNSIGNED NULL'],
      ['accepted_at', 'TIMESTAMP NULL DEFAULT NULL'],
    ];
    for (const [name, definition] of columns) {
      if (!await columnExists(pool, name)) {
        await pool.query(`ALTER TABLE purchase_orders ADD COLUMN ${name} ${definition}`);
        console.log(`Added purchase_orders.${name}`);
      }
    }

    await pool.query(
      `ALTER TABLE purchase_orders
       MODIFY COLUMN status ENUM(
         'pending','awaiting_owner_approval','submitted','approved','accepted','rejected','completed'
       ) NOT NULL DEFAULT 'pending'`
    );

    const indexes = [
      ['idx_po_requester_partner', 'requester_partner_id'],
      ['idx_po_supplier_partner', 'supplier_partner_id'],
      ['idx_po_source_warehouse', 'source_warehouse_id'],
      ['idx_po_destination_warehouse', 'destination_warehouse_id'],
    ];
    for (const [name, column] of indexes) {
      if (!await indexExists(pool, name)) {
        await pool.query(`ALTER TABLE purchase_orders ADD INDEX ${name} (${column})`);
      }
    }

    await pool.execute(
      `UPDATE purchase_orders po
       JOIN users u ON u.id = po.created_by
       SET po.requester_partner_id = COALESCE(po.requester_partner_id, u.partner_id)
       WHERE po.requester_partner_id IS NULL AND u.partner_id IS NOT NULL`
    );
    await pool.execute(
      `UPDATE purchase_orders po
       JOIN partners requester ON requester.id = po.requester_partner_id
       SET po.supplier_partner_id = requester.parent_partner_id
       WHERE po.supplier_partner_id IS NULL
         AND requester.stockist_level = 'city_stockist'
         AND requester.parent_partner_id IS NOT NULL`
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
