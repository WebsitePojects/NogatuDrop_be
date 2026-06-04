const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const { NOGATU_MLM_LANDING_CATALOG } = require('./catalog/nogatuMlmLandingCatalog');

function toNumber(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function main() {
  const [rows] = await pool.execute(
    `SELECT sku, name, retail_price, partner_price, image_url
     FROM products
     WHERE is_deleted = 0 AND is_active = 1
     ORDER BY sku ASC`
  );

  const bySku = new Map(rows.map((row) => [row.sku, row]));
  const problems = [];

  if (rows.length !== NOGATU_MLM_LANDING_CATALOG.length) {
    problems.push(`Expected ${NOGATU_MLM_LANDING_CATALOG.length} active products but found ${rows.length}.`);
  }

  for (const product of NOGATU_MLM_LANDING_CATALOG) {
    const row = bySku.get(product.sku);
    if (!row) {
      problems.push(`Missing product row for SKU ${product.sku}.`);
      continue;
    }

    if (row.name !== product.name) {
      problems.push(`Name mismatch for ${product.sku}: "${row.name}" != "${product.name}".`);
    }
    if (toNumber(row.retail_price) !== toNumber(product.retailPrice)) {
      problems.push(`Retail price mismatch for ${product.sku}: ${row.retail_price} != ${product.retailPrice}.`);
    }
    if (toNumber(row.partner_price) !== toNumber(product.partnerPrice)) {
      problems.push(`Partner price mismatch for ${product.sku}: ${row.partner_price} != ${product.partnerPrice}.`);
    }
    if (row.image_url !== product.imageUrl) {
      problems.push(`Image path mismatch for ${product.sku}: "${row.image_url}" != "${product.imageUrl}".`);
    }

    const imagePath = path.resolve(__dirname, '../../NogatuDrop_fe/public', `.${product.imageUrl}`);
    if (!fs.existsSync(imagePath)) {
      problems.push(`Missing frontend image asset for ${product.sku}: ${imagePath}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Catalog smoke failed:\n- ${problems.join('\n- ')}`);
  }

  console.log(`Catalog smoke passed for ${NOGATU_MLM_LANDING_CATALOG.length} synced products.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
