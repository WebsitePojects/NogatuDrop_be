const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const env = require('../src/config/env');
const pool = require('../src/config/db');

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:5000/api/v1';

async function getAdminContext() {
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.partner_id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.status = 'active' AND u.is_deleted = 0
     ORDER BY u.id ASC
     LIMIT 1`
  );

  if (rows.length === 0) {
    throw new Error('No active super_admin user found for smoke tests.');
  }

  return rows[0];
}

function buildAdminToken(adminUser) {
  return jwt.sign(
    {
      id: adminUser.id,
      role: 'Super Admin',
      role_slug: 'super_admin',
      partner_id: adminUser.partner_id || null,
      email: adminUser.email,
    },
    env.JWT_SECRET,
    { expiresIn: '30m' }
  );
}

async function ensureTrackingFixture(createdByUserId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orders] = await conn.execute(
      "SELECT id, order_number FROM orders WHERE is_deleted = 0 AND status IN ('approved', 'delivering') ORDER BY id DESC LIMIT 1"
    );
    if (orders.length === 0) {
      throw new Error('No approved or delivering order available for tracking smoke tests.');
    }

    const order = orders[0];

    const [trackRows] = await conn.execute(
      'SELECT id FROM delivery_tracking WHERE order_id = ? LIMIT 1',
      [order.id]
    );

    let trackingId;
    if (trackRows.length === 0) {
      const [created] = await conn.execute(
        "INSERT INTO delivery_tracking (order_id, status) VALUES (?, 'out_for_delivery')",
        [order.id]
      );
      trackingId = created.insertId;
    } else {
      trackingId = trackRows[0].id;
    }

    const token = crypto.randomUUID();
    await conn.execute(
      "INSERT INTO delivery_tokens (order_id, token, expires_at, is_used, created_by) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 48 HOUR), 0, ?)",
      [order.id, token, createdByUserId]
    );

    await conn.commit();

    return {
      orderId: order.id,
      orderNumber: order.order_number,
      trackingId,
      token,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function run() {
  const adminUser = await getAdminContext();
  const token = buildAdminToken(adminUser);
  const api = axios.create({
    baseURL,
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const results = [];

  const check = async (name, fn) => {
    try {
      const response = await fn();
      results.push({ name, ok: true, status: response.status });
      return response;
    } catch (err) {
      results.push({
        name,
        ok: false,
        status: err.response?.status || 0,
        message: err.response?.data?.message || err.message,
      });
      return null;
    }
  };

  const fixture = await ensureTrackingFixture(adminUser.id);

  await check('GET /warehouses', () => api.get('/warehouses', { params: { limit: 50 } }));
  await check('GET /products', () => api.get('/products', { params: { limit: 50 } }));
  await check('GET /orders', () => api.get('/orders', { params: { limit: 20 } }));
  await check('GET /purchase-orders', () => api.get('/purchase-orders', { params: { limit: 20 } }));
  await check('GET /stock-transfers', () => api.get('/stock-transfers', { params: { limit: 20 } }));
  await check('GET /bank-accounts', () => api.get('/bank-accounts', { params: { limit: 20 } }));
  await check('GET /couriers', () => api.get('/couriers', { params: { limit: 20 } }));
  await check('GET /users', () => api.get('/users', { params: { limit: 20 } }));
  await check('GET /partners', () => api.get('/partners', { params: { limit: 20 } }));
  await check('GET /notifications/count', () => api.get('/notifications/count'));
  await check('GET /dashboard/kpis', () => api.get('/dashboard/kpis'));
  await check('GET /grn', () => api.get('/grn', { params: { limit: 20 } }));
  await check('GET /mobile-stockists', () => api.get('/mobile-stockists', { params: { page: 1, limit: 20, search: '' } }));
  await check('GET /reports/movements', () => api.get('/reports/movements', { params: { from: '', to: '' } }));
  await check('GET /stock-movements', () => api.get('/stock-movements', { params: { limit: 20 } }));
  await check('GET /stock-adjustments', () => api.get('/stock-adjustments', { params: { limit: 20 } }));
  await check('GET /reports/revenue', () => api.get('/reports/revenue', { params: { from: '', to: '' } }));
  await check('GET /reports/purchases', () => api.get('/reports/purchases', { params: { from: '', to: '' } }));
  await check('GET /reports/products', () => api.get('/reports/products', { params: { from: '', to: '' } }));
  await check('GET /dashboard/recent-orders', () => api.get('/dashboard/recent-orders'));
  await check('GET /applications', () => api.get('/applications', { params: { limit: 20 } }));
  await check('GET /tracking/:orderId', () => api.get(`/tracking/${fixture.orderId}`));

  const inventoryRes = await check('GET /inventory', () => api.get('/inventory', { params: { limit: 1 } }));
  const inventoryItem = inventoryRes?.data?.data?.[0];

  if (inventoryItem) {
    const createSet = await check('POST /stock-adjustments (set)', () =>
      api.post('/stock-adjustments', {
        inventory_id: inventoryItem.id,
        type: 'set',
        quantity: Number(inventoryItem.current_stock || 0),
        reason: 'Smoke test set adjustment (no stock delta expected)',
      })
    );

    const setAdjustmentId = createSet?.data?.data?.id;
    if (setAdjustmentId) {
      await check('PATCH /stock-adjustments/:id/approve', () =>
        api.patch(`/stock-adjustments/${setAdjustmentId}/approve`)
      );
    }

    const createAdd = await check('POST /stock-adjustments (add)', () =>
      api.post('/stock-adjustments', {
        inventory_id: inventoryItem.id,
        type: 'add',
        quantity: 1,
        reason: 'Smoke test reject path',
      })
    );

    const addAdjustmentId = createAdd?.data?.data?.id;
    if (addAdjustmentId) {
      await check('PATCH /stock-adjustments/:id/reject', () =>
        api.patch(`/stock-adjustments/${addAdjustmentId}/reject`, { reason: 'Smoke test cleanup reject' })
      );
    }
  }

  await check('GET /tracking/public/:orderNumber', () =>
    axios.get(`${baseURL}/tracking/public/${fixture.orderNumber}`, { timeout: 20000 })
  );

  await check('POST /tracking/ping/:token', () =>
    axios.post(
      `${baseURL}/tracking/ping/${fixture.token}`,
      { lat: 14.5995, lng: 120.9842, speed_kmh: 18.2, accuracy_meters: 9.5 },
      { timeout: 20000 }
    )
  );

  await check('GET /tracking/:orderId/pings', () =>
    api.get(`/tracking/${fixture.orderId}/pings`)
  );

  await check('GET /tracking/active', () => api.get('/tracking/active'));
  await check('GET /delivery-tokens/by-order/:orderId', () => api.get(`/delivery-tokens/by-order/${fixture.orderId}`));

  await check('GET /delivery-tokens/deliver/:token', () =>
    axios.get(`${baseURL}/delivery-tokens/deliver/${fixture.token}`, { timeout: 20000 })
  );

  console.log(JSON.stringify({
    baseURL,
    fixture,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    results,
  }, null, 2));

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

run()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode || 0);
  });
