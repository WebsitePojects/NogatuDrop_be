const fs = require('node:fs/promises');
const path = require('node:path');
const axios = require('axios');

const env = require('../src/config/env');
const pool = require('../src/config/db');

const configuredBaseURL = process.env.TEST_BASE_URL || `http://127.0.0.1:${env.PORT}/api`;
const readinessBaseURL = configuredBaseURL.endsWith('/api/v1')
  ? configuredBaseURL.slice(0, -3)
  : configuredBaseURL;

async function loadBaseline() {
  const baselinePath =
    process.env.BASELINE_FILE ||
    path.resolve(process.cwd(), 'operational-baseline.json');
  const raw = await fs.readFile(baselinePath, 'utf8');
  return {
    baselinePath,
    snapshot: JSON.parse(raw),
  };
}

async function getCurrentCounts() {
  const tables = Object.keys((await loadBaseline()).snapshot.counts);
  const counts = {};

  for (const table of tables) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    counts[table] = Number(rows[0]?.total || 0);
  }

  return counts;
}

async function run() {
  const { baselinePath, snapshot } = await loadBaseline();
  const currentCounts = await getCurrentCounts();
  const mismatches = [];

  for (const [table, expectedCount] of Object.entries(snapshot.counts)) {
    const actualCount = currentCounts[table];
    if (actualCount !== expectedCount) {
      mismatches.push({ table, expected: expectedCount, actual: actualCount });
    }
  }

  const http = axios.create({ baseURL: readinessBaseURL, timeout: 20000 });
  const healthRes = await http.get('/health');
  const readyRes = await http.get('/ready');

  const report = {
    baselinePath,
    checked_at: new Date().toISOString(),
    health_status: healthRes.status,
    readiness_status: readyRes.status,
    readiness_body: readyRes.data,
    counts: {
      expected: snapshot.counts,
      actual: currentCounts,
    },
    mismatches,
  };

  console.log(JSON.stringify(report, null, 2));

  if (mismatches.length > 0 || readyRes.status >= 500) {
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
