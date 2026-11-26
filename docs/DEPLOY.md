# Deploy and setup guide: Nogatu NCDMS

How the system runs, how a release goes out, and how a new device gets set up. Status and next steps live in
`docs/HANDOFF.md`. Checked 2026-11-26 against the workspace runbooks (`NOGATU_STAGING_SETUP_2026-10-06.md`,
`NOGATU_GREEN_STAGING_RUNBOOK.md`) and the staging deploy outputs of 2026-11-23/24. Never put a secret here.

## 1. Environments (one VPS, shared MariaDB 10.11)

| | Live | Staging |
|---|---|---|
| Code dir on VPS | `/var/www/nogatu-ncdms-be` | `/var/www/nogatu-ncdms-be-green` |
| Backend branch | `main` | `staging` |
| PM2 app | `nogatudrop-api` | `nogatudrop-api-green` |
| Port | 5007 | 5008 |
| Database | `nogatu_ncdms` | `nogatu_ncdms_staging` (own DB user, sees only this DB) |
| API host | api.nogatu.store | staging-api.nogatu.store |
| Website | nogatu.store (Vercel production, `main`) | staging.nogatu.store (Vercel, branch `staging`) |
| Email | on | allow-listed recipients, subjects prefixed "[TEST]" |
| Member check (MLM) | off until go-live | on: nogatualliance.com GREEN (port 5003) |
| JWT secrets | own | own (a live login never works on staging) |

The VPS also runs nogatualliance.com (MLM): BLUE `/var/www/nogatu` (port 5002, protected) and GREEN
`/var/www/nogatu-green` (port 5003, staging). Never touch BLUE or the live store without the owner's OK.
Shared-box traps (cron lock names carry the DB name, Redis DB index, scripts always need `--env-file`): lessons log.

SSH host and the VPS address: workspace `NOGATU_VPS_CONTEXT.md` (not in git).

## 2. Releasing to staging
1. Work on `feat/meeting-2026-11-10` in both repos; run the tests (section 4) and the browser checks.
2. Push the branch and fast-forward `staging` to it in both repos:
   `git push origin feat/meeting-2026-11-10 HEAD:staging` (check `git merge-base --is-ancestor origin/staging HEAD` first).
3. Website: Vercel builds staging.nogatu.store from `staging` on its own.
4. Backend: the owner runs a deploy block on the VPS (examples: workspace `outputs/sim-2026-11-15/STAGING_DEPLOY_*.md`).
   Every block runs in a subshell with `set -euo pipefail` and:
   - refuses unless `.env.prod` says `DB_NAME=nogatu_ncdms_staging`;
   - backs up the staging DB to `/root/db-exports/` (chmod 600);
   - `git fetch` + `merge --ff-only origin/staging`, asserts the expected short hash;
   - runs migrations with `node --env-file=.env.prod scripts/<x>.js --apply` (idempotent, dry run without `--apply`);
   - `pm2 restart nogatudrop-api-green`, then real checks with curl (health, one feature, 401s, live health 200);
   - compares the PM2 list before/after so no other app changed.
5. It is "on staging" only after that output comes back: process uptime newer than the commit, and checks passing.
6. Deploy the backend right after a website push when the website depends on new API fields.

## 3. Going live (only with the client's approval)
1. MLM BLUE gets the member verify endpoint (separate MLM runbook) and its bridge key.
2. Live DB backup, then pull `main` into `/var/www/nogatu-ncdms-be`, run every migration live has not had
   (`addShippingRates.js`, `addProductMemberPriceFlag.js`, earlier ones listed in the go-live doc) with `--apply`.
3. Set `MLM_API_URL` / `MLM_API_KEY` in the live `.env.prod` (copied on the box, never printed), restart `nogatudrop-api`.
4. Merge the feature branch to `main` in both repos; Vercel deploys nogatu.store.
5. Live test-data clean-up only with `scripts/clearTestStockists.js --live --ids=<list the client approved>`.
6. Every VPS block ends with the production DB snapshot routine (mysqldump to `/root/db-exports/`, then the owner
   copies it to the workspace `db_snapshots/` with scp; the folder is outside the repos).

## 4. New device setup
1. Tools: Node 20 LTS, Git, GitHub CLI (`gh auth login`), Docker Desktop, Python 3 (+ `pyzipper` for /migrate),
   SSH key for the VPS, Vercel access.
2. Clone both repos into one workspace folder (see `docs/HANDOFF.md` 0.2); restore the `/migrate` archive for
   env files, workspace docs, Claude memory and the sim folder.
3. `npm ci` in both repos.
4. Local copy of production ("the sim"): `outputs/sim-2026-11-15/docker-compose.yml` runs `mariadb:10.11` (strict
   sql_mode, `utf8mb4_unicode_ci`) on port 3316 and Redis on 6390. Load the latest snapshot from `db_snapshots/`
   into `nogatu_ncdms` (real customer data: only on a trusted device). The sim API uses `outputs/sim-2026-11-15/.env.sim`:
   `node --env-file=../outputs/sim-2026-11-15/.env.sim src/server.js` (port 5077); website:
   `VITE_API_BASE_URL=http://localhost:5077/api/v1 npx vite --mode dev --port 5183`.
5. Tests: backend `NCDMS_DB_TESTS=1 node --env-file=../outputs/sim-2026-11-15/.env.sim --test --test-concurrency=1 --test-force-exit`;
   frontend `node --test 'test/*.test.js'` and `npm run build`. Expected counts: `docs/HANDOFF.md` 0.3.

## 5. Open infrastructure items
- Old `GET /orders/public/payment-options` stays until the new website is live, then delete it.
- Dependency advisories: React Router 6 (fix needs v7), xlsx (no fix upstream), flowbite deepmerge (fix is a breaking downgrade).
- Live `main` still lacks everything since 2026-10-28 (shipping by weight, territories, member price, payment accounts).
