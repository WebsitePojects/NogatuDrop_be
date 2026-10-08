// Store-order territories (management, 2026-10-08): a Stockist fulfils store orders from the provinces and
// cities Super Admin assigned to it (stockist_territories). Everything else, and every affiliate-link order,
// goes to the nearer of the company centers (Caloocan, Tycoon).

/**
 * Stockists whose territory contains the buyer's barangay, city territory before province territory
 * (the more specific assignment wins), each with its active warehouse. Empty when nobody covers the area.
 * One indexed lookup: barangay -> city -> (city | province) territory -> active partner -> warehouse.
 */
async function findTerritoryStockists(db, barangayCode) {
  if (!barangayCode) return [];
  const [rows] = await db.execute(
    `SELECT t.partner_id, t.area_type, w.id AS warehouse_id, w.lat, w.lng
     FROM ph_barangays b
     JOIN ph_cities_municipalities c ON c.code = b.city_code
     JOIN stockist_territories t
       ON (t.area_type = 'city' AND t.area_code = c.code)
       OR (t.area_type = 'province' AND t.area_code = c.province_code)
     JOIN partners p ON p.id = t.partner_id
     JOIN warehouses w ON w.partner_id = p.id
     WHERE b.code = ?
       AND p.is_deleted = 0 AND p.status = 'active'
       AND p.stockist_level IN ('provincial_stockist', 'city_stockist')
       AND w.is_deleted = 0 AND w.is_active = 1
     ORDER BY (t.area_type = 'city') DESC, w.id ASC`,
    [barangayCode]
  );
  return rows;
}

module.exports = { findTerritoryStockists };
