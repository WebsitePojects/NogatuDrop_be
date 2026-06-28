const PUBLIC_ORDER_SHIPPING_FEE = 159;
const PUBLIC_ORDER_SYSTEM_FEE_RATE = 0.12;

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getPublicOrderPricingTotals(merchandiseSubtotal, { preDiscountSubtotal = merchandiseSubtotal } = {}) {
  const subtotal = roundCurrency(merchandiseSubtotal);
  const originalSubtotal = Math.max(subtotal, roundCurrency(preDiscountSubtotal));
  const memberDiscountAmount = roundCurrency(originalSubtotal - subtotal);
  const shippingFee = subtotal > 0 ? PUBLIC_ORDER_SHIPPING_FEE : 0;
  const systemFee = subtotal > 0 ? roundCurrency(subtotal * PUBLIC_ORDER_SYSTEM_FEE_RATE) : 0;
  const totalDue = roundCurrency(subtotal + shippingFee + systemFee);

  return {
    merchandiseSubtotal: subtotal,
    memberDiscountAmount,
    shippingFee,
    systemFee,
    totalDue,
  };
}

function reconcilePublicOrderPricing({
  merchandiseSubtotal,
  memberDiscountAmount = 0,
  shippingFee = 0,
  systemFee = 0,
  totalAmount,
}) {
  const normalized = {
    merchandiseSubtotal: roundCurrency(merchandiseSubtotal),
    memberDiscountAmount: roundCurrency(memberDiscountAmount),
    shippingFee: roundCurrency(shippingFee),
    systemFee: roundCurrency(systemFee),
  };
  const totalDue = roundCurrency(totalAmount);
  const componentTotal = roundCurrency(
    normalized.merchandiseSubtotal + normalized.shippingFee + normalized.systemFee
  );

  return {
    ...normalized,
    adjustmentAmount: roundCurrency(totalDue - componentTotal),
    totalDue,
  };
}

module.exports = {
  PUBLIC_ORDER_SHIPPING_FEE,
  PUBLIC_ORDER_SYSTEM_FEE_RATE,
  getPublicOrderPricingTotals,
  reconcilePublicOrderPricing,
};
