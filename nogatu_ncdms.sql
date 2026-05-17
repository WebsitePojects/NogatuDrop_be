-- NogatuDS project database dump
-- Database: nogatu_ncdms
-- Exported at: 2026-05-17T16:40:05.747Z

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

--
-- Table structure for audit_logs
--
DROP TABLE IF EXISTS `audit_logs`;
CREATE TABLE `audit_logs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned DEFAULT NULL,
  `action` varchar(100) NOT NULL COMMENT 'e.g. CREATE, UPDATE, DELETE, APPROVE, LOGIN',
  `entity` varchar(100) NOT NULL COMMENT 'e.g. order, product, user, inventory',
  `entity_id` bigint(20) unsigned DEFAULT NULL,
  `details` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Before/after values or context' CHECK (json_valid(`details`)),
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_entity` (`entity`,`entity_id`),
  KEY `idx_action` (`action`),
  KEY `idx_created` (`created_at`),
  CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for audit_logs
--
INSERT INTO `audit_logs` (`id`, `user_id`, `action`, `entity`, `entity_id`, `details`, `ip_address`, `user_agent`, `created_at`) VALUES
(1, 1, 'LOGIN', 'user', 1, '{\"email\": \"pedro@nogatu.com\"}', '127.0.0.1', NULL, '2026-03-18 19:45:10'),
(2, 1, 'APPROVE', 'order', 1, '{\"old_status\": \"pending\", \"new_status\": \"approved\"}', '127.0.0.1', NULL, '2026-03-18 19:45:10'),
(3, 1, 'MARK_PAID', 'order', 1, '{\"payment_method\": \"bank_transfer\", \"amount\": 250000.00}', '127.0.0.1', NULL, '2026-03-18 19:45:10'),
(4, 4, 'CREATE', 'order', 6, '{\"total\": 15000.00, \"items\": 2}', '192.168.1.10', NULL, '2026-03-18 19:45:10'),
(5, 1, 'CREATE', 'stock_transfer', 2, '{\"from\": 1, \"to\": 4, \"product_id\": 5, \"qty\": 2000}', '127.0.0.1', NULL, '2026-03-18 19:45:10');


--
-- Table structure for bank_accounts
--
DROP TABLE IF EXISTS `bank_accounts`;
CREATE TABLE `bank_accounts` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `warehouse_id` bigint(20) unsigned DEFAULT NULL COMMENT 'NULL = company default account',
  `bank_name` varchar(100) NOT NULL,
  `account_name` varchar(150) NOT NULL,
  `account_number` varchar(50) NOT NULL,
  `account_type` varchar(50) NOT NULL DEFAULT 'Savings',
  `is_default` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = fallback when no warehouse match',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_warehouse` (`warehouse_id`),
  KEY `idx_default` (`is_default`),
  KEY `idx_bank_accounts_is_deleted` (`is_deleted`),
  CONSTRAINT `fk_ba_warehouse` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for bank_accounts
--
INSERT INTO `bank_accounts` (`id`, `warehouse_id`, `bank_name`, `account_name`, `account_number`, `account_type`, `is_default`, `is_active`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, NULL, 'BDO Unibank', 'Nogatu Alliance Corporation', '001234567890', 'Savings', 1, 1, 0, '2026-04-06 04:58:11', '2026-04-06 04:58:11'),
(2, 1, 'Metrobank', 'Nogatu Alliance - Metro Manila', '002345678901', 'Current', 0, 1, 0, '2026-04-06 04:58:11', '2026-04-06 04:58:11'),
(3, 4, 'BPI', 'Nogatu Alliance - Cebu', '003456789012', 'Savings', 0, 1, 0, '2026-04-06 04:58:11', '2026-04-06 04:58:11'),
(4, NULL, 'aa', 'a', 'a', 'Savings', 0, 1, 0, '2026-04-09 12:36:40', '2026-04-09 12:36:40');


--
-- Table structure for cart_items
--
DROP TABLE IF EXISTS `cart_items`;
CREATE TABLE `cart_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned NOT NULL,
  `product_id` bigint(20) unsigned NOT NULL,
  `quantity` int(10) unsigned NOT NULL DEFAULT 1,
  `added_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cart_user_product` (`user_id`,`product_id`),
  KEY `idx_user` (`user_id`),
  KEY `fk_cart_product` (`product_id`),
  CONSTRAINT `fk_cart_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `fk_cart_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=47 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for cart_items
--
INSERT INTO `cart_items` (`id`, `user_id`, `product_id`, `quantity`, `added_at`, `updated_at`) VALUES
(28, 4, 11, 1, '2026-04-14 07:21:44', '2026-04-14 07:21:44'),
(29, 4, 3, 1, '2026-04-14 07:21:45', '2026-04-14 07:21:45'),
(30, 4, 8, 3, '2026-04-14 07:21:46', '2026-04-14 10:57:01'),
(31, 4, 1, 1, '2026-04-14 07:21:46', '2026-04-14 07:21:46'),
(32, 4, 7, 1, '2026-04-14 07:21:47', '2026-04-14 07:21:47'),
(33, 4, 10, 1, '2026-04-14 07:21:48', '2026-04-14 07:21:48'),
(36, 4, 12, 1, '2026-04-14 10:56:55', '2026-04-14 10:56:55'),
(37, 4, 2, 4, '2026-04-14 10:56:56', '2026-04-14 10:56:58');


--
-- Table structure for couriers
--
DROP TABLE IF EXISTS `couriers`;
CREATE TABLE `couriers` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `code` varchar(20) NOT NULL COMMENT 'e.g. JT, LBC, FLASH',
  `tracking_url_template` varchar(300) DEFAULT NULL COMMENT 'URL with {tracking_number} placeholder',
  `contact_person` varchar(150) DEFAULT NULL,
  `contact_phone` varchar(30) DEFAULT NULL,
  `contact_email` varchar(150) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_couriers_is_deleted` (`is_deleted`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for couriers
--
INSERT INTO `couriers` (`id`, `name`, `code`, `tracking_url_template`, `contact_person`, `contact_phone`, `contact_email`, `is_active`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'J&T Express', 'JT', 'https://www.jtexpress.ph/index/query/gzquery.html?bills={tracking_number}', NULL, NULL, NULL, 1, 0, '2026-04-06 04:58:12', '2026-04-06 04:58:12'),
(2, 'LBC Express', 'LBC', 'https://www.lbcexpress.com/track/?tracking_no={tracking_number}', NULL, NULL, NULL, 1, 0, '2026-04-06 04:58:12', '2026-04-06 04:58:12'),
(3, 'Flash Express', 'FLASH', 'https://www.flashexpress.ph/tracking?snum={tracking_number}', NULL, NULL, NULL, 1, 0, '2026-04-06 04:58:12', '2026-04-06 04:58:12'),
(4, 'Grab Express', 'GRAB', NULL, NULL, NULL, NULL, 1, 0, '2026-04-06 04:58:12', '2026-04-06 04:58:12'),
(5, 'Lalamove', 'LALAMOVE', NULL, NULL, NULL, NULL, 1, 0, '2026-04-06 04:58:12', '2026-04-06 04:58:12');


--
-- Table structure for cycle_counts
--
DROP TABLE IF EXISTS `cycle_counts`;
CREATE TABLE `cycle_counts` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `count_number` varchar(50) NOT NULL,
  `warehouse_id` bigint(20) unsigned NOT NULL,
  `status` enum('draft','submitted','approved','rejected','cancelled') NOT NULL DEFAULT 'draft',
  `created_by` bigint(20) unsigned NOT NULL,
  `submitted_by` bigint(20) unsigned DEFAULT NULL,
  `submitted_at` timestamp NULL DEFAULT NULL,
  `reviewed_by` bigint(20) unsigned DEFAULT NULL,
  `reviewed_at` timestamp NULL DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `review_notes` text DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `count_number` (`count_number`),
  KEY `idx_cycle_counts_warehouse` (`warehouse_id`),
  KEY `idx_cycle_counts_status` (`status`),
  KEY `fk_cycle_counts_created_by` (`created_by`),
  KEY `fk_cycle_counts_submitted_by` (`submitted_by`),
  KEY `fk_cycle_counts_reviewed_by` (`reviewed_by`),
  CONSTRAINT `fk_cycle_counts_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_cycle_counts_reviewed_by` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cycle_counts_submitted_by` FOREIGN KEY (`submitted_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cycle_counts_warehouse` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Table data for cycle_counts
--
-- No rows for cycle_counts


--
-- Table structure for cycle_count_items
--
DROP TABLE IF EXISTS `cycle_count_items`;
CREATE TABLE `cycle_count_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `cycle_count_id` bigint(20) unsigned NOT NULL,
  `product_id` bigint(20) unsigned NOT NULL,
  `inventory_id` bigint(20) unsigned DEFAULT NULL,
  `system_qty` int(11) NOT NULL DEFAULT 0,
  `counted_qty` int(11) NOT NULL DEFAULT 0,
  `variance_qty` int(11) GENERATED ALWAYS AS (`counted_qty` - `system_qty`) STORED,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_cci_count` (`cycle_count_id`),
  KEY `idx_cci_product` (`product_id`),
  KEY `fk_cci_inventory` (`inventory_id`),
  CONSTRAINT `fk_cci_count` FOREIGN KEY (`cycle_count_id`) REFERENCES `cycle_counts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cci_inventory` FOREIGN KEY (`inventory_id`) REFERENCES `inventories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cci_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Table data for cycle_count_items
--
-- No rows for cycle_count_items


--
-- Table structure for delivery_tokens
--
DROP TABLE IF EXISTS `delivery_tokens`;
CREATE TABLE `delivery_tokens` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint(20) unsigned NOT NULL,
  `token` char(36) NOT NULL COMMENT 'UUID v4',
  `expires_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_used` tinyint(1) NOT NULL DEFAULT 0,
  `used_at` timestamp NULL DEFAULT NULL,
  `created_by` bigint(20) unsigned NOT NULL COMMENT 'Staff who generated the link',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token`),
  KEY `idx_order` (`order_id`),
  KEY `idx_expires` (`expires_at`),
  KEY `idx_used` (`is_used`),
  KEY `fk_dt_creator` (`created_by`),
  CONSTRAINT `fk_dt_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_dt_order_token` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=18 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for delivery_tokens
--
INSERT INTO `delivery_tokens` (`id`, `order_id`, `token`, `expires_at`, `is_used`, `used_at`, `created_by`, `created_at`) VALUES
(1, 21, '3e8d8b39-f5da-42e8-9459-1f992406e34d', '2026-04-09 12:34:23', 1, '2026-04-09 12:34:23', 1, '2026-04-09 12:07:40'),
(2, 20, 'e28f2590-fbf6-4f35-9e36-94cd1bda17d7', '2026-04-16 00:01:49', 0, NULL, 1, '2026-04-14 00:01:49'),
(3, 20, '4b423bb7-6fbb-4f6f-9fb7-49be2a815d27', '2026-04-16 00:23:38', 0, NULL, 1, '2026-04-14 00:23:38'),
(4, 20, '1e068001-96be-401d-a96a-54b24159a029', '2026-04-16 00:27:45', 0, NULL, 1, '2026-04-14 00:27:45'),
(5, 20, '9bbff3c6-cfe0-48db-a2a6-7d9ec75a5f29', '2026-04-16 00:28:48', 0, NULL, 1, '2026-04-14 00:28:48'),
(6, 20, 'f6c05cb4-19b5-4924-8acd-d1b7722993bc', '2026-04-16 00:30:13', 0, NULL, 1, '2026-04-14 00:30:13'),
(7, 20, 'e0e58e1c-bbc9-4d3b-beee-795d02aa421f', '2026-04-16 00:31:48', 0, NULL, 1, '2026-04-14 00:31:48'),
(8, 20, '52709790-65b3-4556-9abb-48457b45a80b', '2026-04-16 00:39:27', 0, NULL, 1, '2026-04-14 00:39:27'),
(9, 20, 'a471f6f0-25cc-49ad-94e2-13338e886ae9', '2026-04-16 00:41:15', 0, NULL, 1, '2026-04-14 00:41:15'),
(10, 20, '79dcc6bb-acc6-4f89-8d74-8b320bb82ac1', '2026-04-16 00:43:21', 0, NULL, 1, '2026-04-14 00:43:21'),
(11, 20, 'b921c5c9-9921-4675-874a-e2e8b69ff81a', '2026-04-16 00:46:49', 0, NULL, 1, '2026-04-14 00:46:49'),
(12, 20, 'f2125d59-e4b0-4d62-9ae8-9c75b0e4273d', '2026-04-16 00:53:02', 0, NULL, 1, '2026-04-14 00:53:02'),
(13, 20, '2c8ef976-820d-4448-8d40-bd62aecbe4fa', '2026-04-16 00:57:09', 0, NULL, 1, '2026-04-14 00:57:09'),
(14, 20, 'f1ec7e95-5d9e-446c-a638-8bd22ed1ed72', '2026-04-16 01:08:19', 0, NULL, 1, '2026-04-14 01:08:19'),
(15, 20, '3e993960-3d5e-4642-b51d-c7d29eb4f712', '2026-04-16 01:18:50', 0, NULL, 1, '2026-04-14 01:18:50'),
(16, 22, 'ed76d9e2-0dca-4846-a6a6-800e4d17806e', '2026-05-17 16:29:10', 1, '2026-05-17 16:29:10', 1, '2026-05-17 16:27:54'),
(17, 23, 'd78ffa28-3a7f-439b-95f4-7a28fcf0090f', '2026-05-18 00:04:09', 1, '2026-05-18 00:04:09', 1, '2026-05-17 19:46:45');


--
-- Table structure for delivery_tracking
--
DROP TABLE IF EXISTS `delivery_tracking`;
CREATE TABLE `delivery_tracking` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint(20) unsigned NOT NULL,
  `transfer_id` bigint(20) unsigned DEFAULT NULL,
  `rider_user_id` bigint(20) unsigned DEFAULT NULL COMMENT 'Staff assigned as delivery rider',
  `courier_id` bigint(20) unsigned DEFAULT NULL,
  `courier_tracking_number` varchar(100) DEFAULT NULL,
  `status` enum('in_progress','out_for_delivery','delivered') NOT NULL DEFAULT 'in_progress',
  `rider_name` varchar(150) DEFAULT NULL,
  `est_delivery_at` date DEFAULT NULL,
  `delivered_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_order` (`order_id`),
  KEY `idx_rider` (`rider_user_id`),
  KEY `fk_dt_transfer` (`transfer_id`),
  CONSTRAINT `fk_dt_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  CONSTRAINT `fk_dt_rider` FOREIGN KEY (`rider_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_dt_transfer` FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for delivery_tracking
--
INSERT INTO `delivery_tracking` (`id`, `order_id`, `transfer_id`, `rider_user_id`, `courier_id`, `courier_tracking_number`, `status`, `rider_name`, `est_delivery_at`, `delivered_at`, `created_at`, `updated_at`) VALUES
(1, 4, NULL, 9, NULL, NULL, 'in_progress', 'Lisa Fernandez', '2026-03-20', NULL, '2026-03-18 19:45:10', '2026-03-18 19:45:10'),
(2, 5, NULL, 10, NULL, NULL, 'in_progress', 'Ricardo Gomez', '2026-03-21', NULL, '2026-03-18 19:45:10', '2026-03-18 19:45:10'),
(3, 2, 1, 11, NULL, NULL, 'out_for_delivery', 'Elena Cruz', '2026-03-18', NULL, '2026-03-18 19:45:10', '2026-03-18 19:45:10'),
(4, 20, NULL, NULL, NULL, NULL, 'out_for_delivery', NULL, NULL, NULL, '2026-04-14 00:01:49', '2026-04-14 01:18:50'),
(5, 22, NULL, NULL, NULL, NULL, 'delivered', NULL, NULL, '2026-05-17 16:29:10', '2026-05-17 16:27:54', '2026-05-17 16:29:10'),
(6, 23, NULL, NULL, NULL, NULL, 'delivered', NULL, NULL, '2026-05-18 00:04:09', '2026-05-17 19:46:45', '2026-05-18 00:04:09');


--
-- Table structure for dta_applications
--
DROP TABLE IF EXISTS `dta_applications`;
CREATE TABLE `dta_applications` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `full_name` varchar(150) DEFAULT NULL,
  `applicant_name` varchar(150) NOT NULL,
  `business_name` varchar(150) NOT NULL,
  `email` varchar(150) NOT NULL,
  `phone` varchar(30) NOT NULL,
  `address` text NOT NULL,
  `stockist_level` enum('provincial_stockist','city_stockist') DEFAULT NULL,
  `id_front_url` varchar(500) DEFAULT NULL,
  `id_back_url` varchar(500) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `region` varchar(100) DEFAULT NULL,
  `requested_level` enum('provincial_stockist','city_stockist') NOT NULL DEFAULT 'city_stockist',
  `message` text DEFAULT NULL,
  `id_document_url` varchar(500) DEFAULT NULL COMMENT 'Cloudinary URL of submitted ID',
  `business_permit_url` varchar(500) DEFAULT NULL COMMENT 'Cloudinary URL of business permit',
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `reviewed_by` bigint(20) unsigned DEFAULT NULL,
  `reviewed_at` timestamp NULL DEFAULT NULL,
  `rejection_reason` text DEFAULT NULL,
  `created_partner_id` bigint(20) unsigned DEFAULT NULL COMMENT 'partner.id created on approval',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`),
  KEY `idx_email` (`email`),
  KEY `fk_dta_reviewer` (`reviewed_by`),
  KEY `fk_dta_partner` (`created_partner_id`),
  KEY `idx_dta_is_deleted` (`is_deleted`),
  CONSTRAINT `fk_dta_partner` FOREIGN KEY (`created_partner_id`) REFERENCES `partners` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_dta_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for dta_applications
--
-- No rows for dta_applications


--
-- Table structure for export_jobs
--
DROP TABLE IF EXISTS `export_jobs`;
CREATE TABLE `export_jobs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `export_number` varchar(50) NOT NULL,
  `export_type` varchar(50) NOT NULL,
  `format` enum('json','csv') NOT NULL DEFAULT 'csv',
  `filters_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`filters_json`)),
  `row_count` int(10) unsigned NOT NULL DEFAULT 0,
  `content_sha256` char(64) NOT NULL,
  `signed_by` bigint(20) unsigned NOT NULL,
  `signed_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `status` enum('generated','voided') NOT NULL DEFAULT 'generated',
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `export_number` (`export_number`),
  KEY `idx_export_jobs_type` (`export_type`),
  KEY `idx_export_jobs_signed_by` (`signed_by`),
  CONSTRAINT `fk_export_jobs_signed_by` FOREIGN KEY (`signed_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Table data for export_jobs
--
-- No rows for export_jobs


--
-- Table structure for goods_receipts
--
DROP TABLE IF EXISTS `goods_receipts`;
CREATE TABLE `goods_receipts` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `grn_number` varchar(30) NOT NULL,
  `po_id` bigint(20) unsigned DEFAULT NULL COMMENT 'NULL = manual/direct receipt',
  `warehouse_id` bigint(20) unsigned NOT NULL,
  `received_by` bigint(20) unsigned NOT NULL,
  `status` enum('draft','completed','discrepancy') NOT NULL DEFAULT 'draft',
  `supplier` varchar(150) DEFAULT NULL,
  `delivery_reference` varchar(100) DEFAULT NULL COMMENT 'DR/invoice number from supplier',
  `notes` text DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_grn_number` (`grn_number`),
  KEY `idx_warehouse` (`warehouse_id`),
  KEY `idx_status` (`status`),
  KEY `idx_po` (`po_id`),
  KEY `fk_grn_receiver` (`received_by`),
  CONSTRAINT `fk_grn_po` FOREIGN KEY (`po_id`) REFERENCES `purchase_orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_grn_receiver` FOREIGN KEY (`received_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_grn_warehouse` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for goods_receipts
--
INSERT INTO `goods_receipts` (`id`, `grn_number`, `po_id`, `warehouse_id`, `received_by`, `status`, `supplier`, `delivery_reference`, `notes`, `completed_at`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'GRN-2026041401', NULL, 5, 2, 'draft', 'asdas', 'asdasd', NULL, NULL, 0, '2026-04-14 07:07:00', '2026-04-14 07:07:00'),
(2, 'GRN-2026041402', NULL, 4, 2, 'completed', 'asd', 'sad', 'sad', '2026-05-17 23:13:42', 0, '2026-04-14 07:08:37', '2026-05-17 23:13:42');


--
-- Table structure for gps_pings
--
DROP TABLE IF EXISTS `gps_pings`;
CREATE TABLE `gps_pings` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `tracking_id` bigint(20) unsigned NOT NULL,
  `lat` decimal(10,8) NOT NULL,
  `lng` decimal(11,8) NOT NULL,
  `speed_kmh` decimal(6,2) DEFAULT NULL,
  `accuracy_meters` decimal(8,2) DEFAULT NULL,
  `pinged_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_tracking` (`tracking_id`),
  KEY `idx_pinged` (`pinged_at`),
  KEY `idx_tracking_time` (`tracking_id`,`pinged_at`),
  CONSTRAINT `fk_gps_tracking` FOREIGN KEY (`tracking_id`) REFERENCES `delivery_tracking` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=18 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for gps_pings
--
INSERT INTO `gps_pings` (`id`, `tracking_id`, `lat`, `lng`, `speed_kmh`, `accuracy_meters`, `pinged_at`) VALUES
(1, 3, '14.59950000', '120.98420000', NULL, NULL, '2026-03-18 09:00:00'),
(2, 3, '14.61000000', '120.99000000', NULL, NULL, '2026-03-18 09:00:30'),
(3, 3, '14.62500000', '120.99500000', NULL, NULL, '2026-03-18 09:01:00'),
(4, 3, '14.64000000', '121.00000000', NULL, NULL, '2026-03-18 09:01:30'),
(5, 3, '14.65500000', '121.02000000', NULL, NULL, '2026-03-18 09:02:00'),
(6, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:23:38'),
(7, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:27:45'),
(8, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:28:48'),
(9, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:30:13'),
(10, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:31:48'),
(11, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:41:15'),
(12, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:43:21'),
(13, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:46:49'),
(14, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:53:02'),
(15, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 00:57:09'),
(16, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 01:08:19'),
(17, 4, '14.59950000', '120.98420000', '18.20', '9.50', '2026-04-14 01:18:50');


--
-- Table structure for grn_items
--
DROP TABLE IF EXISTS `grn_items`;
CREATE TABLE `grn_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `grn_id` bigint(20) unsigned NOT NULL,
  `product_id` bigint(20) unsigned NOT NULL,
  `expected_qty` int(10) unsigned NOT NULL DEFAULT 0,
  `received_qty` int(10) unsigned NOT NULL DEFAULT 0,
  `expected_quantity` int(10) unsigned NOT NULL DEFAULT 0,
  `received_quantity` int(10) unsigned NOT NULL DEFAULT 0,
  `batch_number` varchar(50) DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  `unit_cost` decimal(10,2) DEFAULT NULL,
  `notes` varchar(300) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_grn` (`grn_id`),
  KEY `idx_product` (`product_id`),
  CONSTRAINT `fk_grni_grn` FOREIGN KEY (`grn_id`) REFERENCES `goods_receipts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_grni_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for grn_items
--
INSERT INTO `grn_items` (`id`, `grn_id`, `product_id`, `expected_qty`, `received_qty`, `expected_quantity`, `received_quantity`, `batch_number`, `expiry_date`, `unit_cost`, `notes`) VALUES
(1, 1, 3, 1, 1, 0, 0, '1', '2026-04-13', '1.00', NULL),
(2, 2, 8, 1, 1, 0, 0, 'a1', '2026-04-14', '1.00', NULL);


--
-- Table structure for inventories
--
DROP TABLE IF EXISTS `inventories`;
CREATE TABLE `inventories` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `product_id` bigint(20) unsigned NOT NULL,
  `warehouse_id` bigint(20) unsigned NOT NULL,
  `partner_id` bigint(20) unsigned DEFAULT NULL COMMENT 'Associated partner for this inventory record',
  `current_stock` int(10) unsigned NOT NULL DEFAULT 0,
  `reserved_stock` int(10) unsigned NOT NULL DEFAULT 0 COMMENT 'Stock reserved by pending/approved orders',
  `reorder_threshold` int(10) unsigned NOT NULL DEFAULT 500,
  `warning_threshold` int(10) unsigned NOT NULL DEFAULT 0 COMMENT 'Alert threshold (lower than reorder)',
  `batch_number` varchar(50) NOT NULL,
  `expiry_date` date NOT NULL,
  `status` enum('in_stock','low_stock','out_of_stock') GENERATED ALWAYS AS (case when `current_stock` = 0 then 'out_of_stock' when `current_stock` <= `reorder_threshold` then 'low_stock' else 'in_stock' end) STORED,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `last_movement_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_product` (`product_id`),
  KEY `idx_warehouse` (`warehouse_id`),
  KEY `idx_status` (`status`),
  KEY `idx_threshold` (`current_stock`,`reorder_threshold`),
  KEY `fk_inv_partner` (`partner_id`),
  KEY `idx_expiry` (`expiry_date`),
  CONSTRAINT `fk_inv_partner` FOREIGN KEY (`partner_id`) REFERENCES `partners` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_inv_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `fk_inv_warehouse` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`),
  CONSTRAINT `chk_reserved_stock` CHECK (`reserved_stock` <= `current_stock`)
) ENGINE=InnoDB AUTO_INCREMENT=19 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for inventories
--
INSERT INTO `inventories` (`id`, `product_id`, `warehouse_id`, `partner_id`, `current_stock`, `reserved_stock`, `reorder_threshold`, `warning_threshold`, `batch_number`, `expiry_date`, `status`, `is_active`, `last_movement_at`, `created_at`, `updated_at`) VALUES
(1, 1, 1, NULL, 14999, 0, 5000, 0, 'B2026030701', '2026-09-07', 'in_stock', 1, '2026-05-17 16:29:10', '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(2, 2, 1, NULL, 8999, 320, 4000, 0, 'D3026030701', '2026-09-07', 'in_stock', 1, '2026-05-17 16:29:10', '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(3, 3, 1, NULL, 999, 100, 950, 0, 'AS026030701', '2026-09-07', 'in_stock', 1, '2026-05-17 16:29:10', '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(4, 4, 1, NULL, 898, 120, 700, 0, 'T3026030701', '2026-09-07', 'in_stock', 1, '2026-05-18 00:04:09', '2026-03-18 19:45:09', '2026-05-18 00:04:09'),
(5, 5, 1, NULL, 10000, 4, 3000, 0, 'B2026030702', '2026-09-07', 'in_stock', 1, NULL, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(6, 1, 2, 1, 7999, 0, 2000, 0, 'B2026030711', '2026-09-07', 'in_stock', 1, '2026-05-18 00:35:31', '2026-03-18 19:45:09', '2026-05-18 00:35:31'),
(7, 2, 2, 1, 4000, 0, 1000, 0, 'B2026030712', '2026-09-07', 'in_stock', 1, NULL, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(8, 3, 2, 1, 200, 0, 500, 0, 'B2026030713', '2026-09-07', 'low_stock', 1, NULL, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(9, 1, 3, 4, 6000, 0, 2000, 0, 'B2026030721', '2026-09-07', 'in_stock', 1, NULL, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(10, 5, 3, 4, 3000, 0, 1000, 0, 'B2026030722', '2026-09-07', 'in_stock', 1, NULL, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(11, 1, 4, 2, 5000, 0, 2000, 0, 'B2026030731', '2026-09-07', 'in_stock', 1, '2026-05-18 00:35:32', '2026-03-18 19:45:09', '2026-05-18 00:35:32'),
(12, 4, 4, 2, 10000, 0, 500, 0, 'B2026030732', '2026-09-07', 'in_stock', 1, '2026-05-17 14:02:27', '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(13, 1, 5, 3, 4000, 0, 1500, 0, 'B2026030741', '2026-09-07', 'in_stock', 1, '2026-05-18 00:35:31', '2026-03-18 19:45:09', '2026-05-18 00:35:31'),
(14, 9, 5, 3, 2000, 0, 800, 0, 'B2026030742', '2026-09-07', 'in_stock', 1, NULL, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(15, 1, 6, 5, 300, 0, 1000, 0, 'B2026030751', '2026-09-07', 'low_stock', 1, NULL, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(16, 8, 6, 5, 3269, 0, 500, 0, 'B2026030752', '2026-09-07', 'in_stock', 1, '2026-05-17 14:03:32', '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(17, 5, 4, 2, 2000, 0, 3000, 0, 'B2026030702', '2026-09-07', 'low_stock', 1, NULL, '2026-04-08 22:44:59', '2026-05-17 17:33:06'),
(18, 8, 4, 2, 1, 0, 500, 0, '', '0000-00-00', 'low_stock', 1, '2026-05-17 23:13:42', '2026-05-17 23:13:42', '2026-05-17 23:13:42');


--
-- Table structure for mobile_stockists
--
DROP TABLE IF EXISTS `mobile_stockists`;
CREATE TABLE `mobile_stockists` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `partner_id` bigint(20) unsigned NOT NULL COMMENT 'Parent city/provincial stockist',
  `name` varchar(150) NOT NULL,
  `email` varchar(150) NOT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `region` varchar(100) DEFAULT NULL,
  `lat` decimal(10,8) DEFAULT NULL,
  `lng` decimal(11,8) DEFAULT NULL,
  `status` enum('active','inactive','suspended') NOT NULL DEFAULT 'active',
  `user_id` bigint(20) unsigned DEFAULT NULL COMMENT 'Associated user account for portal login',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `last_login` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`email`),
  KEY `idx_partner` (`partner_id`),
  KEY `idx_status` (`status`),
  KEY `idx_user` (`user_id`),
  CONSTRAINT `fk_ms_partner` FOREIGN KEY (`partner_id`) REFERENCES `partners` (`id`),
  CONSTRAINT `fk_ms_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for mobile_stockists
--
INSERT INTO `mobile_stockists` (`id`, `partner_id`, `name`, `email`, `phone`, `address`, `region`, `lat`, `lng`, `status`, `user_id`, `is_deleted`, `created_at`, `updated_at`, `last_login`) VALUES
(1, 4, 'Juan dela Cruz', 'mobile@nogatu.com', '09121111111', 'blk 6 lot 5 mahogany street', NULL, NULL, NULL, 'active', 4, 0, '2026-04-14 07:10:03', '2026-05-18 00:34:52', NULL);


--
-- Table structure for notifications
--
DROP TABLE IF EXISTS `notifications`;
CREATE TABLE `notifications` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned DEFAULT NULL COMMENT 'NULL = broadcast to all super_admins',
  `type` enum('low_stock','no_stock','stock_replenished','order_placed','order_approved','order_rejected','order_paid','order_delivered','po_generated','system') NOT NULL,
  `title` varchar(200) NOT NULL,
  `message` text NOT NULL,
  `entity_type` varchar(50) DEFAULT NULL COMMENT 'e.g. order, inventory, transfer',
  `entity_id` bigint(20) unsigned DEFAULT NULL,
  `location` varchar(150) DEFAULT NULL COMMENT 'Warehouse/city location for stock alerts',
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `sms_sent` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_type` (`type`),
  KEY `idx_read` (`is_read`),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=111 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for notifications
--
INSERT INTO `notifications` (`id`, `user_id`, `type`, `title`, `message`, `entity_type`, `entity_id`, `location`, `is_read`, `sms_sent`, `created_at`) VALUES
(1, NULL, 'low_stock', 'Low Stock Alert', 'Metro Manila, Philippines: Nogatu Barley Pure Drink is below threshold (200 remaining). Auto-PO generated.', 'inventory', 8, 'Metro Manila, Philippines', 0, 1, '2026-03-18 19:45:10'),
(2, NULL, 'low_stock', 'Low Stock Alert', 'Cebu, Philippines: Nogatu Coffee Mix is below reorder threshold.', 'inventory', 10, 'Cebu, Philippines', 0, 1, '2026-03-18 19:45:10'),
(3, NULL, 'low_stock', 'Low Stock Alert', 'Davao, Philippines: Nogatu Coffee is running low.', 'inventory', 13, 'Davao, Philippines', 0, 1, '2026-03-18 19:45:10'),
(4, NULL, 'no_stock', 'Out of Stock', 'Bulacan, Philippines: Nogatu Mangosteen Coffee has zero units.', 'inventory', 12, 'Bulacan, Philippines', 0, 1, '2026-03-18 19:45:10'),
(5, NULL, 'stock_replenished', 'Stock Replenished', 'Dagupan, Philippines: Nogatu Coffee has been restocked successfully.', 'inventory', 1, 'Dagupan, Philippines', 0, 0, '2026-03-18 19:45:10'),
(6, NULL, 'no_stock', 'Out of Stock', 'Bukidnon, Philippines: Nogatu Chocolate Drink has zero units.', 'inventory', 16, 'Bukidnon, Philippines', 0, 1, '2026-03-18 19:45:10'),
(7, NULL, 'po_generated', 'Auto PO Generated', 'System auto-generated Purchase Order PO-AUTO-001 for Nogatu Barley Pure Drink (500 units).', 'purchase_order', 3, NULL, 0, 1, '2026-03-18 19:45:10'),
(8, 4, 'order_approved', 'Your Order was Approved', 'Your order ORD-2026030701 has been approved. Please proceed with bank transfer.', 'order', 1, NULL, 1, 1, '2026-03-18 19:45:10'),
(9, 5, 'order_approved', 'Your Order was Approved', 'Your order ORD-2026030702 has been approved. Please proceed with bank transfer.', 'order', 2, NULL, 1, 1, '2026-03-18 19:45:10'),
(10, 1, 'no_stock', 'Out of Stock: Nogatu Mangosteen Coffee', 'Nogatu Mangosteen Coffee at Cebu City Center is out of stock. Auto PO PO-2026031801 has been generated.', 'purchase_order', 4, 'Cebu City Center', 1, 0, '2026-03-18 20:30:00'),
(11, 1, 'low_stock', 'Low Stock Alert: Nogatu Coffee', 'Nogatu Coffee at Pangasinan Hub is at 300 units (threshold: 1000). Auto PO PO-2026031802 has been generated.', 'purchase_order', 5, 'Pangasinan Hub', 1, 0, '2026-03-18 20:30:00'),
(12, 1, 'no_stock', 'Out of Stock: Nogatu Chocolate Drink Mix', 'Nogatu Chocolate Drink Mix at Pangasinan Hub is out of stock. Auto PO PO-2026031803 has been generated.', 'purchase_order', 6, 'Pangasinan Hub', 1, 0, '2026-03-18 20:30:00'),
(13, 1, 'order_placed', 'New Order: ORD-2026031801', 'New order ORD-2026031801 from Metro Distributors Inc. worth PHP 45.00', 'order', 9, NULL, 1, 0, '2026-03-18 21:48:03'),
(14, 2, 'order_placed', 'New Order: ORD-2026031801', 'New order ORD-2026031801 from Metro Distributors Inc. worth PHP 45.00', 'order', 9, NULL, 1, 0, '2026-03-18 21:48:03'),
(15, 3, 'order_placed', 'New Order: ORD-2026031801', 'New order ORD-2026031801 from Metro Distributors Inc. worth PHP 45.00', 'order', 9, NULL, 0, 0, '2026-03-18 21:48:03'),
(16, 1, 'order_placed', 'New Order: ORD-2026031802', 'New order ORD-2026031802 from Metro Distributors Inc. worth PHP 532.00', 'order', 10, NULL, 1, 0, '2026-03-18 21:56:57'),
(17, 2, 'order_placed', 'New Order: ORD-2026031802', 'New order ORD-2026031802 from Metro Distributors Inc. worth PHP 532.00', 'order', 10, NULL, 1, 0, '2026-03-18 21:56:57'),
(18, 3, 'order_placed', 'New Order: ORD-2026031802', 'New order ORD-2026031802 from Metro Distributors Inc. worth PHP 532.00', 'order', 10, NULL, 0, 0, '2026-03-18 21:56:57'),
(19, 4, 'order_approved', 'Order Approved: ORD-2026031802', 'Your order ORD-2026031802 has been approved. Please proceed with payment.', 'order', 10, NULL, 0, 0, '2026-03-18 23:24:36'),
(20, 9, 'order_approved', 'Order Approved: ORD-2026031802', 'Your order ORD-2026031802 has been approved. Please proceed with payment.', 'order', 10, NULL, 0, 0, '2026-03-18 23:24:36'),
(21, 10, 'order_approved', 'Order Approved: ORD-2026031802', 'Your order ORD-2026031802 has been approved. Please proceed with payment.', 'order', 10, NULL, 0, 0, '2026-03-18 23:24:36'),
(22, 2, 'order_approved', 'Order Approved: #ORD-2026031801', 'Your order #ORD-2026031801 has been approved. Pay within 24 hours.', 'order', 9, NULL, 1, 0, '2026-04-08 19:32:00'),
(23, 4, 'order_approved', 'Order Approved: #ORD-2026031801', 'Your order #ORD-2026031801 has been approved. Pay within 24 hours.', 'order', 9, NULL, 0, 0, '2026-04-08 19:32:00'),
(24, 9, 'order_approved', 'Order Approved: #ORD-2026031801', 'Your order #ORD-2026031801 has been approved. Pay within 24 hours.', 'order', 9, NULL, 0, 0, '2026-04-08 19:32:00'),
(25, 10, 'order_approved', 'Order Approved: #ORD-2026031801', 'Your order #ORD-2026031801 has been approved. Pay within 24 hours.', 'order', 9, NULL, 0, 0, '2026-04-08 19:32:00'),
(26, 1, '', 'Payment Proof: #ORD-2026031801', 'Payment proof uploaded for order #ORD-2026031801. Please verify.', 'order', 9, NULL, 1, 0, '2026-04-08 21:42:44'),
(27, 2, '', 'Payment Confirmed: #ORD-2026031801', 'Payment for order #ORD-2026031801 has been verified. Delivery is being arranged.', 'order', 9, NULL, 1, 0, '2026-04-08 22:40:03'),
(28, 4, '', 'Payment Confirmed: #ORD-2026031801', 'Payment for order #ORD-2026031801 has been verified. Delivery is being arranged.', 'order', 9, NULL, 0, 0, '2026-04-08 22:40:03'),
(29, 9, '', 'Payment Confirmed: #ORD-2026031801', 'Payment for order #ORD-2026031801 has been verified. Delivery is being arranged.', 'order', 9, NULL, 0, 0, '2026-04-08 22:40:03'),
(30, 10, '', 'Payment Confirmed: #ORD-2026031801', 'Payment for order #ORD-2026031801 has been verified. Delivery is being arranged.', 'order', 9, NULL, 0, 0, '2026-04-08 22:40:03'),
(31, 1, 'low_stock', 'Low Stock: Nogatu Coffee Mix', 'Nogatu Coffee Mix at Cebu City Center is at 2000 units. Auto PO PO-2026040801 generated.', 'purchase_order', 7, NULL, 1, 0, '2026-04-08 22:45:00'),
(32, 1, '', 'Payment Proof: #ORD-2026031802', 'Payment proof uploaded for order #ORD-2026031802. Please verify.', 'order', 10, NULL, 1, 0, '2026-04-09 00:34:34'),
(33, 1, 'order_placed', 'New Order: #ORD-2026040901', 'New order #ORD-2026040901 from Metro Distributors Inc. worth ???5580.00', 'order', 18, NULL, 1, 0, '2026-04-09 11:05:08'),
(34, 1, 'order_placed', 'New Order: #ORD-2026040902', 'New order #ORD-2026040902 from Metro Distributors Inc. worth ???14400.00', 'order', 19, NULL, 1, 0, '2026-04-09 11:22:39'),
(35, 2, 'order_approved', 'Order Approved: #ORD-2026040902', 'Your order #ORD-2026040902 has been approved. Pay within 24 hours.', 'order', 19, NULL, 1, 0, '2026-04-09 11:23:32'),
(36, 4, 'order_approved', 'Order Approved: #ORD-2026040902', 'Your order #ORD-2026040902 has been approved. Pay within 24 hours.', 'order', 19, NULL, 0, 0, '2026-04-09 11:23:32'),
(37, 9, 'order_approved', 'Order Approved: #ORD-2026040902', 'Your order #ORD-2026040902 has been approved. Pay within 24 hours.', 'order', 19, NULL, 0, 0, '2026-04-09 11:23:32'),
(38, 10, 'order_approved', 'Order Approved: #ORD-2026040902', 'Your order #ORD-2026040902 has been approved. Pay within 24 hours.', 'order', 19, NULL, 0, 0, '2026-04-09 11:23:32'),
(39, 1, '', 'Payment Proof: #ORD-2026040902', 'Payment proof uploaded for order #ORD-2026040902. Please verify.', 'order', 19, NULL, 1, 0, '2026-04-09 11:24:26'),
(40, 2, '', 'Payment Confirmed: #ORD-2026040902', 'Payment for order #ORD-2026040902 has been verified. Delivery is being arranged.', 'order', 19, NULL, 0, 0, '2026-04-09 11:25:52'),
(41, 4, '', 'Payment Confirmed: #ORD-2026040902', 'Payment for order #ORD-2026040902 has been verified. Delivery is being arranged.', 'order', 19, NULL, 0, 0, '2026-04-09 11:25:52'),
(42, 9, '', 'Payment Confirmed: #ORD-2026040902', 'Payment for order #ORD-2026040902 has been verified. Delivery is being arranged.', 'order', 19, NULL, 0, 0, '2026-04-09 11:25:52'),
(43, 10, '', 'Payment Confirmed: #ORD-2026040902', 'Payment for order #ORD-2026040902 has been verified. Delivery is being arranged.', 'order', 19, NULL, 0, 0, '2026-04-09 11:25:52'),
(44, 2, 'order_approved', 'Order Approved: #ORD-2026040901', 'Your order #ORD-2026040901 has been approved. Pay within 24 hours.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:14'),
(45, 4, 'order_approved', 'Order Approved: #ORD-2026040901', 'Your order #ORD-2026040901 has been approved. Pay within 24 hours.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:14'),
(46, 9, 'order_approved', 'Order Approved: #ORD-2026040901', 'Your order #ORD-2026040901 has been approved. Pay within 24 hours.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:14'),
(47, 10, 'order_approved', 'Order Approved: #ORD-2026040901', 'Your order #ORD-2026040901 has been approved. Pay within 24 hours.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:14'),
(48, 1, '', 'Payment Proof: #ORD-2026040901', 'Payment proof uploaded for order #ORD-2026040901. Please verify.', 'order', 18, NULL, 1, 0, '2026-04-09 11:33:39'),
(49, 2, '', 'Payment Confirmed: #ORD-2026040901', 'Payment for order #ORD-2026040901 has been verified. Delivery is being arranged.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:57'),
(50, 4, '', 'Payment Confirmed: #ORD-2026040901', 'Payment for order #ORD-2026040901 has been verified. Delivery is being arranged.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:57'),
(51, 9, '', 'Payment Confirmed: #ORD-2026040901', 'Payment for order #ORD-2026040901 has been verified. Delivery is being arranged.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:57'),
(52, 10, '', 'Payment Confirmed: #ORD-2026040901', 'Payment for order #ORD-2026040901 has been verified. Delivery is being arranged.', 'order', 18, NULL, 0, 0, '2026-04-09 11:33:57'),
(53, 2, '', 'Payment Confirmed: #ORD-2026031802', 'Payment for order #ORD-2026031802 has been verified. Delivery is being arranged.', 'order', 10, NULL, 0, 0, '2026-04-09 11:44:14'),
(54, 4, '', 'Payment Confirmed: #ORD-2026031802', 'Payment for order #ORD-2026031802 has been verified. Delivery is being arranged.', 'order', 10, NULL, 0, 0, '2026-04-09 11:44:14'),
(55, 9, '', 'Payment Confirmed: #ORD-2026031802', 'Payment for order #ORD-2026031802 has been verified. Delivery is being arranged.', 'order', 10, NULL, 0, 0, '2026-04-09 11:44:14'),
(56, 10, '', 'Payment Confirmed: #ORD-2026031802', 'Payment for order #ORD-2026031802 has been verified. Delivery is being arranged.', 'order', 10, NULL, 0, 0, '2026-04-09 11:44:14'),
(57, 1, 'order_placed', 'New Order: #ORD-2026040903', 'New order #ORD-2026040903 from Marinduque Distributors Inc. worth ???4500.00', 'order', 20, NULL, 1, 0, '2026-04-09 11:51:01'),
(58, 6, 'order_approved', 'Order Approved: #ORD-2026040903', 'Your order #ORD-2026040903 has been approved. Pay within 24 hours.', 'order', 20, NULL, 0, 0, '2026-04-09 12:05:16'),
(59, 12, 'order_approved', 'Order Approved: #ORD-2026040903', 'Your order #ORD-2026040903 has been approved. Pay within 24 hours.', 'order', 20, NULL, 0, 0, '2026-04-09 12:05:16'),
(60, 1, 'order_placed', 'New Order: #ORD-2026040904', 'New order #ORD-2026040904 from Cebu Distributors Inc. worth ???45.00', 'order', 21, NULL, 1, 0, '2026-04-09 12:06:18'),
(61, 2, 'order_approved', 'Order Approved: #ORD-2026040904', 'Your order #ORD-2026040904 has been approved. Pay within 24 hours.', 'order', 21, NULL, 0, 0, '2026-04-09 12:06:49'),
(62, 3, 'order_approved', 'Order Approved: #ORD-2026040904', 'Your order #ORD-2026040904 has been approved. Pay within 24 hours.', 'order', 21, NULL, 0, 0, '2026-04-09 12:06:49'),
(63, 5, 'order_approved', 'Order Approved: #ORD-2026040904', 'Your order #ORD-2026040904 has been approved. Pay within 24 hours.', 'order', 21, NULL, 0, 0, '2026-04-09 12:06:49'),
(64, 11, 'order_approved', 'Order Approved: #ORD-2026040904', 'Your order #ORD-2026040904 has been approved. Pay within 24 hours.', 'order', 21, NULL, 0, 0, '2026-04-09 12:06:49'),
(65, 1, '', 'Payment Proof: #ORD-2026040904', 'Payment proof uploaded for order #ORD-2026040904. Please verify.', 'order', 21, NULL, 1, 0, '2026-04-09 12:07:24'),
(66, 2, '', 'Payment Confirmed: #ORD-2026040904', 'Payment for order #ORD-2026040904 has been verified. Delivery is being arranged.', 'order', 21, NULL, 0, 0, '2026-04-09 12:07:38'),
(67, 3, '', 'Payment Confirmed: #ORD-2026040904', 'Payment for order #ORD-2026040904 has been verified. Delivery is being arranged.', 'order', 21, NULL, 0, 0, '2026-04-09 12:07:38'),
(68, 5, '', 'Payment Confirmed: #ORD-2026040904', 'Payment for order #ORD-2026040904 has been verified. Delivery is being arranged.', 'order', 21, NULL, 0, 0, '2026-04-09 12:07:38'),
(69, 11, '', 'Payment Confirmed: #ORD-2026040904', 'Payment for order #ORD-2026040904 has been verified. Delivery is being arranged.', 'order', 21, NULL, 0, 0, '2026-04-09 12:07:38'),
(70, 2, 'order_delivered', 'Order Delivered: #ORD-2026040904', 'Order #ORD-2026040904 has been delivered.', 'order', 21, NULL, 0, 0, '2026-04-09 12:34:23'),
(71, 3, 'order_delivered', 'Order Delivered: #ORD-2026040904', 'Order #ORD-2026040904 has been delivered.', 'order', 21, NULL, 0, 0, '2026-04-09 12:34:23'),
(72, 5, 'order_delivered', 'Order Delivered: #ORD-2026040904', 'Order #ORD-2026040904 has been delivered.', 'order', 21, NULL, 0, 0, '2026-04-09 12:34:23'),
(73, 11, 'order_delivered', 'Order Delivered: #ORD-2026040904', 'Order #ORD-2026040904 has been delivered.', 'order', 21, NULL, 0, 0, '2026-04-09 12:34:23'),
(74, 1, 'low_stock', 'Low Stock: Nogatu Mangosteen Coffee', 'Nogatu Mangosteen Coffee at Cebu City Center is at 0 units. Auto PO PO-2026041401 generated.', 'purchase_order', 8, NULL, 0, 0, '2026-04-14 02:00:00'),
(75, 8, 'order_approved', 'Order Approved: #ORD-2026030705', 'Your order #ORD-2026030705 has been approved. Pay within 24 hours.', 'order', 5, NULL, 0, 0, '2026-04-14 10:26:14'),
(76, 14, 'order_approved', 'Order Approved: #ORD-2026030705', 'Your order #ORD-2026030705 has been approved. Pay within 24 hours.', 'order', 5, NULL, 0, 0, '2026-04-14 10:26:14'),
(77, 1, 'order_placed', 'New Order: #ORD-2026051701', 'New order #ORD-2026051701 from Cebu Distributors Inc. worth ₱135.00', 'order', 22, NULL, 0, 0, '2026-05-17 14:06:06'),
(78, 8, '', 'Order Cancelled: ORD-2026030705', 'Order ORD-2026030705 was auto-cancelled because the payment deadline passed.', 'order', 5, NULL, 0, 0, '2026-05-17 15:12:32'),
(79, 14, '', 'Order Cancelled: ORD-2026030705', 'Order ORD-2026030705 was auto-cancelled because the payment deadline passed.', 'order', 5, NULL, 0, 0, '2026-05-17 15:12:32'),
(80, 2, 'order_approved', 'Order Approved: #ORD-2026051701', 'Your order #ORD-2026051701 has been approved. Pay within 24 hours.', 'order', 22, NULL, 0, 0, '2026-05-17 16:26:29'),
(81, 3, 'order_approved', 'Order Approved: #ORD-2026051701', 'Your order #ORD-2026051701 has been approved. Pay within 24 hours.', 'order', 22, NULL, 0, 0, '2026-05-17 16:26:29'),
(82, 5, 'order_approved', 'Order Approved: #ORD-2026051701', 'Your order #ORD-2026051701 has been approved. Pay within 24 hours.', 'order', 22, NULL, 0, 0, '2026-05-17 16:26:29'),
(83, 11, 'order_approved', 'Order Approved: #ORD-2026051701', 'Your order #ORD-2026051701 has been approved. Pay within 24 hours.', 'order', 22, NULL, 0, 0, '2026-05-17 16:26:29'),
(84, 1, '', 'Payment Proof: #ORD-2026051701', 'Payment proof uploaded for order #ORD-2026051701. Please verify.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:03'),
(85, 2, '', 'Payment Confirmed: #ORD-2026051701', 'Payment for order #ORD-2026051701 has been verified. Delivery is being arranged.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:53'),
(86, 3, '', 'Payment Confirmed: #ORD-2026051701', 'Payment for order #ORD-2026051701 has been verified. Delivery is being arranged.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:53'),
(87, 5, '', 'Payment Confirmed: #ORD-2026051701', 'Payment for order #ORD-2026051701 has been verified. Delivery is being arranged.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:53'),
(88, 11, '', 'Payment Confirmed: #ORD-2026051701', 'Payment for order #ORD-2026051701 has been verified. Delivery is being arranged.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:54'),
(89, 2, '', 'Order Dispatched: #ORD-2026051701', 'Order #ORD-2026051701 is on its way via Courier.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:54'),
(90, 3, '', 'Order Dispatched: #ORD-2026051701', 'Order #ORD-2026051701 is on its way via Courier.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:54'),
(91, 5, '', 'Order Dispatched: #ORD-2026051701', 'Order #ORD-2026051701 is on its way via Courier.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:54'),
(92, 11, '', 'Order Dispatched: #ORD-2026051701', 'Order #ORD-2026051701 is on its way via Courier.', 'order', 22, NULL, 0, 0, '2026-05-17 16:27:54'),
(93, 2, 'order_delivered', 'Order Delivered: #ORD-2026051701', 'Order #ORD-2026051701 has been delivered.', 'order', 22, NULL, 0, 0, '2026-05-17 16:29:10'),
(94, 3, 'order_delivered', 'Order Delivered: #ORD-2026051701', 'Order #ORD-2026051701 has been delivered.', 'order', 22, NULL, 0, 0, '2026-05-17 16:29:10'),
(95, 5, 'order_delivered', 'Order Delivered: #ORD-2026051701', 'Order #ORD-2026051701 has been delivered.', 'order', 22, NULL, 0, 0, '2026-05-17 16:29:10'),
(96, 11, 'order_delivered', 'Order Delivered: #ORD-2026051701', 'Order #ORD-2026051701 has been delivered.', 'order', 22, NULL, 0, 0, '2026-05-17 16:29:10'),
(97, 1, 'order_placed', 'New Order: #ORD-2026051702', 'New order #ORD-2026051702 from Cebu Distributors Inc. worth ₱45.00', 'order', 23, NULL, 0, 0, '2026-05-17 19:44:54'),
(98, 2, 'order_approved', 'Order Approved: #ORD-2026051702', 'Your order #ORD-2026051702 has been approved. Pay within 24 hours.', 'order', 23, NULL, 0, 0, '2026-05-17 19:45:21'),
(99, 5, 'order_approved', 'Order Approved: #ORD-2026051702', 'Your order #ORD-2026051702 has been approved. Pay within 24 hours.', 'order', 23, NULL, 0, 0, '2026-05-17 19:45:21'),
(100, 11, 'order_approved', 'Order Approved: #ORD-2026051702', 'Your order #ORD-2026051702 has been approved. Pay within 24 hours.', 'order', 23, NULL, 0, 0, '2026-05-17 19:45:21'),
(101, 1, '', 'Payment Proof: #ORD-2026051702', 'Payment proof uploaded for order #ORD-2026051702. Please verify.', 'order', 23, NULL, 0, 0, '2026-05-17 19:46:15'),
(102, 2, '', 'Payment Confirmed: #ORD-2026051702', 'Payment for order #ORD-2026051702 has been verified. Delivery is being arranged.', 'order', 23, NULL, 0, 0, '2026-05-17 19:46:45'),
(103, 5, '', 'Payment Confirmed: #ORD-2026051702', 'Payment for order #ORD-2026051702 has been verified. Delivery is being arranged.', 'order', 23, NULL, 0, 0, '2026-05-17 19:46:45'),
(104, 11, '', 'Payment Confirmed: #ORD-2026051702', 'Payment for order #ORD-2026051702 has been verified. Delivery is being arranged.', 'order', 23, NULL, 0, 0, '2026-05-17 19:46:45'),
(105, 2, '', 'Order Dispatched: #ORD-2026051702', 'Order #ORD-2026051702 is on its way via Courier.', 'order', 23, NULL, 0, 0, '2026-05-17 19:46:45'),
(106, 5, '', 'Order Dispatched: #ORD-2026051702', 'Order #ORD-2026051702 is on its way via Courier.', 'order', 23, NULL, 0, 0, '2026-05-17 19:46:45'),
(107, 11, '', 'Order Dispatched: #ORD-2026051702', 'Order #ORD-2026051702 is on its way via Courier.', 'order', 23, NULL, 0, 0, '2026-05-17 19:46:45'),
(108, 2, 'order_delivered', 'Order Delivered: #ORD-2026051702', 'Order #ORD-2026051702 has been delivered.', 'order', 23, NULL, 0, 0, '2026-05-18 00:04:09'),
(109, 5, 'order_delivered', 'Order Delivered: #ORD-2026051702', 'Order #ORD-2026051702 has been delivered.', 'order', 23, NULL, 0, 0, '2026-05-18 00:04:09'),
(110, 11, 'order_delivered', 'Order Delivered: #ORD-2026051702', 'Order #ORD-2026051702 has been delivered.', 'order', 23, NULL, 0, 0, '2026-05-18 00:04:09');


--
-- Table structure for orders
--
DROP TABLE IF EXISTS `orders`;
CREATE TABLE `orders` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_number` varchar(30) NOT NULL,
  `partner_id` bigint(20) unsigned NOT NULL,
  `source_warehouse_id` bigint(20) unsigned DEFAULT NULL COMMENT 'Warehouse from which stock is pulled',
  `placed_by` bigint(20) unsigned NOT NULL COMMENT 'user id of Admin who placed the order',
  `approved_by` bigint(20) unsigned DEFAULT NULL,
  `status` enum('pending','approved','rejected','delivering','delivered','cancelled') NOT NULL DEFAULT 'pending',
  `payment_status` enum('unpaid','paid','refunded') NOT NULL DEFAULT 'unpaid',
  `payment_deadline` timestamp NULL DEFAULT NULL COMMENT 'Auto-cancel if unpaid after approval + 24h',
  `payment_proof_url` varchar(500) DEFAULT NULL,
  `payment_proof_uploaded_at` timestamp NULL DEFAULT NULL,
  `payment_proof_verified_by` bigint(20) unsigned DEFAULT NULL,
  `payment_proof_verified_at` timestamp NULL DEFAULT NULL,
  `cancellation_reason` text DEFAULT NULL,
  `cancelled_by` bigint(20) unsigned DEFAULT NULL,
  `courier_id` bigint(20) unsigned DEFAULT NULL,
  `cod_amount` decimal(15,2) NOT NULL DEFAULT 0.00 COMMENT 'COD amount for city???mobile orders ???5000',
  `placed_by_type` enum('user','public') NOT NULL DEFAULT 'user',
  `customer_name` varchar(150) DEFAULT NULL COMMENT 'For public/mobile orders',
  `customer_phone` varchar(30) DEFAULT NULL,
  `customer_email` varchar(150) DEFAULT NULL,
  `customer_address` text DEFAULT NULL,
  `total_amount` decimal(15,2) NOT NULL DEFAULT 0.00,
  `notes` text DEFAULT NULL,
  `approved_at` timestamp NULL DEFAULT NULL,
  `delivered_at` timestamp NULL DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `order_number` (`order_number`),
  KEY `idx_partner` (`partner_id`),
  KEY `idx_status` (`status`),
  KEY `idx_payment` (`payment_status`),
  KEY `fk_orders_placed` (`placed_by`),
  KEY `fk_orders_approved` (`approved_by`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_source_warehouse` (`source_warehouse_id`),
  KEY `idx_payment_deadline` (`payment_deadline`),
  KEY `fk_orders_proof_verifier` (`payment_proof_verified_by`),
  KEY `fk_orders_cancelled_by` (`cancelled_by`),
  CONSTRAINT `fk_orders_approved` FOREIGN KEY (`approved_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_cancelled_by` FOREIGN KEY (`cancelled_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_partner` FOREIGN KEY (`partner_id`) REFERENCES `partners` (`id`),
  CONSTRAINT `fk_orders_placed` FOREIGN KEY (`placed_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_orders_proof_verifier` FOREIGN KEY (`payment_proof_verified_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_source_wh` FOREIGN KEY (`source_warehouse_id`) REFERENCES `warehouses` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=24 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for orders
--
INSERT INTO `orders` (`id`, `order_number`, `partner_id`, `source_warehouse_id`, `placed_by`, `approved_by`, `status`, `payment_status`, `payment_deadline`, `payment_proof_url`, `payment_proof_uploaded_at`, `payment_proof_verified_by`, `payment_proof_verified_at`, `cancellation_reason`, `cancelled_by`, `courier_id`, `cod_amount`, `placed_by_type`, `customer_name`, `customer_phone`, `customer_email`, `customer_address`, `total_amount`, `notes`, `approved_at`, `delivered_at`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'ORD-2026030701', 4, NULL, 4, 1, 'delivered', 'paid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '250000.00', NULL, '2026-03-07 10:15:00', '2026-03-09 14:00:00', 0, '2026-03-07 09:30:00', '2026-05-18 00:35:27'),
(2, 'ORD-2026030702', 2, NULL, 5, 1, 'delivered', 'paid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '125000.00', NULL, '2026-03-07 11:00:00', '2026-03-10 10:00:00', 0, '2026-03-07 09:45:00', '2026-03-18 19:45:09'),
(3, 'ORD-2026030703', 3, NULL, 6, 1, 'delivered', 'paid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '80000.00', NULL, '2026-03-07 11:30:00', '2026-03-11 09:00:00', 0, '2026-03-07 10:00:00', '2026-03-18 19:45:09'),
(4, 'ORD-2026030704', 4, NULL, 7, NULL, 'pending', 'unpaid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '45000.00', NULL, NULL, NULL, 0, '2026-03-15 09:30:00', '2026-03-18 19:45:09'),
(5, 'ORD-2026030705', 5, NULL, 8, 1, 'cancelled', 'unpaid', '2026-04-15 02:26:14', NULL, NULL, NULL, NULL, 'Payment deadline expired', NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '22500.00', NULL, '2026-04-14 10:26:14', NULL, 0, '2026-03-15 10:00:00', '2026-05-17 15:12:31'),
(6, 'TRF-2026030701', 4, NULL, 4, 1, 'delivered', 'paid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '15000.00', NULL, '2026-03-05 10:30:00', '2026-03-07 09:00:00', 0, '2026-03-05 10:00:00', '2026-05-18 00:35:27'),
(7, 'OPE-2026030701', 4, NULL, 4, 1, 'approved', 'paid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '8500.00', NULL, '2026-03-06 11:00:00', NULL, 0, '2026-03-05 09:30:00', '2026-05-18 00:35:27'),
(8, 'SRD-2026030701', 4, NULL, 4, 1, 'delivered', 'paid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '9000.00', NULL, '2026-03-04 10:00:00', '2026-03-07 08:00:00', 0, '2026-03-03 14:00:00', '2026-05-18 00:35:27'),
(9, 'ORD-2026031801', 4, NULL, 4, 1, 'approved', 'paid', '2026-04-09 11:32:00', 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1775655761/nogatu/payment-proofs/b2ye5kypgoetgsmd14rl.png', '2026-04-08 21:42:44', 1, '2026-04-08 22:40:03', NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '45.00', NULL, '2026-04-08 19:32:00', NULL, 0, '2026-03-18 21:48:03', '2026-05-18 00:35:27'),
(10, 'ORD-2026031802', 4, NULL, 4, 1, 'approved', 'paid', NULL, 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1775666074/nogatu/payment-proofs/hycjsyxugkfbi144nzcg.jpg', '2026-04-09 00:34:34', 1, '2026-04-09 11:44:14', NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '532.00', NULL, '2026-03-18 23:24:36', NULL, 0, '2026-03-18 21:56:57', '2026-05-18 00:35:27'),
(18, 'ORD-2026040901', 4, 1, 4, 1, 'approved', 'paid', '2026-04-10 03:33:14', 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1775705618/nogatu/payment-proofs/zqa3zjmmahlcyxevbpka.jpg', '2026-04-09 11:33:39', 1, '2026-04-09 11:33:57', NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '5580.00', NULL, '2026-04-09 11:33:14', NULL, 0, '2026-04-09 11:05:08', '2026-05-18 00:35:27'),
(19, 'ORD-2026040902', 4, 1, 4, 1, 'approved', 'paid', '2026-04-10 03:23:31', 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1775705064/nogatu/payment-proofs/hjfjqf0ngz7kfchosefl.png', '2026-04-09 11:24:26', 1, '2026-04-09 11:25:52', NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '14400.00', NULL, '2026-04-09 11:23:32', NULL, 0, '2026-04-09 11:22:39', '2026-05-18 00:35:27'),
(20, 'ORD-2026040903', 2, 1, 12, 1, 'delivering', 'unpaid', '2026-04-10 04:05:16', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '4500.00', NULL, '2026-04-09 12:05:16', NULL, 0, '2026-04-09 11:51:01', '2026-05-18 00:35:27'),
(21, 'ORD-2026040904', 2, 1, 2, 1, 'delivered', 'paid', '2026-04-10 04:06:49', 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1775707642/nogatu/payment-proofs/bv00ktyzwwzyzpf8x1st.jpg', '2026-04-09 12:07:24', 1, '2026-04-09 12:07:38', NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '45.00', NULL, '2026-04-09 12:06:49', '2026-04-09 12:34:23', 0, '2026-04-09 12:06:18', '2026-04-09 12:34:23'),
(22, 'ORD-2026051701', 2, 1, 2, 1, 'delivered', 'paid', '2026-05-18 08:26:28', 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1779006422/nogatu/payment-proofs/rau3dclfab0x0ilru3nn.png', '2026-05-17 16:27:03', 1, '2026-05-17 16:27:53', NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '135.00', NULL, '2026-05-17 16:26:28', '2026-05-17 16:29:10', 0, '2026-05-17 14:06:06', '2026-05-17 16:29:10'),
(23, 'ORD-2026051702', 2, 1, 2, 1, 'delivered', 'paid', '2026-05-18 11:45:21', 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1779018372/nogatu/payment-proofs/aszyxtqkolhmt6x44bvi.png', '2026-05-17 19:46:15', 1, '2026-05-17 19:46:45', NULL, NULL, NULL, '0.00', 'user', NULL, NULL, NULL, NULL, '45.00', NULL, '2026-05-17 19:45:21', '2026-05-18 00:04:09', 0, '2026-05-17 19:44:54', '2026-05-18 00:04:09');


--
-- Table structure for order_items
--
DROP TABLE IF EXISTS `order_items`;
CREATE TABLE `order_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint(20) unsigned NOT NULL,
  `product_id` bigint(20) unsigned NOT NULL,
  `supplier` varchar(150) NOT NULL DEFAULT 'Nogatu Manufacturing',
  `quantity` int(10) unsigned NOT NULL,
  `unit_price` decimal(10,2) NOT NULL COMMENT 'Partner price at time of order',
  `subtotal` decimal(15,2) GENERATED ALWAYS AS (`quantity` * `unit_price`) STORED,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_order` (`order_id`),
  KEY `idx_product` (`product_id`),
  KEY `idx_created_at` (`created_at`),
  CONSTRAINT `fk_oi_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_oi_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=33 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for order_items
--
INSERT INTO `order_items` (`id`, `order_id`, `product_id`, `supplier`, `quantity`, `unit_price`, `subtotal`, `created_at`) VALUES
(1, 1, 1, 'Southern Beverages Co.', 5000, '25.00', '125000.00', '2026-03-18 19:45:09'),
(2, 1, 2, 'Southern Beverages Co.', 5000, '25.00', '125000.00', '2026-03-18 19:45:09'),
(3, 2, 1, 'Southern Beverages Co.', 5000, '25.00', '125000.00', '2026-03-18 19:45:09'),
(4, 3, 5, 'Northern Beverages Co.', 4000, '20.00', '80000.00', '2026-03-18 19:45:09'),
(5, 4, 1, 'Nogatu Manufacturing', 1000, '45.00', '45000.00', '2026-03-18 19:45:09'),
(6, 4, 3, 'Nogatu Manufacturing', 500, '45.00', '22500.00', '2026-03-18 19:45:09'),
(7, 5, 1, 'Nogatu Manufacturing', 500, '45.00', '22500.00', '2026-03-18 19:45:09'),
(8, 6, 1, 'Southern Beverages Co.', 5000, '25.00', '125000.00', '2026-03-18 19:45:09'),
(9, 6, 2, 'Southern Beverages Co.', 5000, '25.00', '125000.00', '2026-03-18 19:45:09'),
(10, 7, 1, 'Southern Beverages Co.', 5000, '25.00', '125000.00', '2026-03-18 19:45:09'),
(11, 7, 8, 'Northern Beverages Co.', 5000, '20.00', '100000.00', '2026-03-18 19:45:09'),
(12, 8, 1, 'Nogatu Manufacturing', 5000, '25.00', '125000.00', '2026-03-18 19:45:09'),
(13, 8, 8, 'Northern Beverages Co.', 5000, '20.00', '100000.00', '2026-03-18 19:45:09'),
(14, 9, 3, 'Nogatu Manufacturing', 1, '45.00', '45.00', '2026-03-18 21:48:03'),
(15, 10, 9, 'Nogatu Manufacturing', 1, '25.00', '25.00', '2026-03-18 21:56:57'),
(16, 10, 6, 'Nogatu Manufacturing', 11, '45.00', '495.00', '2026-03-18 21:56:57'),
(17, 10, 11, 'Nogatu Manufacturing', 1, '12.00', '12.00', '2026-03-18 21:56:57'),
(24, 18, 4, 'Nogatu Manufacturing', 120, '45.00', '5400.00', '2026-04-09 11:05:08'),
(25, 18, 5, 'Nogatu Manufacturing', 4, '45.00', '180.00', '2026-04-09 11:05:08'),
(26, 19, 2, 'Nogatu Manufacturing', 320, '45.00', '14400.00', '2026-04-09 11:22:39'),
(27, 20, 3, 'Nogatu Manufacturing', 100, '45.00', '4500.00', '2026-04-09 11:51:01'),
(28, 21, 4, 'Nogatu Manufacturing', 1, '45.00', '45.00', '2026-04-09 12:06:18'),
(29, 22, 1, 'Nogatu Manufacturing', 1, '45.00', '45.00', '2026-05-17 14:06:06'),
(30, 22, 2, 'Nogatu Manufacturing', 1, '45.00', '45.00', '2026-05-17 14:06:06'),
(31, 22, 3, 'Nogatu Manufacturing', 1, '45.00', '45.00', '2026-05-17 14:06:06'),
(32, 23, 4, 'Nogatu Manufacturing', 1, '45.00', '45.00', '2026-05-17 19:44:54');


--
-- Table structure for partners
--
DROP TABLE IF EXISTS `partners`;
CREATE TABLE `partners` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `business_name` varchar(150) NOT NULL,
  `email` varchar(150) NOT NULL,
  `phone` varchar(30) NOT NULL,
  `address` text NOT NULL,
  `status` enum('active','inactive','suspended') NOT NULL DEFAULT 'active',
  `region` varchar(100) DEFAULT NULL,
  `stockist_level` enum('provincial_stockist','city_stockist') NOT NULL DEFAULT 'city_stockist',
  `parent_partner_id` bigint(20) unsigned DEFAULT NULL COMMENT 'City stockists point to their provincial parent',
  `discount_pct` decimal(5,2) NOT NULL DEFAULT 0.00 COMMENT 'Flat % discount off partner_price',
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_status` (`status`),
  KEY `idx_parent` (`parent_partner_id`),
  CONSTRAINT `fk_partner_parent` FOREIGN KEY (`parent_partner_id`) REFERENCES `partners` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for partners
--
INSERT INTO `partners` (`id`, `business_name`, `email`, `phone`, `address`, `status`, `region`, `stockist_level`, `parent_partner_id`, `discount_pct`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'Metro Distributors Inc.', 'metro@nogatu.com', '09123456789', 'Metro Manila, Philippines', 'active', 'NCR', 'provincial_stockist', NULL, '0.00', 0, '2026-03-18 19:45:09', '2026-04-06 04:58:11'),
(2, 'Cebu Distributors Inc.', 'cebu@nogatu.com', '09234567890', 'Cebu City, Cebu', 'active', 'Region VII', 'provincial_stockist', NULL, '2.40', 0, '2026-03-18 19:45:09', '2026-05-18 00:00:14'),
(3, 'Marinduque Distributors Inc.', 'marinduque@nogatu.com', '09345678901', 'Boac, Marinduque', 'active', 'Region IV-B', 'provincial_stockist', NULL, '0.00', 0, '2026-03-18 19:45:09', '2026-04-06 04:58:11'),
(4, 'Southern Beverages Co.', 'southern@nogatu.com', '09456789012', 'Davao City, Davao del Sur', 'active', 'Region XI', 'city_stockist', 2, '0.00', 0, '2026-03-18 19:45:09', '2026-05-18 00:34:52'),
(5, 'Northern Beverages Co.', 'northern@nogatu.com', '09567890123', 'Dagupan, Pangasinan', 'active', 'Region I', 'city_stockist', 1, '0.00', 0, '2026-03-18 19:45:09', '2026-04-06 04:58:11'),
(6, 'QuickMart Retail Chain', 'quickmart@nogatu.com', '09678901234', 'Quezon City, Metro Manila', 'active', 'NCR', 'city_stockist', 1, '0.00', 0, '2026-03-18 19:45:09', '2026-04-06 04:58:11');


--
-- Table structure for payments
--
DROP TABLE IF EXISTS `payments`;
CREATE TABLE `payments` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint(20) unsigned NOT NULL,
  `marked_by` bigint(20) unsigned NOT NULL COMMENT 'Super Admin who marked it paid',
  `method` enum('bank_transfer','gcash','cash','credit') NOT NULL DEFAULT 'bank_transfer',
  `amount` decimal(15,2) NOT NULL,
  `reference` varchar(100) DEFAULT NULL COMMENT 'Bank transfer reference number',
  `notes` text DEFAULT NULL,
  `paid_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_order` (`order_id`),
  KEY `fk_pay_marker` (`marked_by`),
  CONSTRAINT `fk_pay_marker` FOREIGN KEY (`marked_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_pay_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for payments
--
INSERT INTO `payments` (`id`, `order_id`, `marked_by`, `method`, `amount`, `reference`, `notes`, `paid_at`) VALUES
(1, 1, 1, 'bank_transfer', '250000.00', 'BT-20260307-001', NULL, '2026-03-07 14:00:00'),
(2, 2, 1, 'bank_transfer', '125000.00', 'BT-20260307-002', NULL, '2026-03-07 15:00:00'),
(3, 3, 1, 'bank_transfer', '80000.00', 'BT-20260308-001', NULL, '2026-03-08 09:00:00'),
(4, 6, 1, 'bank_transfer', '15000.00', 'BT-20260305-001', NULL, '2026-03-05 14:00:00'),
(5, 7, 1, 'bank_transfer', '8500.00', 'BT-20260306-001', NULL, '2026-03-06 13:00:00'),
(6, 8, 1, 'bank_transfer', '9000.00', 'BT-20260304-001', NULL, '2026-03-04 12:00:00');


--
-- Table structure for po_items
--
DROP TABLE IF EXISTS `po_items`;
CREATE TABLE `po_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `po_id` bigint(20) unsigned NOT NULL,
  `product_id` bigint(20) unsigned NOT NULL,
  `supplier` varchar(150) NOT NULL,
  `quantity` int(10) unsigned NOT NULL,
  `unit_price` decimal(10,2) NOT NULL,
  `subtotal` decimal(15,2) GENERATED ALWAYS AS (`quantity` * `unit_price`) STORED,
  PRIMARY KEY (`id`),
  KEY `idx_po` (`po_id`),
  KEY `fk_poi_product` (`product_id`),
  CONSTRAINT `fk_poi_po` FOREIGN KEY (`po_id`) REFERENCES `purchase_orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_poi_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for po_items
--
INSERT INTO `po_items` (`id`, `po_id`, `product_id`, `supplier`, `quantity`, `unit_price`, `subtotal`) VALUES
(1, 1, 1, 'Southern Beverages Co.', 5000, '25.00', '125000.00'),
(2, 1, 8, 'Northern Beverages Co.', 5000, '20.00', '100000.00'),
(3, 2, 1, 'Southern Beverages Co.', 5000, '25.00', '125000.00'),
(4, 2, 8, 'Northern Beverages Co.', 5000, '20.00', '100000.00'),
(5, 3, 3, 'Nogatu Manufacturing', 500, '45.00', '22500.00'),
(6, 4, 4, 'Nogatu Manufacturing', 1000, '45.00', '45000.00'),
(7, 5, 1, 'Nogatu Manufacturing', 2000, '45.00', '90000.00'),
(8, 6, 8, 'Nogatu Manufacturing', 1000, '20.00', '20000.00'),
(9, 7, 5, 'Nogatu Manufacturing', 6000, '45.00', '270000.00'),
(10, 8, 4, 'Nogatu Manufacturing', 1000, '45.00', '45000.00'),
(11, 9, 2, 'asdsad', 2321, '323.00', '749683.00'),
(12, 9, 2, 'asdsad', 1232, '332.00', '409024.00');


--
-- Table structure for products
--
DROP TABLE IF EXISTS `products`;
CREATE TABLE `products` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(200) NOT NULL,
  `sku` varchar(100) NOT NULL,
  `category` varchar(100) NOT NULL DEFAULT 'Drink Mixes',
  `retail_price` decimal(10,2) NOT NULL,
  `partner_price` decimal(10,2) NOT NULL,
  `unit` varchar(50) NOT NULL DEFAULT '420g Boxes',
  `description` text DEFAULT NULL,
  `image_url` varchar(500) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `sku` (`sku`),
  KEY `idx_category` (`category`),
  KEY `idx_sku` (`sku`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for products
--
INSERT INTO `products` (`id`, `name`, `sku`, `category`, `retail_price`, `partner_price`, `unit`, `description`, `image_url`, `is_active`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'Nogatu Coffee', 'NKT-COF-001', 'Drink Mixes', '70.00', '45.00', '420g Boxes', 'Premium Nogatu coffee blend, rich and aromatic.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(2, 'Nogatu Chocolate Drink', 'NKT-CHO-001', 'Drink Mixes', '70.00', '45.00', '420g Boxes', 'Rich chocolate drink mix with natural ingredients.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(3, 'Nogatu Barley Pure Drink', 'NKT-BAR-001', 'Coffee', '70.00', '45.00', '420g Boxes', 'Pure energy barley grass drink, naturally refreshing.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-04-09 00:32:43'),
(4, 'Nogatu Mangosteen Coffee', 'NKT-MAN-001', 'Drink Mixes', '70.00', '45.00', '420g Boxes', 'Unique blend of Mangosteen and premium coffee.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(5, 'Nogatu Coffee Mix', 'NKT-CMX-001', 'Drink Mixes', '70.00', '45.00', '420g Boxes', 'Classic 6-in-1 coffee mix, creamy and delicious.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(6, 'Nogatu Max Fuel Coffee', 'NKT-MXF-001', 'Drink Mixes', '70.00', '45.00', '420g Boxes', 'High-energy coffee blend for active lifestyles.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(7, 'Nogatu Coffee Mix (Dark)', 'NKT-CMD-001', 'Drink Mixes', '70.00', '45.00', '420g Boxes', 'Bold dark roast coffee mix for intense flavor.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(8, 'Nogatu Chocolate Drink Mix', 'NKT-CDM-001', 'Drink Mixes', '70.00', '20.00', '420g Boxes', 'Smooth chocolate drink mix with premium cocoa.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(9, 'Nogatu Pure Barley Drink Mix', 'NKT-PBD-001', 'Drink Mixes', '70.00', '25.00', '420g Boxes', 'Premium barley grass drink for daily wellness.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(10, 'Nogatu Juice', 'NKT-JUI-001', 'Beverages', '55.00', '35.00', 'Tetra Packs', 'Natural fruit juice blend with vitamins and minerals.', NULL, 1, 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(11, 'barlet', 'as', 'Coffee', '122.00', '12.00', '1', 'adsad', '/uploads/image-1773841190536-584746414.png', 0, 1, '2026-03-18 21:39:50', '2026-05-17 14:04:07'),
(12, 'a', 'a', 'Health Drink', '1312313.00', '123.00', '12', 'adsasd', 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1776102582/nogatu/products/qytigzf6yhgyxqmufv3x.png', 1, 0, '2026-03-18 21:58:48', '2026-04-14 01:49:44');


--
-- Table structure for proof_of_delivery
--
DROP TABLE IF EXISTS `proof_of_delivery`;
CREATE TABLE `proof_of_delivery` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint(20) unsigned NOT NULL,
  `token_id` bigint(20) unsigned NOT NULL,
  `photo_url` varchar(500) NOT NULL COMMENT 'Cloudinary URL',
  `gps_lat` decimal(10,8) DEFAULT NULL,
  `gps_lng` decimal(11,8) DEFAULT NULL,
  `recipient_name` varchar(150) DEFAULT NULL,
  `recipient_signature` text DEFAULT NULL,
  `signature_hash` char(64) DEFAULT NULL,
  `signed_at` timestamp NULL DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `submitted_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_order` (`order_id`),
  KEY `fk_pod_token` (`token_id`),
  CONSTRAINT `fk_pod_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  CONSTRAINT `fk_pod_token` FOREIGN KEY (`token_id`) REFERENCES `delivery_tokens` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for proof_of_delivery
--
INSERT INTO `proof_of_delivery` (`id`, `order_id`, `token_id`, `photo_url`, `gps_lat`, `gps_lng`, `recipient_name`, `recipient_signature`, `signature_hash`, `signed_at`, `notes`, `submitted_at`) VALUES
(1, 21, 1, 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1775709262/nogatu/pod/x4uglbmhvnzb01m2qhrg.jpg', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-04-09 12:34:23'),
(2, 22, 16, 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1779006549/nogatu/pod/m34dgaj8ip9q1rn50qk9.png', NULL, NULL, 'Vergel', 'data:image/png;base64,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', '036801463cad2247abaf0aa521d2b0e43f2e0da9bcd729b495f61a81a4734b0a', '2026-05-17 08:29:10', NULL, '2026-05-17 16:29:10'),
(3, 23, 17, 'https://res.cloudinary.com/dc5xtcjqg/image/upload/v1779033848/nogatu/pod/dlxgru7lwaoqebfv8ivb.png', '14.65000000', '121.01000000', 'ver', 'data:image/png;base64,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', 'f3fe58550574406e372d3ae816731eb6498074113d8c7b3c3db681b41abeb851', '2026-05-17 16:04:09', NULL, '2026-05-18 00:04:09');


--
-- Table structure for purchase_orders
--
DROP TABLE IF EXISTS `purchase_orders`;
CREATE TABLE `purchase_orders` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `po_number` varchar(30) NOT NULL,
  `supplier` varchar(150) NOT NULL,
  `created_by` bigint(20) unsigned NOT NULL,
  `status` enum('pending','approved','rejected','completed') NOT NULL DEFAULT 'pending',
  `auto_generated` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 if triggered by auto-replenishment cron',
  `total_amount` decimal(15,2) NOT NULL DEFAULT 0.00,
  `notes` text DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `po_number` (`po_number`),
  KEY `idx_status` (`status`),
  KEY `idx_auto` (`auto_generated`),
  KEY `fk_po_creator` (`created_by`),
  CONSTRAINT `fk_po_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for purchase_orders
--
INSERT INTO `purchase_orders` (`id`, `po_number`, `supplier`, `created_by`, `status`, `auto_generated`, `total_amount`, `notes`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'PO-2026030701', 'Pacific Packaging Supplies', 1, 'approved', 0, '8500.00', NULL, 0, '2026-03-05 00:00:00', '2026-03-18 19:45:10'),
(2, 'PO-2026034561', 'Pacific Packaging Supplies', 1, 'approved', 0, '8500.00', NULL, 0, '2026-03-05 00:00:00', '2026-03-18 19:45:10'),
(3, 'PO-AUTO-001', 'Nogatu Manufacturing', 1, 'pending', 1, '22500.00', NULL, 0, '2026-03-16 00:15:00', '2026-03-18 19:45:10'),
(4, 'PO-2026031801', 'Nogatu Manufacturing', 1, 'approved', 1, '45000.00', 'Auto-generated: Nogatu Mangosteen Coffee low stock at Cebu City Center', 0, '2026-03-18 20:30:00', '2026-04-14 01:47:13'),
(5, 'PO-2026031802', 'Nogatu Manufacturing', 1, 'pending', 1, '90000.00', 'Auto-generated: Nogatu Coffee low stock at Pangasinan Hub', 0, '2026-03-18 20:30:00', '2026-03-18 20:30:00'),
(6, 'PO-2026031803', 'Nogatu Manufacturing', 1, 'pending', 1, '20000.00', 'Auto-generated: Nogatu Chocolate Drink Mix low stock at Pangasinan Hub', 0, '2026-03-18 20:30:00', '2026-03-18 20:30:00'),
(7, 'PO-2026040801', 'Nogatu Manufacturing', 1, 'pending', 1, '270000.00', 'Auto-generated: Nogatu Coffee Mix low stock at Cebu City Center', 0, '2026-04-08 22:45:00', '2026-04-08 22:45:00'),
(8, 'PO-2026041401', 'Nogatu Manufacturing', 1, 'pending', 1, '45000.00', 'Auto-generated: Nogatu Mangosteen Coffee low stock at Cebu City Center', 0, '2026-04-14 02:00:00', '2026-04-14 02:00:00'),
(9, 'PO-2026051701', 'asdsad', 1, 'approved', 0, '1158707.00', 'asdasd', 0, '2026-05-17 16:09:31', '2026-05-17 16:09:37');


--
-- Table structure for roles
--
DROP TABLE IF EXISTS `roles`;
CREATE TABLE `roles` (
  `id` tinyint(3) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `slug` varchar(50) NOT NULL,
  `permissions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT json_object() CHECK (json_valid(`permissions`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`),
  UNIQUE KEY `slug` (`slug`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='System roles: super_admin, admin (partner), staff';

--
-- Table data for roles
--
INSERT INTO `roles` (`id`, `name`, `slug`, `permissions`, `created_at`) VALUES
(1, 'Super Administrator', 'super_admin', '{\"dashboard\":[\"view\"],\"inventory\":[\"view\",\"create\",\"edit\",\"delete\"],\"warehouses\":[\"view\",\"create\",\"edit\",\"delete\"],\"orders\":[\"view\",\"create\",\"edit\",\"delete\",\"approve\",\"reject\",\"mark_paid\",\"mark_delivered\"],\"partners\":[\"view\",\"create\",\"edit\",\"delete\"],\"products\":[\"view\",\"create\",\"edit\",\"delete\"],\"stock_transfers\":[\"view\",\"create\",\"edit\",\"complete\"],\"purchase_orders\":[\"view\",\"create\",\"edit\",\"approve\"],\"reports\":[\"view\",\"export\"],\"users\":[\"view\",\"create\",\"edit\",\"delete\"],\"notifications\":[\"view\",\"manage\"],\"tracking\":[\"view\"]}', '2026-03-18 19:45:08'),
(2, 'Provincial Stockist', 'provincial_stockist', '{\"dashboard\":[\"view\"],\"catalog\":[\"view\"],\"cart\":[\"view\",\"create\",\"edit\",\"delete\"],\"orders\":[\"view\",\"create\",\"cancel\"],\"reports\":[\"view\"],\"users\":[\"view\",\"create_staff\"],\"grn\":[\"view\",\"create\",\"complete\"],\"mobile_stockists\":[\"view\",\"create\",\"edit\"],\"stock_transfers\":[\"view\",\"create\"],\"purchase_orders\":[\"view\",\"create\"],\"inventory\":[\"view\",\"request_adjustment\"],\"warehouses\":[\"view\"],\"notifications\":[\"view\"],\"tracking\":[\"view\"]}', '2026-03-18 19:45:08'),
(3, 'Staff', 'staff', '{\"dashboard\":[\"view\"],\"catalog\":[\"view\"],\"orders\":[\"view\"],\"inventory\":[\"view\"],\"grn\":[\"view\",\"create\",\"complete\"],\"reports\":[\"view\"],\"notifications\":[\"view\"],\"tracking\":[\"view\"]}', '2026-03-18 19:45:08'),
(5, 'City Stockist', 'city_stockist', '{\"dashboard\":[\"view\"],\"catalog\":[\"view\"],\"cart\":[\"view\",\"create\",\"edit\",\"delete\"],\"orders\":[\"view\",\"create\",\"cancel\"],\"reports\":[\"view\"],\"users\":[\"view\",\"create_staff\"],\"grn\":[\"view\",\"create\",\"complete\"],\"mobile_stockists\":[\"view\",\"create\",\"edit\"],\"notifications\":[\"view\"],\"tracking\":[\"view\"]}', '2026-04-06 04:58:11'),
(6, 'Mobile Stockist', 'mobile_stockist', '{\"dashboard\":[\"view\"],\"catalog\":[\"view\"],\"cart\":[\"view\",\"create\",\"edit\",\"delete\"],\"orders\":[\"view\",\"create\"],\"profile\":[\"view\",\"edit\"],\"tracking\":[\"view\"]}', '2026-04-06 04:58:11');


--
-- Table structure for settlements
--
DROP TABLE IF EXISTS `settlements`;
CREATE TABLE `settlements` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `settlement_number` varchar(50) NOT NULL,
  `order_id` bigint(20) unsigned NOT NULL,
  `partner_id` bigint(20) unsigned NOT NULL,
  `amount` decimal(15,2) NOT NULL DEFAULT 0.00,
  `method` enum('bank_transfer','cod','courier_remittance','manual') NOT NULL DEFAULT 'bank_transfer',
  `status` enum('draft','pending','reconciled','disputed','cancelled') NOT NULL DEFAULT 'pending',
  `expected_at` timestamp NULL DEFAULT NULL,
  `reconciled_at` timestamp NULL DEFAULT NULL,
  `reconciled_by` bigint(20) unsigned DEFAULT NULL,
  `reference_number` varchar(100) DEFAULT NULL,
  `variance_amount` decimal(15,2) NOT NULL DEFAULT 0.00,
  `notes` text DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `settlement_number` (`settlement_number`),
  KEY `idx_settlements_order` (`order_id`),
  KEY `idx_settlements_partner` (`partner_id`),
  KEY `idx_settlements_status` (`status`),
  KEY `fk_settlements_reconciled_by` (`reconciled_by`),
  CONSTRAINT `fk_settlements_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`),
  CONSTRAINT `fk_settlements_partner` FOREIGN KEY (`partner_id`) REFERENCES `partners` (`id`),
  CONSTRAINT `fk_settlements_reconciled_by` FOREIGN KEY (`reconciled_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Table data for settlements
--
INSERT INTO `settlements` (`id`, `settlement_number`, `order_id`, `partner_id`, `amount`, `method`, `status`, `expected_at`, `reconciled_at`, `reconciled_by`, `reference_number`, `variance_amount`, `notes`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'SET-2026051701', 22, 2, '135.00', 'bank_transfer', 'pending', '2026-05-17 16:27:53', NULL, NULL, NULL, '0.00', NULL, 0, '2026-05-17 16:27:53', '2026-05-17 16:27:53'),
(4, 'SET-2026051702', 23, 2, '45.00', 'bank_transfer', 'pending', '2026-05-17 19:46:45', NULL, NULL, NULL, '0.00', NULL, 0, '2026-05-17 19:46:45', '2026-05-17 19:46:45');


--
-- Table structure for stock_adjustments
--
DROP TABLE IF EXISTS `stock_adjustments`;
CREATE TABLE `stock_adjustments` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `inventory_id` bigint(20) unsigned NOT NULL,
  `adjustment_type` enum('add','subtract','set') NOT NULL,
  `quantity` int(11) NOT NULL,
  `reason` varchar(300) NOT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `requested_by` bigint(20) unsigned NOT NULL,
  `reviewed_by` bigint(20) unsigned DEFAULT NULL,
  `reviewed_at` timestamp NULL DEFAULT NULL,
  `rejection_reason` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_inventory` (`inventory_id`),
  KEY `idx_status` (`status`),
  KEY `fk_sa_requester` (`requested_by`),
  KEY `fk_sa_reviewer` (`reviewed_by`),
  CONSTRAINT `fk_sa_inventory` FOREIGN KEY (`inventory_id`) REFERENCES `inventories` (`id`),
  CONSTRAINT `fk_sa_requester` FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_sa_reviewer` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=26 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for stock_adjustments
--
INSERT INTO `stock_adjustments` (`id`, `inventory_id`, `adjustment_type`, `quantity`, `reason`, `status`, `requested_by`, `reviewed_by`, `reviewed_at`, `rejection_reason`, `created_at`, `updated_at`) VALUES
(1, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:23:38', NULL, '2026-04-14 00:23:38', '2026-04-14 00:23:38'),
(2, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:23:38', 'Smoke test cleanup reject', '2026-04-14 00:23:38', '2026-04-14 00:23:38'),
(3, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:27:45', NULL, '2026-04-14 00:27:45', '2026-04-14 00:27:45'),
(4, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:27:45', 'Smoke test cleanup reject', '2026-04-14 00:27:45', '2026-04-14 00:27:45'),
(5, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:28:48', NULL, '2026-04-14 00:28:48', '2026-04-14 00:28:48'),
(6, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:28:48', 'Smoke test cleanup reject', '2026-04-14 00:28:48', '2026-04-14 00:28:48'),
(7, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:30:13', NULL, '2026-04-14 00:30:13', '2026-04-14 00:30:13'),
(8, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:30:13', 'Smoke test cleanup reject', '2026-04-14 00:30:13', '2026-04-14 00:30:13'),
(9, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:31:48', NULL, '2026-04-14 00:31:48', '2026-04-14 00:31:48'),
(10, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:31:48', 'Smoke test cleanup reject', '2026-04-14 00:31:48', '2026-04-14 00:31:48'),
(11, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:41:15', NULL, '2026-04-14 00:41:15', '2026-04-14 00:41:15'),
(12, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:41:15', 'Smoke test cleanup reject', '2026-04-14 00:41:15', '2026-04-14 00:41:15'),
(13, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:43:21', NULL, '2026-04-14 00:43:21', '2026-04-14 00:43:21'),
(14, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:43:21', 'Smoke test cleanup reject', '2026-04-14 00:43:21', '2026-04-14 00:43:21'),
(15, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:46:49', NULL, '2026-04-14 00:46:49', '2026-04-14 00:46:49'),
(16, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:46:49', 'Smoke test cleanup reject', '2026-04-14 00:46:49', '2026-04-14 00:46:49'),
(17, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:53:02', NULL, '2026-04-14 00:53:02', '2026-04-14 00:53:02'),
(18, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:53:02', 'Smoke test cleanup reject', '2026-04-14 00:53:02', '2026-04-14 00:53:02'),
(19, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 00:57:09', NULL, '2026-04-14 00:57:09', '2026-04-14 00:57:09'),
(20, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 00:57:09', 'Smoke test cleanup reject', '2026-04-14 00:57:09', '2026-04-14 00:57:09'),
(21, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 01:08:19', NULL, '2026-04-14 01:08:19', '2026-04-14 01:08:19'),
(22, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 01:08:19', 'Smoke test cleanup reject', '2026-04-14 01:08:19', '2026-04-14 01:08:19'),
(23, 4, 'set', 899, 'Smoke test set adjustment (no stock delta expected)', 'approved', 1, 1, '2026-04-14 01:18:50', NULL, '2026-04-14 01:18:50', '2026-04-14 01:18:50'),
(24, 4, 'add', 1, 'Smoke test reject path', 'rejected', 1, 1, '2026-04-14 01:18:50', 'Smoke test cleanup reject', '2026-04-14 01:18:50', '2026-04-14 01:18:50'),
(25, 16, 'add', 1079, 'asd', 'approved', 1, 1, '2026-05-17 14:03:32', NULL, '2026-05-17 14:03:29', '2026-05-17 14:03:32');


--
-- Table structure for stock_movements
--
DROP TABLE IF EXISTS `stock_movements`;
CREATE TABLE `stock_movements` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `inventory_id` bigint(20) unsigned NOT NULL,
  `product_id` bigint(20) unsigned NOT NULL,
  `warehouse_id` bigint(20) unsigned NOT NULL,
  `movement_type` enum('in','out','reserve','release','adjustment','grn','initial_stock','manual_increase','manual_decrease','transfer_out','transfer_in','cycle_count_increase','cycle_count_decrease') NOT NULL,
  `quantity` int(11) NOT NULL COMMENT 'Positive = increase, negative = decrease',
  `reference_type` varchar(50) DEFAULT NULL COMMENT 'order, grn, adjustment, transfer',
  `reference_id` bigint(20) unsigned DEFAULT NULL,
  `before_stock` int(10) unsigned NOT NULL DEFAULT 0,
  `after_stock` int(10) unsigned NOT NULL DEFAULT 0,
  `notes` text DEFAULT NULL,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_inventory` (`inventory_id`),
  KEY `idx_product` (`product_id`),
  KEY `idx_warehouse` (`warehouse_id`),
  KEY `idx_type` (`movement_type`),
  KEY `idx_reference` (`reference_type`,`reference_id`),
  KEY `idx_created` (`created_at`),
  KEY `fk_sm_creator` (`created_by`),
  KEY `idx_sm_is_deleted` (`is_deleted`),
  CONSTRAINT `fk_sm_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sm_inventory` FOREIGN KEY (`inventory_id`) REFERENCES `inventories` (`id`),
  CONSTRAINT `fk_sm_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `fk_sm_warehouse` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=50 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for stock_movements
--
INSERT INTO `stock_movements` (`id`, `inventory_id`, `product_id`, `warehouse_id`, `movement_type`, `quantity`, `reference_type`, `reference_id`, `before_stock`, `after_stock`, `notes`, `created_by`, `created_at`, `is_deleted`) VALUES
(2, 4, 4, 1, 'reserve', 120, 'order', 18, 0, 0, 'Stock reserved on order placement', 2, '2026-04-09 11:05:08', 0),
(3, 5, 5, 1, 'reserve', 4, 'order', 18, 0, 0, 'Stock reserved on order placement', 2, '2026-04-09 11:05:08', 0),
(4, 2, 2, 1, 'reserve', 320, 'order', 19, 0, 0, 'Stock reserved on order placement', 2, '2026-04-09 11:22:39', 0),
(5, 3, 3, 1, 'reserve', 100, 'order', 20, 0, 0, 'Stock reserved on order placement', 3, '2026-04-09 11:51:01', 0),
(6, 4, 4, 1, 'reserve', 1, 'order', 21, 0, 0, 'Stock reserved on order placement', 2, '2026-04-09 12:06:18', 0),
(7, 4, 4, 1, 'out', 1, 'order', 21, 0, 0, 'Stock out on delivery confirmation', NULL, '2026-04-09 12:34:23', 0),
(8, 4, 4, 1, 'adjustment', 0, 'adjustment', 1, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:23:38', 0),
(9, 4, 4, 1, 'adjustment', 0, 'adjustment', 3, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:27:45', 0),
(10, 4, 4, 1, 'adjustment', 0, 'adjustment', 5, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:28:48', 0),
(11, 4, 4, 1, 'adjustment', 0, 'adjustment', 7, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:30:13', 0),
(12, 4, 4, 1, 'adjustment', 0, 'adjustment', 9, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:31:48', 0),
(13, 4, 4, 1, 'adjustment', 0, 'adjustment', 11, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:41:15', 0),
(14, 4, 4, 1, 'adjustment', 0, 'adjustment', 13, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:43:21', 0),
(15, 4, 4, 1, 'adjustment', 0, 'adjustment', 15, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:46:49', 0),
(16, 4, 4, 1, 'adjustment', 0, 'adjustment', 17, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:53:02', 0),
(17, 4, 4, 1, 'adjustment', 0, 'adjustment', 19, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 00:57:09', 0),
(18, 4, 4, 1, 'adjustment', 0, 'adjustment', 21, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 01:08:19', 0),
(19, 4, 4, 1, 'adjustment', 0, 'adjustment', 23, 0, 0, 'Smoke test set adjustment (no stock delta expected)', 1, '2026-04-14 01:18:50', 0),
(20, 16, 8, 6, 'manual_increase', 2190, 'inventory', 16, 0, 0, 'Manual inventory stock update from 0 to 2190', 1, '2026-05-17 14:02:14', 0),
(21, 12, 4, 4, 'manual_increase', 10000, 'inventory', 12, 0, 0, 'Manual inventory stock update from 0 to 10000', 1, '2026-05-17 14:02:27', 0),
(22, 16, 8, 6, 'adjustment', 1079, 'adjustment', 25, 0, 0, 'asd', 1, '2026-05-17 14:03:32', 0),
(23, 1, 1, 1, 'reserve', 1, 'order', 22, 0, 0, 'Stock reserved on order placement', 2, '2026-05-17 14:06:06', 0),
(24, 2, 2, 1, 'reserve', 1, 'order', 22, 0, 0, 'Stock reserved on order placement', 2, '2026-05-17 14:06:06', 0),
(25, 3, 3, 1, 'reserve', 1, 'order', 22, 0, 0, 'Stock reserved on order placement', 2, '2026-05-17 14:06:06', 0),
(26, 1, 1, 1, 'out', 1, 'order', 22, 0, 0, 'Stock out on delivery confirmation', NULL, '2026-05-17 16:29:10', 0),
(27, 2, 2, 1, 'out', 1, 'order', 22, 0, 0, 'Stock out on delivery confirmation', NULL, '2026-05-17 16:29:10', 0),
(28, 3, 3, 1, 'out', 1, 'order', 22, 0, 0, 'Stock out on delivery confirmation', NULL, '2026-05-17 16:29:10', 0),
(40, 4, 4, 1, 'reserve', 1, 'order', 23, 0, 0, 'Stock reserved on order placement', 2, '2026-05-17 19:44:54', 0),
(41, 18, 8, 4, 'in', 1, 'grn', 2, 0, 0, 'Stock received via GRN', 2, '2026-05-17 23:13:42', 0),
(42, 4, 4, 1, 'out', 1, 'order', 23, 0, 0, 'Stock out on delivery confirmation', NULL, '2026-05-18 00:04:09', 0);


--
-- Table structure for stock_transfers
--
DROP TABLE IF EXISTS `stock_transfers`;
CREATE TABLE `stock_transfers` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `transfer_number` varchar(30) NOT NULL,
  `from_warehouse_id` bigint(20) unsigned NOT NULL,
  `to_warehouse_id` bigint(20) unsigned NOT NULL,
  `created_by` bigint(20) unsigned NOT NULL,
  `status` enum('pending','in_transit','completed','cancelled') NOT NULL DEFAULT 'pending',
  `notes` text DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `transfer_number` (`transfer_number`),
  KEY `idx_from` (`from_warehouse_id`),
  KEY `idx_to` (`to_warehouse_id`),
  KEY `idx_status` (`status`),
  KEY `fk_st_creator` (`created_by`),
  CONSTRAINT `fk_st_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_st_from` FOREIGN KEY (`from_warehouse_id`) REFERENCES `warehouses` (`id`),
  CONSTRAINT `fk_st_to` FOREIGN KEY (`to_warehouse_id`) REFERENCES `warehouses` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for stock_transfers
--
INSERT INTO `stock_transfers` (`id`, `transfer_number`, `from_warehouse_id`, `to_warehouse_id`, `created_by`, `status`, `notes`, `completed_at`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'TRF-2026030701', 1, 2, 1, 'completed', NULL, '2026-03-07 09:00:00', 0, '2026-03-05 10:00:00', '2026-03-18 19:45:10'),
(2, 'OPF-2026030701', 1, 4, 1, 'completed', NULL, '2026-04-08 22:44:59', 0, '2026-03-15 10:00:00', '2026-04-08 22:44:59'),
(3, 'OPF-2026030702', 1, 4, 1, 'in_transit', NULL, NULL, 0, '2026-03-15 10:00:00', '2026-03-18 19:45:10'),
(4, 'TRF-2026040801', 4, 1, 1, 'pending', '2', NULL, 0, '2026-04-08 22:43:58', '2026-04-08 22:43:58'),
(5, 'TRF-2026040901', 3, 1, 1, 'pending', 'asd', NULL, 0, '2026-04-09 11:32:03', '2026-04-09 11:32:03');


--
-- Table structure for transfer_items
--
DROP TABLE IF EXISTS `transfer_items`;
CREATE TABLE `transfer_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `transfer_id` bigint(20) unsigned NOT NULL,
  `product_id` bigint(20) unsigned NOT NULL,
  `quantity` int(10) unsigned NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_transfer` (`transfer_id`),
  KEY `fk_ti_product` (`product_id`),
  CONSTRAINT `fk_ti_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`),
  CONSTRAINT `fk_ti_transfer` FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for transfer_items
--
INSERT INTO `transfer_items` (`id`, `transfer_id`, `product_id`, `quantity`) VALUES
(1, 1, 2, 2000),
(2, 2, 5, 2000),
(3, 3, 9, 2000),
(4, 4, 3, 1),
(5, 4, 11, 2),
(6, 5, 2, 12);


--
-- Table structure for users
--
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `email` varchar(150) NOT NULL,
  `password` varchar(255) NOT NULL COMMENT 'bcrypt hashed',
  `phone` varchar(30) DEFAULT NULL,
  `role_id` tinyint(3) unsigned NOT NULL,
  `partner_id` bigint(20) unsigned DEFAULT NULL COMMENT 'NULL for super_admin; set for admin and staff',
  `level` enum('main','regional','city') NOT NULL DEFAULT 'main',
  `location` varchar(150) NOT NULL DEFAULT 'Regional Hub - North',
  `status` enum('active','inactive','suspended') NOT NULL DEFAULT 'active',
  `last_login` timestamp NULL DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_role` (`role_id`),
  KEY `idx_partner` (`partner_id`),
  KEY `idx_status` (`status`),
  CONSTRAINT `fk_users_partner` FOREIGN KEY (`partner_id`) REFERENCES `partners` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=27 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for users
--
INSERT INTO `users` (`id`, `name`, `email`, `password`, `phone`, `role_id`, `partner_id`, `level`, `location`, `status`, `last_login`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, 'Pedro Reyes', 'superadmin@nogatu.com', '$2a$12$g0/F8fkDvfmv0cichLcRB.eSLSRcEi4BUZLNz2/e6zBJeomUGE1oe', '09111111111', 1, NULL, 'main', 'Main Office', 'active', '2026-05-18 00:35:28', 0, '2026-03-18 19:45:09', '2026-05-18 00:35:28'),
(2, 'Carmen Velasquez', 'provincial@nogatu.com', '$2a$12$2Ktp427ow2W5HEzSsT2rXuzb6ueVT/D7dmKew3ptZh1zh35M.S8Sq', '09112222222', 2, 2, 'regional', 'Main Office', 'active', '2026-05-18 00:35:30', 0, '2026-03-18 19:45:09', '2026-05-18 00:35:30'),
(3, 'Paolo Dizon', 'city@nogatu.com', '$2a$12$3rnDZZWw0bHmUSqEgrcP4u8iHd6rsvqFTlFJuxBcu5nIYLcN80U1a', '09113333333', 5, 4, 'city', 'Main Office', 'active', '2026-05-18 00:35:31', 0, '2026-03-18 19:45:09', '2026-05-18 00:35:31'),
(4, 'Juan dela Cruz', 'mobile@nogatu.com', '$2a$12$wumWgLLX38EnJjWl9wSbqOUuf35zHYFnauqtRMUqhzTGhZrgTuDte', '09121111111', 6, 4, 'city', 'Regional Hub - North', 'active', '2026-05-18 00:35:32', 0, '2026-03-18 19:45:09', '2026-05-18 00:35:32'),
(5, 'Maria Santos', 'maria@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09122222222', 2, 2, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(6, 'Ana Garcia', 'ana@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09123333333', 2, 3, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(7, 'Carlos Mendoza', 'carlos@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09124444444', 5, 4, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(8, 'Gabriel Chavez', 'gabriel@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09125555555', 5, 5, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(9, 'Lisa Fernandez', 'lisa@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09131111111', 3, 1, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(10, 'Ricardo Gomez', 'ricardo@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09132222222', 3, 1, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(11, 'Elena Cruz', 'elena@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09133333333', 3, 2, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(12, 'Ramon Torres', 'staff@nogatu.com', '$2a$12$pco0xMbbpbpe4hOTq.Jw6eb9fAUUby.8VoPvZ0FpNmD.OugILzSI6', '09134444444', 3, 2, 'regional', 'Regional Hub - North', 'active', '2026-05-18 00:35:32', 0, '2026-03-18 19:45:09', '2026-05-18 00:35:32'),
(13, 'Gabriel Sy', 'gabrielsy@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09135555555', 3, 4, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(14, 'Dante Alis', 'dante@nogatu.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiMC.7HPuvbFJxXEGCkHBODk.LG2', '09136666666', 3, 5, 'main', 'Regional Hub - North', 'active', '2026-03-07 10:30:00', 0, '2026-03-18 19:45:09', '2026-03-18 19:45:09'),
(15, 'aasdsad', 'VERGEL.AGRIPA.BAUTISTA@GMAIL.COM', '$2a$12$mJ1ZWD9y0jBXhwMhOFtHEe6RYVCxwsAwDtYvP9ReCUB4oMHaVM1oq', NULL, 3, 1, 'main', 'Regional Hub - North', 'inactive', NULL, 1, '2026-03-18 22:49:26', '2026-03-18 23:04:23'),
(16, 'Vergel Bautista', 'a@gmail.com', '$2a$12$0O892CYtI1M669lwxfllL.0MqzetzM/LqFRtam0wl9haGdjKzIbSW', NULL, 1, NULL, 'main', 'Regional Hub - North', 'inactive', NULL, 1, '2026-03-18 23:04:11', '2026-03-18 23:04:16');


--
-- Table structure for warehouses
--
DROP TABLE IF EXISTS `warehouses`;
CREATE TABLE `warehouses` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `partner_id` bigint(20) unsigned DEFAULT NULL,
  `name` varchar(150) NOT NULL,
  `type` enum('manufacturer','region','city') NOT NULL DEFAULT 'region',
  `location` varchar(200) NOT NULL,
  `capacity_total` int(10) unsigned NOT NULL DEFAULT 100000,
  `capacity_used` int(10) unsigned NOT NULL DEFAULT 0,
  `manager_name` varchar(150) NOT NULL,
  `manager_email` varchar(150) DEFAULT NULL,
  `manager_phone` varchar(30) DEFAULT NULL,
  `lat` decimal(10,8) DEFAULT NULL,
  `lng` decimal(11,8) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_type` (`type`),
  KEY `idx_warehouses_partner_id` (`partner_id`),
  CONSTRAINT `fk_warehouses_partner` FOREIGN KEY (`partner_id`) REFERENCES `partners` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Table data for warehouses
--
INSERT INTO `warehouses` (`id`, `partner_id`, `name`, `type`, `location`, `capacity_total`, `capacity_used`, `manager_name`, `manager_email`, `manager_phone`, `lat`, `lng`, `is_active`, `is_deleted`, `created_at`, `updated_at`) VALUES
(1, NULL, 'Goldenstar Warehouse', 'manufacturer', 'Metro Manila, Philippines', 200000, 130000, 'Juan Dela Cruz', 'juan@nogatu.com', '09121111111', '14.59950000', '120.98420000', 1, 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(2, 1, 'North Region', 'region', 'Metro Manila, Philippines', 100000, 65000, 'Juan Dela Cruz', 'juan@nogatu.com', '09121111111', '14.67600000', '121.04370000', 1, 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(3, 4, 'South Region', 'region', 'Metro Manila, Philippines', 100000, 65000, 'Juan Dela Cruz', 'juan@nogatu.com', '09121111111', '14.47930000', '121.01980000', 1, 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(4, 2, 'Cebu City Center', 'city', 'Cebu City, Philippines', 100000, 65000, 'Juan Dela Cruz', 'juan@nogatu.com', '09121111111', '10.31570000', '123.88540000', 1, 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(5, 3, 'Davao Regional Hub', 'region', 'Davao City, Philippines', 100000, 40000, 'Carlos Mendoza', 'carlos@nogatu.com', '09124444444', '7.19070000', '125.45530000', 1, 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06'),
(6, 5, 'Pangasinan Hub', 'city', 'Dagupan, Pangasinan', 80000, 30000, 'Gabriel Chavez', 'gabriel@nogatu.com', '09125555555', '15.52980000', '120.33170000', 1, 0, '2026-03-18 19:45:09', '2026-05-17 17:33:06');


--
-- View structure for vw_dashboard_kpis
--
DROP VIEW IF EXISTS `vw_dashboard_kpis`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `vw_dashboard_kpis` AS select (select coalesce(sum(`orders`.`total_amount`),0) from `orders` where `orders`.`status` = 'delivered' and `orders`.`payment_status` = 'paid' and `orders`.`is_deleted` = 0) AS `total_revenue`,(select coalesce(sum(`p`.`retail_price` * `i`.`current_stock`),0) from (`inventories` `i` join `products` `p` on(`p`.`id` = `i`.`product_id`)) where `i`.`is_active` = 1 and `p`.`is_deleted` = 0) AS `inventory_value`,(select count(0) from `orders` where `orders`.`status` = 'pending' and `orders`.`is_deleted` = 0) AS `pending_orders`,(select count(0) from `partners` where `partners`.`status` = 'active' and `partners`.`is_deleted` = 0) AS `active_stockists`;

--
-- View structure for vw_inventory_detail
--
DROP VIEW IF EXISTS `vw_inventory_detail`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `vw_inventory_detail` AS select `i`.`id` AS `id`,`p`.`name` AS `product_name`,`p`.`sku` AS `sku`,`p`.`category` AS `category`,`w`.`name` AS `warehouse_name`,`w`.`type` AS `warehouse_type`,`w`.`location` AS `location`,`i`.`current_stock` AS `current_stock`,`i`.`reorder_threshold` AS `reorder_threshold`,`i`.`status` AS `status`,`i`.`batch_number` AS `batch_number`,`i`.`expiry_date` AS `expiry_date`,`i`.`updated_at` AS `updated_at` from ((`inventories` `i` join `products` `p` on(`p`.`id` = `i`.`product_id`)) join `warehouses` `w` on(`w`.`id` = `i`.`warehouse_id`)) where `i`.`is_active` = 1 and `p`.`is_deleted` = 0 and `w`.`is_deleted` = 0;

--
-- View structure for vw_order_summary
--
DROP VIEW IF EXISTS `vw_order_summary`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `vw_order_summary` AS select `o`.`id` AS `id`,`o`.`order_number` AS `order_number`,`pt`.`business_name` AS `partner_name`,`u`.`name` AS `placed_by_name`,`o`.`status` AS `status`,`o`.`payment_status` AS `payment_status`,`o`.`payment_deadline` AS `payment_deadline`,`o`.`total_amount` AS `total_amount`,`o`.`created_at` AS `created_at`,`o`.`approved_at` AS `approved_at`,`o`.`delivered_at` AS `delivered_at` from ((`orders` `o` join `partners` `pt` on(`pt`.`id` = `o`.`partner_id`)) left join `users` `u` on(`u`.`id` = `o`.`placed_by`)) where `o`.`is_deleted` = 0;

SET FOREIGN_KEY_CHECKS = 1;
