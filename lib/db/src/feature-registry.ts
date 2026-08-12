/**
 * Global Feature Registry — Lawcaspro single source of truth for configurable
 * features across platform admin and firm control layers.
 *
 * Principles (Part 2 §11 + §3 + §12):
 *  1. Unknown / unregistered configurable feature = DENY BY DEFAULT.
 *  2. Every feature has stable technical key (not display name).
 *  3. Parent-child: parent OFF → all children effective OFF without touching
 *     child stored override. So when parent ON later, child config restored.
 *  4. Dependency array = auto-checked during resolution.
 *  5. Backend guards, route guards, sidebar guards, job guards all consume
 *     this registry + entitlement resolver, never ad-hoc plan==="pro" checks.
 *  6. Each feature records: route_hint, backend_guard_key, job_guards, and
 *     module for founder UI grouping.
 *
 * Registry layers:
 *   - TypeScript REGISTRY array (this file) → developer-managed source of truth
 *   - platform_features DB table (mirror, created by seeding from this array)
 *   - plan_entitlements (plan-level default)
 *   - firm_entitlement_overrides (firm-level permanent + temporary)
 *   - EntitlementResolver (runtime 9-layer merge)
 */

export type FeatureValueType = "boolean" | "integer" | "decimal" | "string" | "config" | "unlimited";
export type FeatureStatus = "active" | "inactive" | "deprecated" | "emergency_disabled";

export interface FeatureDefinition {
  featureKey: string;
  name: string;
  module:
    | "dashboard"
    | "cases"
    | "developers"
    | "projects"
    | "documents"
    | "accounting"
    | "einvoice"
    | "communications"
    | "hr"
    | "rbac"
    | "contacts"
    | "notifications"
    | "hims"
    | "ekyc"
    | "reports"
    | "settings"
    | "storage"
    | "ai"
    | "audit"
    | "platform"
    | "governance";
  parentFeatureKey?: string | null;
  valueType: FeatureValueType;
  defaultValue?: unknown;
  /** Dependencies on sibling features — all must be enabled. */
  dependencies?: readonly string[];
  configurable?: boolean;
  founderOnly?: boolean;
  /** Hint for route/sidebar rendering — usually the page path prefix. */
  routeHint?: string | null;
  /** Code-level permission-action hint (for RBAC mapping). */
  backendGuardKey?: string | null;
  /** Whether this feature is controlled per plan (base plan includes it). */
  planControlled?: boolean;
  /** Whether founder can create a firm-level override for this feature. */
  firmControlledOverride?: boolean;
  /** Job / worker / notification guard keys gated by this feature. */
  jobGuards?: readonly string[];
  status?: FeatureStatus;
  /** Display group / UI expansion ordering inside module. */
  sortOrder?: number;
  description?: string;
}

/**
 * Macro helpers — keep registry compact while preserving tree structure.
 * Module() → submodule() → feature() → action() pattern.
 * Each helper deep-merges module/submodule context into children.
 */

type PartialFeat = Partial<FeatureDefinition> & Pick<FeatureDefinition, "featureKey" | "name">;

function asFeat(
  module: FeatureDefinition["module"],
  parent: string | null,
  defaults: Partial<FeatureDefinition>,
  list: PartialFeat[],
): FeatureDefinition[] {
  return list.map((p) => {
    const valueType: FeatureValueType = (p.valueType as FeatureValueType) ?? "boolean";
    const configurable = p.configurable ?? true;
    const planControlled = p.planControlled ?? true;
    const firmControlledOverride = p.firmControlledOverride ?? true;
    return {
      featureKey: p.featureKey,
      name: p.name,
      module,
      parentFeatureKey: p.parentFeatureKey ?? parent ?? null,
      valueType,
      defaultValue:
        p.defaultValue !== undefined
          ? p.defaultValue
          : valueType === "boolean"
          ? true
          : valueType === "integer" || valueType === "decimal"
          ? 0
          : valueType === "unlimited"
          ? -1
          : null,
      dependencies: Array.isArray(p.dependencies) ? [...p.dependencies] : undefined,
      configurable,
      founderOnly: p.founderOnly ?? false,
      routeHint: p.routeHint ?? defaults.routeHint ?? null,
      backendGuardKey: p.backendGuardKey ?? defaults.backendGuardKey ?? null,
      planControlled,
      firmControlledOverride,
      jobGuards: Array.isArray(p.jobGuards) ? [...p.jobGuards] : undefined,
      status: (p.status as FeatureStatus) ?? "active",
      sortOrder: p.sortOrder,
      description: p.description,
    } satisfies FeatureDefinition;
  });
}

// -----------------------------------------------------------------------------
// 1. DASHBOARD
// -----------------------------------------------------------------------------

const DASHBOARD: FeatureDefinition[] = asFeat("dashboard", null, { routeHint: "/app/dashboard" }, [
  { featureKey: "module.dashboard", name: "Dashboard (all firm dashboards)", valueType: "boolean", defaultValue: true, configurable: true, description: "Top-level dashboard feature module. If OFF, no dashboard pages visible." },
  { featureKey: "dashboard.firm", name: "Firm Dashboard", parentFeatureKey: "module.dashboard", routeHint: "/app/dashboard" },
  { featureKey: "dashboard.partner", name: "Partner Dashboard", parentFeatureKey: "module.dashboard" },
  { featureKey: "dashboard.management", name: "Management Dashboard", parentFeatureKey: "module.dashboard" },
  { featureKey: "dashboard.workbench", name: "My Work / Workbench", parentFeatureKey: "module.dashboard", routeHint: "/app/workbench" },
  { featureKey: "dashboard.kpi", name: "KPI Widgets", parentFeatureKey: "module.dashboard" },
  { featureKey: "dashboard.approvals", name: "Pending Approvals Widget", parentFeatureKey: "module.dashboard", jobGuards: ["payment_voucher_sla"] },
  { featureKey: "dashboard.alerts", name: "Alerts / Escalations Widget", parentFeatureKey: "module.dashboard", jobGuards: ["case_bottleneck", "completion_sla"] },
]);

// -----------------------------------------------------------------------------
// 2. CASES (§ Part 2 §2 CASES complete)
// -----------------------------------------------------------------------------

const CASES: FeatureDefinition[] = asFeat("cases", null, { routeHint: "/app/cases", backendGuardKey: "cases" }, [
  { featureKey: "module.cases", name: "Cases", valueType: "boolean" },
  { featureKey: "cases.read", name: "View / Search / Archive Cases", parentFeatureKey: "module.cases", backendGuardKey: "cases:read" },
  { featureKey: "cases.create", name: "Create New Case", parentFeatureKey: "module.cases", backendGuardKey: "cases:create", jobGuards: [] },
  { featureKey: "cases.legacy_import", name: "Legacy Excel Import (Historical Cases)", parentFeatureKey: "module.cases", firmControlledOverride: true, backendGuardKey: "cases" },
  { featureKey: "cases.overview", name: "Case Overview Tab", parentFeatureKey: "module.cases", routeHint: "/app/cases/:id" },
  { featureKey: "cases.parties", name: "Parties Tab (purchasers/borrowers/vendors)", parentFeatureKey: "module.cases", backendGuardKey: "cases:read" },
  { featureKey: "cases.property", name: "Property Info Tab", parentFeatureKey: "module.cases" },
  { featureKey: "cases.loan", name: "Loan Info Tab", parentFeatureKey: "module.cases" },
  { featureKey: "cases.reference", name: "Reference Numbers + History + Suggestions", parentFeatureKey: "module.cases" },
  { featureKey: "cases.tasks", name: "Case Tasks", parentFeatureKey: "module.cases", routeHint: "/app/cases/:id/tasks", backendGuardKey: "cases:update" },
  { featureKey: "cases.timeline", name: "Case Timeline", parentFeatureKey: "module.cases" },
  { featureKey: "cases.documents", name: "Case Documents Tab", parentFeatureKey: "module.cases", dependencies: ["module.documents"], backendGuardKey: "documents:read" },
  { featureKey: "cases.supporting_documents", name: "Case Supporting Documents Tab", parentFeatureKey: "module.cases", dependencies: ["module.documents"] },
  { featureKey: "cases.notes", name: "Case Notes", parentFeatureKey: "module.cases" },
  { featureKey: "cases.assignment", name: "Case Assignment + Bulk Assign", parentFeatureKey: "module.cases", backendGuardKey: "cases:update" },
  { featureKey: "cases.approval", name: "Case Approval (approve/reject/resubmit)", parentFeatureKey: "module.cases", backendGuardKey: "cases:update" },
  { featureKey: "cases.amendment", name: "Case Amendment / Edit key fields", parentFeatureKey: "module.cases", backendGuardKey: "cases:update" },
  { featureKey: "cases.key_dates", name: "Key Dates / Milestones", parentFeatureKey: "module.cases" },
  { featureKey: "cases.workflow", name: "Workflow Steps + Attachments", parentFeatureKey: "module.cases" },
  { featureKey: "cases.batch_update", name: "Batch Update (cases)", parentFeatureKey: "module.cases", backendGuardKey: "cases:update" },
  { featureKey: "cases.batch_print", name: "Batch Print (case documents)", parentFeatureKey: "module.cases", backendGuardKey: "documents:read" },
  // Sub-types
  { featureKey: "cases.developer_sales", name: "Developer Sales Cases (perfection)", parentFeatureKey: "module.cases" },
  { featureKey: "cases.subsale", name: "Subsale Cases", parentFeatureKey: "module.cases" },
  { featureKey: "cases.perfection", name: "Perfection Steps", parentFeatureKey: "module.cases" },
  // Advanced
  { featureKey: "cases.intake", name: "Intake Inbox", parentFeatureKey: "module.cases", routeHint: "/app/cases/intake" },
  { featureKey: "cases.conflict_check", name: "Conflict Check", parentFeatureKey: "module.cases", dependencies: ["module.cases"] },
  { featureKey: "cases.monitor", name: "Case Monitor (SLAs)", parentFeatureKey: "module.cases", jobGuards: ["case_bottleneck", "completion_sla"] },
  { featureKey: "cases.export", name: "Case Export (CSV)", parentFeatureKey: "cases.read" },
  { featureKey: "limit.cases.max", name: "Max Active Cases", parentFeatureKey: "module.cases", valueType: "integer", defaultValue: -1, description: "-1 = unlimited" },
  { featureKey: "limit.cases.monthly_new", name: "Max New Cases/Month", parentFeatureKey: "module.cases", valueType: "integer", defaultValue: -1 },
]);

// -----------------------------------------------------------------------------
// 3. DEVELOPERS / PROJECTS / PHASES / UNITS
// -----------------------------------------------------------------------------

const DEVELOPERS: FeatureDefinition[] = asFeat("developers", null, { routeHint: "/app/developers" }, [
  { featureKey: "module.developers", name: "Developers", valueType: "boolean" },
  { featureKey: "developers.read", name: "View Developers", parentFeatureKey: "module.developers" },
  { featureKey: "developers.create", name: "Create Developer", parentFeatureKey: "module.developers" },
  { featureKey: "developers.edit", name: "Edit Developer", parentFeatureKey: "module.developers" },
  { featureKey: "developers.codes", name: "Developer/Project Codes Config", parentFeatureKey: "module.developers" },
]);

const PROJECTS: FeatureDefinition[] = asFeat("projects", null, { routeHint: "/app/projects" }, [
  { featureKey: "module.projects", name: "Projects", valueType: "boolean" },
  { featureKey: "projects.read", name: "View Projects", parentFeatureKey: "module.projects" },
  { featureKey: "projects.create", name: "Create Project", parentFeatureKey: "module.projects" },
  { featureKey: "projects.edit", name: "Edit Project", parentFeatureKey: "module.projects" },
  { featureKey: "projects.phases", name: "Phases Management", parentFeatureKey: "module.projects" },
  { featureKey: "projects.units", name: "Units/Lots Management", parentFeatureKey: "module.projects" },
  { featureKey: "projects.reference_config", name: "Reference Configuration", parentFeatureKey: "module.projects" },
  { featureKey: "projects.hims_mapping", name: "HIMS Mapping", parentFeatureKey: "module.projects", dependencies: ["module.hims"] },
]);

// -----------------------------------------------------------------------------
// 4. DOCUMENT AUTOMATION
// -----------------------------------------------------------------------------

const DOCUMENTS: FeatureDefinition[] = asFeat("documents", null, { routeHint: "/app/documents" }, [
  { featureKey: "module.documents", name: "Documents & Automation Hub", valueType: "boolean" },
  { featureKey: "documents.hub", name: "Automation Hub", parentFeatureKey: "module.documents", routeHint: "/app/documents/automation" },
  { featureKey: "documents.templates", name: "Template Library", parentFeatureKey: "module.documents", routeHint: "/app/documents/variables" },
  { featureKey: "documents.templates.founder", name: "Founder Templates", parentFeatureKey: "documents.templates", founderOnly: true },
  { featureKey: "documents.templates.firm", name: "Firm Templates", parentFeatureKey: "documents.templates" },
  { featureKey: "documents.word", name: "Word Generation", parentFeatureKey: "module.documents" },
  { featureKey: "documents.pdf", name: "PDF Generation + Mapping", parentFeatureKey: "module.documents" },
  { featureKey: "documents.variables", name: "Variables / Custom Variables", parentFeatureKey: "module.documents", routeHint: "/app/documents/variables" },
  { featureKey: "documents.batch", name: "Batch Generation", parentFeatureKey: "module.documents" },
  { featureKey: "documents.generated", name: "Generated Documents (case/workflow)", parentFeatureKey: "module.documents" },
  { featureKey: "documents.versioning", name: "History / Versioning", parentFeatureKey: "module.documents" },
  { featureKey: "documents.ocr", name: "OCR", parentFeatureKey: "module.documents", dependencies: ["module.ai"] },
  { featureKey: "documents.ai_read", name: "AI Reading + Date Extraction", parentFeatureKey: "module.documents", dependencies: ["module.ai"] },
  { featureKey: "documents.ai_migration", name: "AI Template Migration", parentFeatureKey: "documents.templates", dependencies: ["module.ai"] },
  { featureKey: "documents.logs", name: "Generation Logs", parentFeatureKey: "module.documents", routeHint: "/app/documents/generation-logs" },
  { featureKey: "limit.documents.generation_monthly", name: "Max Generated Docs/Month", parentFeatureKey: "module.documents", valueType: "integer", defaultValue: -1 },
]);

// -----------------------------------------------------------------------------
// 5. ACCOUNTING (Complete listing §2)
// -----------------------------------------------------------------------------

const ACCOUNTING: FeatureDefinition[] = asFeat("accounting", null, { routeHint: "/app/accounting" }, [
  { featureKey: "module.accounting", name: "Accounting", valueType: "boolean" },
  { featureKey: "accounting.dashboard", name: "Accounting Dashboard", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.quotation", name: "Quotation", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.invoice", name: "Invoice (issue/view)", parentFeatureKey: "module.accounting", backendGuardKey: "accounting.read" },
  { featureKey: "accounting.receipt", name: "Receipt", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.payment_voucher", name: "Payment Voucher (PV)", parentFeatureKey: "module.accounting", jobGuards: ["payment_voucher_sla"] },
  { featureKey: "accounting.payment_voucher.create", name: "Create PV", parentFeatureKey: "accounting.payment_voucher" },
  { featureKey: "accounting.payment_voucher.submit", name: "Submit PV", parentFeatureKey: "accounting.payment_voucher" },
  { featureKey: "accounting.payment_voucher.approval", name: "PV Approval", parentFeatureKey: "accounting.payment_voucher", jobGuards: ["payment_voucher_sla"] },
  { featureKey: "accounting.file_listing", name: "File Listing", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.client_ledger", name: "Client Ledger", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.case_ledger", name: "Case Ledger", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.office_ledger", name: "Office Ledger", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.trust_account", name: "Trust Account", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.trust_statement", name: "Trust Statement", parentFeatureKey: "accounting.trust_account" },
  { featureKey: "accounting.stakeholder", name: "Stakeholder", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.disbursement", name: "Disbursement", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.professional_fees", name: "Professional Fees", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.travelling", name: "Travelling", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.miscellaneous", name: "Miscellaneous", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.overcollection", name: "Overcollection", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.office_income", name: "Office Income", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.bank_transaction", name: "Bank Transaction", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.bank_reconciliation", name: "Bank Reconciliation", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.payment", name: "Payment (out)", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.refund", name: "Refund", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.reports", name: "Accounting Reports", parentFeatureKey: "module.accounting", dependencies: ["module.reports"] },
  { featureKey: "accounting.approvals", name: "Accounting Approvals", parentFeatureKey: "module.accounting" },
  { featureKey: "accounting.notifications", name: "Accounting Notifications", parentFeatureKey: "module.accounting", dependencies: ["module.notifications"], jobGuards: ["payment_voucher_sla"] },
]);

// -----------------------------------------------------------------------------
// 6. E-INVOICE
// -----------------------------------------------------------------------------

const EINVOICE: FeatureDefinition[] = asFeat("einvoice", null, {}, [
  { featureKey: "module.einvoice", name: "E-Invoice (LHDN)", valueType: "boolean" },
  { featureKey: "einvoice.individual", name: "Individual E-Invoice", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.consolidated", name: "Consolidated E-Invoice", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.submit", name: "Submit to LHDN", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.status", name: "Status & History", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.credit_note", name: "Credit Note", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.debit_note", name: "Debit Note", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.refund_note", name: "Refund Note", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.validation", name: "Validation", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.lhdn_integration", name: "LHDN Integration", parentFeatureKey: "module.einvoice" },
  { featureKey: "einvoice.logs", name: "Logs", parentFeatureKey: "module.einvoice" },
]);

// -----------------------------------------------------------------------------
// 7. EMAIL / COMMUNICATIONS
// -----------------------------------------------------------------------------

const COMMUNICATIONS: FeatureDefinition[] = asFeat("communications", null, { routeHint: "/app/communication/email" }, [
  { featureKey: "module.communications", name: "Communications", valueType: "boolean" },
  { featureKey: "communications.email", name: "Email Control", parentFeatureKey: "module.communications", routeHint: "/app/communication/email", jobGuards: ["email_sync"] },
  { featureKey: "communications.email.settings", name: "Email Settings", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.m365", name: "Microsoft 365", parentFeatureKey: "communications.email.settings" },
  { featureKey: "communications.email.imap", name: "IMAP", parentFeatureKey: "communications.email.settings" },
  { featureKey: "communications.email.gmail", name: "Gmail", parentFeatureKey: "communications.email.settings" },
  { featureKey: "communications.email.folders", name: "Inbox/Sent/Draft/Archive", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.mark_read", name: "Read/Unread", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.reply", name: "Reply / Reply All", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.forward", name: "Forward", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.remarks", name: "Remarks", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.assign_user", name: "Assign User", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.link_case", name: "Link to Case", parentFeatureKey: "communications.email", dependencies: ["module.cases"] },
  { featureKey: "communications.email.search", name: "Search / Filter", parentFeatureKey: "communications.email" },
  { featureKey: "communications.email.sla", name: "SLA Tracking", parentFeatureKey: "communications.email", jobGuards: ["email_sla"] },
  { featureKey: "communications.email.task", name: "Email → Task", parentFeatureKey: "communications.email", dependencies: ["cases.tasks"] },
  { featureKey: "communications.email.sync", name: "Sync", parentFeatureKey: "communications.email", jobGuards: ["email_sync"] },
  { featureKey: "communications.email.logs", name: "Logs", parentFeatureKey: "communications.email" },
  { featureKey: "communications.whatsapp", name: "WhatsApp Inbox", parentFeatureKey: "module.communications", routeHint: "/app/communication/whatsapp" },
  { featureKey: "communications.hub", name: "Hub Unified", parentFeatureKey: "module.communications", routeHint: "/app/hub" },
]);

// -----------------------------------------------------------------------------
// 8. HR (Complete §2 list)
// -----------------------------------------------------------------------------

const HR: FeatureDefinition[] = asFeat("hr", null, {}, [
  { featureKey: "module.hr", name: "Human Resources (HRMS)", valueType: "boolean" },
  { featureKey: "hr.dashboard", name: "HR Dashboard", parentFeatureKey: "module.hr", routeHint: "/app/hr/dashboard" },
  { featureKey: "hr.employees", name: "Employees", parentFeatureKey: "module.hr", routeHint: "/app/hr/employees" },
  { featureKey: "hr.departments", name: "Departments", parentFeatureKey: "module.hr", routeHint: "/app/hr/departments" },
  { featureKey: "hr.positions", name: "Positions", parentFeatureKey: "module.hr", routeHint: "/app/hr/positions" },
  { featureKey: "hr.attendance", name: "Attendance", parentFeatureKey: "module.hr", routeHint: "/app/hr/attendance" },
  { featureKey: "hr.leave", name: "Leave", parentFeatureKey: "module.hr", routeHint: "/app/hr/leave", jobGuards: ["hr_leave_sla"] },
  { featureKey: "hr.claims", name: "Claims", parentFeatureKey: "module.hr", routeHint: "/app/hr/claims", jobGuards: ["hr_claim_sla"] },
  { featureKey: "hr.payroll", name: "Payroll", parentFeatureKey: "module.hr", routeHint: "/app/hr/payroll" },
  { featureKey: "hr.onboarding", name: "Onboarding", parentFeatureKey: "module.hr", routeHint: "/app/hr/onboarding", jobGuards: ["hr_onboarding"] },
  { featureKey: "hr.offboarding", name: "Offboarding", parentFeatureKey: "module.hr", routeHint: "/app/hr/offboarding", jobGuards: ["hr_offboarding"] },
  { featureKey: "hr.recruitment", name: "Recruitment", parentFeatureKey: "module.hr", routeHint: "/app/hr/recruitment" },
  { featureKey: "hr.performance", name: "Performance", parentFeatureKey: "module.hr", routeHint: "/app/hr/performance" },
  { featureKey: "hr.training", name: "Training", parentFeatureKey: "module.hr", routeHint: "/app/hr/training" },
  { featureKey: "hr.assets", name: "Assets", parentFeatureKey: "module.hr", routeHint: "/app/hr/assets" },
  { featureKey: "hr.documents", name: "HR Documents", parentFeatureKey: "module.hr", routeHint: "/app/hr/documents" },
  { featureKey: "hr.notifications", name: "HR Notifications", parentFeatureKey: "module.hr", dependencies: ["module.notifications"], jobGuards: ["hr_event_delivery"] },
  { featureKey: "hr.approvals", name: "HR Approvals (leave/claims/payroll)", parentFeatureKey: "module.hr" },
  { featureKey: "hr.self_service", name: "Employee Self Service", parentFeatureKey: "module.hr" },
  { featureKey: "hr.reports", name: "HR Reports", parentFeatureKey: "module.hr", dependencies: ["module.reports"], routeHint: "/app/hr/reports" },
  { featureKey: "hr.settings", name: "HR Settings", parentFeatureKey: "module.hr", routeHint: "/app/hr/settings" },
  { featureKey: "hr.integration_events", name: "HR Integration Events (webhooks)", parentFeatureKey: "module.hr", jobGuards: ["hr_event_delivery"] },
]);

// -----------------------------------------------------------------------------
// 9. RBAC / USER MANAGEMENT
// -----------------------------------------------------------------------------

const RBAC: FeatureDefinition[] = asFeat("rbac", null, {}, [
  { featureKey: "module.rbac", name: "User & Role Management", valueType: "boolean" },
  { featureKey: "rbac.users", name: "Users (list/edit)", parentFeatureKey: "module.rbac", routeHint: "/app/users" },
  { featureKey: "rbac.users.create", name: "Create/Invite Users", parentFeatureKey: "rbac.users" },
  { featureKey: "rbac.users.invitations", name: "Invitations", parentFeatureKey: "rbac.users" },
  { featureKey: "rbac.users.assignments", name: "Assignments (to cases/dept)", parentFeatureKey: "rbac.users" },
  { featureKey: "rbac.users.initials", name: "Initials Config", parentFeatureKey: "rbac.users" },
  { featureKey: "rbac.roles", name: "Roles", parentFeatureKey: "module.rbac", routeHint: "/app/roles" },
  { featureKey: "rbac.permissions", name: "Permissions", parentFeatureKey: "rbac.roles" },
  { featureKey: "rbac.departments", name: "Departments (firm)", parentFeatureKey: "module.rbac" },
  { featureKey: "limit.users.max", name: "Max Users", parentFeatureKey: "module.rbac", valueType: "integer", defaultValue: 10 },
]);

// -----------------------------------------------------------------------------
// 10. CONTACTS (clients / banks / other parties)
// -----------------------------------------------------------------------------

const CONTACTS: FeatureDefinition[] = asFeat("contacts", null, {}, [
  { featureKey: "module.contacts", name: "Contacts (Clients / Parties)", valueType: "boolean" },
  { featureKey: "contacts.clients", name: "Clients", parentFeatureKey: "module.contacts", routeHint: "/app/clients" },
  { featureKey: "contacts.borrowers", name: "Purchasers / Borrowers", parentFeatureKey: "module.contacts" },
  { featureKey: "contacts.vendors", name: "Vendors", parentFeatureKey: "module.contacts" },
  { featureKey: "contacts.banks", name: "Banks", parentFeatureKey: "module.contacts" },
  { featureKey: "contacts.developers_contact", name: "Developer Contacts", parentFeatureKey: "module.contacts", dependencies: ["module.developers"] },
  { featureKey: "contacts.other_parties", name: "Other Parties", parentFeatureKey: "module.contacts" },
]);

// -----------------------------------------------------------------------------
// 11. NOTIFICATIONS
// -----------------------------------------------------------------------------

const NOTIFICATIONS: FeatureDefinition[] = asFeat("notifications", null, {}, [
  { featureKey: "module.notifications", name: "Notifications", valueType: "boolean" },
  { featureKey: "notifications.in_app", name: "In-App Notifications", parentFeatureKey: "module.notifications" },
  { featureKey: "notifications.red_dot", name: "Red Dot / Unread Count Badge", parentFeatureKey: "notifications.in_app" },
  { featureKey: "notifications.approval", name: "Approval Notifications", parentFeatureKey: "module.notifications" },
  { featureKey: "notifications.case", name: "Case Notifications", parentFeatureKey: "module.notifications" },
  { featureKey: "notifications.accounting", name: "Accounting Notifications", parentFeatureKey: "module.notifications" },
  { featureKey: "notifications.pv_escalation", name: "PV Escalation", parentFeatureKey: "notifications.accounting", jobGuards: ["payment_voucher_sla"] },
  { featureKey: "notifications.lawyer", name: "Lawyer Notifications", parentFeatureKey: "module.notifications" },
  { featureKey: "notifications.manager", name: "Manager Notifications", parentFeatureKey: "module.notifications" },
  { featureKey: "notifications.partner_escalation", name: "Partner Escalation", parentFeatureKey: "module.notifications" },
]);

// -----------------------------------------------------------------------------
// 12. HIMS / eSPA TRACKER
// -----------------------------------------------------------------------------

const HIMS: FeatureDefinition[] = asFeat("hims", null, {}, [
  { featureKey: "module.hims", name: "HIMS / eSPA Tracker", valueType: "boolean" },
  { featureKey: "hims.tracker", name: "HIMS Status Tracker", parentFeatureKey: "module.hims" },
  { featureKey: "hims.credentials", name: "Developer Credentials / Config", parentFeatureKey: "module.hims" },
  { featureKey: "hims.project_mapping", name: "Project / Phase Mapping", parentFeatureKey: "module.hims", dependencies: ["module.projects"] },
  { featureKey: "hims.unit_lot_title", name: "Unit/Lot/Title Mapping", parentFeatureKey: "module.hims" },
  { featureKey: "hims.espa_status", name: "eSPA Status", parentFeatureKey: "module.hims" },
  { featureKey: "hims.spa_tracker", name: "SPA Tracker", parentFeatureKey: "module.hims" },
  { featureKey: "hims.spa_stamped_handover", name: "SPA Stamped Handover", parentFeatureKey: "module.hims" },
  { featureKey: "hims.status_check", name: "Status Check (api)", parentFeatureKey: "module.hims" },
  { featureKey: "hims.compare_lawcaspro_hims", name: "Compare Lawcaspro ↔ HIMS", parentFeatureKey: "module.hims" },
  { featureKey: "hims.compare_lawcaspro_ekyc", name: "Compare Lawcaspro ↔ eKYC", parentFeatureKey: "module.hims", dependencies: ["module.ekyc"] },
  { featureKey: "hims.notifications", name: "HIMS Notifications", parentFeatureKey: "module.hims", dependencies: ["module.notifications"] },
]);

// -----------------------------------------------------------------------------
// 13. eKYC
// -----------------------------------------------------------------------------

const EKYC: FeatureDefinition[] = asFeat("ekyc", null, {}, [
  { featureKey: "module.ekyc", name: "eKYC / Identity Verification", valueType: "boolean" },
  { featureKey: "ekyc.verify", name: "Identity Verification", parentFeatureKey: "module.ekyc" },
  { featureKey: "ekyc.status", name: "Status Overview", parentFeatureKey: "module.ekyc" },
  { featureKey: "ekyc.comparison", name: "Comparison (HIMS/others)", parentFeatureKey: "module.ekyc" },
  { featureKey: "ekyc.history", name: "History", parentFeatureKey: "module.ekyc" },
]);

// -----------------------------------------------------------------------------
// 14. REPORTS
// -----------------------------------------------------------------------------

const REPORTS: FeatureDefinition[] = asFeat("reports", null, { routeHint: "/app/reports" }, [
  { featureKey: "module.reports", name: "Reports", valueType: "boolean" },
  { featureKey: "reports.case", name: "Case Reports", parentFeatureKey: "module.reports", dependencies: ["module.cases"] },
  { featureKey: "reports.accounting", name: "Accounting Reports", parentFeatureKey: "module.reports", dependencies: ["module.accounting"] },
  { featureKey: "reports.hr", name: "HR Reports", parentFeatureKey: "module.reports", dependencies: ["module.hr"] },
  { featureKey: "reports.management", name: "Management Reports", parentFeatureKey: "module.reports" },
  { featureKey: "reports.status", name: "Status Reports", parentFeatureKey: "module.reports" },
  { featureKey: "reports.productivity", name: "Productivity Reports", parentFeatureKey: "module.reports" },
  { featureKey: "reports.audit", name: "Audit Reports", parentFeatureKey: "module.reports", dependencies: ["module.audit"] },
  { featureKey: "reports.export_pdf", name: "PDF Export", parentFeatureKey: "module.reports" },
  { featureKey: "reports.export_excel", name: "Excel Export", parentFeatureKey: "module.reports" },
]);

// -----------------------------------------------------------------------------
// 15. SETTINGS
// -----------------------------------------------------------------------------

const SETTINGS: FeatureDefinition[] = asFeat("settings", null, { routeHint: "/app/settings" }, [
  { featureKey: "module.settings", name: "Settings (Firm)", valueType: "boolean" },
  { featureKey: "settings.firm", name: "Firm Settings", parentFeatureKey: "module.settings" },
  { featureKey: "settings.case", name: "Case Settings / Types / Config", parentFeatureKey: "module.settings", dependencies: ["module.cases"] },
  { featureKey: "settings.reference", name: "Reference Number Config", parentFeatureKey: "settings.case" },
  { featureKey: "settings.accounting", name: "Accounting Settings", parentFeatureKey: "module.settings", dependencies: ["module.accounting"], routeHint: "/app/settings/accounting" },
  { featureKey: "settings.hr", name: "HR Settings", parentFeatureKey: "module.settings", dependencies: ["module.hr"] },
  { featureKey: "settings.email", name: "Email Settings", parentFeatureKey: "module.settings", dependencies: ["module.communications"], routeHint: "/app/settings/email" },
  { featureKey: "settings.document", name: "Document / Templates Settings", parentFeatureKey: "module.settings", dependencies: ["module.documents"], routeHint: "/app/settings/templates" },
  { featureKey: "settings.notifications", name: "Notification Settings", parentFeatureKey: "module.settings", dependencies: ["module.notifications"] },
  { featureKey: "settings.integrations", name: "Integrations Settings", parentFeatureKey: "module.settings" },
  { featureKey: "settings.subscription", name: "Subscription & Billing (Firm view)", parentFeatureKey: "module.settings" },
  { featureKey: "settings.logs", name: "Logs (firm)", parentFeatureKey: "module.settings", dependencies: ["module.audit"], routeHint: "/app/settings/logs" },
]);

// -----------------------------------------------------------------------------
// 16. STORAGE
// -----------------------------------------------------------------------------

const STORAGE: FeatureDefinition[] = asFeat("storage", null, {}, [
  { featureKey: "module.storage", name: "Storage / File Custody", valueType: "boolean", status: "active" },
  { featureKey: "storage.file_custody", name: "File Custody Registry (Phase 2/3 candidate)", parentFeatureKey: "module.storage", routeHint: "/app/file-custody", defaultValue: false, status: "inactive", firmControlledOverride: false, description: "Future: Phase 2/3 candidate. Default disabled for all firms; currently hidden from navigation and route-gated." },
  { featureKey: "storage.uploads", name: "General File Uploads", parentFeatureKey: "module.storage" },
  { featureKey: "limit.storage.gb", name: "Storage (GB)", parentFeatureKey: "module.storage", valueType: "integer", defaultValue: 100 },
]);

// -----------------------------------------------------------------------------
// 17. AI
// -----------------------------------------------------------------------------

const AI: FeatureDefinition[] = asFeat("ai", null, {}, [
  { featureKey: "module.ai", name: "AI & OCR Capabilities", valueType: "boolean" },
  { featureKey: "ai.ocr", name: "OCR Engine", parentFeatureKey: "module.ai" },
  { featureKey: "ai.draft", name: "AI Drafting Assistant", parentFeatureKey: "module.ai" },
  { featureKey: "ai.reading", name: "AI Reading / Extraction", parentFeatureKey: "module.ai" },
  { featureKey: "limit.ai.ocr_pages_monthly", name: "OCR Pages / Month", parentFeatureKey: "module.ai", valueType: "integer", defaultValue: 1000 },
  { featureKey: "limit.ai.draft_tokens_monthly", name: "AI Draft Tokens / Month", parentFeatureKey: "module.ai", valueType: "integer", defaultValue: -1 },
]);

// -----------------------------------------------------------------------------
// 18. AUDIT
// -----------------------------------------------------------------------------

const AUDIT: FeatureDefinition[] = asFeat("audit", null, { routeHint: "/app/audit-logs" }, [
  { featureKey: "module.audit", name: "Audit Logs", valueType: "boolean" },
  { featureKey: "audit.logs", name: "View Audit Logs", parentFeatureKey: "module.audit", routeHint: "/app/audit-logs" },
  { featureKey: "audit.export", name: "Export Audit Logs", parentFeatureKey: "module.audit" },
]);

// -----------------------------------------------------------------------------
// 19. PLATFORM / GOVERNANCE (FOUNDER ONLY)
// -----------------------------------------------------------------------------

const PLATFORM: FeatureDefinition[] = asFeat("platform", null, {}, [
  { featureKey: "module.platform", name: "Platform Admin (Founder)", valueType: "boolean", founderOnly: true, configurable: false },
  { featureKey: "platform.firms", name: "Firms Management", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.plans", name: "Plans & Entitlements", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.billing", name: "Billing & Ledger (founder view)", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.audit", name: "Cross-Firm Audit", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.ops_center", name: "Ops Center", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.approvals", name: "Platform Approvals", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.support_sessions", name: "Support Sessions (consent-based access)", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.incident_center", name: "Incident Center", parentFeatureKey: "module.platform", founderOnly: true },
  { featureKey: "platform.governance", name: "Governance", parentFeatureKey: "module.platform", founderOnly: true },
]);

// -----------------------------------------------------------------------------
// Compose the full registry
// -----------------------------------------------------------------------------

export const FEATURE_REGISTRY: FeatureDefinition[] = [
  ...DASHBOARD,
  ...CASES,
  ...DEVELOPERS,
  ...PROJECTS,
  ...DOCUMENTS,
  ...ACCOUNTING,
  ...EINVOICE,
  ...COMMUNICATIONS,
  ...HR,
  ...RBAC,
  ...CONTACTS,
  ...NOTIFICATIONS,
  ...HIMS,
  ...EKYC,
  ...REPORTS,
  ...SETTINGS,
  ...STORAGE,
  ...AI,
  ...AUDIT,
  ...PLATFORM,
];

/** Map for O(1) lookups by featureKey. */
export const FEATURE_REGISTRY_MAP: ReadonlyMap<string, FeatureDefinition> = (() => {
  const m = new Map<string, FeatureDefinition>();
  for (const f of FEATURE_REGISTRY) {
    // Avoid duplicates — if duplicate exists, warn but first wins (configurable)
    if (!m.has(f.featureKey)) m.set(f.featureKey, f);
  }
  return m;
})();

/** Return the registered definition or undefined. */
export function getFeatureDefinition(featureKey: string): FeatureDefinition | undefined {
  return FEATURE_REGISTRY_MAP.get(featureKey);
}

/**
 * UNKNOWN FEATURE POLICY (Part 2 §11):
 * Unregistered configurable features must be denied by default.
 * Use this helper in every guard/middleware before falling back.
 */
export function isFeatureRegistered(featureKey: string): boolean {
  return FEATURE_REGISTRY_MAP.has(featureKey);
}

/**
 * All job/worker guard keys → list of parent feature keys that gate them.
 * Background jobs iterate this set; notification/escalation worker will skip
 * per-firm if ANY feature featureKey in list is not enabled (Part 2 §13).
 */
export function collectJobGuardToFeatureMap(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const f of FEATURE_REGISTRY) {
    if (f.jobGuards && f.jobGuards.length) {
      for (const jg of f.jobGuards) {
        if (!out.has(jg)) out.set(jg, []);
        out.get(jg)!.push(f.featureKey);
      }
    }
  }
  return out;
}

/** All modules (unique feature.module values). */
export function allModules(): readonly FeatureDefinition["module"][] {
  return Array.from(new Set(FEATURE_REGISTRY.map((f) => f.module)));
}

/** Count helpers for Part 2 final report. */
export function countModules(): number {
  return allModules().length;
}
export function countFeatures(): number {
  return FEATURE_REGISTRY.length;
}

/** Returns child features of a given key (immediate children). */
export function childrenOf(parentFeatureKey: string | null): FeatureDefinition[] {
  return FEATURE_REGISTRY.filter((f) => f.parentFeatureKey === parentFeatureKey);
}

/** Walks all descendants of a key (including children, grandchildren, ...). */
export function descendantsOf(parentFeatureKey: string): string[] {
  const out: string[] = [];
  const stack: string[] = [parentFeatureKey];
  while (stack.length) {
    const cur = stack.shift()!;
    for (const child of childrenOf(cur)) {
      out.push(child.featureKey);
      stack.push(child.featureKey);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DRIFT + VALIDATION (Part 2 §3 — single source of truth)
//
// validateFeatureRegistry() throws aggregated FeatureRegistryError if:
//   - duplicate feature keys (not allowed; silent first-wins map above is dangerous)
//   - unknown parent_feature_key — parent must also be registered
//   - unknown dependency key — every dependency must also be registered
//   - parent/dependency cycle (graph cycle detected by DFS coloring)
//   - invalid value_type — not in FeatureValueType union
//   - invalid module — module must be in FeatureDefinition["module"]
//
// validateDbSeedMatchesCanonical(dbRows) — compare DB seed (0149/0150) to canonical
// validateInventoryMatchesCanonical(markdownEntries) — compare generated markdown
//
// Use in tests and migration scripts as the single authoritative validator.
// ---------------------------------------------------------------------------

export class FeatureRegistryError extends Error {
  constructor(public readonly violations: string[]) {
    super(`FEATURE_REGISTRY_INVALID: ${violations.length} violation(s):\n  - ${violations.join("\n  - ")}`);
    this.name = "FeatureRegistryError";
  }
}

const KNOWN_MODULES: ReadonlySet<FeatureDefinition["module"]> = new Set<FeatureDefinition["module"]>([
  "dashboard","cases","developers","projects","documents","accounting","einvoice",
  "communications","hr","rbac","contacts","notifications","hims","ekyc",
  "reports","settings","storage","ai","audit","platform","governance",
]);

const KNOWN_VALUE_TYPES: ReadonlySet<FeatureValueType> = new Set([
  "boolean","integer","decimal","string","config","unlimited",
]);

function detectCycle(key: string, edges: Map<string, readonly string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: Array<{ k: string; iter: Iterator<string>; path: string[] }> = [];
  color.set(key, GRAY);
  stack.push({ k: key, iter: (edges.get(key) ?? [])[Symbol.iterator](), path: [key] });
  while (stack.length) {
    const top = stack[stack.length - 1];
    const { value, done } = top.iter.next();
    if (done) {
      color.set(top.k, BLACK);
      stack.pop();
      continue;
    }
    const next = value as string;
    const c = color.get(next) ?? WHITE;
    if (c === GRAY) {
      // cycle found — reconstruct from path
      const idx = top.path.indexOf(next);
      return idx >= 0 ? [...top.path.slice(idx), next] : [next, top.k, next];
    }
    if (c === WHITE) {
      color.set(next, GRAY);
      const nextPath = [...top.path, next];
      stack.push({ k: next, iter: (edges.get(next) ?? [])[Symbol.iterator](), path: nextPath });
    }
  }
  return null;
}

export function validateFeatureRegistry(): void {
  const violations: string[] = [];

  // 1. Duplicate keys
  const seen = new Map<string, number>();
  for (let i = 0; i < FEATURE_REGISTRY.length; i++) {
    const k = FEATURE_REGISTRY[i].featureKey;
    if (seen.has(k)) violations.push(`Duplicate feature key: ${k} (index ${seen.get(k)} vs ${i})`);
    else seen.set(k, i);
  }

  // 2. Invalid value type
  for (const f of FEATURE_REGISTRY) {
    if (!KNOWN_VALUE_TYPES.has(f.valueType))
      violations.push(`Invalid value_type for ${f.featureKey}: ${f.valueType}`);
  }

  // 3. Invalid module
  for (const f of FEATURE_REGISTRY) {
    if (!((KNOWN_MODULES as unknown) as Set<string>).has(f.module))
      violations.push(`Invalid module for ${f.featureKey}: ${f.module}`);
  }

  // 4. Unknown parent / dependency
  for (const f of FEATURE_REGISTRY) {
    if (f.parentFeatureKey && !FEATURE_REGISTRY_MAP.has(f.parentFeatureKey))
      violations.push(`Unknown parent_feature_key for ${f.featureKey}: ${f.parentFeatureKey}`);
    if (f.dependencies && f.dependencies.length) {
      for (const d of f.dependencies) {
        if (!FEATURE_REGISTRY_MAP.has(d))
          violations.push(`Unknown dependency for ${f.featureKey}: ${d}`);
      }
    }
  }

  // 5. Parent + dependency graph cycle (combined single graph)
  const combined = new Map<string, string[]>();
  for (const f of FEATURE_REGISTRY) {
    const edges: string[] = [];
    if (f.parentFeatureKey) edges.push(f.parentFeatureKey);
    if (f.dependencies) edges.push(...f.dependencies);
    if (edges.length) combined.set(f.featureKey, edges);
  }
  for (const f of FEATURE_REGISTRY) {
    const cyc = detectCycle(f.featureKey, combined as Map<string, readonly string[]>);
    if (cyc) {
      violations.push(`Cycle detected in parent/dependency graph: ${cyc.join(" → ")}`);
      break;
    }
  }

  if (violations.length > 0) throw new FeatureRegistryError(violations);
}

export interface DbFeatureRow {
  featureKey: string;
  name?: string | null;
  module?: string | null;
  parentFeatureKey?: string | null;
  valueType?: string | null;
  default_value?: unknown;
  configurable?: boolean | null;
  founderOnly?: boolean | null;
  status?: string | null;
}

export function validateDbSeedMatchesCanonical(rows: readonly DbFeatureRow[]): void {
  const violations: string[] = [];
  const dbMap = new Map(rows.map((r) => [r.featureKey, r]));
  for (const k of Array.from(FEATURE_REGISTRY_MAP.keys())) {
    const db = dbMap.get(k);
    if (!db) violations.push(`DB seed missing feature_key (expected from registry): ${k}`);
  }
  for (const r of rows) {
    if (!FEATURE_REGISTRY_MAP.has(r.featureKey))
      violations.push(`DB seed contains extra/unknown feature_key not in canonical registry: ${r.featureKey}`);
    else {
      const canon = FEATURE_REGISTRY_MAP.get(r.featureKey)!;
      if (r.module && canon.module !== r.module)
        violations.push(`DB drift on ${r.featureKey}: module='${r.module}' (canonical '${canon.module}')`);
      if (r.valueType && canon.valueType !== r.valueType)
        violations.push(`DB drift on ${r.featureKey}: value_type='${r.valueType}' (canonical '${canon.valueType}')`);
      if (r.parentFeatureKey !== undefined && r.parentFeatureKey !== null && canon.parentFeatureKey !== r.parentFeatureKey)
        violations.push(`DB drift on ${r.featureKey}: parent='${r.parentFeatureKey}' (canonical '${canon.parentFeatureKey}')`);
    }
  }
  if (violations.length > 0) throw new FeatureRegistryError(violations);
}

export function countByModule(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FEATURE_REGISTRY) out[f.module] = (out[f.module] ?? 0) + 1;
  return out;
}
