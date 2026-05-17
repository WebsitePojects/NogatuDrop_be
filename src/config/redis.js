const Redis = require('ioredis');
const env = require('./env');

function toRegexFromRedisPattern(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

function createInMemoryRedis() {
  const store = new Map();

  function readValue(key) {
    const item = store.get(key);
    if (!item) return null;

    if (item.expiresAt && Date.now() > item.expiresAt) {
      store.delete(key);
      return null;
    }

    return item.value;
  }

  return {
    async get(key) {
      return readValue(key);
    },
    async set(key, value) {
      store.set(key, { value, expiresAt: null });
      return 'OK';
    },
    async setex(key, seconds, value) {
      const expiresAt = Date.now() + Number(seconds) * 1000;
      store.set(key, { value, expiresAt });
      return 'OK';
    },
    async del(...keys) {
      const flattened = keys.flat();
      let deleted = 0;
      for (const key of flattened) {
        if (store.delete(key)) deleted += 1;
      }
      return deleted;
    },
    async keys(pattern) {
      const regex = toRegexFromRedisPattern(pattern);
      const matched = [];
      for (const key of store.keys()) {
        if (readValue(key) !== null && regex.test(key)) {
          matched.push(key);
        }
      }
      return matched;
    },
    async scan(cursor, matchKeyword, pattern, countKeyword, count) {
      const matched = await this.keys(pattern);
      const start = Number(cursor) || 0;
      const batchSize = Number(count) || matched.length || 10;
      const slice = matched.slice(start, start + batchSize);
      const nextCursor = start + batchSize >= matched.length ? '0' : String(start + batchSize);
      return [nextCursor, slice];
    },
  };
}

let redis;

if (!env.REDIS_ENABLED) {
  console.log('[Redis] Disabled via REDIS_ENABLED=false. Using in-memory fallback cache.');
  redis = createInMemoryRedis();
  redis.isInMemory = true;
} else {
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: false,
  });

  redis.on('error', (err) => {
    const details = err?.message || err?.code || String(err);
    const endpoint = `${err?.address || 'redis-host'}:${err?.port || 'redis-port'}`;
    console.error(`[Redis] Connection error (${endpoint}):`, details);
  });

  redis.on('connect', () => {
    console.log('[Redis] Connected successfully');
  });

  redis.isInMemory = false;
}

module.exports = redis;
