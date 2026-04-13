const crypto = require('crypto');
const pool = require('../src/config/db');

(async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orders] = await conn.execute(
      "SELECT id, order_number, status FROM orders WHERE is_deleted = 0 AND status IN ('approved', 'delivering') ORDER BY id DESC LIMIT 1"
    );
    if (orders.length === 0) {
      throw new Error('No approved/delivering order available for smoke data');
    }

    const order = orders[0];

    const [trackRows] = await conn.execute(
      'SELECT id FROM delivery_tracking WHERE order_id = ? LIMIT 1',
      [order.id]
    );

    let trackingId = null;
    if (trackRows.length === 0) {
      const [insertTracking] = await conn.execute(
        "INSERT INTO delivery_tracking (order_id, status) VALUES (?, 'out_for_delivery')",
        [order.id]
      );
      trackingId = insertTracking.insertId;
    } else {
      trackingId = trackRows[0].id;
      await conn.execute(
        "UPDATE delivery_tracking SET status = 'out_for_delivery', updated_at = NOW() WHERE id = ?",
        [trackingId]
      );
    }

    const token = crypto.randomUUID();
    await conn.execute(
      "INSERT INTO delivery_tokens (order_id, token, expires_at, is_used, created_by) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 48 HOUR), 0, 1)",
      [order.id, token]
    );

    await conn.commit();

    console.log(JSON.stringify({
      order_id: order.id,
      order_number: order.order_number,
      tracking_id: trackingId,
      token,
    }, null, 2));
  } catch (err) {
    await conn.rollback();
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    process.exit();
  }
})();
