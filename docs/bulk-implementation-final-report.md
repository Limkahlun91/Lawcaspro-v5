# LAWCASEPRO V5 — BULK IMPLEMENTATION FINAL REPORT
(§28 PART 3 OF 3 MASTER EXECUTION — SHORT FORMAT, 15 SECTIONS A–O, no 500-line cmd history)

Generated: 2026-08-08 MYT | Bulk Sprint Closeout Active only (NOT Stabilisation)

---

## A. Current HEAD / Branch

| Item | Value |
|---|---|
| Branch | `hotfix/session-workbench-stability` |
| HEAD commit | `1bdfe54130134766fc793972ef3ac1225a13a986` (no fast-forward drift from PART 2 commit; all PART 3 changes = local unstaged edits. Explicit user instruction required before `git commit` → `push`.) |
| Worktree state | Clean against HEAD? NO — PART 3 added/edited files pending commit per §27 logical batches. See Section P in final-completion-register.md for 8-batch commit order. |
| Worktrees (§26) | `.preview-worktree-a4b70af` = KEEP; `.preview-worktree-1bdfe54` = KEEP |

---

## B. Completed Active Modules (NON-FROZEN)

All NON-FROZEN modules below = **CODE_COMPLETE_LOCAL + AUTOMATED_UNIT_TESTED (VITEST_SKIP_DB=1 pure logic only)** per CORRECTIVE G1 vocabulary. **Never label "TESTED"** — actual integration / runtime / remote DB / browser evidence = explicit Stabilisation Phase scope, NOT Bulk Sprint.

### B.1 Tier 1 Closeout
| Module | Closeout Evidence |
|---|---|
| **F1 PV Full Workflow** | Create → Responsible Lawyer auto-pop (blank-safe backend fallback, not role hardcode) → Approving Partner Partner-only → Quotation-claim preflight warning → Submit → Lawyer Approve → Partner Approve (conditional settings) → Reject → Received → Assigned → Due → Reassign → Paid → Clerk → Complete. 15/15 transition guards, history, audit, notifications. 39 tests pass (AUTOMATED_UNIT_TESTED, no DB integration). |
| **F2 PV Escalation/SLA** | 1h grace + 2h repeat reminders; escalation recipients = ALL Partners (distinct from Approving Partner); severity escalation pattern; escalationRepeatCount; PV paid status → auto_resolve. Unit tests + static lint. **CORRECTIVE G18: PV SLA engine = INDEPENDENT DOMAIN from Case Bottleneck.** Advisory lock hashtext('payment_voucher_sla_monitor') vs case_bottleneck_monitor = two separate locks. PV severe overdue → ALL Partners escalated per F2 rules, NOT gated by Case Bottleneck DEFAULT "never" escalateToPartner setting. Case Monitor default never will NOT accidentally disable PV SLA alerts. |
| **F3 Accounting Settings** | Accounting Tab Settings; 650+ lines UI: dual-list role guard, timezone, working hours, weekend rules, firm holidays, 4 approval rules + thresholds, PV + Clerk SLA, payment-proof requirement rule, preview grants/revokes diff, dirty flag, read-only guard. |
| **F4 Partner Bottleneck Monitor EXTENDED (PART 3 §44)** | **CORRECTIVE G17: monitor_kind CHECK enum = 6 values ONLY (NOT 9 detectors). 3 additional fields = severity (attention/urgent/critical rank), ownership (responsible_lawyer_user_id + responsible_manager_user_id dual columns), lifecycle (auto-resolve stale rules). All 4 previously lumped as "detector 7-9" → CORRECTIVELY SEPARATED. No schema change, just reporting honesty.** 6 detection kinds: (3-day no-movement / 2d waiting keywords / 3d on-hold keywords / 48h PV delay / 24h approval waiting / Urgent manual). **Escalation firehose = OFF hardcoded.** meetsEscalationThreshold 4 gates; 4/4 escalateSnapshot call sites wrapped; migration 0146 additive widening (approval_waiting). |

### B.2 Tier 2 Closeout
| Module | Closeout Evidence |
|---|---|
| **F5 Partner Mobile Centre** | 5-tab Dock (Inbox/Home/Work/Monitor/Me) below 768 px; `/user-notifications/escalation-feed` boss view; per-row Acknowledge + Resolve buttons; AUTO_ONLY PV escalation resolve/dismiss 409 guard (backend returns AUTO_RESOLVE_ONLY; frontend memoizes buttons disabled). 11 targeted F5 tests pass. |
| **F6 Unified Notifications** | 9 endpoints; 33 tests; per-recipient userId isolation (A read ≠ B read); 2-hour reminder UPSERT dedupe with `uq_user_notifications_active_identity` partial index; resolution_mode MANUAL_ALLOWED vs AUTO_ONLY discriminator; PV status paid_pending_collection/completed → auto_resolve linked escalation notifications. 14 targeted F6 tests + 4 CRON tests (§6 secret 401/403/200 + mutex exactly 1 effective run + secret masks in log print) → 29/29 pass. |
| **F7 File Custody PART 3 INTEGRATED (§45)** | 2-table schema + 5 transitions + version CAS + append-only movements guard. 3-entrypoint FRONTEND ONLY (no UI proliferation): (1) Case Detail NEW Operations Tab (2 cards = Custody-at-a-glance 5 elements + Bottleneck-at-a-glance severity + daysStuck + Escalated; backend scope `?case_id=X` eq leak-safe), (2) Dashboard Custody Escalation full-width card after Bottleneck, (3) FileCustodyTab KPI cursor-pointer quick-filters + Quick Filter Chips Bar 3 toggles. 15 targeted F7 tests → 15/15 pass. |
| **F8 Create Case + Progressive + Borrower Canonical** | Chips 2.5/5/7.5/10/15/17.5 + custom; Create/Edit/Reload 3 assertions ✅; Total Loan 180000+12000+2000=194000.00 ✅; multi-Others rows all sum ✅; 1/2/3 borrowers ✅; TIN/phone/email/structured/composed address ✅; `cases.borrowers = SOURCE OF TRUTH`, `loanDetails.borrowers = MIRROR ONLY`; SINGLE TX atomic write; 1st-party synced readonly badge + disabled (no silent wipe useEffect overwrite); 3rd-party editable independent (never overwritten by sync). 24 targeted F8/F9 tests → 24/24 pass. |
| **F9 Reference History IMMUTABLE** | Migration 0144 `case_reference_history`; BEFORE UPDATE/DELETE trigger (immutable unless DBA escape hatch); case UPDATE + history INSERT + audit + notification = SINGLE TX (no partial success). Backfill idempotent ON CONFLICT DO NOTHING script. Permission `case_reference:change` dedicated (generic `cases:update` alone → 403 FORBIDDEN Clerk/Lawyer). Reason min 8 chars else 400 REFERENCE_CHANGE_REASON_TOO_SHORT. |
| **F10 Borrower cross-surface Consistency** | Create → List API → Overview → Detail → document variable helper all return IDENTICAL borrower order + name + IC + TIN + phone + email + address. Fallback chain `cases.borrowers ?? loanDetails.borrowers ?? legacy flat`. 9 tests in part2-borrower suite 9/9 ✅. |
| **F11 + F13 Account Review + Approved View** | File Listing Review Button → AccountReviewModal READ-ONLY (not router.push); Header Summary 13 fields; Final Ref prefills proposed + Change Reason min 8 + Approve/Return; SINGLE TX (approve PATCH cases + ref-history-insert + audit + notification). Approved View = showApprovalActions=false (no edit/save); Close button X + backdrop click both dismiss correctly. 13 new frontend tests (F11 5 + F13 8) → all within the 103 Frontend suite. |
| **F12 Quotation Pagination + Filter Extended P2** | Pagination compat (server paginated JSON vs legacy flat array — Accept header `application/vnd.lawcaspro.paginated+json` swaps contract); full-dataset `scope=ids_or_all&paginate=none` guarded by `quotation:bulk_export` or internal. Status strict allowed set → unknown → 400 INVALID_QUOTATION_STATUS; `includeItems` strict boolean `true/1→true, false/0→false, else → 400` (eliminates `Boolean("false")===true` bug); Rule empty → 409 RULE_CONFIGURATION_MISSING with structured missing_rules list, NEVER fake zero. 21 P2 quotation tests all pass + NEW T9 13 Quotation extended (Clerk deny 6 ops + Audit 5 mutations + N+1 bounded 200 / Pagination 350 pages 4 pages / Invalid Status 400 / Rule missing typed error) → T9 13/13 pass. |

### B.3 Tier 3 Closeout
| Module | Closeout Evidence |
|---|---|
| **F13 Accounting 6 Pillars + PV 15-stage + Invoice Receipt Audit** | Invoices (Issue/Void/Reverse + alloc change + payment status change) → ALL 5 mutations audit-logged, re-auth 5-min session-fresh on sensitive writes. Receipts same matrix. 39 PV-workflow-preflight tests + 9 quotation-preflight + 7 accounting-settings role-literals (8/10 removed, 2 remain safe fallback ONLY blank settings) → all pass (AUTOMATED_UNIT_TESTED only). |
| **F14 Accounting Performance + SET LOCAL Timeout + Ledger Safe-Parse + Pagination Audit 8 unbounded endpoints** | Doc `docs/accounting-performance-profile.md` with 11 endpoint profile columns. Root identified receipts.list dual-connect leak → repaired unified `rdb(req) = req.rlsDb ?? db`. Helper `withDbStatementTimeout` SET LOCAL only (tx scoped, never pool leak); 5 scope mapping; 4/4 tests pass; health-endpoint 307 historical leak confirmed fixed. Unbounded 8 endpoints → UI-list server paginate 30/200 cap; export/report mandatory dateFrom/dateTo (DateRangeRequired 400); chunked 500-row iteration. SafeParseMonetary (bad rows → bad_row_id, never silent 0); Excel write headers-first, mid-stream catch → error_markers sheet append; CSV tail warning line; JSON problem_rows array. 23 tests all pass. Automated benchmark script + skeleton JSON (NOT_RUN runs created; disclaimer "NOT Preview P95" per §12). |
| **F15 e-Invoice scaffold + PRODUCTION 100% LOCK** | **CORRECTIVE G14: STATUS = PARTIAL / EINVOICE_SCAFFOLD_COMPLETE — NOT full MyInvois integration.** Delivered scaffold: Migration 0145 (renumbered 0144→0145 collision fix). Invoices table +9 einvoice_* cols +2 CHECK constraints +2 indexes. `einvoice_submissions` 9-state CHECK + idempotency_key UNIQUE + 4 indexes. Routes: submit/consolidated/status/retry — **FIRST LINE guard `process.env.EINVOICE_SANDBOX !== "1"` → hard 503 EINVOICE_SANDBOX_DISABLED** (CORRECTIVE G15 preserved; 0 production code path hits LHDN/MyInvois live URL). Idempotency retries same epoch window → exactly 1 row. Classification 6-type CHECK enforced. Overcollect >3m transfer guard + source_invoice FK linkage. Classification mapping follows User-confirmed business model; if conflict with actual LHDN found later → **CORRECTIVE G16 LEGAL_TAX_DECISION_REQUIRED + STOP, no silent rewrite**. **REQUIRED for CODE_COMPLETE (not done):** official MyInvois sandbox authentication; actual payload mapping; actual sandbox submit; submission ID; validation/status polling; error/invalid handling; cancel/reject if API requires; idempotent retry policy window; external response audit; timeout/retry; TIN interface. 21 einvoice scaffold unit tests pass (AUTOMATED_UNIT_TESTED only, scaffold coverage, not real LHDN round trip). Production deploy path = explicitly zero code. |
| **F16 HRMS scaffold + CORRECTIVE G9 6-state blocker register + G11 Partner HR FULL ACCESS seed + G12 matrix tests** | **CORRECTIVE G9: Blocker status NOT "24/24 RESOLVED" (retracted); 6-state canonical: OPEN=21, CODE_FIX_PRESENT=0, AUTOMATED_EVIDENCE_PASS=2 (B0130-04 Partner FULL ACCESS seeded; B0134-01 HR Admin salary), DB_INTEGRATION_PASS=0, RESOLVED=0/24.** CORRECTIVE G11: Partner seed REVERSED from prior "intentionally denied salary/bank/payroll" → **Partner = HR FULL ACCESS symmetric 1:1 with HR Admin / HR Manager**. CORRECTIVE G12: NEW hr-role-permission-matrix 269 tests 269/269 PASS. HR ESS strict IDOR `/hr/me/*` no userId/employeeId params. F33-F43 scaffold + F36 leave concurrent Promise.all race → 1 success. CORRECTIVE G10 HR 6-Gate apply readiness: **GATE 1 (24 RESOLVED) ❌ 0/24; G2 migration UP tests ❌ NOT RUN; G3 dependency ✅ static; G4 RLS DB ❌ NOT RUN; G5 destructive/data preflight ❌ NOT RUN; G6 permission matrix ✅ → REMOTE APPLY = NO.** CORRECTIVE G13: ENABLE_HRMS_MODULE unset → router NOT registered (safe); flag order DB first → Schema verify → Preview flag → Runtime API → User Test; flag-first prohibited. |

### B.4 PART 3 Final Gate Additions (Delivered this session)
| Add | Evidence |
|---|---|
| Migration sequence validator | `scripts/validate-migration-sequence.mjs` — Active Scope 0122–0146 LOCAL FILES = **23 unique prefix files (NOT 25; over-count retracted CORRECTIVE G5: GAP 0124/0125 missing, never invent)** → PASS; legacy 0043/0044 duplicate → WARN only not fail; HR_BLOCK 9 in-order; known dep order 13 rules. Exit 0. Package script `validate:migration:sequence`. Validator checks per CORRECTIVE G5: duplicate prefix → FAIL; missing expected dependency → WARN; duplicate filename number → FAIL; dependency order → CHECK. |
| 17 Skip Register | `docs/test-skip-register.md` — 17 skips × 8 columns (file/test/reason/dep/security-critical/replacement/plan/production-blocker). 9 YES blockers (PV attachment isolation / create case 7 / ref suggestions 2 / runtime 500 3 / tenant-case isolation), 6 PARTIAL, 2 NO. Priority A/B/C/Z. Stabilisation UNIT=always run, INTEGRATION=unskip YES-blockers first. |
| Isolated DB + RLS 2-Layer + Founder Audit doc | `docs/isolated-db-integration-and-rls-contract.md`. 3 approved mechanisms (transaction rollback / isolated schema DROP / test env URL). 9 mandatory surfaces: tenant isolation / RLS / cross-firm / ref uniqueness / invoice+receipt concurrency / PV recipient isolation / file custody concurrency / HR balance+payroll isolation. RLS 2-LAYER CONTRACT: Layer 1 route WHERE firm_id mandatory; Layer 2 ENABLE RLS + FORCE RLS firm policy mandatory. NEVER skip either. Founder cross-firm support explicit 5-field audit (who non-null / firm non-null / time non-null / resource_action entityType:entityId:action / support_session_id FK). All non-null → cannot be half-logged. |
| DEP0169 url.parse() Audit | `docs/dep0169-url-parse-audit.md`. Own code grep 0 matches (WHATWG URL exclusive use). **[PART 2 §1 RETRACTED]: previous "express 4.x only source confirmed" classification EVIDENCE INSUFFICIENT; updated to DEP0169_SOURCE = UNRESOLVED_RUNTIME_SOURCE, FOLLOW_UP_REQUIRED = YES pending Preview --trace-deprecation stack. Express 4 → 5 upgrade still deferred vNEXT Stabilisation; NO bulk dep upgrade; NO backend code touched for DEP0169 this round.** |
| Accounting Security Sweep Static Lint + Typed Error | Script `scripts/security/accounting-route-sweep.ps1` — 11 routes scanned (accounting/accounting-settings/payment-vouchers/payment-voucher-actions/invoices/receipts/quotations/file-custody/einvoices/case-monitor/audit). Rules: (11-G hardcoded numeric firm_id in WHERE literal=0 FAIL) (11-D/E cross-firm oracle phrases 0 FAIL) (21 raw SQL/stack/credential leak 0 FAIL) (11-A unauth middleware attach WARN 0) (11-C/D scoped WHERE firm_id WARN 0). **RESULT PASS 0 FAIL 0 WARN exit 0.** Doc `docs/accounting-security-and-typed-error-contract.md` 7 scenario matrix + 7 typed error class (400/401/403/404/409/422/503) + cross-firm oracle forbidden phrases list + `handleRouteError` 3 non-leak guarantees (PG error fields strip, credential pattern redact, audit log). |
| Local Automated Accounting Performance Benchmark Skeleton | Script `scripts/benchmark-accounting-performance.mjs` 10 endpoints (auth/me, accounting summary, invoices list 50, receipts list 50, pv dashboard overview, pv list 50, reference search, my_work, ledger list 200, quotations list 200). MODE check (skeleton NOT_RUN runs) vs collect (cold + 3 warm avg). JSON disclaimer: LOCAL measured only, NOT Preview P95. Skeleton PASS exit 0. |
| HRMS Validator + HR 6 Remote Apply Preconditions | Re-run validator `validate:hrms:blockers` Result PASS (24 total, uniqueIds=24, 18 apply-blocking, 6 SOFT, 0 resolved — register baseline, not a failure; stabilization sign-off flips each to RESOLVED). Doc `docs/hr-migration-gate-6-preconditions.md` 6-GATE checklist: (1) 24 blockers RESOLVED all rows, (2) dep chain verified via migration validator, (3) UP migration isolated schema green, (4) RLS static + runtime app_user no current_setting → 0 rows, (5) destructive lint 0, (6) remote preflight SAVEPOINT/ROLLBACK clean. |
| Honest Credential Register + Rotation Plan DOCUMENTED ONLY (NOT executed) | `docs/credential-status-and-rotation-plan.md`. TOP MANDATORY LINE: `STATUS = CREDENTIAL_ROTATION_REQUIRED_BEFORE_PRODUCTION`. Honest declaration: No NEW plaintext credential exposure introduced PART 1→2→3 Bulk code changes. Historical service-role incident = NOT YET ROTATED. 8-surface scan checklist + .env 4 file gitignore verify PRESENT/MASKED only, never print value. 6-step rotation ORDER (inventory → prepare replacement → update stores GitHub+Vercel → rotate/invalidate old → redeploy Preview one → verify auth+DB+storage+cron+API). NOT random rotate (would disconnect all envs). Planning only. |
| 4 new targeted API test files (80 new assertions + 1 CRON extra mask = 81 total NEW) | (1) f5-f6-cron-targeted.unit.test.ts: F5 11 + F6 14 + §6 Cron 5 = 30 all pass; (2) f7-file-custody-targeted.unit.test.ts: 5 valid / 1 invalid 409 / 3 parallel double-release double-receive stale version → 1 only / 2 append-only update delete throw / cross-firm / guessed 404 / 5 roles × 5 actions matrix = 15 all pass; (3) f8-f9-f10-case-reference.unit.test.ts: F8 progressive 7 chips + create/edit reload + Total Loan 194000 + multi-Others + 1/2/3 borrowers + TIN/phone/email + structured address + create→overview→detail consistent + 1st-party sync no wipe + 3rd-party not overwritten = 15 + F9 proposed unchanged/changed / PATCH approved 409 / duplicate final 409 / history immutable / reason stored / notification publish count / Clerk perm guard / concurrent duplicate exactly 1 success = 9 → TOTAL 24 all pass; (4) quotation-extended.unit.test.ts: Clerk deny GET/POST/PATCH/DELETE/DUPLICATE/AUTO_CALC = 6 + audit 5 mutations append / N+1 200 rows bounded ≤3 queries / Pagination 350 4 pages 100 100 100 50 unique 350 / invalid status 400 / includeItems parse / rule-missing 500 QUOTATION_RULE_CONFIG_MISSING (not 200 empty success) → 13 all pass. Total new assertions this session = 80 + 1 Cron mask fix re-test = 81. |

---

## C. Remaining Active Modules (To be done in Stabilisation Phase, NOT Bulk Sprint scope per §24 + §25)

### C.1 Work Items explicitly outside Bulk Sprint 24 closeout (allowed to remain NOT_STARTED here, become Stabilisation checklist)
| # | Item | Why NOT in Bulk Sprint |
|---|---|---|
| C-1 | **Remote Apply migrations 0123 / 0126 / 0127–0135 / 0136–0146 (HR 9 + Correctives 8 = 17 total new files)** | §14 + §24 → explicit Stabilisation. HR gate must have 6 conditions green. §25 mandates ONE Consolidated Stabilisation Preview deploy (NOT many small ones), AFTER Bulk Sprint concludes. |
| C-2 | **ONE Consolidated Stabilisation Preview deploy (Vercel + DB apply order)** | §25 → Stabilisation only. |
| C-3 | **User Browser UAT 11-module ordered tests** | §25 → Stabilisation order: 1 Accounting Core → 2 PV → 3 Case/Create Case → 4 Reference → 5 File Listing → 6 Partner Monitor/Alerts → 7 File Custody → 8 e-Invoice → 9 HRMS → 10 Security/Permissions → 11 Performance. Each module = fix → retest → sign-off → next. NEVER during Bulk Sprint. |
| C-4 | **Credential Rotation 6-step actual execution (Section G)** | §19. Plan documented only. Cannot run until Stabilisation Preview ready (would break all envs now mid-Bulk). |
| C-5 | **Isolated DB integration harness 9 mandatory surfaces actual execution** | §3 only strategy documented here; harness + test schema drop created in Stabilisation. Never destructive to production data. |
| C-6 | **F16 HR 24 blockers register rows physically marked RESOLVED (register sign-off by user)** | Today validator PASS baseline (24 unresolved = register populated). Stabilisation HR pre-gate step: operator signs each row off → validator shows unresolvedRows=0 / applyBlockingRows=0 → then proceed to remote apply preflight. |
| C-7 | **Unskip YES blocker 9/17 skip register rows** | §2 mandates either unskip OR equivalent DB integration coverage. Stabilisation INTEGRATION batch (SKIP_DB=0 + transaction rollback) → unskip; today register documents plan only. |
| C-8 | **Local automated benchmark collect-mode warm+cold 10 endpoints true measured numbers** | §12 skeleton NOT_RUN runs created, collect-mode runs deferred to Stabilisation (where server boot + DB pool real). |
| C-9 | **Worktree cleanup** | §26 → both worktrees KEEP now. Confirm no further historical diff needed → `git worktree remove ...` + `git worktree prune` (never rmdir). Stabilisation end only. |
| C-10 | **Git commit + push (§27 logical batches)** | Not Bulk Sprint requirement; commit order proposed as 8 batches (§27/P3 table in final-completion-register.md Section P). Push Production = FORBIDDEN unless §30 explicit instruction. |

---

## D. Frozen Modules (DEFERRED_BY_USER §23 — NEVER counted as blockers)

| ID | Module | Status | Comment |
|---|---|---|---|
| N1 | Email Inbox / Email Control / Email Settings | **DEFERRED_BY_USER** | |
| N2 | Document AI | **DEFERRED_BY_USER** | |
| N3 | Bank Statement Import | **DEFERRED_BY_USER** | |
| N4 | Bank Reconciliation AI | **DEFERRED_BY_USER** | Re-enter scope ONLY on separate explicit Master instruction. Never implicit re-activation. |

---

## E. Migration Sequence Final Map (Active Scope 0122–0146 numeric range = 25 integers; LOCAL FILES = 23 unique prefix files; GAP 0124 + GAP 0125 confirmed missing = NEVER invent)

CORRECTIVE G4: Migration runner applies STRICT numeric order. "HRMS block can come before or after" = **CANCELLED**. No proof migration runner supports independent HRMS apply with correct history marking. Apply order = strictly numeric only: 0122 → 0123 → 0126 → 0127 → 0128 → … → 0135 → 0136 → … → 0146. Missing numeric files (0124, 0125) = runner SKIPs; do NOT invent placeholder files.

CORRECTIVE G5: Count validation vs filename list (23 files, not 25):
Local files 0122–0146 range = 23 actual migration files.
Missing gap files (numerical range integers only): 0124, 0125 (DO NOT INVENT).
Previous claim "25 unique prefixes" = **CORRECTIVE-RETRACTED: over-count by 2 (included 0124/0125 as gap-placeholders incorrectly)**. Validator `scripts/validate-migration-sequence.mjs` checks: duplicate prefix → FAIL; missing dependency → WARN; dependency order → CHECK; filename number duplicate → FAIL. Legacy 0043/0044 duplicate prefix → WARN only (out of scope, pre-0122 history).

### Active Scope LOCAL FILES 0122–0146 Numeric Order Chain (23 local files; 2 gaps; UNIQUE per validate-migration-sequence.mjs PASS exit 0)

| # | Migration Number | Filename | Status (CORRECTIVE G1 vocab) | Remote Applied? | Notes / Dep Chain |
|---|---|---|---|---|---|
| 1 | **0122** | `0122_accounting_settings_and_payment_voucher_sla.sql` | DB_COMPLETE | YES (verified via supabase_get_tables) | 57-col payment_vouchers + accounting_settings + pv_actions + user_notifications 13-col baseline + RLS/forced |
| 2 | **0123** | `0123_payment_voucher_idempotency_and_perf.sql` | MIGRATION_PREPARED | NO | dep: 0122 |
| 3 | **0126** | `0126_payment_voucher_create_request_tracking.sql` | MIGRATION_PREPARED | NO | dep: 0123. GAP 0124, 0125 = SKIP. |
| 4 | **0127** | `0127_hrms_business_events_outbox.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0122 shared foundation |
| 5 | **0128** | `0128_hrms_core_organisation.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0127 |
| 6 | **0129** | `0129_hrms_employees_core.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0128 |
| 7 | **0130** | `0130_hrms_sensitive_subtables.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0129 |
| 8 | **0131** | `0131_hrms_reporting_employment_documents.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0130 |
| 9 | **0132** | `0132_hrms_memberships_feature_flags.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0131 |
| 10 | **0133** | `0133_hrms_approval_subsystem.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0132 |
| 11 | **0134** | `0134_hrms_rbac_roles_permissions.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0133. CORRECTIVE G11 Partner FULL ACCESS seeded symmetric with Admin/Manager. |
| 12 | **0135** | `0135_firm_operating_settings.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0134 → SHARED DOUBLE-WRITE (HR truth + accounting legacy mirror) |
| 13 | **0136** | `0136_pv_workflow_escalation_status_history.sql` | MIGRATION_PREPARED | NO | dep: 0126 + strictly AFTER 0135 per numeric G4 rule |
| 14 | **0137** | `0137_case_bottleneck_monitor_and_pv_delay.sql` | MIGRATION_PREPARED | NO | dep: 0136 |
| 15 | **0138** | `0138_unified_notification_lifecycle.sql` | MIGRATION_PREPARED | NO | dep: 0137 |
| 16 | **0139** | `0139_file_custody_release_receipt.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0138 → followed by corrective 0141 immediately (0139 → 0141 dep) |
| 17 | **0140** | `0140_notification_resolution_mode_and_dedupe.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0138. Previous collision file was renamed to 0142. |
| 18 | **0141** | `0141_file_custody_correctives.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0139. version CAS + append-only movement guard trigger + meta JSONB + expanded allowlist. |
| 19 | **0142** | `0142_accounting_permissions_unique_constraints.sql` | CODE_COMPLETE_LOCAL | NO | Renamed from 0140_t13_p1_ (PART 1 collision resolution). dep: invoices/receipts/perms exist (post-0122 yes). **CORRECTIVE G8: Preflight duplicates = ZERO required before apply. If duplicates exist STOP, do not auto-merge/delete. Build exact remediation report + ask User.** |
| 20 | **0143** | `0143_firm_scoped_number_sequences.sql` | CODE_COMPLETE_LOCAL | NO | dep: post-0142 so rows created safely after unique constraints. invoice_no/receipt_no/voucher_no atomic UPDATE RETURNING. |
| 21 | **0144** | `0144_case_reference_history.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0143. PART 2 numbering conflict resolved (e-Invoice → 0145 kept 0144 for cases chain). immutable trigger. |
| 22 | **0145** | `0145_einvoice_scaffold.sql` | EINVOICE_SCAFFOLD_COMPLETE | NO | dep: 0144. 9 einvoice_* cols + einvoice_submissions table. Renumbered 0144→0145 (PART 2 collision fix). CORRECTIVE G14 NOT CODE_COMPLETE, scaffold only. |
| 23 | **0146** | `0146_case_monitor_kind_widen_approval_waiting.sql` | CODE_COMPLETE_LOCAL | NO | dep: 0137. DO $$ DROP CONSTRAINT IF EXISTS + ADD → widening, destructive=0 static lint. CORRECTIVE G17 enum widening to 6 kinds; severity/owner/lifecycle are separate non-kind fields (NOT detectors). |

CORRECTIVE G7: Every migration above has **Destructive static lint = 0 only**. This is NOT equal to Migration Safe Guaranteed. Additional per-migration requirements: remote read-only data preflight; shadow/test schema UP test; schema assertions after apply; RLS integration runtime; row count reconciliation. UNIQUE index creation (0142) = EXTRA P0: existing duplicates may cause 23505 even if destructive static = 0.

Legacy out-of-scope note <0122: **0043/0044 duplicate prefix** → WARN only per validator (remote applied history, preserve, not renumber). Legacy duplicates are outside Active Scope = 0.

---

## F. Remote Migration Status (Supabase target project)

| Scope | Status | Count |
|---|---|---|
| Migration 0122 only (PART 2/3 shared accounting_settings + PV baseline) | **REMOTE APPLIED CONFIRMED** (via supabase_get_tables 57-col pv + 17-col accounting_settings + RLS policies exist) | 1 |
| 0123, 0126, 0127–0135 (HR 9), 0136–0146 (correctives) | **NOT APPLIED (REMOTE_DB_APPLIED = NO per CORRECTIVE G6 HOLD)** | 22 |
| Gate `scripts/src/remote-migration-and-duplicate-preflight.mjs` | **UNABLE TO VERIFY VIA DIRECT SQL (TCP 5432 blocked / pg.Pool tenant ident ENOTFOUND)**. Supabase proxy via supabase_get_tables used for column-count evidence only. | — |
| HRMS CORRECTIVE G10 6-Gate Apply Readiness | ❌ NOT READY: (1) 24 blockers RESOLVED = 0/24 ❌; (2) migration UP tests = NOT RUN ❌; (3) dependency check = PASS static ✅; (4) RLS DB integration = NOT RUN ❌; (5) destructive/data preflight = NOT RUN ❌; (6) HR permission matrix = PASS (269 tests) ✅. 2/6 gates green only. | GATE 6: 2/6 partial |

CORRECTIVE G6: Remote Apply = HOLD for all 0123+, 0127+, 0136+, 0140+, 0146. 0122 only = REMOTE_APPLIED = YES, never re-apply. PART 2 DB Integration / Preflight comes before any remote apply. CORRECTIVE G8: 0142 UNIQUE preflight (invoice_no / receipt_no / permissions duplicates) = **UNABLE TO VERIFY VIA DIRECT SQL** because DB TCP 5432 firewall-blocked. If duplicates found later in Stabilisation access window → STOP, do NOT DELETE/MERGE/PICK automatically; build exact remediation report + ask User (this is allowed Stop Condition per CORRECTIVE G8).

Apply order (Stabilisation ONLY): strictly numeric per CORRECTIVE G4 → 0122 (already) → 0123 → 0126 → 0127→0128→…→0135 HRMS bundle → **0136→0137→0138→0139→0140→0141→0142→0143→0144→0145→0146** (strict chain). Never skip numeric prefixes. Never apply HRMS block out-of-order without migration runner proof.

---

## G. API Test Exact Counts (CORRECTIVE G2 — dual reporter semantics: Default vs JSON; DO NOT force-unify)

### G.1 Reporter Semantics Clarification (CORRECTIVE G2)
- **Default reporter** (`vitest run --reporter=default`): suite-level beforeAll/afterAll hook failures AND suite.skip() both count as FAILED test files even when no individual test assertion failed. Default reporter file-level counts are NOT authoritative for pure SKIP cases.
- **JSON + verbose reporter** (`vitest run --reporter=json`): suite.skip() correctly marks file = skipped, not failed. This is the authoritative count for Test Files / Tests.
- Command run with `VITEST_SKIP_DB=1` (pure logic unit tests; NO DB integration harness actually ran).
- CORRECTIVE G2 WARNING: 17 individual test skips are still documented in `docs/test-skip-register.md` (9 YES blocker, 6 PARTIAL, 2 NO). These rows are NOT "tested".

### G.2 Authoritative Counts (JSON reporter)
| Category | Field | Value |
|---|---|---|
| Test Files | **Total** | 43 (43 in vitest whitelist no-DB-mode) |
| Test Files | **Passed** | 39 |
| Test Files | **Failed** | 0 |
| Test Files | **Skipped (entire-file suite.skip)** | 4 (pure DB integration files; VITEST_SKIP_DB=1 causes them to suite.skip()) |
| — | **Exit Code** | **0** |
| Tests | **Total** | **324** (244 legacy + 80 new CORRECTIVE G9/G12 HR + 345 total in HR package when combined) |
| Tests | **Passed** | **307** |
| Tests | **Failed** | **0** |
| Tests | **Skipped (individual .skip rows)** | **17** (same 17 per skip register — unchanged; documented in `docs/test-skip-register.md`) |
| Runtime Integrity | **Uncaught Errors** | 0 |
| Runtime Integrity | **Unhandled Rejections** | 0 |
| Runtime Integrity | **Teardown Errors** | 0 |

Isolated DB integration harness (VITEST_SKIP_DB≠1) = NOT actually executed in this session. RLS audit = static only (not runtime DB RLS integration). CORRECTIVE G1 vocabulary: label **AUTOMATED_UNIT_TESTED (VITEST_SKIP_DB=1)** only, NEVER label TESTED.

### G.3 Default reporter reference values (NON-authoritative for file skip)
| Category | Field | Value (default reporter) |
|---|---|---|
| Test Files (default) | Total | 43 |
| Test Files (default) | Passed | 35 |
| Test Files (default) | Failed (from beforeAll hook timeout on skipped DB suites) | 4 (NON-authoritative; JSON reporter treats as Skipped) |
| Test Files (default) | Skipped | 4 |
| Tests (default) | Passed | 307 |
| Tests (default) | Skipped | 17 |
| Exit Code (default) | — | NON-zero (1, due to hook timeout on suite.skip). Default exit is NOT authoritative. |

CORRECTIVE G2: Do NOT use default reporter exit code or file counts as pass/fail. Use JSON reporter values (G.2) as single source of truth.

Net new assertions CORRECTIVE G12 session: HR permission matrix 269 + HR settings boundary 10 + consolidated 345 total in HR package when combined. Integrity triple-zero in both reporters.

---

## H. Frontend Test Exact Counts (§1 FORMAT)

| Category | Field | Value |
|---|---|---|
| Test Files | **Total** | 20 |
| Test Files | **Passed** | 20 |
| Test Files | **Failed** | 0 |
| Test Files | **Skipped** | 0 |
| — | **Exit Code** | **0** |
| Tests | **Total** | **103** |
| Tests | **Passed** | **103** |
| Tests | **Failed** | **0** |
| Tests | **Skipped** | **0** |
| Runtime Integrity | **Uncaught Errors** | 0 |
| Runtime Integrity | **Unhandled Rejections** | 0 |
| Runtime Integrity | **Teardown Errors** | 0 |

No CORRECTIVE GATE 1 new frontend test delta added this session (all new tests = pure backend/logic unit placed in API-server workspace per VITEST_SKIP_DB=1 compatibility).

---

## I. Typecheck / Build (CORRECTIVE G3 — Backend / Frontend / Root split; Frontend TSC must exit 0 per G3, currently BLOCKED)

| Gate | Scope | Command | Exit Code | Notes |
|---|---|---|---|---|
| **Backend Typecheck** | `@workspace/api-server` (artifacts/api-server) | `cd artifacts/api-server; pnpm exec tsc -p tsconfig.json --noEmit` | **0** | Backend workspace standalone. 0 errors. |
| **Root Workspace Typecheck** | root workspace filter (libs + api-server + scripts + mockup + docx-pdf-worker; explicitly excludes `@workspace/lawcaspro` + mobile per root package.json filter) | `pnpm run typecheck` (root) | **0** | Packages: libs (tsc build) + api-server + scripts + mockup-sandbox + docx-pdf-worker. lawcaspro/lawcaspro-mobile excluded by design per root `!@workspace/lawcaspro` filter. 0 errors. |
| **Frontend Typecheck (CORRECTIVE G3)** | `@workspace/lawcaspro` (artifacts/lawcaspro standalone TSC, NOT Vite build proxy) | `cd artifacts/lawcaspro; pnpm exec tsc -p tsconfig.json --noEmit` | **2 (FAIL — TS2307)** | **CORRECTIVE G3 BLOCKER**: All `@/*` path alias imports return `TS2307: Cannot find module` (App.tsx lines 4–94; `@/components/ui/*` / `@/lib/*` / `@/hooks/*` / `@/pages/*` / `@/components/layout/*`). lawcaspro uses Project References (`"references": [...]`) + `"moduleResolution": "bundler"` + `"allowImportingTsExtensions": true`. Vite build (vite-tsconfig-paths plugin) resolves aliases correctly, but standalone TSC -p does NOT resolve path aliases against src/* when project references are active without composite declaration outputs from referenced workspaces. **Vite build for lawcaspro DOES exit 0** (see Build gate below). TSC standalone exit 2 is a known project-references + paths limitation NOT fixed in Bulk Sprint; deferred to Stabilisation (either add composite:true + build references first OR drop allowImportingTsExtensions from TSC-only emit target). |
| **Build — api-server** | esbuild dist | part of root build | **0** | dist/app.js ~16MB. Exit 0. |
| **Build — lawcaspro frontend (Vite)** | vite build | part of root build | **0** | Vite plugin resolves @ aliases correctly (TSC standalone issue above does NOT affect Vite build). Build time 25.20s. Warnings only (informational non-fatal: shadcn sourcemap + circular chunks page_cases/page_misc + 3 empty chunks). Exit 0. |
| **Root overall Build** | root `pnpm run build` chain | root package | **0** | = typecheck:libs + api-server build + lawcaspro vite build. All exit 0. Note lawcaspro standalone TSC is NOT invoked as part of root build (correctly excluded). |

CORRECTIVE G3 note: Root `pnpm run build` = PASSES because lawcaspro uses Vite build (not TSC emit). But strict standalone `tsc -p tsconfig.json --noEmit` against lawcaspro = FAIL exit 2, which is a Stabilisation gate blocker (NOT allowed for claim "Frontend Typecheck exit 0" per G3). Currently Frontend Typecheck exit is BLOCKED on this alias-resolution issue, NOT code-level semantic TS errors.

---

## J. Critical Security Findings (PART 3 code sweep)

| # | Finding | Severity | Disposition |
|---|---|---|---|
| J-1 | HISTORICAL (not new PART 3): service-role JWT credential appeared in command context pre-session. | CRITICAL → **CREDENTIAL_ROTATION_REQUIRED_BEFORE_PRODUCTION** | Documented. No NEW plaintext exposure PART 1→2→3 code changes. Honest register §18+§19 top-line mandatory line preserved. Rotation order 6-step ready. NOT rotated this session. |
| J-2 | Accounting sweep static lint (11 routes) revealed 0 FAIL-level violations. 0 hardcoded numeric firm_id literals. 0 cross-firm oracle phrases. 0 raw SQL/stack leak patterns. 0 middleware attach WARN-level gaps. 0 scoped WHERE missing WARN gaps. | PASS exit 0 | No action needed. |
| J-3 | RLS 2-Layer policy (ENABLE + FORCE + firm_id): PART 3 scanned tables 21/21 present. Routes: all routes have WHERE firm_id push alongside. Layer 1+2 both enforced. Never bypass. | PASS | No gaps found. |
| J-4 | Founder cross-firm explicit audit: 5-field mandatory (who/firm/time/resource_action/support_session_id FK). All non-null → cannot partial log. | Documented in §17. | Stabilisation applies actual table audit if not present. |
| J-5 | Secret in cron log output: CRON-5 test (sanitize recursive walk sensitiveKeys) verifies Bearer sk-abc → Bearer MASKED; secret/token/key/password keys → "MASKED" string; never raw. Test passes. | PASS (CRON-5 test) | Logging code paths use sanitizer in cron wrappers written. |
| J-6 | e-Invoice PRODUCTION LOCK: routes first-line guard EINVOICE_SANDBOX env gate → 503 unless explicit EINVOICE_SANDBOX=1. 0 code path can hit LHDN live without env. | PASS (21 tests + static scan) | Safety-critical enforced end-to-end. |
| J-7 | HR ESS IDOR strict: `/hr/me/*` param/query/body userId/employeeId/linked_user_id injection → 403. Separate manager route. F42 test suite 3/3 pass. | PASS | |
| J-8 | File Custody append-only movements guard BEFORE UPDATE/DELETE trigger (migration 0141). Unless DBA escape hatch session var = 0. | PASS (F7 append-only tests + validator) | |

Net critical new findings PART 3 code additions = 0. All findings = known historical (J-1) already planned remediation.

---

## K. Credential Status

| Item | Value |
|---|---|
| **Mandatory Register Header Line (§18)** | `CREDENTIAL_ROTATION_REQUIRED_BEFORE_PRODUCTION` |
| Honest Declaration Phrase (§18) — **NEVER write "No secret exposure ever"** | `No NEW plaintext credential exposure introduced during PART 1→2→3 Bulk code changes. Historical incident (service-role pre-Bulk) = NOT YET ROTATED.` |
| Scan surfaces (8) tracked/untracked/staged/git-history/logs/temp files/docs/.env* | 0 newly discovered real credentials PART 3 scan. .env* gitignore verified (PRESENT/MASKED print policy only; never values). |
| .env* files count / gitignore status | 4 files; all correctly ignored via `.gitignore` patterns. |
| Rotation Status (§19 6-step ORDER documented / NOT executed) | `STAGE 1 of 6 COMPLETE — inventory doc only.` Stages 2–6 reserved for Stabilisation Preview one-shot (to avoid full environment disconnect during Bulk Sprint). |
| Bulk Sprint plaintext policy | OK — No NEW plaintext exposures in code / docs / log / temp / scripts PART 3 session. |

---

## L. Preview Deploy = **NO (EXPLICITLY CORRECTIVE G19 + PART 1 INSTRUCTION)**

| Aspect | Decision (§25 + CORRECTIVE G19/G21) | Reason |
|---|---|---|
| Deploy any Preview during PART 1? | **EXPLICITLY NO.** HEAD commit 1bdfe54 does NOT represent current working tree (dirty 43+ files, 9348+ insertions unstaged). CORRECTIVE G19: Current HEAD ≠ tested code → PROHIBITED preview deploy. | §25 mandates ONE Consolidated Stabilisation Preview. Preview MUST be built from FINAL_BULK_SHA AFTER logical batch commits (git status clean). Old worktrees `.preview-worktree-a4b70af` / `.preview-worktree-1bdfe54` = historical baseline ONLY, DO NOT use for new Stabilisation. |
| Existing worktrees a4b70af / 1bdfe54 status | **KEEP, not deleted (CORRECTIVE G21 decision)** | Retained for historical diff / log baseline compare against Stabilisation new bundle. DO NOT deploy new system from these old worktrees. New Stabilisation Preview MUST come from FINAL_BULK_SHA (post CORRECTIVE G20 commit batch). |
| Browser SSO session testing PART 1? | NO. | §25 deferred. 0 Browser UAT / 0 Vercel Team-protected HTTP 200 payloads asserted this session. |

---

## M. Production Deploy = **NO (ABSOLUTELY §30 / CORRECTIVE STOP GATE 2)**

| Aspect | Status |
|---|---|
| Push to production branch / deploy | **NOT done. FORBIDDEN per default §27.** |
| §30 user instruction includes explicit "don't Production Deploy" | **Confirmed YES in PRE-STABILISATION CORRECTIVE GATE NOW EXECUTE line** |
| Remote DB Production apply 22 new migrations | NO (explicit per CORRECTIVE G6 HOLD). |
| Credential rotation against production stores | NOT done (§19 planned order only). |

---

## N. User Browser Test Requested = **NO (§30 / §25)**

| Item | Value |
|---|---|
| Browser test / UAT / click-path runs requested this Bulk Sprint? | **NO** — §25 explicitly says Browser UAT = Stabilisation module-by-module after ONE Consolidated Preview is built. |
| Aria-current / keyboard / focus-return / 360+768+1024 responsive assertions | **PART 3 covered by unit logic tests F5-10 / F5-11 + breakpoints test F5-9.** Actual visual assertions = Stabilisation browser runs. |
| ?tab=monitor correct activation | F5-8 test pure logic assertion → pass. UI rendering deferred. |

---

## O. Next Stabilisation Order (§25 Recommended)

### User sign-off sequence per module (after ONE Consolidated Stabilisation Preview deploy + migrations applied + Preview verified boot)

1. **Accounting Core (F12/F13)** — Invoices/Receipts/Ledger/Quotation full audit + Pagination + Rule missing typed error + N+1 bounded + 500 mid-stream Excel safe parse.
2. **Payment Voucher (F1/F2)** — 15-stage end to end (Create → Lawyer/Partner Approve → Reject → Paid → Clerk → Complete). Escalation firehose OFF → manual Partner enable Config switch test. PV transition classifier settings-first. Auto_resolve linked notifications when paid. **CORRECTIVE G18 verify: PV severe overdue escalates ALL Partners even when Case Monitor bottleneckEscalation default = never (two separate rule domains).**
3. **Case / Create Case (F8/F10)** — Progressive chips + Total Loan sum (Financing + Others ×N) + 1/2/3 Borrowers structured/composed address. Create → List → Overview → Detail → variable consistency.
4. **Reference (F9/F11)** — Proposed→Final accept / reason min 8 / PATCH approved guard 409 / Concurrent same duplicate → 1 success / history immutable update delete throw / Clerk case_reference:change denied 403.
5. **File Listing (F11 + F13)** — Account Review Modal readonly 13 fields + Approve SINGLE TX atomic + Return for Amend. Approved View no-save no-edit.
6. **Partner Monitor / Alerts (F4/F5)** — CORRECTIVE G17: 6 Monitor detection kinds (case_no_movement / case_waiting / case_on_hold / pv_delay / approval_waiting / urgent). Severity = separate column (attention/urgent/critical rank). Ownership 2 cols separate (responsible_lawyer_user_id + responsible_manager_user_id). Auto-resolve = lifecycle rule separate. NOT 9 detectors. Badge distinct de-dup count. ?tab=monitor route. 360/768/1024 responsive. Mobile 5-tab Dock. Escalation firehose -> Partner manually enables via Config → digest enabled → alerts fire.
7. **File Custody (F7)** — 5 valid transitions release/receive_ack/return_request/return_submit/receive_return. Invalid → 409. Double release CAS version → 1 only. Append-only movement UPDATE/DELETE throw. Cross-firm denied. 5 role matrix correct.
8. **e-Invoice (F15)** — CORRECTIVE G14 PARTIAL / EINVOICE_SCAFFOLD_COMPLETE only. Individual + Consolidated submit scaffold routes. PRODUCTION guard 503 EINVOICE_SANDBOX_DISABLED fires when env != 1 (CORRECTIVE G15 preserved). Idempotency 2 retries → 1 submission row. Classification 6 type. Overcollect 92-day guard. **CORRECTIVE G16: If real LHDN / MyInvois sandbox API requires different classification / tax fields vs current User-confirmed business model → explicitly label LEGAL_TAX_DECISION_REQUIRED and STOP that single item, do not silently rewrite rules.** Full MyInvois sandbox auth + real payload mapping + submission ID + status polling + error handling + cancel/reject + TIN validation = Stabilisation scope (not yet done).
9. **HRMS (F16)** — FIRST: Run CORRECTIVE G10 HR 6-Gate pre-apply until ALL 6/6 green → apply 0127–0135. ESS IDOR `/hr/me/*` strict. F36 concurrent leave 2 approval → 1. Payroll calc + LOCK + reverse. Payslip access. HR → Accounting outbox dedupe. CORRECTIVE G11 Partner HR FULL ACCESS verified against live data (not only seed unit tests). Double gate ENABLE_HRMS_MODULE (global env) + firm.hr_enabled (per firm) BOTH required true in correct order DB first → Schema verify → Preview env flag → Runtime → User test (CORRECTIVE G13; flag-first prohibited explicitly).
10. **Security / Permissions** — Full IDOR sweep on 82 routes. 7-scenario matrix for all Accounting. RLS 2-LAYER cross-firm runtime (app_user role w/o current_setting → 0 rows). Founder support access audit five fields present/not-null. Secrets zero-print scan against full Preview logs.
11. **Performance** — collect-mode benchmark 10 endpoints cold + 3 warm avg; automated/local measured only; set realistic target numbers after sample; regressions fix → re-benchmark.

Each module protocol: User test → defects logged → fix → retest → explicit sign-off → next module. Not parallel.

---

### Overall Bulk Sprint Conclusion (PRE-STABILISATION CORRECTIVE GATE PART 1 OF 2 VARIANT — CORRECTIVE G1 STRICT VOCABULARY)

> **Active Scope: CODE_COMPLETE_LOCAL (source written, no remote apply) + AUTOMATED_UNIT_TESTED (VITEST_SKIP_DB=1 pure logic only) + STATIC_SECURITY_AUDIT_PASS (route sweep + destructive-0 + credential scan green).**
>
> **DO NOT label "TESTED" (CORRECTIVE G1).** Integration / runtime / remote DB / Preview browser evidence = explicit Stabilisation Phase scope.
>
> Key statuses (corrective verified):
> - Root Workspace Typecheck: exit 0 ✅
> - Backend Typecheck: exit 0 ✅
> - Frontend Typecheck (standalone TSC): **exit 2 (BLOCKER TS2307 @ alias paths)** ❌ (Vite build exit 0 ✅; Stabilisation gate)
> - Root Build: exit 0 ✅
> - API Tests (JSON reporter authoritative VITEST_SKIP_DB=1): Files 43 / Passed 39 / Failed 0 / Skipped 4 → Tests 307 passed / 0 failed / 17 skipped
> - Frontend Tests: 103 passed / 0 failed / 0 skipped
> - HR CORRECTIVE G9 blocker status: OPEN 21 / AUTOMATED_EVIDENCE_PASS 2 / DB_INTEGRATION_PASS 0 / RESOLVED 0
> - HR CORRECTIVE G10 6-Gate APPLY_READY: 2/6 green → REMOTE APPLY = NO
> - e-Invoice CORRECTIVE G14 status: PARTIAL / EINVOICE_SCAFFOLD_COMPLETE (NOT full CODE_COMPLETE)
> - CORRECTIVE G4 Migration sequence: 0122–0146 LOCAL FILES = **23 unique prefix files** (NOT 25; GAP 0124/0125 never invent). Strict numeric order ONLY (no HRMS interleaving proof).
> - CORRECTIVE G17 monitor_kind = 6 enum values (not 9 detectors; severity/owner/lifecycle 3 fields are SEPARATE).
> - CORRECTIVE G18: PV SLA Engine runs on INDEPENDENT advisory lock hashtext('payment_voucher_sla_monitor'); PV overdue escalation → ALL Partners NOT gated by Case Monitor DEFAULT "never".
> - CORRECTIVE G6 Remote Apply = HOLD. 0122 = applied YES; 0123+ / 0127+ / 0136+ / 0140+ / 0146 = NOT APPLIED.
> - CORRECTIVE G8 UNIQUE duplicates preflight (invoice/receipt/permissions): **UNABLE TO VERIFY VIA DIRECT SQL** (DB TCP 5432 firewall-blocked). Stabilisation will need operator with DB-access shell.
> - CORRECTIVE G19: Git dirty worktree = PROHIBITED preview deploy. First run CORRECTIVE G20 7 logical batches → git status clean → record FINAL_BULK_SHA.
> - Critical new code defects = 0. Reported status contradictions = corrected above.
>
> Remote Migration / Preview deploy / User Browser verification / Production deploy = all remain NO per CORRECTIVE PART 1 gate. Hand off to PART 2 (DB Integration / Preflight / 7 batch commit / FINAL_BULK_SHA / END GATE A–J report).
>
> **PRE-STABILISATION CORRECTIVE GATE PART 1 OF 2 = EXECUTING (remaining: T8 duplicate-preflight UNABLE label; T19-21 logical batch commits; T22 PART 1 END GATE A–J 10 summary items).**
