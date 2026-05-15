function normalizeRoleSlug(roleSlug) {
  if (roleSlug === 'admin') {
    return 'provincial_stockist';
  }

  return roleSlug;
}

module.exports = normalizeRoleSlug;
