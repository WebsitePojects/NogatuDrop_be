const crypto = require('node:crypto');

let lastDatePart = '';
let lastSequence = 0;

/**
 * Generates unique document numbers like ORD-20260307142311512084.
 * @param {string} prefix - ORD, TRF, PO, etc.
 * @param {string} table - retained for backward-compatible call sites
 * @param {string} column - retained for backward-compatible call sites
 * @returns {string} generated order number
 */
async function generateOrderNum(prefix, table, column) {
  const now = new Date();
  const datePart =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0') +
    String(now.getMilliseconds()).padStart(3, '0');

  if (datePart === lastDatePart) {
    lastSequence = (lastSequence + 1) % 1000;
  } else {
    lastDatePart = datePart;
    lastSequence = crypto.randomInt(0, 10);
  }

  const randomPart = String(lastSequence).padStart(3, '0');

  return `${prefix}-${datePart}${randomPart}`;
}

module.exports = generateOrderNum;
