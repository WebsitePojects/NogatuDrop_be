const mysql = require('mysql2/promise');

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || 'nogatu_ncdms',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 2,
  });

  try {
    const [result] = await pool.execute(
      "UPDATE products SET retail_price = 580 WHERE name LIKE '%Glow%' AND is_deleted = 0"
    );
    console.log(`setGlowSrp: ${result.affectedRows} row(s) updated (retail_price = 580).`);
  } catch (err) {
    console.error('setGlowSrp error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
