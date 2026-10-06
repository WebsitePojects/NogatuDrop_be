// One rule for "is this pin in the Philippines?", used by every endpoint that stores a coordinate
// (checkout pins, warehouses, mobile stockists, rider pings). The frontend has the same numbers in
// src/utils/phBounds.js so a bad pin is caught before it is sent.
//
// A box around the archipelago (Batanes to Tawi-Tawi, Palawan to Davao Oriental) minus the corner of
// Borneo (Sabah) that the box would otherwise include. Coarse on purpose: it stops pins dropped in
// the sea off Africa (0,0), in Manila Bay's mirror (lat/lng swapped) or in another country.
const PH_BOX = Object.freeze({ latMin: 4.2, latMax: 21.5, lngMin: 116.0, lngMax: 127.0 });
const SABAH_CORNER = Object.freeze({ latMax: 7.3, lngMax: 119.2 });

const OUTSIDE_PH_MESSAGE = 'This pin is outside the Philippines. Move it to the correct location.';

function isInsidePhilippines(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la < PH_BOX.latMin || la > PH_BOX.latMax || ln < PH_BOX.lngMin || ln > PH_BOX.lngMax) return false;
  return !(la < SABAH_CORNER.latMax && ln < SABAH_CORNER.lngMax);
}

/** express-validator custom check for a lat/lng pair in the body; skips when both are absent. */
function phCoordinatePair(latField = 'lat', lngField = 'lng') {
  return (value, { req }) => {
    const lat = req.body[latField];
    const lng = req.body[lngField];
    const missing = (v) => v === undefined || v === null || v === '';
    if (missing(lat) && missing(lng)) return true;
    if (missing(lat) || missing(lng)) throw new Error('Set both latitude and longitude, or neither');
    if (!isInsidePhilippines(lat, lng)) throw new Error(OUTSIDE_PH_MESSAGE);
    return true;
  };
}

module.exports = { PH_BOX, isInsidePhilippines, phCoordinatePair, OUTSIDE_PH_MESSAGE };
