const PUBLIC_ORDER_SHIPPING_FEE = 159;
const PUBLIC_ORDER_SYSTEM_FEE_RATE = 0.12;

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getPublicOrderPricingTotals(merchandiseSubtotal) {
  const subtotal = roundCurrency(merchandiseSubtotal);
  const shippingFee = subtotal > 0 ? PUBLIC_ORDER_SHIPPING_FEE : 0;
  const systemFee = subtotal > 0 ? roundCurrency(subtotal * PUBLIC_ORDER_SYSTEM_FEE_RATE) : 0;
  const totalDue = roundCurrency(subtotal + shippingFee + systemFee);

  return {
    merchandiseSubtotal: subtotal,
    shippingFee,
    systemFee,
    totalDue,
  };
}

module.exports = {
  PUBLIC_ORDER_SHIPPING_FEE,
  PUBLIC_ORDER_SYSTEM_FEE_RATE,
  getPublicOrderPricingTotals,
};
