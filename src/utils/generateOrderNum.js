const pool = require('../config/db');

/**
 * Generates unique order numbers like ORD-2026030701, TRF-2026030701, PO-2026030701
 * @param {string} prefix - ORD, TRF, PO, etc.
 * @param {string} table - table name to check for existing numbers
 * @param {string} column - column name that stores the number
 * @returns {string} generated order number
 */
async function generateOrderNum(prefix, table, column) {
  const now = new Date();
  const datePart =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');

  const pattern = `${prefix}-${datePart}%`;

  const [rows] = await pool.execute(
    `SELECT ${column} FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`,
    [pattern]
  );

  let seq = 1;
  if (rows.length > 0) {
    const lastNum = rows[0][column];
    const lastSeq = parseInt(lastNum.slice(-2), 10);
    seq = lastSeq + 1;
  }

  return `${prefix}-${datePart}${String(seq).padStart(2, '0')}`;
}

module.exports = generateOrderNum;
