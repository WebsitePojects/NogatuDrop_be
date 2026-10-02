/**
 * Read-only lookups over the PSGC reference tables (scripts/addPhLocations.js) for checkout's
 * region → province → city/municipality → barangay pickers. Every list is one indexed query.
 */

const NCR_REGION_CODE = '130000000';
// Number-aware ordering so "Barangay 2" comes before "Barangay 10" (Metro Manila numbers most barangays).
const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Metro Manila first: it is where most public orders ship.
async function listRegions(db) {
  const [rows] = await db.execute(
    'SELECT code, name FROM ph_regions ORDER BY code = ? DESC, name',
    [NCR_REGION_CODE]
  );
  return rows;
}

/**
 * Provinces of a region, plus how many of its cities belong to no province. Metro Manila has no
 * provinces at all, and two cities elsewhere (Isabela, Cotabato) are independent, so the picker shows
 * those under one extra "province" choice.
 */
async function listProvinces(db, regionCode) {
  const [[provinces], [[{ independent }]]] = await Promise.all([
    db.execute('SELECT code, name FROM ph_provinces WHERE region_code = ? ORDER BY name', [regionCode]),
    db.execute('SELECT COUNT(*) AS independent FROM ph_cities_municipalities WHERE region_code = ?', [regionCode]),
  ]);
  return {
    provinces,
    independent_cities: Number(independent),
    independent_label: regionCode === NCR_REGION_CODE ? 'Metro Manila' : 'Cities not under a province',
  };
}

/** Cities/municipalities of one province, or the province-less cities of one region. */
async function listCities(db, { provinceCode, regionCode }) {
  const [rows] = provinceCode
    ? await db.execute(
      'SELECT code, name, is_city FROM ph_cities_municipalities WHERE province_code = ? ORDER BY name',
      [provinceCode]
    )
    : await db.execute(
      'SELECT code, name, is_city FROM ph_cities_municipalities WHERE region_code = ? ORDER BY name',
      [regionCode]
    );
  return rows.map((row) => ({ ...row, is_city: Boolean(row.is_city) }));
}

async function listBarangays(db, cityCode) {
  const [rows] = await db.execute('SELECT code, name FROM ph_barangays WHERE city_code = ?', [cityCode]);
  return rows.sort((a, b) => naturalOrder.compare(a.name, b.name));
}

module.exports = { NCR_REGION_CODE, listRegions, listProvinces, listCities, listBarangays };
