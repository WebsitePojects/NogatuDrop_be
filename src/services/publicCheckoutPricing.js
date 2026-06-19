const PUBLIC_ORDER_SHIPPING_ZONES = {
  metro_manila: 120,
  luzon: 180,
  visayas_mindanao: 250,
};
const PUBLIC_ORDER_SYSTEM_FEE_RATE = 0.12;
// TODO: awaiting data - confirm fixed zone rates for Metro Manila, Luzon, and Visayas/Mindanao.
// TODO: awaiting data - confirm whether shipping should remain zone-based or use a distance-based courier API.
// TODO: awaiting data - voucher/member discount interplay must be finalized before backend total calculation can auto-apply member pricing.

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getPublicOrderPricingTotals(merchandiseSubtotal, options = {}) {
  const {
    shippingZone = 'metro_manila',
    memberDiscountPct = 0,
  } = options;

  const subtotal = roundCurrency(merchandiseSubtotal);
  const discountAmount = subtotal > 0 ? roundCurrency(subtotal * (Number(memberDiscountPct || 0) / 100)) : 0;
  const discountedSubtotal = roundCurrency(subtotal - discountAmount);
  const shippingFee = discountedSubtotal > 0
    ? (PUBLIC_ORDER_SHIPPING_ZONES[shippingZone] ?? PUBLIC_ORDER_SHIPPING_ZONES.metro_manila)
    : 0;
  const systemFee = discountedSubtotal > 0 ? roundCurrency(discountedSubtotal * PUBLIC_ORDER_SYSTEM_FEE_RATE) : 0;
  const totalDue = roundCurrency(discountedSubtotal + shippingFee + systemFee);

  return {
    merchandiseSubtotal: subtotal,
    memberDiscountPct: Number(memberDiscountPct || 0),
    discountAmount,
    discountedSubtotal,
    shippingZone,
    shippingFee,
    systemFee,
    totalDue,
  };
}

module.exports = {
  PUBLIC_ORDER_SHIPPING_ZONES,
  PUBLIC_ORDER_SYSTEM_FEE_RATE,
  getPublicOrderPricingTotals,
};
