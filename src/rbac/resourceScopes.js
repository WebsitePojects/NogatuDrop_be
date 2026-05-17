const { ROLES, canonicalRole } = require('./roles');

function appendPartnerScope({ where, params, user, expression, condition }) {
  const role = canonicalRole(user?.role_slug);

  if (role === ROLES.SUPER_ADMIN) {
    return where;
  }

  if (!user?.partner_id) {
    return `${where} AND 1 = 0`;
  }

  params.push(user.partner_id);
  return `${where} AND ${condition || `${expression} = ?`}`;
}

module.exports = {
  appendPartnerScope,
};
