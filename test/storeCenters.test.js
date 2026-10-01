const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ApiError = require('../src/utils/ApiError');
const { __testables } = require('../src/controllers/orderController');
const { resolveUserAssignment } = require('../src/rbac/userAssignments');
const {
  buildOrderScopeFromContext,
  canApproveOrderFromContext,
  canVerifyPaymentFromContext,
} = require('../src/rbac/affiliationScopes');
const { STOCKIST_LEVELS, isStockistLevel } = require('../src/rbac/roles');
const { buildEnumWithCenterDdl, columnDefaultClause } = require('../scripts/addStoreCenters');

const { resolvePublicFulfillmentRoute, rankPublicFulfillmentCandidates } = __testables;

const authSource = readFileSync(join(__dirname, '../src/controllers/authController.js'), 'utf8');

// Minimal stand-in for the mysql2 pool: answers the two queries the allocator issues.
//   centers: rows the candidate query returns (the real SQL filters to active 'center' partners)
//   stock:   { warehouseId: { productId: [currentStock, reservedStock] } }
function fakeDb({ centers, stock }) {
  const executed = [];
  return {
    executed,
    async execute(sql, params = []) {
      executed.push(sql);
      if (sql.includes('FROM partners p')) return [centers];
      if (sql.includes('FROM inventories')) {
        const [warehouseId, ...productIds] = params;
        const rows = productIds
          .filter((productId) => stock[warehouseId]?.[productId])
          .map((productId) => ({
            product_id: productId,
            current_stock: stock[warehouseId][productId][0],
            reserved_stock: stock[warehouseId][productId][1],
          }));
        return [rows];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const CALOOCAN = { partner_id: 1, warehouse_id: 10, lat: 14.6507, lng: 120.9676 };
const TYCOON = { partner_id: 2, warehouse_id: 20, lat: 14.5547, lng: 121.0244 };
const ONE_BOX = [{ product_id: 7, name: 'Berry NAD+', quantity: 1 }];

test('public routing picks the center that has the stock and skips one that is short', async () => {
  const db = fakeDb({
    centers: [CALOOCAN, TYCOON],
    stock: { 10: { 7: [5, 5] }, 20: { 7: [100, 0] } }, // Caloocan fully reserved
  });
  const route = await resolvePublicFulfillmentRoute(db, ONE_BOX, {});
  assert.equal(route.warehouse_id, 20);
  assert.equal(route.partner_id, 2);
});

test('public routing requires EVERY line to be covered by the same center', async () => {
  const items = [
    { product_id: 7, name: 'Berry NAD+', quantity: 2 },
    { product_id: 8, name: 'Glow', quantity: 2 },
  ];
  const db = fakeDb({
    centers: [CALOOCAN, TYCOON],
    stock: { 10: { 7: [50, 0], 8: [1, 0] }, 20: { 7: [50, 0], 8: [9, 0] } },
  });
  assert.equal((await resolvePublicFulfillmentRoute(db, items, {})).warehouse_id, 20);
});

test('public routing sums duplicate lines of the same product before checking stock', async () => {
  const items = [
    { product_id: 7, name: 'Berry NAD+', quantity: 3 },
    { product_id: 7, name: 'Berry NAD+', quantity: 3 },
  ];
  const db = fakeDb({ centers: [CALOOCAN], stock: { 10: { 7: [5, 0] } } });
  await assert.rejects(
    resolvePublicFulfillmentRoute(db, items, {}),
    (err) => err instanceof ApiError && err.statusCode === 409
  );
});

test('public routing answers 409 naming the product when no center can fulfill', async () => {
  const db = fakeDb({ centers: [CALOOCAN, TYCOON], stock: { 10: { 7: [0, 0] }, 20: {} } });
  await assert.rejects(
    resolvePublicFulfillmentRoute(db, ONE_BOX, {}),
    (err) => err instanceof ApiError
      && err.statusCode === 409
      && /Not enough stock at our fulfillment centers for Berry NAD\+/.test(err.message)
  );
});

test('public routing with no configured center is a 503, never a silent fallback', async () => {
  const db = fakeDb({ centers: [], stock: {} });
  await assert.rejects(
    resolvePublicFulfillmentRoute(db, ONE_BOX, {}),
    (err) => err instanceof ApiError && err.statusCode === 503
  );
  assert.equal(db.executed.some((sql) => sql.includes('FROM inventories')), false);
});

test('public candidate query admits only active center partners, never a Stockist level', async () => {
  const db = fakeDb({ centers: [CALOOCAN], stock: { 10: { 7: [5, 0] } } });
  await resolvePublicFulfillmentRoute(db, ONE_BOX, {});
  const candidateSql = db.executed.find((sql) => sql.includes('FROM partners p'));
  assert.match(candidateSql, /p\.stockist_level = 'center'/);
  assert.match(candidateSql, /p\.status = 'active'/);
  assert.match(candidateSql, /p\.is_deleted = 0/);
  assert.match(candidateSql, /w\.is_deleted = 0/);
  assert.doesNotMatch(candidateSql, /city_stockist|provincial_stockist/);
});

test('a customer pin routes to the nearest capable center', async () => {
  const stock = { 10: { 7: [5, 0] }, 20: { 7: [500, 0] } };
  const nearCaloocan = { customerLat: 14.66, customerLng: 120.98 };
  const nearTycoon = { customerLat: 14.55, customerLng: 121.03 };
  const db = fakeDb({ centers: [CALOOCAN, TYCOON], stock });
  assert.equal((await resolvePublicFulfillmentRoute(db, ONE_BOX, nearCaloocan)).warehouse_id, 10);
  assert.equal((await resolvePublicFulfillmentRoute(db, ONE_BOX, nearTycoon)).warehouse_id, 20);
});

test('the nearest center is skipped when it cannot fulfill', async () => {
  const db = fakeDb({
    centers: [CALOOCAN, TYCOON],
    stock: { 10: { 7: [0, 0] }, 20: { 7: [10, 0] } },
  });
  const route = await resolvePublicFulfillmentRoute(db, ONE_BOX, { customerLat: 14.66, customerLng: 120.98 });
  assert.equal(route.warehouse_id, 20);
});

test('without a pin the center with more available stock wins', async () => {
  const db = fakeDb({
    centers: [CALOOCAN, TYCOON],
    stock: { 10: { 7: [300, 100] }, 20: { 7: [250, 0] } }, // 200 vs 250 available
  });
  assert.equal((await resolvePublicFulfillmentRoute(db, ONE_BOX, {})).warehouse_id, 20);
});

test('equal stock ties break on the lowest warehouse id, whatever the input order', async () => {
  const stock = { 10: { 7: [100, 0] }, 20: { 7: [100, 0] } };
  for (const centers of [[CALOOCAN, TYCOON], [TYCOON, CALOOCAN]]) {
    const db = fakeDb({ centers, stock });
    assert.equal((await resolvePublicFulfillmentRoute(db, ONE_BOX, {})).warehouse_id, 10);
  }
});

test('a pin with a center that has no coordinates ranks that center last, then by id', () => {
  const ranked = rankPublicFulfillmentCandidates([
    { warehouse_id: 30, lat: null, lng: null, available_qty: 999 },
    { warehouse_id: 20, lat: null, lng: null, available_qty: 1 },
    { warehouse_id: 10, lat: 14.6, lng: 121.0, available_qty: 1 },
  ], { customerLat: 14.6, customerLng: 121.0 });
  assert.deepEqual(ranked.map((candidate) => candidate.warehouse_id), [10, 20, 30]);
});

test('center staff may belong to a center; Stockist owners and Mobile Stockists may not', async () => {
  const roles = {
    staff: { id: 4, slug: 'staff' },
    provincial_stockist: { id: 2, slug: 'provincial_stockist' },
    city_stockist: { id: 3, slug: 'city_stockist' },
    mobile_stockist: { id: 5, slug: 'mobile_stockist' },
  };
  const partners = { 90: { id: 90, stockist_level: 'center', status: 'active', is_deleted: 0 } };
  const base = {
    actor: { role_slug: 'super_admin' },
    getRoleBySlug: async (slug) => roles[slug] || null,
    getPartnerById: async (id) => partners[id] || null,
  };

  const staff = await resolveUserAssignment({ ...base, requested: { role_slug: 'staff', partner_id: 90 } });
  assert.deepEqual(staff, { roleId: 4, partnerId: 90 });

  for (const roleSlug of ['provincial_stockist', 'city_stockist', 'mobile_stockist']) {
    await assert.rejects(
      resolveUserAssignment({ ...base, requested: { role_slug: roleSlug, partner_id: 90 } }),
      (err) => err instanceof ApiError && err.statusCode === 400,
      `${roleSlug} must be rejected on a center`
    );
  }
});

test('staff on a partner with an unknown level is rejected (fail closed)', async () => {
  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'super_admin' },
      requested: { role_slug: 'staff', partner_id: 91 },
      getRoleBySlug: async () => ({ id: 4, slug: 'staff' }),
      getPartnerById: async () => ({ id: 91, stockist_level: 'warehouse_club', status: 'active', is_deleted: 0 }),
    }),
    (err) => err instanceof ApiError && err.statusCode === 400
  );
});

test('a center is not a Stockist level', () => {
  assert.equal(isStockistLevel('center'), false);
  assert.equal(isStockistLevel(undefined), false);
  assert.deepEqual([...STOCKIST_LEVELS], ['provincial_stockist', 'city_stockist']);
});

test('only Super Admin approves or verifies payment for a center order', () => {
  const order = { partner_id: 90, placed_by_role_slug: 'staff' };
  const centerStaff = { role: 'staff', userId: 5, partnerId: 90, partnerLevel: 'center', childCityPartnerIds: [] };
  assert.equal(canApproveOrderFromContext(centerStaff, order), false);
  assert.equal(canVerifyPaymentFromContext(centerStaff, order), false);

  const superAdmin = { role: 'super_admin', userId: 1, partnerId: null, partnerLevel: null, childCityPartnerIds: [] };
  assert.equal(canApproveOrderFromContext(superAdmin, order), true);
  assert.equal(canVerifyPaymentFromContext(superAdmin, order), true);
});

test('center staff still list their own center orders by partner_id', () => {
  const centerStaff = { role: 'staff', userId: 5, partnerId: 90, partnerLevel: 'center', childCityPartnerIds: [] };
  assert.deepEqual(buildOrderScopeFromContext(centerStaff), { clause: ' AND o.partner_id = ?', params: [90] });
});

test('an unrecognized partner level cannot approve even its own orders', () => {
  const context = { role: 'staff', userId: 5, partnerId: 90, partnerLevel: 'mystery', childCityPartnerIds: [] };
  assert.equal(canApproveOrderFromContext(context, { partner_id: 90, placed_by_role_slug: 'mobile_stockist' }), false);
});

test('login and /auth/me expose partner_level and partner_name from one LEFT JOIN', () => {
  assert.match(authSource, /LEFT JOIN partners p ON p\.id = u\.partner_id/);
  assert.match(authSource, /partner_level: user\.partner_level \|\| null/);
  assert.match(authSource, /partner_name: user\.partner_name \|\| null/);
  assert.match(authSource, /p\.stockist_level AS partner_level/);
});

test('center migration appends to the current enum and preserves nullability, default, comment', () => {
  assert.equal(
    buildEnumWithCenterDdl('partners', 'stockist_level', {
      COLUMN_TYPE: "enum('provincial_stockist','city_stockist')",
      IS_NULLABLE: 'NO',
      COLUMN_DEFAULT: 'city_stockist',
      COLUMN_COMMENT: '',
    }),
    "ALTER TABLE partners MODIFY COLUMN stockist_level ENUM('provincial_stockist','city_stockist','center') NOT NULL DEFAULT 'city_stockist'"
  );
  assert.equal(
    buildEnumWithCenterDdl('warehouses', 'type', {
      COLUMN_TYPE: "enum('manufacturer','region','city')",
      IS_NULLABLE: 'YES',
      COLUMN_DEFAULT: null,
      COLUMN_COMMENT: '',
    }),
    "ALTER TABLE warehouses MODIFY COLUMN type ENUM('manufacturer','region','city','center') NULL"
  );
});

// Regression: the first real run failed on MariaDB 10.4 with "Invalid default value for
// 'stockist_level'" because MariaDB returns COLUMN_DEFAULT already quoted and it was quoted again.
test('enum DDL keeps the original default on MariaDB (quoted COLUMN_DEFAULT)', () => {
  assert.equal(
    buildEnumWithCenterDdl('partners', 'stockist_level', {
      COLUMN_TYPE: "enum('provincial_stockist','city_stockist')",
      IS_NULLABLE: 'NO',
      COLUMN_DEFAULT: "'city_stockist'",
      COLUMN_COMMENT: '',
    }),
    "ALTER TABLE partners MODIFY COLUMN stockist_level ENUM('provincial_stockist','city_stockist','center') NOT NULL DEFAULT 'city_stockist'"
  );
});

test('column default normalizes MySQL and MariaDB shapes to one escaped literal', () => {
  assert.equal(columnDefaultClause('region'), " DEFAULT 'region'");      // MySQL 8 bare value
  assert.equal(columnDefaultClause("'region'"), " DEFAULT 'region'");    // MariaDB quoted literal
  assert.equal(columnDefaultClause(null), '');                           // MySQL: no default
  assert.equal(columnDefaultClause('NULL'), '');                         // MariaDB: DEFAULT NULL
  assert.equal(columnDefaultClause("'it''s'"), " DEFAULT 'it\\'s'");     // MariaDB doubled quote
  assert.equal(columnDefaultClause("it's"), " DEFAULT 'it\\'s'");        // MySQL raw quote
});
