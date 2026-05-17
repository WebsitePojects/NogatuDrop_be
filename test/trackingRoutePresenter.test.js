const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTrackingMapSnapshot } = require('../src/services/trackingRoutePresenter');

test('tracking route presenter builds a warehouse-to-warehouse map snapshot when both endpoints have coordinates', () => {
  const snapshot = buildTrackingMapSnapshot({
    source_warehouse_id: 1,
    source_warehouse_name: 'Goldenstar Main',
    source_warehouse_location: 'Laguna',
    source_warehouse_lat: '14.2100',
    source_warehouse_lng: '121.0400',
    target_warehouse_id: 2,
    target_warehouse_name: 'Cebu Hub',
    target_warehouse_location: 'Cebu City',
    target_warehouse_lat: '10.3157',
    target_warehouse_lng: '123.8854',
    latest_latitude: '13.0000',
    latest_longitude: '122.5000',
    last_pinged_at: '2026-05-17T10:00:00.000Z',
  });

  assert.equal(snapshot.route_kind, 'warehouse_transfer');
  assert.equal(snapshot.source.label, 'Goldenstar Main');
  assert.equal(snapshot.destination.label, 'Cebu Hub');
  assert.deepEqual(snapshot.current, {
    latitude: 13,
    longitude: 122.5,
    pinged_at: '2026-05-17T10:00:00.000Z',
  });
  assert.equal(snapshot.has_mappable_route, true);
});

test('tracking route presenter falls back to customer destination metadata when no warehouse target coordinates exist', () => {
  const snapshot = buildTrackingMapSnapshot({
    source_warehouse_id: 1,
    source_warehouse_name: 'Provincial Hub',
    source_warehouse_location: 'Davao',
    source_warehouse_lat: '7.1907',
    source_warehouse_lng: '125.4553',
    customer_name: 'Juan Dela Cruz',
    customer_address: 'Mintal, Davao City',
    latest_latitude: null,
    latest_longitude: null,
    last_pinged_at: null,
  });

  assert.equal(snapshot.route_kind, 'customer_delivery');
  assert.equal(snapshot.destination.label, 'Juan Dela Cruz');
  assert.equal(snapshot.destination.address, 'Mintal, Davao City');
  assert.equal(snapshot.destination.latitude, null);
  assert.equal(snapshot.has_mappable_route, false);
});

test('tracking route presenter treats incomplete coordinates as unavailable instead of returning NaN', () => {
  const snapshot = buildTrackingMapSnapshot({
    source_warehouse_name: 'North Hub',
    source_warehouse_lat: '',
    source_warehouse_lng: 'foo',
    target_warehouse_name: 'South Hub',
    target_warehouse_lat: '14.5995',
    target_warehouse_lng: '120.9842',
    latest_latitude: '14.7000',
    latest_longitude: '121.0000',
    last_pinged_at: '2026-05-17T10:05:00.000Z',
  });

  assert.equal(snapshot.source.latitude, null);
  assert.equal(snapshot.source.longitude, null);
  assert.equal(snapshot.destination.latitude, 14.5995);
  assert.equal(snapshot.destination.longitude, 120.9842);
  assert.equal(snapshot.current.latitude, 14.7);
  assert.equal(snapshot.current.longitude, 121);
});
