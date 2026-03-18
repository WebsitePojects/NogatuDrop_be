const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const env = require('./config/env');
const routes = require('./routes/index');
const ApiError = require('./utils/ApiError');

const app = express();

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: env.ALLOWED_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { success: false, message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);
}

// Static uploads
app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR)));

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
  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    err = ApiError.badRequest(`File too large. Maximum size is ${env.MAX_FILE_SIZE_MB}MB`);
  }

  const statusCode = err.statusCode || 500;
  const error = err.message || 'Internal server error';

  if (env.NODE_ENV !== 'production') {
    console.error('[Error]', err);
  }

  res.status(statusCode).json({
    success: false,
    error,
    message: error,
    details: Array.isArray(err.details) ? err.details : [],
    ...(env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

module.exports = app;
