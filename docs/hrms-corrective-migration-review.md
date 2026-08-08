# HRMS Corrective Review — Migration 0127–0134 Audit

Document: `docs/hrms-corrective-migration-review.md`
Status: **Draft Audit — NOT YET APPROVED FOR APPLY**
Applies To: `lib/db/migrations/0127_*` … `0134_*` (8 files)
Rule: Review 100% complete and signed off → THEN and ONLY THEN may any migration be applied.

---

## Common Review Framework (12 checks per migration)

Every migration file is evaluated against the following 12 mandatory checklist items:

| # | Check | Pass Criteria |
|---|-------|---------------|
| 1 | firm_id present | Every HR table has `firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE` (or FK equiv). Junction tables must include it. |
| 2 | RLS immediate | `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;` appears in the same migration file immediately after the table is created — never deferred to a later migration. Policy tenant_isolation is created idempotently. |
| 3 | Sensitive tables stricter RLS | Sensitive subtables (salary/bank/identity/medical/disciplinary/leave_balance) have separate, tighter policies beyond basic firm_id. Partner default-deny note must be present. |
| 4 | ON DELETE correct | Employee-referencing FKs use `ON DELETE SET NULL` for non-dependent context (e.g., head_of_dept → NULL on employee leave). Sensitive subtables use `ON DELETE CASCADE` because they cannot exist without their employee. `hr_event_delivery_attempts.event_id → hr_business_events CASCADE`. |
| 5 | No hard delete on employee | Migration does not allow hard delete. The DELETE router handler returns 405. There is no CASCADE to employee from a non-sensitive parent that would wipe it (e.g., department → employee FK is SET NULL, not CASCADE). |
| 6 | Firm-scoped UNIQUE | All candidate unique constraints (code, employee_no, etc.) are prefixed with `firm_id`. Global uniqueness across firms must never be required (unless it is a globally shared lookup, which shouldn't live in HR tables). |
| 7 | Final Approver limited to active firm partner | `hr_approval_process_definitions.default_final_approver_user_id REFERENCES users(id) ON DELETE SET NULL` — there must be no DB-level auto-resolution to "any active Partner". App-layer check enforces firm scope + active partnership. |
| 8 | Delegation circular free | `hr_approval_delegations` has `scope_scope`, `valid_from`, `valid_to`. Application service must validate delegator ≠ delegate and no cycle. Database alone cannot prevent cycle; app guard is mandatory. |
| 9 | Outbox unique idempotency key | `hr_business_events` has `UNIQUE (firm_id, idempotency_key)` = migration 0127 Check ✅. |
| 10 | Event payload no sensitive data in event body | Migration 0127 `payload jsonb` is generic; app-layer service must strip NRIC, bank account numbers, salary figures. The schema allows arbitrary JSON; schema-level check is NOT enough. App-layer guard is MANDATORY and reviewed separately. |
| 11 | Production-safe backfill | No `DROP COLUMN` / `DROP TABLE` in the forward path. Backfills use `INSERT ... SELECT ... ON CONFLICT DO NOTHING` — never overwrite newer data. Loops over firms are idempotent per-firm. |
| 12 | Lock timeout / transaction | Every backfill that loops over firms should be wrapped in single transaction at connection pool default; for large batch (>1k firms): must use explicit batching or advisory lock pattern. For current small production: acceptable as-is. |

---

## Per-Migration Detailed Review

### 0127: `hrms_business_events_outbox.sql`
File: `lib/db/migrations/0127_hrms_business_events_outbox.sql`
**Approved?: ⚠️ CONDITIONAL (see corrections)**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | All 3 tables: `hr_business_events.firm_id NOT NULL`, `hr_event_subscriptions.firm_id NOT NULL`, `hr_event_delivery_attempts` inherits via event_id + policy. |
| 2 | RLS immediate | ✅ PASS | All 3 tables have `ENABLE RLS` / `FORCE RLS` in same file. Idempotent DO $$ blocks re-create tenant_isolation policy. |
| 3 | Sensitive tables stricter | ⚠️ MISSING | `hr_business_events.payload` can contain arbitrary JSONB. Check #10 below: App-layer MUST never put salary/bank/NRIC into payload envelope. Schema-level comment is present but policy is needed. Recommendation: Add comment on payload column to reinforce + add check constraint for metadata only if we want to enforce at schema. For now: CORRECTION = add application-level payload redactor + document as correction. |
| 4 | ON DELETE correct | ✅ PASS | `event_delivery_attempts.event_id → hr_business_events(id) CASCADE`. `hr_business_events.firm_id → firms CASCADE`. sub: correct. |
| 5 | No hard delete on employee | N/A | No employee tables here. |
| 6 | Firm-scoped UNIQUE | ✅ PASS | `uq_hr_events_idempotency_firm (firm_id, idempotency_key)`. `uq_hr_event_subs_firm_sub_evt (firm_id, subscriber, event_type)`. |
| 7 | Final Approver limited | N/A | Outbox only. |
| 8 | Delegation circular | N/A | Outbox only. |
| 9 | Outbox unique idempotency | ✅ PASS | uq_hr_events_idempotency_firm present. `idempotency_key text NOT NULL`. |
| 10 | Event payload no sensitive data | ⚠️ APP-LEVEL GUARD REQUIRED | Schema allows arbitrary JSONB. App-layer service writing events MUST filter: no NRIC, no salary figures, no bank account numbers, no passport numbers, no home addresses in payload. Correction = audit every `INSERT INTO hr_business_events` caller; strip sensitive payload before write; write only employee_id + amount_ref (lookup) rather than raw amounts. |
| 11 | Production-safe backfill | ✅ PASS | Subscriptions seed uses `INSERT … SELECT … WHERE NOT EXISTS`. No overwrites. |
| 12 | Lock timeout / transaction | ✅ PASS | Subscriptions seed is one cross-join per firm. Production firm count is low; acceptable. |

**Required corrections before APPROVE:**
- [ ] 0127-C1: Add COMMENT on `hr_business_events.payload` forbidding PII/sensitive data inline.
- [ ] 0127-C2: Document that app-layer event writer MUST apply PII scrub before payload insert.
- [ ] 0127-C3: Event subscription seed uses priority numbers documented = OK (no correction).

---

### 0128: `hrms_core_organisation.sql`
File: `lib/db/migrations/0128_hrms_core_organisation.sql`
**Approved?: ⚠️ CONDITIONAL — Decision A2 neutral table now exists (0135) but HR read-path cutover NOT YET wired**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | hr_branches, hr_departments, hr_positions, hr_organisation_settings all have firm_id. |
| 2 | RLS immediate | ✅ PASS | Each table has ENABLE RLS + FORCE in same file. Policies firm-scoped via GUC + OR founder. |
| 3 | Sensitive tables stricter | N/A | No sensitive subtables here (HR org masterdata only). |
| 4 | ON DELETE correct | ✅ PASS | branch_id/department_id FKs all SET NULL. head_employee_id → SET NULL. reports_to_position_id → SET NULL. Correct. |
| 5 | No hard delete on employee | N/A | No employee table here. |
| 6 | Firm-scoped UNIQUE | ✅ PASS | uq_hr_branches_firm_code, uq_hr_departments_firm_code, uq_hr_positions_firm_code all include firm_id. |
| 7 | Final Approver limited | N/A | Approval subsystem not here. |
| 8 | Delegation circular | N/A | No delegation. |
| 9 | Outbox idempotency | N/A | No outbox here. |
| 10 | Event payload | N/A | No event here. |
| 11 | Production-safe backfill | ✅ PASS | No destructive changes. Pure CREATE TABLE IF NOT EXISTS. |
| 12 | Lock timeout / transaction | ✅ PASS | No loops > acceptable. |

**Required corrections before APPROVE:**
- [x] 0128-C1 (CRITICAL Decision A2): Introduce neutral `firm_operating_settings(firm_id PK, timezone, working_days jsonb, working_hours jsonb, public_holiday_region text, holiday_calendar jsonb, weekend_rules jsonb)` with idempotent `INSERT … SELECT … FROM accounting_settings ON CONFLICT DO NOTHING` backfill. **→ Implemented as Migration 0135 (LOCAL DRAFT, NOT APPLIED).**
- [ ] 0128-C2: Confirm NO path exists from HR read service to `accounting_settings` columns; HR must read only `firm_operating_settings`. **→ 0135 exists, but HR service layer cutover NOT yet wired (no HR routes import firm_operating_settings service today; current HR middleware still references accounting_settings indirectly — MUST be validated in M2a wiring PR).**
- [x] 0128-C3: RLS + FORCE on new table immediately in same file (firm_id = GUC pattern + grants to app_user). **→ Covered in 0135.**
- [x] 0128-C4: Write cutover procedure for Accounting read path: Accounting settings table retains its columns temporarily, reads new shared table first, falls back to legacy if new is empty, reads from new only once cutover complete, then (later) drops duplicated timezone/weekend cols from accounting_settings. No bidirectional triggers. **→ Documented inline in 0135 (5-step cutover + rollback).**
- [x] 0128-C5: hr_organisation_settings DEFAULT values validated = `Asia/Kuala_Lumpur` timezone default OK per Malaysia rules ✅.

**0128 Verdict change (2026-08-06 corrective checkpoint):** Prior verdict = ❌ NOT APPROVED because firm_operating_settings did not exist. New verdict = ⚠️ CONDITIONAL because 0135 now exists as local draft; remaining blocker is the actual HR service cutover wiring (0128-C2 above) + sign-off that 0135 itself passes its own 12-check review (see below).

---

### 0129: `hrms_employees_core.sql`
File: `lib/db/migrations/0129_hrms_employees_core.sql`
**Approved?: ⚠️ CONDITIONAL**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | hr_employees.firm_id NOT NULL REFERENCES firms CASCADE. |
| 2 | RLS immediate | ✅ PASS | ENABLE + FORCE in same file, tenant_isolation policy. |
| 3 | Sensitive tables stricter | ⚠️ WARN | Core `hr_employees` table stores `ic_passport_no_masked` (which IS masked = OK). For unmasked NRIC, it lives in `hr_employee_identity_records` (migration 0130) → Correct separation. `date_of_birth` is on core; may be considered quasi-sensitive by some frameworks. Recommendation: Consider moving DOB to sensitive in a future revision, but for now acceptable because it's on masked profile. |
| 4 | ON DELETE correct | ✅ PASS | branch/department/position/reporting_manager = SET NULL. linked_user_id = SET NULL (employee record stays if user unlinked). Correct. |
| 5 | No hard delete on employee | ✅ PASS | No DELETE trigger. App route handler: DELETE catch-all returns 405 HR_METHOD_NOT_ALLOWED. |
| 6 | Firm-scoped UNIQUE | ✅ PASS | uq_hr_employees_firm_employee_no (firm_id, employee_no). uq_hr_employees_firm_user_id (firm_id, linked_user_id) WHERE linked_user_id IS NOT NULL. Both firm-scoped. |
| 7 | Final Approver limited | N/A | No approvals here. |
| 8 | Delegation circular | N/A | No delegation here. |
| 9 | Outbox idempotency | N/A | Outbox migration 0127 already present. Status transition application writes to outbox. |
| 10 | Event payload | N/A | App-level concern (see 0127). |
| 11 | Production-safe backfill | ✅ PASS | No backfill here. Schema-only. |
| 12 | Lock timeout / transaction | ✅ PASS | No large batches. |

**Required corrections before APPROVE:**
- [ ] 0129-C1: `employment_status CHECK` absent from schema. Recommend adding: CHECK (employment_status IN ('draft','probation','active','notice_period','inactive_handover','terminated','reactivated','suspended')) so bad rows can't enter. (Currently validated at app; add DB-level belt.)
- [ ] 0129-C2: Confirm `ic_passport_no_masked` column is ALWAYS written masked, never full NRIC. App-layer must enforce. Document this invariant.

---

### 0130: `hrms_sensitive_subtables.sql`
File: `lib/db/migrations/0130_hrms_sensitive_subtables.sql`
**Approved?: ⚠️ CONDITIONAL**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | All 6 subtables (salaries, bank_accounts, identity_records, medical_records, disciplinary_records, leave_balances) have firm_id NOT NULL REFERENCES firms CASCADE. |
| 2 | RLS immediate | ✅ PASS | All 6 tables have ENABLE RLS + FORCE in same file immediately after CREATE. |
| 3 | Sensitive tables stricter | ❌ FAIL | All 6 subtables share identical generic tenant_isolation policy. Per Corrective: sensitive subtables (medical/disciplinary/salary/bank) MUST have DENY for Partner by default and require explicit per-user `hr_medical_document.view` RBAC. The policy currently says "founder OR firm context matches". This does NOT add RBAC check. CORRECTION: Add RLS policy `AND current_setting('app.rbac_hr_sensitive','t') = 'true'` OR move enforcement entirely to application (which it already is via requirePermission). Given that RBAC happens at API layer (requirePermission) before query, this is considered acceptable if AND ONLY IF service layer never builds queries to sensitive tables without checking permission. Current route pattern: requirePermission("hr_salary","view") before sensitive DB read → ACCEPTABLE. Document as CORRECTION = do NOT add Partner to sensitive perms by default in migration 0134 RBAC seeds (verify). |
| 4 | ON DELETE correct | ✅ PASS | employee_id → CASCADE on all 6 subtables. If employee is deleted via status flow (rare), sensitive rows disappear. Correct. |
| 5 | No hard delete on employee | ✅ PASS | As above: employee DELETE route 405. |
| 6 | Firm-scoped UNIQUE | ✅ PASS | uq_hr_salaries_emp_type_from (firm_id, employee_id, salary_type, effective_from). uq_hr_identity_emp_type_no. uq_hr_disciplinary_firm_case. uq_hr_leave_balance_emp_type_year. All firm-scoped. |
| 7 | Final Approver | N/A | Not here. |
| 8 | Delegation circular | N/A | Not here. |
| 9 | Outbox idempotency | N/A | Not here. |
| 10 | Event payload | N/A | App-layer. |
| 11 | Production-safe backfill | ✅ PASS | No destructive ALTERs; DO $$ block loops over firms with NULL body. |
| 12 | Lock timeout | ✅ PASS | DO $$ no-ops per firm = fine for now; add batching if >1k firms (later). |

**Required corrections before APPROVE:**
- [ ] 0130-C1 (CRITICAL §Three): Audit Migration 0134's RBAC seed matrix — CONFIRM Partner role is NOT in the list of receivers of `hr_medical_records.*` and `hr_disciplinary.*` perms. Currently 0134 seeds HR Manager/Admin/Employee only. ✅ Already satisfied (see 0134 review). But the sensitive table-level RLS policy does not encode "partner default deny". Consider: add a COMMENT on each sensitive table documenting the explicit-RBAC-only rule.
- [ ] 0130-C2: `hr_employee_identity_records.identity_number` stores full NRIC/passport. App-layer MUST: never return full value without explicit permission; must mask before list responses; and must audit sensitive reads.
- [ ] 0130-C3 `hr_employee_bank_accounts.account_number` is cleartext. In future: consider pgp_sym_encrypt. For current phase: acceptable if access gated via `hr_bank_details.view` RBAC + audit reads. Document.
- [ ] 0130-C4 `numeric` audit: salary.amount numeric(19,4) ✅, leave_balance numeric(10,2) ✅, no numeric(18,2) or numeric(15,4) found ✅. No corrective needed for types.

---

### 0131: `hrms_reporting_employment_documents.sql`
File: `lib/db/migrations/0131_hrms_reporting_employment_documents.sql`
**Approved?: ⚠️ CONDITIONAL**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | hr_reporting_lines, hr_employment_records, hr_documents all have firm_id. |
| 2 | RLS immediate | ✅ PASS | Each has ENABLE/FORCE/POLICY in same file. |
| 3 | Sensitive stricter | ⚠️ CONDITION | hr_documents has partner_view_allowed boolean column (default false) → correct default deny for partner. Good pattern. For medical/disciplinary doc category: service must re-check category-level perms even if row has view bits. |
| 4 | ON DELETE correct | ✅ PASS | employee_id = CASCADE on reporting lines/records; SET NULL on hr_documents (allow docs even after employee unlinked? Actually hr_documents.employee_id SET NULL seems strange; should probably be CASCADE for employee-specific docs. Consider CORRECTION: ALTER to CASCADE if it's employee-attached docs. Keep SET NULL only for firm-level policy docs that outlive an employee. |
| 5 | No hard delete employee | N/A | N/A |
| 6 | Firm-scoped UNIQUE | ✅ PASS | uq_hr_reporting_primary (firm_id, employee_id, effective_from) WHERE is_primary = true. |
| 7 | Final Approver limited | N/A | Here employment_records.approved_by_user_id FK → users SET NULL, not auto-partner. App must validate. |
| 8 | Delegation circular | N/A | No delegation. |
| 9 | Outbox idempotency | N/A | N/A. |
| 10 | Event payload | N/A | N/A. |
| 11 | Production-safe backfill | ✅ PASS | Schema only. |
| 12 | Lock timeout | ✅ PASS | No loops. |

**Required corrections before APPROVE:**
- [ ] 0131-C1: hr_reporting_lines FK `reporting_manager_employee_id → hr_employees(id) ON DELETE CASCADE` = if manager row is deleted, the reporting link is CASCADE-deleted. This is actually OK because the manager row should never be hard-deleted (405 handler). But the double-CASCADE to employee on both sides is risky. Consider CORRECTION: reporting_manager_employee_id ON DELETE SET NULL instead. So if manager entity is purged (shouldn't happen but future-proof), employee keeps row but manager becomes null.
- [ ] 0131-C2: hr_documents.storage_path must follow Decision C1 path convention `firms/{firm_id}/hr/employees/{employee_id}/{category}/{year}/{month}/{uuid}.{ext}`. Application enforce this; schema stores the produced string; document it.
- [ ] 0131-C3: hr_documents `file_sha256` present = good for integrity.
- [ ] 0131-C4: `hr_employment_records.salary_amount_old / salary_amount_new numeric(19,4)` ✅. `salary_currency` default MYR ✅.

---

### 0132: `hrms_memberships_feature_flags.sql`
File: `lib/db/migrations/0132_hrms_memberships_feature_flags.sql`
**Approved?: ✅ PASS with minor note**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | 3 tables all have firm_id PK or NOT NULL. hr_firm_feature_flags.firm_id PK REFERENCES firms. |
| 2 | RLS immediate | ✅ PASS | All 3 tables have ENABLE/FORCE/POLICY in same file. |
| 3 | Sensitive stricter | N/A | Feature flags + memberships are not direct sensitive. |
| 4 | ON DELETE correct | ✅ PASS | user_id/employee_id CASCADE on membership. hr_enabled flags CASCADE on firm delete. position_authorizations.employee_id CASCADE. employee_id FK to HR employees CASCADE. user_id on membership CASCADE (if user deleted, membership row removed. But employee stays. OK). |
| 5 | No hard delete employee | ✅ PASS | No route. |
| 6 | Firm-scoped UNIQUE | ✅ PASS | uq_hr_membership_firm_user + uq_hr_membership_firm_employee BOTH have partial WHERE is_active = true. Correct pattern for soft links. |
| 7 | Final Approver limited | N/A | No approvals. |
| 8 | Delegation circular | N/A | No delegation. |
| 9 | Outbox idempotency | N/A | N/A. |
| 10 | Event payload | N/A | N/A. |
| 11 | Production-safe backfill | ✅ PASS | `INSERT INTO hr_firm_feature_flags (firm_id, ...) SELECT id ... FROM firms ON CONFLICT (firm_id) DO NOTHING`. Correct idempotent backfill pattern. Never overwrites existing firm settings. |
| 12 | Lock timeout | ✅ PASS | Single INSERT-SELECT. Fast. |

**Required corrections before APPROVE:**
- [ ] 0132-C1: `hr_firm_feature_flags.hr_enabled DEFAULT false`. `hr_claims_enabled DEFAULT true` — but claims is M2c Self-Service. Should default false unless firm explicitly enables. CORRECTION: change default for hr_attendance_enabled, hr_claims_enabled, hr_leave_enabled, hr_documents_enabled, hr_self_service_enabled to DEFAULT false. Firm explicitly enables each in M2b/M2c.
- [ ] 0132-C2: Confirm Decision G1 dual flags = env ENABLE_HRMS_MODULE AND this table's hr_enabled. ✅ Confirmed via requireHRModuleEnabled middleware.

---

### 0133: `hrms_approval_subsystem.sql`
File: `lib/db/migrations/0133_hrms_approval_subsystem.sql`
**Approved?: ⚠️ CONDITIONAL**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | All 5 tables: process_definitions, approval_requests, request_steps, delegations, action_logs have firm_id NOT NULL REFERENCES firms CASCADE. |
| 2 | RLS immediate | ✅ PASS | All 5 tables have ENABLE/FORCE/POLICY in same file. |
| 3 | Sensitive stricter | N/A | Approval are operational, not direct sensitive. Submission payload could contain sensitive → Check #10 equivalent here. |
| 4 | ON DELETE correct | ⚠️ WARN | `approval_requests.process_definition_id → hr_approval_process_definitions RESTRICT`. Good: prevent deletion of active process def if pending requests exist. request_steps.request_id → CASCADE. action_logs: SET NULL for step_id + request_id — audit trail outlives request, acceptable. |
| 5 | No hard delete employee | N/A | N/A. |
| 6 | Firm-scoped UNIQUE | ✅ PASS | uq_hr_approval_proc_firm_code_version, uq_hr_approval_requests_firm_no, uq_hr_approval_requests_aggregate (partial), uq_hr_approval_steps_req_step all firm scoped. |
| 7 | Final Approver limited to active firm partner | ⚠️ APP-LAYER | Schema: `default_final_approver_user_id REFERENCES users(id) ON DELETE SET NULL`. DB does not validate "is this user an active Partner in this firm?". Application MUST validate this before writing, and on read. CORRECTION REQUIRED: explicit service layer check. |
| 8 | Delegation circular free | ⚠️ APP-LAYER CHECK REQUIRED | `hr_approval_delegations` has `delegator_user_id` and `delegate_user_id`. No DB cycle check. App-layer when inserting delegation MUST: (a) delegator ≠ delegate; (b) no chain exists A→B, B→A (2-cycle); (c) no N-step cycle. Add validation in delegation create service. |
| 9 | Outbox idempotency | N/A | Not outbox. |
| 10 | Event payload in submission_payload jsonb | ⚠️ APP-LAYER REDACT REQUIRED | `submission_payload jsonb DEFAULT '{}'`. Application must NOT inline salary/NRIC/bank; use refs only. |
| 11 | Production-safe backfill | ✅ PASS | No destructive. Pure CREATE + RLS + seed none. |
| 12 | Lock timeout | ✅ PASS | No batches. |

**Required corrections before APPROVE:**
- [ ] 0133-C1 (Check 7): Service guard on `hr_approval_process_definitions.default_final_approver_user_id` = verify target user has active partnership row at that firm_id.
- [ ] 0133-C2 (Check 8): Delegation creation guard = delegator != delegate AND no reverse delegation exists (A→B already active, reject B→A AND reject A→B if duplicate active). Fail closed.
- [ ] 0133-C3 `hr_approval_request_steps.assigned_approver_user_ids integer[]` = app must validate each id against firm users list.

---

### 0134: `hrms_rbac_roles_permissions.sql`
File: `lib/db/migrations/0134_hrms_rbac_roles_permissions.sql`
**Approved?: ⚠️ CONDITIONAL**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | Uses existing `roles(firm_id)` + `permissions(role_id)` schema from migration 0003. Role inserts have `firm_id = v_firm.id`. |
| 2 | RLS immediate | N/A | RLS on roles/permissions is from migration 0003; assumed already present. |
| 3 | Sensitive tables stricter | ⚠️ VERIFY MATRIX | Permission matrix (p.34–153 of migration): `hr_medical_records.view/edit → manager_allowed=false, admin_allowed=false, emp_allowed=false` ✅ (self-view is separate self_view + self_upload on sensitive). `hr_disciplinary.view → manager_allowed=true`. Corrective §Three explicitly says Partner has no auto-sensitive grant. Migration doesn't touch Partner role. ✅. But check HR Manager scope: `hr_disciplinary.view/create/close` granted. If HR Manager is a trusted operational role = acceptable. |
| 4 | ON DELETE correct | N/A | Standard roles table. |
| 5 | No hard delete employee | N/A | N/A. |
| 6 | Firm-scoped UNIQUE | N/A via migration 0003 | Existing roles table has unique (firm_id, name). Migration insert uses CONFLICT correctly. |
| 7 | Final Approver limited | N/A | Not here. |
| 8 | Delegation circular | N/A | Not here. |
| 9 | Outbox idempotency | N/A | Not here. |
| 10 | Event payload | N/A | N/A. |
| 11 | Production-safe backfill | ✅ PASS | Uses FOR v_firm loop + INSERT ON CONFLICT DO NOTHING for roles + INSERT ON CONFLICT DO UPDATE SET allowed = EXCLUDED.allowed for permissions. `ON CONFLICT (role_id, module, action) DO UPDATE` ensures if migration re-runs after manual permission edit, it OVERWRITES the permission. This is correct for "system roles" (is_system_role = true) because permissions for HR Manager / Admin / Employee are source-of-truth defined here. No user-granted perm will be touched because those are on different role rows (non-system roles). Good. |
| 12 | Lock timeout | ⚠️ WARNING | DO $$ block with nested FOR loop per firm per permission. For each firm, 58 permission codes × 3 roles = 174 inserts max. Firm count < 100 currently: fine. For >1k firms: unnest + bulk insert pattern required. Acceptable. |

**Required corrections before APPROVE:**
- [ ] 0134-C1 (CRITICAL §Three): CONFIRM this migration does NOT INSERT/UPDATE any rows where role name = 'Partner'. Verified reading migration code: INSERT roles with name IN ('HR Manager', 'HR Admin', 'HR Employee'). Partner untouched. ✅.
- [ ] 0134-C2 (§Three sensitive permissions): Check `hr_salary.*` permissions: Manager has view/create/adjustment_approve. Admin has NO salary.view? Wait permission matrix line 48-51:
  ```
  ('hr_salary','view',true,false,false),
  ('hr_salary','create',true,false,false),
  ('hr_salary','adjustment_approve',true,false,false),
  ```
  = Admin role cannot see salary data. This may be too restrictive for real HR Admin (typically they maintain salary records but cannot approve adjustments). Decision: Keep as-is per current 0134; this MUST be ratified at M2a sign-off. If HR Admin needs salary view, add only `hr_salary.view` to admin_allowed column, keep edit false.
- [ ] 0134-C3: `hr_payroll.*` lines 98-107: 9 operations (calculate/submit/approve/lock/reverse/adjust/request_payment/supplementary_create + view) ALL require manager role. Admin role = no payroll access. This is reasonable. Keep.
- [ ] 0134-C4: `hr_approval.override` manager only. Admin → no override. Good.
- [ ] 0134-C5 (Check 7 partner): Approval system "final approver" cannot be derived from role name (per §Three). Migration 0134 does not encode that rule. OK because enforcement is application-level (per process_definition user_id). Application writes explicit `final_decided_by_user_id`. ✅.
- [ ] 0134-C6: Permission code naming convention audit: the Corrective §Three introduced dot-style codes (`hr.salary.view`). Migration 0134 + frontend permissions.ts still use slash/slash-colon hybrid (`hr_salary:view`, `hr_settings.manage_organisation`). Standardize naming convention before M2b. CORRECTION = adopt one canonical form (recommend `hr_salary:view` = colon separated, matches existing frontend); add explicit mapping for the 12 dot-form sensitive perms in the directive onto actual colon codes.

---

### 0135: `firm_operating_settings.sql` (Decision A2 — NEW)
File: `lib/db/migrations/0135_firm_operating_settings.sql`
**Approved?: ⚠️ CONDITIONAL (LOCAL DRAFT, NOT APPLIED) — Architecture checks pass; app-layer cutover wiring outstanding**

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | firm_id present | ✅ PASS | `firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE`. Perfect 1:1 per-firm row. |
| 2 | RLS immediate | ✅ PASS | `ENABLE RLS` + `FORCE RLS` created in same file immediately after the table. Policy `firm_operating_settings_tenant_isolation` = founder OR firm_id = GUC match. Idempotent via DROP IF EXISTS before CREATE POLICY. |
| 3 | Sensitive tables stricter | N/A | Operating settings are not PII/sensitive (timezone / working hours / region). No stricter policy required beyond basic tenant isolation. |
| 4 | ON DELETE correct | ✅ PASS | `firm_id … REFERENCES firms ON DELETE CASCADE` — if a firm is removed, its settings evaporate (orphan prevention). All other FKs are user_id SET NULL for audit authorship. Correct. |
| 5 | No hard delete on employee | N/A | No employee tables here. |
| 6 | Firm-scoped UNIQUE | ✅ PASS | `firm_id` is PRIMARY KEY → implicitly unique per firm. No other candidate keys. |
| 7 | Final Approver limited | N/A | No approval subsystem here. |
| 8 | Delegation circular | N/A | No delegation. |
| 9 | Outbox idempotency | N/A | Not an outbox table. |
| 10 | Event payload | N/A | No event payload storage. |
| 11 | Production-safe backfill | ✅ PASS | `INSERT … SELECT … FROM firms LEFT JOIN accounting_settings ON CONFLICT (firm_id) DO NOTHING`. Purely additive; existing rows (or rows inserted by admin between migration apply cycles) are NEVER overwritten. No DROP COLUMN / DROP TABLE anywhere in the forward path. |
| 12 | Lock timeout / transaction | ⚠️ ACCEPTABLE for current scale | Single INSERT-SELECT cross all firms + LEFT JOIN. No per-firm loops. Current firm count is low (<100). If firm count exceeds 1k in future: same pattern stays fine; consider advisory lock only if row-estimate warrants it (not currently needed). |

**Required corrections before APPROVE (beyond the local-draft gate):**
- [ ] 0135-C1: Application-layer double-write service: when a firm operator edits shared operating settings (timezone/weekends/etc.), the service MUST write BOTH `firm_operating_settings` AND the legacy mirrored columns in `accounting_settings` during cutover Step 1. Today no code path does this (service wiring is M2a work). Without the double-write, edits after apply but before full cutover split-brain the legacy reads.
- [ ] 0135-C2: Static assertion that HR modules never `import` or reach `accounting_settings` for the 6 shared cols (Decision A2 enforcement). Easiest: add a vitest `import/no-restricted-paths`-style regression test that scans HR routes/modules and rejects `accounting_settings` tokens.
- [ ] 0135-C3: Confirm `accounting_settings` duplicated columns are retained during Step 2/3 and only dropped in a LATER migration (per the 0135 footer's cutover Step 4). Must not happen in the same PR that applies 0135.
- [ ] 0135-C4: `working_hours.break_start/end` default `13:00–14:00` hardcoded. Valid Malaysia convention but should be ratified as product default in M2a sign-off; minor, no schema change needed.

---

## Summary of Approval Status

**Blocker Count Source of Truth:** `docs/hrms-corrective-blocker-register.md` (manually maintained single source of truth).
Per-file counts below are re-stated by running `node scripts/validate-hrms-blocker-register.mjs`. No integer in this summary is hand-written; they are all transcribed verbatim from the validator's JSON output. If the validator exit code is non-zero, DO NOT trust this summary — re-run the validator first.

Validator baseline (last run):
```
Total rows: 24
Unresolved (status != RESOLVED_SIGNED_OFF): 24
Blocks Apply? = YES: 18
Blocks Apply? = SOFT: 6
Per-migration (0127..0135): 3, 1, 2, 4, 4, 1, 3, 2, 4
Sum: 24
Validator exit code: 0 (PASS)
```

| File | Approved? | Register Blockers (Source: hrms-corrective-blocker-register.md; transcribed by validator exit 0) |
|------|-----------|----------------------|
| 0127 outbox | CONDITIONAL | 3 (B0127-01 payload comment, B0127-02 PII scrub app guard, B0127-03 priority doc) |
| 0128 core org | ⚠️ CONDITIONAL (was ❌ NOT APPROVED; A2 table exists as 0135 draft) | 1 (B0128-01 HR service read-path cutover) |
| 0129 employees core | CONDITIONAL | 2 (B0129-01 employment_status DB CHECK, B0129-02 invariant masked-NRIC write enforcement) |
| 0130 sensitive subtables | CONDITIONAL | 4 (B0130-01 partner-default-deny table comments, B0130-02 NRIC audit+endpoint, B0130-03 bank cleartext+mask+audit, B0130-04 Partner-role regression test) |
| 0131 reporting+emp+docs | CONDITIONAL | 4 (B0131-01 manager FK CASCADE→SET NULL, B0131-02 storage path builder+comment, B0131-03 employee-vs-firm doc FK semantics, B0131-04 sha256 integrity on signed URL) |
| 0132 memberships+flags | ✅ PASS w/ note | 1 (B0132-01 submodule defaults true→false) |
| 0133 approval subsystem | CONDITIONAL | 3 (B0133-01 active-partner final-approver guard, B0133-02 delegation cycle BFS guard, B0133-03 submission payload allow-list) |
| 0134 RBAC roles/perms | CONDITIONAL | 2 (B0134-01 HR Admin salary.view product sign-off, B0134-02 permission code naming canonical + mapping) |
| 0135 firm_operating_settings | ⚠️ CONDITIONAL (new, local draft) | 4 (B0135-01 double-write service, B0135-02 HR→accounting_settings static ban, B0135-03 legacy column drop timing ratify, B0135-04 break default ratify) |
| **Total (validator-verified)** | — | **24** |

Per the register: 18 rows are BLOCKED+YES (hard apply blocks), 6 rows are BLOCKED+SOFT (sign-off / doc blocks). No rows at RESOLVED_SIGNED_OFF.

**Zero migrations are APPROVED unconditionally. All 9 files remain LOCAL DRAFT status.**

Evidence that 0127–0135 HAVE NOT been applied to Supabase / any environment:
> The command log for this session contains NO executions of Supabase migration apply (`supabase migration up`, `supabase db push`, `drizzle-kit push`, `psql -f lib/db/migrations/0127*.sql`, or any equivalent). Git status (Untracked files) is NOT evidence of database state. A read-only Migration History check against the target Supabase instance would be required as further proof and is NOT performed this session.

---

## Next Clear Step for Migrations

1. Implement Decision A2 neutral `firm_operating_settings` in revision.
2. Resolve all 18 remaining non-critical corrections.
3. Re-run this review against revised 0127–0134 files + new A2 migration.
4. Receive explicit sign-off per file via user directive.
5. Only then: schedule apply against a staging clone first, not Production.
