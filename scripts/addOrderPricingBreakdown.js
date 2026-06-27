// Persist public checkout pricing components so later reviews explain the exact
// stored total. Idempotent. Historical public orders are reconciled from their
// locked item subtotals; unknown legacy discount history remains zero rather
// than being guessed.
const mysql = require('mysql2/promise');

async function columnExists(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
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
      ['merchandise_subtotal', 'DECIMAL(15,2) NULL'],
      ['member_discount_amount', 'DECIMAL(15,2) NULL'],
      ['shipping_fee', 'DECIMAL(15,2) NULL'],
      ['system_fee', 'DECIMAL(15,2) NULL'],
    ];

    for (const [name, definition] of columns) {
      if (!await columnExists(pool, 'orders', name)) {
        await pool.query(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
        console.log(`Added orders.${name}`);
      }
    }

    await pool.execute(
      `UPDATE orders o
       JOIN (
         SELECT order_id, ROUND(SUM(subtotal), 2) AS merchandise_subtotal
         FROM order_items
         GROUP BY order_id
       ) item_totals ON item_totals.order_id = o.id
       SET o.merchandise_subtotal = COALESCE(o.merchandise_subtotal, item_totals.merchandise_subtotal),
           o.member_discount_amount = COALESCE(o.member_discount_amount, 0),
           o.shipping_fee = COALESCE(
             o.shipping_fee,
             CASE
               WHEN o.placed_by_type = 'public'
                AND o.total_amount - item_totals.merchandise_subtotal >= 159 THEN 159
               ELSE 0
             END
           ),
           o.system_fee = COALESCE(
             o.system_fee,
             GREATEST(
               o.total_amount - item_totals.merchandise_subtotal
               - CASE
                   WHEN o.placed_by_type = 'public'
                    AND o.total_amount - item_totals.merchandise_subtotal >= 159 THEN 159
                   ELSE 0
                 END,
               0
             )
           )
       WHERE o.merchandise_subtotal IS NULL
          OR o.member_discount_amount IS NULL
          OR o.shipping_fee IS NULL
          OR o.system_fee IS NULL`
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
