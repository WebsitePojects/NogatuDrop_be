/**
 * The public buyer's name and delivery address, as checkout sends them: atomic parts, never one
 * free-text blob. Route validators (routes/orders.js) enforce the shapes below; this module turns the
 * validated body into the exact values stored on the order and checks the barangay is a real PSGC code.
 */
const ApiError = require('../utils/ApiError');

const NAME_SUFFIXES = Object.freeze(['Jr.', 'Sr.', 'II', 'III', 'IV', 'V']);
// Letters in any script (ñ, accented vowels) plus the separators real Filipino names use.
const PERSON_NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'’-]*$/u;
const NAME_MAX_LENGTH = 80;
const ADDRESS_LINE_MAX_LENGTH = 255;
const BARANGAY_CODE_PATTERN = /^\d{9}$/;
const POSTAL_CODE_PATTERN = /^\d{4}$/;

// Collapses inner runs of whitespace; empty optional parts become NULL so CONCAT_WS skips them.
function cleanText(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text === '' ? null : text;
}

/**
 * Builds the order's customer columns from a validated request body.
 * @returns {{ firstName: string, middleName: string|null, lastName: string, suffix: string|null,
 *             addressLine: string, barangayCode: string, postalCode: string|null }}
 */
function readPublicCustomer(body) {
  return {
    firstName: cleanText(body.customer_first_name),
    middleName: cleanText(body.customer_middle_name),
    lastName: cleanText(body.customer_last_name),
    suffix: cleanText(body.customer_name_suffix),
    addressLine: cleanText(body.customer_address_line),
    barangayCode: cleanText(body.customer_barangay_code),
    postalCode: cleanText(body.customer_postal_code),
  };
}

/** Fails closed when the barangay code is not in the PSGC reference table. */
async function assertBarangayExists(db, barangayCode) {
  const [rows] = await db.execute('SELECT code FROM ph_barangays WHERE code = ? LIMIT 1', [barangayCode]);
  if (rows.length === 0) {
    throw ApiError.badRequest('Please choose your barangay from the list.');
  }
}

module.exports = {
  NAME_SUFFIXES,
  PERSON_NAME_PATTERN,
  NAME_MAX_LENGTH,
  ADDRESS_LINE_MAX_LENGTH,
  BARANGAY_CODE_PATTERN,
  POSTAL_CODE_PATTERN,
  readPublicCustomer,
  assertBarangayExists,
};
