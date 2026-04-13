const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { sendEmail, EMAIL } = require('../services/emailService');
const { insertStockMovement } = require('../utils/stockMovementLogger');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

async function getGRNItemsSummary(db, grnId) {
  try {
    const [rows] = await db.execute(
      `SELECT gi.id, gi.product_id, p.name AS product_name,
              gi.expected_qty, gi.received_qty, gi.notes AS item_notes
       FROM grn_items gi
       JOIN products p ON p.id = gi.product_id
       WHERE gi.grn_id = ?`,
      [grnId]
    );
    return rows;
  } catch (err) {
    if (!isMissingColumn(err, 'gi.expected_qty') && !isMissingColumn(err, 'expected_qty')) {
      throw err;
    }

    const [rows] = await db.execute(
      `SELECT gi.id, gi.product_id, p.name AS product_name,
              gi.expected_quantity AS expected_qty,
              gi.received_quantity AS received_qty,
              gi.notes AS item_notes
       FROM grn_items gi
       JOIN products p ON p.id = gi.product_id
       WHERE gi.grn_id = ?`,
      [grnId]
    );
    return rows;
  }
}

async function getGRNItemsDetailed(db, grnId) {
  try {
    const [rows] = await db.execute(
      `SELECT gi.id, gi.grn_id, gi.product_id,
              gi.expected_qty, gi.received_qty,
              gi.batch_number, gi.expiry_date, gi.unit_cost, gi.notes,
              p.name AS product_name
       FROM grn_items gi
       JOIN products p ON p.id = gi.product_id
       WHERE gi.grn_id = ?`,
      [grnId]
    );
    return rows;
  } catch (err) {
    if (!isMissingColumn(err, 'gi.expected_qty') && !isMissingColumn(err, 'expected_qty')) {
      throw err;
    }

    const [rows] = await db.execute(
      `SELECT gi.id, gi.grn_id, gi.product_id,
              gi.expected_quantity AS expected_qty,
              gi.received_quantity AS received_qty,
              gi.batch_number, gi.expiry_date, gi.unit_cost, gi.notes,
              p.name AS product_name
       FROM grn_items gi
       JOIN products p ON p.id = gi.product_id
       WHERE gi.grn_id = ?`,
      [grnId]
    );
    return rows;
  }
}

async function insertGRNItem(db, grnId, item) {
  const expectedQty = item.expected_qty || item.expected_quantity || 0;
  const receivedQty = item.received_qty || item.received_quantity || 0;

  try {
    await db.execute(
      `INSERT INTO grn_items (grn_id, product_id, expected_qty, received_qty, batch_number, expiry_date, unit_cost, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grnId,
        item.product_id,
        expectedQty,
        receivedQty,
        item.batch_number || null,
        item.expiry_date || null,
        item.unit_cost || null,
        item.notes || null,
      ]
    );
  } catch (err) {
    if (!isMissingColumn(err, 'expected_qty')) {
      throw err;
    }

    await db.execute(
      `INSERT INTO grn_items (grn_id, product_id, expected_quantity, received_quantity, batch_number, expiry_date, unit_cost, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grnId,
        item.product_id,
        expectedQty,
        receivedQty,
        item.batch_number || null,
        item.expiry_date || null,
        item.unit_cost || null,
        item.notes || null,
      ]
    );
  }
}

async function findInventoryRow(db, productId, warehouseId) {
  try {
    const [rows] = await db.execute(
      'SELECT id FROM inventories WHERE product_id = ? AND warehouse_id = ? AND is_active = 1 LIMIT 1',
      [productId, warehouseId]
    );
    return rows;
  } catch (err) {
    if (!isMissingColumn(err, 'is_active')) {
      throw err;
    }
  }

  try {
    const [rows] = await db.execute(
      'SELECT id FROM inventories WHERE product_id = ? AND warehouse_id = ? AND is_deleted = 0 LIMIT 1',
      [productId, warehouseId]
    );
    return rows;
  } catch (err) {
    if (!isMissingColumn(err, 'is_deleted')) {
      throw err;
    }
  }

  const [rows] = await db.execute(
    'SELECT id FROM inventories WHERE product_id = ? AND warehouse_id = ? LIMIT 1',
    [productId, warehouseId]
  );
  return rows;
}

// GET /api/v1/grn
const getGRNs = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const buildQueries = (useWarehousePartnerScope = true) => {
    const params = [];
    let where = 'WHERE g.is_deleted = 0';

    // Scope by partner
    if (req.user.role_slug !== 'super_admin') {
      if (useWarehousePartnerScope) {
        where += ' AND w.partner_id = ?';
      } else {
        where += ' AND EXISTS (SELECT 1 FROM inventories i WHERE i.warehouse_id = g.warehouse_id AND i.partner_id = ?)';
      }
      params.push(req.user.partner_id);
    }
    if (status) {
      where += ' AND g.status = ?';
      params.push(status);
    }

    return {
      baseQuery: `
        SELECT g.id, g.grn_number, g.po_id, g.warehouse_id, w.name AS warehouse_name,
               g.received_by, u.name AS received_by_name,
               g.status, g.supplier, g.delivery_reference, g.notes, g.created_at, g.completed_at
        FROM goods_receipts g
        JOIN warehouses w ON w.id = g.warehouse_id
        LEFT JOIN users u ON u.id = g.received_by
        ${where} ORDER BY g.created_at DESC`,
      countQuery: `SELECT COUNT(*) AS total FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id ${where}`,
      params,
    };
  };

  let result;
  const primary = buildQueries(true);
  try {
    result = await paginate(primary.baseQuery, primary.countQuery, primary.params, page, limit);
  } catch (err) {
    if (!(req.user.role_slug !== 'super_admin' && isMissingColumn(err, 'w.partner_id'))) {
      throw err;
    }

    const fallback = buildQueries(false);
    result = await paginate(fallback.baseQuery, fallback.countQuery, fallback.params, page, limit);
  }

  for (const grn of result.data) {
    const items = await getGRNItemsSummary(pool, grn.id);
    grn.items = items;
  }

  res.json({ success: true, ...result });
});

// GET /api/v1/grn/:id
const getGRN = asyncHandler(async (req, res) => {
  const buildQuery = (useWarehousePartnerScope = true) => {
    const params = [req.params.id];
    let where = 'WHERE g.id = ? AND g.is_deleted = 0';

    if (req.user.role_slug !== 'super_admin') {
      if (useWarehousePartnerScope) {
        where += ' AND w.partner_id = ?';
      } else {
        where += ' AND EXISTS (SELECT 1 FROM inventories i WHERE i.warehouse_id = g.warehouse_id AND i.partner_id = ?)';
      }
      params.push(req.user.partner_id);
    }

    return {
      sql: `SELECT g.*, w.name AS warehouse_name, u.name AS received_by_name
            FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id LEFT JOIN users u ON u.id = g.received_by
            ${where} LIMIT 1`,
      params,
    };
  };

  let rows;
  const primary = buildQuery(true);
  try {
    [rows] = await pool.execute(primary.sql, primary.params);
  } catch (err) {
    if (!(req.user.role_slug !== 'super_admin' && isMissingColumn(err, 'w.partner_id'))) {
      throw err;
    }

    const fallback = buildQuery(false);
    [rows] = await pool.execute(fallback.sql, fallback.params);
  }

  if (rows.length === 0) throw ApiError.notFound('GRN not found');

  const grn = rows[0];
  const items = await getGRNItemsDetailed(pool, grn.id);
  grn.items = items;
  res.json({ success: true, data: grn });
});

// POST /api/v1/grn — create a new GRN (draft)
const createGRN = asyncHandler(async (req, res) => {
  const {
    warehouse_id,
    po_id,
    supplier,
    delivery_reference,
    items,
    notes,
  } = req.body;
  if (!warehouse_id || !items || items.length === 0) {
    throw ApiError.badRequest('warehouse_id and items are required');
  }

  const grnNumber = await generateOrderNum('GRN', 'goods_receipts', 'grn_number');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO goods_receipts (grn_number, po_id, warehouse_id, received_by, status, supplier, delivery_reference, notes)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [grnNumber, po_id || null, warehouse_id, req.user.id, supplier || null, delivery_reference || null, notes || null]
    );
    const grnId = result.insertId;

    for (const item of items) {
      await insertGRNItem(conn, grnId, item);
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
    'SELECT g.* FROM goods_receipts g WHERE g.id = ? AND g.is_deleted = 0 LIMIT 1',
    [grnId]
  );
  if (grns.length === 0) throw ApiError.notFound('GRN not found');
  if (grns[0].status === 'completed') throw ApiError.badRequest('GRN is already completed');

  const grn = grns[0];

  const items = await getGRNItemsDetailed(pool, grnId);

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
      const invRows = await findInventoryRow(conn, item.product_id, grn.warehouse_id);

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
