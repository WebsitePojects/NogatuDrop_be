const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

const OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'nogatu_ncdms.sql');
const BATCH_SIZE = 200;

function quoteIdent(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

async function getBaseTables(connection, databaseName) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
       AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME ASC`,
    [databaseName]
  );
  return rows.map((row) => row.TABLE_NAME);
}

async function getViews(connection, databaseName) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME
     FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME ASC`,
    [databaseName]
  );
  return rows.map((row) => row.TABLE_NAME);
}

async function getTriggers(connection, databaseName) {
  const [rows] = await connection.query(
    `SELECT TRIGGER_NAME
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ?
     ORDER BY TRIGGER_NAME ASC`,
    [databaseName]
  );
  return rows.map((row) => row.TRIGGER_NAME);
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

async function dumpTableSchema(connection, tableName) {
  const [rows] = await connection.query(`SHOW CREATE TABLE ${quoteIdent(tableName)}`);
  const createSql = rows[0]['Create Table'];
  return [
    `DROP TABLE IF EXISTS ${quoteIdent(tableName)};`,
    `${createSql};`,
    '',
  ].join('\n');
}

async function dumpTableData(connection, tableName) {
  const [rows] = await connection.query(`SELECT * FROM ${quoteIdent(tableName)}`);
  if (!rows.length) {
    return `-- No rows for ${tableName}\n\n`;
  }

  const columnNames = Object.keys(rows[0]);
  const columnSql = columnNames.map(quoteIdent).join(', ');
  const statements = [];

  for (const batch of chunkRows(rows, BATCH_SIZE)) {
    const valuesSql = batch.map((row) => {
      const values = columnNames.map((columnName) => connection.escape(row[columnName]));
      return `(${values.join(', ')})`;
    }).join(',\n');

    statements.push(
      `INSERT INTO ${quoteIdent(tableName)} (${columnSql}) VALUES\n${valuesSql};`
    );
  }

  return `${statements.join('\n\n')}\n\n`;
}

async function dumpViewSchema(connection, viewName) {
  const [rows] = await connection.query(`SHOW CREATE VIEW ${quoteIdent(viewName)}`);
  const createSql = rows[0]['Create View'];
  return [
    `DROP VIEW IF EXISTS ${quoteIdent(viewName)};`,
    `${createSql};`,
    '',
  ].join('\n');
}

async function dumpTriggerSchema(connection, triggerName) {
  const [rows] = await connection.query(`SHOW CREATE TRIGGER ${quoteIdent(triggerName)}`);
  const createSql = rows[0]['SQL Original Statement'];
  return [
    `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)};`,
    `DELIMITER ;;`,
    `${createSql} ;;`,
    `DELIMITER ;`,
    '',
  ].join('\n');
}

async function main() {
  const connection = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    timezone: '+00:00',
    dateStrings: true,
  });

  try {
    const baseTables = await getBaseTables(connection, env.DB_NAME);
    const views = await getViews(connection, env.DB_NAME);
    const triggers = await getTriggers(connection, env.DB_NAME);
    const sections = [];

    sections.push(`-- NogatuDS project database dump`);
    sections.push(`-- Database: ${env.DB_NAME}`);
    sections.push(`-- Exported at: ${new Date().toISOString()}`);
    sections.push('');
    sections.push('SET NAMES utf8mb4;');
    sections.push('SET FOREIGN_KEY_CHECKS = 0;');
    sections.push('');

    for (const tableName of baseTables) {
      sections.push(`--`);
      sections.push(`-- Table structure for ${tableName}`);
      sections.push(`--`);
      sections.push(await dumpTableSchema(connection, tableName));
      sections.push(`--`);
      sections.push(`-- Table data for ${tableName}`);
      sections.push(`--`);
      sections.push(await dumpTableData(connection, tableName));
    }

    for (const viewName of views) {
      sections.push(`--`);
      sections.push(`-- View structure for ${viewName}`);
      sections.push(`--`);
      sections.push(await dumpViewSchema(connection, viewName));
    }

    for (const triggerName of triggers) {
      sections.push(`--`);
      sections.push(`-- Trigger structure for ${triggerName}`);
      sections.push(`--`);
      sections.push(await dumpTriggerSchema(connection, triggerName));
    }

    sections.push('SET FOREIGN_KEY_CHECKS = 1;');
    sections.push('');

    fs.writeFileSync(OUTPUT_PATH, sections.join('\n'), 'utf8');

    const stats = fs.statSync(OUTPUT_PATH);
    console.log(JSON.stringify({
      success: true,
      output: OUTPUT_PATH,
      baseTables: baseTables.length,
      views: views.length,
      triggers: triggers.length,
      sizeBytes: stats.size,
      exportedAt: stats.mtime.toISOString(),
    }, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
