const { Router } = require('express');
const { query, oneOf } = require('express-validator');
const validate = require('../middleware/validate');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { listRegions, listProvinces, listCities, listBarangays } = require('../services/phLocationService');
const { BARANGAY_CODE_PATTERN: PSGC_CODE_PATTERN } = require('../services/publicCustomerInput');

// Public, no auth: checkout's address pickers. The PSGC list changes a few times a year at most, so
// browsers and the CDN may keep each answer for a day.
const router = Router();
const CACHE_HEADER = 'public, max-age=86400';

const psgcCode = (field) => query(field).isString().matches(PSGC_CODE_PATTERN).withMessage(`${field} must be a 9-digit PSGC code`);

const send = (res, data) => {
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ success: true, data });
};

router.get('/regions', asyncHandler(async (req, res) => send(res, await listRegions(pool))));

router.get('/provinces', psgcCode('region'), validate,
  asyncHandler(async (req, res) => send(res, await listProvinces(pool, req.query.region))));

router.get(
  '/cities',
  oneOf([
    [psgcCode('province'), query('region').not().exists()],
    [psgcCode('region'), query('province').not().exists()],
  ], { message: 'Pass exactly one of province or region (9-digit PSGC code)' }),
  validate,
  asyncHandler(async (req, res) => send(res, await listCities(pool, {
    provinceCode: req.query.province,
    regionCode: req.query.region,
  })))
);

router.get('/barangays', psgcCode('city'), validate,
  asyncHandler(async (req, res) => send(res, await listBarangays(pool, req.query.city))));

module.exports = router;
