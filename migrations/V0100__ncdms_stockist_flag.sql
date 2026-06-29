-- NCDMS <-> MLM bridge: flag which members are NCDMS stockists.
-- NCDMS (nogatu.store dropshipping) users are all stockists; stockists earn their
-- own Portions in the global bonus, so the MLM must know which usertab rows are
-- stockists. Populated via POST /api/external/stockists/sync (NCDMS pushes its
-- stockist usernames).
--
-- RUN ONCE against the MLM database (NOT the NCDMS db). This file is mirrored in
-- the NCDMS backend repo so it is reachable on the VPS from /var/www/nogatu-ncdms-be:
--   mysql nogatualliance_sysdb < /var/www/nogatu-ncdms-be/migrations/V0100__ncdms_stockist_flag.sql
-- (Canonical copy lives in the NogatuMLM repo: Nogatu_Backend/migrations/.)
ALTER TABLE usertab ADD COLUMN stockist TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE usertab ADD INDEX idx_usertab_stockist (stockist);
