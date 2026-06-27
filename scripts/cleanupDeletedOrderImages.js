// Safety-fallback cleanup: free Cloudinary storage for SOFT-DELETED orders by
// destroying their payment-proof images and proof-of-delivery photos. Recipient
// signatures are stored inline in the DB (not Cloudinary) so they need no cloud
// cleanup. Safe to re-run (Cloudinary "not found" is treated as success).
// Run: node --env-file=.env.dev scripts/cleanupDeletedOrderImages.js
const mysql = require('mysql2/promise');
const { destroyMany } = require('../src/utils/cloudinaryCleanup');

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });

  const [orders] = await pool.execute(
    "SELECT id, order_number, payment_proof_url FROM orders WHERE is_deleted = 1 AND payment_proof_url IS NOT NULL AND payment_proof_url <> ''"
  );

  let pods = [];
  try {
    [pods] = await pool.execute(
      `SELECT pod.photo_url
       FROM proof_of_delivery pod
       JOIN orders o ON o.id = pod.order_id
       WHERE o.is_deleted = 1 AND pod.photo_url IS NOT NULL AND pod.photo_url <> ''`
    );
  } catch {
    // proof_of_delivery table may not exist on every environment — skip gracefully.
  }

  const urls = [
    ...orders.map((o) => o.payment_proof_url),
    ...pods.map((p) => p.photo_url),
  ];

  console.log(`Soft-deleted orders with proof images: ${orders.length}`);
  console.log(`POD photos on deleted orders: ${pods.length}`);
  console.log(`Total Cloudinary assets to purge: ${urls.length}`);

  if (urls.length === 0) {
    console.log('Nothing to clean up.');
    await pool.end();
    return;
  }

  const res = await destroyMany(urls);
  console.log(`Cloudinary cleanup done — destroyed: ${res.destroyed}, skipped/failed: ${res.skipped}`);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
