## Feature Visibility Matrix (PART 2 §10 update) — Lawcaspro v5

_Generated: 2026-08-13T11:44:31.465Z_
_lastVerifiedSha: 111e2598d0687aef0ef5a054dbdc5c44bbf1f80f_ (hotfix/session-workbench-stability after Part1+Part2 minimal edits)

### PART 2 §10 — New columns added:
- `runtimeReadiness`: `PAGE_AND_READ_API_OK` / `PAGE_ONLY_UNTESTED` / `NOT_READY_BACKEND_MISSING` / `BROKEN_ERROR_BOUNDARY` / `INTENTIONALLY_HIDDEN`
- `lastVerifiedSha`: SHA when the row was last classified
- `readOnlyApiStatus`: `READ_GREEN_200` / `READ_401_UNAUTHENTICATED` / `UNTESTED`
- `manualTestRequired`: `true` / `false` — whether a Founder manual click-through is recommended before exposing wider

### Summary by Status

| Status | Count |
|---|---:|
| READY_VISIBLE | 127 |
| INTENTIONALLY_HIDDEN | 60 |
| NOT_READY | 51 |

### Summary by Module (with PART 2 §7 classification)

| Module | Total Features | READY_VISIBLE | Hidden/Not Ready | §7 Runtime Readiness Estimate | manualTestRequired Recommended |
|---|---:|---:|---:|---|---:|
| dashboard | 8 | 7 | 1 | dashboard.landing = READY_READ_ONLY; dashboard.workbench = NOT_READY_BACKEND (BE contract missing) | true |
| cases | 30 | 28 | 2 | READY_READ_ONLY (landing + detail shell) | true |
| documents | 16 | 12 | 4 | READY_READ_ONLY (landing / templates / word/pdf/variables) | true |
| accounting | 29 | 29 | 0 | READY_FOR_FOUNDER_TEST (read-only APIs green per Part 2 §6, §8: Partner/AccountM/AccountA only) | true |
| communications | 20 | 14 | 6 | communications.hub READY_READ_ONLY (§19 email landing) | true |
| reports | 10 | 10 | 0 | READY_READ_ONLY (reports shell render only, real query by role) | true |
| settings | 12 | 8 | 4 | settings.firm / case / reference / hr READY_READ_ONLY | true |
| projects | 8 | 8 | 0 | READY_READ_ONLY (landing shell) | true |
| developers | 5 | 5 | 0 | READY_READ_ONLY (landing shell) | true |
| audit | 3 | 3 | 0 | READY_READ_ONLY (read-only list/export) | true |
| contacts | 7 | 1 | 6 | contacts.clients = READY_READ_ONLY; others NOT_READY_BACKEND | true |
| rbac | 10 | 2 | 8 | rbac.users / roles READY_READ_ONLY; rest NOT_READY_BACKEND | true |
| hr | 22 | 0 | 22 | §21 landing shell = HIDDEN_BY_FEATURE (HIDDEN_PHASE_2); self-service only §8. File on disk pages render (compilation gate already passes) but nav not exposed | true (phase rollout) |
| notifications | 10 | 0 | 10 | NOT_READY_BACKEND (BE endpoints missing) | false (hidden) |
| hims | 12 | 0 | 12 | INTENTIONALLY_HIDDEN (HIDDEN_PHASE_3) | false (phase 3) |
| einvoice | 11 | 0 | 11 | INTENTIONALLY_HIDDEN (HIDDEN_PHASE_2) | false (phase 2) |
| ekyc | 5 | 0 | 5 | NOT_READY | false |
| storage | 4 | 0 | 4 | storage.file_custody = INTENTIONALLY_HIDDEN (always hidden per §8) | false (never visible) |
| ai | 6 | 0 | 6 | INTENTIONALLY_HIDDEN (HIDDEN_PHASE_3) | false (phase 3) |
| platform | 10 | 0 | 10 | §23 Founder-only = NOT_READY_BACKEND (most routes BE contract missing; platform dashboard frontend module imports PASS per §11) | true |

---

## All Features (extended §10 columns appended to right)

| featureKey | module | intended | page | route | nav | fg | perm | be route | be fg | api | test | status | reason | runtimeReadiness | lastVerifiedSha | readOnlyApiStatus | manualTestRequired
|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|---|---|---|---|---:|
| module.dashboard | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | READ_GREEN_200_LOCAL_VITEST | true |
| dashboard.firm | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| dashboard.partner | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| dashboard.management | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| dashboard.workbench | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| dashboard.kpi | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| dashboard.approvals | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| dashboard.alerts | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.cases | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | READ_GREEN_200_LOCAL_VITEST | true |
| cases.read | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.create | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED (§5: NO mutation) | 111e259 | UNTESTED | true |
| cases.legacy_import | cases | ACTIVE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.overview | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.parties | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.property | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.loan | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.reference | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.tasks | cases | ACTIVE | ⛔ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| cases.timeline | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.documents | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.supporting_documents | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.notes | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.assignment | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| cases.approval | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| cases.amendment | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| cases.key_dates | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.workflow | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.batch_update | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| cases.batch_print | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| cases.developer_sales | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.subsale | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.perfection | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.intake | cases | ACTIVE | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| cases.conflict_check | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.monitor | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| cases.export | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| limit.cases.max | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| limit.cases.monthly_new | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.developers | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| developers.read | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| developers.create | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| developers.edit | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| developers.codes | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.projects | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| projects.read | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| projects.create | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| projects.edit | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| projects.phases | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| projects.units | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| projects.reference_config | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| projects.hims_mapping | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.documents | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | READ_GREEN_200_LOCAL_VITEST | true |
| documents.hub | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.templates | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.templates.founder | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.templates.firm | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.word | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.pdf | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.variables | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.batch | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| documents.generated | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.versioning | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| documents.ocr | documents | HIDDEN_PHASE_3 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | INTENTIONALLY_HIDDEN | 111e259 | UNTESTED | false |
| documents.ai_read | documents | HIDDEN_PHASE_3 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | INTENTIONALLY_HIDDEN | 111e259 | UNTESTED | false |
| documents.ai_migration | documents | HIDDEN_PHASE_3 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | INTENTIONALLY_HIDDEN | 111e259 | UNTESTED | false |
| documents.logs | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| limit.documents.generation_monthly | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.accounting | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK (§8: Partner/AccountM/AccountA only) | 111e259 | READ_GREEN_200_LOCAL_VITEST | true |
| accounting.dashboard | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.quotation | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.invoice | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.receipt | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.payment_voucher | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.payment_voucher.create | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| accounting.payment_voucher.submit | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| accounting.payment_voucher.approval | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| accounting.file_listing | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.client_ledger | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.case_ledger | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.office_ledger | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.trust_account | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.trust_statement | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.stakeholder | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.disbursement | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.professional_fees | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.travelling | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.miscellaneous | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.overcollection | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.office_income | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.bank_transaction | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.bank_reconciliation | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.payment | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| accounting.refund | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| accounting.reports | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| accounting.approvals | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| accounting.notifications | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.einvoice | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | INTENTIONALLY_HIDDEN | 111e259 | UNTESTED | false |
| module.communications | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| communications.email | communications | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| communications.hub | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.hr | hr | ACTIVE | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | HIDDEN_BY_FEATURE (phase) | 111e259 | UNTESTED | true |
| hr.dashboard | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.employees | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.departments | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.positions | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.attendance | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.leave | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.claims | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.payroll | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.onboarding | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.offboarding | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.recruitment | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.performance | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.training | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.assets | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.documents | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.notifications | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.approvals | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.self_service | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE (§8 other staff: self only; nav not exposed yet) | 111e259 | UNTESTED | true |
| hr.reports | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.settings | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | true |
| hr.integration_events | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — | HIDDEN_BY_FEATURE | 111e259 | UNTESTED | false |
| module.rbac | rbac | ACTIVE | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| rbac.users | rbac | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| rbac.users.create | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| rbac.users.invitations | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| rbac.users.assignments | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| rbac.users.initials | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| rbac.roles | rbac | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| rbac.permissions | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| rbac.departments | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| limit.users.max | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| module.contacts | contacts | ACTIVE | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| contacts.clients | contacts | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| module.notifications | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | false |
| module.hims | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | INTENTIONALLY_HIDDEN | 111e259 | UNTESTED | false |
| hims.* (12 rows compacted) | hims | HIDDEN_PHASE_3 | ⛔/✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅/⛔ | **INTENTIONALLY_HIDDEN** | HIDDEN_PHASE_3 | INTENTIONALLY_HIDDEN | 111e259 | UNTESTED | false |
| module.ekyc | ekyc | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ⛔ | **NOT_READY** | No frontend, route, nav or backend route + API contract. | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | false |
| module.reports | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.case | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.accounting | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.hr | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.management | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.status | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.productivity | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.audit | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| reports.export_pdf | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| reports.export_excel | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| module.settings | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.firm | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.case | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.reference | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.accounting | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| settings.hr | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.email | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| settings.document | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| settings.notifications | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.integrations | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.subscription | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| settings.logs | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| module.storage | storage | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | false |
| storage.file_custody | storage | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | File Custody always hidden per §8 | INTENTIONALLY_HIDDEN | 111e259 | COMPILE_OK_ONLY (module smoke §12) | false |
| storage.uploads | storage | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | false |
| limit.storage.gb | storage | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | false |
| module.ai | ai | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — | INTENTIONALLY_HIDDEN | 111e259 | UNTESTED | false |
| module.audit | audit | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| audit.logs | audit | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_AND_READ_API_OK | 111e259 | UNTESTED | true |
| audit.export | audit | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — | PAGE_ONLY_UNTESTED | 111e259 | UNTESTED | true |
| module.platform | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). Most platform routes missing. | NOT_READY_BACKEND_MISSING | 111e259 | READ_401_UNAUTHENTICATED_ONLY | true |
| platform.firms | platform | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.plans | platform | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.billing | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.audit | platform | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.ops_center | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.approvals | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.support_sessions | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.incident_center | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
| platform.governance | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). | NOT_READY_BACKEND_MISSING | 111e259 | UNTESTED | true |
