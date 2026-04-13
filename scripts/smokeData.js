const pool = require('../src/config/db');

(async () => {
  try {
    const [orders] = await pool.execute(
      "SELECT id, order_number, status FROM orders WHERE is_deleted = 0 ORDER BY id DESC LIMIT 5"
    );
    const [tokens] = await pool.execute(
      "SELECT token, order_id, is_used, expires_at FROM delivery_tokens ORDER BY id DESC LIMIT 5"
    );

    console.log('ORDERS');
    console.log(JSON.stringify(orders, null, 2));
    console.log('TOKENS');
    console.log(JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
