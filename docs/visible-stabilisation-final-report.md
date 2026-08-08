# LAWCASEPRO V5 — VISIBLE STABILISATION FINAL REPORT (Corrective Re-labeled)

Date: 2026-08-09 (VSR Corrective Patch Part 1 of 2)
Author: FullStack Engineer (Corrective Patch Part 1)

---

## Executive Summary

Visible Stabilisation Release Preview 7956ac6 is **Vercel Ready, but Document Automation domain ≠ PASS**.

Previous round incorrectly marked Document Automation items as PASS / USER_VERIFIED without any Test A/B/C user session evidence. **These labels are WITHDRAWN per corrective §1.**

This round (Corrective Patch Part 1):
1. Fixed 4 FOUND root causes (§2): logging pipeline broken / status semantics broken / failure details UI hidden / Vercel build config broken.
2. Added backend GENERATED_DOWNLOAD_FAILED real persisted state + Retry Download idempotency (§8/§9).
3. Added backend-driven failed item typed error projection (§10).
4. Hardened logs backend security (§12) and corrected Unified Logs dedupe strategy (§11).
5. Reconciled migration system (§4), corrected migration terminology (§5).
6. Restored Email regression tests baseline (§14).
7. Repaired Git worktree hygiene (§15).
8. **NO user session evidence has been produced.** Therefore Document Automation domain MUST NOT be labeled PASS.

---

## §1: WITHDRAWN Labels (per Corrective §1)

All following labels from previous VSR Final Report are **OFFICIALLY RETRACTED** with prejudice (no user session evidence existed):

| Domain | Previous incorrect label | Corrective replacement (HONEST) |
|---|---|---|
| Single-case generation | PASS (User verified) | PREVIEW_READY = NO / USER_VERIFIED = NO |
| ZIP download | PASS (User verified) | PREVIEW_READY = NO / USER_VERIFIED = NO |
| Multi-case state | PASS (User verified) | PREVIEW_READY = NO / USER_VERIFIED = NO |
| Generation Logging | VERIFIED_PASS | CODE_WIRED / RUNTIME_USER_SESSION_NOT_YET_VERIFIED |
| Unified Logs | VERIFIED_PASS | CODE_COMPLETE_LOCAL / USER_VERIFIED = NO |

**Full register:** see `docs/corrective-stabilisation-register.md` §A–§G.

---

## §2: Root Cause Matrix (Corrective per §2)

### Group A: DOCUMENT_AUTOMATION_UI_LOGGING_ROOT_CAUSES = FOUND (Concrete Evidence)

| # | Root Cause | Evidence | Fixed this round? | Files |
|---|---|---|---|---|
| RC-A1 | Logging pipeline broken → Doc Gen Logs = 0 rows | CHECK constraint on `document_generation_logs.action_type` limited to legacy values; new `DOCUMENT_*` action_type values INSERT rejected. Silent catch swallow gave UI 0 log rows. Error captured by structured logging (§6) only post-fix. | YES (migration + structured error events) | `vsr_p2_doc_gen_logging_additive.sql` + `writeDocumentGenerationLog()` |
| RC-A2 | Status semantics broken → derived frontend state inconsistent with persisted backend state. | UI 6-state existed only as frontend derivation; backend jobs.status never transitioned to `generated_download_failed`. nextAction="wait" even when ZIP packaging failed → Retry Download button not presented. | YES (§8 full wire: finalize + endpoints + download routes). | `documents.ts` §8A / §8B / §8C + §10 finalize helpers |
| RC-A3 | Failure details UI hidden + frontend guesses cause | (a) `failedItems[]` not projected by status endpoint → UI hid Failed Items panel. (b) Error cause was frontend-inferred (not backend authoritative). User saw "all succeeded" facade even when 6/6 failed. | YES (§10 typed projection + per-item classify). UI never guesses cause now — consumes backend typed error codes/human messages. | `documents.ts` status/steps endpoints |
| RC-A4 | Vercel build config broken → Preview Deploy FAIL | `vercel.json` v58.1.0 rejects CronConfig with `description` field (deprecated). Build halted with schema validation error. | YES (3 cron description entries removed). | `vercel.json` |

### Group B: DOCUMENT_GENERATION_6_OF_6_FAILURE_ROOT_CAUSE = NOT YET CONFIRMED (Critical per §2)

| Job ID | Scope | What is known | What is UNKNOWN |
|---|---|---|---|
| `07963ed7-48c4-4fc0-a2f7-662de52f1af0` | 6 cases × 1 template = 6 document generation items. All 6 marked FAILED in items table (per UI inspection of DB snapshot proxy). | Generation attempted. Items rows exist with status=failed. Some error_message populated but not yet classified. Log rows were 0 pre-fix (RC-A1 fixed post-hoc; log retroactively 0). | **TRUE per-item root cause of 6/6 generation failure = UNKNOWN.** Specifically: was it TEMPLATE_FILE_MISSING? VARIABLE_RESOLUTION_FAILED? PDF_GENERATION_FAILED? DOCX_GENERATION_FAILED? OUTPUT_MISSING? STORAGE_WRITE_FAILED? TIMEOUT? UNKNOWN classification → all plausible without real runtime evidence. Cannot claim item-level root cause. |

**CRITICAL WARNING (§2 binding):**
> Logging CHECK constraint failure = root cause of **Doc Gen Logs = 0 rows** ONLY.
> 
> Logging CHECK constraint failure IS NOT and SHALL NOT be reported as root cause of **Job 07963ed7 6/6 document generation failure**. Those are separate phenomena. The item-level generation failure could have been any of the 9 DocGenErrorCode categories. We genuinely do not know without rerunning against live code paths with current fixed logging pipeline and reviewing resulting backend-classified error codes.

**Next evidence required for 07963ed7 6/6 RC confirmation:**
1. Part 2 deploy of this patch.
2. User executes Test A (single-case with the same template + a similar case).
3. Inspect returned failedItems[].errorCode.
4. OR (if cannot reproduce) run the exact 07963ed7 inputs one-by-one in a staging workspace through the newly instrumented classifyDocGenError pipeline and record item-level error codes.

---

## §3: Deployment Scope Matrix (Honest per §3)

| Deployment scope | Touched this round? | Notes |
|---|---|---|
| Vercel Production Deployment | NO | No `vercel --prod` executed. Production domain traffic untouched. |
| Production Domain Changed | NO | No promote; DNS/alias unchanged. |
| Remote Supabase Schema Migration | YES | Full record → `docs/remote-supabase-migration-record.md`. 7 fields captured (migration name / applied time / target project / schema objects changed / row deletion count / data rewrite count / constraint change + columns added). |

Previous misleading phrase: "Production touched = 100% NO". **OFFICIALLY RETRACTED.** It conflated Vercel deployment scope with Supabase DB scope. Split three-column matrix above is now authoritative and permanent for all future round reporting.

---

## §4: Migration System Reconciliation (§4)

See register append at `docs/migration-sequence-register.md`.

- Migration name: `VSR_DOC_GEN_LOGGING`
- File on disk: `supabase/migrations/vsr_p2_doc_gen_logging_additive.sql`
- Apply channel: Out-of-band through `supabase_apply_migration` tool (NOT canonical `lib/db/migrations/*` runner).
- Status: `REMOTE_APPLIED_OUT_OF_BAND`
- Depends on: base `document_generation_logs` / `audit_logs` tables present (canonical numeric 0083 or equivalent base; exact to be verified via direct-SQL when 5432 reachable).
- Reconciliation note: Future schema changes are MANDATED to ONE canonical chain only (`lib/db/migrations/*` numeric ascending + register update). OOB supabase/migrations/ path is frozen effective this round.
- Duplicate apply guard: **NEVER duplicate apply already-remote-applied SQL.** Migration file uses IF NOT EXISTS / DROP CONSTRAINT IF EXISTS pattern.

---

## §5: Migration Terminology (§5)

- Old (incorrect) label: **additive-only**.
- New (authoritative) label: **NON-DESTRUCTIVE CONSTRAINT REPLACEMENT + NULLABLE COLUMN ADDITION**.
- Proof:
  - Contains `ALTER TABLE ... DROP CONSTRAINT ... action_type_check;`
  - Contains `ALTER TABLE ... ADD CONSTRAINT ... action_type_check CHECK (...13 values...);`
  - Contains NULLABLE ADD COLUMNs (no SET NOT NULL / no DEFAULT with backfill rewrite).
  - Verified: 0 rows deleted; 0 rows updated; 0 log rows rewritten; existing action_type values are literal subset of new superset CHECK.

---

## §6–§10: Code-level Fixes Summary (Evidence references)

See `corrective-stabilisation-register.md` §D–§G and §F for status.

Notable points:
- §6 Non-silent logging: Insert failure → emits structured `document_generation_log_write_failed` event (zero PII / credentials / doc content). Main generation flow uninterrupted.
- §7 Fallback visibility: 3-tier fallback used → structured `document_generation_log_schema_fallback_used` WARN. Tier 1 = canonical 18-col insert (normal path). Fallback is backward-compat temporary only.
- §8 Generated Download Failed real state: `document_generation_jobs.status` has value `generated_download_failed` persisted with `error_code` + `error_summary`. Not frontend-derived.
- §9 Retry idempotency: POST `/documents/jobs/:jobId/download` and GET `?force=true` both rebuild ZIP ONLY. 0 document regeneration. 0 duplicate SUCCEEDED events. Only one new `DOCUMENT_ZIP_CREATED` log event per successful retry-packaging.
- §10 Backend-driven Failed Items: `/jobs/:jobId/status` failedItems[]; `/jobs/:jobId/steps` per-item typed projection. Error codes enum DocGenErrorCode. Stack trace never exposed as user message. Unknown error → "Generation failed. Technical error code: ...".

---

## §11–§12: Logs Dedupe + Backend Security

### §11 Dedupe (Corrective Strategy)
Authoritative tiered dedupe strategy (UI):
1. **Tier 1 (PREFERRED, ALWAYS USE IF PRESENT):** Database row primary key / event_id → `pk::${eventId}`.
2. **Tier 2 (if no PK/event_id):** source + source_record_id → `src::${source_record_id}`.
3. **Tier 3 (LEGACY FALLBACK ONLY, never first two absent):** request_id + action + entity_type + entity_id + 10-second timestamp bucket + actor.

**Correlation ID = GROUPING KEY ONLY.** It is NEVER used inside dedupeKey. Same Job:
- Generation Started
- Case A success
- Case B success
- ZIP Created
- ZIP Downloaded

All 5 events preserved. UI collapses them into 1 Job Summary row (expandable), but underlying 5 events are not deduplicated-away.

### §12 Backend Security (Technical Detail Redaction)
- `/audit-logs` + `/platform/audit-logs` backend: firm-scoped (RLS). `audit:read` permission required. Cross-firm IDs rejected (RLS enforced firm_id filter).
- `/document-generation-logs` backend: same scope + permission gate.
- Technical fields (IP address, User-Agent, raw JSON diagnostic/stack/SQLSTATE inside audit.detail):
  - **Only returned** for users with elevated role (Partner / Admin / Founder) OR explicit `audit:view_details` permission.
  - Ordinary log-viewing users receive `null` for these fields in the Network response. UI hiding is defense-in-depth only; primary redaction is backend-side.
- This satisfies §12 "Technical Details cannot only Frontend hidden" requirement.

---

## §13–§16: Previous Verifications + Frozen Boundaries

| # | Item | Verification |
|---|---|---|
| §13 | Variables hash sync | Confirmed (§13, no additional code needed). |
| §14 | Frozen Email tests restored | DB-gated conditional skip; permanent describe.skip withdrawn. Email runtime code frozen = NO feature work. |
| §15 | Git worktree health | see `git worktree prune --verbose` evidence + `git worktree list`; orphan metadata must be 0. |
| §16 | Frozen modules boundary | Email Inbox / Document AI / Bank Statement Import / Bank Reconciliation AI = HOLD runtime code. No changes. |

---

## §17: PART 1 GATE → Immediate Next → PART 2

PART 1 GATE items that required code changes are complete. Final GATE verification (typecheck + build) required after this report is committed.

When PART 1 GATE = ALL GREEN:
1. Commit with message: `Corrective Part 1: 17 items CPASS. Ready for Part 2 Preview.`
2. Note short SHA.
3. Immediately transition to Corrective Patch PART 2: Deploy Preview → User Validation PASS (Test A/B/C) → Report → Production Gate (if approved).

**DO NOT label Document Automation PASS without real user session evidence of Test A/B/C successful execution.**
