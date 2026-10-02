// Most boxes of one product a single public order may hold (public shop and influencer links).
// Without a cap one anonymous order could reserve a center's whole stock (audit AUD-01); 100 was
// chosen by management on 2026-10-03. The storefront mirrors this in src/utils/publicOrderLimits.js.
const PUBLIC_ORDER_MAX_QUANTITY_PER_LINE = 100;

module.exports = { PUBLIC_ORDER_MAX_QUANTITY_PER_LINE };
