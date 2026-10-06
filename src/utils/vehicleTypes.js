// Vehicles a Rider Link can be created for. Also the delivery_tracking.vehicle_type ENUM
// (scripts/addFinalizationSchema.js) and the keys of routeService's traffic factors.
const VEHICLE_TYPES = Object.freeze(['motorcycle', 'car', 'van', 'truck']);

module.exports = { VEHICLE_TYPES };
