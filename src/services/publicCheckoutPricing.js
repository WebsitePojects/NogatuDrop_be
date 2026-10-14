const PUBLIC_ORDER_SHIPPING_FEE = 159;
// Store orders carry no VAT line (management, 2026-10-14): the total is merchandise + shipping. Orders placed
// before then keep the 12% VAT stored in `system_fee`, which reconcilePublicOrderPricing still adds back.
const PUBLIC_ORDER_SYSTEM_FEE = 0;

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getPublicOrderPricingTotals(merchandiseSubtotal, { preDiscountSubtotal = merchandiseSubtotal } = {}) {
  const subtotal = roundCurrency(merchandiseSubtotal);
  const originalSubtotal = Math.max(subtotal, roundCurrency(preDiscountSubtotal));
  const memberDiscountAmount = roundCurrency(originalSubtotal - subtotal);
  const shippingFee = subtotal > 0 ? PUBLIC_ORDER_SHIPPING_FEE : 0;
  const systemFee = PUBLIC_ORDER_SYSTEM_FEE;
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
  getPublicOrderPricingTotals,
  reconcilePublicOrderPricing,
};
