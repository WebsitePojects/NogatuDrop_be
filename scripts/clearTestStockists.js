// Clears test Stockists so a fresh set can be added (Sir Dino, 2026-11-24: "clear the stockist list so I have a
// blank canvas" on staging; on live only together with the updates, from a list he has approved).
//
// For each Provincial / City Stockist chosen (the hubs Caloocan and Tycoon are never touched):
//   - its open orders (pending, approved, delivering) are cancelled and their reserved stock released, exactly as
//     a cancel does in the app (releaseStock + a 'release' stock movement); then all its orders are archived
//     (is_deleted = 1), so lists and reports start clean;
//   - its logins, Mobile Stockists, warehouses and their payment accounts are soft-deleted;
//   - its store territories are removed (assignment rows; a deleted holder would otherwise keep the area);
//   - the Stockist itself is soft-deleted.
// One transaction: all or nothing. Re-running finds nothing left to do. Dry run unless --apply.
//
// Staging (every non-hub Stockist):   node --env-file=.env.prod scripts/clearTestStockists.js [--apply]
// Live (only an approved list):       node --env-file=.env.prod scripts/clearTestStockists.js --live --ids=3,8,12 [--apply]
const mysql = require('mysql2/promise');
const { releaseStock } = require('../src/services/batchStock');
const { insertStockMovement } = require('../src/utils/stockMovementLogger');

const STOCKIST_LEVELS = ['provincial_stockist', 'city_stockist'];
const OPEN_STATUSES = ['pending', 'approved', 'delivering'];
const REASON = 'Test data cleared';

function readArgs(argv) {
  const ids = (argv.find((a) => a.startsWith('--ids=')) || '').slice('--ids='.length)
    .split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return { apply: argv.includes('--apply'), live: argv.includes('--live'), ids };
}

/** The Stockists to clear. Staging: all of them. Live: only the listed ids, and every one must exist. */
async function pickStockists(conn, { live, ids }) {
  const levels = STOCKIST_LEVELS.map(() => '?').join(', ');
  if (!live) {
    const [rows] = await conn.query(
      `SELECT id, business_name, stockist_level FROM partners
       WHERE is_deleted = 0 AND stockist_level IN (${levels}) ORDER BY id`,
      STOCKIST_LEVELS
    );
    return rows;
  }
  if (ids.length === 0) throw new Error('On live, pass the approved list: --ids=1,2,3');
  const [rows] = await conn.query(
    `SELECT id, business_name, stockist_level FROM partners
     WHERE is_deleted = 0 AND stockist_level IN (${levels}) AND id IN (?) ORDER BY id`,
    [...STOCKIST_LEVELS, ids]
  );
  const missing = ids.filter((id) => !rows.some((r) => Number(r.id) === id));
  if (missing.length) throw new Error(`Not a live, non-hub Stockist: ${missing.join(', ')}. Nothing changed.`);
  return rows;
}

async function releaseOpenOrders(conn, orders) {
  for (const order of orders) {
    const [cancelled] = await conn.execute(
      `UPDATE orders SET status = 'cancelled', cancellation_reason = ?, updated_at = NOW()
       WHERE id = ? AND status IN ('pending', 'approved', 'delivering') AND is_deleted = 0`,
      [REASON, order.id]
    );
    if (cancelled.affectedRows !== 1) continue; // already handled: never release twice
    const [items] = await conn.execute(
      'SELECT product_id, quantity, source_warehouse_id FROM order_items WHERE order_id = ?',
      [order.id]
    );
    for (const item of items) {
      const warehouseId = item.source_warehouse_id || order.source_warehouse_id;
      if (!warehouseId) continue;
      await releaseStock(conn, { productId: item.product_id, warehouseId, quantity: item.quantity });
      await insertStockMovement(conn, {
        productId: item.product_id,
        warehouseId,
        movementType: 'release',
        quantity: item.quantity,
        referenceType: 'order',
        referenceId: order.id,
        notes: `Reserved stock released: ${REASON.toLowerCase()}`,
      });
    }
  }
}

async function main() {
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<env>.');
  const args = readArgs(process.argv);
  const isStagingDb = /_staging$/.test(process.env.DB_NAME);
  if (!isStagingDb && !args.live) throw new Error(`${process.env.DB_NAME} is not a staging database. For live, use --live --ids=<approved list>.`);
  if (isStagingDb && args.live) throw new Error('--live is for the live database only.');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });
  try {
    console.log(`Database: ${process.env.DB_NAME}  mode: ${args.apply ? 'APPLY' : 'DRY RUN'}`);
    const stockists = await pickStockists(conn, args);
    if (stockists.length === 0) { console.log('No Stockists to clear. Nothing to do.'); return; }
    const ids = stockists.map((s) => s.id);
    stockists.forEach((s) => console.log(`  stockist #${s.id} ${s.business_name} (${s.stockist_level})`));

    const [orders] = await conn.query(
      'SELECT id, order_number, status, source_warehouse_id FROM orders WHERE partner_id IN (?) AND is_deleted = 0', [ids]
    );
    const openOrders = orders.filter((o) => OPEN_STATUSES.includes(o.status));
    const [[counts]] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE partner_id IN (?) AND is_deleted = 0) AS users,
         (SELECT COUNT(*) FROM mobile_stockists WHERE partner_id IN (?) AND is_deleted = 0) AS mobiles,
         (SELECT COUNT(*) FROM warehouses WHERE partner_id IN (?) AND is_deleted = 0) AS warehouses,
         (SELECT COUNT(*) FROM bank_accounts ba JOIN warehouses w ON w.id = ba.warehouse_id
            WHERE w.partner_id IN (?) AND ba.is_deleted = 0) AS accounts,
         (SELECT COUNT(*) FROM stockist_territories WHERE partner_id IN (?)) AS territories`,
      [ids, ids, ids, ids, ids]
    );
    console.log(`${args.apply ? 'clear' : 'would clear'}: ${stockists.length} Stockists, ${counts.users} logins, ${counts.mobiles} Mobile Stockists, `
      + `${counts.warehouses} warehouses, ${counts.accounts} payment accounts, ${counts.territories} territories, `
      + `${orders.length} orders (${openOrders.length} open, their reserved stock released)`);
    if (!args.apply) { console.log('\nDry run only. Re-run with --apply.'); return; }

    await conn.beginTransaction();
    await releaseOpenOrders(conn, openOrders);
    await conn.query('UPDATE orders SET is_deleted = 1, archived_at = COALESCE(archived_at, NOW()) WHERE partner_id IN (?) AND is_deleted = 0', [ids]);
    await conn.query("UPDATE users SET is_deleted = 1, status = 'inactive' WHERE partner_id IN (?) AND is_deleted = 0", [ids]);
    await conn.query("UPDATE mobile_stockists SET is_deleted = 1, status = 'inactive' WHERE partner_id IN (?) AND is_deleted = 0", [ids]);
    await conn.query(
      `UPDATE bank_accounts ba JOIN warehouses w ON w.id = ba.warehouse_id
       SET ba.is_deleted = 1 WHERE w.partner_id IN (?) AND ba.is_deleted = 0`, [ids]
    );
    await conn.query('UPDATE warehouses SET is_deleted = 1, is_active = 0 WHERE partner_id IN (?) AND is_deleted = 0', [ids]);
    await conn.query('DELETE FROM stockist_territories WHERE partner_id IN (?)', [ids]);
    await conn.query("UPDATE partners SET is_deleted = 1, status = 'inactive' WHERE id IN (?) AND is_deleted = 0", [ids]);
    await conn.commit();
    console.log('Done.');
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
