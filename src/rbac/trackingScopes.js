const { ROLES, canonicalRole } = require('./roles');

function buildActiveTrackingScope({ user, orderAlias = 'o' }) {
  const role = canonicalRole(user?.role_slug);

  if (role === ROLES.SUPER_ADMIN) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND ${orderAlias}.partner_id = ?`,
    params: [user.partner_id],
  };
}

module.exports = {
  buildActiveTrackingScope,
};
