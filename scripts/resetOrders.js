// Clears every order before go-live (management request 2026-10-05: "reset the Sales Channel and Orders"),
// so Orders, Sales Channels, dashboards and reports start from zero.
//
// What --apply does, in ONE transaction:
//   1. releases the stock still reserved by open orders (pending, approved, delivering) and logs each
//      release as a stock movement — otherwise that stock would stay blocked forever;
//   2. soft-deletes every order (is_deleted = 1; nothing is DELETEd, so it can be restored);
//   3. stops what still points at those orders: queued order emails are marked failed, their in-app
//      notifications are marked read, unused rider links are used up, settlements are soft-deleted.
// Stock already shipped by delivered orders is NOT put back: those boxes left the warehouse.
//
// Dry run by default: prints exactly what would change. Idempotent: a second --apply finds nothing.
// Refuses to run without an env file so it can never fall back to a default database.
// Run: node --env-file=.env.prod scripts/resetOrders.js            (dry run)
//      node --env-file=.env.prod scripts/resetOrders.js --apply    (do it)
const mysql = require('mysql2/promise');
const { releaseStock } = require('../src/services/batchStock');
const { insertStockMovement } = require('../src/utils/stockMovementLogger');

// Orders whose items are still reserved: reserved on placement, released on cancel/reject, consumed on delivery.
const RESERVING_STATUSES = new Set(['pending', 'approved', 'delivering']);
const RESET_NOTE = 'Orders reset before go-live';

/** Reserved quantities to release, grouped per warehouse + product, from open orders' items. */
function planReservationRelease(orders, items) {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const totals = new Map();
  for (const item of items) {
    const order = orderById.get(item.order_id);
    if (!order || !RESERVING_STATUSES.has(order.status)) continue;
    const warehouseId = item.source_warehouse_id || order.source_warehouse_id;
    if (!warehouseId) continue;
    const key = `${warehouseId}:${item.product_id}`;
    const entry = totals.get(key) || { warehouseId, productId: item.product_id, quantity: 0, orderIds: new Set() };
    entry.quantity += Number(item.quantity);
    entry.orderIds.add(order.id);
    totals.set(key, entry);
  }
  return [...totals.values()];
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) counts[keyFn(row)] = (counts[keyFn(row)] || 0) + 1;
  return counts;
}

const placeholders = (ids) => ids.map(() => '?').join(', ');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<.env.dev|.env.prod>.');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });

  try {
    await conn.beginTransaction();
    const lock = apply ? ' FOR UPDATE' : '';
    const [orders] = await conn.execute(
      `SELECT id, order_number, status, payment_status, placed_by_type, source_warehouse_id
       FROM orders WHERE is_deleted = 0 ORDER BY id${lock}`
    );
    console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'APPLY' : 'dry run'}`);
    if (orders.length === 0) {
      console.log('No orders to reset. Nothing changed.');
      await conn.rollback();
      return;
    }

    const ids = orders.map((o) => o.id);
    const [items] = await conn.execute(
      `SELECT order_id, product_id, quantity, source_warehouse_id FROM order_items WHERE order_id IN (${placeholders(ids)})`,
      ids
    );
    const releases = planReservationRelease(orders, items);
    const [[related]] = await conn.execute(
      `SELECT
         (SELECT COUNT(*) FROM order_notification_outbox WHERE order_id IN (${placeholders(ids)}) AND status IN ('pending', 'retry', 'processing')) AS queued_emails,
         (SELECT COUNT(*) FROM notifications WHERE entity_type = 'order' AND entity_id IN (${placeholders(ids)}) AND is_read = 0) AS unread_notifications,
         (SELECT COUNT(*) FROM delivery_tokens WHERE order_id IN (${placeholders(ids)}) AND is_used = 0) AS live_rider_links,
         (SELECT COUNT(*) FROM settlements WHERE order_id IN (${placeholders(ids)}) AND is_deleted = 0) AS settlements`,
      [...ids, ...ids, ...ids, ...ids]
    );

    console.log(`\nOrders to remove: ${orders.length}`);
    console.table(countBy(orders, (o) => `${o.placed_by_type || 'unknown'} / ${o.status}`));
    console.log(`Delivered orders (stock already shipped, NOT put back): ${orders.filter((o) => o.status === 'delivered').length}`);
    console.log('\nReserved stock to release:');
    if (releases.length === 0) console.log('  none');
    for (const r of releases) console.log(`  warehouse #${r.warehouseId} product #${r.productId}: ${r.quantity} (from ${r.orderIds.size} open orders)`);
    console.log('\nAlso stopped:', related);

    if (!apply) {
      await conn.rollback();
      console.log('\nDry run only: nothing changed. Re-run with --apply to reset.');
      return;
    }

    for (const r of releases) {
      const released = await releaseStock(conn, { productId: r.productId, warehouseId: r.warehouseId, quantity: r.quantity });
      if (released > 0) {
        await insertStockMovement(conn, {
          productId: r.productId,
          warehouseId: r.warehouseId,
          movementType: 'release',
          quantity: released,
          referenceType: 'order_reset',
          referenceId: null,
          notes: RESET_NOTE,
        });
      }
      const note = released === r.quantity ? '' : ` (only ${released} was still reserved)`;
      console.log(`Released ${released} of product #${r.productId} at warehouse #${r.warehouseId}${note}`);
    }

    const [removed] = await conn.execute(
      `UPDATE orders SET is_deleted = 1, updated_at = NOW() WHERE id IN (${placeholders(ids)}) AND is_deleted = 0`,
      ids
    );
    if (removed.affectedRows !== orders.length) {
      throw new Error(`Expected to remove ${orders.length} orders, removed ${removed.affectedRows}. Rolled back.`);
    }
    await conn.execute(
      `UPDATE order_notification_outbox SET status = 'failed', last_error = ?, locked_at = NULL, lease_token = NULL
       WHERE order_id IN (${placeholders(ids)}) AND status IN ('pending', 'retry', 'processing')`,
      [RESET_NOTE, ...ids]
    );
    await conn.execute(
      `UPDATE notifications SET is_read = 1 WHERE entity_type = 'order' AND entity_id IN (${placeholders(ids)}) AND is_read = 0`,
      ids
    );
    await conn.execute(`UPDATE delivery_tokens SET is_used = 1 WHERE order_id IN (${placeholders(ids)}) AND is_used = 0`, ids);
    await conn.execute(`UPDATE settlements SET is_deleted = 1 WHERE order_id IN (${placeholders(ids)}) AND is_deleted = 0`, ids);

    await conn.commit();
    console.log(`\nDone: ${removed.affectedRows} orders removed. Re-running changes nothing.`);
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('ERR', error.message);
    process.exit(1);
  });
}

module.exports = { planReservationRelease, RESERVING_STATUSES };
