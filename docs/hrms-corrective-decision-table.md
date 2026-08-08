# HRMS Corrective Review — A–G Formal Decision Table

Document: `docs/hrms-corrective-decision-table.md`
Status: **FORMAL APPROVAL from 2026-08-06 Corrective Directive**
Supersedes: All implicit-approval assumptions in prior architecture audit.

---

## Preamble: Implicit Approval Voided

**Rejected Interpretation (prior assistant):**
> Emitting Parts 1→3 architecture and functional spec documents is equivalent to:
> (a) approving Part 1 architecture audit,
> (b) approving 7 default decisions,
> (c) approving local migration authoring (0127–0134),
> (d) approving migration apply to Supabase,
> (e) approving deployment.

**Correct Interpretation (this document):**
Emitting specification documents is requirement clarification, **NOT** blanket approval of any architecture choice, schema, DB write, deploy, or permission expansion.
All 7 decisions below are **explicit** and any not listed below is **DENIED** until re-approved.

---

## Decision Matrix A–G

| ID | Decision | Approved Variant | Implementation Notes |
|----|----------|------------------|-----------------------|
| **A** | Shared Operating Settings Table | **A2 with safe transition** | New neutral table `firm_operating_settings` is single source of truth for `timezone`, `working_days`, `working_hours`, `public_holiday_region`, `holiday_calendar`, `weekend_rules`. HR reads only this table — HR → `accounting_settings` read path is **FORBIDDEN**. Accounting retains read compatibility during cutover window. Migration must be idempotent, backfill from existing `accounting_settings` where present via `ON CONFLICT (firm_id) DO NOTHING`, no bidirectional triggers, and documented rollback + cutover procedure. Separate `hr_organisation_settings` table (migration 0128) remains **HR-only payroll/leave settings**; does NOT overlap with shared operating columns. **Status 2026-08-06:** Migration draft created as `0135_firm_operating_settings.sql` (LOCAL DRAFT, NOT APPLIED, NOT SIGNED OFF). 12-point architecture review ⚠️ CONDITIONAL (4 app-layer blockers remain: double-write service, HR import assertion, legacy drop timing, break default ratify). Migration 0128 CRITICAL blocker downgraded from ❌ NOT APPROVED → ⚠️ CONDITIONAL pending HR cutover wiring. |
| **B** | Identity Model | **B1: Staff ∥ Employee coexist** | `Staff` = existing office admin/legal/partner role group (may hold cases/communications/finance permissions). `Employee` = HR Self-Service base role. Neither name is renamed; existing Staff role permissions are preserved. Permissions are granted **solely via firm-scoped RBAC assignment**; role name alone never triggers bulk permission grants. |
| **C** | Storage Path + Security | **C1: shared private bucket + explicit HR path** | Storage path SHALL be: `firms/{firm_id}/hr/employees/{employee_id}/{document_category}/{year}/{month}/{uuid}.{ext}`. Mandatory controls: (1) existing private bucket, (2) server-side authorization before signed URL issue, (3) short-lived signed URL, (4) per-document-category permission gate, (5) download audit, (6) explicit firm boundary check. File path alone is NOT a security control. |
| **D** | Migration Numbering | **D1: sequential 4-digit from 0127** | Existing 0127–0134 numbering is retained **but not pre-approved**. Each file must pass the 12-point corrective review (see `hrms-corrective-migration-review.md`) individually before any Supabase apply. Numbering ≠ approval. No 0135+ may be authored before review of 0127–0134 is signed off. |
| **E** | NRIC / Sensitive Identity Masking | **E1+ (strict — no empty-string mask)** | (1) Self-read endpoint may return own required fields. (2) Full NRIC and sensitive fields are returned only when caller holds **explicit** sensitive-read permission AND it is a dedicated sensitive-detail endpoint (not list endpoint). (3) Other callers get masked format `******-**-1234` if value exists, else `null`. (4) Empty string `""` is NEVER used — it conflates "no data" with "no permission". (5) Sensitive reads WRITE audit; User List never triggers audits (NRIC column excluded from list SELECT). (6) `users.nric_no` core user list SELECT must never project full NRIC without guard. |
| **F** | Milestone Split / Delivery Cadence | **F1: 4 verifiable milestones (not 2 huge PRs)** | Server + DB + permissions + unit tests must all pass before moving to the next milestone. Milestones: <br>• **M2a-Foundation** = `firm_operating_settings`, org structure, employees core, employment record, sensitive subtables, RBAC, approval policy, delegation, feature flags, RLS, audit, idempotency, error handling.<br>• **M2b-Core HR CRUD** = Departments / Positions / Branches CRUD, Employee Wizard, Employee Detail, Sensitive Data Tabs, Reporting Lines, Employment History, Documents.<br>• **M2c-Self-Service** = Attendance, Leave, Claims, My Profile, My Documents, My Requests, Notifications.<br>• **M2d-Payroll and Accounting Integration** = Payroll engine, Claim reimbursement route, Accounting payment PV route, Outbox handlers, Reconciliation. |
| **G** | HRMS Feature Flag Gate | **G1: dual layer (env + firm DB flag)** | BOTH must be true: (1) Global ENV: `process.env.ENABLE_HRMS_MODULE === "true"`; (2) Firm-level DB: `hr_firm_feature_flags.hr_enabled === true`. Frontend sidebar/redirect guard is UX-only; **every HR server API must re-check both layers independently**. Route registration: if global env flag is off, HR routers are not mounted at all (= `NOT_REGISTERED` lifecycle). If global env flag is on but firm flag off → `HR_MODULE_DISABLED` 503 JSON with code. |

---

## Voided Prior Assumptions

The following assumptions made in the prior "Phase 1 Complete" narrative are **EXPLICITLY REVOKED**:

| Revoked Item | Why | Corrective Action |
|--------------|-----|-------------------|
| Partner auto-grant of 58 HR super-admin codes | §Three explicit denial | permissions.ts Partner fallback reduced to read-only summary set (see §Partner matrix); 0134 RBAC seeding applies only to HR Manager / HR Admin / HR Employee roles, never to Partner. |
| `requireAuth as any`, `requireFirmUser as any`, `requirePermission as any` casts in HR routes | §Four prohibition: `as any` bypasses tenant isolation type guard | All 6 casts removed from hr-employees.ts. Middleware invokes without cast. Domain service now requires branded `HrDomainDb` type. |
| `db: rdb(authReq) as any` to defeat RlsDb vs Pool union | §Four core tenant-isolation violation | Replaced with `toHrDomainDb(authReq.rlsDb, caller)`. Service signature now takes `HrDomainDb` branded nominal type, runtime-asserted. Global `typeof db` cannot satisfy this type. |
| Custom bigint-string scaled arithmetic as payroll engine | §Five explicit prohibition | Replaced with `decimal.js@^10.6.0`; precision 34, ROUND_HALF_UP; all results include raw, rounded, rule version |
| `HR_SETTINGS_NOT_CONFIGURED` 503 for unimplemented endpoints | §Six: "Not Implemented" must not mask as "Not Configured" | Fake placeholders removed from employees, departments, positions, documents routers. Routes enter `NOT_REGISTERED` state (404) or are gated by `HR_MODULE_DISABLED` at mount time. |
| Phase 1 labeled "Production Ready" | §Nine corrective | Renamed to "**Phase 1 Local Foundation Draft**" because: migrations not applied, core CRUD mostly not implemented, placeholders present, tests not all-green, Partner model mismatched, `as any` casts existed, decimal engine custom. |
| Founder can silently cross-firm read HR sensitive data | §Three & §Two | Must go through explicit support/admin access flow and write audit. RLS policies alone do not constitute an access flow. |

---

## Partner Permission Matrix (Corrective §Three, replaces previous 58-code auto grant)

### 3.1 HR Backend Access Roles (entry-only gate)
These roles may enter HR backend screens but have no implicit sensitive-data grant:
- HR Admin
- HR Manager
- Partner

### 3.2 Sensitive Permissions (independently controlled)
Each must be **explicitly assigned** as RBAC row. Not auto-granted to any role name:

| Permission Code | Scope | Default on new Partner? |
|-----------------|-------|--------------------------|
| `hr.salary.view` | Read salary components, history, pay runs | ❌ No |
| `hr.salary.edit` | Adjust base/variable/pay grade | ❌ No |
| `hr.bank_details.view` | Read account number, bank, verification status | ❌ No |
| `hr.medical_document.view` | Read medical attachments & notes | ❌ No |
| `hr.disciplinary.view` | Read disciplinary records (case, finding, action) | ❌ No |
| `hr.performance_private_notes.view` | Read manager private notes | ❌ No |
| `hr.payroll.run` | Calculate / generate payroll draft | ❌ No |
| `hr.payroll.approve` | Move payroll to approved (post calculation) | ❌ No |
| `hr.payroll.lock` | Lock payroll period (no further edits) | ❌ No |
| `hr.payroll.reverse` | Reverse locked payroll (creates correction) | ❌ No |
| `hr.termination.approve` | Final approve termination / separation | ❌ No |
| `hr.settings.manage` | HR feature flags, approval policy, org structure | ❌ No |

### 3.3 Final Approver
- NOT: "any active Partner in the firm".
- IS:  "the single active Partner (user_id) explicitly configured on `hr_approval_process_definitions.default_final_approver_user_id` per firm + process, or overridden on step config".
- Approval Policy step config must enumerate explicit user_ids; role-name based final-approver resolution is FORBIDDEN.

### 3.4 New Firm Partner Defaults
A freshly created firm with a Partner user gets RBAC fallback (frontend permissions.ts only; actual DB grants must still be seeded explicitly by migration 0134 pattern):
- ✅ HR Dashboard view (summary tiles: headcount, leave pending, pending approvals, overdue)
- ✅ Employee basic list + basic detail view (name, department, position, status, join date) — NOT salary, NOT bank, NOT medical/disciplinary
- ✅ Attendance summary / Leave summary / Pending Approvals summary
- ✅ Approval delegation grant (`hr_approval:delegate`)
- ✅ Overdue approval notifications
- ❌ NOT: `hr_settings.manage_organisation`
- ❌ NOT: any salary/bank/medical/disciplinary/performance private view/edit
- ❌ NOT: payroll run/approve/lock/reverse
- ❌ NOT: termination approve
- ❌ NOT: settings manage
- ❌ NOT: auto Final Approver on flows

---

## Placeholder Route Lifecycle Spec (Corrective §Six)

Every HR endpoint SHALL be classified into exactly one of four lifecycle states:

| State | Semantic | HTTP behavior |
|-------|----------|---------------|
| `NOT_REGISTERED` | Endpoint not implemented, router not mounted or handler not defined | Standard 404 NOT_FOUND JSON via app not-found handler. **Do NOT fake 503.** |
| `FEATURE_DISABLED` | Global env flag `ENABLE_HRMS_MODULE` is off OR firm-level `hr_enabled` is off | 503 Service Unavailable JSON with `error.code = HR_MODULE_DISABLED`. |
| `NOT_CONFIGURED` | Feature is enabled for the firm, but a pre-requisite configuration (e.g., approval process definition, pay calendar, EPF SOCSO rules) is absent in HR domain tables | 400 Bad Request JSON with `error.code = HR_SETTINGS_NOT_CONFIGURED`. Body must name the exact missing configuration key. |
| `IMPLEMENTED` | Fully implemented. Unit + integration tests green. RBAC, RLS, audit, optimistic lock, idempotency all active. | 2xx/4xx/5xx per API contract |

**Anti-pattern (prohibited)**
Returning `HR_SETTINGS_NOT_CONFIGURED` / 503 / 400 with "will be available in next rollout" message for endpoints that are simply not written yet. This confuses operators who then troubleshoot a configuration problem that does not exist. Correct state is `NOT_REGISTERED`.

---

## Data Dictionary: Money / Decimal Precision (Corrective §Five)

| Semantic | DB Type | JSON Format | Engine | Precision & Rounding |
|----------|---------|-------------|--------|----------------------|
| Salary / Payroll / Claim Currency Amounts | `numeric(19,4)` | decimal string (not JS number) | `decimal.js@^10.6.0` | Internal calc 4dp, display & disbursement 2dp |
| Statutory Percentages (EPF/SOCSO/EIS/PCB rates) | `numeric(8,6)` | decimal string | `decimal.js@^10.6.0` | Rate versioned per calendar year + government circular; rule version stored with each calc result |
| Leave Days / Hours | `numeric(10,2)` | decimal string | `decimal.js@^10.6.0` | Half-day units only |
| Payroll Aggregation (SQL SUM) | `numeric(19,4)` | decimal string | Postgres + `decimal.js` reconcile | DB aggregation for reports only; statutory engine MUST remain the authoritative calc path. Never use SQL SUM alone to produce statutory deductions. |

Result record for every statutory or payroll operation:
```typescript
{
  rawAmount: string;        // toFixed(4) decimal string (pre-rounding)
  roundedAmount: string;    // toFixed(2) decimal string (disbursement)
  roundingRule: "ROUND_HALF_UP_2DP" | "ROUND_HALF_UP_4DP" | "TRUNCATE_4DP";
  roundingMode: number;     // Decimal.js rounding mode integer
  ruleVersion: string;      // e.g., "EPF_MALAYSIA_2024_V1"
  calculationSource: string; // function / class name for traceability
}
```

**Status 2026-08-06 Money Contract Enforcement:**
- `rawAmount` is always 4 decimal places and `roundedAmount` is always 2 decimal places (enforced explicitly in `formatResult` regardless of the roundingRule selected — fixes prior case where `TRUNCATE_4DP` leaked `0.0001` as roundedAmount and `ROUND_HALF_UP_4DP` leaked `3.7500`).
- `roundingMode` type is no longer an accidental single-literal-narrowed type. Canonical type `HRRoundingMode = typeof Decimal.ROUND_HALF_UP | typeof Decimal.ROUND_DOWN | ...` union of 7 Decimal rounding constants; exported aliases `HR_ROUNDING_MODE_HALF_UP` and `HR_ROUNDING_MODE_TRUNCATE` (Decimal.ROUND_DOWN) used in implementation. Zero `as any` / `@ts-ignore`.

AUDIT existing inconsistencies across 0127–0134 (see migration review doc):
- `hr_employee_salaries.amount` correctly uses `numeric(19,4)`. ✅
- `hr_employment_records.salary_amount_old / salary_amount_new` correctly uses `numeric(19,4)`. ✅
- `hr_organisation_settings.require_claim_attachment_over_amount` correctly uses `numeric(19,4)`. ✅
- `hr_employee_leave_balances.*` uses `numeric(10,2)` — correct for day-count per data-dictionary above. ✅
- No instances of `numeric(18,2)` or `numeric(15,4)` or `numeric(6,2)` found in HR migrations. ✅

---

## NRIC Masking Specification (Corrective §E1+)

Decision tree executed at API serialization layer:

```
IF it is a User List / Employee List (paginated GET /api/users or GET /api/hr-employees):
  → NEVER select full nric_no / ic_passport_no column.
  → If caller holds sensitive-read perm AND needs masked-only-for-non-self, still do NOT project full column on list endpoint; save it for dedicated detail endpoint.

IF request is to dedicated /api/hr-employees/:id (detail) OR /api/users/:id (detail):
  IF self-read (caller user_id === employee.linked_user_id === target user_id):
    → Full values authorized. Write audit (self-read of sensitive data).
  ELSE IF caller holds explicit hr.bank_details.view + hr.salary.view analog (identity sensitive perm) AND firm scoped:
    → Full values authorized. Write audit (sensitive-read).
  ELSE:
    IF value exists:
      → Apply Malaysian NRIC mask: `******-**-` + last 4 chars of non-dash stripped, then reformat to standard group.
    ELSE:
      → null. NEVER empty string.
```

Empty string `""` semantic: NEVER used. It confuses "there is no data" with "you can't see the data". All masked fields use either masked form `******-**-1234` (for existing value without permission) OR `null` (for no value or no permission + no-data case — distinguish by `field_present` boolean if caller needs to know).

---

## Deliverable Sign-off

This decision table is the **sole authority** for 7 decision items A–G. Any change requires explicit new directive from the user. Implicit approval from prior documents (Part 1 / Part 2 / Part 3 specs) is void.
