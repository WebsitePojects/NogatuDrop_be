const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { RedisStore } = require('rate-limit-redis');
const env = require('./config/env');
const redis = require('./config/redis');
const routes = require('./routes/index');
const ApiError = require('./utils/ApiError');
const { attachRequestContext } = require('./middleware/requestContext');
const { buildReadinessSnapshot } = require('./services/readinessService');

const app = express();

// Without this every request behind nginx has req.ip 127.0.0.1, so each rate limiter becomes one
// bucket shared by all visitors and a few shoppers lock everyone out.
app.set('trust proxy', env.TRUST_PROXY);

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

  if (env.CORS_ALLOW_ALL) {
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Alliance-API-Key', 'Idempotency-Key'],
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

// Rate limiting, sized for a working day (2026-11-23). Every window is 15 minutes.
//  - Signed-in staff are counted per USER, not per IP: one open tab already polls notifications and orders
//    about 90 times per window, and a whole office shares one IP. 900 = one call per second on average.
//  - Everyone else is counted per IP with room for a shop or mobile network where many buyers share one.
//  - Each public action that can be abused gets its own tighter budget on top.
//  - Rider pings are counted per Rider Link: riders on mobile data share carrier IPs.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = Object.freeze({
  signedIn: 900,
  anonymous: 600,
  login: 20,
  publicOrder: 10,
  publicTracking: 120, // the tracking page refreshes every 20 s (45 per window) plus the payment check
  shippingQuote: 120, // checkout asks again on each address or cart change, debounced
  memberVerifyPerIp: 10,
  memberVerifyFailuresPerUsername: 5,
  riderPingsPerLink: 120, // one ping every 15 s is 60
});

/** `user:<id>` for a valid staff token, else the client IP (behind nginx: the X-Forwarded-For client). */
function signedInUserKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const claims = jwt.verify(header.slice(7), env.JWT_SECRET);
      if (claims && claims.id) return `user:${claims.id}`;
    } catch {
      // An expired or forged token is counted against the IP like any anonymous call.
    }
  }
  return `ip:${req.ip}`;
}

if (env.RATE_LIMIT_ENABLED) {
  const limited = (message) => ({ success: false, message });
  const isRiderPing = (req) => req.path.startsWith('/v1/tracking/ping/');

  const limiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: (req) => (signedInUserKey(req).startsWith('user:') ? RATE_LIMITS.signedIn : RATE_LIMITS.anonymous),
    keyGenerator: signedInUserKey,
    // Rider pings have their own per-link budget below.
    skip: isRiderPing,
    message: limited('Too many requests, please try again later.'),
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:api:');
  app.use('/api/', limiter);

  // Stricter limit on auth endpoints
  const authLimiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMITS.login,
    message: limited('Too many auth attempts, please try again later.'),
  }, 'rl:auth:');
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/forgot-password', authLimiter);

  const publicOrderLimiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMITS.publicOrder,
    message: limited('Too many public order attempts, please try again later.'),
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:public-order:');
  // Only order submissions spend this allowance. The influencer landing page and payment options are
  // GETs under the same prefix; counting them would block shoppers for browsing.
  app.use('/api/v1/orders/public', (req, res, next) => (
    req.method === 'POST' ? publicOrderLimiter(req, res, next) : next()
  ));

  const publicTrackingLimiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMITS.publicTracking,
    message: limited('Too many tracking lookups, please try again later.'),
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:public-tracking:');
  app.use('/api/v1/tracking/public', publicTrackingLimiter);

  const shippingQuoteLimiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMITS.shippingQuote,
    message: limited('Too many shipping checks, please wait a few minutes and try again.'),
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:shipping-quote:');
  app.use('/api/v1/shipping/quote', shippingQuoteLimiter);

  // Member sign-in guards nogatualliance.com passwords: few tries per IP, and few FAILED tries per username
  // from anywhere, so nobody can guess a member's password from many addresses.
  const memberVerifyIpLimiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMITS.memberVerifyPerIp,
    message: limited('Too many member sign-in attempts. Please wait 15 minutes.'),
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:member-ip:');
  const memberVerifyUsernameLimiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMITS.memberVerifyFailuresPerUsername,
    keyGenerator: (req) => `member:${String(req.body?.username || '').trim().toLowerCase()}`,
    skipSuccessfulRequests: true,
    message: limited('Too many wrong passwords for this member. Please wait 15 minutes.'),
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:member-user:');
  app.use('/api/v1/members/verify', memberVerifyIpLimiter, memberVerifyUsernameLimiter);

  const riderPingLimiter = createRateLimiter({
    windowMs: RATE_WINDOW_MS,
    max: RATE_LIMITS.riderPingsPerLink,
    keyGenerator: (req) => `link:${req.path.split('/').filter(Boolean).pop() || req.ip}`,
    message: limited('Too many location updates for this Rider Link.'),
    standardHeaders: true,
    legacyHeaders: false,
  }, 'rl:rider-ping:');
  app.use('/api/v1/tracking/ping', riderPingLimiter);
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
