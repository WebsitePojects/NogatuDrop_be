const { performance } = require('node:perf_hooks');
const axios = require('axios');

const env = require('../src/config/env');
const pool = require('../src/config/db');

const api = axios.create({
  baseURL: process.env.LOAD_BASE_URL || `http://127.0.0.1:${env.PORT}/api/v1`,
  timeout: Number(process.env.LOAD_TIMEOUT_MS || 20000),
});

const scenario = process.env.LOAD_SCENARIO || 'catalog';
const concurrency = Number(process.env.LOAD_CONCURRENCY || 5);
const totalRequests = Number(process.env.LOAD_REQUESTS || 30);
const trackOrderNumber = process.env.LOAD_TRACK_ORDER_NUMBER || '';
const maxP95Ms = Number(process.env.LOAD_MAX_P95_MS || 3000);
const maxErrorRate = Number(process.env.LOAD_MAX_ERROR_RATE || 0.05);

async function ensurePublicProductId() {
  if (process.env.LOAD_PUBLIC_PRODUCT_ID) {
    return Number(process.env.LOAD_PUBLIC_PRODUCT_ID);
  }

  const [sourceRows] = await pool.query(
    `SELECT w.id AS warehouse_id
     FROM partners p
     JOIN warehouses w ON w.partner_id = p.id
     WHERE p.stockist_level IN ('city_stockist', 'provincial_stockist')
       AND p.is_deleted = 0
       AND w.is_deleted = 0
     ORDER BY p.id ASC, w.id ASC
     LIMIT 1`
  );

  const sourceWarehouseId = sourceRows[0]?.warehouse_id;
  if (!sourceWarehouseId) {
    throw new Error('No source warehouse available for public-order load scenario.');
  }

  const [rows] = await pool.query(
    `SELECT p.id
     FROM products p
     JOIN inventories i ON i.product_id = p.id
     WHERE p.is_active = 1
       AND p.is_deleted = 0
       AND i.is_active = 1
       AND i.warehouse_id = ?
       AND (i.current_stock - COALESCE(i.reserved_stock, 0)) > 0
     GROUP BY p.id
     ORDER BY SUM(i.current_stock - COALESCE(i.reserved_stock, 0)) DESC, p.id ASC
     LIMIT 1`,
    [sourceWarehouseId]
  );

  if (!rows[0]?.id) {
    throw new Error('No orderable public product available for the public source warehouse.');
  }

  return rows[0].id;
}

async function performScenario(index, publicProductId) {
  const started = performance.now();

  try {
    if (scenario === 'catalog') {
      await api.get('/products/public', { params: { limit: 20, search: index % 2 === 0 ? '' : 'nogatu' } });
    } else if (scenario === 'tracking') {
      if (!trackOrderNumber) throw new Error('Set LOAD_TRACK_ORDER_NUMBER for tracking scenario.');
      await api.get(`/tracking/public/${trackOrderNumber}`);
    } else if (scenario === 'public-order') {
      if (!publicProductId) throw new Error('Public product id missing for public-order scenario.');
      await api.post('/orders/public', {
        customer_name: `Load Test ${Date.now()}-${index}`,
        customer_phone: `0917${String(100000 + index).padStart(6, '0')}`,
        customer_email: `loadtest${Date.now()}${index}@example.com`,
        customer_address: 'Load Test Address, Manila',
        payment_method: 'bank_transfer',
        items: [{ product_id: publicProductId, quantity: 1 }],
      });
    } else if (scenario === 'mixed') {
      if (trackOrderNumber && index % 3 === 0) {
        await api.get(`/tracking/public/${trackOrderNumber}`);
      } else {
        await api.get('/products/public', { params: { limit: 12 } });
      }
    } else {
      throw new Error(`Unsupported LOAD_SCENARIO: ${scenario}`);
    }

    return {
      ok: true,
      latency_ms: performance.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: performance.now() - started,
      status: err.response?.status || 0,
      message: err.response?.data?.message || err.message,
    };
  }
}

function percentile(latencies, ratio) {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

async function runWorker(workerId, requestCount, publicProductId, bucket) {
  for (let i = 0; i < requestCount; i += 1) {
    bucket.push(await performScenario(workerId * 100000 + i, publicProductId));
  }
}

async function run() {
  const publicProductId =
    scenario === 'public-order' ? await ensurePublicProductId() : null;

  const workerBuckets = Array.from({ length: concurrency }, () => []);
  const requestsPerWorker = Math.floor(totalRequests / concurrency);
  const remainder = totalRequests % concurrency;

  await Promise.all(
    workerBuckets.map((bucket, index) =>
      runWorker(
        index,
        requestsPerWorker + (index < remainder ? 1 : 0),
        publicProductId,
        bucket
      )
    )
  );

  const results = workerBuckets.flat();
  const latencies = results.map((result) => result.latency_ms);
  const failures = results.filter((result) => !result.ok);
  const errorRate = results.length === 0 ? 0 : failures.length / results.length;

  const report = {
    baseURL: api.defaults.baseURL,
    scenario,
    concurrency,
    total_requests: results.length,
    success_count: results.length - failures.length,
    failure_count: failures.length,
    error_rate: Number(errorRate.toFixed(4)),
    latency_ms: {
      min: Number(Math.min(...latencies).toFixed(2)),
      avg: Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2)),
      max: Number(Math.max(...latencies).toFixed(2)),
    },
    thresholds: {
      max_p95_ms: maxP95Ms,
      max_error_rate: maxErrorRate,
    },
    failures: failures.slice(0, 10),
  };

  console.log(JSON.stringify(report, null, 2));

  if (report.latency_ms.p95 > maxP95Ms || errorRate > maxErrorRate) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
}).finally(async () => {
  await pool.end();
});
