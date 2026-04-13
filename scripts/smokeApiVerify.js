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
    throw new Error('No active super_admin user found for verify smoke tests.');
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

  const skip = (name, message) => {
    results.push({ name, ok: true, skipped: true, status: 0, message });
  };

  await check('GET /warehouses', () => api.get('/warehouses', { params: { limit: 50 } }));
  await check('GET /products', () => api.get('/products', { params: { limit: 50 } }));
  const ordersRes = await check('GET /orders', () => api.get('/orders', { params: { limit: 20 } }));
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
  await check('GET /tracking/active', () => api.get('/tracking/active'));

  const firstOrderNumber = (
    ordersRes?.data?.data?.[0]?.order_number ||
    ordersRes?.data?.data?.items?.[0]?.order_number ||
    null
  );

  if (firstOrderNumber) {
    await check('GET /tracking/public/:orderNumber', () =>
      axios.get(`${baseURL}/tracking/public/${firstOrderNumber}`, { timeout: 20000 })
    );
  } else {
    skip('GET /tracking/public/:orderNumber', 'No order available for public tracking check');
  }

  console.log(JSON.stringify({
    baseURL,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.ok && !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
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
