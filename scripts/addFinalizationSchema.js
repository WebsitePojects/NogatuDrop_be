// Finalization schema (staging first): what the delivery map and the shared address picker need.
//   delivery_tracking.vehicle_type      ENUM('motorcycle','car','van','truck') NOT NULL DEFAULT 'motorcycle'
//   warehouses / partners / mobile_stockists:
//     address_line VARCHAR(200) NULL, barangay_code CHAR(9) NULL (FK ph_barangays), postal_code VARCHAR(10) NULL
// The old single-text columns (warehouses.location, partners.address, mobile_stockists.address) stay and
// are rewritten from the parts on save, so every existing screen and report keeps working.
//
// Additive and idempotent: each step checks information_schema first and is skipped when present.
// Dry run unless --apply. Usage: node --env-file=.env.prod scripts/addFinalizationSchema.js [--apply]
const mysql = require('mysql2/promise');

const { VEHICLE_TYPES } = require('../src/utils/vehicleTypes');
const ADDRESS_TABLES = ['warehouses', 'partners', 'mobile_stockists'];

// Same collation as ph_barangays.code: a mismatched collation makes the foreign key fail to create.
const ADDRESS_COLUMNS = [
  ['address_line', 'VARCHAR(200) NULL'],
  ['barangay_code', 'CHAR(9) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL'],
  ['postal_code', 'VARCHAR(10) NULL'],
];

async function columnExists(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function constraintExists(pool, table, name) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [table, name]
  );
  return rows.length > 0;
}

/** Lists the DDL still needed. Table and column names come from the constants above, never input. */
async function plannedStatements(pool) {
  const statements = [];
  if (!(await columnExists(pool, 'delivery_tracking', 'vehicle_type'))) {
    const values = VEHICLE_TYPES.map((v) => `'${v}'`).join(',');
    statements.push(`ALTER TABLE delivery_tracking ADD COLUMN vehicle_type ENUM(${values}) NOT NULL DEFAULT 'motorcycle'`);
  }
  for (const table of ADDRESS_TABLES) {
    for (const [column, type] of ADDRESS_COLUMNS) {
      if (!(await columnExists(pool, table, column))) {
        statements.push(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    const fk = `fk_${table}_barangay`;
    if (!(await constraintExists(pool, table, fk))) {
      statements.push(`ALTER TABLE ${table} ADD CONSTRAINT ${fk} FOREIGN KEY (barangay_code) REFERENCES ph_barangays (code)`);
    }
  }
  return statements;
}

async function main() {
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<.env.dev|.env.prod>.');
  const apply = process.argv.includes('--apply');
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });
  try {
    if (!(await columnExists(pool, 'ph_barangays', 'code'))) {
      throw new Error('ph_barangays is missing. Run scripts/addPhLocations.js first.');
    }
    const statements = await plannedStatements(pool);
    console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    if (statements.length === 0) {
      console.log('Nothing to do — schema already up to date.');
      return;
    }
    for (const sql of statements) {
      console.log(`${apply ? 'run ' : 'plan'}  ${sql}`);
      if (apply) await pool.query(sql);
    }
    if (!apply) console.log('\nDry run only. Re-run with --apply to make these changes.');
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

module.exports = { VEHICLE_TYPES, plannedStatements };
