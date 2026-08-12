# Feature Visibility Matrix — Lawcaspro v5

_Generated: 2026-08-12T11:44:31.465Z_

## Summary by Status

| Status | Count |
|---|---:|
| READY_VISIBLE | 127 |
| INTENTIONALLY_HIDDEN | 60 |
| NOT_READY | 51 |

## Summary by Module

| Module | Total Features | READY_VISIBLE | Hidden/Not Ready |
|---|---:|---:|---:|
| accounting | 29 | 29 | 0 |
| ai | 6 | 0 | 6 |
| audit | 3 | 3 | 0 |
| cases | 30 | 28 | 2 |
| communications | 20 | 14 | 6 |
| contacts | 7 | 1 | 6 |
| dashboard | 8 | 7 | 1 |
| developers | 5 | 5 | 0 |
| documents | 16 | 12 | 4 |
| einvoice | 11 | 0 | 11 |
| ekyc | 5 | 0 | 5 |
| hims | 12 | 0 | 12 |
| hr | 22 | 0 | 22 |
| notifications | 10 | 0 | 10 |
| platform | 10 | 0 | 10 |
| projects | 8 | 8 | 0 |
| rbac | 10 | 2 | 8 |
| reports | 10 | 10 | 0 |
| settings | 12 | 8 | 4 |
| storage | 4 | 0 | 4 |

## All Features

| featureKey | module | intended | page | route | nav | fg | perm | be route | be fg | api | test | status | reason
|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|---|
| module.dashboard | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| dashboard.firm | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| dashboard.partner | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| dashboard.management | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| dashboard.workbench | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| dashboard.kpi | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| dashboard.approvals | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| dashboard.alerts | dashboard | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.cases | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.read | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.create | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.legacy_import | cases | ACTIVE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.overview | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.parties | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.property | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.loan | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.reference | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.tasks | cases | ACTIVE | ⛔ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| cases.timeline | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.documents | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.supporting_documents | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.notes | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.assignment | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.approval | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.amendment | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.key_dates | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.workflow | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.batch_update | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.batch_print | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.developer_sales | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.subsale | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.perfection | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.intake | cases | ACTIVE | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| cases.conflict_check | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.monitor | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| cases.export | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| limit.cases.max | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| limit.cases.monthly_new | cases | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.developers | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| developers.read | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| developers.create | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| developers.edit | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| developers.codes | developers | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.projects | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| projects.read | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| projects.create | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| projects.edit | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| projects.phases | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| projects.units | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| projects.reference_config | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| projects.hims_mapping | projects | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.documents | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.hub | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.templates | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.templates.founder | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.templates.firm | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.word | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.pdf | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.variables | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.batch | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.generated | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.versioning | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| documents.ocr | documents | HIDDEN_PHASE_3 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| documents.ai_read | documents | HIDDEN_PHASE_3 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| documents.ai_migration | documents | HIDDEN_PHASE_3 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| documents.logs | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| limit.documents.generation_monthly | documents | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.accounting | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.dashboard | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.quotation | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.invoice | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.receipt | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.payment_voucher | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.payment_voucher.create | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.payment_voucher.submit | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.payment_voucher.approval | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.file_listing | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.client_ledger | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.case_ledger | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.office_ledger | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.trust_account | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.trust_statement | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.stakeholder | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.disbursement | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.professional_fees | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.travelling | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.miscellaneous | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.overcollection | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.office_income | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.bank_transaction | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.bank_reconciliation | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.payment | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.refund | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.reports | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.approvals | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| accounting.notifications | accounting | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.einvoice | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.individual | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.consolidated | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.submit | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.status | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.credit_note | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.debit_note | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.refund_note | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.validation | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.lhdn_integration | einvoice | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| einvoice.logs | einvoice | HIDDEN_PHASE_2 | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| module.communications | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email | communications | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| communications.email.settings | communications | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| communications.email.m365 | communications | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| communications.email.imap | communications | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| communications.email.gmail | communications | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| communications.email.folders | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.mark_read | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.reply | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.forward | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.remarks | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.assign_user | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.link_case | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.search | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.sla | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.task | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.sync | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.email.logs | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| communications.whatsapp | communications | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| communications.hub | communications | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.hr | hr | ACTIVE | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| hr.dashboard | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.employees | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.departments | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hr.positions | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hr.attendance | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.leave | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.claims | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.payroll | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.onboarding | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.offboarding | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.recruitment | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.performance | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.training | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.assets | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.documents | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.notifications | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.approvals | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.self_service | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.reports | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.settings | hr | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hr.integration_events | hr | HIDDEN_PHASE_2 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| module.rbac | rbac | ACTIVE | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| rbac.users | rbac | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| rbac.users.create | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| rbac.users.invitations | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| rbac.users.assignments | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| rbac.users.initials | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| rbac.roles | rbac | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| rbac.permissions | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| rbac.departments | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| limit.users.max | rbac | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| module.contacts | contacts | ACTIVE | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| contacts.clients | contacts | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| contacts.borrowers | contacts | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| contacts.vendors | contacts | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| contacts.banks | contacts | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| contacts.developers_contact | contacts | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| contacts.other_parties | contacts | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| module.notifications | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.in_app | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.red_dot | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.approval | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.case | notifications | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.accounting | notifications | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.pv_escalation | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.lawyer | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.manager | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| notifications.partner_escalation | notifications | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| module.hims | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hims.tracker | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hims.credentials | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hims.project_mapping | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hims.unit_lot_title | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hims.espa_status | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| hims.spa_tracker | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hims.spa_stamped_handover | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hims.status_check | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hims.compare_lawcaspro_hims | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hims.compare_lawcaspro_ekyc | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| hims.notifications | hims | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| module.ekyc | ekyc | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ⛔ | **NOT_READY** | No frontend page, route, nav entry and no backend route + API contract. |
| ekyc.verify | ekyc | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ✅ | **NOT_READY** | No frontend page, route, nav entry and no backend route + API contract. |
| ekyc.status | ekyc | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ✅ | **NOT_READY** | No frontend page, route, nav entry and no backend route + API contract. |
| ekyc.comparison | ekyc | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ⛔ | **NOT_READY** | No frontend page, route, nav entry and no backend route + API contract. |
| ekyc.history | ekyc | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ | ⛔ | ✅ | **NOT_READY** | No frontend page, route, nav entry and no backend route + API contract. |
| module.reports | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.case | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.accounting | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.hr | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.management | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.status | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.productivity | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.audit | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.export_pdf | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| reports.export_excel | reports | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.settings | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.firm | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.case | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.reference | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.accounting | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| settings.hr | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.email | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| settings.document | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| settings.notifications | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.integrations | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.subscription | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| settings.logs | settings | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| module.storage | storage | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| storage.file_custody | storage | HIDDEN_PHASE_2 | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| storage.uploads | storage | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| limit.storage.gb | storage | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| module.ai | ai | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| ai.ocr | ai | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| ai.draft | ai | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **INTENTIONALLY_HIDDEN** | — |
| ai.reading | ai | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| limit.ai.ocr_pages_monthly | ai | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| limit.ai.draft_tokens_monthly | ai | HIDDEN_PHASE_3 | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **INTENTIONALLY_HIDDEN** | — |
| module.audit | audit | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| audit.logs | audit | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| audit.export | audit | ACTIVE | ✅ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | **READY_VISIBLE** | — |
| module.platform | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.firms | platform | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.plans | platform | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.billing | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.audit | platform | ACTIVE | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.ops_center | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.approvals | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ✅ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.support_sessions | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.incident_center | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
| platform.governance | platform | ACTIVE | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ⛔ | ⛔ | **NOT_READY** | Backend service exists without endpoint contract (zod / open handler). |
