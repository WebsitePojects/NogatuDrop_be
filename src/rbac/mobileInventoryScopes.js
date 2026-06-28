const ApiError = require('../utils/ApiError');
const { ROLES, canonicalRole } = require('./roles');

function resolveMobileInventoryScope(context) {
  const role = canonicalRole(context?.role);
  const userId = Number(context?.userId || 0) || null;
  const partnerId = Number(context?.partnerId || 0) || null;
  const partnerLevel = canonicalRole(context?.partnerLevel);
  if (role === ROLES.SUPER_ADMIN) return { clause: '', params: [], canAdjust: false };
  if (role === ROLES.MOBILE_STOCKIST && userId) {
    return { clause: ' AND ms.user_id = ?', params: [userId], canAdjust: true };
  }
  if ([ROLES.CITY_STOCKIST, ROLES.STAFF].includes(role)
      && partnerLevel === ROLES.CITY_STOCKIST && partnerId) {
    return { clause: ' AND ms.partner_id = ?', params: [partnerId], canAdjust: false };
  }
  return { clause: ' AND 1 = 0', params: [], canAdjust: false };
}

function calculateMobileInventoryAdjustment(currentStock, direction, quantity) {
  const beforeStock = Number(currentStock);
  const normalizedQuantity = Number(quantity);
  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
    throw ApiError.badRequest('Quantity must be a positive integer');
  }
  if (!['increase', 'decrease'].includes(direction)) {
    throw ApiError.badRequest('Direction must be increase or decrease');
  }
  const afterStock = direction === 'increase'
    ? beforeStock + normalizedQuantity
    : beforeStock - normalizedQuantity;
  if (afterStock < 0) throw ApiError.badRequest('Mobile inventory cannot go below zero');
  return {
    beforeStock,
    afterStock,
    movementType: direction === 'increase' ? 'manual_increase' : 'manual_decrease',
    quantity: normalizedQuantity,
  };
}

module.exports = { resolveMobileInventoryScope, calculateMobileInventoryAdjustment };
