// M2a sign-off 2026-08-07: HR Admin intentionally NOT granted hr.salary.view;
// only Manager + explicit grant roles see salary. (product decision formalized / B0134-01)
//
// 3.2 Sensitive Permissions (Partner Permission Matrix §Decision Table 3.2):
//   hr.salary.view               — ❌ Partner default: NO. Explicit RBAC grant only.
//   hr.bank_details.view         — ❌ Partner default: NO.
//   hr.medical_document.view     — ❌ Partner default: NO.
//   hr.disciplinary.view         — ❌ Partner default: NO.
//   hr.performance_private_notes.view — ❌ NO.
//   hr.payroll.run / approve / lock / reverse — ❌ NO.
//   hr.termination.approve       — ❌ NO.
//   hr.settings.manage           — ❌ NO.

export * from "./canonical.js";
export * from "./hr-authorization.js";
export * from "./hr-domain-db.js";
export * from "./hr-feature-gate.js";
