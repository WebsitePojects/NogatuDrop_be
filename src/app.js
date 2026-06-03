const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const env = require('./config/env');
const redis = require('./config/redis');
const routes = require('./routes/index');
const ApiError = require('./utils/ApiError');

const app = express();

function createRateLimiter(options, redisPrefix) {
  return rateLimit({
    ...options,
    ...(redisPrefix && !redis.isInMemory
      ? {
          store: new RedisStore({
            sendCommand: (...args) => redis.call(...args),
            prefix: redisPrefix,
          }),
        }
      : {}),
  });
}

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: env.ALLOWED_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Alliance-API-Key'],
}));

// Request logging
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Cookies
app.use(cookieParser());

// Rate limiting
if (env.RATE_LIMIT_ENABLED) {
  const limiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:api:');
  app.use('/api/', limiter);

  // Stricter limit on auth endpoints
  const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, message: 'Too many auth attempts, please try again later.' },
  }, 'rl:auth:');
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/forgot-password', authLimiter);

  const publicOrderLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many public order attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:public-order:');
  app.use('/api/v1/orders/public', publicOrderLimiter);

  const publicTrackingLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { success: false, message: 'Too many tracking lookups, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:public-tracking:');
  app.use('/api/v1/tracking/public', publicTrackingLimiter);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Nogatu NCDMS API is running', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1', routes);

// 404 handler
app.use((req, res, next) => {
  next(ApiError.notFound(`Route ${req.originalUrl} not found`));
});

// Global error handler
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    err = ApiError.badRequest(`File too large. Maximum size is ${env.MAX_FILE_SIZE_MB}MB`);
  }

  if (!err.statusCode && typeof err.message === 'string') {
    const msg = err.message.toLowerCase();
    const cloudinaryConfigIssue =
      msg.includes('cloudinary') &&
      (msg.includes('api key') || msg.includes('api_key') || msg.includes('api secret') || msg.includes('api_secret') || msg.includes('cloud name') || msg.includes('cloud_name'));

    if (cloudinaryConfigIssue) {
      err = ApiError.serviceUnavailable(
        'Cloudinary upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in backend env.'
      );
    }
  }

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  if (env.NODE_ENV !== 'production') {
    if (statusCode >= 500) {
      console.error('[Error]', err);
    } else {
      console.warn(`[HTTP ${statusCode}] ${message}`);
    }
  }

  res.status(statusCode).json({
    success: false,
    message,
    details: Array.isArray(err.details) ? err.details : [],
    ...(env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

module.exports = app;
