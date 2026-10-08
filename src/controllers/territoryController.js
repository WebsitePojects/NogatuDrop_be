const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

// Super Admin assigns the provinces and cities a Stockist serves for store orders (management,
// 2026-10-08). Routing reads them in services/territoryRouting.js.

const STOCKIST_LEVELS = ['provincial_stockist', 'city_stockist'];
const AREA_TABLE = { province: 'ph_provinces', city: 'ph_cities_municipalities' };

async function loadStockist(db, partnerId) {
  const [rows] = await db.execute(
    `SELECT p.id, p.business_name, p.stockist_level, p.barangay_code,
            c.code AS city_code, c.name AS city_name, c.province_code, pr.name AS province_name
     FROM partners p
     LEFT JOIN ph_barangays b ON b.code = p.barangay_code
     LEFT JOIN ph_cities_municipalities c ON c.code = b.city_code
     LEFT JOIN ph_provinces pr ON pr.code = c.province_code
     WHERE p.id = ? AND p.is_deleted = 0 LIMIT 1`,
    [partnerId]
  );
  if (rows.length === 0) throw ApiError.notFound('Stockist not found');
  return rows[0];
}

async function listAreas(db, partnerId) {
  const [rows] = await db.execute(
    `SELECT t.area_type, t.area_code,
            COALESCE(pr.name, c.name) AS area_name,
            CASE WHEN t.area_type = 'city' THEN cp.name END AS province_name
     FROM stockist_territories t
     LEFT JOIN ph_provinces pr ON t.area_type = 'province' AND pr.code = t.area_code
     LEFT JOIN ph_cities_municipalities c ON t.area_type = 'city' AND c.code = t.area_code
     LEFT JOIN ph_provinces cp ON cp.code = c.province_code
     WHERE t.partner_id = ?
     ORDER BY t.area_type DESC, area_name ASC`,
    [partnerId]
  );
  return rows;
}

/** What to offer when nothing is assigned yet: a City Stockist's city, a Provincial Stockist's province. */
function suggestedArea(stockist) {
  if (stockist.stockist_level === 'city_stockist' && stockist.city_code) {
    return { area_type: 'city', area_code: stockist.city_code, area_name: stockist.city_name };
  }
  if (stockist.stockist_level === 'provincial_stockist' && stockist.province_code) {
    return { area_type: 'province', area_code: stockist.province_code, area_name: stockist.province_name };
  }
  return null;
}

// GET /api/v1/partners/:id/territories
const getTerritories = asyncHandler(async (req, res) => {
  const stockist = await loadStockist(pool, req.params.id);
  const areas = await listAreas(pool, stockist.id);
  res.json({
    success: true,
    data: { areas, suggested: areas.length ? null : suggestedArea(stockist), can_have_territory: STOCKIST_LEVELS.includes(stockist.stockist_level) },
  });
});

// PUT /api/v1/partners/:id/territories  { areas: [{ area_type: 'province'|'city', area_code }] }
// Replaces the Stockist's whole list in one transaction, so sending the same list twice changes nothing.
// An area held by another Stockist is refused with its name (409), never silently taken over.
const setTerritories = asyncHandler(async (req, res) => {
  // The same area sent twice counts once.
  const areas = [...new Map(req.body.areas.map((a) => [`${a.area_type}:${a.area_code}`, a])).values()];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [locked] = await conn.execute('SELECT id FROM partners WHERE id = ? AND is_deleted = 0 FOR UPDATE', [req.params.id]);
    if (locked.length === 0) throw ApiError.notFound('Stockist not found');
    const stockist = await loadStockist(conn, req.params.id);
    if (!STOCKIST_LEVELS.includes(stockist.stockist_level)) {
      throw ApiError.badRequest('Only Provincial and City Stockists have a territory. Centers serve everyone else.');
    }

    for (const area of areas) {
      const [found] = await conn.execute(`SELECT code FROM ${AREA_TABLE[area.area_type]} WHERE code = ? LIMIT 1`, [area.area_code]);
      if (found.length === 0) throw ApiError.badRequest(`Unknown ${area.area_type} code ${area.area_code}`);
      const [holder] = await conn.execute(
        `SELECT p.business_name FROM stockist_territories t JOIN partners p ON p.id = t.partner_id
         WHERE t.area_type = ? AND t.area_code = ? AND t.partner_id <> ? LIMIT 1`,
        [area.area_type, area.area_code, stockist.id]
      );
      if (holder.length > 0) {
        throw ApiError.conflict(`${holder[0].business_name} already serves this ${area.area_type}. Remove it there first.`);
      }
    }

    // An assignment row, not a business record: the list is replaced as a whole, and a soft-deleted row
    // would keep holding its area against the unique key.
    await conn.execute('DELETE FROM stockist_territories WHERE partner_id = ?', [stockist.id]);
    for (const area of areas) {
      await conn.execute(
        'INSERT INTO stockist_territories (partner_id, area_type, area_code, created_by) VALUES (?, ?, ?, ?)',
        [stockist.id, area.area_type, area.area_code, req.user.id]
      );
    }
    await conn.commit();
    res.json({ success: true, message: 'Territory saved', data: { areas: await listAreas(pool, stockist.id) } });
  } catch (err) {
    await conn.rollback();
    // Two saves claiming the same area at the same moment: the unique key stops the second one.
    if (err.code === 'ER_DUP_ENTRY') throw ApiError.conflict('Another Stockist was just given one of these areas. Refresh and try again.');
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = { getTerritories, setTerritories };
