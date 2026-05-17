function toCoordinate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildPoint({ label = null, address = null, latitude, longitude, pinged_at = null }) {
  return {
    label,
    address,
    latitude: toCoordinate(latitude),
    longitude: toCoordinate(longitude),
    ...(pinged_at !== null ? { pinged_at } : {}),
  };
}

function buildTrackingMapSnapshot(row = {}) {
  const source = buildPoint({
    label: row.source_warehouse_name || null,
    address: row.source_warehouse_location || null,
    latitude: row.source_warehouse_lat,
    longitude: row.source_warehouse_lng,
  });

  const hasWarehouseDestinationCoords =
    toCoordinate(row.target_warehouse_lat) !== null &&
    toCoordinate(row.target_warehouse_lng) !== null;

  const destination = hasWarehouseDestinationCoords
    ? buildPoint({
        label: row.target_warehouse_name || null,
        address: row.target_warehouse_location || null,
        latitude: row.target_warehouse_lat,
        longitude: row.target_warehouse_lng,
      })
    : buildPoint({
        label: row.customer_name || row.target_warehouse_name || null,
        address: row.customer_address || row.target_warehouse_location || null,
        latitude: row.customer_latitude,
        longitude: row.customer_longitude,
      });

  const current = {
    latitude: toCoordinate(row.latest_latitude),
    longitude: toCoordinate(row.latest_longitude),
    pinged_at: row.last_pinged_at || null,
  };

  const route_kind = hasWarehouseDestinationCoords ? 'warehouse_transfer' : 'customer_delivery';
  const has_mappable_route =
    source.latitude !== null &&
    source.longitude !== null &&
    destination.latitude !== null &&
    destination.longitude !== null;

  return {
    route_kind,
    has_mappable_route,
    source,
    current,
    destination,
  };
}

module.exports = {
  buildTrackingMapSnapshot,
};
