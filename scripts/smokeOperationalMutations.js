const assert = require('node:assert/strict');
const pool = require('../src/config/db');

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:5000/api/v1';
const marker = `smoke-${Date.now()}`;

async function login(email, password = '1') {
  const response = await fetch(`${baseURL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await response.json();
  assert.equal(response.status, 200, `Login failed for ${email}: ${json?.message || response.status}`);
  return {
    token: json.data.access_token,
    user: json.data.user,
  };
}

async function requestJson({ method = 'GET', path, token, body }) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return { status: response.status, json };
}

async function getInventoryRow(productId, warehouseId) {
  const [rows] = await pool.execute(
    `SELECT id, product_id, warehouse_id, partner_id, current_stock, reserved_stock, is_active
     FROM inventories
     WHERE product_id = ? AND warehouse_id = ?
     LIMIT 1`,
    [productId, warehouseId]
  );
  return rows[0] || null;
}

async function setInventoryStock(inventoryId, currentStock) {
  await pool.execute(
    'UPDATE inventories SET current_stock = ?, last_movement_at = NOW() WHERE id = ?',
    [currentStock, inventoryId]
  );
}

async function scenarioGrn(provincialToken) {
  const productId = 1;
  const warehouseId = 4;
  const quantity = 2;
  let grnId = null;

  const baseline = await getInventoryRow(productId, warehouseId);
  assert.ok(baseline, 'Expected baseline inventory for GRN smoke');

  try {
    const create = await requestJson({
      method: 'POST',
      path: '/grn',
      token: provincialToken,
      body: {
        warehouse_id: warehouseId,
        supplier: 'Smoke Supplier',
        delivery_reference: marker,
        notes: marker,
        items: [{ product_id: productId, expected_qty: quantity, received_qty: quantity, notes: marker }],
      },
    });
    assert.equal(create.status, 201, `GRN create failed: ${create.json?.message || create.status}`);
    grnId = create.json.data.id;

    const complete = await requestJson({
      method: 'PATCH',
      path: `/grn/${grnId}/complete`,
      token: provincialToken,
    });
    assert.equal(complete.status, 200, `GRN complete failed: ${complete.json?.message || complete.status}`);

    const after = await getInventoryRow(productId, warehouseId);
    assert.equal(after.current_stock, baseline.current_stock + quantity, 'GRN did not increase inventory');

    const [movements] = await pool.execute(
      `SELECT movement_type, quantity
       FROM stock_movements
       WHERE reference_type = 'grn' AND reference_id = ?`,
      [grnId]
    );
    assert.equal(movements.length, 1, 'Expected one GRN stock movement');
    assert.equal(movements[0].movement_type, 'in', 'GRN movement type mismatch');

    return {
      name: 'provincial_grn_complete',
      grnId,
      warehouseId,
      productId,
      quantity,
    };
  } finally {
    if (baseline?.id) {
      await setInventoryStock(baseline.id, baseline.current_stock);
    }
    if (grnId) {
      await pool.execute(`DELETE FROM stock_movements WHERE reference_type = 'grn' AND reference_id = ?`, [grnId]);
      await pool.execute('DELETE FROM grn_items WHERE grn_id = ?', [grnId]);
      await pool.execute('DELETE FROM goods_receipts WHERE id = ?', [grnId]);
    }
  }
}

async function scenarioStockTransfer(superToken) {
  const productId = 1;
  const fromWarehouseId = 2;
  const toWarehouseId = 5;
  const quantity = 2;
  let transferId = null;

  const sourceBaseline = await getInventoryRow(productId, fromWarehouseId);
  const destBaseline = await getInventoryRow(productId, toWarehouseId);
  assert.ok(sourceBaseline && destBaseline, 'Expected baseline inventory for transfer smoke');

  try {
    const create = await requestJson({
      method: 'POST',
      path: '/stock-transfers',
      token: superToken,
      body: {
        from_warehouse_id: fromWarehouseId,
        to_warehouse_id: toWarehouseId,
        notes: marker,
        items: [{ product_id: productId, quantity }],
      },
    });
    assert.equal(create.status, 201, `Transfer create failed: ${create.json?.message || create.status}`);
    transferId = create.json.data.id;

    const complete = await requestJson({
      method: 'PATCH',
      path: `/stock-transfers/${transferId}/complete`,
      token: superToken,
    });
    assert.equal(complete.status, 200, `Transfer complete failed: ${complete.json?.message || complete.status}`);

    const sourceAfter = await getInventoryRow(productId, fromWarehouseId);
    const destAfter = await getInventoryRow(productId, toWarehouseId);
    assert.equal(sourceAfter.current_stock, sourceBaseline.current_stock - quantity, 'Transfer did not decrement source stock');
    assert.equal(destAfter.current_stock, destBaseline.current_stock + quantity, 'Transfer did not increment destination stock');

    const [movements] = await pool.execute(
      `SELECT warehouse_id, movement_type, quantity
       FROM stock_movements
       WHERE reference_type = 'stock_transfer' AND reference_id = ?
       ORDER BY warehouse_id ASC`,
      [transferId]
    );
    assert.equal(movements.length, 2, 'Expected two transfer stock movements');
    assert.deepEqual(
      movements.map((row) => ({ warehouse_id: row.warehouse_id, movement_type: row.movement_type, quantity: row.quantity })),
      [
        { warehouse_id: fromWarehouseId, movement_type: 'transfer_out', quantity },
        { warehouse_id: toWarehouseId, movement_type: 'transfer_in', quantity },
      ],
      'Transfer movement audit mismatch'
    );

    return {
      name: 'super_admin_transfer_complete',
      transferId,
      fromWarehouseId,
      toWarehouseId,
      productId,
      quantity,
    };
  } finally {
    if (sourceBaseline?.id) {
      await setInventoryStock(sourceBaseline.id, sourceBaseline.current_stock);
    }
    if (destBaseline?.id) {
      await setInventoryStock(destBaseline.id, destBaseline.current_stock);
    }
    if (transferId) {
      await pool.execute(`DELETE FROM stock_movements WHERE reference_type = 'stock_transfer' AND reference_id = ?`, [transferId]);
      await pool.execute('DELETE FROM transfer_items WHERE transfer_id = ?', [transferId]);
      await pool.execute('DELETE FROM stock_transfers WHERE id = ?', [transferId]);
    }
  }
}

async function scenarioCycleCount(staffToken, superToken) {
  const productId = 1;
  const warehouseId = 4;
  let cycleCountId = null;

  const baseline = await getInventoryRow(productId, warehouseId);
  assert.ok(baseline, 'Expected baseline inventory for cycle count smoke');

  try {
    const create = await requestJson({
      method: 'POST',
      path: '/cycle-counts',
      token: staffToken,
      body: {
        warehouse_id: warehouseId,
        notes: marker,
      },
    });
    assert.equal(create.status, 201, `Cycle count create failed: ${create.json?.message || create.status}`);
    cycleCountId = create.json.data.id;

    const detail = await requestJson({
      path: `/cycle-counts/${cycleCountId}`,
      token: staffToken,
    });
    assert.equal(detail.status, 200, `Cycle count detail failed: ${detail.json?.message || detail.status}`);
    const item = detail.json.data.items.find((row) => Number(row.product_id) === productId);
    assert.ok(item, 'Expected cycle count item for product 1');

    const update = await requestJson({
      method: 'PATCH',
      path: `/cycle-counts/${cycleCountId}/items`,
      token: staffToken,
      body: {
        items: [{ id: item.id, counted_qty: Number(item.system_qty) - 1, notes: marker }],
      },
    });
    assert.equal(update.status, 200, `Cycle count item update failed: ${update.json?.message || update.status}`);

    const submit = await requestJson({
      method: 'PATCH',
      path: `/cycle-counts/${cycleCountId}/submit`,
      token: staffToken,
    });
    assert.equal(submit.status, 200, `Cycle count submit failed: ${submit.json?.message || submit.status}`);

    const approve = await requestJson({
      method: 'PATCH',
      path: `/cycle-counts/${cycleCountId}/approve`,
      token: superToken,
      body: { review_notes: marker },
    });
    assert.equal(approve.status, 200, `Cycle count approve failed: ${approve.json?.message || approve.status}`);

    const after = await getInventoryRow(productId, warehouseId);
    assert.equal(after.current_stock, baseline.current_stock - 1, 'Cycle count did not adjust inventory');

    const [movements] = await pool.execute(
      `SELECT movement_type, quantity
       FROM stock_movements
       WHERE reference_type = 'cycle_count' AND reference_id = ?`,
      [cycleCountId]
    );
    assert.equal(movements.length, 1, 'Expected one cycle count movement');
    assert.equal(movements[0].movement_type, 'cycle_count_decrease', 'Cycle count movement type mismatch');
    assert.equal(movements[0].quantity, 1, 'Cycle count movement quantity mismatch');

    return {
      name: 'staff_cycle_count_submit_and_super_admin_approve',
      cycleCountId,
      warehouseId,
      productId,
    };
  } finally {
    if (baseline?.id) {
      await setInventoryStock(baseline.id, baseline.current_stock);
    }
    if (cycleCountId) {
      await pool.execute(`DELETE FROM stock_movements WHERE reference_type = 'cycle_count' AND reference_id = ?`, [cycleCountId]);
      await pool.execute('DELETE FROM cycle_count_items WHERE cycle_count_id = ?', [cycleCountId]);
      await pool.execute('DELETE FROM cycle_counts WHERE id = ?', [cycleCountId]);
    }
  }
}

async function scenarioSettlement(superToken) {
  const [[order]] = await pool.execute(
    `SELECT o.id, o.partner_id
     FROM orders o
     LEFT JOIN settlements s ON s.order_id = o.id AND s.is_deleted = 0
     WHERE o.is_deleted = 0 AND s.id IS NULL
     ORDER BY o.id DESC
     LIMIT 1`
  );
  assert.ok(order, 'Expected an order without settlement for settlement smoke');

  let settlementId = null;
  try {
    const create = await requestJson({
      method: 'POST',
      path: '/settlements',
      token: superToken,
      body: {
        order_id: order.id,
        amount: 111.11,
        method: 'manual',
        notes: marker,
      },
    });
    assert.equal(create.status, 201, `Settlement create failed: ${create.json?.message || create.status}`);
    settlementId = create.json.data.id;

    const reconcile = await requestJson({
      method: 'PATCH',
      path: `/settlements/${settlementId}/reconcile`,
      token: superToken,
      body: {
        status: 'reconciled',
        reference_number: marker,
        variance_amount: 0,
        notes: marker,
      },
    });
    assert.equal(reconcile.status, 200, `Settlement reconcile failed: ${reconcile.json?.message || reconcile.status}`);

    const [[settlement]] = await pool.execute(
      `SELECT status, reference_number, reconciled_by
       FROM settlements
       WHERE id = ?`,
      [settlementId]
    );
    assert.equal(settlement.status, 'reconciled', 'Settlement status mismatch');
    assert.equal(settlement.reference_number, marker, 'Settlement reference number mismatch');
    assert.ok(settlement.reconciled_by, 'Settlement reconciled_by missing');

    return {
      name: 'super_admin_settlement_create_and_reconcile',
      settlementId,
      orderId: order.id,
    };
  } finally {
    if (settlementId) {
      await pool.execute('DELETE FROM settlements WHERE id = ?', [settlementId]);
    }
  }
}

async function expectApiStatus({ token, method, path, body, expectedStatus, expectedMessageIncludes }) {
  const response = await requestJson({ method, path, token, body });
  assert.equal(response.status, expectedStatus, `Expected ${expectedStatus} for ${method} ${path} but got ${response.status}`);
  if (expectedMessageIncludes) {
    assert.match(response.json?.message || '', new RegExp(expectedMessageIncludes), `Expected message for ${method} ${path}`);
  }
  return response.json;
}

async function scenarioUserAffiliationMutations(provincialToken, cityToken, superToken) {
  const createdUserIds = [];
  try {
    const provincialStaffEmail = `${marker}-provincial-staff@example.test`;
    const provincialCreate = await requestJson({
      method: 'POST',
      path: '/users',
      token: provincialToken,
      body: {
        name: 'Smoke Provincial Staff',
        email: provincialStaffEmail,
        password: 'Password123!',
        role_slug: 'staff',
        partner_id: 999,
      },
    });
    assert.equal(provincialCreate.status, 201, `Provincial staff create failed: ${provincialCreate.json?.message || provincialCreate.status}`);
    createdUserIds.push(provincialCreate.json.data.id);

    const [[provincialUser]] = await pool.execute(
      `SELECT u.partner_id, r.slug AS role_slug, u.is_deleted
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [provincialCreate.json.data.id]
    );
    assert.equal(provincialUser.partner_id, 2, 'Provincial-created staff partner mismatch');
    assert.equal(provincialUser.role_slug, 'staff', 'Provincial-created user role mismatch');

    const provincialDelete = await requestJson({
      method: 'DELETE',
      path: `/users/${provincialCreate.json.data.id}`,
      token: provincialToken,
    });
    assert.equal(provincialDelete.status, 200, `Provincial staff delete failed: ${provincialDelete.json?.message || provincialDelete.status}`);

    const cityStaffEmail = `${marker}-city-staff@example.test`;
    const cityCreate = await requestJson({
      method: 'POST',
      path: '/users',
      token: cityToken,
      body: {
        name: 'Smoke City Staff',
        email: cityStaffEmail,
        password: 'Password123!',
        role_slug: 'staff',
        partner_id: 999,
      },
    });
    assert.equal(cityCreate.status, 201, `City staff create failed: ${cityCreate.json?.message || cityCreate.status}`);
    createdUserIds.push(cityCreate.json.data.id);

    const [[cityUser]] = await pool.execute(
      `SELECT u.partner_id, r.slug AS role_slug
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [cityCreate.json.data.id]
    );
    assert.equal(cityUser.partner_id, 4, 'City-created staff partner mismatch');
    assert.equal(cityUser.role_slug, 'staff', 'City-created user role mismatch');

    const cityDelete = await requestJson({
      method: 'DELETE',
      path: `/users/${cityCreate.json.data.id}`,
      token: cityToken,
    });
    assert.equal(cityDelete.status, 200, `City staff delete failed: ${cityDelete.json?.message || cityDelete.status}`);

    await expectApiStatus({
      method: 'POST',
      path: '/users',
      token: provincialToken,
      expectedStatus: 403,
      expectedMessageIncludes: 'Stockists can only create staff users',
      body: {
        name: 'Blocked City Role',
        email: `${marker}-blocked-city@example.test`,
        password: 'Password123!',
        role_slug: 'city_stockist',
        partner_id: 2,
      },
    });

    await expectApiStatus({
      method: 'POST',
      path: '/users',
      token: provincialToken,
      expectedStatus: 400,
      expectedMessageIncludes: 'Create Mobile Stockist accounts from the Mobile Stockists module',
      body: {
        name: 'Blocked Mobile Role',
        email: `${marker}-blocked-mobile@example.test`,
        password: 'Password123!',
        role_slug: 'mobile_stockist',
        partner_id: 2,
      },
    });

    await expectApiStatus({
      method: 'POST',
      path: '/users',
      token: superToken,
      expectedStatus: 400,
      expectedMessageIncludes: 'Create Mobile Stockist accounts from the Mobile Stockists module',
      body: {
        name: 'Blocked Admin Mobile',
        email: `${marker}-admin-mobile@example.test`,
        password: 'Password123!',
        role_slug: 'mobile_stockist',
        partner_id: 1,
      },
    });

    await expectApiStatus({
      method: 'POST',
      path: '/users',
      token: superToken,
      expectedStatus: 400,
      expectedMessageIncludes: 'City Stockist users must belong to a city Stockist partner',
      body: {
        name: 'Blocked Wrong Partner',
        email: `${marker}-wrong-partner@example.test`,
        password: 'Password123!',
        role_slug: 'city_stockist',
        partner_id: 2,
      },
    });

    return {
      name: 'role_affiliation_mutations',
      createdUsers: createdUserIds.length,
    };
  } finally {
    if (createdUserIds.length > 0) {
      await pool.execute(
        `DELETE FROM users WHERE id IN (${createdUserIds.map(() => '?').join(', ')})`,
        createdUserIds
      );
    }
  }
}

async function main() {
  const results = [];
  const failures = [];

  const superAdmin = await login('superadmin@nogatu.com');
  const provincial = await login('provincial@nogatu.com');
  const city = await login('city@nogatu.com');
  const staff = await login('staff@nogatu.com');

  const scenarios = [
    () => scenarioGrn(provincial.token),
    () => scenarioStockTransfer(superAdmin.token),
    () => scenarioCycleCount(staff.token, superAdmin.token),
    () => scenarioSettlement(superAdmin.token),
    () => scenarioUserAffiliationMutations(provincial.token, city.token, superAdmin.token),
  ];

  for (const runScenario of scenarios) {
    try {
      results.push(await runScenario());
    } catch (err) {
      failures.push(err.stack || err.message);
    }
  }

  console.log(JSON.stringify({
    baseURL,
    marker,
    summary: {
      scenarios: scenarios.length,
      passed: results.length,
      failed: failures.length,
    },
    results,
    failures,
  }, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode || 0);
  });
