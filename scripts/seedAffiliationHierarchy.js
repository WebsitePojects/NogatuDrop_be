const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');
const {
  DEV_HIERARCHY_PASSWORD,
  AFFILIATION_HIERARCHY_FIXTURE,
} = require('./affiliationHierarchyFixture');

const PROVINCIAL_STOCK = 1800;
const CITY_STOCK = 240;
const EXPIRY_DATE = '2030-12-31';

async function getRoleIds(conn) {
  const requiredRoles = ['provincial_stockist', 'city_stockist', 'mobile_stockist'];
  const [rows] = await conn.execute(
    `SELECT id, slug
     FROM roles
     WHERE slug IN (?, ?, ?)`,
    requiredRoles
  );

  const roleIds = rows.reduce((map, row) => {
    map[row.slug] = Number(row.id);
    return map;
  }, {});

  const missingRoles = requiredRoles.filter((slug) => !roleIds[slug]);
  if (missingRoles.length > 0) {
    throw new Error(
      `Missing required Stockist roles: ${missingRoles.join(', ')}. Run npm run migrate:city-mobile-logins:prod before npm run seed:prod.`
    );
  }

  return roleIds;
}

async function getSeedProducts(conn) {
  const [rows] = await conn.execute(
    `SELECT id, name
     FROM products
     WHERE is_deleted = 0
       AND is_active = 1
     ORDER BY id ASC
     LIMIT 3`
  );

  if (rows.length < 3) {
    throw new Error('Expected at least three active products for hierarchy inventory seeding');
  }

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
  }));
}

async function upsertPartner(conn, data) {
  const [existing] = await conn.execute(
    `SELECT id
     FROM partners
     WHERE email = ?
     LIMIT 1`,
    [data.partnerEmail]
  );

  if (existing.length > 0) {
    await conn.execute(
      `UPDATE partners
       SET business_name = ?,
           phone = ?,
           address = ?,
           region = ?,
           stockist_level = ?,
           parent_partner_id = ?,
           discount_pct = ?,
           status = 'active',
           is_deleted = 0
       WHERE id = ?`,
      [
        data.businessName,
        data.phone,
        data.address,
        data.region || null,
        data.stockistLevel,
        data.parentPartnerId || null,
        data.discountPct || 0,
        existing[0].id,
      ]
    );

    return Number(existing[0].id);
  }

  const [result] = await conn.execute(
    `INSERT INTO partners (
      business_name,
      email,
      phone,
      address,
      region,
      stockist_level,
      parent_partner_id,
      discount_pct,
      status,
      is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
    [
      data.businessName,
      data.partnerEmail,
      data.phone,
      data.address,
      data.region || null,
      data.stockistLevel,
      data.parentPartnerId || null,
      data.discountPct || 0,
    ]
  );

  return Number(result.insertId);
}

async function upsertUser(conn, data) {
  const [existing] = await conn.execute(
    `SELECT id
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [data.email]
  );

  if (existing.length > 0) {
    await conn.execute(
      `UPDATE users
       SET name = ?,
           password = ?,
           phone = ?,
           role_id = ?,
           partner_id = ?,
           level = ?,
           location = ?,
           status = 'active',
           is_deleted = 0
       WHERE id = ?`,
      [
        data.name,
        data.passwordHash,
        data.phone || null,
        data.roleId,
        data.partnerId || null,
        data.level,
        data.location,
        existing[0].id,
      ]
    );

    return Number(existing[0].id);
  }

  const [result] = await conn.execute(
    `INSERT INTO users (
      name,
      email,
      password,
      phone,
      role_id,
      partner_id,
      level,
      location,
      status,
      is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
    [
      data.name,
      data.email,
      data.passwordHash,
      data.phone || null,
      data.roleId,
      data.partnerId || null,
      data.level,
      data.location,
    ]
  );

  return Number(result.insertId);
}

async function upsertMobileStockist(conn, data) {
  const [existing] = await conn.execute(
    `SELECT id
     FROM mobile_stockists
     WHERE email = ?
     LIMIT 1`,
    [data.email]
  );

  if (existing.length > 0) {
    await conn.execute(
      `UPDATE mobile_stockists
       SET partner_id = ?,
           user_id = ?,
           name = ?,
           phone = ?,
           address = ?,
           region = ?,
           lat = ?,
           lng = ?,
           status = 'active',
           is_deleted = 0
       WHERE id = ?`,
      [
        data.partnerId,
        data.userId,
        data.name,
        data.phone || null,
        data.address || null,
        data.region || null,
        data.lat ?? null,
        data.lng ?? null,
        existing[0].id,
      ]
    );

    return Number(existing[0].id);
  }

  const [result] = await conn.execute(
    `INSERT INTO mobile_stockists (
      partner_id,
      user_id,
      name,
      email,
      phone,
      address,
      region,
      lat,
      lng,
      status,
      is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
    [
      data.partnerId,
      data.userId,
      data.name,
      data.email,
      data.phone || null,
      data.address || null,
      data.region || null,
      data.lat ?? null,
      data.lng ?? null,
    ]
  );

  return Number(result.insertId);
}

async function upsertWarehouse(conn, data) {
  const [existing] = await conn.execute(
    `SELECT id
     FROM warehouses
     WHERE partner_id = ?
       AND name = ?
     LIMIT 1`,
    [data.partnerId, data.name]
  );

  if (existing.length > 0) {
    await conn.execute(
      `UPDATE warehouses
       SET type = ?,
           location = ?,
           capacity_total = ?,
           capacity_used = ?,
           manager_name = ?,
           manager_email = ?,
           manager_phone = ?,
           lat = ?,
           lng = ?,
           is_active = 1,
           is_deleted = 0
       WHERE id = ?`,
      [
        data.type,
        data.location,
        data.capacityTotal,
        data.capacityUsed,
        data.managerName,
        data.managerEmail,
        data.managerPhone || null,
        data.lat ?? null,
        data.lng ?? null,
        existing[0].id,
      ]
    );

    return Number(existing[0].id);
  }

  const [result] = await conn.execute(
    `INSERT INTO warehouses (
      partner_id,
      name,
      type,
      location,
      capacity_total,
      capacity_used,
      manager_name,
      manager_email,
      manager_phone,
      lat,
      lng,
      is_active,
      is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    [
      data.partnerId,
      data.name,
      data.type,
      data.location,
      data.capacityTotal,
      data.capacityUsed,
      data.managerName,
      data.managerEmail,
      data.managerPhone || null,
      data.lat ?? null,
      data.lng ?? null,
    ]
  );

  return Number(result.insertId);
}

async function upsertInventory(conn, data) {
  const [existing] = await conn.execute(
    `SELECT id
     FROM inventories
     WHERE product_id = ?
       AND warehouse_id = ?
     ORDER BY id ASC
     LIMIT 1`,
    [data.productId, data.warehouseId]
  );

  if (existing.length > 0) {
    await conn.execute(
      `UPDATE inventories
       SET partner_id = ?,
           current_stock = ?,
           reserved_stock = 0,
           reorder_threshold = ?,
           warning_threshold = ?,
           batch_number = ?,
           expiry_date = ?,
           is_active = 1,
           last_movement_at = NOW()
       WHERE id = ?`,
      [
        data.partnerId,
        data.currentStock,
        data.reorderThreshold,
        data.warningThreshold,
        data.batchNumber,
        data.expiryDate,
        existing[0].id,
      ]
    );

    return Number(existing[0].id);
  }

  const [result] = await conn.execute(
    `INSERT INTO inventories (
      product_id,
      warehouse_id,
      partner_id,
      current_stock,
      reserved_stock,
      reorder_threshold,
      warning_threshold,
      batch_number,
      expiry_date,
      is_active,
      last_movement_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 1, NOW())`,
    [
      data.productId,
      data.warehouseId,
      data.partnerId,
      data.currentStock,
      data.reorderThreshold,
      data.warningThreshold,
      data.batchNumber,
      data.expiryDate,
    ]
  );

  return Number(result.insertId);
}

async function seedWarehouseInventory(conn, {
  partnerId,
  warehouseId,
  products,
  stock,
  prefix,
}) {
  for (const product of products) {
    await upsertInventory(conn, {
      productId: product.id,
      warehouseId,
      partnerId,
      currentStock: stock,
      reorderThreshold: 50,
      warningThreshold: 20,
      batchNumber: `${prefix}-${product.id}`,
      expiryDate: EXPIRY_DATE,
    });
  }
}

async function seedBranch(conn, branch, roleIds, products, passwordHash) {
  const provincialPartnerId = await upsertPartner(conn, {
    ...branch.provincial,
    stockistLevel: 'provincial_stockist',
    parentPartnerId: null,
  });
  const provincialUserId = await upsertUser(conn, {
    name: branch.provincial.name,
    email: branch.provincial.email,
    phone: branch.provincial.phone,
    passwordHash,
    roleId: roleIds.provincial_stockist,
    partnerId: provincialPartnerId,
    level: 'regional',
    location: branch.provincial.address,
  });
  const provincialWarehouseId = await upsertWarehouse(conn, {
    partnerId: provincialPartnerId,
    ...branch.provincial.warehouse,
    capacityTotal: 100000,
    capacityUsed: 0,
  });
  await seedWarehouseInventory(conn, {
    partnerId: provincialPartnerId,
    warehouseId: provincialWarehouseId,
    products,
    stock: PROVINCIAL_STOCK,
    prefix: `AFF-PROV-${provincialPartnerId}`,
  });

  const citySummaries = [];

  for (const unit of branch.cities) {
    const cityPartnerId = await upsertPartner(conn, {
      ...unit.city,
      stockistLevel: 'city_stockist',
      parentPartnerId: provincialPartnerId,
    });
    const cityUserId = await upsertUser(conn, {
      name: unit.city.name,
      email: unit.city.email,
      phone: unit.city.phone,
      passwordHash,
      roleId: roleIds.city_stockist,
      partnerId: cityPartnerId,
      level: 'city',
      location: unit.city.address,
    });
    const cityWarehouseId = await upsertWarehouse(conn, {
      partnerId: cityPartnerId,
      ...unit.city.warehouse,
      capacityTotal: 25000,
      capacityUsed: 0,
    });
    await seedWarehouseInventory(conn, {
      partnerId: cityPartnerId,
      warehouseId: cityWarehouseId,
      products,
      stock: CITY_STOCK,
      prefix: `AFF-CITY-${cityPartnerId}`,
    });

    const mobileUserId = await upsertUser(conn, {
      name: unit.mobile.name,
      email: unit.mobile.email,
      phone: unit.mobile.phone,
      passwordHash,
      roleId: roleIds.mobile_stockist,
      partnerId: cityPartnerId,
      level: 'city',
      location: unit.mobile.location || unit.mobile.address,
    });
    const mobileStockistId = await upsertMobileStockist(conn, {
      partnerId: cityPartnerId,
      userId: mobileUserId,
      name: unit.mobile.name,
      email: unit.mobile.email,
      phone: unit.mobile.phone,
      address: unit.mobile.address,
      region: unit.city.region || branch.provincial.region || null,
      lat: unit.mobile.lat,
      lng: unit.mobile.lng,
    });

    citySummaries.push({
      cityPartnerId,
      cityUserId,
      cityEmail: unit.city.email,
      mobileUserId,
      mobileStockistId,
      mobileEmail: unit.mobile.email,
      parentProvincialPartnerId: provincialPartnerId,
    });
  }

  return {
    provincialPartnerId,
    provincialUserId,
    provincialEmail: branch.provincial.email,
    provincialWarehouseId,
    cities: citySummaries,
  };
}

async function repairCoreDevChainCoordinates(conn) {
  await conn.execute(
    `UPDATE mobile_stockists ms
     JOIN users u ON u.id = ms.user_id
     SET ms.lat = ?, ms.lng = ?
     WHERE u.email = 'mobile@nogatu.com'`,
    [14.4882, 121.0286]
  );
}

async function main() {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const roleIds = await getRoleIds(conn);
    const products = await getSeedProducts(conn);
    const passwordHash = await bcrypt.hash(DEV_HIERARCHY_PASSWORD, 12);
    const branches = [];

    for (const branch of AFFILIATION_HIERARCHY_FIXTURE) {
      branches.push(await seedBranch(conn, branch, roleIds, products, passwordHash));
    }

    await repairCoreDevChainCoordinates(conn);

    await conn.commit();

    console.log(JSON.stringify({
      password: DEV_HIERARCHY_PASSWORD,
      seededProducts: products,
      branches,
    }, null, 2));
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
