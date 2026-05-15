-- Add/repair role-based login accounts for city and mobile access
-- Safe intent:
-- 1. Ensure city_stockist and mobile_stockist roles exist
-- 2. Create or update city@nogatu.com
-- 3. Create or update mobile@nogatu.com
-- 4. Link mobile@nogatu.com to mobile_stockists if that table exists
--
-- Default password in this script: 1
-- The backend supports legacy plaintext passwords and will migrate them to bcrypt
-- automatically on first successful login.
--
-- Before running:
-- - Review @city_partner_id and @mobile_parent_partner_id below
-- - Change them if you want a different city stockist / mobile stockist parent

SET @city_email := 'city@nogatu.com';
SET @mobile_email := 'mobile@nogatu.com';
SET @default_password := '1';

-- Choose the city stockist partner that should own city@nogatu.com
-- Based on local SQL dump, partners 4, 5, 6 are city stockists after migration.
SET @city_partner_id := 4;

-- Choose which stockist owns mobile@nogatu.com.
-- Usually this should be the same city stockist partner.
SET @mobile_parent_partner_id := 4;

SET @city_name := 'City Stockist';
SET @mobile_name := 'Mobile Stockist';
SET @city_phone := '09990000001';
SET @mobile_phone := '09990000002';
SET @default_location := 'Regional Hub - North';

START TRANSACTION;

-- ------------------------------------------------------------
-- Ensure required roles exist
-- ------------------------------------------------------------

SET @city_role_id := (
  SELECT id FROM roles WHERE slug = 'city_stockist' LIMIT 1
);

SET @mobile_role_id := (
  SELECT id FROM roles WHERE slug = 'mobile_stockist' LIMIT 1
);

-- If production still has the old admin slug but not city_stockist,
-- convert that role in place so the frontend routes correctly.
UPDATE roles
SET slug = 'city_stockist',
    name = 'City Stockist'
WHERE slug = 'admin'
  AND @city_role_id IS NULL;

SET @city_role_id := (
  SELECT id FROM roles WHERE slug = 'city_stockist' LIMIT 1
);

-- If city_stockist still does not exist, create it.
INSERT INTO roles (name, slug, permissions, created_at)
SELECT
  'City Stockist',
  'city_stockist',
  '{"dashboard":["view"],"catalog":["view"],"cart":["view","create","edit","delete"],"orders":["view","create","cancel"],"reports":["view"],"users":["view","create_staff"],"grn":["view","create","complete"],"mobile_stockists":["view","create","edit"],"stock_transfers":["view","create"],"purchase_orders":["view","create"],"inventory":["view","request_adjustment"],"warehouses":["view"],"notifications":["view"],"tracking":["view"]}',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE slug = 'city_stockist'
);

SET @city_role_id := (
  SELECT id FROM roles WHERE slug = 'city_stockist' LIMIT 1
);

-- Create mobile_stockist role if missing.
INSERT INTO roles (name, slug, permissions, created_at)
SELECT
  'Mobile Stockist',
  'mobile_stockist',
  '{"dashboard":["view"],"catalog":["view"],"cart":["view","create","edit","delete"],"orders":["view","create"],"profile":["view","edit"],"tracking":["view"]}',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE slug = 'mobile_stockist'
);

SET @mobile_role_id := (
  SELECT id FROM roles WHERE slug = 'mobile_stockist' LIMIT 1
);

-- ------------------------------------------------------------
-- Validate partner ownership targets
-- ------------------------------------------------------------

-- Make sure the selected city partner exists and is active.
-- If you want to enforce stockist_level, do that in the manual pre-check query.
SELECT id, business_name, email, status
FROM partners
WHERE id = @city_partner_id
LIMIT 1;

SELECT id, business_name, email, status
FROM partners
WHERE id = @mobile_parent_partner_id
LIMIT 1;

-- ------------------------------------------------------------
-- Upsert city login
-- ------------------------------------------------------------

INSERT INTO users (
  name, email, password, phone, role_id, partner_id, level, location, status, is_deleted, created_at, updated_at
)
SELECT
  @city_name,
  @city_email,
  @default_password,
  @city_phone,
  @city_role_id,
  @city_partner_id,
  'city',
  @default_location,
  'active',
  0,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = @city_email LIMIT 1
);

UPDATE users
SET
  name = @city_name,
  password = @default_password,
  phone = COALESCE(phone, @city_phone),
  role_id = @city_role_id,
  partner_id = @city_partner_id,
  level = 'city',
  location = COALESCE(location, @default_location),
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email = @city_email;

-- ------------------------------------------------------------
-- Upsert mobile login
-- ------------------------------------------------------------

INSERT INTO users (
  name, email, password, phone, role_id, partner_id, level, location, status, is_deleted, created_at, updated_at
)
SELECT
  @mobile_name,
  @mobile_email,
  @default_password,
  @mobile_phone,
  @mobile_role_id,
  @mobile_parent_partner_id,
  'city',
  @default_location,
  'active',
  0,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = @mobile_email LIMIT 1
);

UPDATE users
SET
  name = @mobile_name,
  password = @default_password,
  phone = COALESCE(phone, @mobile_phone),
  role_id = @mobile_role_id,
  partner_id = @mobile_parent_partner_id,
  level = 'city',
  location = COALESCE(location, @default_location),
  status = 'active',
  is_deleted = 0,
  updated_at = NOW()
WHERE email = @mobile_email;

-- ------------------------------------------------------------
-- Link mobile user into mobile_stockists table if that table exists
-- ------------------------------------------------------------

SET @mobile_user_id := (
  SELECT id FROM users WHERE email = @mobile_email LIMIT 1
);

SET @mobile_stockists_table_exists := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'mobile_stockists'
);

SET @mobile_email_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'mobile_stockists'
    AND column_name = 'email'
);

SET @mobile_user_id_col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'mobile_stockists'
    AND column_name = 'user_id'
);

SET @sql := IF(
  @mobile_stockists_table_exists = 1 AND @mobile_email_exists = 1,
  CONCAT(
    'INSERT INTO mobile_stockists (partner_id, name, email, phone, address, status',
    IF(@mobile_user_id_col_exists = 1, ', user_id', ''),
    ', created_at, updated_at) ',
    'SELECT ', @mobile_parent_partner_id, ', ''', @mobile_name, ''', ''', @mobile_email, ''', ''', @mobile_phone, ''', ''Mobile Stockist Account'', ''active''',
    IF(@mobile_user_id_col_exists = 1, CONCAT(', ', @mobile_user_id), ''),
    ', NOW(), NOW() ',
    'WHERE NOT EXISTS (SELECT 1 FROM mobile_stockists WHERE email = ''', @mobile_email, ''' LIMIT 1)'
  ),
  'SELECT ''mobile_stockists table not present, skipping insert'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  @mobile_stockists_table_exists = 1 AND @mobile_email_exists = 1 AND @mobile_user_id_col_exists = 1,
  CONCAT(
    'UPDATE mobile_stockists SET ',
    'partner_id = ', @mobile_parent_partner_id, ', ',
    'name = ''', @mobile_name, ''', ',
    'phone = COALESCE(phone, ''', @mobile_phone, '''), ',
    'status = ''active'', ',
    'user_id = ', @mobile_user_id, ', ',
    'is_deleted = 0, ',
    'updated_at = NOW() ',
    'WHERE email = ''', @mobile_email, ''''
  ),
  'SELECT ''mobile_stockists user_id linkage skipped'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

COMMIT;

-- ------------------------------------------------------------
-- Verification output
-- ------------------------------------------------------------

SELECT u.id, u.name, u.email, u.role_id, r.slug AS role_slug, u.partner_id, u.status, u.is_deleted
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE u.email IN (@city_email, @mobile_email);

SET @sql := IF(
  @mobile_stockists_table_exists = 1,
  CONCAT('SELECT * FROM mobile_stockists WHERE email = ''', @mobile_email, ''''),
  'SELECT ''mobile_stockists table not present, final verification skipped'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
