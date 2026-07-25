# Production Reset — `scripts/productionReset.js`

Turns a seeded/demo NCDMS database into a clean production starting state:

1. Creates (or restores) exactly one real **super admin** account.
2. Creates a small, clearly-labeled **`TEST — ` org tree** — one account per
   role, so the client can see every tier working end-to-end before real
   Stockists sign up:
   - `TEST — Provincial Stockist (45% discount)` + `TEST — Provincial
     Warehouse`
   - `TEST — City Stockist (40% discount)` (child of the provincial partner)
     + `TEST — City Warehouse`
   - A mobile stockist under the city partner
   - A staff account attached to the TEST City Warehouse via
     `users.warehouse_id` (demonstrates the "staff associated to a
     warehouse; can place orders, adjust inventory, approve lower-tier"
     capability)
3. Soft-deletes (`is_deleted = 1`) every other seeded user, partner,
   warehouse, and mobile-stockist row.

**Always preserved, no matter what:** the manufacturer/company warehouse
(`warehouses.partner_id IS NULL`, e.g. "Goldenstar Warehouse"), and the
entire `products` table. Neither is ever queried for deletion.

## Safety model

- **Dry run by default.** Nothing is written unless you pass `--apply`.
- Everything `--apply` does runs inside **one transaction**; any error rolls
  back the entire run.
- **Idempotent.** Every create/restore is matched by a stable natural key
  (email for users/partners/mobile stockists, name for warehouses), and the
  archive step re-derives its `NOT IN (...)` filter from those same
  identifiers on every run — not from ids captured during that run. Running
  `--apply` twice in a row produces the same end state, no duplicates.
- **Never `DELETE FROM`** a business/historical row. Everything is
  soft-deleted. (The one exception — `cart_items` under
  `--wipe-transactions` — is explained below.)
- **Defensive against schema drift.** Optional columns (`users.warehouse_id`,
  `partners.parent_partner_id` / `stockist_level` / `discount_pct`,
  `mobile_stockists.user_id` / `discount_pct`) are guarded with
  `ER_BAD_FIELD_ERROR` fallbacks, the same pattern used in
  `src/controllers/courierController.js`. If a required **role** (
  `super_admin`, `provincial_stockist`, `city_stockist`, `mobile_stockist`,
  `staff`) is missing from the `roles` table, the script fails closed and
  aborts before writing anything.
- The super admin **password is never printed**, logged, or stored anywhere
  but the `users.password` bcrypt hash (12 rounds).

## Usage

```bash
# Dry run (default, safe, makes zero writes) — read this output first.
node --env-file=.env.dev  scripts/productionReset.js
node --env-file=.env.prod scripts/productionReset.js

# Apply for real. SEED_SUPERADMIN_PASSWORD is REQUIRED — the script exits
# with an error before touching the DB if it's unset or too short (<10 chars).
SEED_SUPERADMIN_PASSWORD='<a strong password>' \
node --env-file=.env.prod scripts/productionReset.js --apply

# Apply AND also wipe seeded transactional data (orders/carts/stock
# transfers/goods receipts) for a fully fresh transactional slate.
# OFF by default — only add this if you explicitly want it.
SEED_SUPERADMIN_PASSWORD='<a strong password>' \
node --env-file=.env.prod scripts/productionReset.js --apply --wipe-transactions
```

Always read the dry-run output before applying. It prints exactly what will
be created/restored and exactly what will be archived, table by table.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SEED_SUPERADMIN_EMAIL` | no | `admin@nogatu.store` | Login email for the real super admin. |
| `SEED_SUPERADMIN_PASSWORD` | **yes, for `--apply`** | — | Not hardcoded anywhere. Script refuses to `--apply` without it. Never printed. Hashed with bcrypt (12 rounds). |
| `SEED_TEST_PASSWORD` | no | `NogatuTest#2026` | Shared password for all four `TEST — ` accounts below. Change it if you don't want the default documented here to be valid in production — it's printed in this file. |

If `SEED_SUPERADMIN_EMAIL` matches an existing user (active **or**
soft-deleted), that row is restored/updated in place instead of a duplicate
being created — including the edge case where it happens to match the old
demo super admin's email.

## Test accounts created

| Role | Email | Password | Notes |
|---|---|---|---|
| `provincial_stockist` | `test.provincial@nogatu.store` | `SEED_TEST_PASSWORD` | 45% discount, orders from Goldenstar. |
| `city_stockist` | `test.city@nogatu.store` | `SEED_TEST_PASSWORD` | 40% discount, child of the TEST provincial partner, orders from it. |
| `mobile_stockist` | `test.mobile@nogatu.store` | `SEED_TEST_PASSWORD` | Under the TEST city partner. 35% discount recorded per the June decision; only persisted if `mobile_stockists.discount_pct` exists (guarded — the current schema doesn't have this column, so discount there currently lives on the parent partner). |
| `staff` | `test.staff@nogatu.store` | `SEED_TEST_PASSWORD` | Attached to `TEST — City Warehouse` via `users.warehouse_id`. Can place orders, do inventory adjustments, approve lower-tier — cannot manage users or assign discounts. |

## What gets archived

On `--apply`, every user/partner/warehouse/mobile-stockist row that is NOT
one of the accounts above (matched by email, or by name for warehouses) is
soft-deleted (`is_deleted = 1`, `status = 'inactive'` where that column
exists). This includes the old demo super admin. Nothing under `products` is
ever touched.

## `--wipe-transactions` (optional, off by default)

When passed together with `--apply`, additionally:

- `orders`, `stock_transfers`, `goods_receipts`: soft-deleted
  (`is_deleted = 1`). Their `status` column is left untouched — it's a
  lifecycle field, not a deletion marker, and mutating e.g. a `delivered`
  order's status to `cancelled` would falsify history.
- `cart_items`: **hard-deleted** for every user other than the super admin
  and the four TEST accounts. `cart_items` has no `is_deleted` column in
  the current schema, and the app itself already hard-deletes cart rows on
  removal/checkout (see `src/controllers/cartController.js`) — it's
  ephemeral UI state, not a historical record, so this matches existing
  convention rather than violating the soft-delete rule.
- `delivery_tracking`: **left untouched.** It has no `is_deleted` column and
  no safe terminal status to repurpose as a deletion marker, so the script
  deliberately does nothing here rather than guess (fail closed).

Default is OFF — do not pass this flag unless you explicitly want seeded
transactional data cleared.

## Verifying before you apply

The dry run makes zero writes. You can prove it yourself:

```bash
# before
node --env-file=.env.dev -e "require('./src/config/db').query('SELECT COUNT(*) c FROM users WHERE is_deleted=0').then(([r])=>console.log(r))"

node --env-file=.env.dev scripts/productionReset.js

# after — counts must be identical
node --env-file=.env.dev -e "require('./src/config/db').query('SELECT COUNT(*) c FROM users WHERE is_deleted=0').then(([r])=>console.log(r))"
```
