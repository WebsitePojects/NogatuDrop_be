/**
 * SQL fragments that return a record's address parts and its composed display address, for the
 * records that store an address as parts (warehouses, partners, mobile_stockists).
 *
 * The edit form needs the region, province and city codes to prefill its pickers; they are joined
 * from the PSGC tables rather than stored on the record (3NF). `address_display` is composed from the
 * parts, and falls back to the record's old single-text column for rows saved before the parts existed.
 *
 * Usage: put addressPartsJoins('w') after `FROM warehouses w` and add addressPartsSelect('w', 'location')
 * to the select list. The joins use fixed aliases (addr_brgy, addr_city, addr_prov, addr_reg), so use
 * them once per query.
 */

// Aliases and column names are interpolated into SQL, so only plain identifiers written by
// developers are accepted.
function assertIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`addressPartsSql: invalid identifier "${name}"`);
  }
  return name;
}

function addressPartsJoins(alias) {
  const a = assertIdentifier(alias);
  return `LEFT JOIN ph_barangays addr_brgy ON addr_brgy.code = ${a}.barangay_code
    LEFT JOIN ph_cities_municipalities addr_city ON addr_city.code = addr_brgy.city_code
    LEFT JOIN ph_provinces addr_prov ON addr_prov.code = addr_city.province_code
    LEFT JOIN ph_regions addr_reg ON addr_reg.code = COALESCE(addr_prov.region_code, addr_city.region_code)`;
}

// Cities outside any province (Metro Manila, Isabela City, Cotabato City) show their region instead.
function addressPartsSelect(alias, legacyColumn) {
  const a = assertIdentifier(alias);
  const legacy = assertIdentifier(legacyColumn);
  return `${a}.address_line, ${a}.barangay_code, ${a}.postal_code,
    addr_brgy.city_code AS address_city_code,
    addr_city.province_code AS address_province_code,
    COALESCE(addr_prov.region_code, addr_city.region_code) AS address_region_code,
    CASE WHEN ${a}.barangay_code IS NOT NULL
      THEN CONCAT_WS(', ', ${a}.address_line, addr_brgy.name, addr_city.name,
                     COALESCE(addr_prov.name, addr_reg.name), ${a}.postal_code)
      ELSE ${a}.${legacy} END AS address_display`;
}

module.exports = { addressPartsJoins, addressPartsSelect };
