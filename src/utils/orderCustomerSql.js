/**
 * SQL fragments that turn a public order's atomic customer columns into the display name and address
 * every screen, email and export shows.
 *
 * New orders store the name as first/middle/last/suffix and the address as a street line, a PSGC
 * barangay code and a postal code. City, province and region are joined from the PSGC tables, never
 * copied onto the order (3NF). Orders placed before that split only have the old single-text
 * customer_name / customer_address, so each expression falls back to that text.
 *
 * Usage: put orderCustomerJoins('o') after `FROM orders o` and select
 * `${orderCustomerNameSql('o')} AS customer_name`, `${orderCustomerAddressSql('o')} AS customer_address`.
 * The joins use fixed aliases (cust_brgy, cust_city, cust_prov, cust_reg), so use them once per query.
 */

// The alias is interpolated into SQL, so only plain identifiers written by developers are accepted.
function assertAlias(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`orderCustomerSql: invalid table alias "${alias}"`);
  }
  return alias;
}

function orderCustomerJoins(orderAlias = 'o') {
  const o = assertAlias(orderAlias);
  return `LEFT JOIN ph_barangays cust_brgy ON cust_brgy.code = ${o}.customer_barangay_code
    LEFT JOIN ph_cities_municipalities cust_city ON cust_city.code = cust_brgy.city_code
    LEFT JOIN ph_provinces cust_prov ON cust_prov.code = cust_city.province_code
    LEFT JOIN ph_regions cust_reg ON cust_reg.code = COALESCE(cust_prov.region_code, cust_city.region_code)`;
}

function orderCustomerNameSql(orderAlias = 'o') {
  const o = assertAlias(orderAlias);
  return `CASE WHEN ${o}.customer_last_name IS NOT NULL
    THEN CONCAT_WS(' ', ${o}.customer_first_name, ${o}.customer_middle_name, ${o}.customer_last_name, ${o}.customer_name_suffix)
    ELSE ${o}.customer_name END`;
}

// Cities outside any province (Metro Manila, Isabela City, Cotabato City) show their region instead.
function orderCustomerAddressSql(orderAlias = 'o') {
  const o = assertAlias(orderAlias);
  return `CASE WHEN ${o}.customer_barangay_code IS NOT NULL
    THEN CONCAT_WS(', ', ${o}.customer_address_line, cust_brgy.name, cust_city.name,
                   COALESCE(cust_prov.name, cust_reg.name), ${o}.customer_postal_code)
    ELSE ${o}.customer_address END`;
}

/** True when the order was placed by a public buyer (works for both old and new name storage). */
function orderIsPublicSql(orderAlias = 'o') {
  const o = assertAlias(orderAlias);
  return `(${o}.placed_by_type = 'public'
    OR (${o}.placed_by IS NULL AND (${o}.customer_name IS NOT NULL OR ${o}.customer_last_name IS NOT NULL)))`;
}

module.exports = {
  orderCustomerJoins,
  orderCustomerNameSql,
  orderCustomerAddressSql,
  orderIsPublicSql,
};
