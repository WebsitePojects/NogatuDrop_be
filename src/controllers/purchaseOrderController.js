const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');

// GET /api/v1/purchase-orders
const getPurchaseOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.query;
  const params = [];
  let where = 'WHERE po.is_deleted = 0';

  if (status) { where += ' AND po.status = ?'; params.push(status); }
  if (search) {
    where += ' AND (po.po_number LIKE ? OR po.supplier LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const baseQuery = `
    SELECT po.id, po.po_number, po.supplier, po.created_by, u.name AS created_by_name,
           po.status, po.auto_generated, po.total_amount, po.notes, po.created_at, po.updated_at
    FROM purchase_orders po
    JOIN users u ON u.id = po.created_by
    ${where}
    ORDER BY po.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM purchase_orders po
    JOIN users u ON u.id = po.created_by
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);

  // Attach items
  for (const po of result.data) {
    const [items] = await pool.execute(
      `SELECT pi.id, pi.product_id, p.name AS product_name, p.sku,
              pi.supplier, pi.quantity, pi.unit_price, pi.subtotal
       FROM po_items pi
       JOIN products p ON p.id = pi.product_id
       WHERE pi.po_id = ?`,
      [po.id]
    );
    po.items = items;
  }

  res.json({ success: true, ...result });
});

// GET /api/v1/purchase-orders/:id
const getPurchaseOrder = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT po.*, u.name AS created_by_name
     FROM purchase_orders po
     JOIN users u ON u.id = po.created_by
     WHERE po.id = ? AND po.is_deleted = 0 LIMIT 1`,
    [req.params.id]
  );
  if (rows.length === 0) throw ApiError.notFound('Purchase order not found');

  const po = rows[0];
  const [items] = await pool.execute(
    `SELECT pi.id, pi.product_id, p.name AS product_name, p.sku,
            pi.supplier, pi.quantity, pi.unit_price, pi.subtotal
     FROM po_items pi JOIN products p ON p.id = pi.product_id
     WHERE pi.po_id = ?`,
    [po.id]
  );
  po.items = items;

  res.json({ success: true, data: po });
});

// POST /api/v1/purchase-orders
const createPurchaseOrder = asyncHandler(async (req, res) => {
  const { supplier, items, notes } = req.body;

  if (!items || items.length === 0) throw ApiError.badRequest('At least one item is required');

  const poNumber = await generateOrderNum('PO', 'purchase_orders', 'po_number');

  // Calculate total
  let totalAmount = 0;
  for (const item of items) {
    totalAmount += item.quantity * item.unit_price;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [poResult] = await conn.execute(
      `INSERT INTO purchase_orders (po_number, supplier, created_by, total_amount, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [poNumber, supplier || 'Nogatu Manufacturing', req.user.id, totalAmount, notes || null]
    );

    const poId = poResult.insertId;

    for (const item of items) {
      await conn.execute(
        `INSERT INTO po_items (po_id, product_id, supplier, quantity, unit_price)
         VALUES (?, ?, ?, ?, ?)`,
        [poId, item.product_id, item.supplier || supplier || 'Nogatu Manufacturing', item.quantity, item.unit_price]
      );
    }

    await conn.commit();

    const [created] = await pool.execute(
      'SELECT * FROM purchase_orders WHERE id = ?', [poId]
    );

    res.status(201).json({ success: true, message: 'Purchase order created', data: created[0] });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/purchase-orders/:id/approve
const approvePurchaseOrder = asyncHandler(async (req, res) => {
  const poId = req.params.id;

  const [pos] = await pool.execute(
    'SELECT id, status, po_number FROM purchase_orders WHERE id = ? AND is_deleted = 0', [poId]
  );
  if (pos.length === 0) throw ApiError.notFound('Purchase order not found');
  if (pos[0].status !== 'pending') throw ApiError.badRequest('PO can only be approved from pending status');

  await pool.execute('UPDATE purchase_orders SET status = ? WHERE id = ?', ['approved', poId]);

  res.json({ success: true, message: 'Purchase order approved' });
});

// PATCH /api/v1/purchase-orders/:id/reject
const rejectPurchaseOrder = asyncHandler(async (req, res) => {
  const poId = req.params.id;
  const reason = (req.body.reason || '').trim();

  const [pos] = await pool.execute(
    'SELECT id, status FROM purchase_orders WHERE id = ? AND is_deleted = 0',
    [poId]
  );
  if (pos.length === 0) throw ApiError.notFound('Purchase order not found');
  if (pos[0].status !== 'pending') throw ApiError.badRequest('PO can only be rejected from pending status');

  await pool.execute(
    `UPDATE purchase_orders
     SET status = ?, notes = CASE
       WHEN ? = '' THEN notes
       WHEN notes IS NULL OR notes = '' THEN ?
       ELSE CONCAT(notes, '\nRejected: ', ?)
     END
     WHERE id = ?`,
    ['rejected', reason, `Rejected: ${reason}`, reason, poId]
  );

  res.json({ success: true, message: 'Purchase order rejected' });
});

module.exports = {
  getPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
};
