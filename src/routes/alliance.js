const { Router } = require('express');
const { allianceAuth, getStockists, getSales, getMobileStockists } = require('../controllers/allianceController');

const r = Router();
r.use(allianceAuth);
r.get('/stockists', getStockists);
r.get('/sales', getSales);
r.get('/mobile-stockists', getMobileStockists);
module.exports = r;
