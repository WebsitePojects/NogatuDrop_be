const LEGACY_NOTIFICATION_TYPES = new Set([
  'low_stock',
  'no_stock',
  'stock_replenished',
  'order_placed',
  'order_approved',
  'order_rejected',
  'order_paid',
  'order_delivered',
  'po_generated',
  'system',
]);

const LEGACY_NOTIFICATION_TYPE_FALLBACKS = Object.freeze({
  dta_received: 'system',
  expiry_alert: 'system',
  order_cancelled: 'order_rejected',
  payment_proof_uploaded: 'order_paid',
  payment_verified: 'order_paid',
  rider_dispatched: 'order_approved',
});

function isNotificationTypeSchemaMismatch(err) {
  return Boolean(
    err &&
    (
      err.code === 'WARN_DATA_TRUNCATED' ||
      err.code === 'ER_TRUNCATED_WRONG_VALUE' ||
      String(err.message || '').includes("Data truncated for column 'type'")
    )
  );
}

function normalizeNotificationTypeForLegacySchema(type) {
  if (LEGACY_NOTIFICATION_TYPES.has(type)) {
    return type;
  }

  return LEGACY_NOTIFICATION_TYPE_FALLBACKS[type] || 'system';
}

async function insertNotification(db, {
  userId = null,
  type,
  title,
  message,
  entityType = null,
  entityId = null,
  location = null,
}) {
  const sql = `
    INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, location)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [userId, type, title, message, entityType, entityId, location];

  try {
    const [result] = await db.execute(sql, params);
    return { result, storedType: type, fallbackApplied: false };
  } catch (err) {
    if (!isNotificationTypeSchemaMismatch(err)) {
      throw err;
    }

    const fallbackType = normalizeNotificationTypeForLegacySchema(type);
    if (fallbackType === type) {
      throw err;
    }

    const fallbackParams = [userId, fallbackType, title, message, entityType, entityId, location];
    const [result] = await db.execute(sql, fallbackParams);
    return { result, storedType: fallbackType, fallbackApplied: true };
  }
}

module.exports = {
  insertNotification,
  isNotificationTypeSchemaMismatch,
  normalizeNotificationTypeForLegacySchema,
};
