// Where a buyer follows a courier parcel. Two kinds of courier (management, 2026-10-14 and 2026-10-29):
//   - J&T, LBC, Flash: staff type the waybill; the courier's link pattern (couriers.tracking_url_template, set by
//     Super Admin, e.g. "https://www.jtexpress.ph/track-and-trace?waybillNo={tracking_number}") makes the link.
//   - Grab, Lalamove: staff paste the "share tracking" link from the courier's app
//     (delivery_tracking.courier_tracking_link); it is used as it is.
// Only https links (or http(s) patterns) are used and the waybill is URL-encoded, so neither a mistyped
// pattern nor a typed waybill can produce a harmful link.
const PLACEHOLDER = '{tracking_number}';
const TRACKING_LINK_MAX = 500;

function courierTrackingUrl(template, trackingNumber) {
  const pattern = String(template || '').trim();
  const number = String(trackingNumber || '').trim();
  if (!pattern || !number || !/^https?:\/\//i.test(pattern) || !pattern.includes(PLACEHOLDER)) return null;
  return pattern.split(PLACEHOLDER).join(encodeURIComponent(number));
}

/** The pasted share link, normalised, when it is a plain https URL; null otherwise. */
function safeTrackingLink(value) {
  const text = String(value || '').trim();
  if (!text || text.length > TRACKING_LINK_MAX) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') ? url.toString() : null;
  } catch {
    return null;
  }
}

/** True when the order went out with a courier: a waybill or a pasted tracking link is saved. */
function isCourierShipment(row) {
  return Boolean(row && (row.courier_tracking_number || row.courier_tracking_link));
}

/**
 * The courier's tracking page for a shipment row ({ courier_tracking_link, tracking_url_template,
 * courier_tracking_number }): the pasted link first, else the pattern filled with the waybill. Null when neither.
 */
function shipmentTrackingUrl(row) {
  if (!row) return null;
  return safeTrackingLink(row.courier_tracking_link) || courierTrackingUrl(row.tracking_url_template, row.courier_tracking_number);
}

module.exports = { courierTrackingUrl, safeTrackingLink, isCourierShipment, shipmentTrackingUrl, PLACEHOLDER, TRACKING_LINK_MAX };
