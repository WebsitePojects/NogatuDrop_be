// Reusable Cloudinary cleanup helpers. A stored image is the FULL secure URL
// (e.g. https://res.cloudinary.com/<cloud>/image/upload/v123/nogatu/payment-proofs/abc.jpg).
// Cloudinary's destroy API needs the public_id (folder/name, no version/extension).
// Used by the purge script today and by any future order-delete endpoint so that
// removing an order also frees its payment-proof / POD images and they don't
// silently accumulate (important while testing).
const cloudinary = require('../config/cloudinary');

/** Extract the Cloudinary public_id from a stored secure URL. */
function extractPublicId(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.includes('/upload/')) return null; // not a Cloudinary upload URL
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
  return match ? match[1] : null;
}

/** Destroy a single Cloudinary asset by its stored URL. Never throws. */
async function destroyByUrl(url) {
  const publicId = extractPublicId(url);
  if (!publicId) return { ok: false, skipped: true, url };
  try {
    const res = await cloudinary.uploader.destroy(publicId, { invalidate: true });
    return { ok: res.result === 'ok' || res.result === 'not found', result: res.result, publicId };
  } catch (err) {
    return { ok: false, error: err.message, publicId };
  }
}

/** Destroy many URLs, ignoring blanks. Returns a summary count. */
async function destroyMany(urls = []) {
  let destroyed = 0;
  let skipped = 0;
  for (const url of urls.filter(Boolean)) {
    const r = await destroyByUrl(url);
    if (r.ok && !r.skipped) destroyed += 1;
    else skipped += 1;
  }
  return { destroyed, skipped };
}

module.exports = { extractPublicId, destroyByUrl, destroyMany };
