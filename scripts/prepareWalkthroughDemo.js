// Prepares the STAGING copy for a management walkthrough (2026-10-14 meeting): every role gets a demo
// sign-in with one known password, the demo Provincial and City warehouses get stock so their ordering
// screens work, and payment accounts tied to deleted warehouses are switched off.
//
// What --apply changes, in ONE transaction:
//   1. demo accounts, upserted by email (a soft-deleted holder is restored, never duplicated):
//        demo.admin (Super Admin), demo.caloocan and demo.tycoon (center staff), demo.provincial
//        (Provincial Stockist of TYCOON PS); test.city, test.mobile, test.staff keep their rows and only
//        get the walkthrough password. Real people's accounts are never touched.
//   2. stock: every active product reaches at least DEMO_STOCK available units in the TEST Provincial
//      and TEST City warehouses; each top-up is logged as a stock movement (reference walkthrough_prep).
//   3. payment accounts whose warehouse is deleted or missing are deactivated (is_active = 0).
//   4. each demo warehouse without a payment account gets one, clearly marked DEMO. Without it, a demo
//      Stockist order falls back to the company default account, which on this copy is a placeholder.
//   5. the TEST demo records get short names (the old ones, like "TEST — City Stockist — orders from
//      parent Provincial (40% discount)", wrapped over eight lines in lists). Only names starting with
//      "TEST" are renamed.
//
// Dry run by default; --apply does it. Idempotent: a second --apply only re-sets the password.
// Refuses any database whose name does not contain "staging" unless --allow-db=<exact name> is passed,
// so it cannot run against the live store. The password comes from WALKTHROUGH_PASSWORD (never stored).
// Run: WALKTHROUGH_PASSWORD='…' node --env-file=.env.prod scripts/prepareWalkthroughDemo.js [--apply]
//      node --env-file=.env.prod scripts/prepareWalkthroughDemo.js --disable [--apply]
//        switches every demo sign-in off after the meeting; the next --apply switches them back on.
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { insertStockMovement } = require('../src/utils/stockMovementLogger');

const DEMO_STOCK = 300;
const DEMO_BATCH = 'WALKTHROUGH-DEMO';
// expiry_date is NOT NULL (strict MySQL rejects a missing one); thresholds match the Add Stock form defaults,
// so 300 demo boxes do not show as "low stock" (the column default is 500).
const DEMO_EXPIRY_YEARS = 2;
const DEMO_REORDER_THRESHOLD = 50;
const DEMO_WARNING_THRESHOLD = 20;
const MOVEMENT_REFERENCE_TYPE = 'walkthrough_prep';
const DEMO_EMAIL_DOMAIN = 'example.com'; // reserved domain: mail to demo accounts never reaches a real inbox

// partner: a center or stockist found by business name; warehouse: that partner's first active warehouse.
const DEMO_ACCOUNTS = [
  { username: 'demo.admin', name: 'Demo Super Admin', role: 'super_admin', level: 'main', location: 'Head Office' },
  { username: 'demo.caloocan', name: 'Demo Staff CALOOCAN', role: 'staff', partner: 'CALOOCAN', withWarehouse: true, level: 'city', location: 'CALOOCAN' },
  { username: 'demo.tycoon', name: 'Demo Staff TYCOON', role: 'staff', partner: 'TYCOON', withWarehouse: true, level: 'city', location: 'TYCOON' },
  { username: 'demo.provincial', name: 'Demo Provincial Stockist', role: 'provincial_stockist', partner: 'TYCOON PS', level: 'regional', location: 'Demo Province' },
];
const EXISTING_DEMO_USERNAMES = ['test.city', 'test.mobile', 'test.staff'];
// Management chose a short shared password for the demo sign-ins (2026-10-13). Staging holds a copy of real
// customer details, so turn the accounts off with --disable when the walkthrough is over.
const MIN_PASSWORD_LENGTH = 6;
const ALL_DEMO_USERNAMES = [...DEMO_ACCOUNTS.map((a) => a.username), ...EXISTING_DEMO_USERNAMES];

/** Switches every demo sign-in off (status inactive). Dry run unless apply. */
async function disableDemoSignIns(conn, apply) {
  const ph = ALL_DEMO_USERNAMES.map(() => '?').join(', ');
  const [rows] = await conn.execute(`SELECT username, status FROM users WHERE username IN (${ph}) AND is_deleted = 0`, ALL_DEMO_USERNAMES);
  const active = rows.filter((r) => r.status === 'active');
  console.log(`Demo sign-ins to switch off: ${active.length ? active.map((r) => r.username).join(', ') : 'none (already off)'}`);
  if (!apply) {
    console.log('Dry run only: nothing changed. Re-run with --disable --apply.');
    return;
  }
  const [result] = await conn.execute(
    `UPDATE users SET status = 'inactive' WHERE username IN (${ph}) AND is_deleted = 0 AND status = 'active'`,
    ALL_DEMO_USERNAMES
  );
  console.log(`Done: ${result.affectedRows} demo sign-ins switched off.`);
}
const DEMO_USER_NAMES = { 'test.city': 'TEST City Stockist', 'test.mobile': 'TEST Mobile Stockist', 'test.staff': 'TEST City Staff' };

/** Short names for the TEST demo records; each entry only touches a row whose name starts with "TEST". */
async function planRenames(conn) {
  const plan = [];
  const add = (table, id, from, to) => { if (from !== to && /^TEST/.test(from)) plan.push({ table, id, from, to }); };
  for (const [username, name] of Object.entries(DEMO_USER_NAMES)) {
    const u = await one(conn, 'SELECT id, name, partner_id FROM users WHERE username = ? AND is_deleted = 0', [username]);
    if (!u) continue;
    add('users', u.id, u.name, name);
    if (username === 'test.mobile') {
      const ms = await one(conn, 'SELECT id, name FROM mobile_stockists WHERE user_id = ? AND is_deleted = 0', [u.id]);
      if (ms) add('mobile_stockists', ms.id, ms.name, name);
    }
    if (username === 'test.city') {
      const partner = await one(conn, 'SELECT id, business_name AS name FROM partners WHERE id = ?', [u.partner_id]);
      if (partner) add('partners', partner.id, partner.name, 'TEST City Stockist');
    }
  }
  for (const wh of await demoWarehouses(conn)) {
    add('warehouses', wh.id, wh.name, /provincial/i.test(wh.name) ? 'TEST Provincial Warehouse' : 'TEST City Warehouse');
  }
  return plan;
}
const RENAME_COLUMN = { users: 'name', mobile_stockists: 'name', partners: 'business_name', warehouses: 'name' };

const argValue = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;

async function one(conn, sql, params) {
  const [rows] = await conn.execute(sql, params);
  return rows[0] || null;
}

async function resolveAccount(conn, spec) {
  const role = await one(conn, 'SELECT id FROM roles WHERE slug = ?', [spec.role]);
  if (!role) throw new Error(`Role ${spec.role} is missing. Nothing changed.`);
  let partnerId = null;
  let warehouseId = null;
  if (spec.partner) {
    const partner = await one(conn, 'SELECT id FROM partners WHERE business_name = ? AND is_deleted = 0 ORDER BY id LIMIT 1', [spec.partner]);
    if (!partner) throw new Error(`Stockist "${spec.partner}" not found. Nothing changed.`);
    partnerId = partner.id;
    if (spec.withWarehouse) {
      const wh = await one(conn, 'SELECT id FROM warehouses WHERE partner_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1', [partnerId]);
      if (!wh) throw new Error(`"${spec.partner}" has no warehouse. Nothing changed.`);
      warehouseId = wh.id;
    }
  }
  const email = `${spec.username}@${DEMO_EMAIL_DOMAIN}`;
  const byEmail = await one(conn, 'SELECT id, is_deleted FROM users WHERE email = ?', [email]);
  const byUsername = await one(conn, 'SELECT id, email FROM users WHERE username = ?', [spec.username]);
  if (byUsername && (!byEmail || byUsername.id !== byEmail.id)) {
    throw new Error(`Username ${spec.username} already belongs to ${byUsername.email}. Nothing changed.`);
  }
  return { ...spec, email, roleId: role.id, partnerId, warehouseId, existing: byEmail };
}

/** Demo warehouses that need stock: the TEST Provincial (TYCOON PS) and TEST City (test.city's stockist) ones. */
async function demoWarehouses(conn) {
  const [rows] = await conn.execute(
    `SELECT w.id, w.name, w.partner_id FROM warehouses w
     WHERE w.is_deleted = 0 AND w.partner_id IN (
       (SELECT id FROM partners WHERE business_name = 'TYCOON PS' AND is_deleted = 0 ORDER BY id LIMIT 1),
       (SELECT partner_id FROM users WHERE username = 'test.city' AND is_deleted = 0 LIMIT 1))
     ORDER BY w.id`
  );
  return rows;
}

async function planStock(conn, warehouses) {
  const [products] = await conn.execute('SELECT id, name FROM products WHERE is_deleted = 0 AND is_active = 1 ORDER BY id');
  const plan = [];
  for (const wh of warehouses) {
    for (const p of products) {
      const [rows] = await conn.execute(
        `SELECT id, current_stock, reserved_stock FROM inventories WHERE warehouse_id = ? AND product_id = ? ORDER BY id`,
        [wh.id, p.id]
      );
      const available = rows.reduce((sum, r) => sum + Number(r.current_stock) - Number(r.reserved_stock), 0);
      if (available >= DEMO_STOCK) continue;
      plan.push({ warehouse: wh, product: p, add: DEMO_STOCK - available, inventoryId: rows[0]?.id || null });
    }
  }
  return plan;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dbName = process.env.DB_NAME;
  if (!dbName) throw new Error('DB_NAME is not set. Run with --env-file=<env>.');
  if (!/staging/i.test(dbName) && argValue('allow-db') !== dbName) {
    throw new Error(`Refusing to run on "${dbName}": this script is for the staging copy only. Nothing changed.`);
  }
  const disable = process.argv.includes('--disable');
  const password = process.env.WALKTHROUGH_PASSWORD || '';
  if (apply && !disable && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Set WALKTHROUGH_PASSWORD (${MIN_PASSWORD_LENGTH}+ characters) for --apply. Nothing changed.`);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', database: dbName, timezone: '+08:00',
  });
  try {
    if (disable) {
      console.log(`Database: ${dbName}  mode: ${apply ? 'DISABLE' : 'disable dry run'}`);
      await disableDemoSignIns(conn, apply);
      return;
    }
    await conn.beginTransaction();
    console.log(`Database: ${dbName}  mode: ${apply ? 'APPLY' : 'dry run'}\n`);

    const accounts = [];
    for (const spec of DEMO_ACCOUNTS) accounts.push(await resolveAccount(conn, spec));
    const [existingDemo] = await conn.execute(
      `SELECT id, username FROM users WHERE username IN (${EXISTING_DEMO_USERNAMES.map(() => '?').join(', ')}) AND is_deleted = 0`,
      EXISTING_DEMO_USERNAMES
    );
    console.log('Demo sign-ins (all get the walkthrough password):');
    for (const a of accounts) console.log(`  ${a.username.padEnd(16)} ${a.role.padEnd(20)} ${a.existing ? (a.existing.is_deleted ? 'restore' : 'update') : 'create'}`);
    for (const u of existingDemo) console.log(`  ${u.username.padEnd(16)} ${'(existing demo)'.padEnd(20)} password only`);
    const missing = EXISTING_DEMO_USERNAMES.filter((n) => !existingDemo.some((u) => u.username === n));
    if (missing.length) console.log(`  not found, skipped: ${missing.join(', ')}`);

    const warehouses = await demoWarehouses(conn);
    const stockPlan = await planStock(conn, warehouses);
    console.log(`\nDemo stock (each product to at least ${DEMO_STOCK} available):`);
    if (warehouses.length === 0) console.log('  no demo warehouses found');
    for (const wh of warehouses) {
      const adds = stockPlan.filter((s) => s.warehouse.id === wh.id);
      console.log(`  ${wh.name}: ${adds.length ? adds.map((s) => `${s.product.name} +${s.add}`).join(', ') : 'already stocked'}`);
    }

    const [staleBanks] = await conn.execute(
      `SELECT b.id, b.bank_name, b.account_name, b.warehouse_id FROM bank_accounts b
       LEFT JOIN warehouses w ON w.id = b.warehouse_id
       WHERE b.is_active = 1 AND b.is_deleted = 0 AND b.warehouse_id IS NOT NULL AND (w.id IS NULL OR w.is_deleted = 1)`
    );
    console.log('\nPayment accounts tied to a deleted warehouse (to deactivate):');
    if (staleBanks.length === 0) console.log('  none');
    for (const b of staleBanks) console.log(`  #${b.id} ${b.bank_name} (${b.account_name}), warehouse #${b.warehouse_id}`);

    const [banklessWarehouses] = warehouses.length ? await conn.execute(
      `SELECT w.id, w.name FROM warehouses w
       WHERE w.id IN (${warehouses.map(() => '?').join(', ')})
         AND NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.warehouse_id = w.id AND b.is_active = 1 AND b.is_deleted = 0)`,
      warehouses.map((w) => w.id)
    ) : [[]];
    console.log('\nDemo payment accounts:');
    if (banklessWarehouses.length === 0) console.log('  none needed');
    for (const w of banklessWarehouses) console.log(`  ${w.name}: add "DEMO BANK"`);

    const renames = await planRenames(conn);
    console.log('\nShorter demo names:');
    if (renames.length === 0) console.log('  none needed');
    for (const r of renames) console.log(`  ${r.table} #${r.id}: "${r.from}" -> "${r.to}"`);

    if (!apply) {
      await conn.rollback();
      console.log('\nDry run only: nothing changed. Re-run with WALKTHROUGH_PASSWORD=… and --apply.');
      return;
    }

    const hash = await bcrypt.hash(password, 12);
    for (const a of accounts) {
      if (a.existing) {
        await conn.execute(
          `UPDATE users SET name = ?, username = ?, password = ?, role_id = ?, partner_id = ?, warehouse_id = ?,
                  level = ?, location = ?, status = 'active', is_deleted = 0 WHERE id = ?`,
          [a.name, a.username, hash, a.roleId, a.partnerId, a.warehouseId, a.level, a.location, a.existing.id]
        );
      } else {
        await conn.execute(
          `INSERT INTO users (name, email, username, password, role_id, partner_id, warehouse_id, level, location, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [a.name, a.email, a.username, hash, a.roleId, a.partnerId, a.warehouseId, a.level, a.location]
        );
      }
    }
    if (existingDemo.length) {
      await conn.execute(
        `UPDATE users SET password = ?, status = 'active' WHERE id IN (${existingDemo.map(() => '?').join(', ')})`,
        [hash, ...existingDemo.map((u) => u.id)]
      );
    }

    for (const s of stockPlan) {
      if (s.inventoryId) {
        await conn.execute('UPDATE inventories SET current_stock = current_stock + ?, last_movement_at = NOW() WHERE id = ?', [s.add, s.inventoryId]);
      } else {
        await conn.execute(
          `INSERT INTO inventories (product_id, warehouse_id, partner_id, current_stock, batch_number, expiry_date,
                                    reorder_threshold, warning_threshold, last_movement_at)
           VALUES (?, ?, ?, ?, ?, CURDATE() + INTERVAL ? YEAR, ?, ?, NOW())`,
          [s.product.id, s.warehouse.id, s.warehouse.partner_id, s.add, DEMO_BATCH,
            DEMO_EXPIRY_YEARS, DEMO_REORDER_THRESHOLD, DEMO_WARNING_THRESHOLD]
        );
      }
      await insertStockMovement(conn, {
        productId: s.product.id, warehouseId: s.warehouse.id, movementType: 'manual_increase', quantity: s.add,
        referenceType: MOVEMENT_REFERENCE_TYPE, notes: 'Demo stock for the management walkthrough',
      });
    }

    if (staleBanks.length) {
      await conn.execute(
        `UPDATE bank_accounts SET is_active = 0 WHERE id IN (${staleBanks.map(() => '?').join(', ')}) AND is_active = 1`,
        staleBanks.map((b) => b.id)
      );
    }

    for (const w of banklessWarehouses) {
      await conn.execute(
        `INSERT INTO bank_accounts (warehouse_id, bank_name, account_name, account_number, account_type, is_default, is_active)
         SELECT ?, 'DEMO BANK', 'Demo account (walkthrough only)', ?, 'Savings', 0, 1 FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM bank_accounts WHERE warehouse_id = ? AND is_active = 1 AND is_deleted = 0)`,
        [w.id, `DEMO-${String(w.id).padStart(4, '0')}`, w.id]
      );
    }

    for (const r of renames) {
      const column = RENAME_COLUMN[r.table];
      await conn.execute(`UPDATE ${r.table} SET ${column} = ? WHERE id = ? AND ${column} LIKE 'TEST%'`, [r.to, r.id]);
    }

    await conn.commit();
    console.log(`\nDone: ${accounts.length + existingDemo.length} demo sign-ins ready, ${stockPlan.length} stock top-ups, ${staleBanks.length} payment accounts deactivated, ${banklessWarehouses.length} demo payment accounts added, ${renames.length} names shortened.`);
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
