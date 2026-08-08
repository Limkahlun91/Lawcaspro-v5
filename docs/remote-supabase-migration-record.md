# LAWCASEPRO V5 — REMOTE SUPABASE MIGRATION RECORD (VSR Corrective §3)

Issued: 2026-08-09 (VSR Corrective Patch Part 1 of 2)
Migration Channel: `supabase_apply_migration` tool (out-of-band; see §4 reconciliation).
Applicability: VSR Document Automation stabilisation only.

---

## 0. Deployment Scope 3-Column (Authoritative per §3)

| Deployment Scope | Touched? | Details |
|---|---|---|
| Vercel Production Deployment | NO | No `--prod` / promote executed. Production Vercel deploy traffic untouched. |
| Production Domain Changed | NO | Production domain NOT promoted / re-pointed. |
| Remote Supabase Schema Migration | YES | This file records exactly what. |

---

## 1. Migration Identifier

| Field | Value |
|---|---|
| Migration logical name | `VSR_DOC_GEN_LOGGING` (see migration-sequence-register.md append) |
| File on local disk | `supabase/migrations/vsr_p2_doc_gen_logging_additive.sql` |
| Remote apply time | ~2026-08-09 UTC+8 (approx 10:30 MYT) during VSR stabilisation prior round; migrated through Supabase `supabase_apply_migration` tool. Exact UTC timestamp = Supabase project console migration history row if reachable via direct SQL in future. |
| Target project | Supabase project ref: `bepixycuulklorcbadww` (host: bepixycuulklorcbadww.supabase.co) |
| Apply tool | `supabase_apply_migration` integrated tool (runs through Supabase proxy API). |
| Authoritative migration history row version / name | UNABLE TO VERIFY via direct-SQL (pg.Pool 5432 blocked for this runner; pooler returned tenant-not-found format mismatch; TCP 5432 timed out on direct host). Pending bastion / DB-access operator execution via Supabase SQL Editor: `SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY installed_at DESC LIMIT 5;` |
| Official status (register) | `REMOTE_APPLIED_OUT_OF_BAND` (per §4 reconciliation) |

---

## 2. Schema Objects Changed (Full Inventory)

| # | Schema Object | Type of Change | DDL Operation Summary |
|---|---|---|---|
| 1 | `document_generation_logs.job_id` | NEW NULLABLE COLUMN | `ALTER TABLE document_generation_logs ADD COLUMN IF NOT EXISTS job_id text NULL;` |
| 2 | `document_generation_logs.error_code` | NEW NULLABLE COLUMN | `ALTER TABLE document_generation_logs ADD COLUMN IF NOT EXISTS error_code text NULL;` |
| 3 | `document_generation_logs.error_message` | NEW NULLABLE COLUMN | `ALTER TABLE document_generation_logs ADD COLUMN IF NOT EXISTS error_message text NULL;` |
| 4 | `document_generation_logs.request_id` | NEW NULLABLE COLUMN | `ALTER TABLE document_generation_logs ADD COLUMN IF NOT EXISTS request_id text NULL;` |
| 5 | `document_generation_logs_action_type_check` | **NON-DESTRUCTIVE CONSTRAINT REPLACEMENT** (§5 label) | `ALTER TABLE DROP CONSTRAINT IF EXISTS document_generation_logs_action_type_check;` then `ALTER TABLE ADD CONSTRAINT document_generation_logs_action_type_check CHECK (action_type IN ('create','update','delete','download','print','DOCUMENT_GENERATION_STARTED','DOCUMENT_GENERATION_SUCCEEDED','DOCUMENT_GENERATION_FAILED','DOCUMENT_GENERATION_PARTIAL','DOCUMENT_ZIP_CREATED','DOCUMENT_ZIP_DOWNLOAD_SUCCEEDED','DOCUMENT_ZIP_DOWNLOAD_FAILED','DOCUMENT_SYSTEM_PRINT_PREPARED','DOCUMENT_SYSTEM_PRINT_FAILED'))` (13 values — SUPerset of legacy 4+ print+download values). |
| 6 | Indexes on `document_generation_logs.job_id`, `request_id` | NEW INDEX (IF NOT EXISTS) | `CREATE INDEX IF NOT EXISTS idx_document_generation_logs_job_id ON document_generation_logs(job_id);` + `CREATE INDEX IF NOT EXISTS idx_document_generation_logs_request_id ON document_generation_logs(request_id);` |
| 7 | `document_generation_log_cases` junction table | NEW TABLE (IF NOT EXISTS) | `CREATE TABLE IF NOT EXISTS document_generation_log_cases (log_id bigint NOT NULL, case_id bigint NOT NULL, firm_id bigint NOT NULL, PRIMARY KEY (log_id, case_id));` + FKs to logs/cases/firms + RLS enable/policy. |
| 8 | `audit_logs.request_id` | NEW NULLABLE COLUMN | `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id text NULL;` |
| 9 | `audit_logs.event_id` | NEW NULLABLE COLUMN | `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS event_id text NULL;` |
| 10 | `audit_logs.correlation_id` | NEW NULLABLE COLUMN | `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS correlation_id text NULL;` |
| 11 | `audit_logs.ip_address` | NEW NULLABLE COLUMN | `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address inet NULL;` |
| 12 | `audit_logs.user_agent` | NEW NULLABLE COLUMN | `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent text NULL;` |
| 13 | `audit_logs.action` CHECK constraint (if widening needed) | **NON-DESTRUCTIVE CONSTRAINT REPLACEMENT** (same pattern) | `ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;` then widened superset CHECK containing doc-generation + auth lifecycle + HR/accounting/cases action values enumerated (100% backward compatible; old values literal subset). |
| 14 | Indexes on audit_logs (event_id, correlation_id, request_id) | NEW INDEX (IF NOT EXISTS) | `CREATE INDEX IF NOT EXISTS idx_audit_logs_event_id ON audit_logs(event_id);` + `CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON audit_logs(correlation_id);` + `CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id ON audit_logs(request_id);` |

---

## 3. Quantified Safety Metrics (§5 Mandatory Verification Fields)

| Metric | Value | How confirmed |
|---|---|---|
| Row deletion count (DROP/DELETE business rows) | 0 | No DELETE FROM statements anywhere in migration SQL. No TRUNCATE. No destructive DML. |
| Data rewrite count (UPDATE / SET NOT NULL / ALTER TYPE with rewrite) | 0 | All added columns are NULLABLE (no SET NOT NULL / no DEFAULT ... backfill executed). CHECK added without NOT VALID flag but since new CHECK is strict superset of old action_type values, no heap verification rewrite was required for existing rows (old values satisfy new set). 0 UPDATEs to any historical log row action_type / detail / any column. |
| Existing business row count unchanged? | CONFIRMED 0 delta | 0 deleted; 0 inserted by migration; 0 rewritten so count identical pre-post. |
| Existing action_type rows all still satisfy new superset CHECK? | CONFIRMED yes | New 13+ value CHECK contains all legacy action_type values as literal subset. No historical row can possibly violate widened constraint. |
| Historical log row content rewritten (e.g., detail JSON, action_type, entity fields)? | 0 | No UPDATE statements in migration. Historical content remains byte-identical to pre-migration state. |

---

## 4. Terminology Classification per §5 (Mandatory Official Label)

| Term proposed previously | Correct / Rejected? | Official Authoritative Label |
|---|---|---|
| "additive-only migration" | **REJECTED per §5** | **NON-DESTRUCTIVE CONSTRAINT REPLACEMENT + NULLABLE COLUMN ADDITION** |

Rationale for rejection:
- Migration contains explicit `DROP CONSTRAINT` + `ADD CONSTRAINT` for CHECK enum widening. This is not "pure ADD".
- However, it is NON-DESTRUCTIVE by the above quantified safety metrics.

---

## 5. Dependency + Reconciliation Notes (§4 Cross-ref)

- See register: `docs/migration-sequence-register.md` → entry `VSR_DOC_GEN_LOGGING`.
- Depends on: base `document_generation_logs` and `audit_logs` tables present (canonical numeric migration established these base tables pre-round).
- Duplicate apply prohibition: **NEVER run this SQL twice against the same remote database.** Although IF NOT EXISTS / DROP CONSTRAINT IF EXISTS guards make idempotent re-apply technically safe at DDL level, runner MUST treat remote-applied history rows as authoritative and skip for future canonical runs.
- Migration system ONE-chain rule effective this round:
  - All NEW schema changes go through the canonical chain ONLY (`lib/db/migrations/*` numeric ascending + register update).
  - `supabase/migrations/*` path FROZEN effective this record. No new SQL added there.
  - Any OOB emergency requires explicit reconciliation entry immediately, same as this file.

---

## 6. Known Risks / Gaps

| Item | Status |
|---|---|
| Exact installed_at timestamp in `supabase_migrations.schema_migrations` | UNABLE TO VERIFY via direct-SQL from this runner. |
| Exact version/name string as recorded by Supabase migration runner | UNABLE TO VERIFY. Pending DB-access operator (Supabase SQL Editor or bastion with 5432 egress). |
| Remote production DB backup taken BEFORE OOB apply? | RECORD UNAVAILABLE. No evidence was produced in this run. Standard Supabase PITR covers point-in-time restore. |

---

## 7. CPART 2 Migration Guard

Before ANY further schema change applies to this same Supabase project:
1. Run authoritative direct-SQL query of `supabase_migrations.schema_migrations` history rows for last 5 entries.
2. Confirm VSR_DOC_GEN_LOGGING equivalent row exists (version filename, installed_at).
3. Append next migration through canonical chain (`lib/db/migrations/0147_...sql` or next numeric after current max in lib/db/migrations — check actual next numeric via `LS lib/db/migrations` at the time).
4. Update register simultaneously per §4 ONE-chain rule.
5. Never duplicate apply.
