const PUBLIC_ORDER_SHIPPING_ZONES = {
  metro_manila: 120,
  luzon: 180,
  visayas_mindanao: 250,
};
const PUBLIC_ORDER_VAT_RATE = 0.12;
// TODO: awaiting data - confirm fixed zone rates for Metro Manila, Luzon, and Visayas/Mindanao.
// TODO: awaiting data - confirm whether shipping should remain zone-based or use a distance-based courier API.
// TODO: awaiting data - voucher/member discount interplay must be finalized before backend total calculation can auto-apply member pricing.

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
    vatAmount,
    systemFee: vatAmount,
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
  PUBLIC_ORDER_SHIPPING_ZONES,
  PUBLIC_ORDER_VAT_RATE,
  getPublicOrderPricingTotals,
  reconcilePublicOrderPricing,
};
