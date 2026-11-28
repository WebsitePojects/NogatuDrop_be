# Handoff: Nogatu NCDMS (nogatu.store store + distribution system)

Last updated: 2026-11-28, on the desktop. Nov 24 + Nov 26 client answers are on branch `staging` (both repos); the
staging SERVER still runs the Nov 24 build (checked 2026-11-28), so its Nov 26 deploy block is the first thing to do.
Deploy/setup details: `docs/DEPLOY.md`.
Read this file first in any new session, on any device. Refresh it with `/handoff update`.

This file is committed. It never holds secrets, tokens, passwords, personal data of customers or residents,
email addresses or personal names. Use roles ("the client's management contact") instead of names.

---

## 0. New device setup

### 0.1 Tools
- Node.js 20 LTS (the VPS runs 20; this desktop has 24, which only differs in one test, see lesson 6). REQUIRED.
- Git + GitHub CLI (`gh auth login`), account with access to the `WebsitePojects` org. REQUIRED.
- Docker Desktop (local MariaDB 10.11 + Redis copy of production, "the sim"). REQUIRED for DB tests.
- Python 3 (scripted edits, handoff/migrate helpers). Playwright (browser checks) comes from the playwright skill.
- SSH key for the VPS (root). Vercel access for the frontend projects (production + `staging` branch).

### 0.2 Get the code
Workspace folder (not a repo) holds both repos side by side plus the project docs:
```
<workspace>/NogatuDrop_be   git clone https://github.com/WebsitePojects/NogatuDrop_be.git
<workspace>/NogatuDrop_fe   git clone https://github.com/WebsitePojects/NogatuDrop_fe.git
```
Then `git switch feat/meeting-2026-11-10` in both. Do not use `outputs/management-2026-09-10/ds-*` worktrees or
scratchpad worktrees: they belong to older sessions/agents (lesson 3).

### 0.3 Prove it works
```
cd <workspace>/outputs/sim-2026-11-15 && docker compose up -d          # MariaDB on 3316, Redis on 6390
cd <workspace>/NogatuDrop_be
NCDMS_DB_TESTS=1 node --env-file=../outputs/sim-2026-11-15/.env.sim --test --test-concurrency=1 --test-force-exit
cd <workspace>/NogatuDrop_fe && node --test 'test/*.test.js' && npm run build
```
Expected (2026-11-26): backend `tests 391, pass 389, fail 1, skipped 1` (the 1 = addressInput, Windows-only, lesson 6);
frontend `pass 71, fail 0`; build `built in ~12s`.

### 0.4 Not in git (bring separately; `/migrate` packs these)
| Item | Where on the source device | Why not in git / how it travels |
|---|---|---|
| `CLAUDE.md`, `.claude/rules/*` (lessons, idempotency, engineering standards) | workspace root | workspace is not a repo; migrate archive |
| Project docs (`NOGATU_*.md`, PRD, plans, runbooks) | workspace root | same |
| Backend `.env.dev` / `.env.prod`, frontend `.env.*` | each repo root | secrets, gitignored |
| Sim env `.env.sim`, `docker-compose.yml`, QA/browser scripts, deploy blocks | `outputs/sim-2026-11-15/` | local test stack; migrate archive |
| Production DB snapshots | `db_snapshots/` | real customer data: never in git, carried only if the owner says so |
| Claude project memory | `~/.claude/projects/<workspace slug>/memory` | device-local; migrate archive |

---

## 1. What we are working on
nogatu.store: the public store plus the distribution system (NCDMS) behind it, for a direct-selling company.
Super Admin and the two company **hubs** (Caloocan, Tycoon) run it; Provincial/City **Stockists** fulfil store
orders in their own territory; buyers pay by bank transfer/e-wallet and upload a receipt. Sister system:
nogatualliance.com (MLM, separate repo/session) verifies members for the 30% member price.

| Repo | What | Runs on |
|---|---|---|
| NogatuDrop_be | Node 20 + Express + mysql2 (MariaDB 10.11) + Redis | VPS, PM2: `nogatudrop-api` (live), `nogatudrop-api-green` (staging) |
| NogatuDrop_fe | React 18 + Vite + Tailwind + flowbite-react 0.12 | Vercel: production = `main`, staging.nogatu.store = `staging` |

Code map: `src/controllers` (orders, partners = Stockists, bankAccounts, shipping, warehouses), `src/services`
(shippingService, publicFulfillmentRoute, bankAccountResolver, memberDiscount, stockistRemoval, buyerEmails),
`scripts/` (idempotent dry-run/`--apply` migrations), `test/*.integration.test.js` (real DB + HTTP, need the sim).
Full project spec and the 30 implementation gotchas: workspace `CLAUDE.md`.

## 2. Decisions made (do not re-litigate)
- UI always says "Stockist", never partner/admin. Caloocan and Tycoon are "Hubs"; they restock from the manufacturer.
- Shipping fee = weight x tier counted from the shipping warehouse (local / same island group / 1 or 2 groups / Island / Palawan); NCR from the hubs = proposal table (local 185). Palawan counts as Island. Delivery dates show "if paid today" and are recounted on payment.
- Territory is hands off: a buyer in a Stockist's area is served and paid by that Stockist only; that Stockist verifies the payment.
- Checkout payment options = only the shipping Stockist's (or hub's) own accounts; company accounts only if it has none (2026-11-26).
- Stockists add/manage their own payment accounts; Super Admin can do it on their behalf; Super Admin is notified of each change.
- Member price: 30% off products only, needs real nogatualliance.com username + password, active members only (suspended/frozen excluded), packages excluded (untick per product), shipping never discounted, approver can "Remove member price" on a pending unpaid order.
- Super Admin can delete a Stockist or warehouse only when nothing live depends on it (open orders, stock, transfers, City Stockists). Hubs never.
- Test data: staging cleared (done 2026-11-24); live clean-up only from a list the client approves, together with go-live.
- Rate limits sized for a normal workday (per user for staff, per IP for anonymous, per link for rider pings).
- Every password field has a show/hide eye. No subagents in this project's sessions; caveman + graphify for token efficiency.

## 3. Lessons that matter
Full log: workspace `.claude/rules/lessons.md` (newest on top).
1. "On staging" only when the running process started after the commit AND a real check passed; pushing is not deploying.
2. Production is MariaDB 10.11, not MySQL 8. New tables state `COLLATE=utf8mb4_unicode_ci`; test schema on the sim.
3. Before any git change run `git worktree list`, `git status`, `git branch --show-current` in both repos: other agents leave worktrees.
4. Python edits on Windows must keep line endings (`newline=''`); check `git diff --stat` and `git ls-files --eol`.
5. Anything a buyer chooses that depends on who fulfils the order must come from the same routing as the order (shipping quote), and the server refuses anything else.
6. addressInput test: all 17 pass; only Node 24 + `--test-force-exit` on Windows crashes at exit. Passes on node:20 Linux (Docker) = the VPS.
7. A UI section fed by a filtered list must be checked against what the API actually returns (the Hubs card was dead for months).

## 4. Rules
- Non-negotiables (workspace `.claude/rules/idempotency-concurrency.md`): no double-submit, every mutating endpoint duplicate-safe with a double-fire test (in a row + at once), fail closed, server recomputes money, no secrets/PII in code, logs or responses.
- DB scripts: idempotent, dry run by default, `--apply` to change, always `--env-file`.
- Never touch live (nogatu.store prod, MLM BLUE) without the owner's explicit OK. Staging deploys are blocks the owner runs on the VPS; they back up the DB first and check other PM2 apps are unchanged.
- Branch `feat/meeting-2026-11-10` in both repos; `staging` is fast-forwarded to it. `main` = live, merged only at go-live.
- Messages to the client: casual paragraphs, "sir", no bullets/numbered lists, no em/en dashes, brief.

## 5. Status (2026-11-28)
**Branches:** `feat/meeting-2026-11-10` (both repos, pushed) == `origin/staging`. Not merged to `main`.
`release/live-2026-10-28`, `finalization`: old, merged into live. Not merged and dormant (do not merge blindly):
backend `feature/signin-security` (2026-10-02, also `origin/parked/signin-security`), `feature/signin-security-v2`
(2026-10-10, WIP sign-in security + reset hardening), `hotfix/store-no-vat` (2026-10-14); frontend
`feature/signin-security`, `feature/signin-security-v2`. Old Codex worktrees under workspace
`outputs/management-2026-09-10/` (one, `quarantine-store-copy`, has 190 uncommitted files): not ours, leave them.
**Recent commits:**
- be `bb9f1bd` docs/DEPLOY.md; `0ca43dd` this handoff
- be `9667980` Nov 26: checkout pays shipping Stockist only, Remove member price, safe Delete Stockist/warehouse
- be `02cb72e` Nov 24: member price skips packages, Stockist payment accounts, staging clean-up
- be `33fb328` store shipping/payments/member sign-in/rate limits; live `main` = `1fa9688`
- fe (NogatuDrop_fe repo) `8fa88ac` Nov 26 (same features); `8cc0bc0` Nov 24; live `main` = `bf7ddb4`
**Verified (real output):** staging API ran `02cb72e` (restarted 2026-11-24, member column = 1, 401 checks, prod health 200); staging Stockists cleared (4) and a re-run found nothing; staging website bundle contains the Nov 24 pages. Sim: backend 389/391 (the 1 = lesson 6), frontend 71/71, build OK; browser checks: payment options 5/5 (Davao buyer sees GCASH only), new buttons 4/4, store e2e 21/21, Nov 24 screens 7/7.
**Staging server is behind (checked 2026-11-28):** `/api/health` uptime 334,190 s (restarted 2026-11-24, the `02cb72e` deploy) and the shipping quote has no `payment_providers`, so the `9667980` block (workspace `outputs/sim-2026-11-15/STAGING_DEPLOY_2026-11-26.md`) has NOT run. Meanwhile the staging website (already `8fa88ac`) shows "Payment accounts are not available" at checkout. Rejecting the staging test order PUB-20261123080452192000 is step 5 of that block.
**Migrate archive:** plan built 2026-11-26 (workspace `.claude/migrate.json`, 380 files, 43.9 MB, real data left out); the owner has not packed it yet (no archive found 2026-11-28).
**Waiting on others:** the client adds a test Stockist on staging and tries the flow; client approval to go live; the MLM session's progress on the client's 8-item list + auto-upgrade proposal (unknown).

## 6. What's next
1. Run the Nov 26 staging block (owner, on the VPS) NOW and read its output: HEAD `9667980`, quote shows `payment_providers`, both 401s, reject result. Check first: `curl -s https://staging-api.nogatu.store/api/health` uptime must drop.
2. Re-check staging in the browser: a Stockist-area address shows only that Stockist's options; Delete Stockist and Remove member price work.
3. Send the client the short update (payment options fixed, Remove member price, Delete Stockist, staging test order removed).
4. When the client adds packages, untick "Nogatu Alliance member price applies" on each (none exist yet).
5. Go-live (only after the client's OK): MLM BLUE gets the member verify endpoint; prod DB backup; pull + `scripts/addShippingRates.js`, `scripts/addProductMemberPriceFlag.js` (and any earlier ones live lacks) with `--apply`; set MLM_API_URL/KEY; restart; merge to `main` for Vercel; live test-data clean-up only with `--live --ids=<approved list>`.
6. If moving devices: owner runs the `/migrate` pack + verify commands (password typed in their own terminal), then the plan file in the session scratchpad is deleted.
7. Later: remove the old `GET /orders/public/payment-options` once the new website is live; dependency advisories (React Router 7 upgrade, xlsx, flowbite deepmerge).

## 7. Handoff rules for this project
- Verify on resume: `cd NogatuDrop_fe && node --test 'test/*.test.js'` (fast); DB suite as in 0.3 when Docker is up.
- Extra scan before committing this file: `grep -niE "sir [A-Z]|@gmail|@nogatu|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}" docs/HANDOFF.md | grep -v "Extra scan" | wc -l` must print 0.
- Other repos to update together: `../NogatuDrop_fe` (same branch names); workspace `CLAUDE.md` and `.claude/rules/lessons.md` (not in git).
- After pushing: none (deploys are separate owner-run blocks).
- Push policy: push `feat/meeting-2026-11-10` and fast-forward `staging` when the owner says deploy; `main` only at go-live with approval.
