// Makes company fulfillment centers (Caloocan, Tycoon) a first-class concept:
//   partners.stockist_level  += 'center'
//   warehouses.type          += 'center'
//   warehouses.operating_hours VARCHAR(80) NULL
// Additive and idempotent: each step reads information_schema first and is skipped when already
// applied. Mirrors sql/store_centers_2026_10_02.sql. Usage: node scripts/addStoreCenters.js
const mysql = require('mysql2/promise');
const { escape } = require('mysql2');

const CENTER_VALUE = 'center';

// information_schema.COLUMN_DEFAULT differs by engine. MySQL 8 returns the bare value
// (`city_stockist`, or JS null for no default). MariaDB >= 10.2.7 returns a SQL literal: strings
// arrive already quoted (`'city_stockist'`) and a NULL default arrives as the 4-char string `NULL`.
// Escaping the MariaDB form again produced DEFAULT '\'city_stockist\'' and the ALTER failed with
// "Invalid default value" — so normalize to the bare value first, then escape exactly once.
function columnDefaultClause(rawDefault) {
  if (rawDefault == null || rawDefault === 'NULL') return '';
  const quoted = /^'([\s\S]*)'$/.exec(rawDefault);
  const bareValue = quoted ? quoted[1].replace(/''/g, "'") : rawDefault;
  return ` DEFAULT ${escape(bareValue)}`;
}

// Rebuilds the column definition from information_schema so MODIFY COLUMN preserves nullability,
// default and comment exactly — only the enum list grows.
function buildEnumWithCenterDdl(table, column, meta) {
  const values = [...meta.COLUMN_TYPE.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]);
  const enumList = [...values, CENTER_VALUE].map((value) => `'${value}'`).join(',');
  const nullability = meta.IS_NULLABLE === 'NO' ? 'NOT NULL' : 'NULL';
  const defaultClause = columnDefaultClause(meta.COLUMN_DEFAULT);
  const commentClause = meta.COLUMN_COMMENT ? ` COMMENT ${escape(meta.COLUMN_COMMENT)}` : '';
  // table/column are constants from this file, never user input; values come from the schema itself.
  return `ALTER TABLE ${table} MODIFY COLUMN ${column} ENUM(${enumList}) ${nullability}${defaultClause}${commentClause}`;
}

async function readColumn(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column]
  );
  return rows[0] || null;
}

async function addCenterToEnum(pool, table, column) {
  const meta = await readColumn(pool, table, column);
  if (!meta) throw new Error(`${table}.${column} does not exist`);
  if (!/^enum\(/i.test(meta.COLUMN_TYPE)) throw new Error(`${table}.${column} is not an enum: ${meta.COLUMN_TYPE}`);
  if (meta.COLUMN_TYPE.includes(`'${CENTER_VALUE}'`)) {
    console.log(`${table}.${column} already has '${CENTER_VALUE}' — skipping`);
    return;
  }
  await pool.query(buildEnumWithCenterDdl(table, column, meta));
  console.log(`${table}.${column} now accepts '${CENTER_VALUE}'`);
}

async function addOperatingHours(pool) {
  if (await readColumn(pool, 'warehouses', 'operating_hours')) {
    console.log('warehouses.operating_hours already exists — skipping');
    return;
  }
  await pool.query('ALTER TABLE warehouses ADD COLUMN operating_hours VARCHAR(80) NULL');
  console.log('warehouses.operating_hours added');
}

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });

  try {
    await addCenterToEnum(pool, 'partners', 'stockist_level');
    await addCenterToEnum(pool, 'warehouses', 'type');
    await addOperatingHours(pool);
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

module.exports = { buildEnumWithCenterDdl, columnDefaultClause };
