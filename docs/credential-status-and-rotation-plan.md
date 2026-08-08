# Credential Status + Rotation Plan (PART 3 §18 + §19)
Last updated: 2026-08-08

---

## §18 Honesty Statement — Credential Exposure Status

### MANDATORY HEADING (not debatable)
```
STATUS = CREDENTIAL_ROTATION_REQUIRED_BEFORE_PRODUCTION
```

**Never** write "No secret exposure ever". The correct honest assertion:

> **No NEW plaintext credential exposure introduced during PART 1 → PART 2 → PART 3 Bulk Sprint code changes. Historical credential exposure (incident: service-role key previously appeared in command context prior to V2 J/K/L) = NOT YET ROTATED. This rotation is scheduled per §19 below and MUST complete before any Production deploy.**

### Scope of Scan performed (2026-08-08)
| Surface | Scan tool | Result |
|---|---|---|
| git tracked files | `git ls-files | xargs grep -lEi "service_role|SUPABASE_SERVICE_ROLE_KEY|sk-|eyJ|Bearer [a-zA-Z0-9_-]{40,}"` | 0 matches in tracked source. (1 match = `.env.example` template, masked value placeholders `XXXXXX`, NOT real). |
| git untracked files | `git ls-files --others --exclude-standard | xargs grep -Ei "service_role|SUPABASE_SERVICE_ROLE_KEY"` | 0 real matches. `.env.local` present — values PRESENT/MASKED only logged below. |
| git staged / index | `git diff --cached` (HEAD → stage) | 0 credentials in staged changes during PART 3 Bulk Sprint. |
| git history last 30 days | `git log -p -S "service_role" --oneline` | Only detected in historical commits prior to V2 J/K/L credential remediation episode. Not reintroduced. |
| logs dir (`artifacts/**/.next`, `logs/`, `tmp/`) | Find `.log`/`.out` files + scan for patterns | 0 real credential values. INFO lines only. (Vite sourcemap / esbuild filesize notices.) |
| temp files ($env:TEMP / tmp/) | Files `api-vitest-summary.json`, verbose logs. | 0 credentials. |
| docs folder `docs/**` | Markdown scan for `sk-` / `eyJ` / Supabase key patterns | 0 real credential values. All status doc PRESENT/MASKED. |
| .env files (`/.env`, `/artifacts/api-server/.env`, `/artifacts/lawcaspro/.env`, `/lib/**/.env*`) | Scan + gitignore verify | See next table. |

### .env files + .gitignore Verify
| File path | Exists? | In `.gitignore`? | Values in this report |
|---|---|---|---|
| `/.env` | YES | YES (line `/.env*`, `!.env.example`) | PRESENT/MASKED only |
| `/.env.local` | YES | YES | PRESENT/MASKED only |
| `/.env.example` | YES | NO (intentionally tracked as template) | Placeholders only. No real value present. |
| `/artifacts/api-server/.env` | YES | YES (`artifacts/api-server/.env`) | PRESENT/MASKED only |
| `/artifacts/lawcaspro/.env` | YES | YES (`artifacts/lawcaspro/.env`) | PRESENT/MASKED only. Supabase anon key (PUBLIC, allowed per standard) is present but not sensitive. |

**Rule going forward (§18 explicit):** Any automated output (logs, reports, CI artifacts, terminal paste, JSON summaries) that mentions a credential present → ONLY output `PRESENT` or `MASKED`. **Never** print actual value even if "partial". Example:
- ❌ Wrong: `SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...32chars`
- ✅ Correct: `SUPABASE_SERVICE_ROLE_KEY: PRESENT` / `SERVICE_ROLE_KEY_STATUS: MASKED`

### Credential Inventory (masked, no values printed)
| Credential Key | Where used | Rotation required? | Plan row |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `artifacts/api-server` auth-admin-db; roles/permission bootstrap | YES (historical incident) | §19 Step 4a |
| `SUPABASE_ANON_KEY` | lawcaspro env, dashboard env, api-server | No (by-design PUBLIC key per Supabase) | N/A |
| `SUPABASE_URL` | All projects | No (non-sensitive) | N/A |
| `SUPABASE_DB_URL_DIRECT` / `DATABASE_URL_DIRECT` | `scripts/security/*.mjs`, remote-migration preflight scripts | YES | §19 Step 4b |
| `CRON_JOB_SHARED_SECRET` | `routes/cron-jobs.ts` → `/api/cron/*` auth guard | YES — rotate if ever exposed in prior context or not unique per env | §19 Step 4c |
| `EINVOICE_LHDN_CLIENT_ID / CLIENT_SECRET` (future) | `routes/einvoices.ts` when live submit | YES — generate new pair upon go-live | §19 Step 4d — deferred until go-live |

---

## §19 Rotation Plan (ORDERED, NON-DISRUPTIVE, NOT YET EXECUTED)

⚠️ **DO NOT EXECUTE DURING BULK SPRINT.** Executed later as a dedicated Stabilisation card with explicit user approval. Order below is critical (inventory → replacement → env update → rotate → redeploy → verify → only then invalidate old):

### §19 Step 1 — Inventory & Validate Exposure Scope (30 min)
- Confirm all §18 Inventory YES rows. Write each credential's location in code, env file, CI secret store, Vercel project, Supabase dashboard.
- Confirm there is ZERO hardcoded value in code (PART 3 scan: ZERO already confirmed).
- Confirm `.env*` files are gitignored. If not, `git rm --cached` now + update `.gitignore`.

### §19 Step 2 — Prepare Replacement Key Set (1h)
In Supabase Dashboard → Project Settings → API → Service role key → **Generate new service_role key**. Do NOT delete old one yet.
- Also rotate Postgres roles passwords for any direct-connect URL.
- Create 2nd copy of the new CRON_JOB_SHARED_SECRET (>=32 chars, CSPRNG) and keep offline.

### §19 Step 3 — Update Existing Env Stores WITHOUT Invalidating Old (30 min)
Push new values to:
1. GitHub Actions repo secrets (new `SUPABASE_SERVICE_ROLE_KEY_V2`, `DATABASE_URL_DIRECT_V2`, `CRON_JOB_SHARED_SECRET_V2`).
2. Vercel Environment Variables for Preview / Production environments (BOTH). Add new env vars with `_V2` suffix; keep old ones temporarily (dual-write window).

### §19 Step 4 — Rotate + Invalidate Old (1h maintenance window-like discipline)
4a. Supabase → revoke old service_role key. 4b. Postgres `ALTER ROLE postgres PASSWORD 'new'` inside a transaction. 4c. CRON_JOB_SHARED_SECRET: update env + redeploy (both env vars accepted for 10 min window). 4d. E-Invoice LHDN: deferred until go-live.

### §19 Step 5 — Redeploy Preview (30 min + smoke)
Trigger ONE Consolidated Stabilisation Preview deploy (per §25). After deploy, smoke check all:
- ✅ Auth login works
- ✅ DB write works (create-test-user script)
- ✅ Storage bucket accessible
- ✅ Cron route `/api/cron/bottlenecks` → accepts correct secret, 401 on wrong secret
- ✅ All API endpoints return 200 for authorized user

### §19 Step 6 — Verify before continue
If ANY of Step 5 fails → Rollback: re-enable old key + redeploy with old env. Do NOT proceed.
If ALL green → final step: remove `_OLD` env vars, confirm git grep for credential patterns = 0.

---

### Final §18/§19 Assertion
```
STATUS: CREDENTIAL_ROTATION_REQUIRED_BEFORE_PRODUCTION
NEW EXPOSURES IN PART 1/2/3 BULK CODE CHANGES:  0
ROTATION EXECUTED:                                NO (scheduled Stabilisation Phase)
NEXT ACTION:                                      User-initiated Stabilisation §19 step-by-step run.
```
