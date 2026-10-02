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

// multer-storage-cloudinary 2.x calls `opts.cloudinary.v2.uploader.upload_stream(...)`, i.e. it wants the
// root SDK module. config/cloudinary.js exports the already-configured v2 client, so wrap it; passing
// the v2 client directly made every upload fail with "Cannot read properties of undefined (reading
// 'uploader')" (seen in production logs, 2026-10-02).
const cloudinarySdkForStorage = { v2: cloudinary };

/**
 * multer-storage-cloudinary 2.x hands Cloudinary's raw upload result to multer, so req.file gets
 * `secure_url` but no `path`; every controller reads req.file.path, which was undefined and made each
 * upload fail at the database write ("Bind parameters must not contain undefined"). This adapter gives
 * every route the same shape: `path` is the https URL, `file_id` is what _removeFile needs to clean up.
 * A result without a URL fails the upload instead of storing an empty link.
 */
function withUrlPath(storage) {
  return {
    _handleFile(req, file, cb) {
      storage._handleFile(req, file, (err, result) => {
        if (err) return cb(err);
        const url = result && (result.secure_url || result.path);
        if (!url) {
          const missing = new Error('File storage did not return a file URL. Please try the upload again.');
          missing.statusCode = 502;
          return cb(missing);
        }
        return cb(null, { path: url, public_id: result.public_id, file_id: result.public_id, size: result.bytes });
      });
    },
    _removeFile(req, file, cb) {
      storage._removeFile(req, file, cb);
    },
  };
}

function createUpload(folder, imageOnly = false, transformation = null) {
  const storage = withUrlPath(createCloudinaryStorage({
    cloudinary: cloudinarySdkForStorage,
    params: {
      folder: `nogatu/${folder}`,
      allowed_formats: imageOnly
        ? ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
        : ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'],
      ...(transformation && { transformation }),
    },
  }));

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

  if (err.statusCode === 502) {
    return next(new ApiError(502, err.message));
  }

  return next(err);
}

module.exports = { productUpload, paymentProofUpload, podUpload, uploadErrorHandler };
