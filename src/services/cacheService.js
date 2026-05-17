const redis = require('../config/redis');

/**
 * Get cached value by key
 * @param {string} key
 * @returns {any|null} parsed value or null
 */
async function get(key) {
  const data = await redis.get(key);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * Set value in cache
 * @param {string} key
 * @param {any} value
 * @param {number} ttl - time to live in seconds
 */
async function set(key, value, ttl) {
  const serialized = JSON.stringify(value);
  if (ttl) {
    await redis.setex(key, ttl, serialized);
  } else {
    await redis.set(key, serialized);
  }
}

/**
 * Delete cached key(s)
 * @param {string|string[]} keys
 */
async function del(keys) {
  if (Array.isArray(keys)) {
    if (keys.length > 0) {
      if (typeof redis.unlink === 'function') {
        await redis.unlink(...keys);
      } else {
        await redis.del(...keys);
      }
    }
  } else {
    if (typeof redis.unlink === 'function') {
      await redis.unlink(keys);
    } else {
      await redis.del(keys);
    }
  }
}

async function listKeysByPattern(pattern) {
  if (typeof redis.scan !== 'function') {
    return redis.keys(pattern);
  }

  const keys = [];
  let cursor = '0';

  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(nextCursor);
    if (Array.isArray(batch) && batch.length > 0) {
      keys.push(...batch);
    }
  } while (cursor !== '0');

  return keys;
}

/**
 * Get from cache or fetch and store
 * @param {string} key
 * @param {number} ttl - seconds
 * @param {Function} fetchFn - async function that returns the data
 * @returns {any}
 */
async function getOrSet(key, ttl, fetchFn) {
  const cached = await get(key);
  if (cached !== null) return cached;

  const data = await fetchFn();
  await set(key, data, ttl);
  return data;
}

/**
 * Delete keys matching a pattern
 * @param {string} pattern
 */
async function delPattern(pattern) {
  const keys = await listKeysByPattern(pattern);
  if (keys.length > 0) {
    await del(keys);
  }
}

module.exports = { get, set, del, getOrSet, delPattern };
