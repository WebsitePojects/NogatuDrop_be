// Money arithmetic for an order whose delivery fee can change after the buyer paid (management round 4,
// 2026-10-08). Everything is done in whole centavos so ₱0.10 + ₱0.20 never becomes ₱0.30000000000000004.
//
// orders.payment_covered_total is the order total the buyer's receipts were for. It is NULL until the first
// receipt, and on orders from before this change; NULL means "nothing to compare", never "owes money".

const toCents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (cents) => cents / 100;

/** The order total after replacing its delivery fee. VAT is on merchandise only, so only the fee moves. */
function totalWithShippingFee(order, newShippingFee) {
  return fromCents(toCents(order.total_amount) - toCents(order.shipping_fee) + toCents(newShippingFee));
}

/** Pesos the buyer still has to send because the total went up after their receipt; 0 when nothing is owed. */
function amountStillOwed(order) {
  if (order?.payment_covered_total == null) return 0;
  const owed = toCents(order.total_amount) - toCents(order.payment_covered_total);
  return owed > 0 ? fromCents(owed) : 0;
}

/** Pesos the buyer paid above the current total (the fee went down after they paid); refunded by hand. */
function amountOverpaid(order) {
  if (order?.payment_covered_total == null) return 0;
  const over = toCents(order.payment_covered_total) - toCents(order.total_amount);
  return over > 0 ? fromCents(over) : 0;
}

module.exports = { toCents, totalWithShippingFee, amountStillOwed, amountOverpaid };
