const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { ROLES, canonicalRole } = require('../rbac/roles');

function isSuperAdmin(user) {
  return canonicalRole(user?.role_slug) === ROLES.SUPER_ADMIN;
}

function scopedSettlementWhere(user, alias = 's') {
  if (isSuperAdmin(user)) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return { clause: ` AND ${alias}.partner_id = ?`, params: [user.partner_id] };
}

async function createPendingSettlementForOrder(conn, { orderId, partnerId, amount, method = 'bank_transfer' }) {
  const [existing] = await conn.execute(
    'SELECT id FROM settlements WHERE order_id = ? AND is_deleted = 0 LIMIT 1',
    [orderId]
  );
  if (existing.length > 0) {
    return existing[0].id;
  }

  const settlementNumber = await generateOrderNum('SET', 'settlements', 'settlement_number');
  const [created] = await conn.execute(
    `INSERT INTO settlements (settlement_number, order_id, partner_id, amount, method, status, expected_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
    [settlementNumber, orderId, partnerId, amount, method]
  );
  return created.insertId;
}

const getSettlements = asyncHandler(async (req, res) => {
  const { page, limit, status, method } = req.query;
  const scope = scopedSettlementWhere(req.user, 's');
  const params = [...scope.params];
  let where = `WHERE s.is_deleted = 0${scope.clause}`;

  if (status) {
    where += ' AND s.status = ?';
    params.push(status);
  }
  if (method) {
    where += ' AND s.method = ?';
    params.push(method);
  }

  const baseQuery = `
    SELECT s.id, s.settlement_number, s.order_id, o.order_number,
           s.partner_id, p.business_name AS partner_name,
           s.amount, s.method, s.status, s.expected_at, s.reconciled_at,
           s.reference_number, s.variance_amount, s.notes,
           s.created_at, ru.name AS reconciled_by_name
    FROM settlements s
    JOIN orders o ON o.id = s.order_id
    LEFT JOIN partners p ON p.id = s.partner_id
    LEFT JOIN users ru ON ru.id = s.reconciled_by
    ${where}
    ORDER BY s.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM settlements s
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

const createSettlement = asyncHandler(async (req, res) => {
  const { order_id, amount, method, notes, expected_at } = req.body;
  if (!order_id || amount === undefined) throw ApiError.badRequest('order_id and amount are required');

  const scope = scopedSettlementWhere(req.user, 'o');
  const [orders] = await pool.execute(
    `SELECT o.id, o.partner_id, o.total_amount
     FROM orders o
     WHERE o.id = ? AND o.is_deleted = 0${scope.clause}
     LIMIT 1`,
    [order_id, ...scope.params]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');

  const settlementNumber = await generateOrderNum('SET', 'settlements', 'settlement_number');
  const [created] = await pool.execute(
    `INSERT INTO settlements (settlement_number, order_id, partner_id, amount, method, status, expected_at, notes)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      settlementNumber,
      order_id,
      orders[0].partner_id,
      amount,
      method || 'bank_transfer',
      expected_at || null,
      notes || null,
    ]
  );

  res.status(201).json({
    success: true,
    message: 'Settlement created',
    data: { id: created.insertId, settlement_number: settlementNumber },
  });
});

const reconcileSettlement = asyncHandler(async (req, res) => {
  const { status, reference_number, variance_amount, notes } = req.body;
  if (!['reconciled', 'disputed', 'cancelled'].includes(status)) {
    throw ApiError.badRequest('status must be reconciled, disputed, or cancelled');
  }

  const [updated] = await pool.execute(
    `UPDATE settlements
     SET status = ?, reconciled_at = NOW(), reconciled_by = ?,
         reference_number = ?, variance_amount = ?, notes = COALESCE(?, notes), updated_at = NOW()
     WHERE id = ? AND is_deleted = 0`,
    [status, req.user.id, reference_number || null, variance_amount || 0, notes || null, req.params.id]
  );
  if (updated.affectedRows === 0) throw ApiError.notFound('Settlement not found');

  res.json({ success: true, message: 'Settlement updated' });
});

module.exports = {
  getSettlements,
  createSettlement,
  reconcileSettlement,
  createPendingSettlementForOrder,
};
