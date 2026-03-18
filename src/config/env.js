// Validated environment variables with defaults
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
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || 'http://localhost:5173',

  // Rate limiting
  RATE_LIMIT_ENABLED:
    (process.env.RATE_LIMIT_ENABLED || (process.env.NODE_ENV === 'production' ? 'true' : 'false')).toLowerCase() === 'true',

  // SMS
  SEMAPHORE_API_KEY: process.env.SEMAPHORE_API_KEY || '',

  // Google Maps
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',

  // File Upload
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 5,

  // Cron
  REPLENISH_CRON: process.env.REPLENISH_CRON || '*/15 * * * *',
  GPS_PING_INTERVAL_SECONDS: parseInt(process.env.GPS_PING_INTERVAL_SECONDS, 10) || 30,
};

module.exports = env;
