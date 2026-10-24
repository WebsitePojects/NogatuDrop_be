// A courier's own tracking page for a waybill, from the courier's link pattern (couriers.tracking_url_template,
// set by Super Admin, e.g. "https://www.jtexpress.ph/track-and-trace?waybillNo={tracking_number}"). Returns null when there
// is no usable pattern, so callers show the waybill number alone. Only http(s) patterns are used, and the
// waybill is URL-encoded, so neither a mistyped pattern nor a typed waybill can produce a harmful link.
const PLACEHOLDER = '{tracking_number}';

function courierTrackingUrl(template, trackingNumber) {
  const pattern = String(template || '').trim();
  const number = String(trackingNumber || '').trim();
  if (!pattern || !number || !/^https?:\/\//i.test(pattern) || !pattern.includes(PLACEHOLDER)) return null;
  return pattern.split(PLACEHOLDER).join(encodeURIComponent(number));
}

module.exports = { courierTrackingUrl, PLACEHOLDER };
