const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

const isSchemaCompatibilityError = (err) => (
  err && (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_DEFAULT_FOR_FIELD')
);

async function insertStockMovement(conn, {
  productId,
  warehouseId,
  movementType,
  quantity,
  referenceType = null,
  referenceId = null,
  notes = null,
  createdBy = null,
}) {
  try {
    const [result] = await conn.execute(
      `INSERT INTO stock_movements
       (inventory_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id, notes, created_by)
       SELECT id, ?, ?, ?, ?, ?, ?, ?, ?
       FROM inventories
       WHERE product_id = ? AND warehouse_id = ?
       LIMIT 1`,
      [
        productId,
        warehouseId,
        movementType,
        quantity,
        referenceType,
        referenceId,
        notes,
        createdBy,
        productId,
        warehouseId,
      ]
    );

    if (result.affectedRows > 0) {
      return true;
    }
  } catch (err) {
    if (!isSchemaCompatibilityError(err)) {
      throw err;
    }
  }

  try {
    await conn.execute(
      `INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity_change, reference_type, reference_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [productId, warehouseId, movementType, quantity, referenceType, referenceId, notes]
    );
    return true;
  } catch (err) {
    if (!isSchemaCompatibilityError(err)) {
      throw err;
    }

    if (!isMissingColumn(err, 'quantity_change')) {
      return false;
    }
  }

  try {
    await conn.execute(
      `INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity, reference_type, reference_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [productId, warehouseId, movementType, quantity, referenceType, referenceId, notes]
    );
    return true;
  } catch (err) {
    if (!isSchemaCompatibilityError(err)) {
      throw err;
    }
    return false;
  }
}

module.exports = { insertStockMovement };
