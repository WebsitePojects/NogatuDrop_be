const axios = require('axios');

const env = require('../src/config/env');

const configuredBaseURL = process.env.TEST_BASE_URL || `http://127.0.0.1:${env.PORT}/api`;
const apiV1BaseURL = configuredBaseURL.endsWith('/api')
  ? `${configuredBaseURL}/v1`
  : configuredBaseURL;
const platformBaseURL = apiV1BaseURL.endsWith('/api/v1')
  ? apiV1BaseURL.slice(0, -3)
  : configuredBaseURL;
const loginEmail = process.env.READINESS_SMOKE_EMAIL || '';
const loginPassword = process.env.READINESS_SMOKE_PASSWORD || '';
const trackingOrderNumber = process.env.READINESS_TRACK_ORDER_NUMBER || '';

async function run() {
  const results = [];

  const check = async (name, fn) => {
    try {
      const response = await fn();
      results.push({
        name,
        ok: true,
        status: response.status,
        requestId: response.headers['x-request-id'] || null,
      });
      return response;
    } catch (err) {
      results.push({
        name,
        ok: false,
        status: err.response?.status || 0,
        requestId: err.response?.headers?.['x-request-id'] || null,
        message: err.response?.data?.message || err.message,
      });
      return null;
    }
  };

  const skip = (name, message) => {
    results.push({ name, ok: true, skipped: true, status: 0, message });
  };

  const publicApi = axios.create({ baseURL: apiV1BaseURL, timeout: 20000 });
  const platformApi = axios.create({ baseURL: platformBaseURL, timeout: 20000 });

  await check('GET /api/health', () => platformApi.get('/health'));
  await check('GET /api/ready', () => platformApi.get('/ready'));
  await check('GET /api/v1/products/public', () => publicApi.get('/products/public', { params: { limit: 12 } }));

  if (trackingOrderNumber) {
    await check('GET /api/v1/tracking/public/:orderNumber', () =>
      publicApi.get(`/tracking/public/${trackingOrderNumber}`)
    );
  } else {
    skip('GET /api/v1/tracking/public/:orderNumber', 'Set READINESS_TRACK_ORDER_NUMBER to exercise public tracking.');
  }

  if (loginEmail && loginPassword) {
    const loginRes = await check('POST /api/v1/auth/login', () =>
      publicApi.post('/auth/login', { email: loginEmail, password: loginPassword })
    );

    const token =
      loginRes?.data?.data?.token ||
      loginRes?.data?.data?.access_token ||
      loginRes?.data?.token ||
      null;
    if (token) {
      const authApi = axios.create({
        baseURL: apiV1BaseURL,
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      await check('GET /api/v1/auth/me', () => authApi.get('/auth/me'));
      await check('GET /api/v1/dashboard/kpis', () => authApi.get('/dashboard/kpis'));
      await check('GET /api/v1/orders', () => authApi.get('/orders', { params: { limit: 5 } }));
    }
  } else {
    skip('POST /api/v1/auth/login', 'Set READINESS_SMOKE_EMAIL and READINESS_SMOKE_PASSWORD to exercise authenticated smoke checks.');
  }

  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({
    baseURL: configuredBaseURL,
    platformBaseURL,
    apiV1BaseURL,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.ok && !result.skipped).length,
      skipped: results.filter((result) => result.skipped).length,
      failed: failed.length,
    },
    results,
  }, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
