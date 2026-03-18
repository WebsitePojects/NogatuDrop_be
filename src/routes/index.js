const { Router } = require('express');

const authRoutes = require('./auth');
const userRoutes = require('./users');
const productRoutes = require('./products');
const inventoryRoutes = require('./inventory');
const warehouseRoutes = require('./warehouses');
const orderRoutes = require('./orders');
const cartRoutes = require('./cart');
const partnerRoutes = require('./partners');
const stockTransferRoutes = require('./stockTransfers');
const purchaseOrderRoutes = require('./purchaseOrders');
const notificationRoutes = require('./notifications');
const trackingRoutes = require('./tracking');
const reportRoutes = require('./reports');
const dashboardRoutes = require('./dashboard');

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/products', productRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/warehouses', warehouseRoutes);
router.use('/orders', orderRoutes);
router.use('/cart', cartRoutes);
router.use('/partners', partnerRoutes);
router.use('/stock-transfers', stockTransferRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/notifications', notificationRoutes);
router.use('/tracking', trackingRoutes);
router.use('/reports', reportRoutes);
router.use('/dashboard', dashboardRoutes);

module.exports = router;
