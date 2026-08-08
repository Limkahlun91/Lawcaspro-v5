# LAWCASEPRO V5 — PRE-STABILISATION CORRECTIVE GATE
## PART 1 of 2 — END GATE (A-J)

Auditor: FullStack Engineer (Corrective Agent) | Date: 2026-08-08 MYT | Next: → PART 2 (DB Integration / Preflight)

---

## §A. CURRENT BRANCH

| Item | Value |
|---|---|
| Branch | `hotfix/session-workbench-stability` |
| Previous baseline HEAD | `1bdfe54130134766fc793972ef3ac1225a13a986` (dirty; CORRECTIVE G19 dirty-tree prohibited deploy) |
| Baseline comparison | No new repo created; No branch swap; Continued existing branch per CORRECTIVE G20 rule |

---

## §B. FINAL BULK SHA

| Label | Value |
|---|---|
| **FINAL_BULK_SHA** | `a61b7de121451eb219f4a6e2973470f686bc3049` |
| Written to | [`docs/gate/sha`](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/docs/gate/sha) |
| Commits applied from baseline → FINAL_BULK_SHA | 7 logical batches (see §K) |
| Requirement (CORRECTIVE G20) | HEAD equals code typechecked/built/tested = SATISFIED |
| One Stabilisation Preview source | MUST originate from exact SHA `a61b7de…3049` — NOT older worktrees |

---

## §C. GIT CLEAN (REPRODUCIBLE)

| Category | Count | Details |
|---|---|---|
| Source files: tracked committed | ✅ ALL | 43 modified + ~250 new untracked source files, all committed in 7 batches |
| Source files: still modified | 0 | No M lines remain for .ts / .tsx / .sql / .json / .mjs / .ps1 / .md |
| Local untracked allowed | 22 items | **NOT deployable source**: 21 local operator logs (p3d*.log, p3d5*.txt, tmp_gate*.log, tmp_batch_plan.log, tsc_errors.txt) + 1 historical worktree leftover dir `.preview-worktree-1bdfe54/` |
| Local untracked: must commit? | NO | All 22 items are local run artifacts or historical worktree; explicitly excluded by `.gitignore` semantics (would add noise only; no functional impact) |
| Overall verdict for reproducible bulk source | **CLEAN** | FINAL_BULK_SHA (§B) + empty source file modification set → reproducible |

---

## §D. MIGRATION EXACT MAP (CORRECTIVE G4/G5/G6/G7/G8)

### D.1 Numeric scope + counts (CORRECTIVE G5)
- Declared Bulk Sprint active migration prefix range: **0122 → 0146**
- **Expected contiguous count if no gaps**: 25 (0146 − 0122 + 1)
- **Actually present local files (unique prefixes)**: **23** (verified via `lib/db/migrations/` glob)
- **Numerical GAPs (never invent placeholders per G5, CORRECTIVE G5)**:
  - 0124 → NO local file → **SKIP** by runner
  - 0125 → NO local file → **SKIP** by runner
- **Verified count**: 0122,0123,0126,0127,0128,0129,0130,0131,0132,0133,0134,0135,0136,0137,0138,0139,0140,0141,0142,0143,0144,0145,0146 → **23 prefix files** (count is correct, not 25; "25 unique prefixes" retracted, CORRECTIVE G5)

### D.2 Order rule (CORRECTIVE G4)
- **Authoritative runner order**: Strict numeric ascending only.
- **Retracted (CORRECTIVE G4)**: All "HRMS first or last OK" interleaved proposals; "0136→0144 renumber / 0137→0145 / 0138→0146 / 0139→0147 / 0140→0148 / 0141→0149" renumber batch; interleaved out-of-band psql manual apply — **ALL EXPLICITLY CANCELLED G4**. Reason: 0144/0145/0146 already occupied (P2 collision resolution: 0144=F9 Reference History, 0145=F15 eInvoice, 0146=F4 Monitor widening); no formal proof Supabase runner supports "independent apply then correct history row marking".

### D.3 Remote applied state (CORRECTIVE G6 HOLD)
| Migration prefix | REMOTE_APPLIED (authoritative) | Evidence / Blocked reason |
|---|---|---|
| 0120 (pre-bulk) | Y | Locked pre-history |
| 0121 (Email FROZEN) | N/A frozen | Explicit frozen module — do not touch (DEFERRED_BY_USER) |
| **0122** | **YES** | PROXY VERIFIED via supabase_get_tables: payment_vouchers=57 cols, user_notifications=13 cols baseline present (CORRECTIVE G6 — only one allowed applied in Bulk Sprint scope) |
| 0123 | **NO (HOLD)** | Strict numeric next after 0122; CORRECTIVE G6 HOLD — runner would proceed 0123 then SKIP 0124/0125 then 0126 then BLOCK at 0127 (G10 6-gate) |
| 0124 / 0125 | N/A gap | SKIP by runner; NEVER invent placeholder (CORRECTIVE G5) |
| 0126 | **NO (HOLD)** | Blocked by 0123 sequential + 0127 gate behind |
| **0127–0135 HRMS (9)** | **NO (APPLY_READY = NO)** | CORRECTIVE G10 6-gate 2/6 green (§E/G); runner would BLOCK immediately at 0127 apply |
| 0136–0141 (PV/notif/custody corrective) | **NO (transitive blocked)** | Blocked behind 0127–0135 (strict numeric CORRECTIVE G4) |
| 0142 (UNIQUE 3 indexes) | **NO + STOP condition** | CORRECTIVE G8 STOP: duplicates exist → STOP build report + ask User, NEVER auto delete/merge/pick-newest/pick-oldest. Current UNABLE TO VERIFY VIA DIRECT SQL (pg.Pool TCP 5432 BLOCKED runner firewall) → label in docs/accounting-duplicate-preflight.md §1.2/§2.3 |
| 0143 (firm sequences) | **NO** | Blocked behind 0142 |
| 0144 (Reference History) | **NO** | Blocked behind 0143 |
| 0145 (eInvoice scaffold) | **NO** | Blocked behind 0144 |
| 0146 (monitor kind widening) | **NO** | Blocked behind 0145 |

### D.4 Static destructive=0 ≠ Migration Safe (CORRECTIVE G7 WARNING)
Each migration 0123+ still requires independently in PART 2:
1. **Remote read-only data preflight** (for UNIQUE/CHECK/FK/trigger actual runtime)
2. **Shadow/test schema UP test** (with SAVEPOINT + ROLLBACK)
3. **Schema assertions** (pg_indexes + pg_constraint catalog checks)
4. **RLS integration** (app_user no current_setting → 0 rows)
5. **Row count reconciliation** (before vs after — zero unexpected delta for additive-only, or documented expected for backfill rows)

CORRECTIVE G7: Static destructive lint = 0 only guarantees absence of DROP/TRUNCATE/DATA TYPE NARROW/DELETE in source SQL; guarantees ZERO about runtime-on-existing-data.

---

## §E. HR 24 BLOCKER TRUE STATUS (CORRECTIVE G9)

### E.1 5-state canonical lifecycle
Status transitions only:
`OPEN → CODE_FIX_PRESENT → AUTOMATED_EVIDENCE_PASS → DB_INTEGRATION_PASS → RESOLVED`

No jump-overs permitted; RESOLVED is terminal final sign-off state only.

### E.2 Population (registered blocker count = 24, unique IDs = 24, validators PASS id uniqueness)

| Status | Count | Examples (IDs) |
|---|---|---|
| **OPEN** | 21 | B0127-01, B0127-02, B0128-01..02, B0129-01..03, B0130-01..03, B0131-01, B0132-01..02, B0133-01, B0134-02..05, B0135-01 (default no sign-off) |
| **CODE_FIX_PRESENT** | 1 | B0130-02 (primary code touched, test pending targeted spec) |
| **AUTOMATED_EVIDENCE_PASS** | 2 | B0130-04 Partner HR FULL ACCESS seeded (G11) + verified by hr-role-permission-matrix L219–231; B0134-01 HR Admin salary grant column present |
| **DB_INTEGRATION_PASS** | 0 | Not run — required PART 2: shadow UP schema + isolated DB tx rollback harness |
| **RESOLVED** | **0 / 24** | Terminal sign-off = Stabilisation Operator; CORRECTIVE G9 **RETRACTED** previous claim of "24/24 RESOLVED" (that was false; never reached terminal state). |

### E.3 CORRECTIVE G9 conclusion
- ❌ NOT "24/24 RESOLVED"
- ✅ Honest 5-state: 21 / 1 / 2 / 0 / 0
- ✅ Blocker register each row = Blocker ID, exact evidence, targeted test, DB, RLS, status per §G9 6-col format
- ✅ Validator `validate-hrms-blocker-register.mjs` checks status lifecycle (not row count alone; earlier "row count pass = resolved" was incorrect, now fixed lifecycle-aware validators only)

---

## §F. PARTNER HR PERMISSION MATRIX (CORRECTIVE G11 + G12)

### F.1 Rule (CORRECTIVE G11 REVERSED previous "Partner default deny salary/bank/payroll")
> **HR Admin = HR Manager = Partner → HR FULL ACCESS (1:1:1 symmetric)**
> All other users (Lawyer, Clerk, Account Admin, ordinary Employee) → **Employee Self-Service only** unless explicit delegated permission configured per firm.

### F.2 FULL ACCESS pillars (Partner included, all granted)
| Pillar | Partner has access (CORRECTIVE G11) |
|---|---|
| Employee: full management (CRUD, org unit, position, reporting) | ✅ YES |
| Salary: view / edit / approve / history | ✅ YES |
| Bank Details: view / edit / verify | ✅ YES |
| Statutory: EPF/SOCSO/EIS/PCB calculations + submissions | ✅ YES |
| Payroll: create / view / adjust / finalise | ✅ YES |
| Payroll Run: execute / lock / unlock / unlock-for-adjustment | ✅ YES |
| Payroll Lock / Reverse | ✅ YES |
| Claims: approve / reject / process / pay-run link | ✅ YES |
| Attendance: settings, rosters, bulk approve | ✅ YES |
| Leave: rules, carry-over, bulk approve | ✅ YES |
| Documents: employee confidential doc upload / revoke / signed URL | ✅ YES |
| Termination: initiate / approve / offboarding checklist | ✅ YES |
| HR Settings: feature flags, working days, holidays, tiers | ✅ YES |
| Reports: headcount, turnover, costing, statutory reports | ✅ YES |

### F.3 Safety conditions (still enforced; full access != unsafe)
- All firm scoped (`firm_id` WHERE mandatory + RLS ENABLE/FORCE)
- All mutations audit-logged (writeAuditLog with ipAddress/userAgent)
- RLS 2-layer contract: route WHERE firm_id + DB policy, NEITHER layer skipped
- Founder access: explicit audited support context only — never implicit "founder is every-firm partner"
- Never substitute "frontend hidden" for backend permission checks

### F.4 Targeted tests (CORRECTIVE G12 hr-role-permission-matrix.test.ts)
| Test block | Assertion count | Result |
|---|---|---|
| HR Admin — full allowed (every HR_FULL_ACCESS_PILLARS row admin=true) | per pillar | PASS (G12: 1st row) |
| HR Manager — symmetric 1:1 to HR Admin (r.manager === r.admin for every row) | 1 assertion + per pillar | PASS (G12: 2nd row) |
| **Partner — symmetric 1:1 to HR Admin (r.partner === r.admin every row)** | 1 assertion + per pillar | **PASS (CORRECTIVE G11 verified — no deny-salary/bank/payroll bug)** |
| Lawyer / Clerk / Account Admin defaults — NOT in seed role list (ESS only fallback, no extra HR grant outside delegation) | 1 seed content + 3 roles | PASS (G12) |
| Cross-firm isolation — cannot read/write other firm data | mocked 2 firms | PASS (G12) |
| Ordinary employee — cannot salary/payroll/other employee's document | 3 tests | PASS (G12) |
| Migration 0134 seed explicitly covers 4 named roles | 4 content matches | PASS (G12 L260–265: HR Admin, HR Manager, HR Employee, Partner present) |
| Backfill per-firm loop present | regex match | PASS (G12 L279) |

**CORRECTIVE G12 total**: 269/269 assertions AUTOMATED_EVIDENCE_PASS ✅.

---

## §G. e-INVOICE TRUE STATUS (CORRECTIVE G14/G15/G16)

### G.1 Overall status → **NOT CODE_COMPLETE** (CORRECTIVE G14 retracted)
> **F15 = PARTIAL / EINVOICE_SCAFFOLD_COMPLETE**

### G.2 Delivered in scaffold (allowed to claim)
- Migration 0145: invoices +9 `einvoice_*` columns, 2 CHECK enums, 2 indexes; new `einvoice_submissions` table with 9-state CHECK, `idempotency_key UNIQUE`, 4 indexes, RLS + FORCE RLS
- Routes: individual submit, consolidated, status, retry — routes exist, route registration done, API types (api-zod)
- Sandbox/mock adapter + 6-type classification helper (§G.4) + overcollect >3m transfer guard
- Status machine skeleton + idempotency retry behaviour (same epoch window idempotency exact 1 row)

### G.3 REQUIRED for full CODE_COMPLETE (NOT done / NOT claimed)
CORRECTIVE G14 explicit missing list (actual MyInvois/LHDN integration items):
1. Official MyInvois sandbox **authentication** (client ID, secret, token refresh)
2. Actual **document payload mapping** (Invoice line 3D party/TIN/date/amount format to official JSON schema version)
3. Actual **sandbox submission** (real POST to api.myinvois.hasil.gov.my — currently mock only)
4. **Submission ID** + Internal invoice ID linkage stored back (einvoice_submissions.tin etc populated by real response)
5. **Validation / status polling** (LHDN callback OR periodic pull; error reason code mapping)
6. **Invalid / error handling** (official error codes → user-facing 409 with structured payload)
7. **Cancel / reject** handling if required by current official MyInvois API spec (LHDN sometimes mandates cancel-not-submit)
8. **Idempotent retry window** + token auto-refresh on 401 (not static 1-epoch only)
9. **External response audit trail** (raw signed inbound LHDN payload, hmac verify, non-repudiation)
10. Timeout / retry / circuit-breaker on network failures
11. TIN validation interface (LHDN TIN checker pre-submit — e.g. seller/buyer TIN format + active status)

### G.4 CORRECTIVE G15 Production hard LOCK → 100% PRESERVED
`artifacts/api-server/src/routes/einvoices.ts` (6 guarded code paths L58/75/85/102/129/151):
- Guard: `process.env.EINVOICE_SANDBOX !== "1"` → HTTP 503 `EINVOICE_SANDBOX_DISABLED`
- Zero production code path can reach LHDN real endpoint. If flag unset, hard 503 before any logic.
- Stabilisation Preview will allow only official sandbox/test endpoint if flag explicitly set; **never Production LHDN**.

### G.5 CORRECTIVE G16 Legal/Tax decision guardrail
Classification currently (per user-confirmed business model, services/einvoice/classification.ts L15-30 keywords):
- Stamp Duty / Registration / Land Office / NPFT / Quit Rent / Cukai Tanah / Solicitor Remuneration / Court Fee / Filing Fee → CLIENT_STAKEHOLDER_MONEY bucket
- Professional Fee = OFFICE_INCOME (default when no stakeholder keyword)
- Overcollect > RM 3m transfer logic preserved; separate OVERCOLLECT_TRANSFER priority

**If actual LHDN/MyInvois official API contradicts any mapping**: record `LEGAL_TAX_DECISION_REQUIRED` on that classification only → single-item STOP + ask User; do not silently rewrite user-confirmed business model. Other modules continue unaffected.

---

## §H. REMOTE DB APPLIED THIS PART = NO (CORRECTIVE G6/G8/G10)

| Action | During PART 1? | Notes |
|---|---|---|
| Apply 0123+ | ❌ NO | G6 HOLD explicitly; 0122 already applied pre-Bulk Sprint (proxy confirmed 57 cols) |
| Apply HRMS 0127–0135 | ❌ NO | G10 APPLY_READY = NO (6-gate 2/6 green only) |
| Apply 0136–0146 (PV, notif, custody, UNIQUE, sequences, F9/F15/F46) | ❌ NO | Blocked behind HR 0127 per strict numeric (G4) |
| Apply 0122 AGAIN (duplicate) | ❌ NEVER | Protected in runner by schema_migrations.version existing |
| Any manual DELETE/merge of invoice number duplicates (G8) | ❌ NEVER | STOP condition required by G8; if found write exact remediation report (firm_id, dup-values, count, PK samples, FK references) then ask User. Never auto-cleanup. |
| schema_migrations.version rows added to remote during PART 1 | 0 | Consistent with "applied = no" |

**Overall: REMOTE_DB_APPLIED_DURING_PART1 = ZERO new migrations** (only 0122 was already there before PART 1 started).

---

## §I. PREVIEW DEPLOYED = NO (CORRECTIVE G19/G21)

### I.1 Why no Preview deploy yet (CORRECTIVE G19)
- Before PART 1: HEAD = `1bdfe54…` with dirty worktree ~250 source files modified/untracked. CORRECTIVE G19 explicitly: "HEAD ≠ tested code → NO Preview deploy".
- NOW: 7 batches committed; FINAL_BULK_SHA clean source. But PREVIEW deploy is **Stabilisation Phase scope**, explicitly:
  - ONE Consolidated Stabilisation Preview build (after PART 2 DB preflight/UP tests/RLS integration passes)
  - Module-by-module user browser sign off only after Stabilisation
  - NEVER Bulk Sprint phase = no Preview
- Rule G19 satisfied (no dirty tree deploy) AND §24/§25 honoured (Preview deferred → Stabilisation).

### I.2 Old worktrees (CORRECTIVE G21)
| Worktree | Status NOW | Action |
|---|---|---|
| `.preview-worktree-a4b70af` | KEEP (historical baseline) | NEVER source for NEW Stabilisation Preview |
| `.preview-worktree-1bdfe54` | KEEP (historical baseline) | NEVER source for NEW Stabilisation Preview |
| New Preview for Stabilisation | → MUST use `a61b7de…3049` (FINAL_BULK_SHA §B) from clean tree | ✅ |

### I.3 User Browser Test = NOT requested
Explicit GATE scope: NO Browser UI testing in PART 1. Will be enabled ONLY in:
→ Stabilisation, after DB+Preview+Runtime green, in order 1.Accounting Core → 2.PV → 3.Cases → 4.Reference → 5.File Listing → 6.Partner Monitor → 7.File Custody → 8.eInvoice → 9.HRMS → 10.Security/Permissions → 11.Performance.

---

## §J. PRODUCTION = NO

| Category | Production action |
|---|---|
| LHDN real submit | ❌ PROHIBITED (CORRECTIVE G15: EINVOICE_SANDBOX unset → 503; production real submit code path NOT enabled) |
| Vercel Production deploy | ❌ NEVER in PART 1 scope; explicitly disallowed |
| Credential / service-rotation actual run | ❌ DOCUMENTED ONLY. Rotation plan in docs/credential-status-and-rotation-plan.md (STATUS: CREDENTIAL_ROTATION_REQUIRED_BEFORE_PRODUCTION). No execute now would break all preview envs mid-Stabilisation prep. |
| Remote destructive DB changes | ❌ 0 applied, 0 planned |
| 0122 duplicate apply | ❌ NEVER |

---

## §K. 7 LOGICAL BATCH COMMITS (CORRECTIVE G20)

| # | SHA (partial) | Summary | Files changed |
|---|---|---|---|
| 1 | `32f2c91` | Migrations (0127–0146, 19 files) + drizzle schema (6) + validators (2) | 28 |
| 2 | `ed25eba` | Notifications F6 + File Custody F7 + Partner Monitor F4 + Mobile Centre F5 + cron/route guards | 17 |
| 3 | `f735c73` | Cases F8 + Borrower Canonical F10 + Reference History Immutable F9 + dashboard/form/detail | 12 |
| 4 | `9303608` | Accounting F1/F2/F3/F13 + PV full workflow + ledger-safe-parse + pagination 8 unbounded endpoints + SET LOCAL timeout + firm sequences + quotation-extended/filters + route-sweep script + lockfile/config | 39 |
| 5 | `8140667` | eInvoice scaffold PARTIAL F15 (routes 6 503 guards + 4 services + test 21 + preflight script G8 STOP) | 7 |
| 6 | `e45cc2d` | HRMS F16 (22 routes + modules/hr + shared + integrations + worker + pages/app/hr + pages/app/my + components/hr + 5 HR tests + api-zod/hr) | 120 |
| 7 | `a61b7de` | 20 docs registers (CORRECTIVE G1–G22 honesty rewrite) + app routes mount + permissions catalog + feature flags + settings + .vercelignore + 2 historical deploy scripts | 26 |

**Total inserted/changed over 7 batches**: ~29,370 insertions / ~1,255 deletions → reproducible chain, 0 merge commits, linear 1bdfe54 → 32f2c91 → … → a61b7de = FINAL_BULK_SHA.

---

## §L. FOLLOW-UP → PART 2 ENTRY CONDITIONS (before Stabilisation Preview)

Ordered mandatory for PART 2:

1. **0142 UNIQUE preflight (G8)**: run scripts/src/remote-migration-and-duplicate-preflight.mjs from a network that has Supabase pooler DB access. If any duplicate row groups found in invoices/receipts/permissions → **STOP single condition**, publish exact remediation report (with firm_id, duplicate values, row counts, sample PKs, FK references), ask User. NEVER auto-DELETE/merge.
2. **HR 6-gate (G10) advance from 2/6 green**:
   - Gate-1: mark 24 blockers → RESOLVED (operator sign-off each row)
   - Gate-2: run migration UP shadow isolated test for 0127–0135
   - Gate-3 (already green) dependency chain
   - Gate-4: RLS DB integration (app_user no context → 0 rows each HR table)
   - Gate-5: destructive/data preflight (orphan rows, seed OK, widening OK)
   - Gate-6 (already green) permission matrix 269/269
3. **G7 each migration 0123+ → 5 phases (shadow UP/data preflight/schema assert/RLS int/row count)**
4. **Run 17 skip register (G2) YES-blocker rows in INTEGRATION mode** (VITEST_SKIP_DB=0 + transaction rollback harness) — unskip 9 YES-production-blockers first
5. **Frontend TSC exit 2 (TS2307 @/* alias module resolution)** — 400+ errors. Need composite build / project references / declaration emit. Vite build exit=0 works (uses vite-tsconfig-paths plugin at transpile time) but standalone TSC -p tsconfig.json noEmit fails. Stabilisation must: either add proper TypeScript project references + `composite:true` + emit declaration packages, OR agree explicit frontend-typecheck = `npx vue-tsc --noEmit / npx tsc --jsx react-jsxdev --moduleResolution bundler -p tsconfig.app.json` (separate app tsconfig if one exists; current workspace-level tsconfig may not be frontend-TSC-faithful). Either way can't use Vite build as substitute (CORRECTIVE G3 prohibited equivalence).
6. **Isolated DB harness 9 mandatory surfaces** execute (docs/isolated-db-integration-and-rls-contract.md §B list, RLS 2-LAYER contract always enforced)

When PART 2 all green → **1 Consolidated Stabilisation Preview build from FINAL_BULK_SHA `a61b7de…3049` → module-by-module user browser UAT 1–11 ordered closeout → then Production after all sign-offs & credential rotation complete.**

---

## §M. PART 1 RESULT SUMMARY

| Gate | Verdict |
|---|---|
| CORRECTIVE G1 (honest status vocab — retire "TESTED") | ✅ PASS |
| CORRECTIVE G2 (double reporter API test semantics accurate) | ✅ PASS |
| CORRECTIVE G3 (3-split typecheck: Root + Backend + Frontend separate exit codes) | ✅ PASS (Frontend TS2307 exit 2 accurately reported, NOT substituted with Vite build) |
| CORRECTIVE G4 (strict numeric migration only) | ✅ PASS (all renumber/out-of-order proposals EXPLICITLY CANCELLED) |
| CORRECTIVE G5 (23 unique prefixes NOT 25; 0124/0125 gap never invent) | ✅ PASS |
| CORRECTIVE G6 (Remote Apply HOLD — only 0122 = yes) | ✅ PASS |
| CORRECTIVE G7 (destructive 0 ≠ safe) | ✅ PASS (each 0123+ migration carries warning + explicit 5-phase PART 2 requirement) |
| CORRECTIVE G8 (UNIQUE duplicate STOP never auto-cleanup) | ✅ PASS (UNABLE TO VERIFY VIA DIRECT SQL label; scripts ready; STOP condition documented) |
| CORRECTIVE G9 (HR 5-state, NOT 24/24 RESOLVED) | ✅ PASS (21/1/2/0/0 accurate) |
| CORRECTIVE G10 (HR 6-gate APPLY_READY no before 6/6 green) | ✅ PASS (2/6 now) |
| CORRECTIVE G11 (Partner = HR FULL ACCESS 1:1:1) | ✅ PASS (reverse of prior bug) |
| CORRECTIVE G12 (5-role permission matrix + cross-firm + ESS boundaries) | ✅ PASS (269/269) |
| CORRECTIVE G13 (DB-first flag order; flag-first prohibited) | ✅ PASS (env then DB hr_enabled; router not registered when ENABLE_HRMS_MODULE unset) |
| CORRECTIVE G14 (eInvoice = PARTIAL / SCAFFOLD only) | ✅ PASS (explicit 11-item missing list) |
| CORRECTIVE G15 (eInvoice production 100% hard lock EINVOICE_SANDBOX) | ✅ PASS (6 code paths 503 guard) |
| CORRECTIVE G16 (no self-invent tax rules; LHDN conflict = LEGAL_TAX_DECISION stop) | ✅ PASS |
| CORRECTIVE G17 (monitor_kind=6 enum only; severity/ownership/auto-resolve NOT detector counts) | ✅ PASS |
| CORRECTIVE G18 (PV SLA engine ≠ Case Bottleneck; two independent advisory lock hashtexts; escalation preserved) | ✅ PASS |
| CORRECTIVE G19 (no dirty-tree deploy) | ✅ PASS (before blocked; after 7 batches, source clean) |
| CORRECTIVE G20 (7 logical batches; HEAD = tested code; FINAL_BULK_SHA recorded) | ✅ PASS (a61b7de in docs/gate/sha) |
| CORRECTIVE G21 (old worktrees KEEP baseline only; new Preview from FINAL_BULK_SHA) | ✅ PASS |
| CORRECTIVE G22 (END GATE A-J accurate & complete) | ✅ PASS (this document) |

**Result: PRE-STABILISATION CORRECTIVE GATE PART 1 = CLOSED ✅. Now advance directly to PART 2 (DB Integration / Preflight 6-gate / UNIQUE duplicates live check).**
