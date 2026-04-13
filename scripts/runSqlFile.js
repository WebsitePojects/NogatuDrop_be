const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: node scripts/runSqlFile.js <sql-file-path>');
  }

  const sqlPath = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`SQL file not found: ${sqlPath}`);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  if (!sql.trim()) {
    throw new Error(`SQL file is empty: ${sqlPath}`);
  }

  const connection = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    multipleStatements: true,
    timezone: '+00:00',
    dateStrings: true,
  });

  try {
    const [resultSets] = await connection.query(sql);

    const sets = Array.isArray(resultSets) ? resultSets : [resultSets];
    const lastSet = sets[sets.length - 1];

    console.log(JSON.stringify({
      success: true,
      file: sqlPath,
      resultSets: sets.length,
      finalResult: Array.isArray(lastSet) ? lastSet : null,
    }, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
