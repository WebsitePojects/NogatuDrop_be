START TRANSACTION;

SET @role_city_stockist = (
  SELECT id FROM roles WHERE slug = 'city_stockist' LIMIT 1
);

UPDATE warehouses
SET partner_id = NULL
WHERE id = 1
  AND type = 'manufacturer';

UPDATE inventories
SET partner_id = NULL
WHERE warehouse_id = 1;

UPDATE warehouses
SET partner_id = CASE id
  WHEN 2 THEN 1
  WHEN 3 THEN 4
  WHEN 4 THEN 2
  WHEN 5 THEN 3
  WHEN 6 THEN 5
  ELSE partner_id
END
WHERE id IN (2, 3, 4, 5, 6);

UPDATE inventories
SET partner_id = CASE warehouse_id
  WHEN 2 THEN 1
  WHEN 3 THEN 4
  WHEN 4 THEN 2
  WHEN 5 THEN 3
  WHEN 6 THEN 5
  ELSE partner_id
END
WHERE warehouse_id IN (2, 3, 4, 5, 6);

UPDATE users
SET partner_id = 4
WHERE email = 'city@nogatu.com';

UPDATE users
SET role_id = @role_city_stockist
WHERE email IN ('carlos@nogatu.com', 'gabriel@nogatu.com');

UPDATE mobile_stockists ms
JOIN users u ON u.email = 'mobile@nogatu.com'
SET ms.user_id = u.id,
    ms.name = u.name,
    ms.email = u.email,
    ms.phone = u.phone,
    ms.partner_id = u.partner_id,
    ms.status = 'active'
WHERE ms.id = 1;

UPDATE orders
SET placed_by = 4
WHERE id IN (18, 19);

UPDATE orders
SET placed_by = 12
WHERE id = 20;

COMMIT;

SELECT 'users' AS entity, u.email AS reference_key, r.slug AS role_slug, u.partner_id, p.business_name, p.stockist_level
FROM users u
JOIN roles r ON r.id = u.role_id
LEFT JOIN partners p ON p.id = u.partner_id
WHERE u.email IN (
  'provincial@nogatu.com',
  'city@nogatu.com',
  'mobile@nogatu.com',
  'staff@nogatu.com',
  'carlos@nogatu.com',
  'gabriel@nogatu.com'
)
ORDER BY u.email;

SELECT 'mobile_stockists' AS entity, id, email, user_id, partner_id, status
FROM mobile_stockists
WHERE id = 1;

SELECT 'warehouses' AS entity, id, name, type, partner_id
FROM warehouses
WHERE id IN (1, 2, 3, 4, 5, 6)
ORDER BY id;
