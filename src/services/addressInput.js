/**
 * One way to take an address from a request, for every record that has a place: warehouses,
 * Stockists (partners) and Mobile Stockists. It is the same shape checkout uses for buyers: a street
 * line, a PSGC barangay code and a postal code, with city, province and region always read from the
 * PSGC tables (3NF) and never copied onto the record.
 *
 * The old single-text column (warehouses.location, partners.address, mobile_stockists.address) still
 * feeds older screens and reports, so it is rewritten from the parts on every save and nothing else
 * writes it.
 */
const { body } = require('express-validator');
const ApiError = require('../utils/ApiError');
const { phCoordinatePair } = require('../utils/phBounds');
const { BARANGAY_CODE_PATTERN, POSTAL_CODE_PATTERN } = require('./publicCustomerInput');

// Size of the address_line column on all three tables.
const ADDRESS_LINE_MAX_LENGTH = 200;
const ADDRESS_LINE_MIN_LENGTH = 3;
const BARANGAY_MESSAGE = 'Please choose the barangay from the list.';
const LINE_MESSAGE = `House no., street and subdivision are required (${ADDRESS_LINE_MIN_LENGTH} to ${ADDRESS_LINE_MAX_LENGTH} characters)`;
const POSTAL_MESSAGE = 'Postal code must be 4 digits';

const isBlank = (value) => value === undefined || value === null || value === '';

// Collapses runs of whitespace; blank becomes null so CONCAT-style joins skip it.
function cleanText(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text === '' ? null : text;
}

/**
 * express-validator chains for the three address fields.
 * `required: true` is for create. Otherwise the address may be left alone, but when either the street
 * line or the barangay is sent both must be, because the parts replace the stored address as a unit.
 */
function addressPartsValidators({ required }) {
  const optionalIfUpdate = (chain) => (required ? chain : chain.optional({ values: 'falsy' }));
  const validators = [
    optionalIfUpdate(body('address_line'))
      .isString().withMessage(LINE_MESSAGE).bail()
      .trim()
      .isLength({ min: ADDRESS_LINE_MIN_LENGTH, max: ADDRESS_LINE_MAX_LENGTH }).withMessage(LINE_MESSAGE),
    optionalIfUpdate(body('barangay_code'))
      .isString().withMessage(BARANGAY_MESSAGE).bail()
      .matches(BARANGAY_CODE_PATTERN).withMessage(BARANGAY_MESSAGE),
    body('postal_code').optional({ values: 'falsy' })
      .isString().withMessage(POSTAL_MESSAGE).bail()
      .trim()
      .matches(POSTAL_CODE_PATTERN).withMessage(POSTAL_MESSAGE),
  ];
  if (!required) {
    // optional() skips a blank field, so the all-or-nothing rule lives on its own chain that always runs.
    validators.push(body('barangay_code').custom((value, { req }) => {
      if (isBlank(req.body.address_line) !== isBlank(req.body.barangay_code)) {
        throw new Error('Send the street line and the barangay together');
      }
      return true;
    }));
  }
  return validators;
}

/** Latitude/longitude must be sent as a pair of numbers inside the Philippines, or not at all. */
function coordinatePairValidator(latField = 'lat', lngField = 'lng') {
  const insidePhilippines = phCoordinatePair(latField, lngField);
  return body(latField).custom((value, meta) => {
    const lat = meta.req.body[latField];
    const lng = meta.req.body[lngField];
    if (!isBlank(lat) && !isBlank(lng) && (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)))) {
      throw new Error('Latitude and longitude must be numbers');
    }
    return insidePhilippines(value, meta);
  });
}

/** The validated pin as numbers, or nulls when none was sent. */
function readCoordinates(source, latField = 'lat', lngField = 'lng') {
  if (isBlank(source[latField]) || isBlank(source[lngField])) return { lat: null, lng: null };
  return { lat: Number(source[latField]), lng: Number(source[lngField]) };
}

/** True when the request carries a new address (street line and barangay). */
function hasAddressParts(source) {
  return !isBlank(source.address_line) && !isBlank(source.barangay_code);
}

/**
 * "street, barangay, city, province-or-region, postal" — the same order orders use. If the text would
 * not fit `maxLength` the street is shortened first, so the place names always survive.
 */
function composeAddressText({ addressLine, barangay, city, provinceOrRegion, postalCode }, { maxLength = Infinity } = {}) {
  const tail = [barangay, city, provinceOrRegion, postalCode].filter(Boolean);
  const full = [addressLine, ...tail].filter(Boolean).join(', ');
  if (full.length <= maxLength) return full;
  const room = maxLength - (tail.length ? `, ${tail.join(', ')}`.length : 0) - 1;
  if (!addressLine || room < 1) return full.slice(0, maxLength);
  return [`${addressLine.slice(0, room).trimEnd()}…`, ...tail].join(', ');
}

/** Names of a barangay and the places above it, or null for a code that is not in the PSGC list. */
async function findPlace(db, barangayCode) {
  const [rows] = await db.execute(
    `SELECT b.name AS barangay, c.name AS city, p.name AS province, r.name AS region
     FROM ph_barangays b
     JOIN ph_cities_municipalities c ON c.code = b.city_code
     LEFT JOIN ph_provinces p ON p.code = c.province_code
     LEFT JOIN ph_regions r ON r.code = COALESCE(p.region_code, c.region_code)
     WHERE b.code = ? LIMIT 1`,
    [barangayCode]
  );
  return rows[0] || null;
}

/**
 * Reads the address parts from a validated body, proves the barangay exists, and returns the values
 * to store, including the rewritten legacy text and the region name (older screens read both).
 * @param {object} db pool or connection
 * @param {object} source the request body
 * @param {{ maxLength?: number }} options legacy column size, so the text always fits
 * @returns {Promise<{ addressLine: string, barangayCode: string, postalCode: string|null,
 *                     text: string, regionName: string|null }>}
 */
async function resolveAddress(db, source, { maxLength } = {}) {
  const addressLine = cleanText(source.address_line);
  const barangayCode = cleanText(source.barangay_code);
  const postalCode = cleanText(source.postal_code);
  const place = await findPlace(db, barangayCode);
  if (!place) throw ApiError.badRequest(BARANGAY_MESSAGE);
  const text = composeAddressText({
    addressLine,
    barangay: place.barangay,
    city: place.city,
    provinceOrRegion: place.province || place.region,
    postalCode,
  }, { maxLength });
  return { addressLine, barangayCode, postalCode, text, regionName: place.region };
}

module.exports = {
  ADDRESS_LINE_MAX_LENGTH,
  addressPartsValidators,
  coordinatePairValidator,
  readCoordinates,
  hasAddressParts,
  composeAddressText,
  findPlace,
  resolveAddress,
};
