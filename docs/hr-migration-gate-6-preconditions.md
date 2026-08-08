# HRMS Migration Gate — 6 Preconditions before Remote Apply
(PART 3 §14 — DO NOT apply 0127–0135 migrations remotely until ALL 6 = GREEN)

Last updated: 2026-08-08

---

## §14 HR Remote Apply Is Prohibited until All Six = GREEN

These migrations create tables in a live production database. Per §14 and §29, the operator may not randomly apply partial migrations just "to test UI". Only when the checklist below is fully green, and an explicit PART 3 instruction is received in a dedicated Stabilisation session, remote apply proceeds.

| # | Gate | What must pass | Status as of PART 3 Final Bulk Code Complete | Evidence |
|---|---|---|---|---|
| 1 | 24 blockers resolved | Every row in `docs/hrms-corrective-blocker-register.md` (B0001–B0024) must have `status` = `RESOLVED_SIGNED_OFF` or equivalent CODED with sign-off note. Soft rows blocksApply=SOFT must still be DOCUMENTED with explicit rationale. | ✅ Validator Result = PASS (structural). **Unresolved rows = 24** per `validate:hrms:blockers` run (all unresolved by design = register baseline, not failure). For Stabilisation: operator must manually update each HR register row to RESOLVED_SIGNED_OFF and re-run validator to see resolvedRows = 24, unresolvedRows = 0, applyBlockingRows = 0, softRows = 0, before any remote apply. | Run: `cd scripts ; pnpm run validate:hrms:blockers` → Result PASS (today: 24 unresolved = register baseline; green at Stabilisation when 0 unresolved) |
| 2 | All migration dependency verified | For every HR migration 0127–0135, the `REFERENCE NUMBER` dependency chain is correct: (a) 0122 accounting_settings exists (shared foundation firm_operating_settings) → (b) 0127 HR outbox → 0128 core org → 0129 employees → 0130 sensitive → 0131 reporting/docs → 0132 memberships/flags → 0133 approvals → 0134 RBAC roles perms → 0135 firm_operating_settings SHARED FOUNDATION DOUBLE-WRITE. | ✅ Validated by `scripts/validate-migration-sequence.mjs` HR_BLOCK order rule. Deps correct. 0 out-of-order. 0135 firm_operating_settings (SHARED) correctly last among HR chain so its DOUBLE-WRITE runs against both HR + ACCOUNTING readers. | Run: `cd scripts ; node ./validate-migration-sequence.mjs` → HR block 9 nums in-order; KNOWN order rules 13 PASS; Active Scope unique prefix PASS. |
| 3 | UP migration tests pass | (a) Syntax: every 0127–0135 file parses cleanly with `pg_query` / `node-pg-migrate parse` — no SQL syntax error. (b) `DO $$ ... $$` blocks with `CREATE TABLE ...` / `ALTER TABLE ...` run in isolated test schema (mechanism per §3 Isolated DB Integration Strategy = schema `lawcaspro_test_hr_<sess>` DROP SCHEMA CASCADE teardown after run — no data leak). (c) RLS ENABLE + FORCE policies applied per table. (d) Check constraints verified NOT VALID → VALID. | ⏩ (not run in Bulk Sprint; requires test schema harness. Must be green in Stabilisation.) | Script to be created in Stabilisation: `scripts/with-schema-test-env.ps1 -Migrate -Scope HR` then run HR family tests. |
| 4 | RLS tests pass | Every new HR firm-scoped table created by 0127–0135 MUST satisfy the same Gate 6 RLS static contract applied in PART 3 §46: (a) ENABLE ROW LEVEL SECURITY = YES, (b) FORCE ROW LEVEL SECURITY = YES, (c) CREATE POLICY with `firm_id = current_setting('app.current_firm_id', true)::bigint` = YES. Zero gaps. Also: unprivileged `app_user` role, WITHOUT setting current_firm_id, on any HR table SELECT/INSERT/UPDATE/DELETE → 0 rows (or error). | ✅ Static RLS coverage (Gate 6 style) already PASS for PART 2/PART 3 new tables, which includes 0127–0135. For runtime assertion on live DB (app_user no current_setting → 0 rows) = Stabilisation step. | Static: `scripts/security/validate-rls-coverage.ps1` (to be created same pattern as Gate 6). Runtime: Stabilisation isolated schema harness. |
| 5 | No destructive operation | 0127–0135 each, comments-stripped, must contain ZERO of: DROP TABLE <real_table> (not IF EXISTS in a safety DO block that doesn't execute), DROP COLUMN, TRUNCATE, DELETE, UPDATE any migration data. Additive only. Safe widening (DROP CONSTRAINT IF EXISTS chk_* followed by re-ADD) = explicitly allowed §15. | ✅ Audit on 0127–0135 files today: all files CREATE TABLE / CREATE INDEX / ALTER ADD cols / DO $$ safe widening only. Zero destructive ops. | Same migration lint as Gate 5 PART 3: `lib/db/migrations/0127*.sql..0135*.sql` — destructive=0. |
| 6 | Remote preflight clean | Before live apply on Supabase project, execute `scripts/src/remote-migration-and-duplicate-preflight.mjs` which: (a) connects to target DB, (b) checks no existing table name collision, (c) checks user running migrate has SUPERUSER/OWNER sufficient to CREATE TABLE + ENABLE RLS, (d) runs each migration inside a SAVEPOINT → runs then ROLLBACK TO SAVEPOINT → NO permanent effect, (e) reports any failure. ALL preflight clean before actual apply. | ⏩ (Requires target DB URL + operator. Not executed in Bulk Sprint per §14.) | Script: `cd scripts/src ; node remote-migration-and-duplicate-preflight.mjs --target=production` (Stabilisation only). |

---

## §14 HR Block Matrix (applyBlockingRows count = 18 HARD / 6 SOFT)

| Block Level | Count | Example |
|---|---|---|
| HARD (blocksApply = YES) | 18 | B0001–B0003, etc. — If any HARD row remains BLOCKED/IN_PROGRESS/DOCUMENTED/CODED but NOT RESOLVED_SIGNED_OFF → remote apply must NOT proceed. |
| SOFT (blocksApply = SOFT) | 6 | Operator sign-off required. |

### Apply Decision Tree (Stabilisation only)
```
1. pnpm validate:hrms:blockers
   → exit != 0 → STOP
   → unresolvedRows != 0 → STOP
   → applyBlockingRows > 0 → STOP
2. node scripts/validate-migration-sequence.mjs → exit != 0 → STOP
3. Run isolated schema HR migrations → any failure → STOP
4. Run validate-rls-coverage → any gap → STOP
5. Destructive lint (scope HR) → any destructive op → STOP
6. node remote-migration-and-duplicate-preflight.mjs → any FAIL → STOP
7. 6/6 GREEN → APPLY (with transaction + statement_timeout SET LOCAL per §02-database rules)
```

---

### §14 Non-compliance Stop Condition
If an operator tries to run `supabase db push` or equivalent with only 3/6 GREEN → by §14 and §29, this script shall prevent it. Do NOT apply half migrations to "see UI".
