// scripts/productionReset.js
//
// Turns a seeded/demo NCDMS database into a clean PRODUCTION starting state:
//   1. Creates (or restores) exactly one real super admin account.
//   2. Creates a small, clearly-labeled "TEST — " org tree (provincial ->
//      city -> mobile stockist + a warehouse-assigned staff account) so the
//      client can see every role working end-to-end before real Stockists
//      sign up.
//   3. Soft-deletes every other seed user/partner/warehouse/mobile stockist.
//
// PRESERVED, ALWAYS:
//   - The new/restored super admin.
//   - The TEST org tree created by this script.
//   - Any warehouse with partner_id IS NULL (the manufacturer/company
//     warehouse, e.g. "Goldenstar Warehouse").
//   - The entire `products` table (never touched).
//
// SAFETY
//   - DRY RUN BY DEFAULT. Nothing is written unless you pass --apply.
//   - Everything in --apply runs inside ONE transaction; any error rolls
//     back the whole thing.
//   - Idempotent: running --apply twice does not duplicate the super admin
//     or the TEST org tree (matched by email / warehouse name), and the
//     archive step is re-derived from those same identifiers every time
//     (not from captured ids), so it is safe to re-run after partial state.
//   - Never DELETEs a row — everything is soft-deleted (is_deleted = 1).
//   - Defensive against schema drift: optional columns (users.warehouse_id,
//     partners.parent_partner_id/stockist_level/discount_pct,
//     mobile_stockists.user_id/discount_pct) are guarded with
//     ER_BAD_FIELD_ERROR fallbacks, same pattern as
//     src/controllers/courierController.js.
//
// USAGE
//   Dry run (default, safe, zero writes):
//     node --env-file=.env.dev  scripts/productionReset.js
//     node --env-file=.env.prod scripts/productionReset.js
//
//   Apply for real:
//     SEED_SUPERADMIN_PASSWORD='<strong password>' \
//     node --env-file=.env.prod scripts/productionReset.js --apply
//
//   Apply and also wipe seeded transactional data (orders/carts/transfers/
//   GRNs) for a fully fresh transactional slate — OFF by default:
//     SEED_SUPERADMIN_PASSWORD='<strong password>' \
//     node --env-file=.env.prod scripts/productionReset.js --apply --wipe-transactions
//
// See scripts/PRODUCTION_RESET_README.md for full details.

const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

const APPLY = process.argv.includes('--apply');
const WIPE_TRANSACTIONS = process.argv.includes('--wipe-transactions');

const BCRYPT_ROUNDS = 12;

const SEED_SUPERADMIN_EMAIL = (process.env.SEED_SUPERADMIN_EMAIL || 'admin@nogatu.store').trim().toLowerCase();
const SEED_SUPERADMIN_PASSWORD = process.env.SEED_SUPERADMIN_PASSWORD || '';
const SEED_TEST_PASSWORD = process.env.SEED_TEST_PASSWORD || 'NogatuTest#2026';

// Extra real accounts to preserve, on top of the super admin / TEST org tree
// above. Comma-separated emails, case-insensitive, blanks dropped. Empty by
// default — archive behavior is unchanged when unset.
const SEED_KEEP_EMAILS = new Set(
  (process.env.SEED_KEEP_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// ---------------------------------------------------------------------------
// Fixed identifiers for the TEST org tree. Matched on every run by email /
// name — this is what makes --apply idempotent without needing to persist
// captured ids anywhere.
// ---------------------------------------------------------------------------
const TEST_PROVINCIAL_PARTNER = {
  business_name: 'TEST — Provincial Stockist (45% discount)',
  email: 'test.provincial.partner@nogatu.store',
  phone: '+639000000001',
  address: 'TEST Provincial Warehouse, Manila, Philippines',
  region: 'NCR (Test)',
  stockist_level: 'provincial_stockist',
  discount_pct: 45.0,
};

const TEST_PROVINCIAL_WAREHOUSE = {
  name: 'TEST — Provincial Warehouse',
  type: 'region',
  location: 'Manila, Philippines',
  capacity_total: 5000,
  capacity_used: 0,
  manager_name: 'TEST Warehouse Manager',
  manager_email: TEST_PROVINCIAL_PARTNER.email,
  manager_phone: TEST_PROVINCIAL_PARTNER.phone,
  lat: 14.5995,
  lng: 120.9842,
};

const TEST_PROVINCIAL_USER = {
  name: 'TEST Provincial Stockist — orders from Goldenstar (45% discount)',
  email: 'test.provincial@nogatu.store',
  phone: '+639000000011',
  roleSlug: 'provincial_stockist',
  level: 'regional',
  location: 'Manila, Philippines',
};

const TEST_CITY_PARTNER = {
  business_name: 'TEST — City Stockist (40% discount)',
  email: 'test.city.partner@nogatu.store',
  phone: '+639000000002',
  address: 'TEST City Warehouse, Quezon City, Philippines',
  region: 'Metro Manila (Test)',
  stockist_level: 'city_stockist',
  discount_pct: 40.0,
};

const TEST_CITY_WAREHOUSE = {
  name: 'TEST — City Warehouse',
  type: 'city',
  location: 'Quezon City, Philippines',
  capacity_total: 2000,
  capacity_used: 0,
  manager_name: 'TEST City Warehouse Manager',
  manager_email: TEST_CITY_PARTNER.email,
  manager_phone: TEST_CITY_PARTNER.phone,
  lat: 14.676,
  lng: 121.0437,
};

const TEST_CITY_USER = {
  name: 'TEST City Stockist — orders from parent Provincial (40% discount)',
  email: 'test.city@nogatu.store',
  phone: '+639000000012',
  roleSlug: 'city_stockist',
  level: 'city',
  location: 'Quezon City, Philippines',
};

// Mobile stockists have no discount_pct column on mobile_stockists in the
// current schema (discount lives on partners). 35% is captured here anyway
// per the June management decision and attempted defensively in case a
// newer schema adds the column — see upsertMobileStockistRow().
const TEST_MOBILE_USER = {
  name: 'TEST Mobile Stockist — orders assigned to parent City (35% discount)',
  email: 'test.mobile@nogatu.store',
  phone: '+639000000013',
  roleSlug: 'mobile_stockist',
  level: 'city',
  location: 'Quezon City Mobile Route (Test)',
  discount_pct: 35.0,
};

const TEST_STAFF_USER = {
  name: 'TEST Staff — warehouse-assigned, can order / adjust inventory / approve lower-tier',
  email: 'test.staff@nogatu.store',
  phone: '+639000000014',
  roleSlug: 'staff',
  level: 'city',
  location: 'TEST — City Warehouse',
};

const TEST_USER_EMAILS = [
  TEST_PROVINCIAL_USER.email,
  TEST_CITY_USER.email,
  TEST_MOBILE_USER.email,
  TEST_STAFF_USER.email,
];
const TEST_PARTNER_EMAILS = [TEST_PROVINCIAL_PARTNER.email, TEST_CITY_PARTNER.email];
const TEST_WAREHOUSE_NAMES = [TEST_PROVINCIAL_WAREHOUSE.name, TEST_CITY_WAREHOUSE.name];

const REQUIRED_ROLE_SLUGS = ['super_admin', 'provincial_stockist', 'city_stockist', 'mobile_stockist', 'staff'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isMissingColumnError = (err) => err && err.code === 'ER_BAD_FIELD_ERROR';
const isMissingTableError = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_NO_SUCH_TABLE_EXISTS');

// Tries a list of { sql, params } attempts in order, falling back to the
// next one only when the error is a missing-column error (schema drift
// guard, mirrors src/controllers/courierController.js).
async function execCascade(conn, attempts) {
  let lastErr;
  for (const attempt of attempts) {
    try {
      return await conn.execute(attempt.sql, attempt.params);
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// Appends "AND LOWER(<column>) NOT IN (...)" against SEED_KEEP_EMAILS, or a
// no-op clause if the allowlist is empty (query text unchanged in that case).
function notInKeepEmailsClause(column) {
  if (SEED_KEEP_EMAILS.size === 0) return { sql: '', params: [] };
  const arr = [...SEED_KEEP_EMAILS];
  return { sql: ` AND LOWER(${column}) NOT IN (${arr.map(() => '?').join(',')})`, params: arr };
}

// Appends "AND (<column> IS NULL OR <column> NOT IN (SELECT id FROM partners
// WHERE LOWER(email) IN (...)))" so rows belonging to a kept partner
// (warehouses, mobile_stockists) are preserved too. No-op when list is empty.
function notInKeptPartnerIdsClause(column) {
  if (SEED_KEEP_EMAILS.size === 0) return { sql: '', params: [] };
  const arr = [...SEED_KEEP_EMAILS];
  return {
    sql: ` AND (${column} IS NULL OR ${column} NOT IN (SELECT id FROM partners WHERE LOWER(email) IN (${arr.map(() => '?').join(',')})))`,
    params: arr,
  };
}

function printTable(title, rows) {
  console.log(`\n${title} (${rows.length})`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  console.table(rows);
}

async function getRoleIdMap(conn) {
  const [rows] = await conn.execute(
    `SELECT id, slug FROM roles WHERE slug IN (?, ?, ?, ?, ?)`,
    REQUIRED_ROLE_SLUGS
  );
  const map = {};
  for (const row of rows) map[row.slug] = row.id;
  const missing = REQUIRED_ROLE_SLUGS.filter((slug) => !map[slug]);
  if (missing.length > 0) {
    throw new Error(
      `Fail closed: required role slug(s) missing from roles table: ${missing.join(', ')}. ` +
        `Run the role/migration scripts before productionReset.js.`
    );
  }
  return map;
}

// ---------------------------------------------------------------------------
// Upserts — each matches on a stable natural key (email / name), restores
// soft-deleted rows in place, and never creates a duplicate on re-run.
// ---------------------------------------------------------------------------

async function upsertUser(conn, { email, name, passwordHash, phone, roleId, partnerId, warehouseId, level, location }) {
  const [existingRows] = await conn.execute('SELECT id, is_deleted FROM users WHERE email = ? LIMIT 1', [email]);
  const existing = existingRows[0];
  const wasDeleted = existing ? existing.is_deleted === 1 : false;

  if (existing) {
    await execCascade(conn, [
      {
        sql: `UPDATE users SET name=?, password=?, phone=?, role_id=?, partner_id=?, warehouse_id=?, level=?, location=?, status='active', is_deleted=0
              WHERE id=?`,
        params: [name, passwordHash, phone, roleId, partnerId, warehouseId, level, location, existing.id],
      },
      {
        sql: `UPDATE users SET name=?, password=?, phone=?, role_id=?, partner_id=?, level=?, location=?, status='active', is_deleted=0
              WHERE id=?`,
        params: [name, passwordHash, phone, roleId, partnerId, level, location, existing.id],
      },
    ]);
    return { id: existing.id, action: wasDeleted ? 'restored' : 'updated' };
  }

  const [result] = await execCascade(conn, [
    {
      sql: `INSERT INTO users (name, email, password, phone, role_id, partner_id, warehouse_id, level, location, status, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
      params: [name, email, passwordHash, phone, roleId, partnerId, warehouseId, level, location],
    },
    {
      sql: `INSERT INTO users (name, email, password, phone, role_id, partner_id, level, location, status, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
      params: [name, email, passwordHash, phone, roleId, partnerId, level, location],
    },
  ]);
  return { id: result.insertId, action: 'created' };
}

async function upsertPartner(conn, def) {
  const [existingRows] = await conn.execute('SELECT id, is_deleted FROM partners WHERE email = ? LIMIT 1', [def.email]);
  const existing = existingRows[0];
  const wasDeleted = existing ? existing.is_deleted === 1 : false;

  if (existing) {
    await execCascade(conn, [
      {
        sql: `UPDATE partners SET business_name=?, phone=?, address=?, status='active', region=?,
              stockist_level=?, parent_partner_id=?, discount_pct=?, is_deleted=0 WHERE id=?`,
        params: [def.business_name, def.phone, def.address, def.region, def.stockist_level, def.parent_partner_id, def.discount_pct, existing.id],
      },
      {
        sql: `UPDATE partners SET business_name=?, phone=?, address=?, status='active', region=?, is_deleted=0 WHERE id=?`,
        params: [def.business_name, def.phone, def.address, def.region, existing.id],
      },
    ]);
    return { id: existing.id, action: wasDeleted ? 'restored' : 'updated' };
  }

  const [result] = await execCascade(conn, [
    {
      sql: `INSERT INTO partners (business_name, email, phone, address, status, region, stockist_level, parent_partner_id, discount_pct, is_deleted)
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 0)`,
      params: [def.business_name, def.email, def.phone, def.address, def.region, def.stockist_level, def.parent_partner_id, def.discount_pct],
    },
    {
      sql: `INSERT INTO partners (business_name, email, phone, address, status, region, is_deleted)
            VALUES (?, ?, ?, ?, 'active', ?, 0)`,
      params: [def.business_name, def.email, def.phone, def.address, def.region],
    },
  ]);
  return { id: result.insertId, action: 'created' };
}

async function upsertWarehouse(conn, def, partnerId) {
  const [existingRows] = await conn.execute('SELECT id, is_deleted FROM warehouses WHERE name = ? LIMIT 1', [def.name]);
  const existing = existingRows[0];
  const wasDeleted = existing ? existing.is_deleted === 1 : false;

  if (existing) {
    await conn.execute(
      `UPDATE warehouses SET partner_id=?, type=?, location=?, capacity_total=?, capacity_used=?,
       manager_name=?, manager_email=?, manager_phone=?, lat=?, lng=?, is_active=1, is_deleted=0 WHERE id=?`,
      [partnerId, def.type, def.location, def.capacity_total, def.capacity_used, def.manager_name, def.manager_email, def.manager_phone, def.lat, def.lng, existing.id]
    );
    return { id: existing.id, action: wasDeleted ? 'restored' : 'updated' };
  }

  const [result] = await conn.execute(
    `INSERT INTO warehouses (partner_id, name, type, location, capacity_total, capacity_used, manager_name, manager_email, manager_phone, lat, lng, is_active, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    [partnerId, def.name, def.type, def.location, def.capacity_total, def.capacity_used, def.manager_name, def.manager_email, def.manager_phone, def.lat, def.lng]
  );
  return { id: result.insertId, action: 'created' };
}

async function upsertMobileStockistRow(conn, def, userId, partnerId) {
  const [existingRows] = await conn.execute('SELECT id, is_deleted FROM mobile_stockists WHERE email = ? LIMIT 1', [def.email]);
  const existing = existingRows[0];
  const wasDeleted = existing ? existing.is_deleted === 1 : false;

  if (existing) {
    await execCascade(conn, [
      {
        sql: `UPDATE mobile_stockists SET user_id=?, name=?, phone=?, address=?, partner_id=?, status='active', discount_pct=?, is_deleted=0 WHERE id=?`,
        params: [userId, def.name, def.phone, def.location, partnerId, def.discount_pct, existing.id],
      },
      {
        sql: `UPDATE mobile_stockists SET user_id=?, name=?, phone=?, address=?, partner_id=?, status='active', is_deleted=0 WHERE id=?`,
        params: [userId, def.name, def.phone, def.location, partnerId, existing.id],
      },
      {
        sql: `UPDATE mobile_stockists SET name=?, phone=?, address=?, partner_id=?, status='active', is_deleted=0 WHERE id=?`,
        params: [def.name, def.phone, def.location, partnerId, existing.id],
      },
    ]);
    return { id: existing.id, action: wasDeleted ? 'restored' : 'updated' };
  }

  const [result] = await execCascade(conn, [
    {
      sql: `INSERT INTO mobile_stockists (user_id, name, email, phone, address, partner_id, status, discount_pct, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0)`,
      params: [userId, def.name, def.email, def.phone, def.location, partnerId, def.discount_pct],
    },
    {
      sql: `INSERT INTO mobile_stockists (user_id, name, email, phone, address, partner_id, status, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, 'active', 0)`,
      params: [userId, def.name, def.email, def.phone, def.location, partnerId],
    },
    {
      sql: `INSERT INTO mobile_stockists (name, email, phone, address, partner_id, status, is_deleted)
            VALUES (?, ?, ?, ?, ?, 'active', 0)`,
      params: [def.name, def.email, def.phone, def.location, partnerId],
    },
  ]);
  return { id: result.insertId, action: 'created' };
}

// ---------------------------------------------------------------------------
// Dry-run preview (read-only)
// ---------------------------------------------------------------------------

async function describeUpcomingAction(conn, table, whereCol, whereVal) {
  const [rows] = await conn.execute(`SELECT id, is_deleted FROM ${table} WHERE ${whereCol} = ? LIMIT 1`, [whereVal]);
  if (rows.length === 0) return 'CREATE';
  return rows[0].is_deleted === 1 ? 'RESTORE (currently soft-deleted)' : 'UPDATE (already active)';
}

async function mobileStockistsTableExists(conn) {
  try {
    await conn.execute('SELECT id FROM mobile_stockists LIMIT 1');
    return true;
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

async function runDryRun(conn) {
  console.log('=== DRY RUN (no changes made — pass --apply to execute) ===');

  if (!SEED_SUPERADMIN_PASSWORD) {
    console.log(
      '\nNOTE: SEED_SUPERADMIN_PASSWORD is not set. --apply will refuse to run until it is set (this is expected in dry-run mode).'
    );
  }

  let roleMap = null;
  try {
    roleMap = await getRoleIdMap(conn);
  } catch (err) {
    console.log(`\nWARNING: ${err.message}`);
    console.log('--apply would abort before making any changes.');
  }

  const hasMobileTable = await mobileStockistsTableExists(conn);

  const creationPlan = [
    { entity: 'Super admin (user)', identifier: SEED_SUPERADMIN_EMAIL, action: await describeUpcomingAction(conn, 'users', 'email', SEED_SUPERADMIN_EMAIL) },
    { entity: 'TEST provincial partner', identifier: TEST_PROVINCIAL_PARTNER.email, action: await describeUpcomingAction(conn, 'partners', 'email', TEST_PROVINCIAL_PARTNER.email) },
    { entity: 'TEST provincial warehouse', identifier: TEST_PROVINCIAL_WAREHOUSE.name, action: await describeUpcomingAction(conn, 'warehouses', 'name', TEST_PROVINCIAL_WAREHOUSE.name) },
    { entity: 'TEST provincial user', identifier: TEST_PROVINCIAL_USER.email, action: await describeUpcomingAction(conn, 'users', 'email', TEST_PROVINCIAL_USER.email) },
    { entity: 'TEST city partner', identifier: TEST_CITY_PARTNER.email, action: await describeUpcomingAction(conn, 'partners', 'email', TEST_CITY_PARTNER.email) },
    { entity: 'TEST city warehouse', identifier: TEST_CITY_WAREHOUSE.name, action: await describeUpcomingAction(conn, 'warehouses', 'name', TEST_CITY_WAREHOUSE.name) },
    { entity: 'TEST city user', identifier: TEST_CITY_USER.email, action: await describeUpcomingAction(conn, 'users', 'email', TEST_CITY_USER.email) },
    { entity: 'TEST mobile user', identifier: TEST_MOBILE_USER.email, action: await describeUpcomingAction(conn, 'users', 'email', TEST_MOBILE_USER.email) },
    {
      entity: 'TEST mobile_stockists row',
      identifier: TEST_MOBILE_USER.email,
      action: hasMobileTable ? await describeUpcomingAction(conn, 'mobile_stockists', 'email', TEST_MOBILE_USER.email) : 'SKIP (mobile_stockists table not present)',
    },
    { entity: 'TEST staff user', identifier: TEST_STAFF_USER.email, action: await describeUpcomingAction(conn, 'users', 'email', TEST_STAFF_USER.email) },
  ];
  printTable('ACCOUNTS TO CREATE / RESTORE', creationPlan);

  if (SEED_KEEP_EMAILS.size > 0) {
    console.log(`\nPreserving ${SEED_KEEP_EMAILS.size} account(s) via SEED_KEEP_EMAILS: ${[...SEED_KEEP_EMAILS].join(', ')}`);
  }

  const preservedUserEmails = [SEED_SUPERADMIN_EMAIL, ...TEST_USER_EMAILS];
  const keepUsersClause = notInKeepEmailsClause('u.email');
  const [usersToArchive] = await conn.execute(
    `SELECT u.id, u.name, u.email, r.slug AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.is_deleted = 0 AND u.email NOT IN (${preservedUserEmails.map(() => '?').join(',')})${keepUsersClause.sql}
     ORDER BY u.id`,
    [...preservedUserEmails, ...keepUsersClause.params]
  );
  printTable('USERS TO ARCHIVE (is_deleted=1)', usersToArchive);

  const keepPartnersClause = notInKeepEmailsClause('email');
  const [partnersToArchive] = await conn.execute(
    `SELECT id, business_name, email, stockist_level
     FROM partners
     WHERE is_deleted = 0 AND email NOT IN (${TEST_PARTNER_EMAILS.map(() => '?').join(',')})${keepPartnersClause.sql}
     ORDER BY id`,
    [...TEST_PARTNER_EMAILS, ...keepPartnersClause.params]
  );
  printTable('PARTNERS TO ARCHIVE (is_deleted=1)', partnersToArchive);

  const keepWarehousePartnerClause = notInKeptPartnerIdsClause('partner_id');
  const [warehousesToArchive] = await conn.execute(
    `SELECT id, name, partner_id, type
     FROM warehouses
     WHERE is_deleted = 0 AND partner_id IS NOT NULL AND name NOT IN (${TEST_WAREHOUSE_NAMES.map(() => '?').join(',')})${keepWarehousePartnerClause.sql}
     ORDER BY id`,
    [...TEST_WAREHOUSE_NAMES, ...keepWarehousePartnerClause.params]
  );
  printTable('WAREHOUSES TO ARCHIVE (is_deleted=1; partner_id IS NULL warehouses are always preserved)', warehousesToArchive);

  if (hasMobileTable) {
    const keepMobileEmailClause = notInKeepEmailsClause('email');
    const keepMobilePartnerClause = notInKeptPartnerIdsClause('partner_id');
    const [mobileToArchive] = await conn.execute(
      `SELECT id, name, email, partner_id
       FROM mobile_stockists
       WHERE is_deleted = 0 AND email NOT IN (?)${keepMobileEmailClause.sql}${keepMobilePartnerClause.sql}
       ORDER BY id`,
      [TEST_MOBILE_USER.email, ...keepMobileEmailClause.params, ...keepMobilePartnerClause.params]
    );
    printTable('MOBILE STOCKIST ROWS TO ARCHIVE (is_deleted=1)', mobileToArchive);
  }

  const [[productCount]] = await conn.execute('SELECT COUNT(*) AS c FROM products WHERE is_deleted = 0');
  console.log(`\nProducts: ${productCount.c} active product(s) — never touched by this script.`);

  if (WIPE_TRANSACTIONS) {
    console.log('\n--wipe-transactions is set. On --apply this will ALSO soft-delete/clear seeded orders, carts, stock transfers, and goods receipts (see README).');
  } else {
    console.log('\n--wipe-transactions NOT set (default). Orders/carts/transfers/GRNs are left untouched.');
  }

  console.log('\nRe-run with --apply to execute.');
}

// ---------------------------------------------------------------------------
// Apply (transactional)
// ---------------------------------------------------------------------------

async function wipeTransactions(conn, preservedUserEmails) {
  const archived = {};

  // orders / stock_transfers / goods_receipts: soft-delete only, status left
  // as-is (status is a lifecycle field, is_deleted is the deletion marker —
  // never mutate a historically-accurate status like 'delivered').
  for (const table of ['orders', 'stock_transfers', 'goods_receipts']) {
    try {
      const [result] = await conn.execute(`UPDATE ${table} SET is_deleted = 1 WHERE is_deleted = 0`);
      archived[table] = result.affectedRows;
    } catch (err) {
      if (isMissingTableError(err) || isMissingColumnError(err)) {
        archived[table] = 'skipped (table/column not present)';
      } else {
        throw err;
      }
    }
  }

  // delivery_tracking has no is_deleted column in the current schema — there
  // is no safe soft-delete marker for it, so it is deliberately left as-is
  // rather than mutating status (fail closed: don't guess).
  archived.delivery_tracking = 'skipped (no is_deleted column)';

  // cart_items is ephemeral UI state with no is_deleted column; the app
  // itself hard-deletes cart rows on removal/checkout (see
  // src/controllers/cartController.js), so a hard delete here matches
  // existing convention rather than violating the soft-delete rule, which
  // is scoped to historical/business records.
  try {
    const [preserved] = await conn.execute(
      `SELECT id FROM users WHERE email IN (${preservedUserEmails.map(() => '?').join(',')})`,
      preservedUserEmails
    );
    const preservedIds = preserved.map((r) => r.id);
    const [result] =
      preservedIds.length > 0
        ? await conn.execute(`DELETE FROM cart_items WHERE user_id NOT IN (${preservedIds.map(() => '?').join(',')})`, preservedIds)
        : await conn.execute('DELETE FROM cart_items');
    archived.cart_items = result.affectedRows;
  } catch (err) {
    if (isMissingTableError(err) || isMissingColumnError(err)) {
      archived.cart_items = 'skipped (table/column not present)';
    } else {
      throw err;
    }
  }

  return archived;
}

async function runApply(conn) {
  if (!SEED_SUPERADMIN_PASSWORD) {
    throw new Error(
      'SEED_SUPERADMIN_PASSWORD is required for --apply. Set a strong password, e.g.:\n' +
        '  SEED_SUPERADMIN_PASSWORD="<strong password>" node --env-file=.env.prod scripts/productionReset.js --apply'
    );
  }
  if (SEED_SUPERADMIN_PASSWORD.length < 10) {
    throw new Error('SEED_SUPERADMIN_PASSWORD is too short. Use a strong password (10+ characters, mixed case/numbers/symbols).');
  }

  await conn.beginTransaction();
  try {
    const roleMap = await getRoleIdMap(conn); // fail closed if a required role is missing

    // --- a. Super admin FIRST, so we never end up with zero admins. -------
    const superAdminHash = await bcrypt.hash(SEED_SUPERADMIN_PASSWORD, BCRYPT_ROUNDS);
    const superAdmin = await upsertUser(conn, {
      email: SEED_SUPERADMIN_EMAIL,
      name: 'Nogatu Super Admin',
      passwordHash: superAdminHash,
      phone: null,
      roleId: roleMap.super_admin,
      partnerId: null,
      warehouseId: null,
      level: 'main',
      location: 'Head Office',
    });

    // --- b. TEST org tree ---------------------------------------------------
    const testPasswordHash = await bcrypt.hash(SEED_TEST_PASSWORD, BCRYPT_ROUNDS);

    const provincialPartner = await upsertPartner(conn, { ...TEST_PROVINCIAL_PARTNER, parent_partner_id: null });
    const provincialWarehouse = await upsertWarehouse(conn, TEST_PROVINCIAL_WAREHOUSE, provincialPartner.id);
    const provincialUser = await upsertUser(conn, {
      email: TEST_PROVINCIAL_USER.email,
      name: TEST_PROVINCIAL_USER.name,
      passwordHash: testPasswordHash,
      phone: TEST_PROVINCIAL_USER.phone,
      roleId: roleMap.provincial_stockist,
      partnerId: provincialPartner.id,
      warehouseId: null,
      level: TEST_PROVINCIAL_USER.level,
      location: TEST_PROVINCIAL_USER.location,
    });

    const cityPartner = await upsertPartner(conn, { ...TEST_CITY_PARTNER, parent_partner_id: provincialPartner.id });
    const cityWarehouse = await upsertWarehouse(conn, TEST_CITY_WAREHOUSE, cityPartner.id);
    const cityUser = await upsertUser(conn, {
      email: TEST_CITY_USER.email,
      name: TEST_CITY_USER.name,
      passwordHash: testPasswordHash,
      phone: TEST_CITY_USER.phone,
      roleId: roleMap.city_stockist,
      partnerId: cityPartner.id,
      warehouseId: null,
      level: TEST_CITY_USER.level,
      location: TEST_CITY_USER.location,
    });

    const mobileUser = await upsertUser(conn, {
      email: TEST_MOBILE_USER.email,
      name: TEST_MOBILE_USER.name,
      passwordHash: testPasswordHash,
      phone: TEST_MOBILE_USER.phone,
      roleId: roleMap.mobile_stockist,
      partnerId: cityPartner.id,
      warehouseId: null,
      level: TEST_MOBILE_USER.level,
      location: TEST_MOBILE_USER.location,
    });

    let mobileRow = null;
    if (await mobileStockistsTableExists(conn)) {
      mobileRow = await upsertMobileStockistRow(conn, TEST_MOBILE_USER, mobileUser.id, cityPartner.id);
    }

    const staffUser = await upsertUser(conn, {
      email: TEST_STAFF_USER.email,
      name: TEST_STAFF_USER.name,
      passwordHash: testPasswordHash,
      phone: TEST_STAFF_USER.phone,
      roleId: roleMap.staff,
      partnerId: cityPartner.id,
      warehouseId: cityWarehouse.id,
      level: TEST_STAFF_USER.level,
      location: TEST_STAFF_USER.location,
    });

    // --- c. Archive everything else -----------------------------------------
    const preservedUserEmails = [SEED_SUPERADMIN_EMAIL, ...TEST_USER_EMAILS];
    const keepUsersClause = notInKeepEmailsClause('email');
    const [usersArchived] = await conn.execute(
      `UPDATE users SET is_deleted = 1, status = 'inactive'
       WHERE is_deleted = 0 AND email NOT IN (${preservedUserEmails.map(() => '?').join(',')})${keepUsersClause.sql}`,
      [...preservedUserEmails, ...keepUsersClause.params]
    );

    const keepPartnersClause = notInKeepEmailsClause('email');
    const [partnersArchived] = await conn.execute(
      `UPDATE partners SET is_deleted = 1, status = 'inactive'
       WHERE is_deleted = 0 AND email NOT IN (${TEST_PARTNER_EMAILS.map(() => '?').join(',')})${keepPartnersClause.sql}`,
      [...TEST_PARTNER_EMAILS, ...keepPartnersClause.params]
    );

    const keepWarehousePartnerClause = notInKeptPartnerIdsClause('partner_id');
    const [warehousesArchived] = await conn.execute(
      `UPDATE warehouses SET is_deleted = 1, is_active = 0
       WHERE is_deleted = 0 AND partner_id IS NOT NULL AND name NOT IN (${TEST_WAREHOUSE_NAMES.map(() => '?').join(',')})${keepWarehousePartnerClause.sql}`,
      [...TEST_WAREHOUSE_NAMES, ...keepWarehousePartnerClause.params]
    );

    let mobileArchivedCount = 0;
    if (await mobileStockistsTableExists(conn)) {
      const keepMobileEmailClause = notInKeepEmailsClause('email');
      const keepMobilePartnerClause = notInKeptPartnerIdsClause('partner_id');
      const [mobileArchived] = await conn.execute(
        `UPDATE mobile_stockists SET is_deleted = 1, status = 'inactive'
         WHERE is_deleted = 0 AND email NOT IN (?)${keepMobileEmailClause.sql}${keepMobilePartnerClause.sql}`,
        [TEST_MOBILE_USER.email, ...keepMobileEmailClause.params, ...keepMobilePartnerClause.params]
      );
      mobileArchivedCount = mobileArchived.affectedRows;
    }

    let transactionsWiped = null;
    if (WIPE_TRANSACTIONS) {
      transactionsWiped = await wipeTransactions(conn, preservedUserEmails);
    }

    await conn.commit();

    // --- Final summary (super admin password NEVER printed) ----------------
    console.log('\n=== APPLIED ===');
    console.log(`Super admin: ${SEED_SUPERADMIN_EMAIL} (${superAdmin.action})`);
    console.log('\nTest org tree (shared test password: set via SEED_TEST_PASSWORD, default shown in README):');
    console.table([
      { role: 'provincial_stockist', email: TEST_PROVINCIAL_USER.email, action: provincialUser.action },
      { role: 'city_stockist', email: TEST_CITY_USER.email, action: cityUser.action },
      { role: 'mobile_stockist', email: TEST_MOBILE_USER.email, action: mobileUser.action },
      { role: 'staff', email: TEST_STAFF_USER.email, action: staffUser.action },
    ]);
    console.log(`Shared test password: ${SEED_TEST_PASSWORD}`);
    console.log('\nArchived counts:');
    console.table({
      users: usersArchived.affectedRows,
      partners: partnersArchived.affectedRows,
      warehouses: warehousesArchived.affectedRows,
      mobile_stockists: mobileArchivedCount,
    });
    if (mobileRow) {
      console.log(`mobile_stockists row: id=${mobileRow.id} (${mobileRow.action})`);
    } else {
      console.log('mobile_stockists table not present — skipped (users row for the mobile stockist was still created).');
    }
    if (transactionsWiped) {
      console.log('\n--wipe-transactions results:');
      console.table(transactionsWiped);
    }
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

async function main() {
  const conn = await pool.getConnection();
  try {
    if (!APPLY) {
      await runDryRun(conn);
    } else {
      await runApply(conn);
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nERR', err.message);
  process.exit(1);
});
