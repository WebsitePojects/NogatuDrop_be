const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const env = require('../src/config/env');

function getLocalDateStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getObjectValue(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  return obj[key] ?? obj[String(key).toLowerCase()] ?? obj[String(key).toUpperCase()];
}

function bytesToMiB(bytes) {
  if (!Number.isFinite(bytes)) return null;
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function buildDefaultOutputDir() {
  const stamp = getLocalDateStamp();
  const [year, month] = stamp.split('-');
  const repoRoot = path.resolve(__dirname, '..', '..');
  return path.join(
    repoRoot,
    'docs',
    'repository',
    'audits',
    'database',
    year,
    month,
    `${stamp}-local-db-readiness-artifacts`
  );
}

async function fetchTableNames() {
  const [rows] = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
  `);
  return rows.map((row) => row.table_name);
}

async function fetchCreateStatements(tableNames) {
  const statements = [];

  for (const tableName of tableNames) {
    const [rows] = await pool.query(`SHOW CREATE TABLE ${escapeIdentifier(tableName)}`);
    const createRow = rows[0];
    statements.push({
      tableName,
      sql: createRow['Create Table'],
    });
  }

  return statements;
}

async function fetchServerVariables() {
  const [rows] = await pool.query(`
    SELECT variable_name, variable_value
    FROM information_schema.global_variables
    WHERE variable_name IN (
      'version',
      'version_comment',
      'character_set_server',
      'collation_server',
      'innodb_buffer_pool_size',
      'innodb_log_file_size',
      'innodb_flush_log_at_trx_commit',
      'innodb_file_per_table',
      'max_connections',
      'table_open_cache',
      'slow_query_log',
      'long_query_time',
      'log_bin',
      'binlog_format',
      'sync_binlog'
    )
    ORDER BY variable_name ASC
  `);

  return rows.reduce((acc, row) => {
    acc[row.variable_name] = row.variable_value;
    return acc;
  }, {});
}

async function fetchServerStatus() {
  const [rows] = await pool.query(`
    SELECT variable_name, variable_value
    FROM information_schema.global_status
    WHERE variable_name IN (
      'Threads_connected',
      'Threads_running',
      'Uptime',
      'Questions',
      'Slow_queries',
      'Innodb_buffer_pool_reads',
      'Innodb_buffer_pool_read_requests'
    )
    ORDER BY variable_name ASC
  `);

  return rows.reduce((acc, row) => {
    acc[row.variable_name] = row.variable_value;
    return acc;
  }, {});
}

async function fetchTableMetrics(tableNames) {
  const [tableInfoRows] = await pool.query(`
    SELECT table_name, engine, table_rows, data_length, index_length, create_time, update_time
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
  `);

  const exactCounts = {};
  for (const tableName of tableNames) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS exact_row_count FROM ${escapeIdentifier(tableName)}`);
    exactCounts[tableName] = toNumber(rows[0].exact_row_count) || 0;
  }

  return tableInfoRows.map((row) => ({
    table_name: row.table_name,
    engine: row.engine,
    estimated_rows: toNumber(row.table_rows),
    exact_row_count: exactCounts[row.table_name] || 0,
    data_length_bytes: toNumber(row.data_length) || 0,
    index_length_bytes: toNumber(row.index_length) || 0,
    total_size_bytes: (toNumber(row.data_length) || 0) + (toNumber(row.index_length) || 0),
    create_time: row.create_time,
    update_time: row.update_time,
  }));
}

async function fetchIndexMetrics() {
  const [rows] = await pool.query(`
    SELECT
      table_name,
      index_name,
      non_unique,
      seq_in_index,
      column_name
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
    ORDER BY table_name ASC, index_name ASC, seq_in_index ASC
  `);

  const grouped = new Map();

  for (const row of rows) {
    const key = `${row.table_name}::${row.index_name}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        table_name: row.table_name,
        index_name: row.index_name,
        non_unique: row.non_unique,
        columns: [],
      });
    }
    grouped.get(key).columns.push(row.column_name);
  }

  const indexes = Array.from(grouped.values()).map((entry) => ({
    ...entry,
    column_signature: entry.columns.join(','),
  }));

  const signatureCounts = new Map();
  for (const index of indexes) {
    const key = `${index.table_name}::${index.non_unique}::${index.column_signature}`;
    signatureCounts.set(key, (signatureCounts.get(key) || 0) + 1);
  }

  return indexes.map((index) => ({
    ...index,
    duplicate_signature_count: signatureCounts.get(`${index.table_name}::${index.non_unique}::${index.column_signature}`) || 1,
  }));
}

async function fetchForeignKeyMetrics() {
  const [rows] = await pool.query(`
    SELECT
      kcu.constraint_name,
      kcu.table_name,
      kcu.column_name,
      kcu.ordinal_position,
      kcu.referenced_table_name,
      kcu.referenced_column_name
    FROM information_schema.key_column_usage kcu
    WHERE kcu.table_schema = DATABASE()
      AND kcu.referenced_table_name IS NOT NULL
    ORDER BY
      kcu.table_name ASC,
      kcu.constraint_name ASC,
      kcu.ordinal_position ASC
  `);

  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.table_name}::${row.constraint_name}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        constraint_name: row.constraint_name,
        child_table: row.table_name,
        parent_table: row.referenced_table_name,
        column_pairs: [],
      });
    }
    grouped.get(key).column_pairs.push({
      child_column: row.column_name,
      parent_column: row.referenced_column_name,
    });
  }

  return Array.from(grouped.values());
}

async function fetchPrimaryKeyCoverage() {
  const [rows] = await pool.query(`
    SELECT
      t.table_name,
      SUM(CASE WHEN c.column_key = 'PRI' THEN 1 ELSE 0 END) AS primary_key_columns
    FROM information_schema.tables t
    LEFT JOIN information_schema.columns c
      ON c.table_schema = t.table_schema
     AND c.table_name = t.table_name
    WHERE t.table_schema = DATABASE()
      AND t.table_type = 'BASE TABLE'
    GROUP BY t.table_name
    ORDER BY t.table_name ASC
  `);

  return rows.map((row) => ({
    table_name: row.table_name,
    primary_key_columns: toNumber(row.primary_key_columns) || 0,
  }));
}

async function runOrphanChecks(foreignKeys) {
  const results = [];

  for (const fk of foreignKeys) {
    const childAlias = 'c';
    const parentAlias = 'p';
    const joinPredicate = fk.column_pairs
      .map(
        (pair) =>
          `${childAlias}.${escapeIdentifier(pair.child_column)} = ${parentAlias}.${escapeIdentifier(pair.parent_column)}`
      )
      .join(' AND ');
    const childNotNullPredicate = fk.column_pairs
      .map((pair) => `${childAlias}.${escapeIdentifier(pair.child_column)} IS NOT NULL`)
      .join(' AND ');
    const parentNullColumn = fk.column_pairs[0].parent_column;
    const sql = `
      SELECT COUNT(*) AS orphan_count
      FROM ${escapeIdentifier(fk.child_table)} ${childAlias}
      LEFT JOIN ${escapeIdentifier(fk.parent_table)} ${parentAlias}
        ON ${joinPredicate}
      WHERE ${childNotNullPredicate}
        AND ${parentAlias}.${escapeIdentifier(parentNullColumn)} IS NULL
    `;
    const [rows] = await pool.query(sql);
    results.push({
      constraint_name: fk.constraint_name,
      child_table: fk.child_table,
      parent_table: fk.parent_table,
      orphan_count: toNumber(rows[0].orphan_count) || 0,
      columns: fk.column_pairs,
    });
  }

  return results;
}

function buildSummary({ serverVariables, serverStatus, tableMetrics, indexMetrics, foreignKeys, orphanChecks, primaryKeyCoverage }) {
  const totalSizeBytes = tableMetrics.reduce((sum, table) => sum + table.total_size_bytes, 0);
  const totalExactRows = tableMetrics.reduce((sum, table) => sum + table.exact_row_count, 0);
  const bufferPoolSizeBytes = toNumber(getObjectValue(serverVariables, 'innodb_buffer_pool_size')) || 0;
  const bufferPoolReads = toNumber(getObjectValue(serverStatus, 'INNODB_BUFFER_POOL_READS')) || 0;
  const bufferPoolReadRequests = toNumber(getObjectValue(serverStatus, 'INNODB_BUFFER_POOL_READ_REQUESTS')) || 0;
  const bufferPoolHitRatio =
    bufferPoolReadRequests > 0 ? Number((((bufferPoolReadRequests - bufferPoolReads) / bufferPoolReadRequests) * 100).toFixed(2)) : null;

  const duplicateIndexes = indexMetrics.filter((index) => index.duplicate_signature_count > 1);
  const tablesWithoutPrimaryKeys = primaryKeyCoverage.filter((table) => table.primary_key_columns === 0).map((table) => table.table_name);
  const orphanedConstraints = orphanChecks.filter((check) => check.orphan_count > 0);
  const zeroRowTables = tableMetrics.filter((table) => table.exact_row_count === 0).map((table) => table.table_name);

  return {
    snapshot: {
      database: env.DB_NAME,
      host: env.DB_HOST,
      port: env.DB_PORT,
      generated_at: new Date().toISOString(),
    },
    server: {
      version: getObjectValue(serverVariables, 'version') || null,
      version_comment: getObjectValue(serverVariables, 'version_comment') || null,
      character_set_server: getObjectValue(serverVariables, 'character_set_server') || null,
      collation_server: getObjectValue(serverVariables, 'collation_server') || null,
      max_connections: toNumber(getObjectValue(serverVariables, 'max_connections')),
      table_open_cache: toNumber(getObjectValue(serverVariables, 'table_open_cache')),
      innodb_buffer_pool_size_bytes: bufferPoolSizeBytes,
      innodb_buffer_pool_size_mib: bytesToMiB(bufferPoolSizeBytes),
      innodb_log_file_size_bytes: toNumber(getObjectValue(serverVariables, 'innodb_log_file_size')),
      innodb_flush_log_at_trx_commit: toNumber(getObjectValue(serverVariables, 'innodb_flush_log_at_trx_commit')),
      innodb_file_per_table: getObjectValue(serverVariables, 'innodb_file_per_table'),
      log_bin: getObjectValue(serverVariables, 'log_bin'),
      binlog_format: getObjectValue(serverVariables, 'binlog_format') || null,
      sync_binlog: toNumber(getObjectValue(serverVariables, 'sync_binlog')),
      slow_query_log: getObjectValue(serverVariables, 'slow_query_log'),
      long_query_time_seconds: toNumber(getObjectValue(serverVariables, 'long_query_time')),
    },
    runtime_status: {
      uptime_seconds: toNumber(getObjectValue(serverStatus, 'UPTIME')),
      threads_connected: toNumber(getObjectValue(serverStatus, 'THREADS_CONNECTED')),
      threads_running: toNumber(getObjectValue(serverStatus, 'THREADS_RUNNING')),
      questions: toNumber(getObjectValue(serverStatus, 'QUESTIONS')),
      slow_queries: toNumber(getObjectValue(serverStatus, 'SLOW_QUERIES')),
      innodb_buffer_pool_reads: bufferPoolReads,
      innodb_buffer_pool_read_requests: bufferPoolReadRequests,
      innodb_buffer_pool_hit_ratio_percent: bufferPoolHitRatio,
    },
    schema: {
      table_count: tableMetrics.length,
      total_exact_rows: totalExactRows,
      total_size_bytes: totalSizeBytes,
      total_size_mib: bytesToMiB(totalSizeBytes),
      foreign_key_count: foreignKeys.length,
      index_count: indexMetrics.length,
      duplicate_index_signatures: duplicateIndexes.length,
      tables_without_primary_keys: tablesWithoutPrimaryKeys,
      zero_row_tables: zeroRowTables,
      orphaned_constraint_count: orphanedConstraints.length,
    },
    readiness_flags: {
      buffer_pool_below_128_mib: bufferPoolSizeBytes > 0 && bufferPoolSizeBytes < 134217728,
      node_db_pool_below_20: env.DB_POOL_SIZE < 20,
      binary_logging_disabled: String(getObjectValue(serverVariables, 'log_bin') || '').toUpperCase() !== 'ON',
      slow_query_log_disabled: String(getObjectValue(serverVariables, 'slow_query_log') || '').toUpperCase() !== 'ON',
      orphan_rows_detected: orphanedConstraints.length > 0,
      duplicate_indexes_detected: duplicateIndexes.length > 0,
      empty_legacy_tables_present: zeroRowTables.includes('dta_applications'),
    },
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const outputDir = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : buildDefaultOutputDir();

  ensureDir(outputDir);

  const tableNames = await fetchTableNames();
  const [createStatements, serverVariables, serverStatus, tableMetrics, indexMetrics, foreignKeys, primaryKeyCoverage] =
    await Promise.all([
      fetchCreateStatements(tableNames),
      fetchServerVariables(),
      fetchServerStatus(),
      fetchTableMetrics(tableNames),
      fetchIndexMetrics(),
      fetchForeignKeyMetrics(),
      fetchPrimaryKeyCoverage(),
    ]);
  const orphanChecks = await runOrphanChecks(foreignKeys);
  const summary = buildSummary({
    serverVariables,
    serverStatus,
    tableMetrics,
    indexMetrics,
    foreignKeys,
    orphanChecks,
    primaryKeyCoverage,
  });

  const schemaSql = [
    '-- NogatuDS local database schema snapshot',
    `-- Generated at ${summary.snapshot.generated_at}`,
    `-- Database ${summary.snapshot.database}`,
    '-- This file intentionally excludes row data to avoid committing operational records.',
    '',
    ...createStatements.flatMap((statement) => [statement.sql + ';', '']),
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'schema.sql'), schemaSql, 'utf8');
  writeJson(path.join(outputDir, 'summary.json'), summary);
  writeJson(path.join(outputDir, 'server-variables.json'), serverVariables);
  writeJson(path.join(outputDir, 'server-status.json'), serverStatus);
  writeJson(path.join(outputDir, 'tables.json'), tableMetrics);
  writeJson(path.join(outputDir, 'indexes.json'), indexMetrics);
  writeJson(path.join(outputDir, 'foreign-keys.json'), foreignKeys);
  writeJson(path.join(outputDir, 'orphan-checks.json'), orphanChecks);
  writeJson(path.join(outputDir, 'primary-key-coverage.json'), primaryKeyCoverage);

  console.log(
    JSON.stringify(
      {
        success: true,
        outputDir,
        artifacts: [
          'schema.sql',
          'summary.json',
          'server-variables.json',
          'server-status.json',
          'tables.json',
          'indexes.json',
          'foreign-keys.json',
          'orphan-checks.json',
          'primary-key-coverage.json',
        ],
        summary: {
          tableCount: summary.schema.table_count,
          totalExactRows: summary.schema.total_exact_rows,
          totalSizeMiB: summary.schema.total_size_mib,
          innodbBufferPoolMiB: summary.server.innodb_buffer_pool_size_mib,
          orphanedConstraintCount: summary.schema.orphaned_constraint_count,
          duplicateIndexSignatures: summary.schema.duplicate_index_signatures,
        },
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
