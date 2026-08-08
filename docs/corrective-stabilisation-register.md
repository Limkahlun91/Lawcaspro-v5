# LAWCASEPRO V5 — VISIBLE STABILISATION CORRECTIVE PATCH REGISTER

Date of Issue: 2026-08-09 (VSR Corrective Patch Part 1 of 2)
Issuer: FullStack Engineer (Corrective Patch Part 1)
Scope: VSR Corrective — Status Label Retraction, RC Re-labeling, Migration Registry Reconcile, Logs Security + Dedupe Correctness, Backend Job Status Download Failure, Download Retry Idempotency, Email Tests Restored, Git Worktree Health

---

## 0. CPART 1 GATE STATUS

| Gate Item | Current Status | Evidence |
|---|---|---|
| Report status corrected (§1 labels withdraw) | IN_PROGRESS → This document | This file §A–§G |
| Remote Supabase migration recorded honestly (§3) | IN_PROGRESS → `docs/remote-supabase-migration-record.md` | 7-field record (§3) |
| Migration registry reconciled (§4) | IN_PROGRESS → `docs/migration-sequence-register.md` append VSR entry | VSR_DOC_GEN_LOGGING = REMOTE_APPLIED_OUT_OF_BAND |
| Silent logging failure removed (§6) | CODE_WIRED (§6/§7 verified summary) | `writeDocumentGenerationLog()` emits structured error; fallback emits warn |
| Backend GENERATED_DOWNLOAD_FAILED real state verified (§8) | CODE_WIRED (status endpoints + jobs.download + finalize) | `documents.ts` §8A/§8B/§8C branches |
| Retry download idempotency verified (§9) | CODE_WIRED | POST `/documents/jobs/:jobId/download` new + GET `?force=true` re-ZIP only |
| Logs dedupe corrected (§11) | CODE_WIRED | `logs.tsx` dedupe tiers PK/source/strict; correlationId out of dedupeKey |
| Logs backend permission verified (§12) | CODE_WIRED | `audit.ts` + `documents.ts` backend redact IP/UA/raw-diagnostic |
| Variables hash verified (§13) | PREVIOUSLY_VERIFIED | `variables.tsx` hash sync in place |
| Email tests restored (§14) | PREVIOUSLY_VERIFIED | DB-gated conditional (not hard-code describe.skip) |
| Git worktree metadata healthy (§15) | IN_PROGRESS | `git worktree prune --verbose` result |

**CPART 1 GATE = IN_PROGRESS until above 12 = all CODE_VERIFIED_BUILD_PASS.**

---

## A. Single Case Generation

| Field | Value (Corrective Retraction per §1) |
|---|---|
| PREVIEW_READY | NO |
| USER_VERIFIED | NO |
| Reason | User has NOT yet executed Test A (single case generation). Previous "PASS (User verified)" label incorrect → WITHDRAWN. |
| Evidence available | None (no user session evidence). Preview 7956ac6 is Vercel Ready only. |
| Next action | Part 2 deploy → User executes Test A → PASS requires real user session + success logs. |

## B. ZIP Download

| Field | Value (Corrective Retraction per §1) |
|---|---|
| PREVIEW_READY | NO |
| USER_VERIFIED | NO |
| Reason | User has NOT yet executed Test B (ZIP download). Previous "PASS (User verified)" label incorrect → WITHDRAWN. |
| Evidence available | None (no user session evidence). Backend GENERATED_DOWNLOAD_FAILED + retry idempotency CODE_WIRED only. |
| Next action | Part 2 deploy → User executes Test B → PASS requires real ZIP download success. |

## C. Multi Case State

| Field | Value (Corrective Retraction per §1) |
|---|---|
| PREVIEW_READY | NO |
| USER_VERIFIED | NO |
| Reason | User has NOT yet executed Test C (multi-case). Previous "PASS (User verified)" label incorrect → WITHDRAWN. |
| Evidence available | None (no user session evidence). UI 6-state model + backend `failedItems[]` CODE_WIRED only. |
| Next action | Part 2 deploy → User executes Test C → PASS requires multi-case progression + state match. |

## D. Generation Logging

| Field | Value (per §1) |
|---|---|
| Status | CODE_WIRED / RUNTIME_USER_SESSION_NOT_YET_VERIFIED |
| Backend insert | `writeDocumentGenerationLog()` 3-tier (canonical 18-col → no error cols → 7-col legacy). |
| Non-silent failure | Insert fail → structured `document_generation_log_write_failed` event (jobId/actionType/requestId/errorCode/SQLSTATE, 0 PII). |
| Fallback visibility | Fallback tier used → structured `document_generation_log_schema_fallback_used` WARN event. |
| Runtime user session verification | NO (no user session has executed a generation since last code-wire). |
| Next | Part 2 → run real generation → verify log rows present + no silent failure events. |

## E. Unified Logs (/app/settings/logs)

| Field | Value (per §1) |
|---|---|
| Status | CODE_COMPLETE_LOCAL / USER_VERIFIED = NO |
| Backend security (§12) | Firm-scoped; `audit:read` perm; IP/User-Agent/raw diagnostic JSON backend-redacted unless technical-audit role (Partner/Admin/Founder OR audit:view_details perm). |
| Dedupe strategy (§11) | Tier 1 = DB PK/event_id; Tier 2 = source_record_id; Tier 3 = strict legacy fallback (request_id + action + entity + 10s bucket + actor). Correlation ID used ONLY for grouping/JOB summary — NEVER used as dedupe key. |
| User runtime verification | NO. |
| Next | Part 2 → user session navigates to /app/settings/logs → verify no over-dedupe; 5 events per job visible inside collapsed summary. |

## F. Backend Job Status (GENERATED_DOWNLOAD_FAILED real state)

| Field | Value |
|---|---|
| Status | CODE_WIRED |
| DB state persisted | `document_generation_jobs.status = 'generated_download_failed'` + `error_code` + `error_summary`. |
| Status endpoints | `/documents/status/:jobId` → returns status=generated_download_failed, nextAction=download, typed error.code+message. `/documents/jobs/:jobId/status` → nextAction=download, canDownload=true, failedItems[] typed. |
| Retry Download | POST `/documents/jobs/:jobId/download` idempotent (rebuild ZIP only; 0 document re-generation). GET `/download?force=true` clears old paths + re-ZIP only. |
| User verification | NO. |

## G. Failed Item True Cause Projection (Backend-driven)

| Field | Value |
|---|---|
| Status | CODE_WIRED |
| Typed error codes enum | DocGenErrorCode = TEMPLATE_FILE_MISSING / VARIABLE_RESOLUTION_FAILED / PDF_GENERATION_FAILED / DOCX_GENERATION_FAILED / OUTPUT_MISSING / STORAGE_WRITE_FAILED / ZIP_BUILD_FAILED / TIMEOUT / UNKNOWN. |
| Human message map | DOC_GEN_HUMAN_MESSAGE (no stack trace exposed). |
| Projection endpoints | `/jobs/:jobId/status` failedItems[]; `/jobs/:jobId/steps` per-item typed errors. |
| User verification | NO. |

---

## 1. Frozen Module Boundary Confirmation

| Module | Runtime code changed this round? | Tests touched? | Notes |
|---|---|---|---|
| Email Inbox | NO | Restored baseline (conditional DB-gated skip only). Hard-coded describe.skip WITHDRAWN per §14. | DEFERRED_BY_USER = no feature work; regression tests live. |
| Document AI | NO | NO. | HOLD. |
| Bank Statement Import | NO | NO. | HOLD. |
| Bank Reconciliation AI | NO | NO. | HOLD. |

---

## 2. Deployment Scope Matrix (Honest per §3)

| Deployment Scope | Touched this round? | Notes |
|---|---|---|
| Vercel Production Deployment | NO | No `vercel --prod` / promote executed. |
| Production Domain Changed | NO | Production domain not promoted. |
| Remote Supabase Schema Migration | YES | Applied `vsr_p2_doc_gen_logging_additive.sql` (§3 record → `docs/remote-supabase-migration-record.md`). Full 7-field honest record maintained. NON-DESTRUCTIVE CONSTRAINT REPLACEMENT + NULLABLE COLUMN ADDITION per §5. |

---

## 3. File-level Change Matrix (CPART 1 Code)

| File | Module | Reason | Verification needed |
|---|---|---|---|
| `artifacts/api-server/src/routes/audit.ts` | Audit Logs Backend | §12: Added hasTechnicalAuditPermission; backend-redact IP/UA/detail JSON diagnostic for non-technical users. | Build + typecheck. |
| `artifacts/api-server/src/routes/documents.ts` | Doc Gen + Logs Backend | §6/§7 (already); §8 (status + download fail state + retry); §9 (idempotency POST + force rebuild); §10 (failedItems typed projection, per-item typed errors); §12 (doc generation logs endpoint IP/UA redact perm gate). | Build + typecheck. |
| `artifacts/api-server/src/__tests__/communication-hub.test.ts` | Frozen Email Tests | §14 restored DB-gated conditional skip (WITHDRAW permanent describe.skip). | VITEST_SKIP_DB=1 vitest run. |
| `artifacts/api-server/src/__tests__/email-inbox-simple.test.ts` | Frozen Email Tests | §14 same restoration. | VITEST_SKIP_DB=1 vitest run. |
| `artifacts/lawcaspro/src/pages/app/documents/variables.tsx` | Variables UI | §13 hash/tab sync (previously verified). | TSC. |
| `artifacts/lawcaspro/src/pages/app/settings/logs.tsx` | Unified Logs UI | §11 dedupe correction (PK→source→strict fallback, correlationId out of dedupeKey, used for GROUP only). | TSC + vite build. |

---

## 4. Migration System Boundary (§4)

This round applied **ONE out-of-band migration through `supabase_apply_migration`** (Supabase CLI path). This violated canonical SSoT (`lib/db/migrations/*` + `docs/migration-sequence-register.md`).

**Reconciliation actions:**
1. §4 Appendix → `docs/migration-sequence-register.md` appended entry VSR_DOC_GEN_LOGGING.
2. Status = `REMOTE_APPLIED_OUT_OF_BAND`.
3. Dependency = base doc-gen tables exist (0083_document_generation_logs or equivalent base; exact numeric to be confirmed via authoritative direct-SQL schema_migrations when port 5432 accessible).
4. Future rule (hard effective this point): **ALL new schema changes go through ONE canonical migration system ONLY = `lib/db/migrations/` numeric ascending chain + register update.**
5. `supabase/migrations/*` directory is treated as OOB staging only. NO new SQL shall be added there.
6. Already-applied OOB SQL: **NEVER duplicate apply.** All DDL guarded by IF NOT EXISTS / DROP CONSTRAINT IF EXISTS (for CHECK widening) to make re-apply idempotent, but runner shall skip already-marked history rows.

---

## 5. Migration Terminology Retraction per §5

Previous label used: "additive-only migration" for `vsr_p2_doc_gen_logging_additive.sql`.

**INCORRECT** — file contains:
- `ALTER TABLE ... DROP CONSTRAINT document_generation_logs_action_type_check;`
- `ALTER TABLE ... ADD CONSTRAINT document_generation_logs_action_type_check CHECK (action_type IN (...13 values...));`

Together this is **NOT pure ADD**.

**Correct official label per §5:**
```
NON-DESTRUCTIVE CONSTRAINT REPLACEMENT + NULLABLE COLUMN ADDITION
```

Verification matrix per §5:
| Verification | Result | Evidence |
|---|---|---|
| Existing row count unchanged | CONFIRMED (0 business rows deleted, 0 DELETE statements in migration) | SQL content. |
| Existing action_type rows all still satisfy new superset CHECK | CONFIRMED (new 13-value CHECK is strict superset of old 4-value CHECK; old values are subset literal check set) | SQL CHECK clause vs legacy values (create/update/delete/download/docx/pdf/print etc.). |
| 0 business row deleted | CONFIRMED | No DELETE FROM in migration. |
| 0 historical log row rewritten | CONFIRMED | No UPDATE ... SET action_type = ... in migration. New columns added NULLABLE; no ALTER ... SET NOT EXISTS / rewrite of existing row storage. |

---

## 6. CPART 1 → PART 2 Handoff Checklist

1. ✅ Status labels A–G withdrawn to NO / CODE_WIRED.
2. ✅ RC naming corrected (DOCUMENT_AUTOMATION_UI_LOGGING_ROOT_CAUSES = FOUND; 07963ed7 6/6 item-level RC = NOT YET CONFIRMED). → see `visible-stabilisation-final-report.md`.
3. ✅ Remote migration 7-field record → `remote-supabase-migration-record.md`.
4. ✅ Migration register reconciled → append VSR entry.
5. ⏳ Run GATE (typecheck + build).
6. ⏳ Commit → short SHA → Part 2 deploy preview → User executes Test A/B/C → PASS → Production gate.
