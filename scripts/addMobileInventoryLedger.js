// Personal Mobile Stockist inventory is intentionally separate from warehouse
// inventory. Manual direct-sale recording can never mutate parent stock.
const mysql = require('mysql2/promise');

async function tableExists(pool, table) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
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
    if (!await tableExists(pool, 'mobile_inventories')) {
      await pool.query(
        `CREATE TABLE mobile_inventories (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          mobile_stockist_id BIGINT UNSIGNED NOT NULL,
          product_id BIGINT UNSIGNED NOT NULL,
          current_stock INT UNSIGNED NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_mobile_inventory_product (mobile_stockist_id, product_id),
          KEY idx_mobile_inventory_product (product_id),
          CONSTRAINT fk_mobile_inventory_stockist FOREIGN KEY (mobile_stockist_id) REFERENCES mobile_stockists(id),
          CONSTRAINT fk_mobile_inventory_product FOREIGN KEY (product_id) REFERENCES products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
      console.log('Created mobile_inventories');
    }
    if (!await tableExists(pool, 'mobile_inventory_movements')) {
      await pool.query(
        `CREATE TABLE mobile_inventory_movements (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          inventory_id BIGINT UNSIGNED NOT NULL,
          mobile_stockist_id BIGINT UNSIGNED NOT NULL,
          product_id BIGINT UNSIGNED NOT NULL,
          movement_type ENUM('manual_increase','manual_decrease') NOT NULL,
          quantity INT UNSIGNED NOT NULL,
          before_stock INT UNSIGNED NOT NULL,
          after_stock INT UNSIGNED NOT NULL,
          reason VARCHAR(255) NULL,
          created_by BIGINT UNSIGNED NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_mobile_movement_stockist_created (mobile_stockist_id, created_at),
          KEY idx_mobile_movement_product (product_id),
          CONSTRAINT fk_mobile_movement_inventory FOREIGN KEY (inventory_id) REFERENCES mobile_inventories(id),
          CONSTRAINT fk_mobile_movement_stockist FOREIGN KEY (mobile_stockist_id) REFERENCES mobile_stockists(id),
          CONSTRAINT fk_mobile_movement_product FOREIGN KEY (product_id) REFERENCES products(id),
          CONSTRAINT fk_mobile_movement_user FOREIGN KEY (created_by) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
      console.log('Created mobile_inventory_movements');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
