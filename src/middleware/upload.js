const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const env = require('../config/env');

const MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const IMAGE_ONLY = ['image/jpeg', 'image/png', 'image/webp'];

function createUpload(folder, imageOnly = false, transformation = null) {
  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: `nogatu/${folder}`,
      allowed_formats: imageOnly ? ['jpg', 'jpeg', 'png', 'webp'] : ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
      ...(transformation && { transformation }),
    },
  });

  return multer({
    storage,
    limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = imageOnly ? IMAGE_ONLY : MIME_WHITELIST;
      if (allowed.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid file type. Allowed: ${allowed.join(', ')}`), false);
      }
    },
  });
}

// Product images — compressed square
const productUpload = createUpload('products', true, [
  { width: 800, height: 800, crop: 'limit', quality: 'auto:good' },
]);

// Payment proof — original quality, PDF allowed
const paymentProofUpload = createUpload('payment-proofs', false, [
  { width: 1200, height: 1200, crop: 'limit', quality: 'auto' },
]);

// Proof of delivery photos
const podUpload = createUpload('pod', true, [
  { width: 1200, height: 1200, crop: 'limit', quality: 'auto' },
]);

// DTA application attachments
const dtaUpload = createUpload('dta', false);

module.exports = { productUpload, paymentProofUpload, podUpload, dtaUpload };
