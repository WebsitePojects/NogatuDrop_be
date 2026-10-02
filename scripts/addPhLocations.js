// Adds the Philippine location reference tables (PSGC: regions, provinces, cities/municipalities,
// barangays) and splits a public order's customer name and address into atomic columns.
//
// Why: checkout used to take one free-text name and one free-text address, so reports could not group
// by city, couriers got inconsistent addresses and nobody could tell a first name from a surname. New
// orders store first/middle/last name, suffix, a street line, a PSGC barangay code and a postal code.
// City, province and region are reached through the reference tables, never copied onto the order
// (3NF). Orders placed before this keep their original customer_name / customer_address text; every
// read composes the display value from the parts and falls back to that text
// (src/utils/orderCustomerSql.js).
//
// Data: data/psgc/*.json, built from the PSA PSGC list published at https://psgc.gitlab.io/api/
// (fetched 2026-10-02). To refresh, replace those files and re-run: names are updated in place and
// codes are never deleted, because orders reference them.
//
// Additive and idempotent: creates only what is missing; re-running changes nothing.
// Refuses to run without an env file so it can never fall back to a default database.
// Run: node --env-file=.env.dev scripts/addPhLocations.js
const path = require('path');
const mysql = require('mysql2/promise');

const DATA_DIR = path.join(__dirname, '..', 'data', 'psgc');
const INSERT_BATCH_SIZE = 1000;

const TABLES = [
  {
    name: 'ph_regions',
    ddl: `CREATE TABLE ph_regions (
      code CHAR(9) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
  {
    name: 'ph_provinces',
    ddl: `CREATE TABLE ph_provinces (
      code CHAR(9) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      region_code CHAR(9) NOT NULL,
      KEY idx_ph_provinces_region (region_code),
      CONSTRAINT fk_ph_provinces_region FOREIGN KEY (region_code) REFERENCES ph_regions (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
  {
    // region_code is set only for the few cities that belong to no province (Metro Manila, Isabela
    // City, Cotabato City); for every other city the region comes from its province, so storing it
    // again would be a transitive dependency.
    name: 'ph_cities_municipalities',
    ddl: `CREATE TABLE ph_cities_municipalities (
      code CHAR(9) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      province_code CHAR(9) NULL,
      region_code CHAR(9) NULL,
      is_city TINYINT(1) NOT NULL DEFAULT 0,
      KEY idx_ph_cities_province (province_code),
      KEY idx_ph_cities_region (region_code),
      CONSTRAINT fk_ph_cities_province FOREIGN KEY (province_code) REFERENCES ph_provinces (code),
      CONSTRAINT fk_ph_cities_region FOREIGN KEY (region_code) REFERENCES ph_regions (code),
      CONSTRAINT chk_ph_cities_one_parent CHECK ((province_code IS NULL) <> (region_code IS NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
  {
    name: 'ph_barangays',
    ddl: `CREATE TABLE ph_barangays (
      code CHAR(9) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      city_code CHAR(9) NOT NULL,
      KEY idx_ph_barangays_city (city_code),
      CONSTRAINT fk_ph_barangays_city FOREIGN KEY (city_code) REFERENCES ph_cities_municipalities (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
];

// Seed order follows the foreign keys: parents before children.
const SEEDS = [
  { table: 'ph_regions', file: 'regions.json', columns: ['code', 'name'] },
  { table: 'ph_provinces', file: 'provinces.json', columns: ['code', 'name', 'region_code'] },
  { table: 'ph_cities_municipalities', file: 'cities.json', columns: ['code', 'name', 'province_code', 'region_code', 'is_city'] },
  { table: 'ph_barangays', file: 'barangays.json', columns: ['code', 'name', 'city_code'] },
];

const ORDER_COLUMNS = [
  ['customer_first_name', 'VARCHAR(80) NULL'],
  ['customer_middle_name', 'VARCHAR(80) NULL'],
  ['customer_last_name', 'VARCHAR(80) NULL'],
  ['customer_name_suffix', 'VARCHAR(10) NULL'],
  ['customer_address_line', 'VARCHAR(255) NULL'],
  ['customer_barangay_code', 'CHAR(9) NULL'],
  ['customer_postal_code', 'CHAR(4) NULL'],
];

function loadSeedRows(file) {
  return require(path.join(DATA_DIR, file));
}

/** Splits rows into fixed-size chunks so one INSERT never grows past max_allowed_packet. */
function chunk(rows, size = INSERT_BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

async function tableExists(pool, table) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function columnExists(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function constraintExists(pool, table, constraint) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [table, constraint]
  );
  return rows.length > 0;
}

async function seedTable(pool, { table, file, columns }) {
  const rows = loadSeedRows(file);
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const updates = columns.filter((c) => c !== 'code').map((c) => `${c} = VALUES(${c})`).join(', ');
  const [[{ row_count: before }]] = await pool.query(`SELECT COUNT(*) AS row_count FROM ${table}`);
  for (const batch of chunk(rows)) {
    await pool.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${batch.map(() => placeholders).join(', ')}
       ON DUPLICATE KEY UPDATE ${updates}`,
      batch.flat()
    );
  }
  const [[{ row_count: after }]] = await pool.query(`SELECT COUNT(*) AS row_count FROM ${table}`);
  console.log(`${table}: ${rows.length} in data file, ${after} in table (${after - before} new)`);
}

async function main() {
  if (!process.env.DB_NAME) {
    throw new Error('DB_NAME is not set. Run with --env-file=<.env.dev|.env.prod>.');
  }
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  });

  try {
    for (const { name, ddl } of TABLES) {
      if (await tableExists(pool, name)) {
        console.log(`${name} already exists — skipping create`);
      } else {
        await pool.query(ddl);
        console.log(`Created ${name}`);
      }
    }
    for (const seed of SEEDS) await seedTable(pool, seed);

    for (const [column, type] of ORDER_COLUMNS) {
      if (await columnExists(pool, 'orders', column)) {
        console.log(`orders.${column} already exists — skipping`);
      } else {
        await pool.query(`ALTER TABLE orders ADD COLUMN ${column} ${type}`);
        console.log(`Added orders.${column}`);
      }
    }
    if (await constraintExists(pool, 'orders', 'fk_orders_customer_barangay')) {
      console.log('fk_orders_customer_barangay already exists — skipping');
    } else {
      await pool.query(
        `ALTER TABLE orders ADD CONSTRAINT fk_orders_customer_barangay
         FOREIGN KEY (customer_barangay_code) REFERENCES ph_barangays (code)`
      );
      console.log('Added fk_orders_customer_barangay');
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('ERR', error.message);
    process.exit(1);
  });
}

module.exports = { chunk, TABLES, SEEDS, ORDER_COLUMNS };
