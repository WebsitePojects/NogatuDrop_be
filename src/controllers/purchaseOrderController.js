const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { canonicalRole, ROLES } = require('../rbac/roles');
const { resolveAffiliationContext } = require('../rbac/affiliationScopes');
const {
  getPurchaseOrderCreationState,
  getPurchaseOrderSupplier,
  canSubmitPurchaseOrder,
  canAcceptPurchaseOrder,
  buildPurchaseOrderScope,
} = require('../rbac/purchaseOrderScopes');

async function getPurchaseOrderItems(db, poId) {
  const [items] = await db.execute(
    `SELECT pi.id, pi.product_id, p.name AS product_name, p.sku,
            pi.supplier, pi.quantity, pi.unit_price, pi.subtotal
     FROM po_items pi
     JOIN products p ON p.id = pi.product_id
     WHERE pi.po_id = ?`,
    [poId]
  );
  return items;
}

async function getScopedPurchaseOrder(db, context, poId, { lock = false } = {}) {
  const scope = buildPurchaseOrderScope(context, 'po');
  const [rows] = await db.execute(
    `SELECT po.*, requester.business_name AS requester_stockist_name,
            supplier_partner.business_name AS supplier_stockist_name,
            creator.name AS created_by_name
     FROM purchase_orders po
     JOIN users creator ON creator.id = po.created_by
     LEFT JOIN partners requester ON requester.id = po.requester_partner_id
     LEFT JOIN partners supplier_partner ON supplier_partner.id = po.supplier_partner_id
     WHERE po.id = ? AND po.is_deleted = 0${scope.clause}
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [poId, ...scope.params]
  );
  return rows[0] || null;
}

async function findWarehouseForPartner(db, partnerId) {
  if (partnerId == null) {
    const [rows] = await db.execute(
      `SELECT id FROM warehouses
       WHERE partner_id IS NULL AND type = 'manufacturer' AND is_deleted = 0 AND is_active = 1
       ORDER BY id ASC LIMIT 1`
    );
    return rows[0]?.id || null;
  }
  const [rows] = await db.execute(
    `SELECT id FROM warehouses
     WHERE partner_id = ? AND is_deleted = 0 AND is_active = 1
     ORDER BY id ASC LIMIT 1`,
    [partnerId]
  );
  return rows[0]?.id || null;
}

const getPurchaseOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.query;
  const context = await resolveAffiliationContext(pool, req.user);
  const scope = buildPurchaseOrderScope(context, 'po');
  const params = [...scope.params];
  let where = `WHERE po.is_deleted = 0${scope.clause}`;
  if (status) { where += ' AND po.status = ?'; params.push(status); }
  if (search) {
    where += ' AND (po.po_number LIKE ? OR po.supplier LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const baseQuery = `
    SELECT po.id, po.po_number, po.supplier, po.created_by, creator.name AS created_by_name,
           po.requester_partner_id, requester.business_name AS requester_stockist_name,
           po.supplier_partner_id, supplier_partner.business_name AS supplier_stockist_name,
           po.source_warehouse_id, po.destination_warehouse_id,
           po.status, po.auto_generated, po.total_amount, po.notes,
           po.submitted_by, po.submitted_at, po.owner_approved_by, po.owner_approved_at,
           po.accepted_by, po.accepted_at, po.created_at, po.updated_at
    FROM purchase_orders po
    JOIN users creator ON creator.id = po.created_by
    LEFT JOIN partners requester ON requester.id = po.requester_partner_id
    LEFT JOIN partners supplier_partner ON supplier_partner.id = po.supplier_partner_id
    ${where}
    ORDER BY po.created_at DESC`;
  const countQuery = `SELECT COUNT(*) AS total FROM purchase_orders po ${where}`;
  const result = await paginate(baseQuery, countQuery, params, page, limit);
  for (const po of result.data) po.items = await getPurchaseOrderItems(pool, po.id);
  res.json({ success: true, ...result });
});

const getPurchaseOrder = asyncHandler(async (req, res) => {
  const context = await resolveAffiliationContext(pool, req.user);
  const po = await getScopedPurchaseOrder(pool, context, req.params.id);
  if (!po) throw ApiError.notFound('Purchase order not found');
  po.items = await getPurchaseOrderItems(pool, po.id);
  res.json({ success: true, data: po });
});

const createPurchaseOrder = asyncHandler(async (req, res) => {
  const { items, notes } = req.body;
  if (!Array.isArray(items) || items.length === 0) throw ApiError.badRequest('At least one item is required');
  const context = await resolveAffiliationContext(pool, req.user);
  const role = canonicalRole(context.role);
  const status = getPurchaseOrderCreationState(context);
  const supplierScope = getPurchaseOrderSupplier(context);
  const requesterPartnerId = role === ROLES.SUPER_ADMIN ? null : context.partnerId;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sourceWarehouseId = await findWarehouseForPartner(conn, supplierScope.partnerId);
    const destinationWarehouseId = await findWarehouseForPartner(conn, requesterPartnerId);
    if (!sourceWarehouseId || !destinationWarehouseId) {
      throw ApiError.badRequest('Source and destination warehouses must be configured before creating a purchase order');
    }

    let supplierName = 'Nogatu Main Warehouse';
    if (supplierScope.partnerId) {
      const [supplierRows] = await conn.execute(
        'SELECT business_name FROM partners WHERE id = ? AND is_deleted = 0 LIMIT 1',
        [supplierScope.partnerId]
      );
      if (supplierRows.length === 0) throw ApiError.badRequest('Affiliated supplier Stockist is unavailable');
      supplierName = supplierRows[0].business_name;
    }

    let totalAmount = 0;
    const resolvedItems = [];
    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) throw ApiError.badRequest('Quantity must be at least 1');
      const [products] = await conn.execute(
        `SELECT id, partner_price FROM products
         WHERE id = ? AND is_deleted = 0 AND is_active = 1 LIMIT 1`,
        [item.product_id]
      );
      if (products.length === 0) throw ApiError.badRequest(`Product ${item.product_id} not found`);
      const unitPrice = role === ROLES.SUPER_ADMIN && Number.isFinite(Number(item.unit_price))
        ? Number(item.unit_price)
        : Number(products[0].partner_price || 0);
      resolvedItems.push({ productId: products[0].id, quantity, unitPrice });
      totalAmount += quantity * unitPrice;
    }

    const poNumber = await generateOrderNum('PO', 'purchase_orders', 'po_number');
    const [poResult] = await conn.execute(
      `INSERT INTO purchase_orders
       (po_number, supplier, created_by, requester_partner_id, supplier_partner_id,
        source_warehouse_id, destination_warehouse_id, status, total_amount, notes,
        submitted_by, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [poNumber, supplierName, req.user.id, requesterPartnerId, supplierScope.partnerId,
       sourceWarehouseId, destinationWarehouseId, status, totalAmount, notes || null,
       status === 'submitted' ? req.user.id : null, status === 'submitted' ? new Date() : null]
    );
    for (const item of resolvedItems) {
      await conn.execute(
        `INSERT INTO po_items (po_id, product_id, supplier, quantity, unit_price)
         VALUES (?, ?, ?, ?, ?)`,
        [poResult.insertId, item.productId, supplierName, item.quantity, item.unitPrice]
      );
    }
    await conn.commit();
    res.status(201).json({
      success: true,
      message: status === 'awaiting_owner_approval'
        ? 'Purchase order prepared for Stockist owner approval'
        : 'Purchase order submitted to the affiliated supplier',
      data: { id: poResult.insertId, po_number: poNumber, status, total_amount: totalAmount },
    });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
});

const submitPurchaseOrder = asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const context = await resolveAffiliationContext(conn, req.user);
    const po = await getScopedPurchaseOrder(conn, context, req.params.id, { lock: true });
    if (!po) throw ApiError.notFound('Purchase order not found');
    if (!canSubmitPurchaseOrder(context, po)) throw ApiError.forbidden('Only the owning Stockist can submit this staff-prepared PO');
    await conn.execute(
      `UPDATE purchase_orders
       SET status = 'submitted', owner_approved_by = ?, owner_approved_at = NOW(),
           submitted_by = ?, submitted_at = NOW()
       WHERE id = ?`,
      [req.user.id, req.user.id, po.id]
    );
    await conn.commit();
    res.json({ success: true, message: 'Purchase order submitted to the affiliated supplier' });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
});

const approvePurchaseOrder = asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const context = await resolveAffiliationContext(conn, req.user);
    const po = await getScopedPurchaseOrder(conn, context, req.params.id, { lock: true });
    if (!po) throw ApiError.notFound('Purchase order not found');
    if (!canAcceptPurchaseOrder(context, po)) throw ApiError.forbidden('Only the direct supplier can accept this purchase order');
    await conn.execute(
      `UPDATE purchase_orders SET status = 'accepted', accepted_by = ?, accepted_at = NOW() WHERE id = ?`,
      [req.user.id, po.id]
    );
    await conn.commit();
    res.json({ success: true, message: 'Purchase order accepted' });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
});

const rejectPurchaseOrder = asyncHandler(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const context = await resolveAffiliationContext(conn, req.user);
    const po = await getScopedPurchaseOrder(conn, context, req.params.id, { lock: true });
    if (!po) throw ApiError.notFound('Purchase order not found');
    const ownerMayReject = canSubmitPurchaseOrder(context, po);
    const supplierMayReject = canAcceptPurchaseOrder(context, po);
    if (!ownerMayReject && !supplierMayReject) throw ApiError.forbidden('You cannot reject this purchase order');
    const reason = String(req.body.reason || '').trim();
    await conn.execute(
      `UPDATE purchase_orders
       SET status = 'rejected', notes = CONCAT(COALESCE(notes, ''), ?)
       WHERE id = ?`,
      [reason ? `\n[Rejected: ${reason}]` : '\n[Rejected]', po.id]
    );
    await conn.commit();
    res.json({ success: true, message: 'Purchase order rejected' });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
});

module.exports = {
  getPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
};
