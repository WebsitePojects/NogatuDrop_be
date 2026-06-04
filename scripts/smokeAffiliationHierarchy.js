const assert = require('node:assert/strict');
const pool = require('../src/config/db');
const {
  AFFILIATION_HIERARCHY_FIXTURE,
  DEV_HIERARCHY_PASSWORD,
} = require('./affiliationHierarchyFixture');

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:5000/api/v1';
const marker = `hierarchy-smoke-${Date.now()}`;

function getBranch(index) {
  return AFFILIATION_HIERARCHY_FIXTURE[index];
}

async function login(email, password = DEV_HIERARCHY_PASSWORD) {
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
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

async function fetchOrderableProduct(token) {
  const response = await requestJson({
    path: '/products?limit=50',
    token,
  });
  assert.equal(response.status, 200, `Product list failed: ${response.json?.message || response.status}`);

  const items = Array.isArray(response.json?.data) ? response.json.data : response.json?.data?.items || [];
  const product = items.find((item) => item.is_orderable === true);
  assert.ok(product, 'Expected at least one orderable product for hierarchy smoke');
  return product;
}

async function clearCart(token) {
  const response = await requestJson({
    method: 'DELETE',
    path: '/cart',
    token,
  });
  assert.equal(response.status, 200, `Cart clear failed: ${response.json?.message || response.status}`);
}

async function addToCart(token, productId, quantity = 1) {
  const response = await requestJson({
    method: 'POST',
    path: '/cart',
    token,
    body: {
      product_id: productId,
      quantity,
    },
  });
  assert.equal(response.status, 201, `Cart add failed: ${response.json?.message || response.status}`);
}

async function createOrder(token, notes) {
  const response = await requestJson({
    method: 'POST',
    path: '/orders',
    token,
    body: {
      notes,
      payment_method: 'bank_transfer',
    },
  });
  assert.equal(response.status, 201, `Order create failed: ${response.json?.message || response.status}`);
  return response.json.data;
}

async function expectDetailStatus(token, orderId, expectedStatus, label) {
  const response = await requestJson({
    path: `/orders/${orderId}`,
    token,
  });
  assert.equal(response.status, expectedStatus, `${label} expected ${expectedStatus} for order ${orderId} but got ${response.status}`);
  return response.json;
}

async function expectApproveStatus(token, orderId, expectedStatus, label) {
  const response = await requestJson({
    method: 'PATCH',
    path: `/orders/${orderId}/approve`,
    token,
  });
  assert.equal(response.status, expectedStatus, `${label} approve expected ${expectedStatus} for order ${orderId} but got ${response.status}`);
  return response.json;
}

async function rejectOrder(token, orderId, reason) {
  const response = await requestJson({
    method: 'PATCH',
    path: `/orders/${orderId}/reject`,
    token,
    body: { reason },
  });
  assert.equal(response.status, 200, `Order reject failed: ${response.json?.message || response.status}`);
}

async function verifySeededRelationships() {
  const expectedEmails = [];
  for (const branch of AFFILIATION_HIERARCHY_FIXTURE) {
    expectedEmails.push(branch.provincial.email);
    for (const unit of branch.cities) {
      expectedEmails.push(unit.city.email, unit.mobile.email);
    }
  }

  const placeholders = expectedEmails.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT u.email,
            r.slug AS role_slug,
            u.partner_id,
            p.stockist_level,
            p.parent_partner_id,
            ms.partner_id AS mobile_partner_id,
            ms.user_id AS mobile_user_id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN partners p ON p.id = u.partner_id
     LEFT JOIN mobile_stockists ms ON ms.user_id = u.id
     WHERE u.email IN (${placeholders})
       AND u.is_deleted = 0`,
    expectedEmails
  );

  const byEmail = new Map(rows.map((row) => [row.email, row]));
  for (const branch of AFFILIATION_HIERARCHY_FIXTURE) {
    const provincial = byEmail.get(branch.provincial.email);
    assert.ok(provincial, `Missing provincial user ${branch.provincial.email}`);
    assert.equal(provincial.role_slug, 'provincial_stockist');
    assert.equal(provincial.stockist_level, 'provincial_stockist');
    assert.equal(provincial.parent_partner_id, null);

    for (const unit of branch.cities) {
      const city = byEmail.get(unit.city.email);
      const mobile = byEmail.get(unit.mobile.email);

      assert.ok(city, `Missing city user ${unit.city.email}`);
      assert.ok(mobile, `Missing mobile user ${unit.mobile.email}`);
      assert.equal(city.role_slug, 'city_stockist');
      assert.equal(city.stockist_level, 'city_stockist');
      assert.equal(Number(city.parent_partner_id), Number(provincial.partner_id), `City ${unit.city.email} is not affiliated to ${branch.provincial.email}`);

      assert.equal(mobile.role_slug, 'mobile_stockist');
      assert.equal(Number(mobile.partner_id), Number(city.partner_id), `Mobile ${unit.mobile.email} is not affiliated to city ${unit.city.email}`);
      assert.equal(Number(mobile.mobile_partner_id), Number(city.partner_id), `Mobile stockist row for ${unit.mobile.email} is not linked to city partner`);
      assert.ok(Number(mobile.mobile_user_id) > 0, `Mobile stockist row for ${unit.mobile.email} is missing user_id`);
    }
  }
}

async function placeScopedOrder(actor, noteSuffix) {
  const product = await fetchOrderableProduct(actor.token);
  await clearCart(actor.token);
  await addToCart(actor.token, product.id, 1);
  const order = await createOrder(actor.token, `${marker} ${noteSuffix}`);
  const detail = await expectDetailStatus(actor.token, order.id, 200, actor.label);

  return {
    id: Number(order.id),
    orderNumber: order.order_number,
    productId: Number(product.id),
    productName: product.name,
    detail: detail?.data || null,
  };
}

async function cleanupOrders(orderIds) {
  if (orderIds.length === 0) {
    return;
  }

  const placeholders = orderIds.map(() => '?').join(', ');
  await pool.execute(`DELETE FROM notifications WHERE entity_type = 'order' AND entity_id IN (${placeholders})`, orderIds);
  await pool.execute(`DELETE FROM stock_movements WHERE reference_type = 'order' AND reference_id IN (${placeholders})`, orderIds);
  await pool.execute(`DELETE FROM order_items WHERE order_id IN (${placeholders})`, orderIds);
  await pool.execute(`DELETE FROM orders WHERE id IN (${placeholders})`, orderIds);
}

async function purgeSmokeOrders(noteLikePattern) {
  const [orders] = await pool.execute(
    `SELECT id, source_warehouse_id
     FROM orders
     WHERE notes LIKE ?`,
    [noteLikePattern]
  );

  if (orders.length === 0) {
    return 0;
  }

  const orderIds = orders.map((order) => Number(order.id));
  const placeholders = orderIds.map(() => '?').join(', ');
  let items;
  try {
    [items] = await pool.execute(
      `SELECT oi.order_id,
              oi.product_id,
              oi.quantity,
              COALESCE(oi.source_warehouse_id, o.source_warehouse_id) AS warehouse_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );
  } catch (error) {
    if (!(error?.code === 'ER_BAD_FIELD_ERROR' && String(error.message || '').includes("'oi.source_warehouse_id'"))) {
      throw error;
    }

    [items] = await pool.execute(
      `SELECT oi.order_id,
              oi.product_id,
              oi.quantity,
              o.source_warehouse_id AS warehouse_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );
  }

  for (const item of items) {
    if (!item.warehouse_id) {
      continue;
    }

    await pool.execute(
      `UPDATE inventories
       SET reserved_stock = GREATEST(reserved_stock - ?, 0)
       WHERE product_id = ?
         AND warehouse_id = ?`,
      [item.quantity, item.product_id, item.warehouse_id]
    );
  }

  await cleanupOrders(orderIds);
  return orderIds.length;
}

async function main() {
  const branchA = getBranch(0);
  const branchB = getBranch(1);
  const createdOrderIds = [];

  try {
    const purgedBeforeRun = await purgeSmokeOrders('hierarchy-smoke%');
    await verifySeededRelationships();

    const superAdmin = await login('superadmin@nogatu.com', '1');
    const luna = await login(branchA.provincial.email);
    const mateo = await login(branchB.provincial.email);
    const ash = await login(branchA.cities[0].city.email);
    const ray = await login(branchA.cities[1].city.email);
    const john = await login(branchB.cities[0].city.email);
    const bea = await login(branchB.cities[1].city.email);
    const noel = await login(branchA.cities[0].mobile.email);

    const ashCityOrder = await placeScopedOrder({ ...ash, label: 'Ash city' }, 'ash-city-order');
    createdOrderIds.push(ashCityOrder.id);
    assert.equal(ashCityOrder.detail.placed_by_role_slug, 'city_stockist');
    assert.equal(Number(ashCityOrder.detail.partner_id), Number(ash.user.partner_id));
    await expectDetailStatus(luna.token, ashCityOrder.id, 200, 'Luna provincial parent');
    await expectDetailStatus(superAdmin.token, ashCityOrder.id, 200, 'Super admin');
    await expectDetailStatus(mateo.token, ashCityOrder.id, 404, 'Mateo unrelated provincial');
    await expectDetailStatus(ray.token, ashCityOrder.id, 404, 'Ray sibling city');
    await expectDetailStatus(john.token, ashCityOrder.id, 404, 'John unrelated city');
    await expectApproveStatus(ash.token, ashCityOrder.id, 403, 'Ash city self');
    await expectApproveStatus(ray.token, ashCityOrder.id, 403, 'Ray sibling city');
    await expectApproveStatus(mateo.token, ashCityOrder.id, 403, 'Mateo unrelated provincial');
    await rejectOrder(luna.token, ashCityOrder.id, `${marker} parent provincial reject`);

    const noelMobileOrder = await placeScopedOrder({ ...noel, label: 'Noel mobile' }, 'noel-mobile-order');
    createdOrderIds.push(noelMobileOrder.id);
    assert.equal(noelMobileOrder.detail.placed_by_role_slug, 'mobile_stockist');
    await expectDetailStatus(ash.token, noelMobileOrder.id, 200, 'Ash parent city');
    await expectDetailStatus(superAdmin.token, noelMobileOrder.id, 200, 'Super admin mobile order');
    await expectDetailStatus(luna.token, noelMobileOrder.id, 404, 'Luna provincial should not see mobile child order');
    await expectDetailStatus(ray.token, noelMobileOrder.id, 404, 'Ray sibling city should not see mobile child order');
    await expectDetailStatus(mateo.token, noelMobileOrder.id, 404, 'Mateo unrelated provincial should not see mobile child order');
    await expectApproveStatus(luna.token, noelMobileOrder.id, 403, 'Luna provincial approve mobile order');
    await expectApproveStatus(ray.token, noelMobileOrder.id, 403, 'Ray sibling city approve mobile order');
    await expectApproveStatus(mateo.token, noelMobileOrder.id, 403, 'Mateo unrelated provincial approve mobile order');
    await rejectOrder(ash.token, noelMobileOrder.id, `${marker} parent city reject`);

    const johnCityOrder = await placeScopedOrder({ ...john, label: 'John city' }, 'john-city-order');
    createdOrderIds.push(johnCityOrder.id);
    assert.equal(johnCityOrder.detail.placed_by_role_slug, 'city_stockist');
    await expectDetailStatus(mateo.token, johnCityOrder.id, 200, 'Mateo provincial parent');
    await expectDetailStatus(superAdmin.token, johnCityOrder.id, 200, 'Super admin second branch');
    await expectDetailStatus(luna.token, johnCityOrder.id, 404, 'Luna unrelated provincial second branch');
    await expectDetailStatus(bea.token, johnCityOrder.id, 404, 'Bea sibling city second branch');
    await expectApproveStatus(luna.token, johnCityOrder.id, 403, 'Luna unrelated provincial approve second branch');
    await expectApproveStatus(bea.token, johnCityOrder.id, 403, 'Bea sibling city approve second branch');
    await rejectOrder(mateo.token, johnCityOrder.id, `${marker} second branch parent provincial reject`);

    console.log(JSON.stringify({
      baseURL,
      marker,
      summary: {
        purgedBeforeRun,
        relationshipsVerified: true,
        scopedOrdersChecked: 3,
      },
      orders: [
        { id: ashCityOrder.id, order_number: ashCityOrder.orderNumber, owner: branchA.cities[0].city.email },
        { id: noelMobileOrder.id, order_number: noelMobileOrder.orderNumber, owner: branchA.cities[0].mobile.email },
        { id: johnCityOrder.id, order_number: johnCityOrder.orderNumber, owner: branchB.cities[0].city.email },
      ],
    }, null, 2));
  } finally {
    await cleanupOrders(createdOrderIds);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
