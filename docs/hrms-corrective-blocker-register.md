# HRMS Corrective Review — Single-Source-of-Truth Blocker Register

Document: `docs/hrms-corrective-blocker-register.md`
Status: **CORRECTIVE GATE 9 REVISION (2026-08-08, Pre-Stabilisation Part 1 of 2)
Rule: Every row in this register is one blocker.
* Blocker Register is the **manually maintained single source of truth**.
* Summary counts in other documents MUST reproduce this register.
* Validation rules:
  (1) unique Blocker IDs
  (2) migration prefix 0127–0135 only
  (3) allowed Status values (CORRECTIVE GATE 9 CANONICAL status set:
      OPEN → CODE_FIX_PRESENT → AUTOMATED_EVIDENCE_PASS → DB_INTEGRATION_PASS → RESOLVED
  (4) Blocks Apply in {YES, SOFT}
  (5) every row must have Evidence column non-empty
  (6) every row must have Targeted Test, DB Requirement, RLS Requirement columns filled per CORRECTIVE GATE 9.

## Status lifecycle (CORRECTIVE GATE 9 CANONICAL):

| Status | Meaning | Counts as "resolved"? |
|--------|---------|------------------------|
| OPEN | Blocker identified, no code change or doc change attempted in working tree | NO |
| CODE_FIX_PRESENT | Candidate code/migration edits exist in working tree (diff; may or may not have passing tests | NO |
| AUTOMATED_EVIDENCE_PASS | A targeted automated test exists AND it passes (VITEST_SKIP_DB=1) | NO |
| DB_INTEGRATION_PASS | Migration UP test + destructive/data preflight all pass; plus required DB integration harness | NO |
| RESOLVED | Operator sign-off; 5 gates above all green; recorded sign-off artifact attached | YES |

Only RESOLVED counts as resolved for apply clearance.

Legend — Columns (per CORRECTIVE GATE 9):
* Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply?
|---|---|---|---|---|---|---|---|---|

## 0127 `hrms_business_events_outbox.sql` (3 blockers)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0127-01 | 0127_hrms_business_events_outbox.sql | Add COMMENT on `hr_business_events.payload` column explicitly forbidding inline PII/sensitive data (NRIC, bank account numbers, salary figures, home address, passport numbers). | OPEN | `lib/db/migrations/0127_hrms_business_events_outbox.sql` has no `COMMENT ON COLUMN hr_business_events.payload` line (grep = 0 matches). | hr-event-payload-pii-comment.unit.test.ts — CREATE TABLE; verify COMMENT exists | Apply 0127 with COMMENT (additive only, no data risk) | RLS on hr_business_events must be firm scoped; audit reads of payload | YES |
| B0127-02 | 0127_hrms_business_events_outbox.sql | App-layer event writer MUST apply PII scrub before payload INSERT. Must be wired: every `INSERT INTO hr_business_events` caller must route through a single `hrBusinessEventWriteService.writeScrubbed()` method that drops forbidden keys. | OPEN | `artifacts/api-server/src/modules/hr/events/` folder exists but no scrubbed-writer service. No grep match for `writeScrubbed` in `src/modules/hr/**/*.ts`. | hr-event-writer-pii-scrub.unit.test.ts — pass NRIC/bank payload; assert scrubbed payload INSERTED | Table row count reconciled after apply + trigger check (no direct INSERT from routes) | RLS already firm-scoped; need separate RBAC permission to INSERT event rows at all | YES |
| B0127-03 | 0127_hrms_business_events_outbox.sql | Document the event subscription seed priority numbers so operators know the intended delivery order per firm per event type. | OPEN | No inline comment in subscription DO-$$ seed block explaining priority integers. | hr-event-subscription-priority.unit.test.ts — grep priority integers; assert they are monotonically increasing per firm per event class | No data risk, documentation only | N/A | SOFT |

## 0128 `hrms_core_organisation.sql` (1 blocker)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0128-01 | 0128_hrms_core_organisation.sql | Confirm NO HR read path reaches `accounting_settings` for the 6 shared operating columns. HR must read exclusively `firm_operating_settings` + `hr_organisation_settings`. Must be provable via static import-scan regression test OR module boundary enforcement. | OPEN | `artifacts/api-server/src/routes/hr-settings.ts` still matches `getAccountingSettings` (grep non-zero). No `firmOperatingSettingsReadService` in src/modules/hr/. | hr-org-settings-boundary-eslint.unit.test.ts — forbid `*AccountingSettings*` imports from hr dir | Apply 0135 first → 0128 applies; otherwise firm_operating_settings table DNE at HR reads | RLS on hr_organisation_settings must be firm scoped (firm_id + RLS) | YES |

## 0129 `hrms_employees_core.sql` (2 blockers)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0129-01 | 0129_hrms_employees_core.sql | Add DB-level CHECK constraint on `hr_employees.employment_status` so bad enums cannot enter even if app-layer validator bypassed. | OPEN | `lib/db/migrations/0129_hrms_employees_core.sql` column `employment_status` has no CHECK constraint; app-layer validator only. | hr-employment-status-check.unit.test.ts — insert bad value; assert CHECK raises error | If existing rows contain enum outside the 8 set → ALTER TABLE ADD CHECK WILL FAIL; must run remote preflight for existing data | RLS on hr_employees firm scoped; mask NRIC on list endpoint | YES |
| B0129-02 | 0129_hrms_employees_core.sql | Document + enforce invariant: `ic_passport_no_masked` ALWAYS written masked `******-**-1234` form. Single write service must enforce mask; no route may write user-supplied value directly. | OPEN | No `hrEmployeeWriteService.createOrUpdate()` enforces mask; no unit test asserts unmasked input → stored masked output. | hr-employee-mask-on-write.unit.test.ts — insert 880101-10-1234; assert stored 880101-**-1234 | Verify existing rows (if any) already satisfy mask; otherwise migration must backfill mask | RLS policy must not expose unmasked value to ESS-only role (own row only) | YES |

## 0130 `hrms_sensitive_subtables.sql` (4 blockers)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0130-01 | 0130_hrms_sensitive_subtables.sql | Add COMMENT on EACH of 6 sensitive tables (salary/bank_accounts/identity_records/medical/disciplinary/leave_balances) explicitly documenting RBAC grant required. Partner default deny comment no longer required post Corrective Gate 11; still need table-level COMMENT documenting explicit-RBAC-grant required. | OPEN | Zero COMMENT ON TABLE statements for 6 sensitive subtables in `0130_hrms_sensitive_subtables.sql`. | hr-sensitive-table-comments.unit.test.ts — per table assert COMMENT IS NOT NULL | No data risk; COMMENT is metadata only | Each sensitive table MUST keep separate RLS + role_id=Partner with explicit row via RBAC (no blanket) | YES |
| B0130-02 | 0130_hrms_sensitive_subtables.sql | Audit: full unmasked NRIC/passport NEVER from list endpoints; ONLY dedicated GET `/api/hr-employees/:id/identity` with (a) explicit permission (b) audit write per read. | OPEN | No dedicated identity-detail endpoint; no audit writer for sensitive reads. No grep match for `auditSensitiveIdentityRead`. | hr-sensitive-read-audit.unit.test.ts — hit identity endpoint once; assert audit row written | Identity_number column NOT IN returned SELECT list of any hr_employees.list handler | RLS on identity_records restricts to role_ids with `hr_identity_records.view`; fail closed | YES |
| B0130-03 | 0130_hrms_sensitive_subtables.sql | `hr_employee_bank_accounts.account_number` cleartext. Document (i) `hr_bank_details.view` RBAC only; (ii) every read audit logged; (iii) list endpoints return last-4-masked; (iv) future pgp_sym_encrypt candidate. | OPEN | No documentation; no list-level mask-at-read service; no grep match for maskBankAccount function. | hr-bank-list-mask.unit.test.ts — full account returned only on detail endpoint; list endpoint returns last 4 | No schema change required now; just service + doc | RLS on bank_accounts gating via role_id with explicit `hr_bank_details.view`; ESS role can view own row only | YES |
| B0130-04 | 0130_hrms_sensitive_subtables.sql | Add deterministic regression test that scans 0134 seed matrix and asserts CORRECTIVE GATE 11 POST-CONDITION: Partner role MUST grant HR FULL ACCESS (same columns true as HR Admin / HR Manager for all sensitive permission codes (medical/disciplinary/salary/bank). The blocker goal was redefined by Corrective Gate 11; no longer "Partner absent". | AUTOMATED_EVIDENCE_PASS | Code edits: `0134_hrms_rbac_roles_permissions.sql` added `v_partner_role_id` SELECT + 5-col VALUES `partner_allowed=true` for all 67+ permissions. Frontend `permissions.ts` Partner Set extended symmetrically to HR Admin. Test exists + passes. | `src/__tests__/hr-role-permission-matrix.test.ts` — 269 tests; asserts Partner==Admin==Manager 1:1:1 on all rows. Test passes. | Verify when migration 0134 actually runs that `permissions` role_id=Partner rows are INSERTed with correct count (count(Partner role_id permissions) == count(Admin) per firm_id). | Permissions table must already have 0142 UNIQUE(role_id,module,action) so INSERT ON CONFLICT works; and generic RLS on permissions is firm_id scoped | SOFT |

## 0131 `hrms_reporting_employment_documents.sql` (4 blockers)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0131-01 | 0131_hrms_reporting_employment_documents.sql | Switch `hr_reporting_lines.reporting_manager_employee_id` FK from `ON DELETE CASCADE` → `ON DELETE SET NULL`. | OPEN | Current FK line in migration = CASCADE (manual inspection). | hr-reporting-fk-setnull.unit.test.ts — hard-delete manager row; verify reporting_lines.reporting_manager_employee_id IS NULL (not whole row deleted) | Must not have orphan reporting rows; remote preflight for any FK-violating reporting_lines rows before apply | N/A | YES |
| B0131-02 | 0131_hrms_reporting_employment_documents.sql | `hr_documents.storage_path` must follow convention `firms/{firm_id}/hr/employees/{employee_id}/{category}/{year}/{month}/{uuid}.{ext}`. Document with column COMMENT; single writer enforces path convention regex. | OPEN | No COMMENT on hr_documents.storage_path; no `buildHrDocStoragePath()` builder; no assertion regex. | hr-doc-storage-path.unit.test.ts — upload document; assert storage_path matches the regex exactly | Rows with existing storage_path from any prior dev apply MUST be updated or they'll violate the convention on read checks | RLS on hr_documents: employee_id matched to viewer unless manager/admin/partner | YES |
| B0131-03 | 0131_hrms_reporting_employment_documents.sql | `hr_documents.employee_id` FK semantics ambiguous. Split into employee-specific-document CASCADE vs firm-policy-doc SET NULL; OR add doc_category FK. Document 2 semantics. | OPEN | Single `employee_id` FK with generic `ON DELETE SET NULL`; no semantic split column. | hr-doc-fk-semantics-split.unit.test.ts — assert 2 distinct paths per category | Delete of employee must not wipe firm-level policies | RLS: Firm policy docs readable by ALL firm HR roles; employee docs only self + HR | SOFT |
| B0131-04 | 0131_hrms_reporting_employment_documents.sql | `file_sha256` computed and verified on upload/download; signed-URL cannot be issued unless sha256 matches row. | OPEN | No upload/download service; no `issueSignedHrDocUrl()` that checks sha256. | hr-doc-sha256-integrity.unit.test.ts — tamper with bytes; assert signed URL rejected | Existing rows need sha256 backfilled if they have storage_path set | RLS already firm scoped; signed URL must include firm_id in path | YES |

## 0132 `hrms_memberships_feature_flags.sql` (1 blocker)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0132-01 | 0132_hrms_memberships_feature_flags.sql | Change booleans `hr_attendance_enabled`, `hr_claims_enabled`, `hr_leave_enabled`, `hr_documents_enabled`, `hr_self_service_enabled` DEFAULT from `true` → `false` so each firm explicitly enables. | OPEN | `0132_hrms_memberships_feature_flags.sql` CREATE TABLE matches `_enabled DEFAULT true` multiple grep hits. | hr-feature-flag-default-false.unit.test.ts — insert new row without columns; assert 5 flags false | If apply already happened somewhere (dev), need explicit UPDATE to flip existing rows already default true to desired post-gate state | RLS on memberships + feature_flags firm_id scoped always | YES |

## 0133 `hrms_approval_subsystem.sql` (3 blockers)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0133-01 | 0133_hrms_approval_subsystem.sql | Verify user before INSERT/UPDATE `hr_approval_process_definitions.default_final_approver_user_id` is active Partner at firm_id; fail closed if not. | OPEN | No such service guard; no grep match for `validatePartnerAtFirm` in approval-create routes. | hr-approval-final-approver-is-partner.unit.test.ts — pass non-Partner user_id; assert 400 | Partner existence must be verified against `firm_users` join `roles` WHERE name = 'Partner' per firm. Not just any user. | RLS approval definitions firm scoped; partner_id must belong to same firm | YES |
| B0133-02 | 0133_hrms_approval_subsystem.sql | Delegation creation must enforce: (i) delegator != delegate, (ii) no 2-cycle reverse (B→A if A→B active), (iii) no N-cycle via BFS across firm_id's active delegations. | OPEN | No delegation cycle validator; no `hrDelegationGraph.hasCycle()` function in approvals module. | hr-delegation-cycle-check.unit.test.ts — A→B then B→A fails; 3-node cycle A→B→C→A fails | Cycle check runs inside single DB tx so concurrent inserts protected by advisory lock | Delegations firm_id scoped + delegator_id scoped to self | YES |
| B0133-03 | 0133_hrms_approval_subsystem.sql | `submission_payload jsonb` MUST NOT inline salary/NRIC/bank. Single payload builder allow-lists permitted keys only (refs; id fields). | OPEN | No allow-list builder for submission_payload; routes accept arbitrary JSON. | hr-approval-payload-allowlist.unit.test.ts — include "salary_amount" in payload; assert 400 strip. | N/A (app-layer only) | RLS on approval_requests rows must not include payload for ordinary employee ESS viewer who is neither submitter nor approver chain | YES |

## 0134 `hrms_rbac_roles_permissions.sql` (2 blockers)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0134-01 | 0134_hrms_rbac_roles_permissions.sql | CORRECTIVE GATE 11 REVISED. Post Gate 11 — HR Admin == HR Manager == Partner on all HR permissions. Confirm Admin role DOES have `hr_salary.view` + `hr_salary.create` + full payroll + terminate + settings manage access; no "Admin cannot see salary data" ambiguity. | AUTOMATED_EVIDENCE_PASS | `0134_hrms_rbac_roles_permissions.sql` VALUES table columns `admin_allowed=true` on hr_salary.view/create; `hr_payroll.lock/reverse`; `hr_employee.terminate`; `hr_settings.manage_organisation`. Verified by tests. | `hr-role-permission-matrix.test.ts` 67 FULL ACCESS tests + Admin==Manager 1:1 symmetry test + Partner==Admin symmetry test. All pass. | permissions seed after apply count per firm: HR Admin role rows count MUST equal HR Manager role rows count. | Permissions table UNIQUE(role_id,module,action) (migration 0142). Generic RLS on permissions firm scoped. | SOFT |
| B0134-02 | 0134_hrms_rbac_roles_permissions.sql | Canonicalize permission code naming between Corrective dot form (`hr.salary.view`) vs seeds (`hr_salary` + action column separate) vs frontend fallback colon/dot hybrid. Single canonical mapping + deprecation. | OPEN | Grep across workspace: mix of `hr_salary:view` / `hr.salary.view` / `hr_salary.view` + separate (module,action) tuple. No central mapping file. | hr-permission-code-normalize.unit.test.ts — 6 form variants → 1 canonical code | N/A (pure mapping) | N/A | YES |

## 0135 `firm_operating_settings.sql` (Decision A2 split) (4 blockers)

| Blocker ID | Migration File | Issue | Status | Exact Code/Migration Evidence | Targeted Test | DB Requirement | RLS Requirement | Blocks Apply? |
|---|---|---|---|---|---|---|---|---|
| B0135-01 | 0135_firm_operating_settings.sql | Shared-settings double-write service on edit: UPDATE firm_operating_settings AND legacy accounting_settings (6 mirrored cols) atomically in 1 tx during Step-1 cutover. | OPEN | No double-write service; no grep match for `firmOperatingSettingsDoubleWriteService`. | hr-shared-settings-double-write.unit.test.ts — edit 1 setting; assert BOTH tables rows UPDATED | accounting_settings 6 legacy columns must remain WRITE-compatible with the double-write schema (no removal in same PR) | Firm scoped; both target tables RLS firm_id bound | YES |
| B0135-02 | 0135_firm_operating_settings.sql | Static-import regression test: `src/modules/hr/**` AND `src/routes/hr*.ts` MUST NOT `import *AccountingSettings*`; MUST import `firmOperatingSettingsReadService`. | OPEN | Current routes match `getAccountingSettings` in `src/routes/hr-settings.ts` grep. | hr-no-accounting-settings-import.lint-test.unit.test.ts — ESLint or grep script; fail on forbidden import paths | N/A (pure module boundary) | N/A | YES |
| B0135-03 | 0135_firm_operating_settings.sql | Legacy mirrored 6 columns in accounting_settings will be retained through Step-2/3 cutover window. Drop ONLY in separate LATER migration (not 0135 apply PR). Explicit sign-off artifact to prevent accidental wipe. | OPEN | No separate future migration created; no drop-legacy-columns documented plan. | hr-legacy-columns-not-dropped-in-0135.unit.test.ts — grep 0135 ALTER DROP COLUMN on accounting_settings; assert zero hits | 0135 must not have any `ALTER TABLE accounting_settings DROP COLUMN` statements | N/A | SOFT |
| B0135-04 | 0135_firm_operating_settings.sql | `working_hours.break_start/end` default 13:00–14:00 hardcoded. Ratify Malaysia product default OR allow NULL (no mandated break) default = NULL. Sign-off required; no backflip post all-firm seed. | OPEN | No sign-off artifact; migration CREATE TYPE / DEFAULT still hardcoded. | hr-working-hours-defaults-signoff.unit.test.ts — either (i) default NULL or (ii) sign-off file exists + default 13:00–14:00 | If switch default to NULL, any already-applied firm rows need UPDATE to NULL to match new canonical intent | N/A | SOFT |

---

## Summary — CORRECTIVE GATE 9 Canonical Status (rows 24 total; not "24/24 RESOLVED")

Status counts (canonical; validator must match):
```
OPEN                      = 21  rows
CODE_FIX_PRESENT          =  0  rows
AUTOMATED_EVIDENCE_PASS   =  2  rows (B0130-04, B0134-01)
DB_INTEGRATION_PASS       =  0  rows (Remote Apply not done; PART 2 gate required)
RESOLVED                  =  0  rows (no blocker signed off yet)
─────────────────────────────────────────────
TOTAL                     = 24 rows
```

Classification counts:
```
Blocks Apply = YES   = 18 rows
Blocks Apply = SOFT  =  6 rows (B0127-03, B0130-04, B0131-03, B0133-01 sign-off categorised YES, see row B0134-01=SOFT / B0135-03 SOFT / B0135-04 SOFT)
```

### CORRECTIVE GATE 10 — HRMS 0127–0135 Remote Apply 6-Gate Readiness

| Gate (per Corrective G10) | Current result | Pass? |
|---------------------------|----------------|-------|
| (1) 24 blockers = RESOLVED | 0/24 — 2 AUTOMATED_EVIDENCE_PASS; 21 OPEN | ❌ NO |
| (2) migration UP tests pass | NOT RUN (Isolated DB harness not executed) | ❌ NO |
| (3) dependency check PASS | validate-migration-sequence PASS (numeric order + HR block preserved) | ✅ (static only) |
| (4) RLS DB integration pass | NOT RUN | ❌ NO |
| (5) destructive/data preflight PASS | NOT RUN (UNIQUE + FK + CHECK widening remote read-only preflight not executed yet; Part 2) | ❌ NO |
| (6) HR permission matrix PASS | `hr-role-permission-matrix.test.ts` 269/269 tests passed + `hr-settings-boundary.test.ts` 10/10 | ✅ (automated unit) |

Remote Apply 0127–0135 = **NO**. All 6 gates must green before apply.

Previous wording "HR Migration Gate 2/6 partial" is retained; NO row marked RESOLVED before Part 2 integration harnesses run.
