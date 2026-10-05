// Clears every order before go-live (management request 2026-10-05: "reset the Sales Channel and Orders"),
// so Orders, Sales Channels, dashboards and reports start from zero — and can be undone exactly.
//
// What --apply does, in ONE transaction:
//   1. releases the stock still reserved by open orders (pending, approved, delivering) and logs each
//      release as a stock movement — otherwise that stock would stay blocked forever;
//   2. soft-deletes every order (is_deleted = 1; nothing is DELETEd);
//   3. stops what still points at those orders: queued order emails are marked failed, their unread
//      in-app notifications are marked read, unused rider links are used up, settlements are soft-deleted.
// Stock already shipped by delivered orders is NOT put back: those boxes left the warehouse.
//
// Undo: --apply writes a journal (--journal=<file>, required) with every row it changed and that row's
// previous values, BEFORE committing. --rollback --journal=<file> puts exactly those rows back, including
// the reserved quantity per inventory row. It refuses (and changes nothing) when stock it would re-reserve
// has been sold since, or when the journal was already rolled back.
//
// Dry run by default for both directions; --apply does it. Idempotent: a second reset finds nothing.
// Refuses to run without an env file so it can never fall back to a default database.
// Run: node --env-file=.env.prod scripts/resetOrders.js                                   (dry run)
//      node --env-file=.env.prod scripts/resetOrders.js --apply --journal=/root/x.json   (reset)
//      node --env-file=.env.prod scripts/resetOrders.js --rollback --journal=/root/x.json [--apply]
const fs = require('fs');
const mysql = require('mysql2/promise');
const { releaseStock } = require('../src/services/batchStock');
const { insertStockMovement } = require('../src/utils/stockMovementLogger');

// Orders whose items are still reserved: reserved on placement, released on cancel/reject, consumed on delivery.
const RESERVING_STATUSES = new Set(['pending', 'approved', 'delivering']);
const RESET_NOTE = 'Orders reset before go-live';
const MOVEMENT_REFERENCE_TYPE = 'order_reset';

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

/** Per inventory row, how much reserved stock went down between two snapshots ({id: reserved}). */
function reservedDeltas(before, after) {
  return Object.keys(before)
    .map((id) => ({ inventory_id: Number(id), released: Number(before[id]) - Number(after[id] ?? before[id]) }))
    .filter((d) => d.released > 0);
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) counts[keyFn(row)] = (counts[keyFn(row)] || 0) + 1;
  return counts;
}

const placeholders = (ids) => ids.map(() => '?').join(', ');
const argValue = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;

async function reservedSnapshot(conn, releases) {
  const snapshot = {};
  for (const r of releases) {
    const [rows] = await conn.execute(
      'SELECT id, reserved_stock FROM inventories WHERE warehouse_id = ? AND product_id = ? FOR UPDATE',
      [r.warehouseId, r.productId]
    );
    for (const row of rows) snapshot[row.id] = Number(row.reserved_stock);
  }
  return snapshot;
}

async function reset(conn, { apply, journalPath }) {
  await conn.beginTransaction();
  const lock = apply ? ' FOR UPDATE' : '';
  const [orders] = await conn.execute(
    `SELECT id, order_number, status, payment_status, placed_by_type, source_warehouse_id, updated_at
     FROM orders WHERE is_deleted = 0 ORDER BY id${lock}`
  );
  console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'APPLY' : 'dry run'}`);
  if (orders.length === 0) {
    console.log('No orders to reset. Nothing changed.');
    await conn.rollback();
    return;
  }

  const ids = orders.map((o) => o.id);
  const ph = placeholders(ids);
  const [items] = await conn.execute(
    `SELECT order_id, product_id, quantity, source_warehouse_id FROM order_items WHERE order_id IN (${ph})`, ids
  );
  const releases = planReservationRelease(orders, items);
  const [notifications] = await conn.execute(
    `SELECT id FROM notifications WHERE entity_type = 'order' AND entity_id IN (${ph}) AND is_read = 0${lock}`, ids
  );
  const [outbox] = await conn.execute(
    `SELECT id, status, last_error FROM order_notification_outbox WHERE order_id IN (${ph}) AND status IN ('pending', 'retry', 'processing')${lock}`, ids
  );
  const [tokens] = await conn.execute(`SELECT id FROM delivery_tokens WHERE order_id IN (${ph}) AND is_used = 0${lock}`, ids);
  const [settlements] = await conn.execute(`SELECT id FROM settlements WHERE order_id IN (${ph}) AND is_deleted = 0${lock}`, ids);

  console.log(`\nOrders to remove: ${orders.length}`);
  console.table(countBy(orders, (o) => `${o.placed_by_type || 'unknown'} / ${o.status}`));
  console.log(`Delivered orders (stock already shipped, NOT put back): ${orders.filter((o) => o.status === 'delivered').length}`);
  console.log('\nReserved stock to release:');
  if (releases.length === 0) console.log('  none');
  for (const r of releases) console.log(`  warehouse #${r.warehouseId} product #${r.productId}: ${r.quantity} (from ${r.orderIds.size} open orders)`);
  console.log('\nAlso stopped:', {
    queued_emails: outbox.length, unread_notifications: notifications.length,
    live_rider_links: tokens.length, settlements: settlements.length,
  });

  if (!apply) {
    await conn.rollback();
    console.log('\nDry run only: nothing changed. Re-run with --apply --journal=<file> to reset.');
    return;
  }

  const runId = Date.now();
  const before = await reservedSnapshot(conn, releases);
  for (const r of releases) {
    const released = await releaseStock(conn, { productId: r.productId, warehouseId: r.warehouseId, quantity: r.quantity });
    if (released > 0) {
      await insertStockMovement(conn, {
        productId: r.productId, warehouseId: r.warehouseId, movementType: 'release', quantity: released,
        referenceType: MOVEMENT_REFERENCE_TYPE, referenceId: runId, notes: RESET_NOTE,
      });
    }
    const note = released === r.quantity ? '' : ` (only ${released} was still reserved)`;
    console.log(`Released ${released} of product #${r.productId} at warehouse #${r.warehouseId}${note}`);
  }
  const after = await reservedSnapshot(conn, releases);

  const [removed] = await conn.execute(`UPDATE orders SET is_deleted = 1 WHERE id IN (${ph}) AND is_deleted = 0`, ids);
  if (removed.affectedRows !== orders.length) {
    throw new Error(`Expected to remove ${orders.length} orders, removed ${removed.affectedRows}. Rolled back.`);
  }
  if (outbox.length) {
    await conn.execute(
      `UPDATE order_notification_outbox SET status = 'failed', last_error = ?, locked_at = NULL, lease_token = NULL WHERE id IN (${placeholders(outbox)})`,
      [RESET_NOTE, ...outbox.map((o) => o.id)]
    );
  }
  if (notifications.length) await conn.execute(`UPDATE notifications SET is_read = 1 WHERE id IN (${placeholders(notifications)})`, notifications.map((n) => n.id));
  if (tokens.length) await conn.execute(`UPDATE delivery_tokens SET is_used = 1 WHERE id IN (${placeholders(tokens)})`, tokens.map((t) => t.id));
  if (settlements.length) await conn.execute(`UPDATE settlements SET is_deleted = 1 WHERE id IN (${placeholders(settlements)})`, settlements.map((s) => s.id));

  // The journal is written before COMMIT: if it cannot be saved, nothing is changed.
  const journal = {
    database: process.env.DB_NAME,
    run_id: runId,
    created_at: new Date().toISOString(),
    orders: orders.map((o) => ({ id: o.id, order_number: o.order_number, updated_at: o.updated_at })),
    reserved_released: reservedDeltas(before, after),
    stock_movements: { reference_type: MOVEMENT_REFERENCE_TYPE, reference_id: runId },
    notification_ids: notifications.map((n) => n.id),
    outbox: outbox.map((o) => ({ id: o.id, status: o.status, last_error: o.last_error })),
    delivery_token_ids: tokens.map((t) => t.id),
    settlement_ids: settlements.map((s) => s.id),
    rolled_back_at: null,
  };
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

  await conn.commit();
  console.log(`\nDone: ${removed.affectedRows} orders removed. Undo file: ${journalPath}`);
}

async function rollback(conn, { apply, journalPath }) {
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  if (journal.database !== process.env.DB_NAME) throw new Error(`Journal is for ${journal.database}, not ${process.env.DB_NAME}. Nothing changed.`);
  if (journal.rolled_back_at) throw new Error(`Already rolled back at ${journal.rolled_back_at}. Nothing changed.`);

  console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'ROLLBACK' : 'rollback dry run'}  journal: ${journalPath}`);
  console.log({
    orders_to_restore: journal.orders.length,
    reserved_to_put_back: journal.reserved_released.reduce((sum, d) => sum + d.released, 0),
    notifications_to_mark_unread: journal.notification_ids.length,
    emails_to_requeue: journal.outbox.length,
    rider_links_to_reopen: journal.delivery_token_ids.length,
    settlements_to_restore: journal.settlement_ids.length,
  });

  await conn.beginTransaction();
  try {
    // Re-reserve first: if stock was sold since the reset, stop before touching anything.
    for (const d of journal.reserved_released) {
      const [rows] = await conn.execute('SELECT current_stock, reserved_stock FROM inventories WHERE id = ? FOR UPDATE', [d.inventory_id]);
      const row = rows[0];
      if (!row || Number(row.reserved_stock) + d.released > Number(row.current_stock)) {
        throw new Error(`Inventory #${d.inventory_id} no longer has ${d.released} unreserved units to re-reserve. Nothing changed.`);
      }
      if (apply) {
        await conn.execute('UPDATE inventories SET reserved_stock = reserved_stock + ? WHERE id = ? AND reserved_stock + ? <= current_stock',
          [d.released, d.inventory_id, d.released]);
      }
    }
    if (!apply) {
      await conn.rollback();
      console.log('\nRollback dry run: every check passed, nothing changed. Re-run with --apply to roll back.');
      return;
    }

    let restored = 0;
    for (const o of journal.orders) {
      // updated_at is set explicitly so the row reads exactly as it did before the reset.
      const [r] = await conn.execute('UPDATE orders SET is_deleted = 0, updated_at = ? WHERE id = ? AND is_deleted = 1', [new Date(o.updated_at), o.id]);
      restored += r.affectedRows;
    }
    await conn.execute(
      'UPDATE stock_movements SET is_deleted = 1 WHERE reference_type = ? AND reference_id = ?',
      [journal.stock_movements.reference_type, journal.stock_movements.reference_id]
    );
    if (journal.notification_ids.length) {
      await conn.execute(`UPDATE notifications SET is_read = 0 WHERE id IN (${placeholders(journal.notification_ids)})`, journal.notification_ids);
    }
    for (const o of journal.outbox) {
      await conn.execute('UPDATE order_notification_outbox SET status = ?, last_error = ? WHERE id = ? AND status = \'failed\' AND last_error = ?',
        [o.status, o.last_error, o.id, RESET_NOTE]);
    }
    if (journal.delivery_token_ids.length) {
      await conn.execute(`UPDATE delivery_tokens SET is_used = 0 WHERE id IN (${placeholders(journal.delivery_token_ids)})`, journal.delivery_token_ids);
    }
    if (journal.settlement_ids.length) {
      await conn.execute(`UPDATE settlements SET is_deleted = 0 WHERE id IN (${placeholders(journal.settlement_ids)})`, journal.settlement_ids);
    }
    await conn.commit();
    journal.rolled_back_at = new Date().toISOString();
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    console.log(`\nRolled back: ${restored} orders restored. The journal is marked as rolled back.`);
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const isRollback = process.argv.includes('--rollback');
  const journalPath = argValue('journal');
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<.env.dev|.env.prod>.');
  if ((apply || isRollback) && !journalPath) throw new Error('--journal=<file> is required for --apply and --rollback.');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    timezone: '+08:00',
  });
  try {
    if (isRollback) await rollback(conn, { apply, journalPath });
    else await reset(conn, { apply, journalPath });
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

module.exports = { planReservationRelease, reservedDeltas, RESERVING_STATUSES };
