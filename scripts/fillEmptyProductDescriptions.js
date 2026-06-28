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
    // Fetch products with empty/null descriptions
    const [products] = await pool.execute(
      `SELECT id, name, category FROM products
       WHERE (description IS NULL OR description = '') AND is_deleted = 0`
    );

    if (products.length === 0) {
      console.log('fillEmptyProductDescriptions: No products with empty descriptions found. Nothing to do.');
      return;
    }

    let updatedCount = 0;
    for (const product of products) {
      const category = (product.category || 'wellness').trim();
      const description = `${product.name} — premium Nogatu ${category} product.`;

      const [result] = await pool.execute(
        'UPDATE products SET description = ? WHERE id = ? AND (description IS NULL OR description = \'\') AND is_deleted = 0',
        [description, product.id]
      );
      if (result.affectedRows > 0) {
        updatedCount++;
        console.log(`  [${product.id}] "${product.name}" → "${description}"`);
      }
    }

    console.log(`fillEmptyProductDescriptions: ${updatedCount} row(s) updated.`);
  } catch (err) {
    console.error('fillEmptyProductDescriptions error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
