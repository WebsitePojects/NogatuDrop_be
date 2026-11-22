// Dynamic shipping fee for store orders (meeting with Sir Dino, 2026-11-10; rates from PROPOSAL_0026_SHIPPING_FEES):
//   products.weight_grams        weight of one unit. A product with no weight cannot be checked out.
//   shipping_zones               delivery tiers (local, same island group, 1 or 2 groups away, Island, Palawan)
//                                with delivery days (calendar days).
//   shipping_rates               fee per tier per weight bracket: the smallest max_weight_grams >= cart weight.
//   shipping_area_zones          a region's island group; a province row marks Island / Palawan (beats its region).
//   orders.shipping_zone, shipping_weight_grams, delivery_eta_from/_to, delivery_eta_min/max_days
//                                what the buyer was quoted, saved with the order so later rate changes never alter it.
//
// Seeds only rows that are missing (INSERT IGNORE / weight still NULL), so Super Admin's edits on the Shipping
// screen survive a re-run. Additive and idempotent. Dry run unless --apply.
// Usage: node --env-file=<env> scripts/addShippingRates.js [--apply]
const mysql = require('mysql2/promise');

// Rates and days are the proposal's table (origin NCR), as Sir Dino decided on 2026-11-23. Each row is a delivery
// tier counted from where the parcel leaves (services/shippingService.js shippingTier): from the NCR hubs the
// tiers are exactly the proposal's NCR / Luzon / Visayas / Mindanao / Island / Palawan columns.
const ZONES = [
  // code, name, eta_min_days, eta_max_days, [fee up to 3 kg, up to 4 kg, up to 5 kg]
  ['NCR', 'Local: same region', 1, 6, [185, 240, 265]],
  ['LUZON', 'Same island group', 1, 8, [230, 335, 385]],
  ['VISAYAS', 'One island group away', 3, 10, [240, 360, 445]],
  ['MINDANAO', 'Two island groups away', 3, 10, [265, 395, 445]],
  ['ISLAND', 'Island provinces', 5, 9, [275, 410, 455]],
  // Palawan is an island at the Island rate (Sir Dino, 2026-11-23) with the proposal's own 5-24 day window.
  ['PALAWAN', 'Palawan', 5, 24, [275, 410, 455]],
];
const BRACKET_MAX_GRAMS = [3000, 4000, 5000];

// Island group of each region (Luzon, Visayas, Mindanao). NCR is in Luzon.
const REGION_ZONES = {
  130000000: 'LUZON',
  '010000000': 'LUZON', '020000000': 'LUZON', '030000000': 'LUZON', '040000000': 'LUZON',
  '050000000': 'LUZON', 140000000: 'LUZON', 170000000: 'LUZON',
  '060000000': 'VISAYAS', '070000000': 'VISAYAS', '080000000': 'VISAYAS',
  '090000000': 'MINDANAO', 100000000: 'MINDANAO', 110000000: 'MINDANAO', 120000000: 'MINDANAO',
  150000000: 'MINDANAO', 160000000: 'MINDANAO',
};

// J&T's own "Island" provinces, read from J&T's public rate calculator on 2026-10-23 (3 towns per province),
// as published in github.com/atc1989/GutGuard-Doctors-HTML/pull/56. Marinduque, Mindoro, Masbate and
// Catanduanes are Luzon for J&T. Palawan is Island by Sir Dino's decision (J&T itself prices it as Visayas).
const PROVINCE_ZONES = {
  175300000: 'PALAWAN',
  148100000: 'ISLAND', // Apayao
  150700000: 'ISLAND', // Basilan
  '020900000': 'ISLAND', // Batanes
  101800000: 'ISLAND', // Camiguin
  168500000: 'ISLAND', // Dinagat Islands
  '067900000': 'ISLAND', // Guimaras
  144400000: 'ISLAND', // Mountain Province
  175900000: 'ISLAND', // Romblon
  '076100000': 'ISLAND', // Siquijor
  156600000: 'ISLAND', // Sulu
  157000000: 'ISLAND', // Tawi-Tawi
};

// Grams per unit from the proposal's weight table, matched by SKU.
const PRODUCT_WEIGHTS = {
  'NOG-109': 290, // Berry NAD+, 1 box
  'NOG-108': 179, // Max Fuel, 1 pack
  'NOG-102': 44, // Vitamin C with Collagen & Glutathione, 1 bottle
  'NOG-106': 45, // Vitamin C with Zinc & Mangosteen, 1 bottle
  'NOG-110': 17, // Glow (Glutathione), 1 box
  'NOG-100': 68, // Barley Juice, 1 box
  'NOG-105': 193, // Mangosteen Coffee, 1 box
  'NOG-107': 49, // Black Coffee, 1 pack
  'NOG-104': 445, // Coffee Mix, 1 pack
  'NOG-103': 477, // Chocolate Mix, 1 box
};

// The collation is spelled out: these tables join ph_* tables (utf8mb4_unicode_ci), and a server whose
// default is utf8mb4_general_ci would otherwise create them with a mix MariaDB refuses to compare.
const CREATE_TABLES = {
  shipping_zones: `CREATE TABLE shipping_zones (
    code VARCHAR(20) NOT NULL PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    eta_min_days TINYINT UNSIGNED NOT NULL,
    eta_max_days TINYINT UNSIGNED NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_shipping_zones_eta CHECK (eta_min_days <= eta_max_days),
    CONSTRAINT fk_shipping_zones_user FOREIGN KEY (updated_by) REFERENCES users (id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  shipping_rates: `CREATE TABLE shipping_rates (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zone_code VARCHAR(20) NOT NULL,
    max_weight_grams INT UNSIGNED NOT NULL,
    fee DECIMAL(10,2) NOT NULL,
    UNIQUE KEY uq_shipping_rates_bracket (zone_code, max_weight_grams),
    CONSTRAINT fk_shipping_rates_zone FOREIGN KEY (zone_code) REFERENCES shipping_zones (code)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  shipping_area_zones: `CREATE TABLE shipping_area_zones (
    area_type ENUM('region','province') NOT NULL,
    area_code CHAR(9) NOT NULL,
    zone_code VARCHAR(20) NOT NULL,
    PRIMARY KEY (area_type, area_code),
    CONSTRAINT fk_shipping_area_zones_zone FOREIGN KEY (zone_code) REFERENCES shipping_zones (code)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
};

const ADD_COLUMNS = [
  ['products', 'weight_grams', 'ALTER TABLE products ADD COLUMN weight_grams INT UNSIGNED NULL AFTER unit'],
  ['orders', 'shipping_zone', 'ALTER TABLE orders ADD COLUMN shipping_zone VARCHAR(20) NULL AFTER shipping_fee'],
  ['orders', 'shipping_weight_grams', 'ALTER TABLE orders ADD COLUMN shipping_weight_grams INT UNSIGNED NULL AFTER shipping_zone'],
  ['orders', 'delivery_eta_from', 'ALTER TABLE orders ADD COLUMN delivery_eta_from DATE NULL AFTER shipping_weight_grams'],
  ['orders', 'delivery_eta_to', 'ALTER TABLE orders ADD COLUMN delivery_eta_to DATE NULL AFTER delivery_eta_from'],
  // The tier's delivery days, kept so the dates can be counted again from the day payment is confirmed.
  ['orders', 'delivery_eta_min_days', 'ALTER TABLE orders ADD COLUMN delivery_eta_min_days TINYINT UNSIGNED NULL AFTER delivery_eta_to'],
  ['orders', 'delivery_eta_max_days', 'ALTER TABLE orders ADD COLUMN delivery_eta_max_days TINYINT UNSIGNED NULL AFTER delivery_eta_min_days'],
];

async function columnExists(db, table, column) {
  const [rows] = await db.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function tableExists(db, table) {
  const [rows] = await db.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table]
  );
  return rows.length > 0;
}

async function plannedDdl(db) {
  const statements = [];
  for (const [table, column, ddl] of ADD_COLUMNS) {
    if (!(await columnExists(db, table, column))) statements.push(ddl);
  }
  for (const [table, ddl] of Object.entries(CREATE_TABLES)) {
    if (!(await tableExists(db, table))) statements.push(ddl);
  }
  return statements;
}

/** Seed rows as [sql, params, label]. Every statement only adds what is missing. */
function seedStatements() {
  const seeds = [];
  ZONES.forEach(([code, name, etaMin, etaMax, fees], index) => {
    seeds.push([
      'INSERT IGNORE INTO shipping_zones (code, name, eta_min_days, eta_max_days, sort_order) VALUES (?, ?, ?, ?, ?)',
      [code, name, etaMin, etaMax, index + 1],
      `zone ${code} (${etaMin}-${etaMax} days)`,
    ]);
    fees.forEach((fee, bracket) => {
      seeds.push([
        'INSERT IGNORE INTO shipping_rates (zone_code, max_weight_grams, fee) VALUES (?, ?, ?)',
        [code, BRACKET_MAX_GRAMS[bracket], fee],
        `rate ${code} up to ${BRACKET_MAX_GRAMS[bracket] / 1000} kg = PHP ${fee}`,
      ]);
    });
  });
  for (const [regionCode, zone] of Object.entries(REGION_ZONES)) {
    seeds.push([
      `INSERT IGNORE INTO shipping_area_zones (area_type, area_code, zone_code)
       SELECT 'region', code, ? FROM ph_regions WHERE code = ?`,
      [zone, String(regionCode).padStart(9, '0')],
      `region ${String(regionCode).padStart(9, '0')} -> ${zone}`,
    ]);
  }
  for (const [provinceCode, zone] of Object.entries(PROVINCE_ZONES)) {
    seeds.push([
      `INSERT IGNORE INTO shipping_area_zones (area_type, area_code, zone_code)
       SELECT 'province', code, ? FROM ph_provinces WHERE code = ?`,
      [zone, String(provinceCode).padStart(9, '0')],
      `province ${String(provinceCode).padStart(9, '0')} -> ${zone}`,
    ]);
  }
  for (const [sku, grams] of Object.entries(PRODUCT_WEIGHTS)) {
    seeds.push([
      'UPDATE products SET weight_grams = ? WHERE sku = ? AND weight_grams IS NULL',
      [grams, sku],
      `weight ${sku} = ${grams} g (only if not set yet)`,
    ]);
  }
  return seeds;
}

async function main() {
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<env>.');
  const apply = process.argv.includes('--apply');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });
  try {
    console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    const ddl = await plannedDdl(conn);
    for (const sql of ddl) {
      console.log(`${apply ? 'run ' : 'plan'}  ${sql.split('\n')[0]}`);
      if (apply) await conn.query(sql);
    }
    if (!apply) {
      console.log(`plan  seed ${seedStatements().length} zone/rate/area/weight rows where missing`);
      console.log('\nDry run only. Re-run with --apply to make these changes.');
      return;
    }
    // Seeds run in one transaction: a half-seeded rate table would quote some zones and refuse others.
    await conn.beginTransaction();
    let changed = 0;
    for (const [sql, params, label] of seedStatements()) {
      const [result] = await conn.execute(sql, params);
      if (result.affectedRows > 0) {
        changed += 1;
        console.log(`seed  ${label}`);
      }
    }
    await conn.commit();
    console.log(changed === 0 ? 'Seeds already present. Nothing added.' : `Added ${changed} seed rows.`);
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

module.exports = { ZONES, BRACKET_MAX_GRAMS, REGION_ZONES, PROVINCE_ZONES, PRODUCT_WEIGHTS };
