const env = require('../config/env');
const pool = require('../config/db');
const redis = require('../config/redis');

function isCloudinaryConfigured() {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME &&
      env.CLOUDINARY_API_KEY &&
      env.CLOUDINARY_API_SECRET
  );
}

async function probeDatabase() {
  const startedAt = Date.now();

  try {
    await pool.query('SELECT 1 AS ok');
    return {
      status: 'ok',
      latency_ms: Date.now() - startedAt,
      details: {
        host: env.DB_HOST,
        port: env.DB_PORT,
        database: env.DB_NAME,
        pool_size: env.DB_POOL_SIZE,
      },
    };
  } catch (err) {
    return {
      status: 'fail',
      latency_ms: Date.now() - startedAt,
      message: err.message,
    };
  }
}

async function probeRedis() {
  const startedAt = Date.now();

  if (redis.isInMemory) {
    return {
      status: 'warn',
      latency_ms: 0,
      message: 'Redis is running in in-memory fallback mode.',
    };
  }

  try {
    const pong = typeof redis.ping === 'function' ? await redis.ping() : null;
    return {
      status: pong === 'PONG' ? 'ok' : 'warn',
      latency_ms: Date.now() - startedAt,
      message: pong === 'PONG' ? null : 'Redis ping returned an unexpected response.',
    };
  } catch (err) {
    return {
      status: 'warn',
      latency_ms: Date.now() - startedAt,
      message: err.message,
    };
  }
}

function probeFileStorage() {
  if (isCloudinaryConfigured()) {
    return {
      status: 'ok',
      provider: 'cloudinary',
    };
  }

  return {
    status: env.NODE_ENV === 'production' ? 'fail' : 'warn',
    provider: 'cloudinary',
    message: 'Cloudinary upload is not configured.',
  };
}

function summarizeReadiness(dependencies) {
  const criticalFailures = ['database', 'file_storage'].filter(
    (key) => dependencies[key]?.status === 'fail'
  );
  const warnings = Object.values(dependencies).filter(
    (dep) => dep.status === 'warn'
  ).length;

  if (criticalFailures.length > 0) {
    return {
      status: 'not_ready',
      httpStatus: 503,
      critical_failures: criticalFailures,
      warnings,
    };
  }

  if (warnings > 0) {
    return {
      status: 'degraded',
      httpStatus: 200,
      critical_failures: [],
      warnings,
    };
  }

  return {
    status: 'ready',
    httpStatus: 200,
    critical_failures: [],
    warnings: 0,
  };
}

async function buildReadinessSnapshot({ requestId = null } = {}) {
  const dependencies = {
    database: await probeDatabase(),
    redis: await probeRedis(),
    file_storage: probeFileStorage(),
  };
  const summary = summarizeReadiness(dependencies);

  return {
    success: summary.httpStatus < 500,
    status: summary.status,
    request_id: requestId,
    checked_at: new Date().toISOString(),
    critical_failures: summary.critical_failures,
    warnings: summary.warnings,
    dependencies,
    runtime: {
      node_env: env.NODE_ENV,
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap_used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    },
  };
}

module.exports = {
  buildReadinessSnapshot,
  __testables: {
    isCloudinaryConfigured,
    summarizeReadiness,
  },
};
