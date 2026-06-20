START TRANSACTION;

SET @role_super_admin = (SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1);
SET @role_provincial_stockist = (SELECT id FROM roles WHERE slug = 'provincial_stockist' LIMIT 1);
SET @role_city_stockist = (SELECT id FROM roles WHERE slug = 'city_stockist' LIMIT 1);
SET @role_staff = (SELECT id FROM roles WHERE slug = 'staff' LIMIT 1);
SET @role_mobile_stockist = (SELECT id FROM roles WHERE slug = 'mobile_stockist' LIMIT 1);

SET @provincial_partner_id = 2;
SET @city_partner_id = 4;

UPDATE partners
SET parent_partner_id = @provincial_partner_id,
    status = 'active'
WHERE id = @city_partner_id
  AND is_deleted = 0;

INSERT INTO users (
  name, email, password, phone, role_id, partner_id, level, location, status, is_deleted, created_at, updated_at
)
SELECT
  'Provincial Stockist',
  'provincial@nogatu.com',
  '1',
  '09990000010',
  @role_provincial_stockist,
  @provincial_partner_id,
  'provincial',
  'Cebu Regional Hub',
  'active',
  0,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = 'provincial@nogatu.com' LIMIT 1
);

INSERT INTO users (
  name, email, password, phone, role_id, partner_id, level, location, status, is_deleted, created_at, updated_at
)
SELECT
  'Provincial Staff',
  'provincialstaff@nogatu.com',
  '1',
  '09990000011',
  @role_staff,
  @provincial_partner_id,
  'provincial',
  'Cebu Regional Hub',
  'active',
  0,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = 'provincialstaff@nogatu.com' LIMIT 1
);

INSERT INTO users (
  name, email, password, phone, role_id, partner_id, level, location, status, is_deleted, created_at, updated_at
)
SELECT
  'City Staff',
  'citystaff@nogatu.com',
  '1',
  '09990000012',
  @role_staff,
  @city_partner_id,
  'city',
  'Southern Beverages Co. Hub',
  'active',
  0,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = 'citystaff@nogatu.com' LIMIT 1
);

UPDATE users
SET
  name = 'Super Admin',
  password = '1',
  role_id = @role_super_admin,
  partner_id = NULL,
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email = 'superadmin@nogatu.com';

UPDATE users
SET
  name = 'Provincial Stockist',
  password = '1',
  role_id = @role_provincial_stockist,
  partner_id = @provincial_partner_id,
  level = 'provincial',
  location = 'Cebu Regional Hub',
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email = 'provincial@nogatu.com';

UPDATE users
SET
  name = 'Provincial Staff',
  password = '1',
  role_id = @role_staff,
  partner_id = @provincial_partner_id,
  level = 'provincial',
  location = 'Cebu Regional Hub',
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email IN ('provincialstaff@nogatu.com', 'staff@nogatu.com');

UPDATE users
SET
  name = 'City Stockist',
  password = '1',
  role_id = @role_city_stockist,
  partner_id = @city_partner_id,
  level = 'city',
  location = 'Southern Beverages Co. Hub',
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email = 'city@nogatu.com';

UPDATE users
SET
  name = 'City Staff',
  password = '1',
  role_id = @role_staff,
  partner_id = @city_partner_id,
  level = 'city',
  location = 'Southern Beverages Co. Hub',
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email IN ('citystaff@nogatu.com', 'gabrielsy@nogatu.com');

UPDATE users
SET
  name = 'Mobile Stockist',
  password = '1',
  role_id = @role_mobile_stockist,
  partner_id = @city_partner_id,
  level = 'city',
  location = 'Southern Beverages Co. Hub',
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email = 'mobile@nogatu.com';

INSERT INTO mobile_stockists (
  partner_id, name, email, phone, address, status, user_id, is_deleted, created_at, updated_at
)
SELECT
  @city_partner_id,
  'Mobile Stockist',
  'mobile@nogatu.com',
  '09990000002',
  'Southern Beverages Co. Mobile Route',
  'active',
  (SELECT id FROM users WHERE email = 'mobile@nogatu.com' LIMIT 1),
  0,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM mobile_stockists WHERE email = 'mobile@nogatu.com' LIMIT 1
);

UPDATE mobile_stockists
SET
  partner_id = @city_partner_id,
  name = 'Mobile Stockist',
  phone = '09990000002',
  address = 'Southern Beverages Co. Mobile Route',
  status = 'active',
  user_id = (SELECT id FROM users WHERE email = 'mobile@nogatu.com' LIMIT 1),
  is_deleted = 0,
  updated_at = NOW()
WHERE email = 'mobile@nogatu.com';

INSERT INTO settlements (
  settlement_number,
  order_id,
  partner_id,
  amount,
  method,
  status,
  expected_at,
  reconciled_at,
  reconciled_by,
  reference_number,
  variance_amount,
  notes,
  is_deleted,
  created_at,
  updated_at
)
SELECT
  CONCAT('SET-SEED-', LPAD(o.id, 4, '0')),
  o.id,
  o.partner_id,
  o.total_amount,
  CASE
    WHEN o.total_amount <= 5000 THEN 'cod'
    ELSE 'bank_transfer'
  END,
  CASE
    WHEN o.status = 'delivered' THEN 'reconciled'
    ELSE 'pending'
  END,
  COALESCE(o.approved_at, o.created_at),
  CASE
    WHEN o.status = 'delivered' THEN COALESCE(o.delivered_at, o.updated_at, o.created_at)
    ELSE NULL
  END,
  CASE
    WHEN o.status = 'delivered' THEN 1
    ELSE NULL
  END,
  CASE
    WHEN o.status = 'delivered' THEN CONCAT('AUTO-', o.order_number)
    ELSE NULL
  END,
  0.00,
  'Seeded from paid operational orders to bootstrap Settlement Monitor.',
  0,
  o.created_at,
  NOW()
FROM orders o
WHERE o.is_deleted = 0
  AND o.payment_status = 'paid'
  AND NOT EXISTS (
    SELECT 1
    FROM settlements s
    WHERE s.order_id = o.id
      AND s.is_deleted = 0
  );

COMMIT;

SELECT
  u.email,
  u.name,
  r.slug AS role_slug,
  u.partner_id,
  p.business_name,
  p.stockist_level,
  p.parent_partner_id,
  u.status
FROM users u
JOIN roles r ON r.id = u.role_id
LEFT JOIN partners p ON p.id = u.partner_id
WHERE u.email IN (
  'superadmin@nogatu.com',
  'provincial@nogatu.com',
  'provincialstaff@nogatu.com',
  'city@nogatu.com',
  'citystaff@nogatu.com',
  'mobile@nogatu.com'
)
ORDER BY FIELD(
  u.email,
  'superadmin@nogatu.com',
  'provincial@nogatu.com',
  'provincialstaff@nogatu.com',
  'city@nogatu.com',
  'citystaff@nogatu.com',
  'mobile@nogatu.com'
);

SELECT
  settlement_number,
  order_id,
  partner_id,
  amount,
  status,
  method
FROM settlements
WHERE is_deleted = 0
ORDER BY id DESC
LIMIT 12;
