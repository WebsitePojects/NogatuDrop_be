const pool = require('../src/config/db');
const { NOGATU_MLM_LANDING_CATALOG } = require('./catalog/nogatuMlmLandingCatalog');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function rankMatch(row, product) {
  const sku = normalize(row.sku);
  const name = normalize(row.name);

  if (sku === normalize(product.sku)) return 4;
  if (name === normalize(product.name)) return 3;
  if ((product.aliases || []).map(normalize).includes(name)) return 2;
  if ((product.aliases || []).map(normalize).includes(sku)) return 1;
  return 0;
}

function findExistingProduct(rows, product, usedIds) {
  let bestRow = null;
  let bestRank = 0;

  for (const row of rows) {
    if (usedIds.has(row.id)) continue;
    const rank = rankMatch(row, product);
    if (rank > bestRank) {
      bestRank = rank;
      bestRow = row;
    }
  }

  return bestRow;
}

async function main() {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [existingRows] = await conn.execute(
      `SELECT id, sku, name
       FROM products
       WHERE is_deleted = 0
       ORDER BY id ASC
       FOR UPDATE`
    );

    const usedIds = new Set();
    const syncedIds = [];

    for (const product of NOGATU_MLM_LANDING_CATALOG) {
      const existing = findExistingProduct(existingRows, product, usedIds);

      if (existing) {
        usedIds.add(existing.id);
        syncedIds.push(existing.id);
        await conn.execute(
          `UPDATE products
           SET name = ?,
               sku = ?,
               category = ?,
               retail_price = ?,
               partner_price = ?,
               unit = ?,
               description = ?,
               image_url = ?,
               is_active = 1
           WHERE id = ?`,
          [
            product.name,
            product.sku,
            product.category,
            product.retailPrice,
            product.partnerPrice,
            product.unit,
            product.description,
            product.imageUrl,
            existing.id,
          ]
        );
        continue;
      }

      const [result] = await conn.execute(
        `INSERT INTO products
         (name, sku, category, retail_price, partner_price, unit, description, image_url, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          product.name,
          product.sku,
          product.category,
          product.retailPrice,
          product.partnerPrice,
          product.unit,
          product.description,
          product.imageUrl,
        ]
      );

      syncedIds.push(result.insertId);
    }

    if (syncedIds.length > 0) {
      const placeholders = syncedIds.map(() => '?').join(', ');
      await conn.execute(
        `UPDATE products
         SET is_active = 0
         WHERE is_deleted = 0
           AND id NOT IN (${placeholders})`,
        syncedIds
      );
    }

    await conn.commit();

    console.log(`Synced ${NOGATU_MLM_LANDING_CATALOG.length} NogatuMLM landing products into NogatuDS.`);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
