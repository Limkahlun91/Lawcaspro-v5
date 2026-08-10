-- Migration 0150: Re-seed platform_features + plan_entitlements from Global Feature Registry.
-- This is a DATA migration. Schema already exists from 0148; we perform idempotent
-- UPSERT of platform_features and regeneration of plan_entitlements for
-- Starter / Pro / Enterprise plans with deny-lists and tier limits per Part 2 spec.
--
-- Note: Feature key list below is derived from lib/db/src/feature-registry.ts.
-- We use a single PL/pgSQL block to guarantee plan_id mapping locally and
-- ensure idempotency.

DO $$
DECLARE
  _starter_id int;
  _pro_id int;
  _enterprise_id int;
  _cnt_pf int := 0;
  _cnt_pe int := 0;
BEGIN

  -- Ensure plans exist --------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name = 'Starter') THEN
    INSERT INTO subscription_plans (name, price_monthly, max_users, max_cases_per_month, features, is_active, created_at, updated_at)
    VALUES ('Starter', 129, 5, 50, '{}', true, now(), now());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name = 'Pro') THEN
    INSERT INTO subscription_plans (name, price_monthly, max_users, max_cases_per_month, features, is_active, created_at, updated_at)
    VALUES ('Pro', 299, 30, 500, '{}', true, now(), now());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscription_plans WHERE name = 'Enterprise') THEN
    INSERT INTO subscription_plans (name, price_monthly, max_users, max_cases_per_month, features, is_active, created_at, updated_at)
    VALUES ('Enterprise', 599, 999, 99999, '{}', true, now(), now());
  END IF;
  SELECT id INTO _starter_id   FROM subscription_plans WHERE name = 'Starter';
  SELECT id INTO _pro_id       FROM subscription_plans WHERE name = 'Pro';
  SELECT id INTO _enterprise_id FROM subscription_plans WHERE name = 'Enterprise';

  -- Clear plan_entitlements (regeneration) -----------------------------------
  DELETE FROM plan_entitlements WHERE plan_id IN (_starter_id, _pro_id, _enterprise_id);

  -- helper inline: perform upsert via simple SQL block using VALUES list
  -- Values seeded below are generated from TypeScript registry defaults.

  -- 1. Upsert platform_features (idempotent on feature_key) -------------------
  DROP TABLE IF EXISTS tmp_pf;
  CREATE TEMP TABLE tmp_pf (
    feature_key text, name text, module text, parent_feature_key text,
    value_type text, default_value jsonb, configurable boolean,
    founder_only boolean, dependency_json jsonb, route_hint text, status text
  ) ON COMMIT DROP;

  -- Registry snapshot (see lib/db/src/feature-registry.ts FEATURE_REGISTRY)
  INSERT INTO tmp_pf (feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, dependency_json, route_hint, status) VALUES
  -- DASHBOARD
  ('module.dashboard','Dashboard (all firm dashboards)','dashboard',NULL,'boolean','true',true,false,'[]','/app/dashboard','active'),
  ('dashboard.firm','Firm Dashboard','dashboard','module.dashboard','boolean','true',true,false,'[]','/app/dashboard','active'),
  ('dashboard.partner','Partner Dashboard','dashboard','module.dashboard','boolean','true',true,false,'[]',NULL,'active'),
  ('dashboard.management','Management Dashboard','dashboard','module.dashboard','boolean','true',true,false,'[]',NULL,'active'),
  ('dashboard.workbench','My Work / Workbench','dashboard','module.dashboard','boolean','true',true,false,'[]','/app/workbench','active'),
  ('dashboard.kpi','KPI Widgets','dashboard','module.dashboard','boolean','true',true,false,'[]',NULL,'active'),
  ('dashboard.approvals','Pending Approvals Widget','dashboard','module.dashboard','boolean','true',true,false,'[]',NULL,'active'),
  ('dashboard.alerts','Alerts / Escalations Widget','dashboard','module.dashboard','boolean','true',true,false,'[]',NULL,'active'),
  -- CASES
  ('module.cases','Cases','cases',NULL,'boolean','true',true,false,'[]','/app/cases','active'),
  ('cases.read','View / Search / Archive Cases','cases','module.cases','boolean','true',true,false,'[]','/app/cases','active'),
  ('cases.create','Create New Case','cases','module.cases','boolean','true',true,false,'[]','/app/cases/new','active'),
  ('cases.overview','Case Overview Tab','cases','module.cases','boolean','true',true,false,'[]','/app/cases/:id','active'),
  ('cases.parties','Parties Tab','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.property','Property Info Tab','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.loan','Loan Info Tab','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.reference','Reference Numbers + History','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.tasks','Case Tasks','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.timeline','Case Timeline','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.documents','Case Documents Tab','cases','module.cases','boolean','true',true,false,'["module.documents"]',NULL,'active'),
  ('cases.notes','Case Notes','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.assignment','Case Assignment + Bulk Assign','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.approval','Case Approval','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.amendment','Case Amendment','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.key_dates','Key Dates / Milestones','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.workflow','Workflow Steps + Attachments','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.developer_sales','Developer Sales Cases','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.subsale','Subsale Cases','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.perfection','Perfection Steps','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.intake','Intake Inbox','cases','module.cases','boolean','true',true,false,'[]','/app/cases/intake','active'),
  ('cases.conflict_check','Conflict Check','cases','module.cases','boolean','true',true,false,'["module.cases"]',NULL,'active'),
  ('cases.monitor','Case Monitor (SLAs)','cases','module.cases','boolean','true',true,false,'[]',NULL,'active'),
  ('cases.export','Case Export (CSV)','cases','cases.read','boolean','true',true,false,'[]',NULL,'active'),
  ('limit.cases.max','Max Active Cases','cases','module.cases','integer','-1',true,false,'[]',NULL,'active'),
  ('limit.cases.monthly_new','Max New Cases/Month','cases','module.cases','integer','-1',true,false,'[]',NULL,'active'),
  -- DEVELOPERS
  ('module.developers','Developers','developers',NULL,'boolean','true',true,false,'[]','/app/developers','active'),
  ('developers.read','View Developers','developers','module.developers','boolean','true',true,false,'[]',NULL,'active'),
  ('developers.create','Create Developer','developers','module.developers','boolean','true',true,false,'[]',NULL,'active'),
  ('developers.edit','Edit Developer','developers','module.developers','boolean','true',true,false,'[]',NULL,'active'),
  ('developers.codes','Developer/Project Codes Config','developers','module.developers','boolean','true',true,false,'[]',NULL,'active'),
  -- PROJECTS
  ('module.projects','Projects','projects',NULL,'boolean','true',true,false,'[]','/app/projects','active'),
  ('projects.read','View Projects','projects','module.projects','boolean','true',true,false,'[]',NULL,'active'),
  ('projects.create','Create Project','projects','module.projects','boolean','true',true,false,'[]',NULL,'active'),
  ('projects.edit','Edit Project','projects','module.projects','boolean','true',true,false,'[]',NULL,'active'),
  ('projects.phases','Phases Management','projects','module.projects','boolean','true',true,false,'[]',NULL,'active'),
  ('projects.units','Units/Lots Management','projects','module.projects','boolean','true',true,false,'[]',NULL,'active'),
  ('projects.reference_config','Reference Configuration','projects','module.projects','boolean','true',true,false,'[]',NULL,'active'),
  ('projects.hims_mapping','HIMS Mapping','projects','module.projects','boolean','true',true,false,'["module.hims"]',NULL,'active'),
  -- DOCUMENTS
  ('module.documents','Documents & Automation Hub','documents',NULL,'boolean','true',true,false,'[]','/app/documents','active'),
  ('documents.hub','Automation Hub','documents','module.documents','boolean','true',true,false,'[]','/app/documents/automation','active'),
  ('documents.templates','Template Library','documents','module.documents','boolean','true',true,false,'[]','/app/documents/variables','active'),
  ('documents.templates.founder','Founder Templates','documents','documents.templates','boolean','true',true,true,'[]',NULL,'active'),
  ('documents.templates.firm','Firm Templates','documents','documents.templates','boolean','true',true,false,'[]',NULL,'active'),
  ('documents.word','Word Generation','documents','module.documents','boolean','true',true,false,'[]',NULL,'active'),
  ('documents.pdf','PDF Generation + Mapping','documents','module.documents','boolean','true',true,false,'[]',NULL,'active'),
  ('documents.variables','Variables / Custom Variables','documents','module.documents','boolean','true',true,false,'[]','/app/documents/variables','active'),
  ('documents.batch','Batch Generation','documents','module.documents','boolean','true',true,false,'[]',NULL,'active'),
  ('documents.generated','Generated Documents','documents','module.documents','boolean','true',true,false,'[]',NULL,'active'),
  ('documents.versioning','History / Versioning','documents','module.documents','boolean','true',true,false,'[]',NULL,'active'),
  ('documents.ocr','OCR','documents','module.documents','boolean','true',true,false,'["module.ai"]',NULL,'active'),
  ('documents.ai_read','AI Reading + Date Extraction','documents','module.documents','boolean','true',true,false,'["module.ai"]',NULL,'active'),
  ('documents.ai_migration','AI Template Migration','documents','documents.templates','boolean','true',true,false,'["module.ai"]',NULL,'active'),
  ('documents.logs','Generation Logs','documents','module.documents','boolean','true',true,false,'[]','/app/documents/generation-logs','active'),
  ('limit.documents.generation_monthly','Max Generated Docs/Month','documents','module.documents','integer','-1',true,false,'[]',NULL,'active'),
  -- ACCOUNTING
  ('module.accounting','Accounting','accounting',NULL,'boolean','true',true,false,'[]','/app/accounting','active'),
  ('accounting.dashboard','Accounting Dashboard','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.quotation','Quotation','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.invoice','Invoice','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.receipt','Receipt','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.payment_voucher','Payment Voucher (PV)','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.payment_voucher.create','Create PV','accounting','accounting.payment_voucher','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.payment_voucher.submit','Submit PV','accounting','accounting.payment_voucher','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.payment_voucher.approval','PV Approval','accounting','accounting.payment_voucher','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.file_listing','File Listing','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.client_ledger','Client Ledger','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.case_ledger','Case Ledger','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.office_ledger','Office Ledger','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.trust_account','Trust Account','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.trust_statement','Trust Statement','accounting','accounting.trust_account','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.stakeholder','Stakeholder','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.disbursement','Disbursement','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.professional_fees','Professional Fees','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.travelling','Travelling','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.miscellaneous','Miscellaneous','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.overcollection','Overcollection','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.office_income','Office Income','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.bank_transaction','Bank Transaction','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.bank_reconciliation','Bank Reconciliation','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.payment','Payment (out)','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.refund','Refund','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.reports','Accounting Reports','accounting','module.accounting','boolean','true',true,false,'["module.reports"]',NULL,'active'),
  ('accounting.approvals','Accounting Approvals','accounting','module.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('accounting.notifications','Accounting Notifications','accounting','module.accounting','boolean','true',true,false,'["module.notifications"]',NULL,'active'),
  -- E-INVOICE
  ('module.einvoice','E-Invoice (LHDN)','einvoice',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.individual','Individual E-Invoice','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.consolidated','Consolidated E-Invoice','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.submit','Submit to LHDN','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.status','Status & History','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.credit_note','Credit Note','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.debit_note','Debit Note','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.refund_note','Refund Note','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.validation','Validation','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.lhdn_integration','LHDN Integration','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  ('einvoice.logs','Logs','einvoice','module.einvoice','boolean','true',true,false,'[]',NULL,'active'),
  -- COMMUNICATIONS
  ('module.communications','Communications','communications',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email','Email Control','communications','module.communications','boolean','true',true,false,'[]','/app/communication/email','active'),
  ('communications.email.settings','Email Settings','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.m365','Microsoft 365','communications','communications.email.settings','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.imap','IMAP','communications','communications.email.settings','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.gmail','Gmail','communications','communications.email.settings','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.folders','Inbox/Sent/Draft/Archive','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.mark_read','Read/Unread','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.reply','Reply / Reply All','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.forward','Forward','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.remarks','Remarks','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.assign_user','Assign User','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.link_case','Link to Case','communications','communications.email','boolean','true',true,false,'["module.cases"]',NULL,'active'),
  ('communications.email.search','Search / Filter','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.sla','SLA Tracking','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.task','Email → Task','communications','communications.email','boolean','true',true,false,'["cases.tasks"]',NULL,'active'),
  ('communications.email.sync','Sync','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.email.logs','Logs','communications','communications.email','boolean','true',true,false,'[]',NULL,'active'),
  ('communications.whatsapp','WhatsApp Inbox','communications','module.communications','boolean','true',true,false,'[]','/app/communication/whatsapp','active'),
  ('communications.hub','Hub Unified','communications','module.communications','boolean','true',true,false,'[]','/app/hub','active'),
  -- HR
  ('module.hr','Human Resources (HRMS)','hr',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('hr.dashboard','HR Dashboard','hr','module.hr','boolean','true',true,false,'[]','/app/hr/dashboard','active'),
  ('hr.employees','Employees','hr','module.hr','boolean','true',true,false,'[]','/app/hr/employees','active'),
  ('hr.departments','Departments','hr','module.hr','boolean','true',true,false,'[]','/app/hr/departments','active'),
  ('hr.positions','Positions','hr','module.hr','boolean','true',true,false,'[]','/app/hr/positions','active'),
  ('hr.attendance','Attendance','hr','module.hr','boolean','true',true,false,'[]','/app/hr/attendance','active'),
  ('hr.leave','Leave','hr','module.hr','boolean','true',true,false,'[]','/app/hr/leave','active'),
  ('hr.claims','Claims','hr','module.hr','boolean','true',true,false,'[]','/app/hr/claims','active'),
  ('hr.payroll','Payroll','hr','module.hr','boolean','true',true,false,'[]','/app/hr/payroll','active'),
  ('hr.onboarding','Onboarding','hr','module.hr','boolean','true',true,false,'[]','/app/hr/onboarding','active'),
  ('hr.offboarding','Offboarding','hr','module.hr','boolean','true',true,false,'[]','/app/hr/offboarding','active'),
  ('hr.recruitment','Recruitment','hr','module.hr','boolean','true',true,false,'[]','/app/hr/recruitment','active'),
  ('hr.performance','Performance','hr','module.hr','boolean','true',true,false,'[]','/app/hr/performance','active'),
  ('hr.training','Training','hr','module.hr','boolean','true',true,false,'[]','/app/hr/training','active'),
  ('hr.assets','Assets','hr','module.hr','boolean','true',true,false,'[]','/app/hr/assets','active'),
  ('hr.documents','HR Documents','hr','module.hr','boolean','true',true,false,'[]','/app/hr/documents','active'),
  ('hr.notifications','HR Notifications','hr','module.hr','boolean','true',true,false,'["module.notifications"]',NULL,'active'),
  ('hr.approvals','HR Approvals','hr','module.hr','boolean','true',true,false,'[]',NULL,'active'),
  ('hr.self_service','Employee Self Service','hr','module.hr','boolean','true',true,false,'[]',NULL,'active'),
  ('hr.reports','HR Reports','hr','module.hr','boolean','true',true,false,'["module.reports"]','/app/hr/reports','active'),
  ('hr.settings','HR Settings','hr','module.hr','boolean','true',true,false,'[]','/app/hr/settings','active'),
  ('hr.integration_events','HR Integration Events','hr','module.hr','boolean','true',true,false,'[]',NULL,'active'),
  -- RBAC
  ('module.rbac','User & Role Management','rbac',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('rbac.users','Users (list/edit)','rbac','module.rbac','boolean','true',true,false,'[]','/app/users','active'),
  ('rbac.users.create','Create/Invite Users','rbac','rbac.users','boolean','true',true,false,'[]',NULL,'active'),
  ('rbac.users.invitations','Invitations','rbac','rbac.users','boolean','true',true,false,'[]',NULL,'active'),
  ('rbac.users.assignments','Assignments','rbac','rbac.users','boolean','true',true,false,'[]',NULL,'active'),
  ('rbac.users.initials','Initials Config','rbac','rbac.users','boolean','true',true,false,'[]',NULL,'active'),
  ('rbac.roles','Roles','rbac','module.rbac','boolean','true',true,false,'[]','/app/roles','active'),
  ('rbac.permissions','Permissions','rbac','rbac.roles','boolean','true',true,false,'[]',NULL,'active'),
  ('rbac.departments','Departments (firm)','rbac','module.rbac','boolean','true',true,false,'[]',NULL,'active'),
  ('limit.users.max','Max Users','rbac','module.rbac','integer','10',true,false,'[]',NULL,'active'),
  -- CONTACTS
  ('module.contacts','Contacts (Clients / Parties)','contacts',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('contacts.clients','Clients','contacts','module.contacts','boolean','true',true,false,'[]','/app/clients','active'),
  ('contacts.borrowers','Purchasers / Borrowers','contacts','module.contacts','boolean','true',true,false,'[]',NULL,'active'),
  ('contacts.vendors','Vendors','contacts','module.contacts','boolean','true',true,false,'[]',NULL,'active'),
  ('contacts.banks','Banks','contacts','module.contacts','boolean','true',true,false,'[]',NULL,'active'),
  ('contacts.developers_contact','Developer Contacts','contacts','module.contacts','boolean','true',true,false,'["module.developers"]',NULL,'active'),
  ('contacts.other_parties','Other Parties','contacts','module.contacts','boolean','true',true,false,'[]',NULL,'active'),
  -- NOTIFICATIONS
  ('module.notifications','Notifications','notifications',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.in_app','In-App Notifications','notifications','module.notifications','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.red_dot','Red Dot / Unread Count Badge','notifications','notifications.in_app','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.approval','Approval Notifications','notifications','module.notifications','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.case','Case Notifications','notifications','module.notifications','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.accounting','Accounting Notifications','notifications','module.notifications','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.pv_escalation','PV Escalation','notifications','notifications.accounting','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.lawyer','Lawyer Notifications','notifications','module.notifications','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.manager','Manager Notifications','notifications','module.notifications','boolean','true',true,false,'[]',NULL,'active'),
  ('notifications.partner_escalation','Partner Escalation','notifications','module.notifications','boolean','true',true,false,'[]',NULL,'active'),
  -- HIMS
  ('module.hims','HIMS / eSPA Tracker','hims',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('hims.tracker','HIMS Status Tracker','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.credentials','Developer Credentials / Config','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.project_mapping','Project / Phase Mapping','hims','module.hims','boolean','true',true,false,'["module.projects"]',NULL,'active'),
  ('hims.unit_lot_title','Unit/Lot/Title Mapping','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.espa_status','eSPA Status','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.spa_tracker','SPA Tracker','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.spa_stamped_handover','SPA Stamped Handover','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.status_check','Status Check (api)','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.compare_lawcaspro_hims','Compare Lawcaspro ↔ HIMS','hims','module.hims','boolean','true',true,false,'[]',NULL,'active'),
  ('hims.compare_lawcaspro_ekyc','Compare Lawcaspro ↔ eKYC','hims','module.hims','boolean','true',true,false,'["module.ekyc"]',NULL,'active'),
  ('hims.notifications','HIMS Notifications','hims','module.hims','boolean','true',true,false,'["module.notifications"]',NULL,'active'),
  -- EKYC
  ('module.ekyc','eKYC / Identity Verification','ekyc',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('ekyc.verify','Identity Verification','ekyc','module.ekyc','boolean','true',true,false,'[]',NULL,'active'),
  ('ekyc.status','Status Overview','ekyc','module.ekyc','boolean','true',true,false,'[]',NULL,'active'),
  ('ekyc.comparison','Comparison','ekyc','module.ekyc','boolean','true',true,false,'[]',NULL,'active'),
  ('ekyc.history','History','ekyc','module.ekyc','boolean','true',true,false,'[]',NULL,'active'),
  -- REPORTS
  ('module.reports','Reports','reports',NULL,'boolean','true',true,false,'[]','/app/reports','active'),
  ('reports.case','Case Reports','reports','module.reports','boolean','true',true,false,'["module.cases"]',NULL,'active'),
  ('reports.accounting','Accounting Reports','reports','module.reports','boolean','true',true,false,'["module.accounting"]',NULL,'active'),
  ('reports.hr','HR Reports','reports','module.reports','boolean','true',true,false,'["module.hr"]',NULL,'active'),
  ('reports.management','Management Reports','reports','module.reports','boolean','true',true,false,'[]',NULL,'active'),
  ('reports.status','Status Reports','reports','module.reports','boolean','true',true,false,'[]',NULL,'active'),
  ('reports.productivity','Productivity Reports','reports','module.reports','boolean','true',true,false,'[]',NULL,'active'),
  ('reports.audit','Audit Reports','reports','module.reports','boolean','true',true,false,'["module.audit"]',NULL,'active'),
  ('reports.export_pdf','PDF Export','reports','module.reports','boolean','true',true,false,'[]',NULL,'active'),
  ('reports.export_excel','Excel Export','reports','module.reports','boolean','true',true,false,'[]',NULL,'active'),
  -- SETTINGS
  ('module.settings','Settings (Firm)','settings',NULL,'boolean','true',true,false,'[]','/app/settings','active'),
  ('settings.firm','Firm Settings','settings','module.settings','boolean','true',true,false,'[]',NULL,'active'),
  ('settings.case','Case Settings / Types / Config','settings','module.settings','boolean','true',true,false,'["module.cases"]',NULL,'active'),
  ('settings.reference','Reference Number Config','settings','settings.case','boolean','true',true,false,'[]',NULL,'active'),
  ('settings.accounting','Accounting Settings','settings','module.settings','boolean','true',true,false,'["module.accounting"]','/app/settings/accounting','active'),
  ('settings.hr','HR Settings','settings','module.settings','boolean','true',true,false,'["module.hr"]',NULL,'active'),
  ('settings.email','Email Settings','settings','module.settings','boolean','true',true,false,'["module.communications"]','/app/settings/email','active'),
  ('settings.document','Document / Templates Settings','settings','module.settings','boolean','true',true,false,'["module.documents"]','/app/settings/templates','active'),
  ('settings.notifications','Notification Settings','settings','module.settings','boolean','true',true,false,'["module.notifications"]',NULL,'active'),
  ('settings.integrations','Integrations Settings','settings','module.settings','boolean','true',true,false,'[]',NULL,'active'),
  ('settings.subscription','Subscription & Billing (Firm view)','settings','module.settings','boolean','true',true,false,'[]',NULL,'active'),
  ('settings.logs','Logs (firm)','settings','module.settings','boolean','true',true,false,'["module.audit"]','/app/settings/logs','active'),
  -- STORAGE
  ('module.storage','Storage / File Custody','storage',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('storage.file_custody','File Custody Registry','storage','module.storage','boolean','true',true,false,'[]','/app/file-custody','active'),
  ('storage.uploads','General File Uploads','storage','module.storage','boolean','true',true,false,'[]',NULL,'active'),
  ('limit.storage.gb','Storage (GB)','storage','module.storage','integer','100',true,false,'[]',NULL,'active'),
  -- AI
  ('module.ai','AI & OCR Capabilities','ai',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('ai.ocr','OCR Engine','ai','module.ai','boolean','true',true,false,'[]',NULL,'active'),
  ('ai.draft','AI Drafting Assistant','ai','module.ai','boolean','true',true,false,'[]',NULL,'active'),
  ('ai.reading','AI Reading / Extraction','ai','module.ai','boolean','true',true,false,'[]',NULL,'active'),
  ('limit.ai.ocr_pages_monthly','OCR Pages / Month','ai','module.ai','integer','1000',true,false,'[]',NULL,'active'),
  ('limit.ai.draft_tokens_monthly','AI Draft Tokens / Month','ai','module.ai','integer','-1',true,false,'[]',NULL,'active'),
  -- AUDIT
  ('module.audit','Audit Logs','audit',NULL,'boolean','true',true,false,'[]',NULL,'active'),
  ('audit.logs','View Audit Logs','audit','module.audit','boolean','true',true,false,'[]','/app/audit-logs','active'),
  ('audit.export','Export Audit Logs','audit','module.audit','boolean','true',true,false,'[]',NULL,'active'),
  -- PLATFORM (FOUNDER ONLY)
  ('module.platform','Platform Admin (Founder)','platform',NULL,'boolean','true',false,true,'[]',NULL,'active'),
  ('platform.firms','Firms Management','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.plans','Plans & Entitlements','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.billing','Billing & Ledger (founder view)','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.audit','Cross-Firm Audit','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.ops_center','Ops Center','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.approvals','Platform Approvals','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.support_sessions','Support Sessions','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.incident_center','Incident Center','platform','module.platform','boolean','true',false,true,'[]',NULL,'active'),
  ('platform.governance','Governance','platform','module.platform','boolean','true',false,true,'[]',NULL,'active');

  GET DIAGNOSTICS _cnt_pf = ROW_COUNT;

  INSERT INTO platform_features (
    feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, dependency_json, route_hint, status, created_at, updated_at
  )
  SELECT t.feature_key, t.name, t.module, t.parent_feature_key, t.value_type::text, t.default_value, t.configurable, t.founder_only, t.dependency_json, t.route_hint, t.status::text, now(), now()
  FROM tmp_pf t
  ON CONFLICT (feature_key) DO UPDATE SET
    name = EXCLUDED.name,
    module = EXCLUDED.module,
    parent_feature_key = EXCLUDED.parent_feature_key,
    value_type = EXCLUDED.value_type,
    configurable = EXCLUDED.configurable,
    founder_only = EXCLUDED.founder_only,
    dependency_json = EXCLUDED.dependency_json,
    route_hint = EXCLUDED.route_hint,
    status = EXCLUDED.status,
    updated_at = now();

  -- 2. plan_entitlements per plan --------------------------------------------

  -- Starter deny lists --------------------------------------------------------
  DROP TABLE IF EXISTS tmp_starter_deny;
  CREATE TEMP TABLE tmp_starter_deny (k text PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO tmp_starter_deny (k) VALUES
    ('module.hr'),('module.einvoice'),('module.ai'),('module.hims'),('module.ekyc'),
    ('storage.file_custody'),('communications.whatsapp'),('accounting.bank_reconciliation'),
    ('einvoice.lhdn_integration'),('cases.intake'),('cases.conflict_check'),('cases.monitor'),
    ('documents.batch'),('documents.ai_read'),('documents.ai_migration');

  DROP TABLE IF EXISTS tmp_starter_deny_modules;
  CREATE TEMP TABLE tmp_starter_deny_modules (m text PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO tmp_starter_deny_modules (m) VALUES ('hr'),('ai'),('hims'),('ekyc'),('einvoice');

  INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
  SELECT _starter_id, t.feature_key,
    CASE
      WHEN t.founder_only THEN 'false'::jsonb
      WHEN EXISTS (SELECT 1 FROM tmp_starter_deny d WHERE d.k = t.feature_key) THEN 'false'::jsonb
      WHEN EXISTS (SELECT 1 FROM tmp_starter_deny_modules d WHERE d.m = t.module) THEN 'false'::jsonb
      WHEN t.value_type = 'boolean' THEN COALESCE(CASE
        WHEN t.feature_key = 'limit.users.max' THEN to_jsonb(5)
        WHEN t.feature_key = 'limit.cases.max' THEN to_jsonb(200)
        WHEN t.feature_key = 'limit.cases.monthly_new' THEN to_jsonb(50)
        WHEN t.feature_key = 'limit.storage.gb' THEN to_jsonb(20)
        WHEN t.feature_key = 'limit.documents.generation_monthly' THEN to_jsonb(200)
        WHEN t.feature_key = 'limit.ai.ocr_pages_monthly' THEN to_jsonb(0)
        WHEN t.feature_key = 'limit.ai.draft_tokens_monthly' THEN to_jsonb(0)
        ELSE t.default_value END, 'true'::jsonb)
      WHEN t.value_type IN ('integer','decimal','unlimited') THEN
        COALESCE(CASE
          WHEN t.feature_key = 'limit.users.max' THEN to_jsonb(5)
          WHEN t.feature_key = 'limit.cases.max' THEN to_jsonb(200)
          WHEN t.feature_key = 'limit.cases.monthly_new' THEN to_jsonb(50)
          WHEN t.feature_key = 'limit.storage.gb' THEN to_jsonb(20)
          WHEN t.feature_key = 'limit.documents.generation_monthly' THEN to_jsonb(200)
          WHEN t.feature_key = 'limit.ai.ocr_pages_monthly' THEN to_jsonb(0)
          WHEN t.feature_key = 'limit.ai.draft_tokens_monthly' THEN to_jsonb(0)
          ELSE t.default_value END, to_jsonb(0))
      ELSE t.default_value END,
    now(), now()
  FROM tmp_pf t;
  GET DIAGNOSTICS _cnt_pe = ROW_COUNT;

  -- Pro ----------------------------------------------------------------------
  INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
  SELECT _pro_id, t.feature_key,
    CASE
      WHEN t.founder_only THEN 'false'::jsonb
      WHEN t.value_type = 'boolean' THEN COALESCE(t.default_value, 'true'::jsonb)
      WHEN t.value_type IN ('integer','decimal','unlimited') THEN
        COALESCE(CASE
          WHEN t.feature_key = 'limit.users.max' THEN to_jsonb(30)
          WHEN t.feature_key = 'limit.storage.gb' THEN to_jsonb(100)
          WHEN t.feature_key = 'limit.ai.ocr_pages_monthly' THEN to_jsonb(1000)
          WHEN t.feature_key = 'limit.ai.draft_tokens_monthly' THEN to_jsonb(-1)
          ELSE t.default_value END, to_jsonb(0))
      ELSE t.default_value END,
    now(), now()
  FROM tmp_pf t;
  GET DIAGNOSTICS _cnt_pe = _cnt_pe + ROW_COUNT;

  -- Enterprise ---------------------------------------------------------------
  INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
  SELECT _enterprise_id, t.feature_key,
    CASE
      WHEN t.founder_only THEN 'false'::jsonb
      WHEN t.value_type = 'boolean' THEN COALESCE(t.default_value, 'true'::jsonb)
      WHEN t.value_type IN ('integer','decimal','unlimited') THEN
        CASE WHEN t.feature_key LIKE 'limit.%' THEN to_jsonb(-1) ELSE COALESCE(t.default_value, to_jsonb(-1)) END
      ELSE t.default_value END,
    now(), now()
  FROM tmp_pf t;
  GET DIAGNOSTICS _cnt_pe = _cnt_pe + ROW_COUNT;

  RAISE NOTICE '[0150] Done: platform_features=%, plan_entitlements=% (starter=%, pro=%, enterprise=%)',
    _cnt_pf, _cnt_pe, _starter_id, _pro_id, _enterprise_id;
END $$;
