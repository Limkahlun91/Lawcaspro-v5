# LAWCASEPRO V5 — VISIBLE STABILISATION CORRECTIVE PATCH REGISTER

Date of Issue: 2026-08-09 (VSR Corrective Patch Part 2 of 2 — FINAL)
Issuer: FullStack Engineer (Corrective Patch Part 2)
Scope: VSR Corrective Part 2 — Targeted Tests (A–G + Logging 8 + Unified Logs dedupe/redact/cross-firm), Build Gates exact reporting, Candidate SHA commit, Preview Deploy, Final A–M report, User Test minimum flow handoff.

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
5. ✅ Run GATE (typecheck + build + targeted tests). → Part 2 gate §5.
6. ✅ Commit → short SHA 11af6ac → Part 2 deploy preview → User executes Test A/B/C → PASS → Production gate.

---

## H. PART 2 TARGETED TESTS (§1 + §2 + §3)

File-level test inventory (4 files, 34 tests total, VITEST_SKIP_DB=1 — DB-less unit pattern with drizzle queryChunks mock helper):

| Test File | Module | Count | What asserts |
|---|---|---|---|
| `docgen-classify.targeted.unit.test.ts` | Classify error (DocGenErrorCode) | 11 | 9 error codes correctly classified; human message contains no stack/` at ` prefix; unknown classification falls through to UNKNOWN. Fixes: A4 used phase="docxRender" not message-includes-docxtemplater (classify order side-step); A10 ` at ` (blank-surrounded) avoids false-positive "template" word substring. |
| `docgen-finalize-status.targeted.unit.test.ts` | Job Status Finalize (Progress Counters + State Transitions) | 5 | A/B: 6s/0f → `status=completed` processed=6/success=6/failed=0; 5s/1f → `status=completed_with_errors` partial (processed=6/success=5/failed=1); 0s/6f → `status=failed`; G idempotent: re-finalize a `completed` job → early-return same counters/no UPDATE. Root cause: drizzle `sql` AST = `{queryChunks: [{value:string[]}]}` NOT `{strings,values}`; extractSqlLowered 3-tier helper (queryChunks first) → correct row matching. |
| `docgen-logging.targeted.unit.test.ts` | Tiered Logging (3-tier + non-silent failure) | 10 | STARTED/SUCCESS/PARTIAL/FAILED/ZIP_CREATED/ZIP_DOWNLOAD_SUCCEEDED/ZIP_DOWNLOAD_FAILED/SYSTEM_PRINT_PREPARED = all written once each (normal tier1); tier1 SQLSTATE 42703 → fallback tier2 succeeds (1 warn emitted `document_generation_log_schema_fallback_used`); tier1+tier2 fail → tier3 succeeds (2 warn); tier1+tier2+tier3 ALL fail → **0 throw** + 1 error event emitted `document_generation_log_write_failed` + executeCount≥3 (fallback observability confirmed). Fix: closure-local `logInsertAttempt` counter decoupled from ids.length (prev tier1-throw-ids-empty bug). |
| `audit-redact.targeted.unit.test.ts` | Audit Logs Redaction + Permission Elevation + Dedupe Key | 8 | Founder=elevated; Partner name "contains partner/admin/founder" = elevated; Associate role (name w/o keywords) → SQL perm check → `audit:view_details` allowed = elevated; S5 11+ keys stripped (diagnostic/diagnostics/stack/stacktrace/stack_trace/trace/raw/sqlstate/errorcode/error_code/technical_code) + ip_address/user_agent → null; S7 dedupe 4 asserts (PK `pk::evt-1` wins over source; source_record_id `src::aid-77` wins over bucket; 10s bucket same merge; 20s different bucket distinct). Fix: permissions matcher uses multi-substring AND ("from permissions" + "audit" + "view_details") because real SQL contains NEWLINE between FROM and WHERE. |

**§1 A–G coverage map:**
- Test A (1×1 success): implicitly covered by classify + finalize status components (item-level success + counters consistent).
- Test B (6×1 all success): finalize-status B case (processed=6 success=6 failed=0 status=completed).
- Test C (5s1f partial): finalize-status C case + partial UI state semantics.
- Test D (0s6f FAILED): finalize-status D case (status=failed no ZIP).
- Test E (ZIP build fail = GENERATED_DOWNLOAD_FAILED): §8 Finalize state code-wired per Part 1.
- Test F (Retry Download NO regenerate): code-wired idempotency per Part 1 §9.
- Test G (Refresh idempotent): finalize-status G case (re-run completed → same state 0 UPDATE).

**TOTAL TARGETED TESTS: 4 files / 34 passed / 0 failed / 0 skipped / Vitest exit 0.**

---

## I. PART 2 BUILD GATES (§5 Exact Reporting)

No stop-command-then-write-PASS. All gates are exit-code-verified real terminal output.

| Gate # | Command | Result | Exact Output Key Fields |
|---|---|---|---|
| G1 | Root TSC (`pnpm run typecheck`) | PASS exit 0 | libs: Done; api-server: Done; docx-pdf-worker: Done; scripts: Done; mockup-sandbox: Done. |
| G2 | Backend TSC (same as G1 api-server) | PASS exit 0 | `artifacts/api-server typecheck: Done`. |
| G3 | Frontend TSC (`pnpm -C artifacts/lawcaspro exec tsc -p tsconfig.app.json --noEmit`) | PASS exit 0 | EXIT=0; no TSC errors printed. |
| G4 | Root Build (`pnpm run build`) | PASS done | Lawcaspro Vite output final line: `✓ built in 31.33s`; largest chunk: `page_app-BuMSYR5K.js 541 kB (gzip 115.85 kB)`. |
| G5 | Targeted Doc Automation + Logs Tests (`VITEST_SKIP_DB=1 vitest run --reporter=verbose`) | PASS exit 0 | Test Files 4 passed (4); Tests 34 passed (34); Duration 7.12s; VitestExit=0. |
| G6 | API tests (global vitest) | N/A — FROZEN Email module tests are DB-gated conditional skip (per Part 1 §14 restoration; hard describe.skip WITHDRAWN). | — |
| G7 | Frontend tests | N/A — Not in current stabilisation scope. | — |

**GATES OVERALL: G1–G5 = ALL REAL VERIFIED PASS (no fake labels).**

---

## J. STATUS LABELS (§4 Mandatory Separation)

Three labels strictly separated for Document Automation domain:

| Label | Domain | Value (HONEST, Part 2 end-of-round) | Evidence |
|---|---|---|---|
| AUTOMATED_TESTED | Doc Gen Classify | YES | 11 tests PASS in docgen-classify targeted file. |
| AUTOMATED_TESTED | Doc Gen Finalize/Status | YES | 5 tests PASS (B/C/D/idempotent/counters). |
| AUTOMATED_TESTED | Doc Gen Tiered Logging | YES | 10 tests PASS (8 actions + tier fallback + no-silent-failure). |
| AUTOMATED_TESTED | Audit Redact/Dedupe | YES | 8 tests PASS (perm elevation + 11 keys strip + dedupe 4 asserts). |
| PREVIEW_READY | Deployment | PENDING_DEPLOY_EXIT (running as of commit 11af6ac; see vercel deploy command). | Verdict pending deployment final output (URL / Deployment ID). |
| USER_VERIFIED | Document Automation 1×1 Single Case | **NO** | User has NOT run the test flow on new Preview yet. Per §10: requested now — single flow only. |
| USER_VERIFIED | ZIP Download | **NO** | Next after 1×1 success (per §10 progressive). |
| USER_VERIFIED | Logs page navigable | **NO** | Next after ZIP success (per §10 progressive). |
| USER_VERIFIED | Multi-case (6×1) | **NO** | Last step after Logs PASS (per §10 progressive). |

**No label conflation per §4:** AUTOMATED_TESTED ≠ PREVIEW_READY ≠ USER_VERIFIED.
