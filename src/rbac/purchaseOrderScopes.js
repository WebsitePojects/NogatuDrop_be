const ApiError = require('../utils/ApiError');
const { ROLES, canonicalRole } = require('./roles');

function getPurchaseOrderCreationState(context) {
  const role = canonicalRole(context?.role);
  if (role === ROLES.STAFF) return 'awaiting_owner_approval';
  if ([ROLES.CITY_STOCKIST, ROLES.PROVINCIAL_STOCKIST, ROLES.SUPER_ADMIN].includes(role)) {
    return 'submitted';
  }
  throw ApiError.forbidden('This role cannot create purchase orders');
}

function getPurchaseOrderSupplier(context) {
  const level = canonicalRole(context?.partnerLevel);
  if (level === ROLES.CITY_STOCKIST) {
    const parentPartnerId = Number(context?.parentPartnerId || 0) || null;
    if (!parentPartnerId) throw ApiError.badRequest('City Stockist has no affiliated Provincial Stockist');
    return { kind: 'partner', partnerId: parentPartnerId };
  }
  if (level === ROLES.PROVINCIAL_STOCKIST || canonicalRole(context?.role) === ROLES.SUPER_ADMIN) {
    return { kind: 'manufacturer', partnerId: null };
  }
  throw ApiError.badRequest('Purchase-order supplier cannot be resolved from this affiliation');
}

function canSubmitPurchaseOrder(context, po) {
  const role = canonicalRole(context?.role);
  return [ROLES.CITY_STOCKIST, ROLES.PROVINCIAL_STOCKIST].includes(role)
    && po?.status === 'awaiting_owner_approval'
    && Number(po?.requester_partner_id) === Number(context?.partnerId);
}

function canAcceptPurchaseOrder(context, po) {
  if (po?.status !== 'submitted') return false;
  const role = canonicalRole(context?.role);
  if (role === ROLES.SUPER_ADMIN) return po?.supplier_partner_id == null;
  return role === ROLES.PROVINCIAL_STOCKIST
    && Number(po?.supplier_partner_id) === Number(context?.partnerId);
}

function buildPurchaseOrderScope(context, alias = 'po') {
  const role = canonicalRole(context?.role);
  if (role === ROLES.SUPER_ADMIN) return { clause: '', params: [] };
  const partnerId = Number(context?.partnerId || 0) || null;
  if (!partnerId) return { clause: ' AND 1 = 0', params: [] };
  return {
    clause: ` AND (${alias}.requester_partner_id = ? OR ${alias}.supplier_partner_id = ?)`,
    params: [partnerId, partnerId],
  };
}

module.exports = {
  getPurchaseOrderCreationState,
  getPurchaseOrderSupplier,
  canSubmitPurchaseOrder,
  canAcceptPurchaseOrder,
  buildPurchaseOrderScope,
};
