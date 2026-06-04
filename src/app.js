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
const { attachRequestContext } = require('./middleware/requestContext');
const { buildReadinessSnapshot } = require('./services/readinessService');

const app = express();

const allowedOrigins = String(env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (env.NODE_ENV !== 'production' && isLoopbackOrigin(origin)) {
    return true;
  }

  return false;
}

morgan.token('request-id', (req) => req.requestId || '-');

function productionMorganJson(tokens, req, res) {
  return JSON.stringify({
    request_id: tokens['request-id'](req, res),
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: Number(tokens.status(req, res) || 0),
    response_time_ms: Number(tokens['response-time'](req, res) || 0),
    content_length: Number(tokens.res(req, res, 'content-length') || 0),
    remote_addr: tokens['remote-addr'](req, res),
    user_agent: tokens['user-agent'](req, res),
  });
}

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
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(ApiError.forbidden(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Alliance-API-Key'],
}));

app.use(attachRequestContext);

// Request logging
app.use(
  morgan(
    env.NODE_ENV === 'production'
      ? productionMorganJson
      : ':request-id :method :url :status :res[content-length] - :response-time ms'
  )
);

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
  res.json({
    success: true,
    status: 'ok',
    message: 'Nogatu NCDMS API is running',
    request_id: req.requestId,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.get('/api/ready', async (req, res, next) => {
  try {
    const snapshot = await buildReadinessSnapshot({ requestId: req.requestId });
    res.status(snapshot.success ? 200 : 503).json(snapshot);
  } catch (err) {
    next(err);
  }
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

  if (statusCode >= 500) {
    console.error('[HTTP 5xx]', {
      request_id: req.requestId || null,
      method: req.method,
      url: req.originalUrl,
      status: statusCode,
      message,
      stack: err.stack,
    });
  } else if (env.NODE_ENV !== 'production') {
    console.warn(`[HTTP ${statusCode}] ${message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    request_id: req.requestId || null,
    details: Array.isArray(err.details) ? err.details : [],
    ...(env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

module.exports = app;
