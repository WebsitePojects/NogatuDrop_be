const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { sendEmail, EMAIL } = require('../services/emailService');
const { insertStockMovement } = require('../utils/stockMovementLogger');

// GET /api/v1/grn
const getGRNs = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const params = [];
  let where = 'WHERE g.is_deleted = 0';

  // Scope by partner
  if (req.user.role_slug !== 'super_admin') {
    where += ' AND w.partner_id = ?';
    params.push(req.user.partner_id);
  }
  if (status) { where += ' AND g.status = ?'; params.push(status); }

  const baseQuery = `
    SELECT g.id, g.grn_number, g.po_id, g.warehouse_id, w.name AS warehouse_name,
           g.received_by, u.name AS received_by_name, g.status, g.notes, g.created_at, g.completed_at
    FROM goods_receipts g
    JOIN warehouses w ON w.id = g.warehouse_id
    LEFT JOIN users u ON u.id = g.received_by
    ${where} ORDER BY g.created_at DESC`;
  const countQuery = `SELECT COUNT(*) AS total FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);

  for (const grn of result.data) {
    const [items] = await pool.execute(
      `SELECT gi.id, gi.product_id, p.name AS product_name, gi.expected_qty, gi.received_qty, gi.notes AS item_notes
       FROM grn_items gi JOIN products p ON p.id = gi.product_id WHERE gi.grn_id = ?`,
      [grn.id]
    );
    grn.items = items;
  }

  res.json({ success: true, ...result });
});

// GET /api/v1/grn/:id
const getGRN = asyncHandler(async (req, res) => {
  const params = [req.params.id];
  let where = 'WHERE g.id = ? AND g.is_deleted = 0';
  if (req.user.role_slug !== 'super_admin') {
    where += ' AND w.partner_id = ?';
    params.push(req.user.partner_id);
  }

  const [rows] = await pool.execute(
    `SELECT g.*, w.name AS warehouse_name, u.name AS received_by_name
     FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id LEFT JOIN users u ON u.id = g.received_by
     ${where} LIMIT 1`,
    params
  );
  if (rows.length === 0) throw ApiError.notFound('GRN not found');

  const grn = rows[0];
  const [items] = await pool.execute(
    `SELECT gi.*, p.name AS product_name
     FROM grn_items gi JOIN products p ON p.id = gi.product_id WHERE gi.grn_id = ?`,
    [grn.id]
  );
  grn.items = items;
  res.json({ success: true, data: grn });
});

// POST /api/v1/grn — create a new GRN (draft)
const createGRN = asyncHandler(async (req, res) => {
  const { warehouse_id, po_id, items, notes } = req.body;
  if (!warehouse_id || !items || items.length === 0) {
    throw ApiError.badRequest('warehouse_id and items are required');
  }

  const grnNumber = await generateOrderNum('GRN', 'goods_receipts', 'grn_number');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO goods_receipts (grn_number, po_id, warehouse_id, received_by, status, notes)
       VALUES (?, ?, ?, ?, 'draft', ?)`,
      [grnNumber, po_id || null, warehouse_id, req.user.id, notes || null]
    );
    const grnId = result.insertId;

    for (const item of items) {
      await conn.execute(
        `INSERT INTO grn_items (grn_id, product_id, expected_qty, received_qty, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [grnId, item.product_id, item.expected_qty || 0, item.received_qty || 0, item.notes || null]
      );
    }

    await conn.commit();
    res.status(201).json({ success: true, message: 'GRN created', data: { id: grnId, grn_number: grnNumber } });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/grn/:id/complete — complete GRN, increment stock
const completeGRN = asyncHandler(async (req, res) => {
  const grnId = req.params.id;

  const [grns] = await pool.execute(
    'SELECT g.*, w.partner_id FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id WHERE g.id = ? AND g.is_deleted = 0 LIMIT 1',
    [grnId]
  );
  if (grns.length === 0) throw ApiError.notFound('GRN not found');
  if (grns[0].status === 'completed') throw ApiError.badRequest('GRN is already completed');

  const grn = grns[0];

  const [items] = await pool.execute(
    'SELECT * FROM grn_items WHERE grn_id = ?',
    [grnId]
  );

  const discrepancies = items.filter(i => i.received_qty !== i.expected_qty);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE goods_receipts SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [grnId]
    );

    // Increment inventory for each received item
    for (const item of items) {
      if (item.received_qty <= 0) continue;

      // Upsert inventory record
      const [invRows] = await conn.execute(
        'SELECT id FROM inventories WHERE product_id = ? AND warehouse_id = ? AND is_deleted = 0',
        [item.product_id, grn.warehouse_id]
      );

      if (invRows.length > 0) {
        await conn.execute(
          `UPDATE inventories SET current_stock = current_stock + ?, last_movement_at = NOW() WHERE id = ?`,
          [item.received_qty, invRows[0].id]
        );
      } else {
        await conn.execute(
          `INSERT INTO inventories (product_id, warehouse_id, current_stock, last_movement_at) VALUES (?, ?, ?, NOW())`,
          [item.product_id, grn.warehouse_id, item.received_qty]
        );
      }

      // Log stock movement
      await insertStockMovement(conn, {
        productId: item.product_id,
        warehouseId: grn.warehouse_id,
        movementType: 'in',
        quantity: item.received_qty,
        referenceType: 'grn',
        referenceId: grnId,
        notes: 'Stock received via GRN',
        createdBy: req.user.id,
      });
    }

    await conn.commit();

    // Alert admins if discrepancies found
    if (discrepancies.length > 0) {
      const [admins] = await pool.execute(
        `SELECT u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active'`
      );
      for (const admin of admins) {
        const tmpl = EMAIL.grnDiscrepancy(
          grns[0].grn_number,
          `${discrepancies.length} product(s)`,
          'expected',
          'received'
        );
        await sendEmail({ to: admin.email, toName: admin.name, ...tmpl });
      }
    }

    res.json({ success: true, message: 'GRN completed. Stock has been updated.' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = { getGRNs, getGRN, createGRN, completeGRN };
