# Test Skip Register (PART 3 §2)

API suite (VITEST_SKIP_DB=1) — Total 17 skipped tests as-of 2026-08-08.

**Rule**: Any test marked `DB_REQUIRED` / `INTEGRATION_REQUIRED` that exercises a security-critical surface (tenant isolation, RLS, cross-firm, reference uniqueness, invoice/receipt/PV concurrency, file custody consistency, HR isolation) is a PRODUCTION BLOCKER until replaced with an equivalent DB-integration test running under transaction-rollback / isolated test schema.

---

## Column Legend

| Column | Meaning |
|---|---|
| # | Ordinal skip ID (matches current 17 count) |
| file | `artifacts/api-server/src/__tests__/<file>` |
| test | `fullName` captured from vitest JSON reporter |
| reason | Why currently skipped (VITEST_SKIP_DB guard, missing fixture, legacy TODO, etc.) |
| dependency | What needs to exist to unskip (test-schema, seeded test firms, transaction-rollback harness, secret, concurrency harness) |
| security-critical? | YES / PARTIAL / NO (§2 4 critical buckets: PV attachment isolation / create case / reference suggestions / tenant-case isolation) |
| replacement coverage | If currently covered by another test family, cite file + count. If NOT, write NONE. |
| plan | Proposed resolution before PRODUCTION_READY gate |
| production blocker? | YES / PARTIAL / NO (YES = do not ship PRODUCTION without unskip) |

---

## Skip Inventory

| # | file | test | reason | dependency | security-critical? | replacement coverage | plan | production blocker? |
|---|---|---|---|---|---|---|---|---|
| 1 | communication-hub.test.ts | `Communication Hub MVP — Manual Email → Tasks → Draft → Sent manual email creation works and viewing writes audit only` | Skipped under `if (process.env.VITEST_SKIP_DB === "1")` — requires seeded DB firms, clerk user, email draft/patch endpoints. | test-schema harness + communication_hub seeded fixture + seeded auth user actor + transaction rollback | PARTIAL (firm isolation assertion co-located at #3 below) | NONE (communication hub MVP surface = not yet Active Scope per §23 frozen/partial definition; but #3 below IS isolation) | Stabilisation phase: run with DB harness when Communication Hub enters Active Scope (currently deferred, not blocker) | NO (not Active Scope, see #3) |
| 2 | communication-hub.test.ts | `Communication Hub MVP — Manual Email → Tasks → Draft → Sent batch message can create tasks, draft, approve and mark sent; timeline shows linked records` | Same VITEST_SKIP_DB=1 skip; same #1 dependencies | Same #1 | NO (business-path only, not isolation) | NONE | Same #1 | NO |
| 3 | communication-hub.test.ts | `Communication Hub MVP — Manual Email → Tasks → Draft → Sent firm isolation: message from other firm cannot be read` | Same VITEST_SKIP_DB=1 skip. **Cross-firm disclosure test** | Same #1, plus firm-B seeded message fixture + firm-A auth actor tries GET by id | YES (§2 explicit: "tenant/case isolation relevant tests") | NONE (no parallel isolation assertion for Communication Hub surface today) | Stabilisation: DB-integration run with 2 firms + transaction rollback; or add static route RLS policy test equivalent | YES (PARTIAL if communication hub not in Active Scope; YES if ship communication hub) |
| 4 | create-case.test.ts | `POST /api/cases — create case regression returns structured validation errors when body is empty` | VITEST_SKIP_DB=1 skip | test-schema + transaction rollback (no data written) | PARTIAL (contract only; no isolation) | NONE (but runtime-500-regression does not cover create-case validation matrix) | Stabilisation phase: unskip (safe: only POST/400, no data written if body empty) + add no-auth guard coverage | PARTIAL |
| 5 | create-case.test.ts | `POST /api/cases — create case regression Perfection minimal payload succeeds (no titleType/project/developer/purchasers)` | VITEST_SKIP_DB=1 + requires full accounting_settings/case_type/number_seq seeded | Same + firm with valid accounting_settings + perfection-numbering rules + seeded app user role (Clerk) with cases:create perm | YES (§2 explicit: "create case" critical bucket. Creates real data. Must verify idempotency + token reuse + firm binding.) | NONE for Perfection-specific case-type path. Borrower canonical unit tests cover 1-3 borrower persistence but NOT create-case HTTP contract. | Stabilisation Priority B. Unskip with transaction rollback. Assert firm_id in returned payload matches seeded actor firm_id. Assert borrower_canonical_write writes `cases.borrowers` not only loanDetails. | YES |
| 6 | create-case.test.ts | `POST /api/cases — create case regression Subsale minimal payload succeeds` | Same #5 dependencies + different case_type rules (Subsale progressive-chips default) | Same #5 | YES (same bucket) | NONE for Subsale path | Same #5 | YES |
| 7 | create-case.test.ts | `POST /api/cases — create case regression Developer Sales minimal payload succeeds (no referenceNo / no purchasers required)` | Same #5 + Developer Sales type. | Same #5 | YES (same bucket) | NONE for Developer Sales path | Same #5 | YES |
| 8 | create-case.test.ts | `POST /api/cases — create case regression creates a case successfully with inline purchasers` | Same #5 + inline structured address / TIN / phone / email | Same #5 | YES (same bucket; also §8 Borrower: 1st-party sync / 3rd-party not overwrite) | F8/F9 basic borrower-persistence unit tests = 9 tests in separate unit; but NOT HTTP create-case path + idempotency + purchaser->1st-party borrower sync | Same #5, additionally asserts purchasers[0] === cases.borrowers[0] canonical by JSONB-shape after reload. | YES |
| 9 | create-case.test.ts | `POST /api/cases — create case regression reuses the same case when the same tracking token is retried` | Same #5 + idempotency double-POST harness | Same #5 | YES (idempotency prevents duplicate real rows in PROD) | NONE for create-case tracking-token idempotency layer | Stabilisation Priority A. Unskip first. Double-POST with 0-delay then 5s delay, both returns same case_id, 2nd call = 200 (not 201), DB count unchanged. | YES |
| 10 | create-case.test.ts | `POST /api/cases — create case regression returns 401 when creating a case without authentication` | Same #4 — NO-DATA contract test, actually zero DB dependency! | None! Can run without DB. 401 auth middleware only. | PARTIAL (auth contract. 401 path is not isolation, but auth-hardening.) | NONE but 3 existing "unauth denied" route tests in rbac base families partially cover pattern. | **ACTION: Move this 401 case from .skip to inline immediately (this session).** No DB needed. | PARTIAL |
| 11 | payment-voucher-case-attachment-isolation.test.ts | `Payment voucher case attachment tenant isolation rejects attaching a caseId from another firm (server-side integrity check)` | VITEST_SKIP_DB=1. Requires 2 firms, 2 PVs each, each has a case_id in its own firm. | Same (Firm A PV → try attach Firm B case_id → 409 or 404 scoped-not-found, and row never written). Transaction rollback. | **YES (§2 FIRST critical bucket: "payment voucher case attachment isolation")** | NONE. No other endpoint-level cross-firm attachment integrity test exists today. | **Stabilisation Priority A.** Unskip first. Must prove either: (a) route handler `WHERE case.firm_id = req.firm_id AND pv.firm_id = req.firm_id` BOTH before insert; or (b) INSERT includes firm_id join check. Cross-firm attachment must not silently bind rows. | YES |
| 12 | payment-voucher-case-attachment-isolation.test.ts | `Payment voucher case attachment tenant isolation does not return other firm's cases in /accounting/cases/search` | VITEST_SKIP_DB=1. Requires 2 firms, each with cases. Actor firm-A searches and must only see firm-A rows. | Same #11 + cases seeded in both firms. Query: search returns N firm-A, 0 firm-B rows. | **YES (§2 explicit + tenant isolation)** | NONE. No isolated cases-search cross-firm disclosure test today. | Stabilisation Priority A. Unskip. Also asserts: if firm-A supplies case_id known to exist only in firm-B → GET /accounting/cases/X returns 404 NOT 403 "exists elsewhere" (no cross-firm oracle). | YES |
| 13 | reference-suggestions.test.ts | `reference suggestions returns starting number, next number, highest existing number and warning for project-specific rules` | VITEST_SKIP_DB=1. Depends on `firm_scoped_number_sequences` seeded rows (migration 0143). | migration 0143 applied (test-schema) + seeded accounting_settings.project_ref_rules + transaction rollback. | **YES (§2 critical bucket: "reference suggestions" — feeds #14 uniqueness below)** | F9 unit tests cover patch reference guard + immutable history rows; but NOT suggestion arithmetic + warning messages + per-project overrides. | Stabilisation Priority B. Unskip with 0143 number_seq table + 3 cases (existing refs: ABC/001/020/100). Assert next = ABC/0101, or project override shifts start. | PARTIAL → YES (#14 dup-detect critical enables ship) |
| 14 | reference-suggestions.test.ts | `reference suggestions keeps duplicate checks and allows manual reference approval` | Same #13. Also requires /cases POST + approval flow. | Same #13 + app user with case_reference:change role perm. | YES (directly feeds §9 "duplicate final → 409" integrity) | F9 PATCH reference guard = 1 test covers duplicate 409. But suggestion routine must also REDUCE duplicate risk. | Stabilisation together #13: unskip, assert when next would collide → routine bumps + returns "warning: collision detected, bumped to ABC/0102". | YES |
| 15 | runtime-500-regression.test.ts | `Runtime 500 regressions (with-db) dashboard does not 500 for valid auth` | VITEST_SKIP_DB=1. Dashboard summary queries need seeded firms + auth header. | Same #11 + seeded Clerk actor → GET /auth/me → GET /accounting/summary → expect 200 with JSON shape (not 5xx). | PARTIAL. Not an isolation test. But 500 at summary exposes stack traces if error handler leak. | NONE. No dashboard smoke-test today. | Stabilisation. Also pair with §21 typed-error contract: capture any route that returns 500 with raw err.stack → FAIL. | PARTIAL |
| 16 | runtime-500-regression.test.ts | `Runtime 500 regressions (with-db) cases list does not 500 with milestone + overdue filters` | Same #15 + seeded cases with key_dates/workflow milestones | Same #15 + seeded case workflow steps (at least 1 overdue by >1d). | PARTIAL. See #15. | NONE | Stabilisation same #15 | PARTIAL |
| 17 | runtime-500-regression.test.ts | `Runtime 500 regressions (with-db) cases workbench does not 500 for valid auth` | Same #15 + workbench query params | Same #15 | PARTIAL. See #15. | NONE | Stabilisation same #15 | PARTIAL |

---

## Security-Critical Counts (§2 4 named buckets)
| Bucket | Skip IDs | Count | PRODUCTION blocker? |
|---|---|---|---|
| payment voucher case attachment isolation | #11, #12 | 2 | YES ×2 |
| create case (all paths + idempotency + 401) | #4, #5, #6, #7, #8, #9, #10 | 7 | YES ×6, PARTIAL ×2 (#4, #10) |
| reference suggestions + dup detect | #13, #14 | 2 | YES (#14) / PARTIAL (#13) |
| tenant / case isolation relevant (cross-firm) | #3, #12 | 2 (one overlaps PV bucket) | YES ×2 (after #12) |

**Total security-critical skips → §2 explicit bucket skips = 10 unique rows out of 17. Remaining 7 = 6 PARTIAL (#4, #10, #13, #15, #16, #17) + 1 NO (#1, #2).**

## Production Blocker Summary
| Category | Count | IDs |
|---|---|---|
| YES PRODUCTION BLOCKER | 9 | #5, #6, #7, #8, #9, #11, #12, #14, #3 (if comms hub active) |
| PARTIAL PRODUCTION BLOCKER | 6 | #4, #10, #13, #15, #16, #17 |
| NO (not active scope / only business) | 2 | #1, #2 |
| **Total** | **17** | — |

## Resolution Priority Order (Stabilisation, before PRODUCTION)
1. **Priority A (ship blocking, integrity)**: #11 → #12 → #9 → #14 → #8 → #5/#6/#7 (create-case 3 payloads) → #3 (if comms hub ships)
2. **Priority B (contract + UX integrity)**: #13 → #4 → #10 (401 case, move NO-DB inline this session → 0 skip)
3. **Priority C (no crash)**: #15 → #16 → #17
4. **Priority Z (Active Scope deferred)**: #1 → #2

## VITEST_SKIP_DB Mechanism Note
Currently skipped by per-suite guard `if (process.env.VITEST_SKIP_DB === "1") { suite.skip() }` / inline `.skip()`.
- **NOT PRODUCTION READY** to leave all 17 skipped when VITEST_SKIP_DB=1 runs in CI as the *only* gate.
- **Required CI split**: (1) UNIT = VITEST_SKIP_DB=1 → always run (227 pass); (2) INTEGRATION = VITEST_SKIP_DB=0 + test-schema (transaction rollback) → must separately run on Stabilisation CI, with ZERO of the 9 YES PRODUCTION BLOCKER skips.
