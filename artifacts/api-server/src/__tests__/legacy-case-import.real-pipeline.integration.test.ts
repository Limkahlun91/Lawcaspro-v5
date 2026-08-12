import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseExcelWorkbook,
  type ParsedExcelWorkbook,
} from "../modules/cases/legacy-import/excel-parser.js";
import {
  autoMapHeaders,
  type MappingTemplateDefinition,
  applyRowMapping,
} from "../modules/cases/legacy-import/mapping-engine.js";
import { M_LEGASI_PRESET_MAPPING } from "../modules/cases/legacy-import/legacy-case-field-catalog.js";
import {
  deriveLegacyPurchaseMode,
  deriveLegacyLoanPartyType,
  LEGACY_IMPORT_V1_CASE_TYPE,
  LEGACY_CASE_TYPE_UNSUPPORTED_CODE,
  sanitizeLegacyImportError,
  runDryRun,
  runImport,
  validateFixedValues,
} from "../modules/cases/legacy-import/legacy-batch-pipeline.service.js";
import {
  createCaseCanonical,
  createCaseCanonicalInTx,
  type CanonicalCaseCreateContext,
  type CanonicalCaseCreateInput,
} from "../modules/cases/create-case-canonical.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

const TEST_FIRM_ID = 1;
const TEST_USER_ID = 42;
const TEST_ROLE_ID = 7;
const TEST_DEVELOPER_ID = 9001;
const TEST_PROJECT_ID = 9002;

type SheetRow = Record<string, unknown>;

function buildSyntheticWorkbookRows(): SheetRow[] {
  const rows: SheetRow[] = [];
  const numRows = 228;
  for (let i = 1; i <= numRows; i++) {
    const r: SheetRow = {};
    r["Our Ref"] = `LEG-${10000 + i}`;
    r["Parcel No"] = `PT 12345, Lot ${i}`;
    r["Purchase Price"] = 400_000 + i * 1000;
    r["Developer"] = "Test Developer Sdn Bhd";
    r["Property"] = `Test Apartment A-${i}`;
    r["Property Type"] = "Apartment";
    r["Ignored Historical Column"] = `UNUSED-${i}`;

    const hasP4 = i % 7 === 0;
    const hasP3 = hasP4 || i % 5 === 0;
    const hasP2 = hasP3 || i % 2 === 0;
    r["Purchaser 1"] = `Purchaser One ${i}`;
    r["Purchaser 1 IC"] = `800101-01-${String(1000 + i).slice(-4)}`;
    if (hasP2) {
      r["Purchaser 2"] = `Purchaser Two ${i}`;
      r["Purchaser 2 IC"] = `800202-02-${String(2000 + i).slice(-4)}`;
    }
    if (hasP3) {
      r["Purchaser 3"] = `Purchaser Three ${i}`;
      r["Purchaser 3 IC"] = `800303-03-${String(3000 + i).slice(-4)}`;
    }
    if (hasP4) {
      r["Purchaser 4"] = `Purchaser Four ${i}`;
      r["Purchaser 4 IC"] = `800404-04-${String(4000 + i).slice(-4)}`;
    }

    const bucket = i % 10;
    if (bucket === 0) {
      r["Borrower 1"] = `Purchaser One ${i}`;
      const icRaw = `800101-01-${String(1000 + i).slice(-4)}`;
      r["Borrower 1 IC"] = icRaw.replace(/-/g, "");
      r["End Financier"] = "Maybank";
      r["Bank Ref"] = `MAY-${i}`;
      r["Property Financing Sum"] = 320_000;
      r["Total Loan"] = 320_000;
    } else if (bucket === 1) {
      r["Borrower 1"] = `Third Party Guarantor ${i}`;
      r["Borrower 1 IC"] = `900101-01-${String(9000 + i).slice(-4)}`;
      r["Borrower 2"] = `Third Party Sibling ${i}`;
      r["Borrower 2 IC"] = `900202-02-${String(9000 + i).slice(-4)}`;
      r["End Financier"] = "CIMB";
      r["Bank Ref"] = `CIMB-${i}`;
      r["Property Financing Sum"] = 300_000;
      r["Total Loan"] = 300_000;
    } else if (bucket === 2) {
      r["End Financier"] = "Public Bank";
      r["Bank Ref"] = `PB-${i}`;
      r["Property Financing Sum"] = 310_000;
    } else if (bucket === 4) {
      r["Bank Ref"] = "0";
      r["Total Loan"] = 0;
      r["Property Financing Sum"] = -100;
    } else if (bucket === 5) {
      r["Borrower 1"] = r["Purchaser 1"] as string;
      r["Borrower 1 IC"] = String(r["Purchaser 1 IC"] ?? "").replace(/-/g, "");
      if (hasP2) {
        r["Borrower 2"] = r["Purchaser 2"] as string;
        r["Borrower 2 IC"] = String(r["Purchaser 2 IC"] ?? "").replace(/-/g, "");
      }
      r["End Financier"] = "AmBank";
      r["Property Financing Sum"] = 200_000;
    }

    if (i % 3 === 0) {
      r["SPA date"] = "";
      r["SPA stamping"] = "";
      r["LO Date"] = "";
    } else {
      r["SPA date"] = new Date(2024, (i % 12), (i % 27) + 1).toISOString().slice(0, 10);
      r["SPA stamping"] = new Date(2024, (i % 12), (i % 27) + 5).toISOString().slice(0, 10);
      r["LO Date"] = new Date(2024, (i % 12), (i % 27) - 1).toISOString().slice(0, 10);
    }
    rows.push(r);
  }
  return rows;
}

function buildWorkbookBuffer(): Buffer {
  const rows = buildSyntheticWorkbookRows();
  const headers = [
    "Our Ref",
    "Parcel No",
    "Purchaser 1",
    "Purchaser 1 IC",
    "Purchaser 2",
    "Purchaser 2 IC",
    "Purchaser 3",
    "Purchaser 3 IC",
    "Purchaser 4",
    "Purchaser 4 IC",
    "Borrower 1",
    "Borrower 1 IC",
    "Borrower 2",
    "Borrower 2 IC",
    "Developer",
    "Property",
    "Property Type",
    "Purchase Price",
    "End Financier",
    "Bank Ref",
    "Property Financing Sum",
    "Total Loan",
    "SPA date",
    "SPA stamping",
    "LO Date",
    "Ignored Historical Column",
  ];
  const aoa: unknown[][] = [headers];
  for (const r of rows) aoa.push(headers.map((h) => r[h] ?? ""));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(out);
}

async function bootstrapMinimalSchema() {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS firms (
      id serial PRIMARY KEY, name text NOT NULL, slug text NOT NULL,
      status text NOT NULL DEFAULT 'active', subscription_plan_id integer NOT NULL,
      subscription_status text NOT NULL DEFAULT 'active',
      custom_price_monthly numeric(12, 2), is_custom_plan boolean NOT NULL DEFAULT false,
      show_master_documents boolean NOT NULL DEFAULT true,
      logo_url text, address text, st_number text, tin_number text,
      registration_no text, sst_no text, phone text, email text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS roles (
      id serial PRIMARY KEY, firm_id integer NOT NULL, name text NOT NULL,
      is_system_role boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS permissions (
      id serial PRIMARY KEY, role_id integer NOT NULL, module text NOT NULL,
      action text NOT NULL, allowed boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY, firm_id integer, developer_id integer, email text NOT NULL,
      name text NOT NULL, initials varchar(5), password_hash text NOT NULL,
      user_type text NOT NULL DEFAULT 'firm_user', role_id integer, department text,
      bar_council_no text, nric_no text, status text NOT NULL DEFAULT 'active',
      totp_secret text, totp_enabled boolean NOT NULL DEFAULT false,
      totp_last_used_at timestamptz, last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS developers (
      id serial PRIMARY KEY, firm_id integer NOT NULL,
      name text NOT NULL, company_reg_no text,
      address text, business_address text, contacts text, contact_person text,
      phone text, email text, created_by integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id serial PRIMARY KEY, firm_id integer NOT NULL, developer_id integer NOT NULL,
      name text NOT NULL, phase text, developer_name text,
      project_type text NOT NULL DEFAULT 'highrise', title_type text NOT NULL DEFAULT 'master',
      is_encumbered boolean NOT NULL DEFAULT false, tenure text NOT NULL DEFAULT 'freehold',
      master_chargee_bank text, master_chargee_account text,
      construction_period_months integer, actual_vp_date date, ccc_date date,
      hda_account text, hda_bank text, title_subtype text,
      master_title_number text, master_title_land_size text,
      mukim text, daerah text, negeri text, land_use text,
      development_condition text, unit_category text,
      extra_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by integer, archived_at timestamptz, archived_by integer, archived_reason text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS clients (
      id serial PRIMARY KEY, firm_id integer NOT NULL,
      name text NOT NULL, ic_no text, tin text,
      nationality text, address text, email text, phone text,
      created_by integer, deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cases (
      id serial PRIMARY KEY, firm_id integer NOT NULL,
      project_id integer, developer_id integer,
      reference_no text, proposed_reference_no text,
      reference_no_changed_by integer, reference_no_changed_at timestamptz, reference_no_change_reason text,
      purchase_mode text NOT NULL DEFAULT 'cash', title_type text NOT NULL DEFAULT 'master',
      is_encumbered boolean NOT NULL DEFAULT false, tenure text NOT NULL DEFAULT 'freehold',
      tracking_token uuid NOT NULL DEFAULT (md5((random()::text || clock_timestamp()::text))::uuid),
      spa_price numeric(15, 2), apdl_price numeric(15, 2),
      developer_discount numeric(15, 2), bumiputra_discount numeric(15, 2),
      amount_paid numeric(18, 2) NOT NULL DEFAULT 0,
      outstanding_balance numeric(18, 2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'File Opened / SPA Pending Signing',
      lawyer_status text, lawyer_status_updated_at timestamptz,
      developer_status text, developer_status_updated_at timestamptz,
      case_type text NOT NULL DEFAULT 'developer_sales',
      approval_status text NOT NULL DEFAULT 'pending_approval',
      submitted_by integer, submitted_at timestamptz,
      approved_by integer, approved_at timestamptz, approval_note text,
      encumbrances text, acting_for text, perfection_type text,
      parcel_no text, spa_details text,
      property_details jsonb, loan_details jsonb,
      borrowers jsonb NOT NULL DEFAULT '[]'::jsonb,
      loan_party_type text NOT NULL DEFAULT '1st_party',
      company_details text, created_by integer, deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cases_tracking_token_key ON cases (tracking_token);
    CREATE INDEX IF NOT EXISTS idx_cases_firm ON cases (firm_id);
    CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status);
    CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases (created_at);
    CREATE INDEX IF NOT EXISTS idx_cases_firm_status ON cases (firm_id, status);

    CREATE TABLE IF NOT EXISTS case_purchasers (
      id serial PRIMARY KEY, case_id integer NOT NULL,
      client_id integer NOT NULL, role text NOT NULL DEFAULT 'main',
      order_no integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS case_assignments (
      id serial PRIMARY KEY, case_id integer NOT NULL,
      user_id integer NOT NULL, role_in_case text NOT NULL DEFAULT 'lawyer',
      assigned_by integer, assigned_at timestamptz, unassigned_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS case_key_dates (
      id serial PRIMARY KEY, firm_id integer NOT NULL, case_id integer NOT NULL,
      spa_signed_date date, spa_forward_to_developer_execution_on date,
      spa_received_dev_return_spa_on date, spa_date date, spa_stamped_date date,
      stamped_spa_send_to_developer_on date, stamped_spa_received_from_developer_on date,
      stamped_spa_sent_to_purchaser_on date,
      li_date date, li_received_on date,
      letter_of_offer_date date, letter_of_offer_stamped_date date, supp_lo_date date,
      loan_docs_pending_date date, loan_docs_signed_date date,
      acting_letter_issued_date date, developer_confirmation_received_on date,
      developer_confirmation_date date,
      loan_sent_bank_execution_date date, loan_bank_executed_date date,
      differential_sum_rm numeric(15, 2), differential_sum_settled_on date,
      bank_lu_dated date, bank_lu_received_date date,
      bank_lu_forward_to_developer_on date, developer_lu_received_on date, developer_lu_dated date,
      master_lu_exempted boolean NOT NULL DEFAULT false,
      encumbrance_free_exempted boolean NOT NULL DEFAULT false,
      letter_disclaimer_received_on date, letter_disclaimer_dated date,
      letter_disclaimer_reference_nos text,
      redemption_sum numeric(15, 2), balance_sum_less_last_5_rm numeric(15, 2),
      bankruptcy_search_dated date, loan_agreement_dated date,
      loan_agreement_submitted_stamping_date date, loan_agreement_stamped_date date,
      received_executed_document_on_1 date, received_unexecuted_document_on date,
      resent_bank_execution_dated date, received_executed_document_on_2 date,
      statutory_declaration_dated date, statutory_declaration_stamped_on date,
      fa_date date, fa_adjudication_number text, fa_stamp_on date,
      doa_date date, doa_stamp_on date, poa_date date, poa_stamp_on date,
      noa_dated date, register_pa_on date, pa_no text,
      register_poa_on date, registered_poa_registration_number text,
      noa_served_on date, advice_to_bank_date date,
      bank_1st_release_on date, first_release_amount_rm numeric(15, 2),
      completion_sla_activated_at timestamptz, completion_sla_notified_48h_at timestamptz,
      discharge_date date, discharge_title_received_on date,
      request_letter_no_objection date, received_letter_no_objection_on date,
      blanket_consent_transfer_req date, blanket_consent_transfer_approval date,
      consent_to_charge_req date, consent_to_charge_approval date,
      consent_to_transfer_date date, consent_to_charge_date date,
      caveat_lodged_date date, first_advice_date date,
      dev_informed_redemption_date date, request_discharge_date date,
      charge_date date,
      charge_submit_stamping date, charge_stamped date,
      presentation_date date, second_advice_date date,
      mot_received_date date, mot_signed_date date,
      mot_submit_stamping date, mot_stamped_date date, mot_registered_date date,
      progressive_payment_date date, full_settlement_date date,
      completion_date date,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id serial PRIMARY KEY, firm_id integer,
      actor_id integer, actor_type text NOT NULL DEFAULT 'firm_user',
      action text NOT NULL, entity_type text, entity_id integer,
      detail text, ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS case_notifications (
      id serial PRIMARY KEY, firm_id integer NOT NULL, case_id integer NOT NULL,
      recipient_user_id integer NOT NULL, actor_user_id integer,
      type text NOT NULL, title text NOT NULL, message text,
      meta jsonb, is_read boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS legacy_case_import_batches (
      id serial PRIMARY KEY, firm_id integer NOT NULL,
      created_by integer NOT NULL,
      source_file_name text NOT NULL, source_file_hash text NOT NULL,
      source_sheet_name text, source_format text,
      mapping_template_id integer, header_fingerprint text,
      status text NOT NULL,
      mapping_json jsonb,
      fixed_values_json jsonb,
      options_json jsonb,
      total_rows integer NOT NULL DEFAULT 0,
      ready_rows integer NOT NULL DEFAULT 0, warning_rows integer NOT NULL DEFAULT 0,
      review_rows integer NOT NULL DEFAULT 0, duplicate_rows integer NOT NULL DEFAULT 0,
      imported_rows integer NOT NULL DEFAULT 0, failed_rows integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS legacy_case_import_rows (
      id serial PRIMARY KEY, firm_id integer NOT NULL,
      batch_id integer NOT NULL,
      source_row_no integer NOT NULL, source_row_hash text, source_reference text,
      raw_row_json jsonb, mapped_payload_json jsonb, validation_json jsonb,
      row_status text NOT NULL, idempotency_key text NOT NULL,
      duplicate_type text, duplicate_case_id integer, duplicate_score numeric,
      created_case_id integer, error_code text, error_message text,
      imported_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (firm_id, batch_id, source_row_no),
      UNIQUE (firm_id, idempotency_key)
    );
  `);
}

function insertSeed(tableName: string, values: Record<string, unknown>[]) {
  // Use raw SQL inserts to avoid all Drizzle-exported table shape mismatches.
  // All inserts in this file go through pg.exec() batched SQL.
  if (values.length === 0) return Promise.resolve();
  const keys = Object.keys(values[0]);
  const tuples: string[] = [];
  for (const v of values) {
    const parts = keys.map((k) => {
      const val = v[k];
      if (val === null || val === undefined) return "NULL";
      if (typeof val === "string") {
        return `'${val.replace(/'/g, "''")}'`;
      }
      if (typeof val === "object") {
        const s = JSON.stringify(val).replace(/'/g, "''");
        return `'${s}'::jsonb`;
      }
      if (typeof val === "boolean") return val ? "true" : "false";
      return String(val);
    });
    tuples.push(`(${parts.join(",")})`);
  }
  const cols = keys.map((k) => `"${k}"`).join(",");
  const sql = `INSERT INTO "${tableName}" (${cols}) VALUES ${tuples.join(",")} ON CONFLICT DO NOTHING;`;
  return pg.exec(sql);
}

beforeAll(async () => {
  pg = new PGlite();
  await bootstrapMinimalSchema();
  db = drizzle(pg);

  await insertSeed("firms", [{
    id: TEST_FIRM_ID, name: "Test Law Firm", slug: "test-law-firm",
    status: "active", subscription_plan_id: 1, subscription_status: "active",
    is_custom_plan: false, show_master_documents: true,
  }]);
  await insertSeed("developers", [{
    id: TEST_DEVELOPER_ID, firm_id: TEST_FIRM_ID,
    name: "Test Developer Sdn Bhd", created_by: TEST_USER_ID,
  }]);
  await insertSeed("projects", [{
    id: TEST_PROJECT_ID, firm_id: TEST_FIRM_ID, developer_id: TEST_DEVELOPER_ID,
    name: "Project A", project_type: "highrise", title_type: "master",
    tenure: "freehold", is_encumbered: false, created_by: TEST_USER_ID,
  }]);
  await insertSeed("roles", [{
    id: TEST_ROLE_ID, firm_id: TEST_FIRM_ID,
    name: "Partner", is_system_role: false,
  }]);
  await insertSeed("permissions", [
    { role_id: TEST_ROLE_ID, module: "cases", action: "create", allowed: true },
    { role_id: TEST_ROLE_ID, module: "cases", action: "view", allowed: true },
  ]);
  await insertSeed("users", [{
    id: TEST_USER_ID, firm_id: TEST_FIRM_ID,
    email: "tester@lawfirm.test", name: "Tester User",
    password_hash: "x", user_type: "firm_user", role_id: TEST_ROLE_ID, status: "active",
  }]);
});

afterAll(async () => {
  try { await pg.close(); } catch { /* ignore */ }
});

function extractFromParsedWorkbook(p: ParsedExcelWorkbook): { headers: string[]; rawRows: Record<string, unknown>[]; totalRowCount: number } {
  const sheet = p.sheets["Sheet1"] ?? p.sheets[Object.keys(p.sheets)[0]];
  return { headers: sheet.headers, rawRows: sheet.rows, totalRowCount: sheet.totalRowCount };
}

describe("Legacy Import — REAL DB Pipeline (PGlite + Synthetic 228 rows workbook)", () => {
  it("REAL-PARSE: synthetic 228 rows workbook parses with required headers + 228 rows", async () => {
    const buffer = buildWorkbookBuffer();
    const parsed = await parseExcelWorkbook(buffer, "synthetic-228.xlsx");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse failed");
    const { headers, rawRows, totalRowCount } = extractFromParsedWorkbook(parsed.data);
    expect(headers.length).toBeGreaterThan(20);
    const lowered = headers.map((h) => (typeof h === "string" ? h.toLowerCase() : String(h).toLowerCase()));
    expect(lowered).toContain("our ref");
    expect(lowered).toContain("parcel no");
    expect(lowered).toContain("purchaser 1");
    expect(lowered).toContain("purchaser 1 ic");
    expect(lowered).toContain("borrower 1");
    expect(lowered).toContain("end financier");
    expect(lowered).toContain("bank ref");
    expect(lowered).toContain("property financing sum");
    expect(lowered).toContain("total loan");
    expect(lowered).toContain("spa date");
    expect(lowered).toContain("spa stamping");
    expect(lowered).toContain("lo date");
    expect(lowered).toContain("ignored historical column");
    expect(totalRowCount).toBe(228);
    expect(rawRows.length).toBe(228);
    const ourRefKey = headers.find((h) => String(h).toLowerCase() === "our ref") ?? "our ref";
    expect(String(rawRows[0]?.[ourRefKey] ?? "")).toBe("LEG-10001");
  });

  it("HELPER-A: IC normalised (hyphen/no hyphen) match same → 1st_party same_as_purchaser", async () => {
    const purchasers = [{ ic: "800101-01-1234", name: "Ali", tin: null }] as any;
    const borrowers = [{ ic: "800101011234", name: "Ali", tin: null }] as any;
    const r = deriveLegacyLoanPartyType(purchasers, borrowers);
    expect(r.loanPartyType).toBe("1st_party");
    expect(r.borrowerMode).toBe("same_as_purchaser");
  });

  it("HELPER-B: different ICs → 3rd_party separate", async () => {
    const purchasers = [{ ic: "111111-11-1111", name: "A", tin: null }] as any;
    const borrowers = [{ ic: "222222-22-2222", name: "B", tin: null }] as any;
    const r = deriveLegacyLoanPartyType(purchasers, borrowers);
    expect(r.loanPartyType).toBe("3rd_party");
    expect(r.borrowerMode).toBe("separate");
  });

  it("HELPER-C: no borrower, endFinancierBank nonblank → loan", () => {
    expect(deriveLegacyPurchaseMode([], { endFinancierBank: "Maybank" })).toBe("loan");
  });

  it("HELPER-D: no borrower/bank/loan → cash", () => {
    expect(deriveLegacyPurchaseMode([], {})).toBe("cash");
  });

  it("HELPER-E: bankRef=0 / totalLoan=0 / negative amount → cash", () => {
    const r = deriveLegacyPurchaseMode([], { bankRef: "0", totalLoan: 0, propertyFinancingSum: -100 });
    expect(r).toBe("cash");
  });

  it("REAL-1..9: End-to-end EXACT 228 row dry-run + plan + import with real DB tables & real services", async () => {
    const buffer = buildWorkbookBuffer();
    const parsed = await parseExcelWorkbook(buffer, "synthetic-228.xlsx");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse failed");
    const { headers, rawRows, totalRowCount } = extractFromParsedWorkbook(parsed.data);
    expect(totalRowCount).toBe(228);
    expect(rawRows.length).toBe(228);

    const mappingTemplate = autoMapHeaders(headers, M_LEGASI_PRESET_MAPPING);
    const fixedValues = {
      projectId: TEST_PROJECT_ID,
      developerId: TEST_DEVELOPER_ID,
      caseType: LEGACY_IMPORT_V1_CASE_TYPE,
      preserveRef: true,
    };
    // Create batch with columns matching real @workspace/db export.
    // runDryRun reads options_json.columns + options_json.fixedValues, mapping_json, fixed_values_json.
    await insertSeed("legacy_case_import_batches", [{
      firm_id: TEST_FIRM_ID,
      created_by: TEST_USER_ID,
      source_file_name: "synthetic-228.xlsx",
      source_file_hash: `synthetic-hash-${Date.now()}`,
      source_sheet_name: "Sheet1",
      source_format: "xlsx",
      status: "mapping_saved",
      options_json: {
        storedHeaders: headers,
        sourceSheetName: "Sheet1",
        columns: mappingTemplate.columns,
        fixedValues,
      },
      mapping_template_id: null,
      header_fingerprint: null,
      total_rows: rawRows.length,
      ready_rows: 0, warning_rows: 0, review_rows: 0,
      duplicate_rows: 0, imported_rows: 0, failed_rows: 0,
    }]);
    const batchRes = await pg.query(
      `SELECT id FROM legacy_case_import_batches WHERE source_file_name = $1 ORDER BY id DESC LIMIT 1;`,
      ["synthetic-228.xlsx"]
    );
    const batchId = Number((batchRes.rows as any)[0].id);
    expect(batchId).toBeGreaterThan(0);

    // Also update mapping_json + fixed_values_json columns via UPDATE
    await pg.query(
      `UPDATE legacy_case_import_batches
       SET mapping_json = $1::jsonb,
           fixed_values_json = $2::jsonb,
           status = 'mapping_saved'
       WHERE id = $3;`,
      [
        JSON.stringify({ columns: mappingTemplate.columns }),
        JSON.stringify(fixedValues),
        batchId,
      ]
    );

    // Insert rows (batched 50) with real schema columns
    for (let i = 0; i < rawRows.length; i += 50) {
      const slice = rawRows.slice(i, i + 50);
      const batch = slice.map((r, j) => {
        const sourceRowNo = i + j + 1;
        const ourRefKey = headers.find((h) => String(h).toLowerCase() === "our ref");
        const srcRef = ourRefKey ? String(r[ourRefKey] ?? "") : "";
        return {
          firm_id: TEST_FIRM_ID,
          batch_id: batchId,
          source_row_no: sourceRowNo,
          source_row_hash: null,
          source_reference: srcRef || null,
          raw_row_json: JSON.stringify(r),
          mapped_payload_json: null,
          validation_json: null,
          row_status: "UPLOADED",
          idempotency_key: `synthetic-${batchId}-${sourceRowNo}`,
          duplicate_type: null,
          duplicate_case_id: null,
          duplicate_score: null,
          created_case_id: null,
          error_code: null,
          error_message: null,
        };
      });
      await insertSeed("legacy_case_import_rows", batch);
    }

    const dryRun = await runDryRun(db as any, batchId, TEST_FIRM_ID, TEST_USER_ID);
    expect(dryRun.summary.total).toBe(228);

    // §2 remove LIMIT 200: select ALL rows (not LIMIT 200)
    const rowsQ = await pg.query(
      `SELECT id, source_row_no, row_status, created_case_id FROM legacy_case_import_rows WHERE batch_id = $1 ORDER BY id;`,
      [batchId]
    );
    const rowStatuses: { id: number; source_row_no: number; row_status: string; created_case_id: number | null }[]
      = rowsQ.rows as any;
    expect(rowStatuses.length).toBe(228);
    const r51 = rowStatuses.find((r) => r.source_row_no === 51);
    const r228 = rowStatuses.find((r) => r.source_row_no === 228);
    expect(r51).toBeDefined();
    expect(r228).toBeDefined();
    // Debug: count status distribution
    const dist: Record<string, number> = {};
    for (const r of rowStatuses) dist[r.row_status] = (dist[r.row_status] ?? 0) + 1;
    console.log("[DEBUG REAL-1] row_status distribution after dry run:", JSON.stringify(dist));
    expect(["READY", "WARNING", "REVIEW_REQUIRED", "INVALID", "HARD_DUPLICATE"].includes(r51!.row_status)).toBe(true);
    expect(["READY", "WARNING", "REVIEW_REQUIRED", "INVALID", "HARD_DUPLICATE"].includes(r228!.row_status)).toBe(true);

    const importableIds: number[] = [];
    for (const r of rowStatuses) {
      if (r.row_status === "READY" || r.row_status === "WARNING") importableIds.push(r.id);
    }
    expect(importableIds.includes(r51!.id)).toBe(true);
    expect(importableIds.includes(r228!.id)).toBe(true);

    const casesBeforeRes = await pg.query(`SELECT count(*)::int AS c FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]);
    const caseCountBefore = Number((casesBeforeRes.rows as any)[0].c);
    const notifBeforeRes = await pg.query(`SELECT count(*)::int AS c FROM case_notifications WHERE firm_id = $1;`, [TEST_FIRM_ID]);
    const notifBefore = Number((notifBeforeRes.rows as any)[0].c);
    const auditRowImportedBeforeRes = await pg.query(
      `SELECT count(*)::int AS c FROM audit_logs WHERE firm_id = $1 AND action = 'cases.legacy_import.row_imported';`,
      [TEST_FIRM_ID]
    );
    const auditRowImportedBefore = Number((auditRowImportedBeforeRes.rows as any)[0].c);
    const auditLegacyBeforeRes = await pg.query(
      `SELECT count(*)::int AS c FROM audit_logs WHERE firm_id = $1 AND action = 'cases.legacy_import';`,
      [TEST_FIRM_ID]
    );
    const auditLegacyBefore = Number((auditLegacyBeforeRes.rows as any)[0].c);

    // §1: Required exact importableIds length 228 (no tolerance). This means ALL rows must be READY or WARNING.
    // If fewer, increase row count to 228.
    expect(importableIds.length).toBe(228);

    const CHUNK = 20;
    let chunkImportErrors = 0;
    let summaries: any[] = [];
    for (let i = 0; i < importableIds.length; i += CHUNK) {
      const chunk = importableIds.slice(i, i + CHUNK);
      try {
        const res = await runImport(db as any, batchId, TEST_FIRM_ID, TEST_USER_ID, {
          rowIds: chunk, includeWarnings: true, reviewOverrides: {},
          createCase: createCaseCanonicalInTx,
        } as any);
        summaries.push(res);
      } catch (e) {
        chunkImportErrors++;
        if (chunkImportErrors <= 3) console.error(`[DEBUG IMPORT ERROR chunk ${Math.floor(i / CHUNK)} first 3]:`, String(e?.message ?? e ?? "").slice(0, 500));
      }
    }
    console.log(`[DEBUG IMPORT SUMMARY] chunkImportErrors=${chunkImportErrors}/${Math.ceil(importableIds.length / CHUNK)} lastSummary=${JSON.stringify(summaries[summaries.length - 1] ? { status: summaries[summaries.length - 1]?.status, summary: summaries[summaries.length - 1]?.summary } : null)}`);

    // §1: Required exact ZERO chunk errors
    expect(chunkImportErrors).toBe(0);

    // §2 importedRows.length === 228; NO LIMIT 200
    const rowsAfterQ = await pg.query(
      `SELECT source_row_no, created_case_id, error_code, error_message FROM legacy_case_import_rows WHERE batch_id = $1 ORDER BY source_row_no;`,
      [batchId]
    );
    const importedRows = (rowsAfterQ.rows as any[]).filter((r) => r.created_case_id != null);
    expect(importedRows.length).toBe(228);
    for (const r of rowsAfterQ.rows as any[]) {
      expect(r.created_case_id).not.toBeNull();
      expect(r.error_message).toBeNull();
    }

    const casesAfterRes = await pg.query(`SELECT * FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]);
    const casesAfter = casesAfterRes.rows as any[];
    const createdCount = casesAfter.length - caseCountBefore;
    console.log(`[DEBUG IMPORT] caseCountBefore=${caseCountBefore}; casesAfter.length=${casesAfter.length}; created=${createdCount}`);
    // §1: required exact createdCount = 228
    expect(createdCount).toBe(228);
    for (const c of casesAfter.slice(caseCountBefore)) {
      expect(Number(c.project_id)).toBe(TEST_PROJECT_ID);
      expect(Number(c.developer_id)).toBe(TEST_DEVELOPER_ID);
      expect(c.case_type).toBe("developer_sales");
    }

    // §3: re-query for rows 51 & 228 created_case_id NOT NULL + cases real-exists
    const row51ReQ = await pg.query(
      `SELECT source_row_no, created_case_id FROM legacy_case_import_rows WHERE batch_id = $1 AND source_row_no = 51;`,
      [batchId]
    );
    const row228ReQ = await pg.query(
      `SELECT source_row_no, created_case_id FROM legacy_case_import_rows WHERE batch_id = $1 AND source_row_no = 228;`,
      [batchId]
    );
    const case51 = Number((row51ReQ.rows as any)[0]?.created_case_id);
    const case228 = Number((row228ReQ.rows as any)[0]?.created_case_id);
    expect(case51).toBeGreaterThan(0);
    expect(case228).toBeGreaterThan(0);
    const case51ExistsRes = await pg.query(`SELECT id FROM cases WHERE id = $1 AND firm_id = $2;`, [case51, TEST_FIRM_ID]);
    const case228ExistsRes = await pg.query(`SELECT id FROM cases WHERE id = $1 AND firm_id = $2;`, [case228, TEST_FIRM_ID]);
    expect(Number((case51ExistsRes.rows as any)[0]?.id)).toBe(case51);
    expect(Number((case228ExistsRes.rows as any)[0]?.id)).toBe(case228);

    // §5: Project + Developer exact 228
    const cntProjDevRes = await pg.query(
      `SELECT count(*)::int AS c FROM cases WHERE firm_id = $1 AND project_id = $2 AND developer_id = $3;`,
      [TEST_FIRM_ID, TEST_PROJECT_ID, TEST_DEVELOPER_ID]
    );
    expect(Number((cntProjDevRes.rows as any)[0].c)).toBe(228);

    // §4: retry same batch → idempotent zero tolerance
    for (let i = 0; i < importableIds.length; i += CHUNK) {
      const chunk = importableIds.slice(i, i + CHUNK);
      try {
        await runImport(db as any, batchId, TEST_FIRM_ID, TEST_USER_ID, {
          rowIds: chunk, includeWarnings: true, reviewOverrides: {},
          createCase: createCaseCanonicalInTx,
        } as any);
      } catch { /* ignore */ }
    }
    const casesRerunRes = await pg.query(`SELECT count(*)::int AS c, COUNT(DISTINCT reference_no)::int AS dc FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]);
    const rerunCount = Number((casesRerunRes.rows as any)[0].c);
    const distinctRef = Number((casesRerunRes.rows as any)[0].dc);
    expect(rerunCount).toBe(228);
    expect(distinctRef).toBe(228);
    const dupGrpRes = await pg.query(
      `SELECT reference_no, count(*) AS c FROM cases WHERE firm_id = $1 GROUP BY reference_no HAVING count(*) > 1 LIMIT 20;`,
      [TEST_FIRM_ID]
    );
    expect((dupGrpRes.rows as any[]).length).toBe(0);

    // §6 Purchasers exact
    const row7Q = await pg.query(`SELECT source_row_no, created_case_id FROM legacy_case_import_rows WHERE batch_id = $1 AND source_row_no = 7;`, [batchId]);
    const row1Q = await pg.query(`SELECT source_row_no, created_case_id FROM legacy_case_import_rows WHERE batch_id = $1 AND source_row_no = 1;`, [batchId]);
    const case7Id = Number((row7Q.rows as any)[0]?.created_case_id);
    const case1Id = Number((row1Q.rows as any)[0]?.created_case_id);
    // Case #7 is (i%7==0 => all 4 purchaser columns filled: P1,P2,P3,P4)
    expect(case7Id).toBeGreaterThan(0);
    const cp7Res = await pg.query(
      `SELECT cp.role, c.name, c.ic_no FROM case_purchasers cp JOIN clients c ON c.id = cp.client_id WHERE cp.case_id = $1 ORDER BY cp.order_no;`,
      [case7Id]
    );
    const cp7 = cp7Res.rows as any[];
    expect(cp7.length).toBe(4);
    expect(cp7[0].role).toBe("main");
    expect(cp7[1].role).toBe("joint");
    expect(cp7[2].role).toBe("joint");
    expect(cp7[3].role).toBe("joint");
    // Names/ICs match fixture
    expect(cp7[0].name).toBe("Purchaser One 7");
    expect(cp7[0].ic_no).toBe("800101-01-1007");
    expect(cp7[1].name).toBe("Purchaser Two 7");
    expect(cp7[1].ic_no).toBe("800202-02-2007");
    expect(cp7[2].name).toBe("Purchaser Three 7");
    expect(cp7[2].ic_no).toBe("800303-03-3007");
    expect(cp7[3].name).toBe("Purchaser Four 7");
    expect(cp7[3].ic_no).toBe("800404-04-4007");
    // 1-purchaser sample: Case #1 only has P1 (i=1 odd → i%2 != 0 → no hasP2)
    expect(case1Id).toBeGreaterThan(0);
    const cp1Res = await pg.query(
      `SELECT cp.role, c.name, c.ic_no FROM case_purchasers cp JOIN clients c ON c.id = cp.client_id WHERE cp.case_id = $1 ORDER BY cp.order_no;`,
      [case1Id]
    );
    const cp1 = cp1Res.rows as any[];
    expect(cp1.length).toBe(1);
    expect(cp1[0].name).toBe("Purchaser One 1");
    expect(cp1[0].ic_no).toBe("800101-01-1001");

    // §7: Audit exact (row_imported = 228; cases.legacy_import = 228)
    const auditRowImportedAfterRes = await pg.query(
      `SELECT count(*)::int AS c FROM audit_logs WHERE firm_id = $1 AND action = 'cases.legacy_import.row_imported';`,
      [TEST_FIRM_ID]
    );
    const auditRowImportedCount = Number((auditRowImportedAfterRes.rows as any)[0].c) - auditRowImportedBefore;
    expect(auditRowImportedCount).toBe(228);
    const auditLegacyAfterRes = await pg.query(
      `SELECT count(*)::int AS c FROM audit_logs WHERE firm_id = $1 AND action = 'cases.legacy_import';`,
      [TEST_FIRM_ID]
    );
    const auditLegacyCount = Number((auditLegacyAfterRes.rows as any)[0].c) - auditLegacyBefore;
    expect(auditLegacyCount).toBe(228);

    // §8: Notifications delta = 0 (legacy suppress notifications)
    const notifAfterRes = await pg.query(`SELECT count(*)::int AS c FROM case_notifications WHERE firm_id = $1;`, [TEST_FIRM_ID]);
    expect(Number((notifAfterRes.rows as any)[0].c) - notifBefore).toBe(0);
  }, 420_000);
});

describe("Normal createCaseCanonical — atomic rollback (REAL PGlite)", () => {
  it("ROLLBACK-1: assignment insert failure mid-create rolls back case + clients (canonical strictness)", async () => {
    const beforeRes = await Promise.all([
      pg.query(`SELECT count(*)::int AS c FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM clients WHERE firm_id = $1 OR firm_id IS NULL;`, [TEST_FIRM_ID]),
    ]);
    const caseCountBefore = Number((beforeRes[0].rows as any)[0].c);
    const clientCountBefore = Number((beforeRes[1].rows as any)[0].c);

    let observedMessage: string | null = null;
    try {
      // S13: Use INVALID assignment userId (999999 does not exist in users table).
      // Case insert + client insert happen first, then case_assignments insert triggers FK/NULL
      // failure because user_id is invalid — createCaseCanonical now propagates (S14: no fail-soft),
      // so drizzle transaction rolls back case + clients.
      const input: CanonicalCaseCreateInput = {
        caseType: "developer_sales",
        projectId: TEST_PROJECT_ID,
        developerId: TEST_DEVELOPER_ID,
        purchaseMode: "cash",
        titleType: "master",
        parcelNo: "ROLLBACK-1-Parcel",
        purchasers: [{ name: "Rollback Purchaser", ic: "880101-01-9999" }],
        actingFor: "purchaser",
        // Force internal assignment list with invalid user after partial TX.
        assignedLawyerId: 99999999,
      } as any;
      await createCaseCanonical({
        db: db as any,
        firmId: TEST_FIRM_ID,
        actorUserId: TEST_USER_ID,
        actorRoleId: TEST_ROLE_ID,
        canAssignAny: true,
        source: "web_create",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        logger: null,
      } as CanonicalCaseCreateContext, input);
      observedMessage = "SHOULD_HAVE_FAILED";
    } catch (err: any) {
      observedMessage = String(err?.message ?? err ?? "");
    }
    expect(observedMessage).not.toBeNull();
    console.log(`[ROLLBACK-1 DEBUG] before cases=${caseCountBefore} clients=${clientCountBefore}; observed="${observedMessage?.slice(0, 200)}"`);

    const afterRes = await Promise.all([
      pg.query(`SELECT count(*)::int AS c FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM clients WHERE firm_id = $1 OR firm_id IS NULL;`, [TEST_FIRM_ID]),
    ]);
    const caseCountAfter = Number((afterRes[0].rows as any)[0].c);
    const clientCountAfter = Number((afterRes[1].rows as any)[0].c);
    console.log(`[ROLLBACK-1 DEBUG] after cases=${caseCountAfter} clients=${clientCountAfter}`);

    // Rollback proof: exactly equal before vs after → no partial rows.
    expect(caseCountAfter).toBe(caseCountBefore);
    expect(clientCountAfter).toBe(clientCountBefore);
  }, 60_000);

  it("ROLLBACK-2: §9 true mid-transaction keydate rollback SPA=2099-01-01 FAILS AFTER Client+Case+Purchaser+Assignment inserted", async () => {
    // §9: Test-only constraint: REJECT SPA Date = 2099-01-01 on case_key_dates
    await pg.exec(`ALTER TABLE case_key_dates ADD CONSTRAINT spa_date_not_2099 CHECK (spa_date IS NULL OR spa_date < '2099-01-01'::date);`);
    const t1 = await Promise.all([
      pg.query(`SELECT count(*)::int AS c FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM clients WHERE firm_id = $1 OR firm_id IS NULL;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_purchasers cp JOIN cases c ON c.id = cp.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_assignments ca JOIN cases c ON c.id = ca.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_key_dates WHERE firm_id = $1;`, [TEST_FIRM_ID]),
    ]);
    const before = t1.map((r) => Number((r.rows as any)[0].c));
    let failed = false;
    try {
      const input: CanonicalCaseCreateInput = {
        caseType: "developer_sales",
        projectId: TEST_PROJECT_ID,
        developerId: TEST_DEVELOPER_ID,
        purchaseMode: "cash",
        titleType: "master",
        parcelNo: "ROLLBACK-2-Parcel",
        purchasers: [{ name: "Rollback Two Main", ic: "890101-01-2345", role: "main" } as any],
        actingFor: "purchaser",
        assignedLawyerId: TEST_USER_ID,
        mappedKeyDates: {
          spa_date: "2099-01-01",
        } as any,
      } as any;
      await createCaseCanonical({
        db: db as any,
        firmId: TEST_FIRM_ID,
        actorUserId: TEST_USER_ID,
        actorRoleId: TEST_ROLE_ID,
        canAssignAny: true,
        source: "web_create",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        logger: null,
      } as CanonicalCaseCreateContext, input);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const t2 = await Promise.all([
      pg.query(`SELECT count(*)::int AS c FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM clients WHERE firm_id = $1 OR firm_id IS NULL;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_purchasers cp JOIN cases c ON c.id = cp.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_assignments ca JOIN cases c ON c.id = ca.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_key_dates WHERE firm_id = $1;`, [TEST_FIRM_ID]),
    ]);
    const after = t2.map((r) => Number((r.rows as any)[0].c));
    console.log(`[ROLLBACK-2 DEBUG] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    expect(after[0] - before[0]).toBe(0); // cases delta 0
    expect(after[1] - before[1]).toBe(0); // clients delta 0
    expect(after[2] - before[2]).toBe(0); // purchasers delta 0
    expect(after[3] - before[3]).toBe(0); // assignments delta 0
    expect(after[4] - before[4]).toBe(0); // keydates delta 0

    await pg.exec(`ALTER TABLE case_key_dates DROP CONSTRAINT spa_date_not_2099;`);
  }, 60_000);

  it("ROLLBACK-3: §10 audit_logs reject cases.create FAILURE ROLLBACK all tables delta=0", async () => {
    // §10: Test-only constraint: reject action = cases.create in audit_logs
    // Clear existing audit rows first (they contain cases.create / legacy rows from prior tests)
    await pg.exec(`DELETE FROM audit_logs WHERE 1=1;`);
    await pg.exec(`ALTER TABLE audit_logs ADD CONSTRAINT no_cases_create CHECK (action <> 'cases.create');`);
    const t1 = await Promise.all([
      pg.query(`SELECT count(*)::int AS c FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM clients WHERE firm_id = $1 OR firm_id IS NULL;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_purchasers cp JOIN cases c ON c.id = cp.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_assignments ca JOIN cases c ON c.id = ca.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM audit_logs WHERE firm_id = $1;`, [TEST_FIRM_ID]),
    ]);
    const before = t1.map((r) => Number((r.rows as any)[0].c));
    let failed = false;
    try {
      const input: CanonicalCaseCreateInput = {
        caseType: "developer_sales",
        projectId: TEST_PROJECT_ID,
        developerId: TEST_DEVELOPER_ID,
        purchaseMode: "cash",
        titleType: "master",
        parcelNo: "ROLLBACK-3-Parcel",
        purchasers: [{ name: "Rollback Three Main", ic: "900101-01-5432", role: "main" } as any],
        actingFor: "purchaser",
        assignedLawyerId: TEST_USER_ID,
      } as any;
      await createCaseCanonical({
        db: db as any,
        firmId: TEST_FIRM_ID,
        actorUserId: TEST_USER_ID,
        actorRoleId: TEST_ROLE_ID,
        canAssignAny: true,
        source: "web_create",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        logger: null,
      } as CanonicalCaseCreateContext, input);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const t2 = await Promise.all([
      pg.query(`SELECT count(*)::int AS c FROM cases WHERE firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM clients WHERE firm_id = $1 OR firm_id IS NULL;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_purchasers cp JOIN cases c ON c.id = cp.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM case_assignments ca JOIN cases c ON c.id = ca.case_id WHERE c.firm_id = $1;`, [TEST_FIRM_ID]),
      pg.query(`SELECT count(*)::int AS c FROM audit_logs WHERE firm_id = $1;`, [TEST_FIRM_ID]),
    ]);
    const after = t2.map((r) => Number((r.rows as any)[0].c));
    console.log(`[ROLLBACK-3 DEBUG] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    expect(after[0] - before[0]).toBe(0);
    expect(after[1] - before[1]).toBe(0);
    expect(after[2] - before[2]).toBe(0);
    expect(after[3] - before[3]).toBe(0);
    expect(after[4] - before[4]).toBe(0);

    await pg.exec(`ALTER TABLE audit_logs DROP CONSTRAINT no_cases_create;`);
  }, 60_000);
});

describe("§11-14 PII sanitizer + strict caseType + fixed values validation", () => {
  it("§11 sanitizeLegacyImportError: known safe code passes code/message stripped PII", () => {
    const e1 = sanitizeLegacyImportError({ code: "PROJECT_NOT_FOUND", message: "Project not found" });
    expect(e1.code).toBe("PROJECT_NOT_FOUND");
    expect(e1.message).toBe("Project not found");
    expect(e1.message.length).toBeLessThanOrEqual(500);
  });

  it("§11 sanitizeLegacyImportError strips NRIC / names / emails / SQL tokens / connection strings", () => {
    const rawErr = new Error(
      `failed to insert row: purchaser=TEST JOHN NRIC 800101-01-1234 email=john@test.com address="42 Jalan Foo Bar" conn=postgresql://u:p@host:5432/db SQLSTATE 23505 duplicate key violates constraint detail: ...`
    );
    (rawErr as any).code = "SOME_UNKNOWN_DB_CODE";
    const sanitized = sanitizeLegacyImportError(rawErr);
    expect(sanitized.code).toBe("LEGACY_IMPORT_INTERNAL_ERROR");
    expect(sanitized.message).toContain("Legacy case import failed");
    expect(sanitized.message.length).toBeLessThanOrEqual(500);
    expect(sanitized.message).not.toContain("TEST JOHN");
    expect(sanitized.message).not.toContain("800101-01-1234");
    expect(sanitized.message).not.toContain("john@test.com");
    expect(sanitized.message).not.toContain("Jalan Foo Bar");
    expect(sanitized.message).not.toContain("postgresql://");
    expect(sanitized.message).not.toContain("SQLSTATE");
    expect(sanitized.message).not.toContain("constraint");
  });

  it("§13 import-error persistence: PII (TEST JOHN + NRIC) never stored in row.error_message nor audit detail", async () => {
    // §13 Inject synthetic failure with a fake DB-like error containing PII.
    // Use a fresh batch with ONE row that has TEST JOHN + 800101-01-1234, and force error via invalid project id.
    const headers = ["Our Ref", "Parcel No", "Purchaser 1", "Purchaser 1 IC"];
    const singleRow = {
      "Our Ref": "LEG-PII-001",
      "Parcel No": "PT XYZ",
      "Purchaser 1": "TEST JOHN",
      "Purchaser 1 IC": "800101-01-1234",
    };
    const aoa: unknown[][] = [
      headers,
      headers.map((h) => singleRow[h as keyof typeof singleRow] ?? ""),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S1");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const parsed = await parseExcelWorkbook(buf, "pii-test.xlsx");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse");
    const sheet = parsed.data.sheets["S1"] ?? parsed.data.sheets[Object.keys(parsed.data.sheets)[0]];
    const mapping = autoMapHeaders(sheet.headers, M_LEGASI_PRESET_MAPPING);

    // Inject with invalid project (999999 = not found) to force structured error from validateFixedValues
    const badFixed: any = {
      projectId: 999999, // project not found → produces safe error PROJECT_NOT_FOUND code
      developerId: TEST_DEVELOPER_ID,
      caseType: LEGACY_IMPORT_V1_CASE_TYPE,
      preserveRef: true,
    };

    // Insert batch & row
    const bRes1 = await pg.query(`SELECT coalesce(max(id),0)::int AS m FROM legacy_case_import_batches;`);
    const maxBid = Number((bRes1.rows as any)[0].m) + 100;
    await insertSeed("legacy_case_import_batches", [{
      id: maxBid,
      firm_id: TEST_FIRM_ID,
      created_by: TEST_USER_ID,
      source_file_name: "pii-test.xlsx",
      source_file_hash: `pii-hash-${Date.now()}`,
      source_sheet_name: "S1",
      source_format: "xlsx",
      status: "mapping_saved",
      options_json: { storedHeaders: sheet.headers, sourceSheetName: "S1", columns: mapping.columns, fixedValues: badFixed },
      mapping_template_id: null,
      header_fingerprint: null,
      total_rows: 1,
      ready_rows: 0, warning_rows: 0, review_rows: 0, duplicate_rows: 0, imported_rows: 0, failed_rows: 0,
    }]);
    await pg.query(
      `UPDATE legacy_case_import_batches SET mapping_json=$1::jsonb, fixed_values_json=$2::jsonb WHERE id=$3;`,
      [JSON.stringify({ columns: mapping.columns }), JSON.stringify(badFixed), maxBid]
    );
    await insertSeed("legacy_case_import_rows", [{
      firm_id: TEST_FIRM_ID,
      batch_id: maxBid,
      source_row_no: 1,
      source_row_hash: null,
      source_reference: "LEG-PII-001",
      raw_row_json: JSON.stringify(singleRow),
      mapped_payload_json: null,
      validation_json: null,
      row_status: "UPLOADED",
      idempotency_key: `pii-test-${maxBid}-1`,
      duplicate_type: null,
      duplicate_case_id: null,
      duplicate_score: null,
      created_case_id: null,
      error_code: null,
      error_message: null,
    }]);
    const auditFailBeforeR = await pg.query(`SELECT count(*)::int AS c FROM audit_logs WHERE firm_id=$1 AND action='cases.legacy_import.row_failed';`, [TEST_FIRM_ID]);
    const auditFailBefore = Number((auditFailBeforeR.rows as any)[0].c);

    // Dry run then import one row → will fail in validateFixedValues → produces failed row with sanitized message
    try { await runDryRun(db as any, maxBid, TEST_FIRM_ID, TEST_USER_ID); } catch { /* ignore */ }
    const rowsPreQ = await pg.query(`SELECT id, row_status FROM legacy_case_import_rows WHERE batch_id=$1;`, [maxBid]);
    const row = (rowsPreQ.rows as any[])[0];
    if (row && (row.row_status === "READY" || row.row_status === "WARNING")) {
      try {
        await runImport(db as any, maxBid, TEST_FIRM_ID, TEST_USER_ID, {
          rowIds: [row.id], includeWarnings: true, reviewOverrides: {},
          createCase: createCaseCanonicalInTx,
        } as any);
      } catch { /* ignore */ }
    }

    const failRowQ = await pg.query(
      `SELECT error_code, error_message FROM legacy_case_import_rows WHERE batch_id=$1 AND source_row_no=1;`,
      [maxBid]
    );
    const errRow = (failRowQ.rows as any[])[0];
    const msg = String(errRow?.error_message ?? "");
    const code = String(errRow?.error_code ?? "");
    console.log(`[PII-TEST] persisted code=${code} message=${JSON.stringify(msg)}`);
    // §13: no PII leak in persisted message
    expect(msg).not.toContain("TEST JOHN");
    expect(msg).not.toContain("800101-01-1234");
    // Also message length cap 500 or under (sanitizer limit)
    if (msg !== "" && msg !== null) {
      expect(msg.length).toBeLessThanOrEqual(500);
    }
    // §12 audit detail only has batchId rowId sourceRowNo errorCode — no raw error
    const auditFailAfterR = await pg.query(`SELECT detail FROM audit_logs WHERE firm_id=$1 AND action='cases.legacy_import.row_failed' ORDER BY id DESC LIMIT 5;`, [TEST_FIRM_ID]);
    const failCount = Number(((await pg.query(`SELECT count(*)::int AS c FROM audit_logs WHERE firm_id=$1 AND action='cases.legacy_import.row_failed';`, [TEST_FIRM_ID])).rows as any)[0].c) - auditFailBefore;
    if (failCount > 0) {
      for (const row of auditFailAfterR.rows as any[]) {
        const d = String(row.detail ?? "");
        expect(d).not.toContain("TEST JOHN");
        expect(d).not.toContain("800101-01-1234");
        expect(d).not.toMatch(/error=.+/); // No raw `error=…message…`
        expect(d).toContain("batchId=");
        expect(d).toContain("rowId=");
        expect(d).toContain(/errorCode=/);
      }
    }
  }, 120_000);

  it("§14 strict caseType: subsale mapping must HTTP 400 + LEGACY_CASE_TYPE_UNSUPPORTED (no silent remap)", async () => {
    // First: validateFixedValues() → must return LEGACY_CASE_TYPE_UNSUPPORTED directly for subsale
    const v = await validateFixedValues(db as any, TEST_FIRM_ID, {
      projectId: TEST_PROJECT_ID,
      developerId: TEST_DEVELOPER_ID,
      caseType: "subsale",
    });
    expect(v.ok).toBe(false);
    if (v.ok === false) {
      expect(v.code).toBe(LEGACY_CASE_TYPE_UNSUPPORTED_CODE);
      expect(v.message).toMatch(/Developer Sales/);
    }
    // Also: LEGACY_IMPORT_V1_CASE_TYPE still ok
    const v2 = await validateFixedValues(db as any, TEST_FIRM_ID, {
      projectId: TEST_PROJECT_ID,
      developerId: TEST_DEVELOPER_ID,
      caseType: LEGACY_IMPORT_V1_CASE_TYPE,
    });
    expect(v2.ok).toBe(true);
    // sanity: empty/null caseType also currently accepted (normalized default to developer_sales by caller in routes anyway)
    const v3 = await validateFixedValues(db as any, TEST_FIRM_ID, {
      projectId: TEST_PROJECT_ID,
      developerId: TEST_DEVELOPER_ID,
    });
    expect(v3.ok).toBe(true);
  });
});
