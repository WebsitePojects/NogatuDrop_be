const { ROLES, canonicalRole } = require('./roles');

async function executePartnerLookup(db, sql, params) {
  try {
    const [rows] = await db.execute(sql, params);
    return rows;
  } catch (err) {
    const isMissingSoftDelete = err?.code === 'ER_BAD_FIELD_ERROR'
      && String(err.message || '').includes("'is_deleted'");
    const isMissingStatus = err?.code === 'ER_BAD_FIELD_ERROR'
      && String(err.message || '').includes("'status'");

    if (!isMissingSoftDelete && !isMissingStatus) {
      throw err;
    }

    const fallbackSql = sql
      .replace(' AND is_deleted = 0', '')
      .replace(" AND status = 'active'", '');
    const [rows] = await db.execute(fallbackSql, params);
    return rows;
  }
}

async function getPartnerRecord(db, partnerId) {
  if (!partnerId) {
    return null;
  }

  const rows = await executePartnerLookup(
    db,
    `SELECT id, stockist_level, parent_partner_id
     FROM partners
     WHERE id = ?
       AND is_deleted = 0
       AND status = 'active'
     LIMIT 1`,
    [partnerId]
  );

  return rows[0] || null;
}

async function getDirectChildCityPartnerIds(db, partnerId) {
  if (!partnerId) {
    return [];
  }

  const rows = await executePartnerLookup(
    db,
    `SELECT id
     FROM partners
     WHERE parent_partner_id = ?
       AND stockist_level = 'city_stockist'
       AND is_deleted = 0
       AND status = 'active'
     ORDER BY id ASC`,
    [partnerId]
  );

  return rows.map((row) => Number(row.id)).filter((value) => Number.isFinite(value) && value > 0);
}

async function resolveAffiliationContext(db, user) {
  const role = canonicalRole(user?.role_slug);
  const partnerId = Number(user?.partner_id || 0) || null;

  if (role === ROLES.SUPER_ADMIN) {
    return {
      role,
      userId: Number(user?.id || 0) || null,
      partnerId: null,
      partnerLevel: null,
      parentPartnerId: null,
      childCityPartnerIds: [],
    };
  }

  if (role === ROLES.MOBILE_STOCKIST) {
    return {
      role,
      userId: Number(user?.id || 0) || null,
      partnerId,
      partnerLevel: ROLES.CITY_STOCKIST,
      parentPartnerId: null,
      childCityPartnerIds: [],
    };
  }

  const partner = await getPartnerRecord(db, partnerId);

  return {
    role,
    userId: Number(user?.id || 0) || null,
    partnerId,
    partnerLevel: partner?.stockist_level || null,
    parentPartnerId: Number(partner?.parent_partner_id || 0) || null,
    childCityPartnerIds: partner?.stockist_level === ROLES.PROVINCIAL_STOCKIST
      ? await getDirectChildCityPartnerIds(db, partner.id)
      : [],
  };
}

function getPlacedByRoleExpression({ orderAlias = 'o', placedByRoleAlias = null } = {}) {
  if (placedByRoleAlias) {
    return `${placedByRoleAlias}.slug`;
  }

  const orderRef = orderAlias ? `${orderAlias}.` : '';
  return `(
    SELECT r.slug
    FROM users placed_by_user
    JOIN roles r ON r.id = placed_by_user.role_id
    WHERE placed_by_user.id = ${orderRef}placed_by
    LIMIT 1
  )`;
}

function buildOrderScopeFromContext(context, {
  orderAlias = 'o',
  placedByRoleAlias = null,
} = {}) {
  const orderRef = orderAlias ? `${orderAlias}.` : '';
  const role = canonicalRole(context?.role);
  const partnerId = Number(context?.partnerId || 0) || null;
  const userId = Number(context?.userId || 0) || null;
  const partnerLevel = canonicalRole(context?.partnerLevel);
  const childCityPartnerIds = Array.isArray(context?.childCityPartnerIds)
    ? context.childCityPartnerIds.filter((value) => Number.isFinite(Number(value)) && Number(value) > 0).map(Number)
    : [];

  if (role === ROLES.SUPER_ADMIN) {
    return { clause: '', params: [] };
  }

  if (role === ROLES.MOBILE_STOCKIST) {
    if (!userId) {
      return { clause: ' AND 1 = 0', params: [] };
    }

    return {
      clause: ` AND ${orderRef}placed_by = ?`,
      params: [userId],
    };
  }

  if (!partnerId) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  if (partnerLevel === ROLES.PROVINCIAL_STOCKIST) {
    if (childCityPartnerIds.length === 0) {
      return {
        clause: ` AND ${orderRef}partner_id = ?`,
        params: [partnerId],
      };
    }

    const childPlaceholders = childCityPartnerIds.map(() => '?').join(', ');
    const placedByRoleExpression = getPlacedByRoleExpression({ orderAlias, placedByRoleAlias });

    return {
      clause: ` AND (
        ${orderRef}partner_id = ?
        OR (
          ${orderRef}partner_id IN (${childPlaceholders})
          AND ${placedByRoleExpression} = ?
        )
      )`,
      params: [partnerId, ...childCityPartnerIds, ROLES.CITY_STOCKIST],
    };
  }

  return {
    clause: ` AND ${orderRef}partner_id = ?`,
    params: [partnerId],
  };
}

function canApproveOrderFromContext(context, order) {
  const role = canonicalRole(context?.role);
  const partnerId = Number(context?.partnerId || 0) || null;
  const partnerLevel = canonicalRole(context?.partnerLevel);
  const childCityPartnerIds = Array.isArray(context?.childCityPartnerIds)
    ? context.childCityPartnerIds.map(Number)
    : [];
  const orderPartnerId = Number(order?.partner_id || 0) || null;
  const placedByRoleSlug = canonicalRole(order?.placed_by_role_slug);

  if (role === ROLES.SUPER_ADMIN) {
    return true;
  }

  if (!partnerId || !orderPartnerId) {
    return false;
  }

  if (partnerLevel === ROLES.CITY_STOCKIST) {
    return orderPartnerId === partnerId && placedByRoleSlug === ROLES.MOBILE_STOCKIST;
  }

  if (partnerLevel === ROLES.PROVINCIAL_STOCKIST) {
    return childCityPartnerIds.includes(orderPartnerId) && placedByRoleSlug === ROLES.CITY_STOCKIST;
  }

  return false;
}

function canVerifyPaymentFromContext(context, order) {
  return canApproveOrderFromContext(context, order);
}

function canManageDeliveryLinkFromContext(context, order) {
  return canApproveOrderFromContext(context, order);
}

module.exports = {
  resolveAffiliationContext,
  buildOrderScopeFromContext,
  canApproveOrderFromContext,
  canVerifyPaymentFromContext,
  canManageDeliveryLinkFromContext,
  __testables: {
    getPlacedByRoleExpression,
  },
};
