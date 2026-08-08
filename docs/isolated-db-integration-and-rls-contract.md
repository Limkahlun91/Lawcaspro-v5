# Isolated DB Integration Test Strategy (PART 3 §3)
# Also includes §16 RLS 2-layer contract + §17 Founder Support Access Audit

Last updated: 2026-08-08

---

## §3 Isolated DB Integration Strategy — NEVER destructive to Production

### Allowed Mechanisms Only
1. **Transaction Rollback (preferred)** — `BEGIN; run-tests; ROLLBACK;` at outer scope. Sub-transactions / savepoints allowed within. **No COMMIT ever.** Requires all tests be wrapped. Incompatible only with tests that must COMMIT (e.g. DDL inside test). For those, use #2 below.
2. **Isolated Test Schema** — `CREATE SCHEMA lawcaspro_test_<session> AUTHORIZATION current_user; SET search_path TO lawcaspro_test_<session>, public; DROP SCHEMA lawcaspro_test_<session> CASCADE;` at teardown. Tables fully re-materialized per run. No data leaks to prod schema. All RLS re-applied.
3. **Approved Existing Test Environment** — Use `TEST_DATABASE_URL` env var when supplied. NEVER point to Supabase prod project. CI has a dedicated ephemeral Supabase branch-previews cluster. Production DB = **never** used for integration tests.

### PROHIBITED
- Any destructive test that writes to Production data.
- Creating a NEW Production Supabase DB for testing.
- Running DDL against `app_public` (live application namespace) in a shared environment.

### §3 Required Coverage (Stabilisation Phase — run under mechanism 1 or 2 above)
| Surface | Test family | What must be asserted |
|---|---|---|
| 1 | Tenant Isolation — 2 firms | Firm-A actor: list/get/search/create/read ANY endpoint → 0 firm-B rows; firm-B actor → 0 firm-A rows. Applies to Cases, PV, Invoices, Receipts, Quotations, Ledgers, File Custody, HR Employee/Payroll/Leave. |
| 2 | RLS Enforcement (bypass test) | Act as unprivileged `app_user` PostgreSQL role WITHOUT setting `app.current_firm_id`. All SELECT/INSERT/UPDATE/DELETE → 0 rows or ERROR. |
| 3 | Cross-firm Oracle Prohibition | Firm-A calls `GET /cases/<firm-B-id>` → returns 404 (NOT 403 "exists elsewhere"). No cross-firm "entity exists" oracle. |
| 4 | Reference Uniqueness | `POST /cases` (finalize ref) twice concurrently with same `file_ref` → exactly 1 success, 1 gets 409. |
| 5 | Invoice Number Concurrency | `POST /invoices` with same firm_id + invoice_number → 1 success, 1 409. Firm-A and firm-B can share same numeric invoice_number → BOTH succeed but distinct invoice_numbers composite (firm,year,number). |
| 6 | Receipt Number Concurrency | Same as Invoice #5. |
| 7 | PV Notification Recipient Isolation | `POST /payment-vouchers/:id/notify` → recipients list ONLY firm users with appropriate role. No cross-firm user ever added to recipients list. |
| 8 | File Custody Concurrency | Double-release → only 1 valid row; double-receive → 1 success, 1 409 stale version; stale version (optimistic lock) → 409. |
| 9 | HR Balance/Payroll Isolation | Firm-A payroll run cannot read/overwrite Firm-B balance values; concurrent payroll lock for same employee → 1 success, 1 blocked 409. |

---

## §16 RLS 2-Layer Contract (Route WHERE + PostgreSQL Policy — BOTH MANDATORY)

### Layer 1 — Application Route `WHERE firm_id = current_firm_id` scoping
All route/service queries that read or write firm-scoped tables MUST include explicit `WHERE firm_id = req.firm_id` (or equivalent Drizzle/Knex `and(eq(firmId, req.firmId))`).

**WHY:** Defense-in-depth even in contexts where `SET LOCAL app.current_firm_id` has not been executed (cron, offline jobs, ad-hoc scripts, migration apply with elevated role bypassing RLS).

### Layer 2 — PostgreSQL `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + per-table policy
All firm-scoped tables MUST have:
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE  ROW LEVEL SECURITY;
CREATE POLICY <table>_firm_isolation ON <table>
  USING (firm_id = current_setting('app.current_firm_id', true)::bigint)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', true)::bigint);
```

**Zero exemptions.** Do not argue "route already filters" or "RLS is performance hit". Both layers required.

### Scope of this rule
Applies to ALL new tables in PART 1/2/3 Active Scope. Already enforced by Gate 6 in PART 3 §46 (21 tables 0 gaps).

### Founder / Support Access Contract (§17)
- **Founder is platform-only by default.** No implicit cross-firm read.
- **Support access = explicit session**: before founder queries any firm-scoped data outside their own firm scope, MUST:
  1. Record explicit `reason` (ticket, customer request, incident ID)
  2. Record explicit `target_firm_id`
  3. Open a time-bounded `support_sessions` row (max 24h; auto-expire column)
  4. During the session: `SET LOCAL app.current_firm_id = <target_firm_id>` — NEVER omit
  5. At session end / auto-expiry: close support_session row
  6. Audit write (see §17) for every action within the session
- **Ordinary Partner CANNOT cross-firm**. Policy rejects `app.current_firm_id` not owned.

### §17 Founder Support Audit Fields (mandatory)
Every founder/support action touching another firm's data writes to `audit_logs`:
| Field | Required value |
|---|---|
| who | `founder_user_id` (= `app.current_user_id`) — non-null |
| firm | `target_firm_id` — non-null |
| time | `now()` — non-null |
| resource/action | `entity_type + entity_id + action` — e.g. `case_bottleneck_snapshot:42:escalate_override` |
| session link | `support_session_id` FK — non-null |

---

## Implementation Toggles
- Rollback harness path: `scripts/with-tx-test-env.sh` + `with-tx-test-env.ps1` → to be created in Stabilisation phase.
- Isolated schema path: `scripts/with-schema-test-env.sh` → same.
- RLS coverage: re-verified by Gate 6 `scripts/security/validate-rls-coverage.ps1` (Gate 6).
