const pool = require('../src/config/db');

(async () => {
  try {
    const [cols] = await pool.execute('SHOW COLUMNS FROM users');
    console.log('USERS_COLUMNS');
    console.log(cols.map((c) => c.Field).join(','));

    const [rows] = await pool.execute(
      `SELECT u.id, u.email, u.partner_id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.slug = 'super_admin' AND u.status = 'active' AND u.is_deleted = 0
       ORDER BY u.id ASC
       LIMIT 1`
    );

    console.log('ADMIN_ROWS');
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('QUERY_ERROR', err.code, err.sqlMessage || err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
