const multer = require('multer');
const cloudinaryStoragePkg = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

// HEIC/HEIF covers iPhone photos taken with the default camera format — Cloudinary
// ingests and transcodes them, so we accept the mimetype and let Cloudinary convert.
const MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const IMAGE_ONLY = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const hasCloudinaryConfig = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
);

function createCloudinaryStorage(options) {
  if (typeof cloudinaryStoragePkg === 'function') {
    try {
      return new cloudinaryStoragePkg(options);
    } catch (_) {
      return cloudinaryStoragePkg(options);
    }
  }

  if (typeof cloudinaryStoragePkg.CloudinaryStorage === 'function') {
    return new cloudinaryStoragePkg.CloudinaryStorage(options);
  }

  if (typeof cloudinaryStoragePkg.default === 'function') {
    return new cloudinaryStoragePkg.default(options);
  }

  if (typeof cloudinaryStoragePkg.createCloudinaryStorage === 'function') {
    return cloudinaryStoragePkg.createCloudinaryStorage(options);
  }

  throw new TypeError(
    'Unsupported multer-storage-cloudinary export shape. Expected CloudinaryStorage constructor.'
  );
}

function createUpload(folder, imageOnly = false, transformation = null) {
  const storage = createCloudinaryStorage({
    cloudinary,
    params: {
      folder: `nogatu/${folder}`,
      allowed_formats: imageOnly
        ? ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
        : ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'],
      ...(transformation && { transformation }),
    },
  });

  return multer({
    storage,
    limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!hasCloudinaryConfig) {
        const err = new Error(
          'Cloudinary upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in backend env.'
        );
        err.statusCode = 503;
        cb(err, false);
        return;
      }

      const allowed = imageOnly ? IMAGE_ONLY : MIME_WHITELIST;
      if (allowed.includes(file.mimetype)) {
        cb(null, true);
      } else {
        const err = new Error(`Invalid file type. Allowed: ${allowed.join(', ')}`);
        err.code = 'INVALID_FILE_TYPE';
        cb(err, false);
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

// Route-scoped multer error translator. Wire this immediately after
// `<upload>.single(field)` on any upload route so multer/fileFilter failures
// become a clean 400/503 JSON error instead of falling through to the app's
// catch-all handler as an opaque 500 (which is what iPhone users were hitting:
// HEIC rejected by fileFilter -> generic 500 -> FE showed "Upload failed").
// Unrecognized errors are passed through untouched (fail closed, not swallowed).
function uploadErrorHandler(err, req, res, next) {
  if (!err) {
    return next();
  }

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return next(ApiError.badRequest(`File too large. Maximum ${env.MAX_FILE_SIZE_MB} MB.`));
  }

  if (err.code === 'INVALID_FILE_TYPE') {
    return next(ApiError.badRequest('Unsupported file type. Please upload a JPG, PNG, HEIC, or PDF.'));
  }

  if (err.statusCode === 503) {
    return next(ApiError.serviceUnavailable(err.message));
  }

  return next(err);
}

module.exports = { productUpload, paymentProofUpload, podUpload, uploadErrorHandler };
