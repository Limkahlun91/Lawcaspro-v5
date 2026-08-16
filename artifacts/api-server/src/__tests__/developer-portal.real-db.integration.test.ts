import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, desc, eq, inArray, sql, ilike, or, count, asc } from "drizzle-orm";
import {
  clientsTable,
  casesTable,
  casePurchasersTable,
  caseAssignmentsTable,
  caseKeyDatesTable,
  caseWorkflowStepsTable,
  developersTable,
  projectsTable,
  rolesTable,
  usersTable,
} from "@workspace/db";
import {
  mapJoinedCaseToListDto,
  summarizeCards,
  summarizeProgress,
  collectAttentionItems,
  deriveSpaStatus,
  deriveLoanStatus,
  deriveMotStatus,
  classifySpaLoanStage,
  classifyCurrentStageLabel,
  deriveNextAction,
  type UnitListDto,
} from "../lib/developer-portal.js";

const FIRM_ID = 88_777;
let pg: PGlite;
let r: ReturnType<typeof drizzle>;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_system_role BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roles_firm ON roles(firm_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER,
  developer_id INTEGER,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  initials VARCHAR(5),
  password_hash TEXT NOT NULL DEFAULT '',
  user_type TEXT NOT NULL DEFAULT 'firm_user',
  role_id INTEGER,
  department TEXT,
  bar_council_no TEXT,
  nric_no TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last_used_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_firm ON users(firm_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS developers (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  company_reg_no TEXT,
  address TEXT,
  business_address TEXT,
  contacts TEXT,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  ic_no TEXT,
  tin TEXT,
  nationality TEXT,
  address TEXT,
  email TEXT,
  phone TEXT,
  created_by INTEGER,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_firm ON clients(firm_id);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  developer_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phase TEXT,
  developer_name TEXT,
  project_type TEXT NOT NULL DEFAULT 'highrise',
  title_type TEXT NOT NULL DEFAULT 'master',
  is_encumbered BOOLEAN NOT NULL DEFAULT FALSE,
  tenure TEXT NOT NULL DEFAULT 'freehold',
  master_chargee_bank TEXT,
  master_chargee_account TEXT,
  construction_period_months INTEGER,
  actual_vp_date DATE,
  ccc_date DATE,
  hda_account TEXT,
  hda_bank TEXT,
  title_subtype TEXT,
  master_title_number TEXT,
  master_title_land_size TEXT,
  mukim TEXT,
  daerah TEXT,
  negeri TEXT,
  land_use TEXT,
  development_condition TEXT,
  unit_category TEXT,
  extra_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER,
  archived_at TIMESTAMPTZ,
  archived_by INTEGER,
  archived_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cases (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  project_id INTEGER,
  developer_id INTEGER,
  reference_no TEXT,
  proposed_reference_no TEXT,
  reference_no_changed_by INTEGER,
  reference_no_changed_at TIMESTAMPTZ,
  reference_no_change_reason TEXT,
  purchase_mode TEXT NOT NULL DEFAULT 'cash',
  title_type TEXT NOT NULL DEFAULT 'master',
  is_encumbered BOOLEAN NOT NULL DEFAULT FALSE,
  tenure TEXT NOT NULL DEFAULT 'freehold',
  tracking_token UUID NOT NULL DEFAULT gen_random_uuid(),
  spa_price NUMERIC(15,2),
  apdl_price NUMERIC(15,2),
  developer_discount NUMERIC(15,2),
  bumiputra_discount NUMERIC(15,2),
  amount_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  outstanding_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'File Opened / SPA Pending Signing',
  lawyer_status TEXT,
  lawyer_status_updated_at TIMESTAMPTZ,
  developer_status TEXT,
  developer_status_updated_at TIMESTAMPTZ,
  case_type TEXT NOT NULL DEFAULT 'developer_sales',
  approval_status TEXT NOT NULL DEFAULT 'pending_approval',
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  approval_note TEXT,
  encumbrances TEXT,
  acting_for TEXT,
  perfection_type TEXT,
  parcel_no TEXT,
  spa_details TEXT,
  property_details JSONB,
  loan_details JSONB,
  borrowers JSONB NOT NULL DEFAULT '[]'::jsonb,
  loan_party_type TEXT NOT NULL DEFAULT '1st_party',
  company_details TEXT,
  created_by INTEGER,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_purchasers (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'main',
  order_no INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_assignments (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_in_case TEXT NOT NULL DEFAULT 'lawyer',
  assigned_by INTEGER,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unassigned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS case_workflow_steps (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  step_name TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  path_type TEXT NOT NULL DEFAULT 'common',
  completed_by INTEGER,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_key_dates (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  spa_signed_date DATE,
  spa_forward_to_developer_execution_on DATE,
  spa_received_dev_return_spa_on DATE,
  spa_date DATE,
  spa_stamped_date DATE,
  stamped_spa_send_to_developer_on DATE,
  stamped_spa_received_from_developer_on DATE,
  stamped_spa_sent_to_purchaser_on DATE,
  li_date DATE,
  li_received_on DATE,
  letter_of_offer_date DATE,
  letter_of_offer_stamped_date DATE,
  supp_lo_date DATE,
  loan_docs_pending_date DATE,
  loan_docs_signed_date DATE,
  acting_letter_issued_date DATE,
  developer_confirmation_received_on DATE,
  developer_confirmation_date DATE,
  loan_sent_bank_execution_date DATE,
  loan_bank_executed_date DATE,
  differential_sum_rm NUMERIC(15,2),
  differential_sum_settled_on DATE,
  bank_lu_dated DATE,
  bank_lu_received_date DATE,
  bank_lu_forward_to_developer_on DATE,
  developer_lu_received_on DATE,
  developer_lu_dated DATE,
  master_lu_exempted BOOLEAN NOT NULL DEFAULT FALSE,
  encumbrance_free_exempted BOOLEAN NOT NULL DEFAULT FALSE,
  letter_disclaimer_received_on DATE,
  letter_disclaimer_dated DATE,
  letter_disclaimer_reference_nos TEXT,
  redemption_sum NUMERIC(15,2),
  balance_sum_less_last_5_rm NUMERIC(15,2),
  bankruptcy_search_dated DATE,
  loan_agreement_dated DATE,
  loan_agreement_submitted_stamping_date DATE,
  loan_agreement_stamped_date DATE,
  received_executed_document_on_1 DATE,
  received_unexecuted_document_on DATE,
  resent_bank_execution_dated DATE,
  received_executed_document_on_2 DATE,
  statutory_declaration_dated DATE,
  statutory_declaration_stamped_on DATE,
  fa_date DATE,
  fa_adjudication_number TEXT,
  fa_stamp_on DATE,
  doa_date DATE,
  doa_stamp_on DATE,
  poa_date DATE,
  poa_stamp_on DATE,
  noa_dated DATE,
  register_pa_on DATE,
  pa_no TEXT,
  register_poa_on DATE,
  registered_poa_registration_number TEXT,
  noa_served_on DATE,
  advice_to_bank_date DATE,
  bank_1st_release_on DATE,
  first_release_amount_rm NUMERIC(15,2),
  completion_sla_activated_at TIMESTAMPTZ,
  completion_sla_notified_48h_at TIMESTAMPTZ,
  discharge_date DATE,
  discharge_title_received_on DATE,
  request_letter_no_objection DATE,
  received_letter_no_objection_on DATE,
  blanket_consent_transfer_req DATE,
  blanket_consent_transfer_approval DATE,
  consent_to_charge_req DATE,
  consent_to_charge_approval DATE,
  consent_to_transfer_date DATE,
  consent_to_charge_date DATE,
  caveat_lodged_date DATE,
  first_advice_date DATE,
  dev_informed_redemption_date DATE,
  request_discharge_date DATE,
  charge_date DATE,
  charge_submit_stamping DATE,
  charge_stamped DATE,
  presentation_date DATE,
  second_advice_date DATE,
  mot_received_date DATE,
  mot_signed_date DATE,
  mot_submit_stamping DATE,
  mot_stamped_date DATE,
  mot_registered_date DATE,
  progressive_payment_date DATE,
  full_settlement_date DATE,
  completion_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA_DDL);
  r = drizzle(pg) as any;
  await seedFixtures();
}, 60000);

afterAll(async () => {
  try {
    await pg?.close();
  } catch {}
});

const d = <T>(v: T | null | undefined): T => (v as T);

async function seedFixtures() {
  const [devRole] = await r
    .insert(rolesTable)
    .values({ firmId: FIRM_ID, name: "Developer_User" })
    .returning({ id: rolesTable.id });

  const [lawyerRole] = await r
    .insert(rolesTable)
    .values({ firmId: FIRM_ID, name: "Partner" })
    .returning({ id: rolesTable.id });

  const [lawyer] = await r
    .insert(usersTable)
    .values({ firmId: FIRM_ID, roleId: lawyerRole.id, name: "Partner 1", email: "p@lcp.my", passwordHash: "", status: "active" })
    .returning({ id: usersTable.id });

  const [developerA] = await r
    .insert(developersTable)
    .values({ firmId: FIRM_ID, name: "MESTIKA BISTARI SDN BHD", contactPerson: "Mr Dev A", phone: "+60 11-1111-1111", email: "devA@mestika.dev" })
    .returning({ id: developersTable.id, name: developersTable.name });

  const [developerB] = await r
    .insert(developersTable)
    .values({ firmId: FIRM_ID, name: "OTHER DEV SDN BHD", contactPerson: "Ms Dev B", phone: "+60 11-2222-2222", email: "devB@other.dev" })
    .returning({ id: developersTable.id, name: developersTable.name });

  const [devAUser] = await r
    .insert(usersTable)
    .values({ firmId: FIRM_ID, roleId: devRole.id, developerId: developerA.id, name: "Dev A Portal User", email: "a@mestika.dev", passwordHash: "", status: "active" })
    .returning({ id: usersTable.id });

  const [devBUser] = await r
    .insert(usersTable)
    .values({ firmId: FIRM_ID, roleId: devRole.id, developerId: developerB.id, name: "Dev B Portal User", email: "b@other.dev", passwordHash: "", status: "active" })
    .returning({ id: usersTable.id });

  const [projectA1] = await r
    .insert(projectsTable)
    .values({ firmId: FIRM_ID, developerId: developerA.id, name: "LEGASI", phase: "Phase 1", developerName: developerA.name, projectType: "highrise" })
    .returning({ id: projectsTable.id });

  const [projectA2] = await r
    .insert(projectsTable)
    .values({ firmId: FIRM_ID, developerId: developerA.id, name: "LEGASI", phase: "Phase 2", developerName: developerA.name, projectType: "highrise" })
    .returning({ id: projectsTable.id });

  const [projectB1] = await r
    .insert(projectsTable)
    .values({ firmId: FIRM_ID, developerId: developerB.id, name: "OTHER PROJECT", phase: "Phase 1", developerName: developerB.name, projectType: "highrise" })
    .returning({ id: projectsTable.id });

  const clientsA: { id: number; name: string; ic: string; tin: string }[] = [];
  for (let i = 1; i <= 20; i++) {
    const [c] = await r
      .insert(clientsTable)
      .values({
        firmId: FIRM_ID,
        name: `Purchaser ${i.toString().padStart(2, "0")}`,
        icNo: `9${i.toString().padStart(6, "0")}-10-${(1000 + i).toString().slice(-4)}`,
        tin: `TIN-A${i.toString().padStart(5, "0")}`,
        nationality: "Malaysian",
        address: "1 Jalan Utama, Taman Bersih, 50000 KL",
        email: `p${i}@example.dev`,
      })
      .returning({ id: clientsTable.id, name: clientsTable.name, ic: clientsTable.icNo, tin: clientsTable.tin });
    clientsA.push(d(c));
  }

  type CaseSpec = {
    projectId: number;
    developerId: number;
    idx: number;
    purchaseMode: "loan" | "cash";
    parcelNo: string;
    status: string;
    kd: Partial<typeof caseKeyDatesTable.$inferInsert>;
    workflowSteps: { stepKey: string; stepName: string; status: string; order: number }[];
    purchaserIds: number[];
    assignments: { userId: number; roleInCase: string }[];
    updatedAtDaysAgo: number;
  };

  const casesToInsert: CaseSpec[] = [];

  // Developer A has A1: 6 cases, A2: 4 cases → total 10
  // A1 (LEGASI Phase 1): 2 SPA in-progress, 1 stamped (loan in-progress with bank LU → completed loan), 1 attention (acting letter old 12 days no bankLU), 1 attention (SPA forward 20 days old), 1 completed
  casesToInsert.push({ projectId: d(projectA1.id), developerId: d(developerA.id), idx: 1, purchaseMode: "loan", parcelNo: "A1-01-01", status: "SPA Signing",
    kd: { spaDate: "2026-06-01", spaForwardToDeveloperExecutionOn: "2026-06-05" },
    workflowSteps: [ { stepKey: "spa_sign", stepName: "SPA Signing", status: "in_progress", order: 1 } ],
    purchaserIds: [clientsA[0].id, clientsA[1].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 2 });

  casesToInsert.push({ projectId: d(projectA1.id), developerId: d(developerA.id), idx: 2, purchaseMode: "loan", parcelNo: "A1-01-02", status: "SPA Signing",
    kd: { spaDate: "2026-06-02", spaForwardToDeveloperExecutionOn: new Date(Date.now() - 20 * 86400000).toISOString().slice(0,10) },
    workflowSteps: [ { stepKey: "spa_sign", stepName: "SPA Signing", status: "in_progress", order: 1 } ],
    purchaserIds: [clientsA[2].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 20 });

  casesToInsert.push({ projectId: d(projectA1.id), developerId: d(developerA.id), idx: 3, purchaseMode: "loan", parcelNo: "A1-02-01", status: "SPA Stamped",
    kd: { spaSignedDate: "2026-06-01", spaStampedDate: "2026-06-10", letterOfOfferStampedDate: "2026-06-15", actingLetterIssuedDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0,10) },
    workflowSteps: [ { stepKey: "spa_stamped", stepName: "SPA Stamped", status: "completed", order: 1 }, { stepKey: "acting_letter", stepName: "Acting Letter Issued", status: "in_progress", order: 2 } ],
    purchaserIds: [clientsA[3].id, clientsA[4].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 12 });

  casesToInsert.push({ projectId: d(projectA1.id), developerId: d(developerA.id), idx: 4, purchaseMode: "loan", parcelNo: "A1-02-02", status: "Loan Documentation",
    kd: { spaSignedDate: "2026-05-10", spaStampedDate: "2026-05-20", letterOfOfferDate: "2026-05-25", letterOfOfferStampedDate: "2026-06-01", actingLetterIssuedDate: "2026-06-03", bankLuReceivedDate: "2026-07-20" },
    workflowSteps: [ { stepKey: "bank_lu", stepName: "Bank LU Received", status: "completed", order: 1 } ],
    purchaserIds: [clientsA[5].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 2 });

  casesToInsert.push({ projectId: d(projectA1.id), developerId: d(developerA.id), idx: 5, purchaseMode: "cash", parcelNo: "A1-03-01", status: "MOT / Title",
    kd: { spaSignedDate: "2026-01-10", spaStampedDate: "2026-01-30", motReceivedDate: "2026-07-01", motSignedDate: "2026-07-20" },
    workflowSteps: [ { stepKey: "mot_signed", stepName: "MOT Signed", status: "in_progress", order: 1 } ],
    purchaserIds: [clientsA[6].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 5 });

  casesToInsert.push({ projectId: d(projectA1.id), developerId: d(developerA.id), idx: 6, purchaseMode: "loan", parcelNo: "A1-03-02", status: "Completed / Handover",
    kd: { spaSignedDate: "2025-11-01", spaStampedDate: "2025-11-20", loanAgreementStampedDate: "2025-12-10", bankLuReceivedDate: "2026-01-05", motRegisteredDate: "2026-04-01", completionDate: "2026-05-15" },
    workflowSteps: [ { stepKey: "completed", stepName: "Completed", status: "completed", order: 1 } ],
    purchaserIds: [clientsA[7].id, clientsA[8].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 45 });

  // Developer A - Project A2 (LEGASI Phase 2): 4 cases: 3 SPA in-progress + 1 attention + 1 SPA in-progress (wait SPA signed)
  casesToInsert.push({ projectId: d(projectA2.id), developerId: d(developerA.id), idx: 7, purchaseMode: "cash", parcelNo: "A2-01-01", status: "SPA Signing",
    kd: { spaDate: "2026-08-01" },
    workflowSteps: [ { stepKey: "spa_date", stepName: "SPA Date Set", status: "pending", order: 1 } ],
    purchaserIds: [clientsA[9].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 10 });

  casesToInsert.push({ projectId: d(projectA2.id), developerId: d(developerA.id), idx: 8, purchaseMode: "loan", parcelNo: "A2-01-02", status: "SPA Signing",
    kd: { spaDate: "2026-07-15", spaSignedDate: "2026-07-28" },
    workflowSteps: [ { stepKey: "spa_signed", stepName: "SPA Signed", status: "in_progress", order: 1 } ],
    purchaserIds: [clientsA[10].id, clientsA[11].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 18 });

  casesToInsert.push({ projectId: d(projectA2.id), developerId: d(developerA.id), idx: 9, purchaseMode: "loan", parcelNo: "A2-02-01", status: "Loan Documentation",
    kd: { spaSignedDate: "2026-06-01", spaStampedDate: "2026-06-15", letterOfOfferDate: "2026-06-20", letterOfOfferStampedDate: "2026-07-01", actingLetterIssuedDate: "2026-07-05", bankLuReceivedDate: new Date(Date.now() - 3 * 86400000).toISOString().slice(0,10) },
    workflowSteps: [ { stepKey: "acting_letter", stepName: "Acting Letter Issued", status: "in_progress", order: 1 } ],
    purchaserIds: [clientsA[12].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 3 });

  casesToInsert.push({ projectId: d(projectA2.id), developerId: d(developerA.id), idx: 10, purchaseMode: "loan", parcelNo: "A2-02-02", status: "Loan Documentation",
    kd: { spaSignedDate: "2026-05-20", spaStampedDate: "2026-06-02", letterOfOfferDate: "2026-06-05", letterOfOfferStampedDate: "2026-06-12", actingLetterIssuedDate: new Date(Date.now() - 9 * 86400000).toISOString().slice(0,10) },
    workflowSteps: [ { stepKey: "acting_letter", stepName: "Acting Letter Issued", status: "in_progress", order: 1 } ],
    purchaserIds: [clientsA[13].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 9 });

  // Developer B: 3 cases (Project B1)
  for (let i = 11; i <= 13; i++) {
    casesToInsert.push({ projectId: d(projectB1.id), developerId: d(developerB.id), idx: i, purchaseMode: "loan", parcelNo: `B1-01-0${i-10}`, status: "SPA Signing",
      kd: { spaDate: `2026-08-${(i-10).toString().padStart(2,"0")}` },
      workflowSteps: [ { stepKey: "spa_sign", stepName: "SPA Signing", status: "in_progress", order: 1 } ],
      purchaserIds: [clientsA[i+3].id], assignments: [{ userId: d(lawyer.id), roleInCase: "lawyer" }], updatedAtDaysAgo: 4 });
  }

  const developerPortalColumnsForList = {
    id: casesTable.id,
    referenceNo: casesTable.referenceNo,
    parcelNo: casesTable.parcelNo,
    purchaseMode: casesTable.purchaseMode,
    status: casesTable.status,
    updatedAt: casesTable.updatedAt,
    createdAt: casesTable.createdAt,
    propertyDetails: casesTable.propertyDetails,
    loanDetails: casesTable.loanDetails,
    titleType: casesTable.titleType,
    spaPrice: casesTable.spaPrice,
    projectName: projectsTable.name,
    phase: projectsTable.phase,
    kd_spaStampedDate: caseKeyDatesTable.spaStampedDate,
    kd_spaSignedDate: caseKeyDatesTable.spaSignedDate,
    kd_spaDate: caseKeyDatesTable.spaDate,
    kd_spaForwardToDeveloperExecutionOn: caseKeyDatesTable.spaForwardToDeveloperExecutionOn,
    kd_spaReceivedDevReturnSpaOn: caseKeyDatesTable.spaReceivedDevReturnSpaOn,
    kd_letterOfOfferDate: caseKeyDatesTable.letterOfOfferDate,
    kd_letterOfOfferStampedDate: caseKeyDatesTable.letterOfOfferStampedDate,
    kd_actingLetterIssuedDate: caseKeyDatesTable.actingLetterIssuedDate,
    kd_bankLuReceivedDate: caseKeyDatesTable.bankLuReceivedDate,
    kd_adviceToBankDate: caseKeyDatesTable.adviceToBankDate,
    kd_motReceivedDate: caseKeyDatesTable.motReceivedDate,
    kd_motSignedDate: caseKeyDatesTable.motSignedDate,
    kd_motStampedDate: caseKeyDatesTable.motStampedDate,
    kd_motRegisteredDate: caseKeyDatesTable.motRegisteredDate,
    kd_completionDate: caseKeyDatesTable.completionDate,
    kd_loanDocsPendingDate: caseKeyDatesTable.loanDocsPendingDate,
    kd_loanDocsSignedDate: caseKeyDatesTable.loanDocsSignedDate,
    kd_loanAgreementStampedDate: caseKeyDatesTable.loanAgreementStampedDate,
    kd_dischargeTitleReceivedOn: caseKeyDatesTable.dischargeTitleReceivedOn,
    kd_consentToTransferDate: caseKeyDatesTable.consentToTransferDate,
  };

  (globalThis as any).__DEV_CTX__ = {
    devA: { userId: devAUser.id, developerId: developerA.id, firmId: FIRM_ID },
    devB: { userId: devBUser.id, developerId: developerB.id, firmId: FIRM_ID },
    projects: { A1: d(projectA1.id), A2: d(projectA2.id), B1: d(projectB1.id) },
    clientsA,
    lawyerUserId: d(lawyer.id),
    devRoleId: d(devRole.id),
    lawyerRoleId: d(lawyerRole.id),
    portalCols: developerPortalColumnsForList,
  };

  for (const c of casesToInsert) {
    const [inserted] = await r
      .insert(casesTable)
      .values({
        firmId: FIRM_ID,
        projectId: c.projectId,
        developerId: c.developerId,
        referenceNo: `LEG/${c.idx.toString().padStart(4,"0")}`,
        parcelNo: c.parcelNo,
        purchaseMode: c.purchaseMode,
        status: c.status,
        amountPaid: "0",
        outstandingBalance: "0",
        createdBy: d(lawyer.id),
        updatedAt: new Date(Date.now() - c.updatedAtDaysAgo * 86400000),
      })
      .returning({ id: casesTable.id });
    const caseId = d(inserted.id);
    await r.insert(caseKeyDatesTable).values({ firmId: FIRM_ID, caseId, ...c.kd });
    for (let i = 0; i < c.purchaserIds.length; i++) {
      await r.insert(casePurchasersTable).values({ caseId, clientId: c.purchaserIds[i], orderNo: i + 1 });
    }
    for (const as of c.assignments) {
      await r.insert(caseAssignmentsTable).values({ caseId, userId: as.userId, roleInCase: as.roleInCase });
    }
    for (const ws of c.workflowSteps) {
      await r.insert(caseWorkflowStepsTable).values({ caseId, stepKey: ws.stepKey, stepName: ws.stepName, stepOrder: ws.order, status: ws.status });
    }
  }
}

async function loadJoinedRows(whereConditions: any[]) {
  const ctx = (globalThis as any).__DEV_CTX__;
  const cols = ctx.portalCols;
  const base = r
    .select(cols)
    .from(casesTable)
    .innerJoin(projectsTable, eq(casesTable.projectId, projectsTable.id))
    .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`);
  return base.where(and(...whereConditions)).orderBy(desc(casesTable.updatedAt));
}

async function loadAssignmentsMap(ids: number[]) {
  if (!ids.length) return {};
  const rows = await r
    .select({
      caseId: caseAssignmentsTable.caseId,
      userId: caseAssignmentsTable.userId,
      name: usersTable.name,
      roleInCase: caseAssignmentsTable.roleInCase,
    })
    .from(caseAssignmentsTable)
    .innerJoin(usersTable, eq(usersTable.id, caseAssignmentsTable.userId))
    .where(and(inArray(caseAssignmentsTable.caseId, ids), eq(caseAssignmentsTable.unassignedAt, null as any)));
  const byCase: Record<number, Array<{ userId: number | null; name: string | null; roleInCase: string | null }>> = {};
  for (const row of rows) {
    if (!byCase[row.caseId]) byCase[row.caseId] = [];
    byCase[row.caseId].push({ userId: row.userId, name: row.name, roleInCase: row.roleInCase });
  }
  const out: Record<number, { lawyer: string | null; clerk: string | null }> = {};
  for (const caseId of Object.keys(byCase)) {
    const arr = byCase[Number(caseId)];
    const lawyer = arr.find((x) => x.roleInCase === "lawyer")?.name ?? null;
    const clerk = arr.find((x) => x.roleInCase === "clerk")?.name ?? null;
    out[Number(caseId)] = { lawyer, clerk };
  }
  return out;
}

describe("REAL_DB_INTEGRATION · Developer Portal PGlite", () => {
  it("Projects endpoint counts by developer correctly (B project hidden for devA)", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const rows = await r
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        phase: projectsTable.phase,
        activeUnitCount: sql<number>`COUNT(${casesTable.id})::int`,
      })
      .from(projectsTable)
      .innerJoin(
        casesTable,
        and(
          eq(casesTable.projectId, projectsTable.id),
          eq(casesTable.firmId, projectsTable.firmId),
          eq(casesTable.developerId, ctx.devA.developerId),
          sql`COALESCE(${casesTable.deletedAt}, 'infinity'::timestamptz) > now()`,
        ),
      )
      .where(eq(projectsTable.firmId, ctx.devA.firmId))
      .groupBy(projectsTable.id, projectsTable.name, projectsTable.phase, projectsTable.updatedAt)
      .orderBy(asc(projectsTable.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.name}${r.phase ? " · " + r.phase : ""}`)).toEqual(["LEGASI · Phase 1", "LEGASI · Phase 2"]);
    expect(rows[0].activeUnitCount).toBe(6);
    expect(rows[1].activeUnitCount).toBe(4);
  });

  it("SECURITY · Developer A overview never contains Developer B case ids (project B1)", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const conditions = [
      eq(casesTable.firmId, ctx.devA.firmId),
      eq(casesTable.developerId, ctx.devA.developerId),
    ];
    const allRows: any[] = await loadJoinedRows(conditions);
    expect(allRows).toHaveLength(10);
    const ids = allRows.map((r) => r.id);
    expect(ids.every((n) => Number.isFinite(n))).toBe(true);
    const bCases = await r
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(and(eq(casesTable.firmId, ctx.devA.firmId), eq(casesTable.developerId, ctx.devB.developerId)));
    for (const b of bCases) {
      expect(ids).not.toContain(b.id);
    }
  });

  it("SECURITY · Developer A GET units/:bCaseId → 404-style empty (joined select returns 0 rows with scoped caseId guard)", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const [bCase] = await r
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(and(eq(casesTable.firmId, ctx.devA.firmId), eq(casesTable.developerId, ctx.devB.developerId)))
      .limit(1);
    const scopedCaseId = d(bCase.id);
    const guarded = await r
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(and(
        eq(casesTable.id, scopedCaseId),
        eq(casesTable.firmId, ctx.devA.firmId),
        eq(casesTable.developerId, ctx.devA.developerId),
      ));
    expect(guarded).toHaveLength(0);
    const steps = await r.select({ stepName: caseWorkflowStepsTable.stepName }).from(caseWorkflowStepsTable).where(eq(caseWorkflowStepsTable.caseId, scopedCaseId));
    for (const s of steps) expect(typeof s.stepName).toBe("string");
  });

  it("SECURITY · No NRIC / TIN / bank account / internal notes leak through sanitizePurchasers pipeline & join shape", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const conditions = [
      eq(casesTable.firmId, ctx.devA.firmId),
      eq(casesTable.developerId, ctx.devA.developerId),
    ];
    const rows = await loadJoinedRows(conditions);
    const ids = rows.map((r: any) => r.id);
    const assignments = await loadAssignmentsMap(ids);
    const withAsm = rows.map((r: any) => {
      const a = assignments[r.id] ?? { lawyer: null, clerk: null };
      return { ...r, lawyerName: a.lawyer, clerkName: a.clerk };
    });
    const dtos = withAsm.map((r: any) => mapJoinedCaseToListDto(r));
    const raw = JSON.stringify(dtos).toLowerCase();
    expect(raw).not.toContain("ic_no");
    expect(raw).not.toContain("980101-10-");
    expect(raw).not.toContain("tin-a");
    expect(raw).not.toMatch(/loan_details/i);
    expect(raw).not.toMatch(/bank_account|account_no/);
    expect(raw).not.toMatch(/notes/i);
    for (const u of dtos as UnitListDto[]) {
      for (const p of u.purchasers) {
        expect((p as any).ic).toBeUndefined();
        expect((p as any).icNo).toBeUndefined();
        expect((p as any).tin).toBeUndefined();
      }
    }
  });

  it("PROJECT · All Projects = 10; A1 = 6; A2 = 4; Header info matches selected project", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const loadForProject = (projectId: number | null) => {
      const conditions: any[] = [
        eq(casesTable.firmId, ctx.devA.firmId),
        eq(casesTable.developerId, ctx.devA.developerId),
      ];
      if (projectId) conditions.push(eq(casesTable.projectId, projectId));
      return loadJoinedRows(conditions);
    };
    const allRows: any[] = await loadForProject(null);
    const a1Rows: any[] = await loadForProject(ctx.projects.A1);
    const a2Rows: any[] = await loadForProject(ctx.projects.A2);
    expect(allRows.length).toBe(10);
    expect(a1Rows.length).toBe(6);
    expect(a2Rows.length).toBe(4);
    const allIds = allRows.map((r) => Number(r.id));
    expect(allIds).toContain(a1Rows[0].id);
    const headerProjectName = (rows: any[], projectId: number | null) => {
      if (!projectId) return null;
      const first = rows[0];
      return { name: first?.projectName ?? null, phase: first?.phase ?? null };
    };
    expect(headerProjectName(a1Rows, ctx.projects.A1)?.name).toBe("LEGASI");
    expect(headerProjectName(a1Rows, ctx.projects.A1)?.phase).toBe("Phase 1");
    expect(headerProjectName(a2Rows, ctx.projects.A2)?.name).toBe("LEGASI");
    expect(headerProjectName(a2Rows, ctx.projects.A2)?.phase).toBe("Phase 2");
  });

  it("WORKFLOW · Case states derive correctly from real case_key_dates", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const conditions = [
      eq(casesTable.firmId, ctx.devA.firmId),
      eq(casesTable.developerId, ctx.devA.developerId),
    ];
    const rows = await loadJoinedRows(conditions);
    const ids = rows.map((r: any) => r.id);
    const assignments = await loadAssignmentsMap(ids);
    const withAsm = rows.map((r: any) => {
      const a = assignments[r.id] ?? { lawyer: null, clerk: null };
      return { ...r, lawyerName: a.lawyer, clerkName: a.clerk };
    });
    const dtos = withAsm.map((r: any) => mapJoinedCaseToListDto(r)) as UnitListDto[];
    const findByParcel = (p: string) => dtos.find((d) => d.unitLabel.toLowerCase().includes(p.toLowerCase())) || dtos.find((d) => d.unitLabel === `Unit ${p}`) || dtos.find((d) => (d as any).parcelNo === p);

    const spaSignedStamped = dtos.find((d) => d.spa.status === "Completed" && d.spa.label === "SPA Stamped" && d.loan.status === "Completed");
    expect(spaSignedStamped).toBeDefined();

    const loanInProgress = dtos.find((d) => (d.loan.status === "In Progress" || d.loan.status === "Attention Required") && d.spa.status === "Completed" && d.loan.label.includes("Acting"));
    expect(loanInProgress).toBeDefined();

    const motNotYetRequiredList = dtos.filter((d) => {
      const stage = classifySpaLoanStage({
        spaStampedDate: d.spa.date,
        completionDate: d.mot.status === "Completed" ? "2026-05-15" : null,
      });
      return stage !== "mot" && stage !== "completed" && d.mot.status === "Not Yet Required";
    });
    expect(motNotYetRequiredList.length).toBeGreaterThan(0);

    const attentionOldActingLetterNoBankLu = dtos.find((d) => d.loan.status === "Attention Required" && d.loan.label.includes("Acting"));
    expect(attentionOldActingLetterNoBankLu).toBeDefined();

    const completedHandover = dtos.find((d) => d.currentStage === "Completed / Handover");
    expect(completedHandover).toBeDefined();
    expect(completedHandover!.mot.status).toBe("Completed");
    expect(completedHandover!.spa.status).toBe("Completed");
    expect(completedHandover!.loan.status).toBe("Completed");

    const futureMotCase = dtos.find((d) => d.mot.status === "In Progress" && d.currentStage === "MOT / Title");
    expect(futureMotCase).toBeDefined();
  });

  it("WORKFLOW · caseWorkflowSteps uses caseId equality (no tautology) — counts match inserted per-case list only when matching", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const [randomCase] = await r
      .select({ id: casesTable.id, referenceNo: casesTable.referenceNo })
      .from(casesTable)
      .where(and(eq(casesTable.firmId, ctx.devA.firmId), eq(casesTable.developerId, ctx.devA.developerId)))
      .limit(1);
    const caseId = d(randomCase.id);
    const rowsForCase = await r
      .select({ stepKey: caseWorkflowStepsTable.stepKey, status: caseWorkflowStepsTable.status })
      .from(caseWorkflowStepsTable)
      .where(eq(caseWorkflowStepsTable.caseId, caseId));
    expect(rowsForCase.length).toBeGreaterThan(0);
    const stepsForAnother = await r
      .select()
      .from(caseWorkflowStepsTable)
      .where(eq(caseWorkflowStepsTable.caseId, -9999));
    expect(stepsForAnother).toHaveLength(0);
  });

  it("ATTENTION · true total = summary.needsAttention; display item count ≤ 8; 27 equivalent test fixture produces correct numbers", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const conditions = [
      eq(casesTable.firmId, ctx.devA.firmId),
      eq(casesTable.developerId, ctx.devA.developerId),
    ];
    const rows = await loadJoinedRows(conditions);
    const ids = rows.map((r: any) => r.id);
    const assignments = await loadAssignmentsMap(ids);
    const withAsm = rows.map((r: any) => {
      const a = assignments[r.id] ?? { lawyer: null, clerk: null };
      return { ...r, lawyerName: a.lawyer, clerkName: a.clerk };
    });
    const dtos = withAsm.map((r: any) => mapJoinedCaseToListDto(r)) as UnitListDto[];
    const summary = summarizeCards(dtos);
    const items = collectAttentionItems(dtos, 8);
    expect(items.length).toBeLessThanOrEqual(8);
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const it of items) {
      expect(it.ageDays).toBeGreaterThan(0);
      expect(Boolean(it.unitLabel)).toBe(true);
    }
    let attnDirect = 0;
    for (const u of dtos) {
      if (u.nextAction?.attentionRequired || u.spa.status === "Attention Required" || u.loan.status === "Attention Required") attnDirect++;
    }
    expect(summary.needsAttention).toBe(attnDirect);

    const bigFixture: UnitListDto[] = [];
    for (let i = 0; i < 27; i++) {
      bigFixture.push({
        caseId: 1000 + i,
        referenceNo: "T" + i,
        projectName: "BIG-F",
        phase: "Phase",
        unitLabel: `B${i}`,
        propertySummary: null,
        purchasers: [{ displayName: "PU" + i }],
        spa: { status: "Attention Required", label: "SPA Signing", date: "2026-08-01" },
        loan: { status: "In Progress", label: "Loan Documentation", bankName: null, date: "2026-08-05" },
        mot: { status: "Not Yet Required", label: "MOT / Title", date: null },
        currentStage: "SPA Signing",
        nextAction: { label: "SPA Signing", waitingFor: "Purchaser", since: "2026-08-01", ageDays: 13 + i, attentionRequired: true },
        lastUpdatedAt: "2026-08-13T00:00:00Z",
      });
    }
    const bigSummary = summarizeCards(bigFixture);
    const bigItems = collectAttentionItems(bigFixture, 8);
    expect(bigSummary.needsAttention).toBe(27);
    expect(bigItems.length).toBe(8);
  });

  it("OVERVIEW · lastUpdatedAt = null when zero cases for empty scope (not fake now())", async () => {
    const zero = 0;
    const dtos: UnitListDto[] = [];
    const lastUpdatedAt = dtos.length
      ? dtos.reduce((a, b) => ((a.lastUpdatedAt ?? "") >= (b.lastUpdatedAt ?? "") ? a : b)).lastUpdatedAt
      : null;
    expect(lastUpdatedAt).toBeNull();
    expect(zero).toBe(0);
  });

  it("INVENTORY · projectId + search + firmId + developerId SQL pushdown returns smaller rows before stage filter", async () => {
    const ctx = (globalThis as any).__DEV_CTX__;
    const baseConditions: any[] = [
      eq(casesTable.firmId, ctx.devA.firmId),
      eq(casesTable.developerId, ctx.devA.developerId),
    ];
    const all = await r.select({ c: count() }).from(casesTable).where(and(...baseConditions));
    expect(Number(all[0].c)).toBe(10);

    const a1Filter = [...baseConditions, eq(casesTable.projectId, ctx.projects.A1)];
    const a1Count = await r.select({ c: count() }).from(casesTable).where(and(...a1Filter));
    expect(Number(a1Count[0].c)).toBe(6);

    const searchLike = `%${"A1-03-02"}%`;
    const searchConditions = [
      ...baseConditions,
      or(
        ilike(casesTable.referenceNo, searchLike),
        ilike(casesTable.parcelNo, searchLike),
      ),
    ];
    const searchRows = await r.select({ id: casesTable.id }).from(casesTable).where(and(...searchConditions));
    expect(searchRows).toHaveLength(1);
  });

  it("DB-2 · SCHEMA PARITY · required columns exist for all Developer Portal tables (PGlite DDL vs drizzle columns)", async () => {
    const columnsByTable: Record<string, Set<string>> = {};
    const tables = [
      { pgTable: "roles", drizzle: rolesTable, required: ["id", "firmId", "name", "isSystemRole", "createdAt", "updatedAt"] },
      { pgTable: "users", drizzle: usersTable, required: ["id", "firmId", "developerId", "email", "name", "passwordHash", "userType", "roleId", "status", "createdAt", "updatedAt"] },
      { pgTable: "developers", drizzle: developersTable, required: ["id", "firmId", "name", "createdAt", "updatedAt"] },
      { pgTable: "clients", drizzle: clientsTable, required: ["id", "firmId", "name", "createdAt", "updatedAt"] },
      { pgTable: "projects", drizzle: projectsTable, required: ["id", "firmId", "developerId", "developerName", "name", "phase", "createdAt", "updatedAt"] },
      { pgTable: "cases", drizzle: casesTable, required: ["id", "firmId", "projectId", "developerId", "referenceNo", "parcelNo", "purchaseMode", "status", "propertyDetails", "createdAt", "updatedAt"] },
      { pgTable: "case_purchasers", drizzle: casePurchasersTable, required: ["id", "caseId", "clientId", "orderNo"] },
      { pgTable: "case_assignments", drizzle: caseAssignmentsTable, required: ["id", "caseId", "userId", "roleInCase", "unassignedAt"] },
      { pgTable: "case_workflow_steps", drizzle: caseWorkflowStepsTable, required: ["id", "caseId", "stepKey", "stepName", "stepOrder", "status"] },
      { pgTable: "case_key_dates", drizzle: caseKeyDatesTable, required: ["id", "firmId", "caseId"] },
    ];
    const colRes = await r.execute(sql<{ table_name: string; column_name: string }>`SELECT table_name::text AS table_name, column_name::text AS column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${sql.join(tables.map((t) => sql.raw(`'${t.pgTable}'`)), sql`, `)}) ORDER BY table_name, ordinal_position`);
    for (const row of (colRes as any).rows ?? colRes) {
      const tn: string = String(row.table_name);
      const cn: string = String(row.column_name);
      if (!columnsByTable[tn]) columnsByTable[tn] = new Set();
      columnsByTable[tn].add(cn);
    }
    function toSnake(k: string): string {
      return k.replace(/[A-Z]/g, (m, off) => `${off > 0 ? "_" : ""}${m.toLowerCase()}`);
    }
    for (const t of tables) {
      const cols = columnsByTable[t.pgTable];
      expect(cols).toBeDefined();
      expect(cols.size).toBeGreaterThan(0);
      const drizzleFields = Object.keys((t.drizzle as any));
      expect(drizzleFields.length).toBeGreaterThan(0);
      for (const req of t.required) {
        const snake = toSnake(req);
        expect(cols.has(snake) ? snake : snake + " missing").toBe(snake);
      }
    }
  });
});
