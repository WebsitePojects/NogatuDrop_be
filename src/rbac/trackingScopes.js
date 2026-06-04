const { buildOrderScopeFromContext } = require('./affiliationScopes');

function buildActiveTrackingScope({ affiliationContext, orderAlias = 'o' }) {
  return buildOrderScopeFromContext(affiliationContext, { orderAlias });
}

module.exports = {
  buildActiveTrackingScope,
};
