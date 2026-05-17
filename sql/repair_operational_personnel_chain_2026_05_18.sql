START TRANSACTION;

SET @role_super_admin = (
  SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1
);
SET @role_provincial_stockist = (
  SELECT id FROM roles WHERE slug = 'provincial_stockist' LIMIT 1
);
SET @role_city_stockist = (
  SELECT id FROM roles WHERE slug = 'city_stockist' LIMIT 1
);
SET @role_staff = (
  SELECT id FROM roles WHERE slug = 'staff' LIMIT 1
);
SET @role_mobile_stockist = (
  SELECT id FROM roles WHERE slug = 'mobile_stockist' LIMIT 1
);

-- Canonical operational chain for docs and smoke:
-- superadmin -> provincial@ (partner 2 Cebu Distributors Inc.)
-- provincial staff -> staff@
-- city@ under partner 4, which rolls up to provincial partner 2
-- city staff -> gabrielsy@
-- mobile@ under the same city partner 4

UPDATE partners
SET parent_partner_id = 2,
    status = 'active'
WHERE id = 4
  AND stockist_level = 'city_stockist'
  AND is_deleted = 0;

UPDATE users
SET role_id = @role_super_admin,
    partner_id = NULL,
    status = 'active'
WHERE email = 'superadmin@nogatu.com';

UPDATE users
SET role_id = @role_provincial_stockist,
    partner_id = 2,
    status = 'active'
WHERE email = 'provincial@nogatu.com';

UPDATE users
SET role_id = @role_staff,
    partner_id = 2,
    status = 'active'
WHERE email = 'staff@nogatu.com';

UPDATE users
SET role_id = @role_city_stockist,
    partner_id = 4,
    status = 'active'
WHERE email = 'city@nogatu.com';

UPDATE users
SET role_id = @role_staff,
    partner_id = 4,
    status = 'active'
WHERE email = 'gabrielsy@nogatu.com';

UPDATE users
SET role_id = @role_mobile_stockist,
    partner_id = 4,
    status = 'active'
WHERE email = 'mobile@nogatu.com';

UPDATE mobile_stockists ms
JOIN users u ON u.email = 'mobile@nogatu.com'
SET ms.user_id = u.id,
    ms.name = u.name,
    ms.email = u.email,
    ms.phone = u.phone,
    ms.partner_id = 4,
    ms.status = 'active'
WHERE ms.id = 1;

UPDATE orders
SET partner_id = 4
WHERE placed_by = (
  SELECT id FROM users WHERE email = 'mobile@nogatu.com' LIMIT 1
)
  AND is_deleted = 0;

UPDATE orders
SET partner_id = 2
WHERE placed_by = (
  SELECT id FROM users WHERE email = 'staff@nogatu.com' LIMIT 1
)
  AND is_deleted = 0;

COMMIT;

SELECT
  'personnel_chain' AS entity,
  u.email,
  u.name,
  r.slug AS role_slug,
  u.partner_id,
  p.business_name,
  p.stockist_level,
  p.parent_partner_id
FROM users u
JOIN roles r ON r.id = u.role_id
LEFT JOIN partners p ON p.id = u.partner_id
WHERE u.email IN (
  'superadmin@nogatu.com',
  'provincial@nogatu.com',
  'staff@nogatu.com',
  'city@nogatu.com',
  'gabrielsy@nogatu.com',
  'mobile@nogatu.com'
)
ORDER BY FIELD(
  u.email,
  'superadmin@nogatu.com',
  'provincial@nogatu.com',
  'staff@nogatu.com',
  'city@nogatu.com',
  'gabrielsy@nogatu.com',
  'mobile@nogatu.com'
);

SELECT
  'mobile_stockist_link' AS entity,
  ms.id,
  ms.email,
  ms.user_id,
  ms.partner_id,
  ms.status
FROM mobile_stockists ms
WHERE ms.email = 'mobile@nogatu.com';
