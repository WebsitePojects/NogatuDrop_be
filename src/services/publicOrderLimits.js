const ApiError = require('../utils/ApiError');

// Most items one store order may hold, in total, any mix: "10 pcs (any item) max" (Sir Dino, 2026-11-10).
// It also keeps every cart inside the 5 kg shipping table (10 Chocolate Mix, the heaviest, is 4.77 kg).
// It replaced the per-product cap of 100 (audit AUD-01, 2026-10-03), which it is stricter than.
// The storefront mirrors this in NogatuDrop_fe/src/utils/publicOrderLimits.js.
const PUBLIC_ORDER_MAX_ITEMS = 10;
const PUBLIC_ORDER_MAX_QUANTITY_PER_LINE = PUBLIC_ORDER_MAX_ITEMS;

const tooManyItemsMessage = (total) => (
  `An order can hold at most ${PUBLIC_ORDER_MAX_ITEMS} items in total (this one has ${total}). `
  + 'Place a second order for the rest.'
);

/** Refuses a store order whose quantities add up to more than PUBLIC_ORDER_MAX_ITEMS. */
function assertWithinPublicItemLimit(items) {
  const total = (items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  if (total > PUBLIC_ORDER_MAX_ITEMS) throw ApiError.badRequest(tooManyItemsMessage(total));
  return total;
}

module.exports = { PUBLIC_ORDER_MAX_ITEMS, PUBLIC_ORDER_MAX_QUANTITY_PER_LINE, assertWithinPublicItemLimit };
