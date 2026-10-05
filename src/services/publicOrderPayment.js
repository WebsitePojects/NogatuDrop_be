/**
 * How long a public buyer has to pay before the order is cancelled and its stock released
 * (management decision 2026-10-05: 3 days, only when nothing was paid and no receipt was uploaded).
 * The deadline is stored on the order when it is placed; services/paymentDeadlineCron.js enforces it.
 */
const PUBLIC_ORDER_PAYMENT_WINDOW_HOURS = 72;

function publicPaymentDeadline(now = new Date()) {
  return new Date(now.getTime() + PUBLIC_ORDER_PAYMENT_WINDOW_HOURS * 60 * 60 * 1000);
}

module.exports = { PUBLIC_ORDER_PAYMENT_WINDOW_HOURS, publicPaymentDeadline };
