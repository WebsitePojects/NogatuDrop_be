const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { resolveAffiliationContext } = require('../rbac/affiliationScopes');
const {
  resolveMobileInventoryScope,
  calculateMobileInventoryAdjustment,
} = require('../rbac/mobileInventoryScopes');

const getMobileInventory = asyncHandler(async (req, res) => {
  const context = await resolveAffiliationContext(pool, req.user);
  const scope = resolveMobileInventoryScope(context);
  const params = [...scope.params];
  let where = `WHERE ms.is_deleted = 0 AND ms.status = 'active'
               AND p.is_deleted = 0 AND p.is_active = 1${scope.clause}`;
  if (req.query.mobile_stockist_id) {
    where += ' AND ms.id = ?';
    params.push(req.query.mobile_stockist_id);
  }
  const [rows] = await pool.execute(
    `SELECT mi.id AS inventory_id, ms.id AS mobile_stockist_id, ms.name AS mobile_stockist_name,
            ms.partner_id, p.id AS product_id, p.name AS product_name, p.sku, p.image_url,
            COALESCE(mi.current_stock, 0) AS current_stock,
            mi.updated_at
     FROM mobile_stockists ms
     CROSS JOIN products p
     LEFT JOIN mobile_inventories mi
       ON mi.mobile_stockist_id = ms.id AND mi.product_id = p.id
     ${where}
     ORDER BY ms.name ASC, p.name ASC`,
    params
  );
  res.json({ success: true, can_adjust: scope.canAdjust, data: rows });
});

const getMobileInventoryMovements = asyncHandler(async (req, res) => {
  const context = await resolveAffiliationContext(pool, req.user);
  const scope = resolveMobileInventoryScope(context);
  const params = [...scope.params];
  let where = `WHERE ms.is_deleted = 0${scope.clause}`;
  if (req.query.mobile_stockist_id) {
    where += ' AND ms.id = ?';
    params.push(req.query.mobile_stockist_id);
  }
  const [rows] = await pool.execute(
    `SELECT movement.id, movement.mobile_stockist_id, ms.name AS mobile_stockist_name,
            movement.product_id, p.name AS product_name, movement.movement_type,
            movement.quantity, movement.before_stock, movement.after_stock,
            movement.reason, movement.created_by, movement.created_at
     FROM mobile_inventory_movements movement
     JOIN mobile_stockists ms ON ms.id = movement.mobile_stockist_id
     JOIN products p ON p.id = movement.product_id
     ${where}
     ORDER BY movement.created_at DESC
     LIMIT 200`,
    params
  );
  res.json({ success: true, data: rows });
});

const adjustMobileInventory = asyncHandler(async (req, res) => {
  const { direction, quantity, reason } = req.body;
  const productId = Number(req.params.productId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const context = await resolveAffiliationContext(conn, req.user);
    const scope = resolveMobileInventoryScope(context);
    if (!scope.canAdjust) throw ApiError.forbidden('Only the Mobile Stockist can adjust personal inventory');

    const [mobileRows] = await conn.execute(
      `SELECT ms.id
       FROM mobile_stockists ms
       WHERE ms.is_deleted = 0 AND ms.status = 'active'${scope.clause}
       LIMIT 1`,
      scope.params
    );
    if (mobileRows.length === 0) throw ApiError.notFound('Mobile Stockist profile not found');
    const mobileStockistId = mobileRows[0].id;

    const [products] = await conn.execute(
      'SELECT id FROM products WHERE id = ? AND is_deleted = 0 AND is_active = 1 LIMIT 1',
      [productId]
    );
    if (products.length === 0) throw ApiError.notFound('Product not found');

    await conn.execute(
      `INSERT INTO mobile_inventories (mobile_stockist_id, product_id, current_stock)
       VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [mobileStockistId, productId]
    );
    const [inventoryRows] = await conn.execute(
      `SELECT id, current_stock
       FROM mobile_inventories
       WHERE mobile_stockist_id = ? AND product_id = ?
       FOR UPDATE`,
      [mobileStockistId, productId]
    );
    const inventory = inventoryRows[0];
    const adjustment = calculateMobileInventoryAdjustment(inventory.current_stock, direction, quantity);
    await conn.execute(
      'UPDATE mobile_inventories SET current_stock = ? WHERE id = ?',
      [adjustment.afterStock, inventory.id]
    );
    await conn.execute(
      `INSERT INTO mobile_inventory_movements
       (inventory_id, mobile_stockist_id, product_id, movement_type, quantity,
        before_stock, after_stock, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [inventory.id, mobileStockistId, productId, adjustment.movementType, adjustment.quantity,
       adjustment.beforeStock, adjustment.afterStock, String(reason || '').trim() || null, req.user.id]
    );
    await conn.commit();
    res.json({
      success: true,
      message: direction === 'increase' ? 'Personal inventory increased' : 'Direct sale recorded',
      data: {
        inventory_id: inventory.id,
        product_id: productId,
        before_stock: adjustment.beforeStock,
        after_stock: adjustment.afterStock,
      },
    });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
});

module.exports = { getMobileInventory, getMobileInventoryMovements, adjustMobileInventory };
