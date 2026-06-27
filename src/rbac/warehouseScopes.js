const { ROLES, canonicalRole } = require('./roles');

function failClosed(kind = 'warehouses') {
  return { kind, clause: ' AND 1 = 0', params: [] };
}

function buildWarehouseListScope(context, { view = 'owned' } = {}) {
  const role = canonicalRole(context?.role);
  const partnerId = Number(context?.partnerId || 0) || null;
  const partnerLevel = canonicalRole(context?.partnerLevel);
  const childIds = Array.isArray(context?.childCityPartnerIds)
    ? context.childCityPartnerIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : [];

  if (!['owned', 'network'].includes(view)) return failClosed();

  if (role === ROLES.SUPER_ADMIN) {
    if (view === 'owned') {
      return {
        kind: 'warehouses',
        clause: " AND w.partner_id IS NULL AND w.type = 'manufacturer'",
        params: [],
      };
    }
    return {
      kind: 'warehouses',
      clause: ` AND EXISTS (
        SELECT 1 FROM partners scope_partner
        WHERE scope_partner.id = w.partner_id
          AND scope_partner.stockist_level = 'provincial_stockist'
          AND scope_partner.is_deleted = 0
      )`,
      params: [],
    };
  }

  if (!partnerId) return failClosed();

  if (view === 'owned') {
    return { kind: 'warehouses', clause: ' AND w.partner_id = ?', params: [partnerId] };
  }

  if (partnerLevel === ROLES.PROVINCIAL_STOCKIST) {
    if (childIds.length === 0) return failClosed();
    return {
      kind: 'warehouses',
      clause: ` AND w.partner_id IN (${childIds.map(() => '?').join(', ')})`,
      params: childIds,
    };
  }

  if (partnerLevel === ROLES.CITY_STOCKIST) {
    return {
      kind: 'mobile_stockists',
      clause: ' AND ms.partner_id = ?',
      params: [partnerId],
    };
  }

  return failClosed();
}

function canManageWarehouse(context, warehouse) {
  const role = canonicalRole(context?.role);
  if (role === ROLES.SUPER_ADMIN) return true;
  if (![ROLES.PROVINCIAL_STOCKIST, ROLES.CITY_STOCKIST, ROLES.STAFF].includes(role)) return false;
  const partnerId = Number(context?.partnerId || 0) || null;
  return Boolean(partnerId && Number(warehouse?.partner_id) === partnerId);
}

module.exports = { buildWarehouseListScope, canManageWarehouse };
