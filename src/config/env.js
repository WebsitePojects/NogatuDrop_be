// Validated environment variables
// Loaded via --env-file flag in package.json scripts

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 5000,

  // Database
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: parseInt(process.env.DB_PORT, 10) || 3306,
  DB_NAME: process.env.DB_NAME || 'nogatu_ncdms',
  DB_USER: process.env.DB_USER || 'root',
  DB_PASSWORD: process.env.DB_PASSWORD || '',
  DB_POOL_SIZE: parseInt(process.env.DB_POOL_SIZE, 10) || 10,

  // Redis
  REDIS_ENABLED: (process.env.REDIS_ENABLED || 'true').toLowerCase() === 'true',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // JWT
  JWT_SECRET: process.env.JWT_SECRET || 'change_me',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'change_me_refresh',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // CORS
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173',
  CORS_ALLOW_ALL: (process.env.CORS_ALLOW_ALL || 'false').toLowerCase() === 'true',

  // Brevo (transactional email — replaces SMS)
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  EMAIL_FROM: 'noreply@nogatu.store',
  EMAIL_FROM_NAME: 'Nogatu',

  // Cloudinary (file storage — replaces local uploads)
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',

  // Google Maps
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',

  // Alliance API bridge
  ALLIANCE_API_KEY: process.env.ALLIANCE_API_KEY || '',

  MLM_API_URL: process.env.MLM_API_URL || '',
  MLM_API_KEY: process.env.MLM_API_KEY || '',

  // Public base URL (for magic links)
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:5173',

  // Business rules
  PAYMENT_DEADLINE_HOURS: parseInt(process.env.PAYMENT_DEADLINE_HOURS, 10) || 24,

  // Rate limiting
  RATE_LIMIT_ENABLED:
    (process.env.RATE_LIMIT_ENABLED || (process.env.NODE_ENV === 'production' ? 'true' : 'false')).toLowerCase() === 'true',

  // File size limit (MB)
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 5,

  // Cron schedules
  REPLENISH_CRON: process.env.REPLENISH_CRON || '*/15 * * * *',
  PAYMENT_DEADLINE_CRON: process.env.PAYMENT_DEADLINE_CRON || '*/5 * * * *',
  EXPIRY_ALERT_CRON: process.env.EXPIRY_ALERT_CRON || '0 8 * * *',
  TOKEN_CLEANUP_CRON: process.env.TOKEN_CLEANUP_CRON || '0 3 * * *',
};

module.exports = env;
