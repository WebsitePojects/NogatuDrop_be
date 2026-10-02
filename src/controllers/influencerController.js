const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { normalizeProvider } = require('../services/bankAccountResolver');
const { PUBLIC_ORDER_MAX_QUANTITY_PER_LINE } = require('../services/publicOrderLimits');

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw ApiError.badRequest('Invalid influencer link');
  return slug;
}

const prepareInfluencerOrder = asyncHandler(async (req, res, next) => {
  const slug = normalizeSlug(req.params.slug);
  const [links] = await pool.execute(
    `SELECT id, slug, canonical_product_sku
     FROM influencer_links WHERE slug = ? AND enabled = 1 LIMIT 1`,
    [slug]
  );
  if (!links.length || !links[0].canonical_product_sku) {
    throw ApiError.notFound('Influencer checkout link is not configured');
  }
  const [products] = await pool.execute(
    `SELECT id, name, sku, is_active FROM products
     WHERE sku = ? AND is_active = 1 AND is_deleted = 0`,
    [links[0].canonical_product_sku]
  );
  if (products.length !== 1) throw ApiError.serviceUnavailable('Influencer product configuration is unavailable');
  if (req.body.member_username != null && String(req.body.member_username).trim()) {
    throw ApiError.badRequest('Member username is not supported on influencer checkout');
  }
  // One product per link (Berry NAD+ for /kawoodee); the buyer chooses how many, within the public cap.
  const quantity = Array.isArray(req.body.items) && req.body.items.length === 1 ? Number(req.body.items[0].quantity) : NaN;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > PUBLIC_ORDER_MAX_QUANTITY_PER_LINE) {
    throw ApiError.badRequest(`Influencer checkout requires exactly one item with a quantity from 1 to ${PUBLIC_ORDER_MAX_QUANTITY_PER_LINE}`);
  }
  if (Number(req.body.items[0].product_id) !== Number(products[0].id)) {
    throw ApiError.badRequest('Influencer checkout product does not match the configured product');
  }
  req.body = {
    ...req.body,
    member_username: undefined,
    items: [{ product_id: products[0].id, quantity }],
  };
  req.influencerContext = { slug, linkId: links[0].id };
  next();
});

const getPublicPaymentOptions = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT DISTINCT bank_name
     FROM bank_accounts
     WHERE is_active = 1 AND is_deleted = 0 AND bank_name IS NOT NULL`
  );
  const providers = [...new Set(rows.map((row) => normalizeProvider(row.bank_name)).filter(Boolean))];
  res.json({ success: true, data: { payment_method: 'bank_transfer', providers } });
});

const getInfluencerMetadata = asyncHandler(async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const [rows] = await pool.execute(
    `SELECT l.slug, p.id AS product_id, p.name, p.sku, p.retail_price
     FROM influencer_links l JOIN products p ON p.sku = l.canonical_product_sku
     WHERE l.slug = ? AND l.enabled = 1 AND p.is_active = 1 AND p.is_deleted = 0`, [slug],
  );
  if (rows.length !== 1) throw ApiError.notFound('Influencer checkout link is not configured');
  res.json({ success: true, data: { slug: rows[0].slug, product: { id: rows[0].product_id, name: rows[0].name, sku: rows[0].sku, retail_price: rows[0].retail_price } } });
});

module.exports = { normalizeSlug, prepareInfluencerOrder, getPublicPaymentOptions, getInfluencerMetadata };
