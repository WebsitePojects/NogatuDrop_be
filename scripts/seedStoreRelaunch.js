// scripts/seedStoreRelaunch.js
//
// Seeds the nogatu.store relaunch: the Dino super admin, the two company fulfillment CENTERS
// (partner row with stockist_level 'center' + one warehouse of type 'center'), their staff,
// Berry NAD+ opening stock, payment accounts per center, and the influencer link.
//
// All personal data (emails, phones, bank accounts) comes from a GITIGNORED config file:
//   scripts/store-relaunch.config.json   (shape: scripts/store-relaunch.config.example.json)
//
// SAFETY (same contract as scripts/productionReset.js)
//   - DRY RUN BY DEFAULT: reads the DB, prints exactly what --apply WOULD do, writes nothing.
//   - --apply runs ONE transaction (super admin first); any error rolls everything back.
//   - Idempotent: every row is upserted by a stable natural key (email / business_name+level /
//     warehouse+bank+account / slug); opening stock is guarded by a goods_receipts.client_ref, so
//     re-running --apply creates no new rows and never adds stock twice.
//   - Passwords are set ONLY when a user is created, from the env var named by `passwordEnv`.
//     Existing users keep their password. Passwords, full account numbers and full emails are never printed.
//   - Never creates a product. Never DELETEs. Fails closed on any config or schema problem,
//     listing every problem at once.
//
// USAGE
//   node --env-file=.env.dev scripts/seedStoreRelaunch.js                       # dry run
//   DINO_PASSWORD='...' RYAN_PASSWORD='...' node --env-file=.env.prod \
//     scripts/seedStoreRelaunch.js --apply [--config path/to/config.json]

const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { MAX_RECEIVE_QUANTITY, isFutureIsoDate, receiveStock } = require('../src/services/stockReceiving');
const { normalizeUsername, isValidUsername } = require('../src/utils/username');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 10;
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'store-relaunch.config.json');
const CLIENT_REF_MAX_LENGTH = 64;
const STAFF_LEVEL = 'city'; // users.level is enum('main','regional','city'); centers are city-scope operations.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CENTER_KEY_PATTERN = /^[A-Z0-9_]{1,20}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

// ---------------------------------------------------------------------------
// Config validation (pure — no DB, no process.env)
// ---------------------------------------------------------------------------

const isNonEmptyString = (value, max = 255) => (
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
);
const isEmail = (value) => typeof value === 'string' && value.length <= 150 && EMAIL_PATTERN.test(value.trim());
const isCoordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/**
 * Validates the whole config and returns EVERY problem found, so the operator fixes them in one pass.
 * Problems name the field path only, never the offending value (config holds personal data).
 *
 * @param {object} config parsed store-relaunch config
 * @param {Date} [now] injectable clock (expiry must be in the future)
 * @returns {string[]} problems, empty when the config is valid
 */
function validateConfig(config, now = new Date()) {
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['config must be a JSON object'];
  }

  const seenEmails = new Set();
  const checkUniqueEmail = (pathName, value) => {
    const normalized = String(value).trim().toLowerCase();
    expect(!seenEmails.has(normalized), `${pathName} duplicates another email in the config`);
    seenEmails.add(normalized);
  };

  const seenUsernames = new Set();
  const checkUsername = (pathName, value) => {
    if (value == null) return;
    const normalized = normalizeUsername(value);
    expect(isValidUsername(normalized), `${pathName} must be 3-50 characters: letters, digits, dot, underscore or hyphen`);
    expect(!seenUsernames.has(normalized), `${pathName} duplicates another username in the config`);
    seenUsernames.add(normalized);
  };

  const { superAdmin, product, opening, centers, influencer } = config;

  expect(superAdmin && typeof superAdmin === 'object', 'superAdmin is required');
  if (superAdmin && typeof superAdmin === 'object') {
    expect(isNonEmptyString(superAdmin.name, 150), 'superAdmin.name is required (max 150 chars)');
    expect(isEmail(superAdmin.email), 'superAdmin.email must be a valid email');
    expect(ENV_NAME_PATTERN.test(superAdmin.passwordEnv || ''), 'superAdmin.passwordEnv must be an env var name like SUPERADMIN_PASSWORD');
    if (isEmail(superAdmin.email)) checkUniqueEmail('superAdmin.email', superAdmin.email);
    checkUsername('superAdmin.username', superAdmin.username);
  }

  expect(product && typeof product === 'object', 'product is required');
  if (product && typeof product === 'object') {
    expect(isNonEmptyString(product.sku, 100) || isNonEmptyString(product.nameMatch, 200), 'product needs a sku or a nameMatch');
  }

  expect(opening && typeof opening === 'object', 'opening is required');
  if (opening && typeof opening === 'object') {
    expect(
      Number.isInteger(opening.quantity) && opening.quantity >= 1 && opening.quantity <= MAX_RECEIVE_QUANTITY,
      `opening.quantity must be a whole number between 1 and ${MAX_RECEIVE_QUANTITY}`
    );
    expect(isNonEmptyString(opening.batch, 50), 'opening.batch is required (max 50 chars)');
    expect(isFutureIsoDate(opening.expiry, now), 'opening.expiry must be a future date in YYYY-MM-DD format');
    expect(opening.supplier == null || isNonEmptyString(opening.supplier, 150), 'opening.supplier must be a non-empty string (max 150 chars) when given');
    expect(opening.unit == null || isNonEmptyString(opening.unit, 50), 'opening.unit must be a non-empty string when given');
  }

  expect(Array.isArray(centers) && centers.length > 0, 'centers must be a non-empty array');
  const seenKeys = new Set();
  const seenNames = new Set();
  (Array.isArray(centers) ? centers : []).forEach((center, i) => {
    const at = `centers[${i}]`;
    if (!center || typeof center !== 'object') {
      problems.push(`${at} must be an object`);
      return;
    }
    expect(CENTER_KEY_PATTERN.test(center.key || ''), `${at}.key must be 1-20 chars of A-Z, 0-9, _`);
    expect(!seenKeys.has(center.key), `${at}.key duplicates another center`);
    seenKeys.add(center.key);

    expect(isNonEmptyString(center.businessName, 150), `${at}.businessName is required (max 150 chars)`);
    const nameKey = String(center.businessName || '').trim().toLowerCase();
    expect(!seenNames.has(nameKey), `${at}.businessName duplicates another center`);
    seenNames.add(nameKey);

    expect(isNonEmptyString(center.address, 200), `${at}.address is required (max 200 chars)`);
    expect(isNonEmptyString(center.region, 100), `${at}.region is required (max 100 chars)`);
    expect(isNonEmptyString(center.contactPerson, 150), `${at}.contactPerson is required (max 150 chars)`);
    expect(isNonEmptyString(center.contactPhone, 30), `${at}.contactPhone is required (max 30 chars)`);
    expect(center.operatingHours == null || isNonEmptyString(center.operatingHours, 150), `${at}.operatingHours must be a non-empty string when given`);
    expect(center.email == null || isEmail(center.email), `${at}.email must be a valid email when given`);

    const hasLat = center.lat != null;
    const hasLng = center.lng != null;
    expect(hasLat === hasLng, `${at}.lat and ${at}.lng must be given together`);
    if (hasLat) {
      expect(isCoordinate(center.lat, 90), `${at}.lat must be a number between -90 and 90`);
      expect(isCoordinate(center.lng, 180), `${at}.lng must be a number between -180 and 180`);
    }

    // The opening-stock client_ref is `seed-opening-<key>-<batch>` and must fit goods_receipts.client_ref.
    if (isNonEmptyString(opening && opening.batch, 50) && CENTER_KEY_PATTERN.test(center.key || '')) {
      expect(openingClientRef(center.key, opening.batch).length <= CLIENT_REF_MAX_LENGTH, `${at}.key + opening.batch make a client reference longer than ${CLIENT_REF_MAX_LENGTH} chars`);
    }

    expect(Array.isArray(center.staff), `${at}.staff must be an array (may be empty)`);
    (Array.isArray(center.staff) ? center.staff : []).forEach((staff, j) => {
      const staffAt = `${at}.staff[${j}]`;
      if (!staff || typeof staff !== 'object') {
        problems.push(`${staffAt} must be an object`);
        return;
      }
      expect(isNonEmptyString(staff.name, 150), `${staffAt}.name is required (max 150 chars)`);
      expect(isEmail(staff.email), `${staffAt}.email must be a valid email`);
      checkUsername(`${staffAt}.username`, staff.username);
      expect(ENV_NAME_PATTERN.test(staff.passwordEnv || ''), `${staffAt}.passwordEnv must be an env var name like STAFF_PASSWORD`);
      if (isEmail(staff.email)) checkUniqueEmail(`${staffAt}.email`, staff.email);
    });

    expect(Array.isArray(center.paymentAccounts), `${at}.paymentAccounts must be an array (may be empty)`);
    const seenAccounts = new Set();
    (Array.isArray(center.paymentAccounts) ? center.paymentAccounts : []).forEach((account, j) => {
      const accountAt = `${at}.paymentAccounts[${j}]`;
      if (!account || typeof account !== 'object') {
        problems.push(`${accountAt} must be an object`);
        return;
      }
      expect(isNonEmptyString(account.bankName, 100), `${accountAt}.bankName is required (max 100 chars)`);
      expect(isNonEmptyString(account.accountName, 150), `${accountAt}.accountName is required (max 150 chars)`);
      expect(isNonEmptyString(account.accountNumber, 50), `${accountAt}.accountNumber is required (max 50 chars)`);
      const accountKey = `${String(account.bankName).trim().toLowerCase()}|${String(account.accountNumber).trim()}`;
      expect(!seenAccounts.has(accountKey), `${accountAt} duplicates another payment account of the same center`);
      seenAccounts.add(accountKey);
    });
  });

  expect(influencer && typeof influencer === 'object', 'influencer is required');
  if (influencer && typeof influencer === 'object') {
    expect(SLUG_PATTERN.test(influencer.slug || ''), 'influencer.slug must be lowercase letters, digits and hyphens (max 80 chars)');
    expect(isNonEmptyString(influencer.displayName, 100), 'influencer.displayName is required (max 100 chars)');
  }

  return problems;
}

const openingClientRef = (centerKey, batch) => `seed-opening-${centerKey}-${String(batch).trim()}`;

// ---------------------------------------------------------------------------
// Output masking — logs must never carry full emails or account numbers
// ---------------------------------------------------------------------------

function maskEmail(email) {
  const [local = '', domain = ''] = String(email).trim().split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskAccountNumber(accountNumber) {
  const text = String(accountNumber).trim();
  return `****${text.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Schema preflight (pure evaluation over an information_schema snapshot)
// ---------------------------------------------------------------------------

const PREFLIGHT_TABLES = ['partners', 'warehouses', 'users', 'goods_receipts', 'influencer_links'];

async function readSchemaSnapshot(conn) {
  const [rows] = await conn.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${PREFLIGHT_TABLES.map(() => '?').join(',')})`,
    PREFLIGHT_TABLES
  );
  return rows;
}

/**
 * Checks the schema the seed depends on. Returns every missing prerequisite plus which optional
 * columns exist (written only when present, so the seed works before and after those migrations).
 *
 * @param {{tableName:string, columnName:string, columnType:string}[]} snapshot
 */
function evaluatePreflight(snapshot) {
  const find = (table, column) => snapshot.find((row) => row.tableName === table && row.columnName === column);
  const allowsCenter = (table, column) => String(find(table, column)?.columnType || '').includes("'center'");
  const problems = [];

  if (!allowsCenter('partners', 'stockist_level') || !allowsCenter('warehouses', 'type')) {
    problems.push("MySQL enums partners.stockist_level and warehouses.type must contain 'center' — run: node --env-file=<env> scripts/addStoreCenters.js");
  }
  if (!snapshot.some((row) => row.tableName === 'influencer_links')) {
    problems.push('influencer_links table is missing — apply sql/influencer_checkout_2026_09_10.sql (node scripts/runSqlFile.js sql/influencer_checkout_2026_09_10.sql)');
  }
  if (!find('goods_receipts', 'client_ref')) {
    problems.push('goods_receipts.client_ref is missing — run: node --env-file=<env> scripts/addGrnClientRef.js');
  }
  if (!find('users', 'warehouse_id')) {
    problems.push('users.warehouse_id is missing — run: node --env-file=<env> scripts/addUserWarehouse.js');
  }
  if (!find('users', 'username')) {
    problems.push('users.username is missing — run: node --env-file=<env> scripts/addUsername.js');
  }

  return {
    problems,
    hasWarehouseOperatingHours: Boolean(find('warehouses', 'operating_hours')),
    hasInfluencerDisplayName: Boolean(find('influencer_links', 'display_name')),
  };
}

// ---------------------------------------------------------------------------
// The sync itself. ONE code path for dry run and apply: every step does its read, decides
// create/update/restore, and only the write is skipped when ctx.apply is false. That keeps the
// printed plan honest — it is the same logic that --apply executes.
// ---------------------------------------------------------------------------

async function write(ctx, sql, params) {
  if (!ctx.apply) return null;
  const [result] = await ctx.conn.execute(sql, params);
  return result;
}

/**
 * @param lookup  [sql, params] selecting `id, is_deleted` by natural key, or null when a parent
 *                row does not exist yet (dry run) so the row cannot exist either
 * @param insert  async () => [sql, params]   (lazy: only built when the row is missing)
 * @param update  [sql, params] ending in `WHERE id = ?`; the found id is appended
 */
async function upsert(ctx, { lookup, insert, update }) {
  const [rows] = lookup ? await ctx.conn.execute(lookup[0], lookup[1]) : [[]];
  const found = rows[0];

  if (!found) {
    const [sql, params] = await insert();
    const result = await write(ctx, sql, params);
    return { id: result ? result.insertId : null, action: 'create' };
  }
  await write(ctx, update[0], [...update[1], found.id]);
  return { id: found.id, action: found.is_deleted ? 'restore' : 'update' };
}

async function resolveRoleIds(conn) {
  const [rows] = await conn.execute("SELECT id, slug FROM roles WHERE slug IN ('super_admin', 'staff')");
  const ids = Object.fromEntries(rows.map((row) => [row.slug, row.id]));
  const missing = ['super_admin', 'staff'].filter((slug) => !ids[slug]);
  if (missing.length > 0) throw new Error(`Fail closed: role(s) missing from roles table: ${missing.join(', ')}`);
  return ids;
}

class ProductResolutionError extends Error {}

async function resolveProduct(conn, productConfig) {
  const sku = productConfig.sku && productConfig.sku.trim();
  let rows;
  if (sku) {
    [rows] = await conn.execute('SELECT id, name, sku FROM products WHERE sku = ? AND is_deleted = 0', [sku]);
  } else {
    // Escape LIKE wildcards so nameMatch is matched literally.
    const pattern = `%${productConfig.nameMatch.trim().replace(/[\\%_]/g, '\\$&')}%`;
    [rows] = await conn.execute(
      'SELECT id, name, sku FROM products WHERE name LIKE ? AND is_active = 1 AND is_deleted = 0 ORDER BY id',
      [pattern]
    );
  }
  if (rows.length === 1) return rows[0];

  const candidates = rows.length > 0
    ? rows
    : (await conn.execute('SELECT id, name, sku FROM products WHERE is_active = 1 AND is_deleted = 0 ORDER BY id LIMIT 20'))[0];
  const listing = candidates.map((row) => `  #${row.id}  ${row.sku}  ${row.name}`).join('\n') || '  (no active products)';
  throw new ProductResolutionError(
    `${rows.length === 0 ? 'No product matched' : `${rows.length} products matched`} — refusing to guess (this script never creates products). ` +
    `Set product.sku in the config to one of:\n${listing}`
  );
}

/**
 * Fails closed when the configured username already belongs to a different account; otherwise the
 * UNIQUE index would abort the whole seed transaction with a raw duplicate-key error.
 */
async function assertUsernameFree(ctx, username, email, at) {
  if (!username) return;
  const [rows] = await ctx.conn.execute(
    'SELECT id FROM users WHERE username = ? AND LOWER(email) <> ? LIMIT 1',
    [username, email]
  );
  if (rows.length) {
    throw new Error(`Fail closed: ${at} username "${username}" is already used by another account (user id ${rows[0].id})`);
  }
}

async function syncSuperAdmin(ctx, roleIds, superAdmin) {
  const email = superAdmin.email.trim().toLowerCase();
  const username = normalizeUsername(superAdmin.username);
  await assertUsernameFree(ctx, username, email, 'superAdmin');
  return upsert(ctx, {
    lookup: ['SELECT id, is_deleted FROM users WHERE email = ? LIMIT 1', [email]],
    insert: async () => [
      `INSERT INTO users (name, email, username, password, role_id, partner_id, warehouse_id, level, location, status, is_deleted)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'main', 'Head Office', 'active', 0)`,
      [superAdmin.name.trim(), email, username, await ctx.hashPasswordFromEnv(superAdmin.passwordEnv), roleIds.super_admin],
    ],
    // Password deliberately untouched: an existing admin keeps the credential they already have.
    // COALESCE keeps a username set earlier when the config does not name one.
    update: [
      `UPDATE users SET name = ?, username = COALESCE(?, username), role_id = ?, partner_id = NULL, warehouse_id = NULL, level = 'main',
              status = 'active', is_deleted = 0
       WHERE id = ?`,
      [superAdmin.name.trim(), username, roleIds.super_admin],
    ],
  });
}

function centerEmail(center) {
  // partners.email is NOT NULL UNIQUE but a center has no stockist mailbox; derive a stable one.
  return (center.email || `center-${center.key.toLowerCase()}@nogatu.store`).trim().toLowerCase();
}

async function syncCenterPartner(ctx, center) {
  const businessName = center.businessName.trim();
  const email = centerEmail(center);

  const emailHolder = (await ctx.conn.execute(
    "SELECT id FROM partners WHERE email = ? AND NOT (business_name = ? AND stockist_level = 'center') LIMIT 1",
    [email, businessName]
  ))[0][0];
  if (emailHolder) {
    throw new Error(`Fail closed: partners.email for center ${center.key} is already held by another partner — set centers[].email to a free address`);
  }

  // A center is NOT a stockist: no discount, no parent. Discount/parent are only set on insert
  // so later admin edits are never clobbered by a re-run.
  return upsert(ctx, {
    lookup: ["SELECT id, is_deleted FROM partners WHERE business_name = ? AND stockist_level = 'center' LIMIT 1", [businessName]],
    insert: async () => [
      `INSERT INTO partners (business_name, email, phone, address, status, region, stockist_level, parent_partner_id, discount_pct, is_deleted)
       VALUES (?, ?, ?, ?, 'active', ?, 'center', NULL, 0, 0)`,
      [businessName, email, center.contactPhone.trim(), center.address.trim(), center.region.trim()],
    ],
    update: [
      "UPDATE partners SET phone = ?, address = ?, region = ?, status = 'active', is_deleted = 0 WHERE id = ?",
      [center.contactPhone.trim(), center.address.trim(), center.region.trim()],
    ],
  });
}

async function syncCenterWarehouse(ctx, center, partnerId) {
  const base = {
    name: center.businessName.trim(),
    location: center.address.trim(),
    manager_name: center.contactPerson.trim(),
    manager_phone: center.contactPhone.trim(),
  };
  const optional = ctx.preflight.hasWarehouseOperatingHours && center.operatingHours
    ? { operating_hours: center.operatingHours.trim() }
    : {};
  const columns = { ...base, ...optional };
  const names = Object.keys(columns);
  const values = Object.values(columns);
  const lat = center.lat ?? null;
  const lng = center.lng ?? null;

  return upsert(ctx, {
    lookup: partnerId
      ? ["SELECT id, is_deleted FROM warehouses WHERE partner_id = ? AND type = 'center' ORDER BY is_deleted, id LIMIT 1", [partnerId]]
      : null,
    insert: async () => [
      `INSERT INTO warehouses (partner_id, type, ${names.join(', ')}, lat, lng, is_active, is_deleted)
       VALUES (?, 'center', ${names.map(() => '?').join(', ')}, ?, ?, 1, 0)`,
      [partnerId, ...values, lat, lng],
    ],
    // COALESCE keeps coordinates already on the row when the config omits them.
    update: [
      `UPDATE warehouses SET ${names.map((name) => `${name} = ?`).join(', ')},
              lat = COALESCE(?, lat), lng = COALESCE(?, lng), is_active = 1, is_deleted = 0
       WHERE id = ?`,
      [...values, lat, lng],
    ],
  });
}

async function syncStaff(ctx, roleIds, center, staff, partnerId, warehouseId) {
  const email = staff.email.trim().toLowerCase();
  const username = normalizeUsername(staff.username);
  const location = center.businessName.trim();
  await assertUsernameFree(ctx, username, email, `center ${center.key} staff`);
  return upsert(ctx, {
    lookup: ['SELECT id, is_deleted FROM users WHERE email = ? LIMIT 1', [email]],
    insert: async () => [
      `INSERT INTO users (name, email, username, password, role_id, partner_id, warehouse_id, level, location, status, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
      [staff.name.trim(), email, username, await ctx.hashPasswordFromEnv(staff.passwordEnv), roleIds.staff, partnerId, warehouseId, STAFF_LEVEL, location],
    ],
    update: [
      `UPDATE users SET name = ?, username = COALESCE(?, username), role_id = ?, partner_id = ?, warehouse_id = ?, level = ?, location = ?,
              status = 'active', is_deleted = 0
       WHERE id = ?`,
      [staff.name.trim(), username, roleIds.staff, partnerId, warehouseId, STAFF_LEVEL, location],
    ],
  });
}

/**
 * Brings (product, warehouse) up to opening.quantity exactly once. Rerun-safe in both directions:
 * an existing receipt with the seed's client_ref means "already recorded" even if stock has since
 * been sold below the opening quantity; stock already >= opening means nothing to add.
 */
async function syncOpeningStock(ctx, center, opening, product, warehouseId, superAdminId) {
  const clientRef = openingClientRef(center.key, opening.batch);
  if (!warehouseId) return { action: `receive ${opening.quantity} (new warehouse)` };

  const [receipts] = await ctx.conn.execute('SELECT id FROM goods_receipts WHERE client_ref = ? LIMIT 1', [clientRef]);
  if (receipts.length > 0) return { action: 'skip (opening receipt already recorded)' };

  const [[stock]] = await ctx.conn.execute(
    'SELECT COALESCE(SUM(current_stock), 0) AS onHand FROM inventories WHERE product_id = ? AND warehouse_id = ? AND is_active = 1',
    [product.id, warehouseId]
  );
  const onHand = Number(stock.onHand);
  if (onHand >= opening.quantity) return { action: `skip (on hand ${onHand} >= ${opening.quantity})` };

  const shortfall = opening.quantity - onHand;
  if (ctx.apply) {
    await receiveStock(ctx.conn, {
      productId: product.id,
      warehouseId,
      quantity: shortfall,
      batchNumber: opening.batch.trim(),
      expiryDate: opening.expiry,
      supplier: opening.supplier ? opening.supplier.trim() : null,
      notes: 'Opening stock (store relaunch seed)',
      createdBy: superAdminId,
      clientRef,
    });
  }
  return { action: `receive ${shortfall}` };
}

async function syncPaymentAccount(ctx, warehouseId, account) {
  const bankName = account.bankName.trim();
  const accountNumber = account.accountNumber.trim();
  const accountName = account.accountName.trim();
  return upsert(ctx, {
    lookup: warehouseId
      ? ['SELECT id, is_deleted FROM bank_accounts WHERE warehouse_id = ? AND bank_name = ? AND account_number = ? LIMIT 1', [warehouseId, bankName, accountNumber]]
      : null,
    insert: async () => [
      `INSERT INTO bank_accounts (warehouse_id, bank_name, account_name, account_number, is_active, is_deleted)
       VALUES (?, ?, ?, ?, 1, 0)`,
      [warehouseId, bankName, accountName, accountNumber],
    ],
    update: ['UPDATE bank_accounts SET account_name = ?, is_active = 1, is_deleted = 0 WHERE id = ?', [accountName]],
  });
}

async function syncInfluencerLink(ctx, influencer, product) {
  const slug = influencer.slug.trim();
  const withDisplayName = ctx.preflight.hasInfluencerDisplayName;
  return upsert(ctx, {
    lookup: ['SELECT id, 0 AS is_deleted FROM influencer_links WHERE slug = ? LIMIT 1', [slug]],
    insert: async () => [
      `INSERT INTO influencer_links (slug, enabled, canonical_product_sku${withDisplayName ? ', display_name' : ''})
       VALUES (?, 1, ?${withDisplayName ? ', ?' : ''})`,
      [slug, product.sku, ...(withDisplayName ? [influencer.displayName.trim()] : [])],
    ],
    update: [
      `UPDATE influencer_links SET enabled = 1, canonical_product_sku = ?${withDisplayName ? ', display_name = ?' : ''} WHERE id = ?`,
      [product.sku, ...(withDisplayName ? [influencer.displayName.trim()] : [])],
    ],
  });
}

/**
 * Runs the whole seed against `ctx.conn`. Super admin first (so there is never a window with no
 * admin), then centers, staff, opening stock, payment accounts, influencer link.
 * @returns {Promise<{rows: object[], notes: string[]}>} report lines for printing
 */
async function syncSeed(ctx, config, product) {
  const roleIds = await resolveRoleIds(ctx.conn);
  const rows = [];
  const record = (entity, label, result) => rows.push({ entity, target: label, action: result.action });

  const admin = await syncSuperAdmin(ctx, roleIds, config.superAdmin);
  record('super admin', maskEmail(config.superAdmin.email), admin);

  for (const center of config.centers) {
    const partner = await syncCenterPartner(ctx, center);
    record('center partner', center.key, partner);

    const warehouse = await syncCenterWarehouse(ctx, center, partner.id);
    record('center warehouse', center.key, warehouse);

    for (const staff of center.staff) {
      record('staff', `${center.key} ${maskEmail(staff.email)}`, await syncStaff(ctx, roleIds, center, staff, partner.id, warehouse.id));
    }

    record('opening stock', center.key, await syncOpeningStock(ctx, center, config.opening, product, warehouse.id, admin.id));

    for (const account of center.paymentAccounts) {
      record('payment account', `${center.key} ${account.bankName.trim()} ${maskAccountNumber(account.accountNumber)}`, await syncPaymentAccount(ctx, warehouse.id, account));
    }
  }

  record('influencer link', config.influencer.slug.trim(), await syncInfluencerLink(ctx, config.influencer, product));

  const notes = [];
  if (!ctx.preflight.hasWarehouseOperatingHours && config.centers.some((center) => center.operatingHours)) {
    notes.push('operatingHours NOT stored: warehouses.operating_hours column does not exist yet.');
  }
  if (!ctx.preflight.hasInfluencerDisplayName) {
    notes.push('influencer.displayName NOT stored: influencer_links.display_name column does not exist.');
  }
  return { rows, notes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const configFlag = argv.indexOf('--config');
  if (configFlag !== -1 && !argv[configFlag + 1]) throw new Error('--config needs a path');
  return {
    apply: argv.includes('--apply'),
    configPath: configFlag === -1 ? DEFAULT_CONFIG_PATH : path.resolve(process.cwd(), argv[configFlag + 1]),
  };
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nCopy scripts/store-relaunch.config.example.json to scripts/store-relaunch.config.json and fill it in.`);
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    // err.message of JSON.parse can quote file content (personal data) — report position only.
    throw new Error(`Config is not valid JSON: ${configPath} (${err.name})`);
  }
}

function failWithProblems(heading, problems) {
  console.error(`\n${heading}`);
  problems.forEach((problem) => console.error(`  - ${problem}`));
  process.exitCode = 1;
}

function printReport(title, { rows, notes }) {
  console.log(`\n${title}`);
  console.table(rows);
  notes.forEach((note) => console.log(`NOTE: ${note}`));
}

// The env vars holding passwords of users that will be CREATED, validated before any write.
function passwordProblems(neededEnvNames, env) {
  return [...neededEnvNames].flatMap((name) => {
    if (!env[name]) return [`env var ${name} is required to create a new user but is not set`];
    if (env[name].length < MIN_PASSWORD_LENGTH) return [`env var ${name} is shorter than ${MIN_PASSWORD_LENGTH} characters`];
    return [];
  });
}

function buildContext(conn, preflight, { apply, env = process.env }) {
  const passwordEnvNamesUsed = new Set();
  return {
    conn,
    apply,
    preflight,
    passwordEnvNamesUsed,
    // Dry run only records which env vars a creation would need; apply hashes the real value.
    async hashPasswordFromEnv(envName) {
      passwordEnvNamesUsed.add(envName);
      if (!apply) return null;
      const password = env[envName];
      if (!password || password.length < MIN_PASSWORD_LENGTH) throw new Error(`env var ${envName} missing or too short`);
      return bcrypt.hash(password, BCRYPT_ROUNDS);
    },
  };
}

async function main() {
  const { apply, configPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath);

  const configProblems = validateConfig(config);
  if (configProblems.length > 0) {
    failWithProblems(`Config invalid (${configProblems.length} problem(s)) — nothing was changed:`, configProblems);
    return;
  }

  const pool = require('../src/config/db'); // lazy: validation above must work without a database
  let conn;
  try {
    conn = await pool.getConnection();

    const preflight = evaluatePreflight(await readSchemaSnapshot(conn));
    if (preflight.problems.length > 0) {
      failWithProblems('Schema preflight failed — nothing was changed:', preflight.problems);
      return;
    }

    let product;
    try {
      product = await resolveProduct(conn, config.product);
    } catch (err) {
      if (!(err instanceof ProductResolutionError)) throw err;
      failWithProblems('Product resolution failed — nothing was changed:', [err.message]);
      return;
    }
    console.log(`Product: #${product.id} ${product.sku} — ${product.name}${config.opening.unit ? ` (opening unit: ${config.opening.unit})` : ''}`);

    // Pass 1: read-only plan. In --apply mode it also tells us which passwords will be needed.
    const previewCtx = buildContext(conn, preflight, { apply: false });
    const plan = await syncSeed(previewCtx, config, product);
    printReport(apply ? 'PLAN (about to apply)' : '=== DRY RUN — nothing written, pass --apply to execute ===', plan);

    if (!apply) {
      const missing = passwordProblems(previewCtx.passwordEnvNamesUsed, process.env);
      if (missing.length > 0) console.log('\nBefore --apply:\n' + missing.map((problem) => `  - ${problem}`).join('\n'));
      console.log('\nRe-run with --apply to execute.');
      return;
    }

    const missingPasswords = passwordProblems(previewCtx.passwordEnvNamesUsed, process.env);
    if (missingPasswords.length > 0) {
      failWithProblems('Cannot apply — nothing was changed:', missingPasswords);
      return;
    }

    // Pass 2: the same logic, writing, inside one transaction.
    await conn.beginTransaction();
    try {
      const applied = await syncSeed(buildContext(conn, preflight, { apply: true }), config, product);
      await conn.commit();
      printReport('=== APPLIED ===', applied);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // Some connection failures (ECONNREFUSED on both IPv4+IPv6) arrive with an empty message.
    console.error('\nERR', err.message || err.code || String(err));
    process.exit(1);
  });
}

module.exports = {
  validateConfig,
  evaluatePreflight,
  passwordProblems,
  maskEmail,
  maskAccountNumber,
  openingClientRef,
  syncSeed,
  buildContext,
};
