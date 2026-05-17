const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { insertStockMovement } = require('../utils/stockMovementLogger');
const { ROLES, canonicalRole } = require('../rbac/roles');

function isSuperAdmin(user) {
  return canonicalRole(user?.role_slug) === ROLES.SUPER_ADMIN;
}

function scopedWarehouseClause(user, alias) {
  if (isSuperAdmin(user)) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND (${alias}.partner_id = ? OR EXISTS (
      SELECT 1 FROM inventories si
      WHERE si.warehouse_id = ${alias}.id
        AND si.partner_id = ?
    ))`,
    params: [user.partner_id, user.partner_id],
  };
}

function scopedTransferClause(user) {
  if (isSuperAdmin(user)) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND (
      fw.partner_id = ? OR tw.partner_id = ?
      OR EXISTS (SELECT 1 FROM inventories sfi WHERE sfi.warehouse_id = fw.id AND sfi.partner_id = ?)
      OR EXISTS (SELECT 1 FROM inventories sti WHERE sti.warehouse_id = tw.id AND sti.partner_id = ?)
    )`,
    params: [user.partner_id, user.partner_id, user.partner_id, user.partner_id],
  };
}

function scopedInventoryMutationClause(user, warehousePartnerId, alias = 'inventories') {
  if (isSuperAdmin(user)) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND COALESCE(${alias}.partner_id, ?) = ?`,
    params: [warehousePartnerId || null, user.partner_id],
  };
}

// GET /api/v1/stock-transfers
const getTransfers = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.query;
  const params = [];
  let where = 'WHERE st.is_deleted = 0';
  const scope = scopedTransferClause(req.user);

  if (status) { where += ' AND st.status = ?'; params.push(status); }
  if (search) {
    where += ' AND (st.transfer_number LIKE ? OR fw.name LIKE ? OR tw.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  where += scope.clause;
  params.push(...scope.params);

  const baseQuery = `
    SELECT st.id, st.transfer_number, st.from_warehouse_id, fw.name AS from_warehouse_name,
           st.to_warehouse_id, tw.name AS to_warehouse_name,
           st.created_by, u.name AS created_by_name,
           st.status, st.notes, st.completed_at, st.created_at
    FROM stock_transfers st
    JOIN warehouses fw ON fw.id = st.from_warehouse_id
    JOIN warehouses tw ON tw.id = st.to_warehouse_id
    JOIN users u ON u.id = st.created_by
    ${where}
    ORDER BY st.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM stock_transfers st
    JOIN warehouses fw ON fw.id = st.from_warehouse_id
    JOIN warehouses tw ON tw.id = st.to_warehouse_id
    JOIN users u ON u.id = st.created_by
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);

  // Attach items
  for (const transfer of result.data) {
    const [items] = await pool.execute(
      `SELECT ti.id, ti.product_id, p.name AS product_name, p.sku, ti.quantity
       FROM transfer_items ti
       JOIN products p ON p.id = ti.product_id
       WHERE ti.transfer_id = ?`,
      [transfer.id]
    );
    transfer.items = items;
  }

  res.json({ success: true, ...result });
});

// GET /api/v1/stock-transfers/:id
const getTransfer = asyncHandler(async (req, res) => {
  const scope = scopedTransferClause(req.user);
  const [rows] = await pool.execute(
    `SELECT st.*, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name,
            u.name AS created_by_name
     FROM stock_transfers st
     JOIN warehouses fw ON fw.id = st.from_warehouse_id
     JOIN warehouses tw ON tw.id = st.to_warehouse_id
     JOIN users u ON u.id = st.created_by
     WHERE st.id = ? AND st.is_deleted = 0${scope.clause} LIMIT 1`,
    [req.params.id, ...scope.params]
  );
  if (rows.length === 0) throw ApiError.notFound('Stock transfer not found');

  const transfer = rows[0];
  const [items] = await pool.execute(
    `SELECT ti.id, ti.product_id, p.name AS product_name, p.sku, ti.quantity
     FROM transfer_items ti JOIN products p ON p.id = ti.product_id
     WHERE ti.transfer_id = ?`,
    [transfer.id]
  );
  transfer.items = items;

  res.json({ success: true, data: transfer });
});

// POST /api/v1/stock-transfers
const createTransfer = asyncHandler(async (req, res) => {
  const { from_warehouse_id, to_warehouse_id, items, notes } = req.body;

  if (!items || items.length === 0) throw ApiError.badRequest('At least one item is required');
  if (from_warehouse_id === to_warehouse_id) throw ApiError.badRequest('Source and destination warehouses must differ');

  // Verify warehouses
  const fromScope = scopedWarehouseClause(req.user, 'w');
  const toScope = scopedWarehouseClause(req.user, 'w');
  const [fw] = await pool.execute(
    `SELECT w.id FROM warehouses w WHERE w.id = ? AND w.is_deleted = 0${fromScope.clause}`,
    [from_warehouse_id, ...fromScope.params]
  );
  const [tw] = await pool.execute(
    `SELECT w.id FROM warehouses w WHERE w.id = ? AND w.is_deleted = 0${toScope.clause}`,
    [to_warehouse_id, ...toScope.params]
  );
  if (fw.length === 0) throw ApiError.notFound('Source warehouse not found');
  if (tw.length === 0) throw ApiError.notFound('Destination warehouse not found');

  const transferNumber = await generateOrderNum('TRF', 'stock_transfers', 'transfer_number');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [stResult] = await conn.execute(
      `INSERT INTO stock_transfers (transfer_number, from_warehouse_id, to_warehouse_id, created_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [transferNumber, from_warehouse_id, to_warehouse_id, req.user.id, notes || null]
    );

    const transferId = stResult.insertId;

    for (const item of items) {
      await conn.execute(
        'INSERT INTO transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)',
        [transferId, item.product_id, item.quantity]
      );
    }

    await conn.commit();

    const [created] = await pool.execute(
      `SELECT st.*, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name
       FROM stock_transfers st
       JOIN warehouses fw ON fw.id = st.from_warehouse_id
       JOIN warehouses tw ON tw.id = st.to_warehouse_id
       WHERE st.id = ?`,
      [transferId]
    );

    res.status(201).json({ success: true, message: 'Stock transfer created', data: created[0] });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/stock-transfers/:id/complete
const completeTransfer = asyncHandler(async (req, res) => {
  const transferId = req.params.id;
  const scope = scopedTransferClause(req.user);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [transfers] = await conn.execute(
      `SELECT st.id, st.status, st.from_warehouse_id, st.to_warehouse_id,
              fw.partner_id AS from_partner_id,
              tw.partner_id AS to_partner_id
       FROM stock_transfers st
       JOIN warehouses fw ON fw.id = st.from_warehouse_id
       JOIN warehouses tw ON tw.id = st.to_warehouse_id
       WHERE st.id = ? AND st.is_deleted = 0${scope.clause}
       LIMIT 1
       FOR UPDATE`,
      [transferId, ...scope.params]
    );
    if (transfers.length === 0) throw ApiError.notFound('Stock transfer not found');
    if (transfers[0].status === 'completed') throw ApiError.badRequest('Transfer already completed');
    if (transfers[0].status === 'cancelled') throw ApiError.badRequest('Transfer is cancelled');

    const transfer = transfers[0];
    const sourceScope = scopedInventoryMutationClause(req.user, transfer.from_partner_id);
    const destScope = scopedInventoryMutationClause(req.user, transfer.to_partner_id);

    const [completed] = await conn.execute(
      `UPDATE stock_transfers
       SET status = 'completed', completed_at = NOW()
       WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
      [transferId]
    );
    if (completed.affectedRows === 0) {
      throw ApiError.badRequest('Transfer is no longer eligible for completion');
    }

    // Get items
    const [items] = await conn.execute(
      'SELECT product_id, quantity FROM transfer_items WHERE transfer_id = ?', [transferId]
    );

    for (const item of items) {
      // Decrement from source warehouse
      const [sourceInv] = await conn.execute(
        `SELECT id, product_id, warehouse_id, current_stock, reserved_stock, reorder_threshold, batch_number, expiry_date, partner_id
         FROM inventories
         WHERE product_id = ? AND warehouse_id = ? AND is_active = 1${sourceScope.clause}
         ORDER BY expiry_date ASC LIMIT 1
         FOR UPDATE`,
        [item.product_id, transfer.from_warehouse_id, ...sourceScope.params]
      );

      if (sourceInv.length === 0) {
        throw ApiError.badRequest(`No inventory found for product ${item.product_id} in source warehouse`);
      }

      const availableStock = Number(sourceInv[0].current_stock || 0) - Number(sourceInv[0].reserved_stock || 0);
      if (availableStock < item.quantity) {
        throw ApiError.badRequest(`Insufficient stock for product ${item.product_id}. Available: ${availableStock}, Requested: ${item.quantity}`);
      }

      await conn.execute(
        'UPDATE inventories SET current_stock = current_stock - ?, last_movement_at = NOW() WHERE id = ?',
        [item.quantity, sourceInv[0].id]
      );
      await insertStockMovement(conn, {
        productId: item.product_id,
        warehouseId: transfer.from_warehouse_id,
        movementType: 'transfer_out',
        quantity: item.quantity,
        referenceType: 'stock_transfer',
        referenceId: transferId,
        notes: `Stock transferred to warehouse ${transfer.to_warehouse_id}`,
        createdBy: req.user.id,
      });

      // Increment at destination warehouse
      const [destInv] = await conn.execute(
        `SELECT id FROM inventories
         WHERE product_id = ? AND warehouse_id = ? AND is_active = 1${destScope.clause}
         LIMIT 1
         FOR UPDATE`,
        [item.product_id, transfer.to_warehouse_id, ...destScope.params]
      );

      if (destInv.length > 0) {
        await conn.execute(
          'UPDATE inventories SET current_stock = current_stock + ?, last_movement_at = NOW() WHERE id = ?',
          [item.quantity, destInv[0].id]
        );
      } else {
        // Create new inventory record at destination
        const srcData = sourceInv[0];
        const [srcFull] = await conn.execute('SELECT * FROM inventories WHERE id = ?', [srcData.id]);
        await conn.execute(
          `INSERT INTO inventories (product_id, warehouse_id, partner_id, current_stock, reorder_threshold, batch_number, expiry_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            item.product_id,
            transfer.to_warehouse_id,
            isSuperAdmin(req.user) ? transfer.to_partner_id || null : req.user.partner_id,
            item.quantity,
           srcFull[0].reorder_threshold, srcFull[0].batch_number, srcFull[0].expiry_date]
        );
      }
      await insertStockMovement(conn, {
        productId: item.product_id,
        warehouseId: transfer.to_warehouse_id,
        movementType: 'transfer_in',
        quantity: item.quantity,
        referenceType: 'stock_transfer',
        referenceId: transferId,
        notes: `Stock received from warehouse ${transfer.from_warehouse_id}`,
        createdBy: req.user.id,
      });
    }

    await conn.commit();
    res.json({ success: true, message: 'Stock transfer completed' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = { getTransfers, getTransfer, createTransfer, completeTransfer };
