# Lawcaspro V5 — HRMS Architecture Audit (Part 1 of 3)

**Date:** 2026-08-06
**Scope:** Architecture audit before HRMS development
**Status:** Audit Complete — Awaiting Implementation Approval

---

## 1. Executive Summary

This audit evaluates the existing Lawcaspro-v5 codebase's capacity to host a new HRMS module without violating the established architectural principles. The audit confirms:

- The current monorepo, RBAC foundation, tenant isolation (RLS), Drizzle schema/migration system, Express routing pattern, money handling, and object storage patterns are **all reusable** for HRMS.
- **Identity (users) and Employee must be separated**: The current `users` table mixes login identity with partial employment data (`department`, `bar_council_no`, `nric_no`). A new `employees` table family is required.
- **Department / Position / Reporting Line**: Currently only `users.department` (free-text string) exists. Proper normalized tables for `departments`, `positions`, `reporting_lines` are new requirements.
- **Accounting ↔ HR Boundary**: Current accounting module has direct `payment_vouchers` + `ledger_entries`. HR must **not** write to these. An integration service/business event pattern (e.g., `hr_claim_submitted` → Accounting creates PV suggestion) is the correct path.
- **Soft delete**: Existing pattern uses `deleted_at` timestamp + query filtering. Employee will use **status-based lifecycle** (not `deleted_at`) per HRMS spec (`draft/active/probation/confirmed/.../terminated`).
- **No existing `firm_memberships` table**: The current `users.firm_id` column directly links user → firm. For multi-firm employees in future, `firm_memberships` bridging table should be introduced now for HRMS, but this is additive only and does not break current users.

---

## 2. Monorepo & Package Architecture

### 2.1 Current Layout (可復用 / Reusable)

| Package | Path | Purpose | HRMS Impact |
|---|---|---|---|
| `@workspace/db` | [lib/db/](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db) | Drizzle schema, migrations, RLS helpers, pool | **HRMS schema lives here.** Add new files under `src/schema/hrms-*.ts`. Reuse `tenant-context.ts`, `pool`, `db` export. |
| `@workspace/api-zod` | [lib/api-zod/](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/api-zod) | Shared Zod schemas for API contracts, generated TS types | Add HRMS request/response types here following existing pattern. |
| `@workspace/api-client-react` | [lib/api-client-react/](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/api-client-react) | Frontend typed API client + React Query hooks | Auto-picks up new `api-zod` types. No schema changes needed here. |
| `@workspace/api-server` | [artifacts/api-server/](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server) | Express backend; routes per domain in `src/routes/*.ts` | Add `routes/hr-*.ts` files. Reuse `requireAuth`, `requireFirmUser`, `requirePermission`, `requireReAuth`, `writeAuditLog`. |
| `@workspace/lawcaspro` | [artifacts/lawcaspro/](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro) | Vite React SPA; pages under `src/pages/app/*` | Add `pages/app/hr/*` for HR admin and `pages/app/my/*` for Employee Self-Service. |
| `@workspace/object-storage-web` | [lib/object-storage-web/](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/object-storage-web) | Browser-side upload validation | Reuse for HR document uploads. |
| Root workspace | [package.json](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/package.json) | `pnpm run typecheck` / `pnpm run build` | After adding HRMS schemas/types, both must pass green. |

### 2.2 Build Chain (不能修改 / Do Not Modify)
- Drizzle config: [drizzle.config.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/drizzle.config.ts) — schema entry point `./src/schema/index.ts`, migrations out to `./migrations`.
- Migration table: `__drizzle_migrations` (public schema).
- **Rule**: Always add new migrations (SQL files) under `lib/db/migrations/`. Never edit existing migrations retroactively.

---

## 3. Users, Firm Membership, Roles & Permissions

### 3.1 Current Structure — Detailed Findings

#### 3.1.1 `users` table ([users.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/users.ts))

| Column | Type | Semantic Issue for HRMS |
|---|---|---|
| `id` (PK) | serial | ✅ Reusable as User identity (login account). |
| `firm_id` | integer (FK-ish, no constraint) | ⚠️ Direct single-firm assignment. No `firm_memberships` bridging table. For HRMS this is acceptable initially (HRMS is always single-firm scoped). However Employee table must NOT rely solely on this; use `employees.firm_id` explicitly. |
| `developer_id` | integer | Unrelated to HR. |
| `email` | text UNIQUE NOT NULL | ✅ Login identity. |
| `name` | text NOT NULL | ⚠️ Currently also serves as display name. `employees.full_name` should be the HR source of truth; `users.name` is the login display name (may differ). |
| `initials` | varchar(5) | ✅ OK. |
| `password_hash` | text NOT NULL | ✅ Auth only. Keep in users. |
| `user_type` | text NOT NULL default 'firm_user' | Values include `firm_user`, `founder`, `developer_user`. **HRMS employees are always within `firm_user` type.** Founder is never an employee record. |
| `role_id` | integer | Links to `roles` table. ✅ System Role lives here. |
| **`department`** | text | ❌ **Conflict with HRMS**: Currently a free-text column on User. HRMS requires normalized `departments` table + `employees.department_id`. This column in `users` should be **deprecated for HR scoping** and eventually migrated; for now, treat it as read-only legacy and use the new Employee→Department relation as the canonical source. |
| **`bar_council_no`** | text | ❌ Belongs in HR: should move to `employee_professional_details` or similar. Leave on `users` for backward compatibility with Case references; copy value to Employee during onboarding. |
| **`nric_no`** | text | ❌ Sensitive! Currently on the `users` table. HRMS spec requires this in `employee_personal_details` with restricted `hr.*.view` permissions. Existing `users.nric_no` must remain for login context but **new HR queries MUST NOT read it**; read from Employee's personal details table. |
| `status` | text default 'active' | Login account status (`active`/`inactive`). Independent of Employee's `employment_status`. Both must co-exist. |
| TOTP fields, `last_login_at`, timestamps | — | ✅ Pure auth concern; keep in users only. |

**Key decision (可能衝突 / Possible Conflict):**
The `users.department`, `users.nric_no`, `users.bar_council_no` fields overlap with HRMS Employee data.
- **Resolution**: Do NOT drop these columns. Add new `employees` + related tables as **canonical HR source**. For existing users, create matching Employee records with a data migration (backfill) and keep `users.*` fields in sync via application logic (or leave `users.*` as legacy read-only). RLS on the HR tables ensures `hr.*` permission checks govern sensitive fields, while `users.*` fields remain guarded by existing `users:read` / `users:update` permissions.

#### 3.1.2 No `firm_memberships` Table (需要新增 / New Requirement)
- Currently membership is implicit via `users.firm_id`.
- HRMS spec explicitly calls for `firm_memberships` as a bridging concept. Since `users.user_type='founder'` must NOT be any firm's employee, and the requirement says "One User could be Founder Admin, not belonging to any firm's Employee", a normalized `firm_memberships(id, user_id, firm_id, joined_at, left_at, member_type)` is **recommended** for correctness.
- **Migration impact**: Additive only. Does not require modifying `users.firm_id` for existing flows. The new `employees.user_id` FK references `users(id)` and the employee's `firm_id` duplicates `firm_memberships.firm_id` (acceptable denormalization for RLS efficiency).

#### 3.1.3 `roles` and `permissions` tables ([roles.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/roles.ts))

Current RBAC pattern is **fully reusable**:
- `roles(id, firm_id, name, is_system_role, timestamps)` — this matches exactly the HRMS spec's **System Role** concept.
- `permissions(id, role_id, module, action, allowed, created_at)` — uniquely indexed on `(role_id, module, action)` after migration [0003_permissions_rbac_baseline.sql](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/migrations/0003_permissions_rbac_baseline.sql).

Standard role names auto-bootstrapped:
```
Partner, Account Admin, Account Manager, Senior Lawyer, Lawyer, Senior Clerk, Clerk, Staff, Manager, Admin, Viewer, Developer_User
```
Source: [roles.ts lines 86-114](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/roles.ts#L86-L114)

**HRMS requires adding new system roles** (需要新增):
- `HR Manager`
- `HR Admin`
- `Employee` (for self-service only users — note: existing `Staff` is similar but may have different module grants; add `Employee` explicitly or alias with docs).

**HRMS requires adding new permissions** (需要新增) — see §8 for the full list. Use the existing `module:action` format:
- Module: `hr_employee` (view/edit)
- Module: `hr_salary` (view/edit)
- Module: `hr_bank_details` (view)
- Module: `hr_medical_document` (view)
- Module: `hr_disciplinary` (view)
- Module: `hr_performance_private_notes` (view)
- Module: `hr_payroll` (run/approve)
- Module: `hr_termination` (approve)
- Module: `hr_settings` (manage)
- Module: `hr_leave` (view_others/approve)
- Module: `hr_claim` (view_others/approve)
- Module: `hr_attendance` (view_others/edit)
- Module: `hr_recruitment` (view/manage)
- Module: `hr_training` (view/manage)
- Module: `hr_asset` (view/manage)
- Module: `hr_onboarding` (view/manage)
- Module: `hr_offboarding` (view/manage)
- Module: `hr_document` (view_others/manage)
- Module: `hr_approval_policy` (manage)
- Module: `hr_approval_delegation` (manage)

#### 3.1.4 Frontend Permission Helper ([permissions.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/lib/permissions.ts))

Current `hasPermission()` function:
1. Checks explicit `user.permissions[]` array (from JWT/API).
2. Falls back to role-name-based hardcoded sets: `partner`, `clerk`, `lawyer`, `account admin/manager`, `staff`, `developer_user`.
3. Has a `coreStaffBypass` set for dashboard/cases/projects/documents read.

**HRMS must extend this without modifying existing sets.** Specifically:
- Add `hrAdminRoleAllowed()` helper like existing `isAccountingRoleAllowed()`.
- Add HR module:action entries to the Partner set (Partner gets full HR access by default per §5 & §6).
- Add HR module:action entries for HR Manager / HR Admin role-name detection.
- Add a **new `hrSelfServiceBypass`** set so any authenticated firm user can read their own `my_*` endpoints (server must still enforce per-row ownership).

#### 3.1.5 Server-side Permission Middleware ([auth.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/lib/auth.ts))

Reusable middleware signatures (already in every other route):
- `requireAuth` — validates token + hydrates session/user.
- `requireFirmUser` — **critical**: sets `req.rlsDb` (RLS-bound Drizzle instance) via `setTenantContextSession(...)`, assigns `req.firmId`, `req.userId`, `req.roleId`, `req.userType`. **All HRMS firm-scoped routes MUST stack this.**
- `requirePermission(module, action)` — queries `permissions` table for `req.roleId`. Fallback grants are inside.
- `requireReAuth` — for sensitive actions (approve payroll, terminate, change salary). Use for the HRMS actions specified in §7, §8.
- `writeAuditLog({...})` — writes to `audit_logs` table. **Every HRMS write and approval action must call this.**

AuthRequest shape: [auth.ts lines 9-27](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/lib/auth.ts#L9-L27).

---

## 4. Firm / Branch / Department Structures

### 4.1 `firms` table ([firms.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/firms.ts))

Reusable columns:
- `id` (PK), `name`, `slug`, `status`, `subscription_plan_id`, timestamps — all serve as the tenant boundary.
- Additional firm metadata (`logo_url`, `address`, `st_number`, `tin_number`, `registration_no`, `sst_no`, `phone`, `email`) — these are the firm's legal/billing details. **Branch-level addresses are separate.**

### 4.2 Firm-level Settings Tables

| Table | Purpose | HRMS Reuse |
|---|---|---|
| `firm_settings` ([firms.ts lines 60-66](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/firms.ts#L60-L66)) | Booleans for document engine behavior | ⚠️ Don't overload. Add dedicated `hr_settings` table instead. |
| `firm_bank_accounts` | Office/client bank accounts | ❌ Accounting-owned. HR payroll references these by ID (readonly) but never writes. |
| `firm_file_ref_settings` | Case file numbering sequences | N/A. |
| `accounting_settings` ([accounting.ts lines 163-183](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/accounting.ts#L163-L183)) | Timezone, working hours, SLA policies, approval rules | ✅ **High value reuse**: HRMS attendance/leave/overtime calculations need same `timezone`, `working_hours_start/end`, `exclude_saturday/sunday`, `firm_holidays`. Suggest refactor: extract these common fields into a new shared `firm_operating_settings` table, OR read them via a shared loader from `accounting_settings` (HR read-only) to avoid duplication. Audit flag: **possible conflict** if HR needs different hours vs. Accounting — then separate `hr_settings` wins. |

### 4.3 Gap: `departments`, `positions`, `branches`, `reporting_lines`

**None of these normalized tables exist.** (需要新增)

Current state: `users.department` is free text (see §3.1.1).

Required new tables (full schema will be in HRMS Part 2):

```
departments:
  id, firm_id, name, code, parent_department_id (self-ref hierarchy),
  manager_employee_id (nullable → FK employees),
  location/branch_id, status, created_at
  UNIQUE(firm_id, name), UNIQUE(firm_id, code)

positions:
  id, firm_id, name, code, job_grade, department_id (nullable),
  description, status, created_at
  UNIQUE(firm_id, name), UNIQUE(firm_id, code)

branches:
  id, firm_id, name, code, address, city, state, country,
  phone, email, is_head_office boolean, status

reporting_lines:
  id, firm_id, employee_id, supervisor_employee_id,
  report_type ('primary' | 'dotted' | 'functional'),
  effective_from, effective_to, status
```

---

## 5. Accounting Permissions & Payment Voucher Flow (邊界約束)

### 5.1 Accounting Permissions Model (可復用架構，禁止跨越)

The accounting module defines the following permission `actions` used with `requirePermission('accounting', x)`:
```
read, write, create, edit, review, approve, mark_received, mark_paid,
cancel, reopen, export, view_audit, manage_settings, override_sla
```
Source: [permissions.ts lines 5-20](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/lib/permissions.ts#L5-L20).

Only role-names matching Partner / Account Admin / Account Manager pass `isAccountingRoleAllowed()`. Everyone else is denied accounting module actions even if DB permissions somehow misconfigured.

### 5.2 Payment Voucher State Machine ([payment-vouchers.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/payment-vouchers.ts))

Current lifecycle on `payment_vouchers` table:
- `status`: pending_lawyer → ... → approved → paid
- `approval_status`: approved/requires_partner/etc
- `lawyer_approved_by/at`, `partner_approved_by/at`, `prepared_by/at`, `received_by/at`, `paid_by/at`, `paid_at`
- Snapshot of SLA policy stored at `sla_policy_snapshot` jsonb
- Idempotency via `uq_payment_vouchers_client_request` unique index on `(firm_id, client_request_id)`

Ledger integration:
- `ledger_entries(firm_id, entry_type, account_type, debit, credit, balance_after, source_type, source_id, ...)`
- `case_ledgers(...)`

### 5.3 Strict HR ↔ Accounting Boundary (禁止事項 — Must Be Enforced)

Per the user's mandate:

| ❌ FORBIDDEN | ✅ CORRECT INTEGRATION |
|---|---|
| HR directly INSERTs/UPDATEs `ledger_entries` | HR emits business event `hr.claim.final_approved` → Accounting Service (or a shared `hr_accounting_integration.ts`) creates a Payment Voucher **suggestion** (status=pending_lawyer/pending_account) with `source_type='hr_claim'` and `source_id=claim_id`. |
| HR directly creates `bank_transactions` or marks PV paid | Same: Accounting workflow (via existing PV actions routes) is the sole writer of `paid_at`, `paid_by`, `bank_*` fields. HR consumes read-only PV status for display in Claim tracker. |
| HR directly writes to `firm_bank_accounts` or `accounting_settings` | HR read-only references to bank account IDs for payroll disbursement configuration; write requests still go through Accounting UI (role-gated). |
| Accounting modifies `employee_compensation.salary` or `leave_balances.remaining_days` | Accounting only ever reads aggregated payroll data from HR for reconciliation. All salary/leave writes live in HR-owned tables with `hr_*` permission checks. |

**New table required (Integration Service Contract):**
```
hr_accounting_events (NEW):
  id, firm_id, event_type ('claim_approved'|'payroll_disbursement_ready'|'salary_advance_approved'),
  payload_hash, status ('pending'|'delivered'|'failed'),
  source_type, source_id,
  delivered_to_accounting_at, accounting_ref_type, accounting_ref_id,
  error_message, retry_count, created_at, updated_at
```
This gives us auditability of every cross-module hand-off. If Accounting-side creates a PV, it writes back `accounting_ref_type='payment_voucher'`, `accounting_ref_id=pv.id`. HR UI shows this link.

---

## 6. Notification, Audit Log, Background Job

### 6.1 Audit Log — Fully Reusable (可復用)

Table: `audit_logs` in [cases.ts lines 379-397](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/cases.ts#L379-L397)

```
id, firm_id, actor_id, actor_type, action, entity_type, entity_id,
detail, ip_address, user_agent, created_at
```
With indexes on `(firm_id)`, `(actor_id)`, `(entity_type, entity_id)`, `(created_at)`, `(action)`.

Helper: `writeAuditLog({...})` — see [auth.ts lines 85-156](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/lib/auth.ts#L85-L156). It correctly skips when `firm_id` or `actor_id` missing (for non-firm system actions) and never throws in non-strict mode — critical to avoid disrupting the primary operation when audit write fails.

**HRMS MUST audit every one of these actions** (use standard `entity_type` like `employee`, `employment_record`, `leave_request`, `claim`, `payroll_run`, `hr_approval_policy_step`, `hr_approval_delegation`):
- Create / Edit / Terminate / Reactivate Employee
- Edit compensation, bank details, personal details
- Create/Edit Department, Position
- Submit / Approve / Reject / Delegate Leave, Claim, Overtime, Payroll
- Change of Final Approver
- Create / Revoke Delegation
- Run Payroll, Publish Payslip, Revert Payslip
- Upload / Download / View sensitive HR document
- Founder access to HR data (through support_sessions — covered by existing support_session audit)

### 6.2 Notifications — Two Tables (可復用架構)

1. `case_notifications` — per-case with `recipient_user_id`, `actor_user_id`, `type`, `title`, `message`, `meta:jsonb`, `is_read`, `read_at`.
2. `user_notifications` ([accounting.ts lines 219-237](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/accounting.ts#L219-L237)) — generic per-firm-user notifications, with `source_type/source_id` and `case_id` (nullable). Index on `(firm_id, user_id, is_read, created_at)`.

**HRMS should reuse `user_notifications`**:
- Example `source_type` values: `'hr_leave_request'`, `'hr_claim_request'`, `'hr_payroll_published'`, `'hr_approval_assigned'`, `'hr_delegation_activated'`.
- Notification route already exists: [user-notifications.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/user-notifications.ts) and API contract types.
- Insert from HR routes on any user-facing action (request submitted, approval assigned, payslip published).

### 6.3 Background Jobs — Polling + Advisory Lock Pattern (可復用)

Current implementation pattern (no external queue; use Node timers + Postgres advisory locks for single-writer safety):

Examples:
- [completion-sla-monitor.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/jobs/completion-sla-monitor.ts) — `pg_try_advisory_lock(hashtext('...'))` guard; `setInterval`-based tick; env-gated `ENABLE_*_MONITOR=1`; configurable interval; `LIMIT 50` batches.
- [payment-voucher-sla-monitor.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/jobs/payment-voucher-sla-monitor.ts)
- [snapshot-scheduler.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/jobs/snapshot-scheduler.ts)
- [snapshot-retention.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/jobs/snapshot-retention.ts)

Jobs are started from [app.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/app.ts) (verify by reading; naming convention clear).

**HRMS Background Jobs (to add in Part 2/3 following same pattern):**
- `hr-leave-balance-carryover` — yearly / at anniversary: carry over max balance, auto-expire excess.
- `hr-attendance-nightly-process` — aggregate clock-in/clock-out, flag anomalies.
- `hr-payroll-auto-lock` — lock payroll period after publish window.
- `hr-probation-reminder` — notify HR Manager/Partner X days before confirmation date.
- `hr-delegation-auto-expire` — set delegation.status = 'expired' when `end_at < now()`.
- `hr-approval-escalation` — SLA-based escalate approval to alternate approver after X days.
- `hr-offboarding-checklist` — trigger revocation tasks (disable user, revoke case assignments, return assets checklist reminders).

Each job:
1. Tries advisory lock.
2. Scans rows `LIMIT N`.
3. Writes audit log for each changed row.
4. Creates `user_notifications`.
5. Never runs if ENABLE env var ≠ `1`.

---

## 7. Case Assignment / Responsible Lawyer / Partner / Manager Relationships

### 7.1 `case_assignments` Table ([cases.ts lines 183-195](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/cases.ts#L183-L195))

```
id, case_id, user_id, role_in_case (default 'lawyer'),
assigned_by, assigned_at, unassigned_at
```
Soft "unassignment" via `unassigned_at` timestamp. Index on `(user_id, unassigned_at, case_id)` for active query.

### 7.2 HRMS Interaction Points

- The `case_assignments.user_id` → `users.id` link stays intact. HRMS does NOT replace Case Assignments.
- **New: Offboarding trigger** (background job in §6.3): when `employees.employment_status = 'terminated'` and `termination_date <= today`:
  - Set `unassigned_at = now()` on all case_assignments for matching `users.id = employees.user_id` (ONLY if employee has a linked user).
  - Log each such revocation to `audit_logs` with `entity_type='case_assignment'`, `action='hr.offboarding.case_unassignment'`, `detail`.
  - Notify the supervising Partner / Department Manager (via user_notifications) to re-assign.
- **Do NOT hard-delete case assignments** — they are part of historical case record, `unassigned_at` is sufficient.

### 7.3 Reporting Line vs Case Role Distinction (四個概念不混)

Current code:
- System Role = `roles` table (§3.1.3)
- Case Role = `case_assignments.role_in_case` ('lawyer'/...)

HRMS will add:
- Employment Position = `positions` table (§4.3)
- Reporting Line = `reporting_lines` table (§4.3)
- Process Approver = `hr_approval_policy_steps` + `hr_approver_assignments` (§6 of user's spec)
- Delegation = `hr_approval_delegations` (§7 of user's spec)

**Rule**: None of these 4 HR concepts may change a user's System Role or Case Role. They are strictly separate layers.

---

## 8. Soft Delete / Tenant Isolation / RLS / Server Authorization (最高優先)

### 8.1 Tenant Isolation Pattern — MUST Apply to Every HR Table

Current enforced pattern (by [requireFirmUser](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/lib/auth.ts)):
1. `req.rlsDb = makeRlsDb(client)` where `client` has run `setTenantContextSession(client, req.firmId, req.userId)`.
2. `setTenantContextSession` does:
   - `SET ROLE app_user` (NOLOGIN / NOBYPASSRLS role created in migration 0002).
   - `assertSafeRlsRole()` to guard against accidental superuser.
   - `set_config('app.current_firm_id', $1, false)` + `'app.current_user_id'` + `'app.is_founder'='false'`.
3. RLS policies (migration 0002 baseline + later idempotent patches) apply:
   ```
   firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::int
   OR current_setting('app.is_founder',true) = 'true'
   ```
4. All policies are `TO PUBLIC` + `FORCE ROW LEVEL SECURITY` (not `TO app_user`) so they apply regardless of role fallback.

Source: [tenant-context.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/tenant-context.ts) and [0002_correct_rls_policies.sql](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/migrations/0002_correct_rls_policies.sql).

**HRMS Non-Negotiables (沿用，不可修改底層機制):**
- Every new `hr_*` and `employees*` and `departments`, `positions`, `reporting_lines` table:
  1. MUST have `firm_id integer NOT NULL`.
  2. MUST be listed in a new RLS idempotent migration that does:
     - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`
     - `ALTER TABLE ... FORCE  ROW LEVEL SECURITY;`
     - `DROP POLICY IF EXISTS tenant_isolation ON ...;`
     - `CREATE POLICY tenant_isolation ON ... TO PUBLIC USING (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::int OR current_setting('app.is_founder',true) = 'true') WITH CHECK (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::int OR current_setting('app.is_founder',true) = 'true');`
  3. MUST have an index on `(firm_id)` (and additional composite indexes with firm_id prefix for common filters).
- Founder-access to HR tables is already covered by the `is_founder=true` branch — this is correct and compliant with existing platform support sessions (which already log founder access to `support_sessions.action_log`).

### 8.2 Soft Delete vs Status-Based Lifecycle

Current soft delete pattern across existing tables uses `deleted_at timestamp with time zone` (nullable):
- `invoices`, `cases`, `clients`, `quotations`, `case_workflow_documents`, workflow documents, platform snapshots, compliance, parties.
- Index: `(firm_id, deleted_at)` for fast filtering of non-deleted rows.

**HRMS Override (不能修改，另闢新路徑):**
Per user's §10: **Employee and HR process records DO NOT use `deleted_at`. Use `employment_status` (enum-ish text) + date fields.**

Employee statuses (canonical text values, add check constraint in DB if possible — use CHECK constraint migration):
```
draft, active, probation, confirmed, notice_period, pending_handover, inactive, terminated
```

Associated timestamp fields (no `deleted_at` on `employees`):
- `join_date`, `confirmation_date`, `termination_date`, `last_working_date` (new), `reactivated_at` (new).

Related HR records (Leave, Claim, Payroll, Performance) also use status columns, never `deleted_at`. The exception is `hr_documents.upload_deleted_at` if we need to allow upload cancellation before final attachment commit.

### 8.3 Server Authorization (Permission Layer Extension)

Current permission check stack for routes:
```
routerInternal.GET(
  "/path",
  requireAuth,
  requireFirmUser,               // ← sets RLS db + firm boundary
  requirePermission("mod","act"), // ← RBAC module:action
  async (req, res) => { ... }
);
```
This is **necessary but not sufficient** for HRMS due to §5's Self-Service rule and §8's sensitive data restriction.

**HRMS must add two MORE layers of server enforcement**:

1. **Self-Service row ownership guard** — for `/my-*` endpoints (or any endpoint where a non-HR user requests their own data):
   - Explicitly check: `queried_employee.user_id = req.userId` OR the caller passes `requirePermission('hr_employee','view_others')`.
   - Never rely solely on frontend hiding.

2. **Sensitive field column-level guards** — for GET endpoints returning employee detail:
   - When caller lacks `hr_salary.view`, drop `compensation_*` columns from the SELECT (or return `null` masked values).
   - When caller lacks `hr_bank_details.view`, omit employee_bank_details join entirely.
   - Same rule for `hr_medical_document.view`, `hr_disciplinary.view`, `hr_performance_private_notes.view`.
   - **Always enforce on the server.** Do not return the row unmasked.

Pattern:
```ts
const canViewSalary = await roleHasPermission(req, 'hr_salary', 'view');
const canViewBank = await roleHasPermission(req, 'hr_bank_details', 'view');
const base = await r.select({ ...safeColumns }).from(employees)...;
if (canViewSalary) {
  // join + include compensation
}
if (canViewBank) {
  // join + include bank details
}
```

3. **Final Approver delegation resolver** — any HR approval route:
   - Look up `hr_approval_delegations` for current timestamp within `[start_at, end_at]`, status = `active`.
   - If a delegation applies, the delegate's approval counts as valid; audit log must record `approver_user_id` (the actual actor) and `acting_on_behalf_of_user_id` (delegation principal). **Do not mutate the policy table.**

---

## 9. API / Router Naming Conventions

### 9.1 Backend Routes

All routes follow the [api-server routes/index.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/index.ts) pattern:

| Convention | Example from codebase | HRMS Equivalent |
|---|---|---|
| Domain = separate file | `routes/payment-vouchers.ts` | `routes/hr-employees.ts` |
| kebab-case filenames | `routes/case-notifications.ts` | `routes/hr-leaves.ts` |
| REST-ish path = plural | `GET /payment-vouchers` | `GET /hr-employees` |
| Resource by id param | `GET /roles/:roleId` + Zod schema parse | `GET /hr-employees/:employeeId` |
| Action suffix path | `POST /payment-vouchers/:id/transition` | `POST /hr-leaves/:id/approve` |
| Compound setting path | `GET /accounting-settings` | `GET /hr-settings` |
| Founder = subfolder | `routes/founder/billing.ts` | (HRMS is firm-scoped; founder uses support-session existing flow only) |

**HRMS routes to create (tentative list, exact paths in Part 2):**
- `hr-employees.ts` → `/hr-employees` CRUD + `/hr-employees/:id/terminate`, `/hr-employees/:id/reactivate`, `/hr-employees/:id/link-user`
- `hr-employment-records.ts` → `/hr-employees/:id/employment-records` (job history)
- `hr-departments.ts` → `/hr-departments` CRUD
- `hr-positions.ts` → `/hr-positions` CRUD
- `hr-reporting-lines.ts` → `/hr-reporting-lines` CRUD (or nested under employees)
- `hr-leaves.ts` → `/hr-leaves` (all) + `/my/hr-leaves` (self-service, same file with ownership guard)
- `hr-claims.ts` → same pattern: `/hr-claims` + `/my/hr-claims`
- `hr-attendance.ts` → `/hr-attendance` + `/my/hr-attendance`
- `hr-payroll.ts` → `/hr-payroll/runs`, `/hr-payroll/:runId/publish`, `/my/hr-payroll` (payslips)
- `hr-payslips.ts` → `/hr-payslips/:id/download`
- `hr-recruitment.ts` → `/hr-recruitment/vacancies`, applicants (future)
- `hr-performance.ts` → reviews, goals
- `hr-training.ts` → training records
- `hr-assets.ts` → asset inventory + assignment
- `hr-documents.ts` → HR document upload + signed URL download (storage)
- `hr-approvals.ts` → `/hr-approval-policies`, `/hr-approval-delegations`, `POST /hr-approvals/:id/act`
- `hr-settings.ts` → firm-level HR config
- `hr-integrations.ts` → Accounting hand-off status viewer (read-only `hr_accounting_events`)

All new route files must be registered in [routes/index.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/index.ts) in alphabetical-ish position alongside peers.

### 9.2 `api-zod` Contract Types

Existing pattern:
- `lib/api-zod/src/paymentVouchers.ts` hand-crafted schemas.
- `lib/api-zod/src/generated/types/*.ts` + `index.ts` auto-generated (from `lib/api-spec`?) — but also hand-written types exist.
- Reuse `CreateXxxBody`, `UpdateXxxBody`, `ListXxxQueryParams`, `GetXxxParams`, `XxxDetail` Zod + types pattern from users/roles routes.

HRMS types go to `lib/api-zod/src/hr-*.ts` (or single `hr.ts` with sub-exports to avoid file explosion). Part 2 will decide.

---

## 10. Migration Mechanism

### 10.1 Current Setup

- Drizzle ORM: config in [drizzle.config.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/drizzle.config.ts)
- Source-of-truth: SQL files under [lib/db/migrations/](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/migrations/).
- Current migration count: 0000 baseline → 0126_payment_voucher_create_request_tracking (and may include 0127–0128 idempotent repairs; verify with glob).
- Key helper scripts (under `lib/db/scripts/`):
  - `apply-migrations-safe.mjs` — safe runner.
  - `verify-migrations.mjs` — post-apply checks.
  - `post-migration-verify.mjs`, `post-migration-verify-production.mjs`.
  - `apply-rls.mjs` / `apply-rls.sql` — RLS grant/policy scripts.
  - `apply-migrations-from.mjs` — apply range.
  - `reconcile-live-db.mjs`, `check-prod-state.cjs`.
  - `fix-founder-rbac.cjs`.

### 10.2 HRMS Migration Order (Migration 順序)

Migrations must be idempotent, additive-only where feasible, and strictly ordered to respect FK dependencies.

Proposed migration batch numbering starts **after whatever is currently the highest on disk**. The list below is in **logical dependency order**; actual filenames will follow the existing timestamp-numbering convention (sequential 4-digit `0127_*.sql`, `0128_*.sql`, …) and applied in one deployment window.

| Step | Migration Label | Content |
|---|---|---|
| M1 | `hrms_operating_settings_shared_extract` (optional) | Optional: if we extract timezone/holidays from `accounting_settings` → new `firm_operating_settings`. If skipped, HR reads `accounting_settings` read-only. |
| M2 | `hrms_departments_positions_branches` | `departments`, `positions`, `branches` tables + firm_id RLS + indexes. Self-FK on `departments.parent_department_id` deferred. |
| M3 | `hrms_employees_core` | `employees` (core columns as in user's §3), FK `department_id → departments.id`, FK `position_id → positions.id`, self-FK `reporting_manager_employee_id → employees.id` (DEFERRABLE INITIALLY DEFERRED so inserts work in any order). Unique on `(firm_id, employee_no)`. CHECK on `employment_status`. |
| M4 | `hrms_employees_sensitive_tables` | `employee_personal_details`, `employee_bank_details`, `employee_statutory_details`, `employee_compensation`, `employee_emergency_contacts`, `employee_documents`. All FK `employee_id → employees.id ON DELETE RESTRICT` (prevent accidental orphan; employees never hard-deleted anyway). |
| M5 | `hrms_reporting_lines_and_employment_records` | `employment_records` (history of position/dept changes, salary changes — `employee_id` FK), `reporting_lines` (FK `employee_id`, `supervisor_employee_id`). |
| M6 | `hrms_firm_memberships_bridge` (additive, not breaking) | `firm_memberships(id, user_id, firm_id, member_type, joined_at, left_at)` — unique on `(user_id, firm_id)`. Backfill from `users where firm_id is not null`. |
| M7 | `hrms_rbac_seeds_new_roles_and_permissions` | INSERT new roles `HR Manager`, `HR Admin`, `Employee` into `roles` (per-firm? No — use the existing `backfillStandardRoles` pattern that runs on first visit, OR the migration can also insert per-firm using a lateral join over existing firms). Then seed all `hr_*` module:action permissions for Partner / HR Manager / HR Admin roles using same pattern as migration 0003. |
| M8 | `hrms_approval_subsystem` | `hr_approval_policies`, `hr_approval_policy_steps`, `hr_approver_assignments`, `hr_approval_delegations`. Default HR Final Approver setting stored in `hr_settings` (next migration). |
| M9 | `hrms_settings_table` | `hr_settings(firm_id PK, default_final_approver_employee_id, leave_final_approver_id, payroll_final_approver_id, salary_adj_final_approver_id, bonus_final_approver_id, recruitment_final_approver_id, termination_final_approver_id, overtime_final_approver_id, claim_final_approver_id, working_hours_start, working_hours_end, exclude_saturday, exclude_sunday, firm_holidays jsonb, payroll_cutoff_day, payroll_payout_day, epf_contribution_rate_employee, epf_contribution_rate_employer, socso_rate, eis_rate, income_tax_schedule jsonb, default_currency='MYR', version int, created_by, updated_by, timestamps)`. Foreign keys to employees deferred. |
| M10 | `hrms_leave_types_and_balances` | `hr_leave_types`, `hr_leave_policies`, `hr_leave_entitlements`, `hr_leave_balances`, `hr_leave_requests`, `hr_leave_request_approvals`. |
| M11 | `hrms_claim_types_and_requests` | `hr_claim_types`, `hr_claim_requests`, `hr_claim_items`, `hr_claim_request_approvals`. |
| M12 | `hrms_attendance` | `hr_attendance_entries`, `hr_attendance_shifts`, `hr_overtime_requests`, `hr_overtime_approvals`. |
| M13 | `hrms_payroll_and_payslip` | `hr_payroll_runs`, `hr_payroll_run_items`, `hr_payslips`, `hr_payroll_deductions`, `hr_payroll_allowances`, `hr_statutory_contributions`. |
| M14 | `hrms_recruitment_performance_training_assets` | `hr_recruitment_vacancies`, `hr_recruitment_applicants`, `hr_performance_reviews`, `hr_performance_goals`, `hr_training_courses`, `hr_training_enrolments`, `hr_asset_inventory`, `hr_asset_assignments`. |
| M15 | `hrms_onboarding_offboarding` | `hr_onboarding_plans`, `hr_onboarding_tasks`, `hr_onboarding_task_assignments`, `hr_offboarding_checklists`, `hr_offboarding_tasks`. |
| M16 | `hrms_integration_events_table` | `hr_accounting_events` (§5.3) plus any outbound notification queues. |
| M17 | `hrms_rls_policies_idempotent` | Standalone idempotent RLS enable+policy patch for every new table (same style as 0002). **Must run after M2–M16 so tables exist.** |
| M18 | `hrms_rbac_permissions_backfill_idempotent` | Idempotent `ensureRolePermissionsInitialized`-style SQL. Safe re-run. |

### 10.3 Rollback Strategy (Rollback 方法)

Each migration must be written to be **DROP-safe and re-runnable**:
- Use `CREATE TABLE IF NOT EXISTS`.
- Use `DROP POLICY IF EXISTS … ; CREATE POLICY …` for RLS.
- Use `CREATE INDEX IF NOT EXISTS`.
- Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
- For permission seeds: use `INSERT … WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE …)` — do not insert raw and rely on unique index errors; that pollutes logs.

If rollback is required after production deploy:
1. **DO NOT run `DROP TABLE`** on HR tables (data loss risk). Instead:
   - Apply a "disable HRMS" patch migration that adds `is_enabled = false` to `hr_settings`, and in the server code feature-flag checks that (similar to `feature-flags.ts` for Phase 2).
   - Or, apply `REVOKE SELECT/INSERT/UPDATE/DELETE ON hr_* FROM app_user` temporarily via an emergency migration if the tables cause a severe security issue. RLS is already denying access at row level, so a full REVOKE is extra-safe.
2. For code-level rollback: revert the commit(s) from Part 2/3 that introduced HR routes and re-deploy. Since no existing routes were modified, code revert is clean.
3. For RBAC pollution: delete rows added in M7 / M18 where `module LIKE 'hr_%'` from `permissions`, and delete new role names with `is_system_role=false` only. Leave `is_system_role=true` alone since future Part 3 may need them.

---

## 11. Money & Decimal Handling

### 11.1 Database Schema Convention

Pattern across Accounting/Invoices/Payment Vouchers (uniform, consistent):
- `numeric(precision: 18, scale: 2)` for money amounts (grand totals, paid amounts, voucher amounts, ledger debit/credit). Examples: `invoices.grand_total`, `payment_vouchers.amount`, `ledger_entries.debit`.
- `numeric(precision: 15, scale: 2)` for reference prices (SPA, APDL, discounts etc).
- `numeric(precision: 12, scale: 2)` for opening balances / bank transaction balances.

All `numeric` types (not float/double), all 2-decimal scale. This matches Malaysian Ringgit requirements perfectly.

**HRMS must use identical types:**
| New Field Recommendation | Type |
|---|---|
| `employee_compensation.basic_salary` | `numeric(18,2)` |
| `employee_compensation.allowance_total`, `bonus_amount` | `numeric(18,2)` |
| `hr_claim_items.amount` | `numeric(18,2)` |
| `hr_payroll_run_items.*_amount` (salary, allowance, deduction, ot, statutory) | `numeric(18,2)` |
| `hr_payslips.net_pay`, `gross_pay` | `numeric(18,2)` |
| `hr_overtime_requests.hourly_rate` | `numeric(15,4)` — hourly rate needs sub-cent precision for multiplication; round at final pay. |
| EPF/SOCSO/EIS contribution percentages | `numeric(8,4)` — e.g. 11.00% = 11.0000. |
| Leave balance days | `numeric(6,2)` — supports half-day leave. |

### 11.2 Frontend Money Utilities (可復用)

All existing utilities are in [money.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/lib/money.ts):
- `toMoneyNumber(value: unknown): number` — parses string "RM1,234.56" and `(123.45)` negative notation safely.
- `formatRMAmount(value): "RM1,234.56"` — uses `Intl.NumberFormat('en-MY')`.
- `amountToEnglishWords(value): "Ringgit Malaysia One Thousand Two Hundred Thirty Four and Sen Fifty Six"` — Malaysian legal format; needed for payslip/HR letter generation.

**Reuse these unchanged.** Do not create a second money formatter.

Server-side decimal handling:
- When reading from Drizzle, `numeric` columns come back as JS `string` → convert via `toMoneyNumber` or `Number()` for in-memory calculations, then re-save as string/number (Drizzle handles coercion). **When computing payroll totals, compute on DB side via SQL `SUM()` using numeric arithmetic, not JS floating, to avoid drift.** Round at the final aggregation step.

---

## 12. Attachment / Object Storage Handling

### 12.1 Existing Storage Abstractions

Two parallel implementations (both in same file, route chooses):
- **Google Cloud Storage**: via `@google-cloud/storage` client + Replit sidecar credential helper. Path style: `/objects/<entity>/...`; paths normalized by [ObjectStorageService](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/lib/objectStorage.ts).
- **Supabase Storage**: via `@supabase/storage-js` `SupabaseStorageService` class — methods: `uploadPrivateObject`, `deletePrivateObject`, `createSignedDownloadUrl`, `fetchPrivateObjectResponse`, `privateObjectExists`.
  - Private bucket name defaults to `lawcaspro-private` (env override `SUPABASE_STORAGE_BUCKET_PRIVATE`).
  - Signed URLs with TTL are the canonical read path for browser clients.
  - Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

Storage route already exists: [storage.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/storage.ts).

### 12.2 HRMS Document Storage Rules

**DO create a new private storage root path hierarchy** (within the same bucket; do NOT create new DB bucket for HR — bucket-per-concern is overkill here since RLS already governs DB rows):

For HR (following the `objectPath` string convention):
- Pattern: `firms/{firm_id}/hr/employees/{employee_id}/{document_category}/{yyyy}/{mm}/{random_uuid}.{ext}`
- Categories examples: `contract`, `payslip`, `medical_claim_receipt`, `disciplinary_letter`, `performance_review`, `ic_passport_scan`, `tax_form`.

**Table link pattern** (reuse `caseDocumentsTable.object_path` / `.file_name` pattern from [documents.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/documents.ts)):

```
employee_documents (already listed in M4):
  id, firm_id, employee_id, document_category,
  title, description, tags(jsonb?),
  object_path (NOT NULL), file_name, mime_type, file_size,
  uploaded_by, uploaded_at,
  is_sensitive boolean default true,
  expires_at (for temp docs like offer letters),
  checksum_sha256, version default 1,
  linked_source_type (e.g. 'hr_claim_request', 'hr_payslip'), linked_source_id
```

Index: `(firm_id, employee_id, document_category, uploaded_at DESC)`.

**Server-side download guard (Critical!):**
- Route `GET /hr-documents/:id/download` or `/hr-documents/:id/signed-url`.
- Stack `requireAuth → requireFirmUser`.
- DB SELECT on `employee_documents` (RLS already narrows to firm).
- Then authorization check:
  - Allow if caller has `hr_document.view_others` permission AND doc category not in `medical/payroll/salary_private` OR has the specific narrower permission (e.g. `hr_medical_document.view`).
  - Allow if caller's user_id matches `employees.user_id` where employees.id = employee_documents.employee_id (self-view) AND category is self-visible (e.g. payslip self is OK; disciplinary letter self visibility is firm policy-controlled).
- Only after both checks pass → call `createSignedDownloadUrl(object_path, ttlSec=300)` → redirect to signed URL, or proxy-download.
- **NEVER serve the raw Supabase/GS object path to the frontend directly.** Always go through signed URLs.

Audit every view: `action = 'hr_document.view_sensitive' | 'hr_document.view' | 'hr_document.download'`.

---

## 13. 可復用 / 需要新增 / 可能衝突 / 不能修改 總結表

### 13.1 可復用部分 (Reusable Components)

| # | Item | Where |
|---|---|---|
| 1 | Drizzle ORM, migrations folder, Drizzle config | `lib/db/*` |
| 2 | Postgres Pool + global `db` export | `lib/db/src/index.ts` (assumed export; verify at final import) |
| 3 | Tenant context + RLS helpers | [tenant-context.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/tenant-context.ts) |
| 4 | `app_user` role + `TO PUBLIC` + `FORCE RLS` policy pattern | Migration 0002 |
| 5 | Auth middleware: `requireAuth`, `requireFirmUser`, `requirePermission`, `requireReAuth`, `writeAuditLog` | [auth.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/lib/auth.ts) |
| 6 | `audit_logs` table | [cases.ts audit_logs](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/cases.ts#L379-L397) |
| 7 | `user_notifications` table + route | [accounting.ts user_notifications](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/accounting.ts#L219-L237), [user-notifications.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/user-notifications.ts) |
| 8 | Roles + permissions RBAC tables + role-name-based fallback | [roles.ts schema](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/roles.ts), [roles route](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/roles.ts) |
| 9 | Route structure: Express Router + file per domain + register in index.ts | [routes/index.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/index.ts) |
| 10 | Zod-based `CreateXxxBody`, `UpdateXxxBody` + `api-zod` package | `lib/api-zod/*` |
| 11 | Frontend React Query hooks + `@workspace/api-client-react` | (reused automatically once API contracts are published) |
| 12 | Money utilities (RM format/words/parse) | [money.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/lib/money.ts) |
| 13 | `numeric(18,2)` etc. decimal types | All accounting tables' column types |
| 14 | Object storage (Supabase/GCS) + signed URLs + ACL framework | [objectStorage.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/lib/objectStorage.ts) |
| 15 | Background job pattern (advisory lock + env gate + interval) | `artifacts/api-server/src/jobs/*` |
| 16 | Frontend layout + navigation pattern (sidebar + app-layout) | [app-layout.tsx](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/components/layout/app-layout.tsx) + [permission-guard.tsx](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/components/permission-guard.tsx) |
| 17 | Firm-level settings patterns + `accounting_settings` common fields | [accounting.ts settings](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/accounting.ts#L163-L183) |

### 13.2 需要新增部分 (New Components Required)

| # | Item | Detail |
|---|---|---|
| 1 | `employees` + 6 sensitive detail tables | Section 3 / M3–M4 |
| 2 | `departments`, `positions`, `branches`, `reporting_lines`, `employment_records` | Section 4 / M2, M5 |
| 3 | `firm_memberships` bridge (additive) | M6 |
| 4 | New System Roles: HR Manager, HR Admin, Employee | M7 |
| 5 | ~25 new `hr_*` module permissions (list in §3.1.3) | M7, M18 |
| 6 | HR approval subsystem tables | §6 user spec / M8 |
| 7 | `hr_settings` firm-level config | M9 |
| 8 | Leave, Claim, Attendance sub-systems | M10–M12 |
| 9 | Payroll + Payslip sub-system | M13 |
| 10 | Recruitment, Performance, Training, Assets | M14 |
| 11 | Onboarding/Offboarding | M15 |
| 12 | HR→Accounting integration events table | M16 |
| 13 | RLS policies for all new tables | M17 |
| 14 | 15–20 new Express route files | §9.1 |
| 15 | Corresponding `api-zod` contract schemas | §9.2 |
| 16 | Frontend pages: `/app/hr/*` + `/app/my/*` | Part 3 will detail |
| 17 | 7 new background job files | §6.3 |
| 18 | Feature flag if rollout must be phased | extend existing [feature-flags.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/lib/feature-flags.ts) |
| 19 | HR Permission Guard extension on server (row-ownership + sensitive column masking) | §8.3 |

### 13.3 可能衝突部分 (Possible Conflicts — Must Resolve During Part 2)

| # | Conflict | Parties Involved | Resolution |
|---|---|---|---|
| 1 | `users.department` (free-text) vs `departments` normalized table + `employees.department_id` | Users module vs HRMS | Keep `users.department` read-only legacy. HR source of truth = `employees.department_id`. Optional sync job to write back department name when user has linked employee. |
| 2 | `users.nric_no` / `users.bar_council_no` vs `employee_personal_details` / professional tables | Users vs HR sensitive data | Users columns remain for login context; HR MUST read/write via new Employee tables. Add documentation note: "On Employee create/update with linked User, keep them loosely synchronized by best-effort app logic; HR always owns true value." Do NOT drop user columns. |
| 3 | `users.firm_id` single-firm design vs `firm_memberships` multi-membership bridge | Users auth vs HR membership model | Keep `users.firm_id` as-is; auth still uses it. `firm_memberships` serves as HR canonical membership history and future multi-firm readiness. On user login to a firm, memberships table is cross-checked only if HRMS feature is enabled for that firm. |
| 4 | `accounting_settings` (timezone/hours/holidays) vs `hr_settings` potential duplication | Accounting vs HR | Option A: extract common "firm operating settings" to shared table (migration risk). **Option B (safer, recommended):** HR read-only loads `accounting_settings.*` for timezone/working hours/holidays ONLY if `hr_settings` columns are NULL; otherwise HR uses its own values. This allows divergence without forcing schema change now. Keep `hr_settings` columns for all HR-specific values. |
| 5 | Payment Vouchers / Ledger Entries: Can HR write them? | Accounting module vs HR module | Strictly forbidden. HR → Accounting integration via `hr_accounting_events` table only. All PV/Ledger writes continue exclusively through `payment-vouchers.ts` and accounting routes. |
| 6 | Soft delete (`deleted_at`) vs status-based lifecycle | Existing codebase convention vs HR mandate | **Accept coexistence**: Accounting/Finance/Cases tables keep `deleted_at`. HR tables use status columns. Do NOT try to "normalize" existing tables to status lifecycle. |
| 7 | Frontend Partner role currently hard-coded to see all modules; HR sensitive column masking must still apply to Partner if they lack specific `hr_*.view` permission | Frontend permissions.ts vs §8 server rule | Server-side column masking (§8.3 item 2) is authoritative. Frontend can show/hide tabs via role name heuristic as UX convenience only. |

### 13.4 不能修改部分 (Do Not Modify)

| # | Item | Reason |
|---|---|---|
| 1 | `password_hash`, TOTP fields, `last_login_at` auth columns in `users` | Auth boundary. |
| 2 | Auth middleware implementation (`requireAuth`, session lookup, token handling) | Already tested & security-audited. |
| 3 | RLS enforcement core (tenant-context.ts, app_user role, `is_founder` guard clauses) | Touching these is platform-wide risk. |
| 4 | Existing migration SQL files under `lib/db/migrations/*.sql` | Migrations are immutable; Drizzle tracks applied IDs. |
| 5 | Drizzle `schema/index.ts` export style (only `export * from "./x"`) | Downstream packages rely on it. |
| 6 | Document Generation / Document Engine core services | Explicitly out of scope per user's instruction. Do not touch `services/document-engine.service.ts`, `services/document-generation.service.ts`, or `lib/db/src/schema/documents.ts` except if HR needs to **reuse** the doc engine as a consumer call (calling existing service, not modifying it — consumer code only, allowed by spec caveat). |
| 7 | Existing roles/permissions for non-HR modules (accounting, cases, etc.) | Avoid regression. |
| 8 | Money utility functions / payroll rounding laws not yet understood | Keep existing `money.ts` exactly as-is. |
| 9 | Payment Voucher idempotency + create request tracking tables | Accounting asset. |
| 10 | Phase 2 git stash / PR #2 / Production deployment | Hard constraints from user profile and project memory. |

---

## 14. 受影響 API / Table / Page / Permission 清單 (Scope Preview)

### 14.1 Existing APIs that will be **Extended (Not Breaking)**
These are additive changes only; their existing contracts remain intact.

| API/Route | Change |
|---|---|
| `GET /roles` + roles bootstrap | Backfill will include 3 new roles (HR Manager, HR Admin, Employee). Existing role objects now include more permissions (their hr_* ones). |
| `GET/PATCH /roles/:id/permissions` | Permissions UI should allow HR modules to be toggled. |
| `GET /users`, `POST /users`, `PATCH /users/:id` | Add optional `link_to_employee_id` field (if HR user has employee record) on response only; writes remain same. **Do NOT mix employee fields into users payload.** |
| `GET /dashboard/stats` | Optional: include HR headcount widget tiles if user has `hr_employee.view` permission. (Opt-in; skip if dashboard stability is at risk.) |
| `GET /user-notifications` | Consumers will see new `source_type` values. No schema change; field is already free text. |
| `GET /audit-logs` | Consumers will see new `entity_type` and `action` values. No schema change; fields are free text. |
| Frontend sidebar (app-layout) | Add new menu section "HR" (gated by HR Admin/Partner permissions) and "My HR" / "Self-Service" (always visible for firm users, leads to `/my/*`). Gating logic lives in layout + feature flag. |

### 14.2 New APIs (All Firm-Scoped; All Under `requireFirmUser`)

Listed at high level — detailed contracts in Part 2:
- 150+ REST endpoints across ~18 HR routes.

### 14.3 New Database Tables (30-40 tables, M2–M16)

Logical count:
- Core HR structure: ~10
- Sensitive sub-tables: ~6
- Leave subsystem: ~5
- Claim subsystem: ~4
- Attendance/OT: ~4
- Payroll/Payslip: ~6
- Recruitment: ~2
- Performance: ~2
- Training: ~2
- Assets: ~2
- Onboarding/Offboarding: ~4
- Approval subsystem: ~4
- Integration events: 1
- HR settings: 1
- (Total ≈ 53; some may be merged.)

### 14.4 New Permissions (Module:Action Format)

Exact list to be seeded in M7/M18:

```text
hr_employee:view, hr_employee:edit, hr_employee:create,
hr_employee:terminate, hr_employee:reactivate,
hr_salary:view, hr_salary:edit,
hr_bank_details:view,
hr_medical_document:view,
hr_disciplinary:view,
hr_performance_private_notes:view,
hr_department:manage,
hr_position:manage,
hr_leave:view_others, hr_leave:approve, hr_leave:manage_settings,
hr_claim:view_others, hr_claim:approve, hr_claim:manage_settings,
hr_attendance:view_others, hr_attendance:edit, hr_attendance:manage_settings,
hr_overtime:view_others, hr_overtime:approve,
hr_payroll:run, hr_payroll:approve, hr_payroll:publish, hr_payroll:revert,
hr_payslip:view_others,
hr_termination:approve,
hr_recruitment:view, hr_recruitment:manage,
hr_performance:view_others, hr_performance:manage,
hr_training:view_others, hr_training:manage,
hr_asset:view_others, hr_asset:manage,
hr_onboarding:manage,
hr_offboarding:manage,
hr_document:view_others, hr_document:upload, hr_document:delete,
hr_approval_policy:manage,
hr_approval_delegation:manage,
hr_settings:manage,
hr_reporting_line:manage,
hr_integration:view_status
```

Self-service endpoints use row-ownership guard, not a separate permission, so any firm user can view their own My HR pages.

---

## 15. Verification After Part 2/3 (建議驗證清單)

Once the implementation is complete, verify:

### Build & Typecheck
```bash
# From repo root
pnpm run typecheck
pnpm run build
```
Both exit 0.

### Backend Unit Test Suites
```bash
pnpm -C artifacts/api-server run test
```
Existing 176 tests still pass (HR new tests do not regress old ones). Add new tests:
- RLS isolation test for `employees` table: 2 firms' data — cross-read returns empty.
- Permission masking test: user without `hr_salary.view` gets `null` compensation via API.
- Delegation resolver: active delegation window allows delegate to approve; audit log records acting-on-behalf-of.
- Integration event: Claim final approval → `hr_accounting_events` row created with `status='pending'`.

### Manual Verification (QA)
1. **Founder isolation check**: Login as founder → via support-session impersonate Firm A → create an employee. Switch impersonation to Firm B → confirm employee is NOT visible.
2. **HR Admin vs Employee self-service**: Create HR Admin user + regular Employee user. Employee can only reach `/my/*` pages; `GET /hr-employees` returns 403. HR Admin can list all.
3. **Partner sensitive data scope**: Partner without `hr_salary.view` permission → edit salary endpoint returns 403; GET /hr-employees/:id → `compensation` fields are nulled.
4. **Approval delegation active window**: Activate delegation, approve via delegate → audit row shows delegating partner + actual actor correctly.
5. **Accounting boundary test**: Submit + fully approve a claim → `payment_vouchers` table still has 0 rows (because integration is event-only); verify Accounting can see the event and manually create PV (that's Part 3 Accounting-side hook — to be built then).
6. **Termination offboarding trigger**: Set employee terminated with today's date. Verify case_assignments for linked user have `unassigned_at = now()` and audit trail.
7. **HR document download**: Attempt to GET a signed URL for another employee's payslip without `hr_payslip.view_others` → 403.

### Production Deployment Checks (per §0 constraints — requires explicit approval)
- Run migrations against staging first using `apply-migrations-safe.mjs`.
- Run `post-migration-verify.mjs` → `post-migration-verify-production.mjs`.
- Confirm RBAC seed migration produced 3 new roles per firm (or at least for the firm being smoke-tested).
- **Do not deploy to Production without user confirmation.** (Project memory hard constraint.)

---

## 16. Risks & Follow-up Items

| # | Risk | Mitigation |
|---|---|---|
| 1 | Migration 0127+ (many tables at once) may fail mid-apply on live DB (timeouts). | Split M1–M18 into 2–3 deploy batches. M1-7 (structure+RBAC) first, M8-13 (process core) second, M14-18 (extended+RLS+seeds) third. Each batch individually wrapped with `statement_timeout` at migration runner level. |
| 2 | `users.nric_no` currently exposed under `users:read` permission. HR's stricter `hr.*.view` on employee_personal_details does nothing for users who read the users table directly. | **Temporary**: in Part 2 patch `users` route `enrichUser()` to redact `nric_no` (return empty string) unless caller has `hr_employee.view` OR user is reading own row. Write audit when someone without elevated permission attempts it. |
| 3 | Founder support_session access to HR data lacks specific per-row HR consent. | Existing `support_sessions` already captures `action_log` jsonb and explicit consent. Add `hr_` entries to that log for every sensitive HR row read performed during a support session. |
| 4 | Payroll calculations with `numeric(18,2)` may drift due to JS floats. | Aggregate on SQL side (use `SUM()`), round explicitly at final step using `ROUND(col,2)` in SQL, and add a unit test comparing manual calculation vs SQL result for a 500-employee synthetic run. |
| 5 | HR → Accounting integration events are new asynchronous boundary. If Accounting service fails to consume, claim appears approved but no PV exists. | Add: (a) UI badge showing handoff status `(Pending / Delivered / Failed - Retry)` on each Claim; (b) background job `hr-integration-retry` to re-poll/re-deliver failed events; (c) alerting via user_notification to Account Admin + HR Manager on `Failed` status 3+ retries. |
| 6 | Part 2 implementation will be large (routes + pages + types). | Split into 3 milestone PRs (per user's 3-Part plan). Do not attempt to deliver everything in one commit. |

---

**— End of Audit —**

Next Step: Await user sign-off on architecture & migration plan. After approval, proceed to Part 2: Database Schema + Migrations + RBAC Seeds + Server Authorization Layer + Core HR Employee/Department/Position CRUD Routes + Tests.
