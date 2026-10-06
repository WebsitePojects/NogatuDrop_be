// Road routes and arrival estimates for the delivery map.
//
// Routes come from OSRM (OpenStreetMap road network), so the line on the map follows real roads.
// The public OSRM server asks for light use, so every route is cached in Redis for ROUTE_TTL_SECONDS,
// keyed by both ends rounded to ~11 m: a rider pinging every 15-30 s on the same street reuses it.
// If routing is down or slow the map still works: it gets a straight line marked `approximate`.
const env = require('../config/env');
const cache = require('./cacheService');
const { VEHICLE_TYPES } = require('../utils/vehicleTypes');

const ROUTE_TTL_SECONDS = 6 * 60 * 60;
const ROUTE_TIMEOUT_MS = 6000;
const STRAIGHT_LINE_KMH = 25; // city average, only used when there is no road route

// OSRM's demo server has one car profile and free-flow speeds; these turn that into a Metro Manila
// estimate. The ETA is shown as a range, low = factor, high = factor x ETA_SPREAD.
const TRAFFIC_FACTOR = Object.freeze({ motorcycle: 1.2, car: 1.4, van: 1.5, truck: 1.6 });
const ETA_SPREAD = 1.35;

const round4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

// A cache outage must not take the map down; it only costs an extra routing call.
async function cacheGet(key) {
  try { return await cache.get(key); } catch { return null; }
}
async function cacheSet(key, value) {
  try { await cache.set(key, value, ROUTE_TTL_SECONDS); } catch { /* best effort */ }
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function straightLine(from, to) {
  const distance = haversineMeters(from, to);
  return {
    source: 'approximate',
    coordinates: [[from.lat, from.lng], [to.lat, to.lng]],
    distance_m: Math.round(distance),
    duration_s: Math.round(distance / ((STRAIGHT_LINE_KMH * 1000) / 3600)),
  };
}

async function fetchOsrmRoute(from, to, fetchImpl) {
  const base = String(env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
  // OSRM takes lng,lat. Coordinates are numbers we rounded ourselves, never raw input.
  const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'NogatuNCDMS/1.0 (nogatu.store)' } });
    if (!res.ok) return null;
    const body = await res.json();
    const route = body?.code === 'Ok' ? body.routes?.[0] : null;
    if (!route?.geometry?.coordinates?.length) return null;
    return {
      source: 'road',
      // GeoJSON is [lng, lat]; the map (Leaflet) wants [lat, lng].
      coordinates: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distance_m: Math.round(route.distance),
      duration_s: Math.round(route.duration),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Road route between two points ({lat, lng}). Never throws: falls back to a straight line.
 * @returns {Promise<{source:'road'|'approximate', coordinates:number[][], distance_m:number, duration_s:number}>}
 */
async function getRoadRoute(fromPoint, toPoint, { fetchImpl = fetch } = {}) {
  const from = { lat: round4(fromPoint.lat), lng: round4(fromPoint.lng) };
  const to = { lat: round4(toPoint.lat), lng: round4(toPoint.lng) };
  const key = `route:v1:${from.lat},${from.lng}:${to.lat},${to.lng}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const road = await fetchOsrmRoute(from, to, fetchImpl);
  if (!road) return straightLine(from, to); // not cached, so the next request retries the road route
  await cacheSet(key, road);
  return road;
}

/** Arrival window in minutes for a drive time (seconds) and vehicle. */
function estimateArrival(durationSeconds, vehicleType = 'motorcycle') {
  const factor = TRAFFIC_FACTOR[vehicleType] || TRAFFIC_FACTOR.motorcycle;
  const minutes = (Number(durationSeconds) || 0) / 60;
  const low = Math.max(1, Math.round(minutes * factor));
  const high = Math.max(low + 1, Math.round(minutes * factor * ETA_SPREAD));
  return { min_minutes: low, max_minutes: high };
}

module.exports = { getRoadRoute, estimateArrival, haversineMeters, TRAFFIC_FACTOR, VEHICLE_TYPES };
