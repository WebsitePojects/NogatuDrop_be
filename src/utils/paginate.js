const pool = require('../config/db');

/**
 * Pagination helper
 * @param {string} baseQuery - SQL SELECT query without LIMIT/OFFSET
 * @param {string} countQuery - SQL COUNT query
 * @param {Array} params - query parameters
 * @param {number} page - current page (1-based)
 * @param {number} limit - items per page
 * @returns {{ data: Array, pagination: object }}
 */
async function paginate(baseQuery, countQuery, params = [], page = 1, limit = 20) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (page - 1) * limit;

  const [rows] = await pool.execute(`${baseQuery} LIMIT ? OFFSET ?`, [
    ...params,
    String(limit),
    String(offset),
  ]);

  const [countRows] = await pool.execute(countQuery, params);
  const total = countRows[0].total;
  const totalPages = Math.ceil(total / limit);

  return {
    data: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

module.exports = paginate;
