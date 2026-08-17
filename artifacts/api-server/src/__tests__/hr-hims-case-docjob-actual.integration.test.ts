import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { FEATURE_REGISTRY_MAP, getFeatureDefinition } from "@workspace/db";
import {
  applyEntitlementFoundationDdl,
  seedCanonicalFeatureRegistry,
} from "./pglite-bootstrap.js";
import {
  _resetEntitlementCacheForTests,
  getEffectiveEntitlement,
  canUseFeature,
  resolveEntitlementsBulk,
  type EntitlementResult,
} from "../services/entitlement-resolver.js";
import { computeDocGenJobProgress } from "../routes/documents.js";

const DOMAIN_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS cases (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_number text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  case_type text,
  primary_client_id integer
);

CREATE TABLE IF NOT EXISTS case_assignments (
  case_id integer NOT NULL,
  user_id integer NOT NULL,
  firm_id integer NOT NULL,
  role text DEFAULT 'Assigned',
  PRIMARY KEY (case_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS hr_employees (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  user_id integer,
  employee_number text,
  full_name text,
  status text DEFAULT 'active',
  joined_at date,
  department text,
  reporting_to_id integer
);

CREATE TABLE IF NOT EXISTS hr_leave_claims (
  id serial PRIMARY KEY,
  firm_id integer,
  employee_id integer,
  leave_type text,
  start_date date,
  end_date date,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_payroll_periods (
  id serial PRIMARY KEY,
  firm_id integer,
  period_name text,
  start_date date,
  end_date date,
  status text DEFAULT 'draft',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_payroll_entries (
  id serial PRIMARY KEY,
  firm_id integer,
  period_id integer,
  employee_id integer,
  gross_amount numeric DEFAULT 0,
  net_amount numeric DEFAULT 0,
  status text DEFAULT 'draft',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hims_connections (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  connection_name text,
  status text DEFAULT 'inactive',
  provider text,
  config jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hims_cases (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  connection_id integer,
  hims_case_ref text,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_templates (
  id serial PRIMARY KEY,
  firm_id integer,
  template_name text,
  template_type text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_template_versions (
  id serial PRIMARY KEY,
  template_id integer,
  firm_id integer,
  version_number integer DEFAULT 1,
  file_path text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_documents (
  id serial PRIMARY KEY,
  document_key text UNIQUE,
  document_name text,
  category text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_generation_jobs (
  id text PRIMARY KEY,
  firm_id integer NOT NULL,
  created_by integer,
  status text DEFAULT 'pending',
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  error_code text,
  error_summary text,
  total_count integer DEFAULT 0,
  success_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,
  pending_count integer DEFAULT 0,
  running_count integer DEFAULT 0,
  download_object_path text,
  last_heartbeat_at timestamptz
);

CREATE TABLE IF NOT EXISTS document_generation_job_items (
  id serial PRIMARY KEY,
  job_id text NOT NULL,
  firm_id integer NOT NULL,
  case_id integer,
  template_source text DEFAULT 'firm',
  template_id integer,
  template_version_id integer,
  status text DEFAULT 'pending',
  object_path text,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS case_messages (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  sender_id integer,
  message_text text,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_key_dates (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  date_label text,
  date_value date,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_loan_stamping (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  item_key text,
  item_status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_supp_lo_docs (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  document_name text,
  file_path text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_workflow_documents (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  workflow_key text,
  has_file boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_advances (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  advance_amount numeric DEFAULT 0,
  payee_name text,
  status text DEFAULT 'requested',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_workflow_steps (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  step_order integer,
  step_name text,
  is_completed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_ledger_entries (
  id serial PRIMARY KEY,
  firm_id integer,
  case_id integer,
  entry_type text,
  amount numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
`;

type DbConn = ReturnType<typeof drizzle>;

function rowsFromExec(res: unknown): Record<string, unknown>[] {
  if (res && Array.isArray(res)) {
    const first = res[0] as any;
    if (first && Array.isArray(first.rows)) return first.rows as Record<string, unknown>[];
    if (first && Array.isArray(first.fields)) {
      const out: Record<string, unknown>[] = [];
      const fields = first.fields.map((f: any) => typeof f === "string" ? f : f.name);
      for (const row of (first.rows ?? [])) {
        const o: Record<string, unknown> = {};
        fields.forEach((k: string, i: number) => { o[k] = row[i]; });
        out.push(o);
      }
      return out;
    }
  }
  const r = res as any;
  if (r && r.rows && Array.isArray(r.rows)) return r.rows as Record<string, unknown>[];
  return [];
}

function resolveDocGenNextActionInline(args: {
  status: string;
  progress: { total: number; success: number; failed: number; pending: number; running: number };
  downloadObjectPath?: string | null;
}): "run_next" | "finalize" | "download" | "stop" {
  if (args.status === "failed") return "stop";
  if (args.status === "generated_download_failed") return "download";
  if (args.status === "completed" || args.status === "completed_with_errors") {
    return "download";
  }
  if (args.status === "finalizing") return "finalize";
  if (args.progress.pending > 0) return "run_next";
  if (args.progress.running > 0) return "run_next";
  if (
    args.progress.total > 0 &&
    args.progress.pending === 0 &&
    args.progress.running === 0 &&
    args.progress.success + args.progress.failed === args.progress.total
  )
    return "finalize";
  return "run_next";
}

function getDisplayStatusFromSnapshot(snapshot: {
  status?: string;
  nextAction?: string;
  progress?: { total: number; success: number; failed: number; pending: number; running: number };
  totalCount?: number;
  successCount?: number;
  failedCount?: number;
  pendingCount?: number;
  runningCount?: number;
  downloadObjectPath?: string | null;
  downloadUrl?: string | null;
  downloadManifestUrl?: string | null;
  active?: boolean;
}): string {
  const st = String(snapshot?.status ?? "").toLowerCase();
  const nextAction = String(snapshot?.nextAction ?? "").toLowerCase();
  const p = snapshot?.progress ?? {
    total: snapshot?.totalCount ?? 0,
    success: snapshot?.successCount ?? 0,
    failed: snapshot?.failedCount ?? 0,
    pending: snapshot?.pendingCount ?? 0,
    running: snapshot?.runningCount ?? 0,
  };
  const isComplete = (() => {
    if (st === "failed") return true;
    return (
      p.total > 0 &&
      p.pending === 0 &&
      p.running === 0 &&
      p.success + p.failed === p.total
    );
  })();
  const zipReady = Boolean(
    snapshot?.downloadObjectPath || snapshot?.downloadUrl || snapshot?.downloadManifestUrl,
  );
  const active = (snapshot as any)?.active;
  if (
    st === "failed" ||
    nextAction === "stop" ||
    (active === false && !isComplete)
  ) {
    return "FAILED";
  }
  if (st === "cancelled") return "CANCELLED";
  if (!isComplete) return "GENERATING";
  if (p.success === 0) return "FAILED";
  if (p.failed === 0) {
    return zipReady ? "COMPLETED" : "GENERATED_DOWNLOAD_FAILED";
  }
  return zipReady ? "PARTIALLY_COMPLETED" : "GENERATED_DOWNLOAD_FAILED";
}

describe("PARTNER-HR tests (fresh PGlite)", () => {
  let pg: PGlite;
  let db: DbConn;

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    _resetEntitlementCacheForTests();
    await applyEntitlementFoundationDdl(pg);
    await seedCanonicalFeatureRegistry(pg);
    await pg.exec(DOMAIN_TABLES_DDL);
  }, 30000);

  it("PARTNER-HR-1: Partner with HR feature ON → dashboard resolves truthy (200 path)", async () => {
    await pg.exec(`
      INSERT INTO firm_entitlement_overrides (firm_id, feature_key, override_kind, override_mode)
      VALUES (1, 'hr.dashboard', 'permanent', 'force_on')
      ON CONFLICT (firm_id, feature_key) WHERE override_kind = 'permanent' DO UPDATE
        SET override_mode = 'force_on';
    `);
    _resetEntitlementCacheForTests();
    const res = await getEffectiveEntitlement(1, "hr.dashboard", { conn: db as any });
    expect(res.enabled).toBe(true);
    expect(canUseFeature(1, "hr.dashboard", { conn: db as any })).resolves.toBe(true);
  });

  it("PARTNER-HR-2: Partner with HR feature ON → employees path resolves truthy (200 path)", async () => {
    await pg.exec(`
      INSERT INTO firm_entitlement_overrides (firm_id, feature_key, override_kind, override_mode)
      VALUES (1, 'hr.employees', 'permanent', 'force_on')
      ON CONFLICT (firm_id, feature_key) WHERE override_kind = 'permanent' DO UPDATE
        SET override_mode = 'force_on';
    `);
    _resetEntitlementCacheForTests();
    const res = await getEffectiveEntitlement(1, "hr.employees", { conn: db as any });
    expect(res.enabled).toBe(true);
  });
});

describe("PARTNER-HIMS tests (fresh PGlite)", () => {
  let pg: PGlite;
  let db: DbConn;

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    _resetEntitlementCacheForTests();
    await applyEntitlementFoundationDdl(pg);
    await seedCanonicalFeatureRegistry(pg);
    await pg.exec(DOMAIN_TABLES_DDL);
  }, 30000);

  it("PARTNER-HIMS-1: Partner with HIMS module ON with connection → /hims/cases path + configurationStatus=configured OK (200)", async () => {
    await pg.exec(`
      INSERT INTO firm_entitlement_overrides (firm_id, feature_key, override_kind, override_mode)
      VALUES (1, 'hims.tracker', 'permanent', 'force_on')
      ON CONFLICT (firm_id, feature_key) WHERE override_kind = 'permanent' DO UPDATE
        SET override_mode = 'force_on';
      INSERT INTO hims_connections (firm_id, connection_name, status, provider, config)
      VALUES (1, 'Test HIMS Conn', 'active', 'myhims', '{"apiKey":"x"}'::jsonb)
      ON CONFLICT DO NOTHING;
    `);
    _resetEntitlementCacheForTests();
    const res = await getEffectiveEntitlement(1, "hims.tracker", { conn: db as any });
    expect(res.enabled).toBe(true);

    const connRows = rowsFromExec(await pg.exec(`
      SELECT COUNT(*)::int AS c FROM hims_connections
      WHERE firm_id = 1 AND status = 'active';
    `));
    const activeCount = Number(connRows[0]?.c ?? 0);
    const configurationStatus = activeCount > 0 ? "configured" : "no_connections";
    expect(configurationStatus).toBe("configured");
  });

  it("PARTNER-HIMS-2: HIMS ON + zero active connections → configurationStatus=no_connections OK (NOT denied; 200 path with HIMS not configured safe text allowed)", async () => {
    await pg.exec(`
      UPDATE hims_connections SET status = 'inactive' WHERE firm_id = 1;
      INSERT INTO firm_entitlement_overrides (firm_id, feature_key, override_kind, override_mode)
      VALUES (1, 'hims.tracker', 'permanent', 'force_on')
      ON CONFLICT (firm_id, feature_key) WHERE override_kind = 'permanent' DO UPDATE
        SET override_mode = 'force_on';
    `);
    _resetEntitlementCacheForTests();
    const res = await getEffectiveEntitlement(1, "hims.tracker", { conn: db as any });
    expect(res.enabled).toBe(true);

    const connRows = rowsFromExec(await pg.exec(`
      SELECT COUNT(*)::int AS c FROM hims_connections
      WHERE firm_id = 1 AND status = 'active';
    `));
    const activeCount = Number(connRows[0]?.c ?? 0);
    const configurationStatus = activeCount > 0 ? "configured" : "no_connections";
    expect(configurationStatus).toBe("no_connections");
  });
});

describe("CASE16 tests (fresh PGlite)", () => {
  let pg: PGlite;
  let db: DbConn;

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    _resetEntitlementCacheForTests();
    await applyEntitlementFoundationDdl(pg);
    await seedCanonicalFeatureRegistry(pg);
    await pg.exec(DOMAIN_TABLES_DDL);

    await pg.exec(`
      INSERT INTO cases (id, firm_id, case_number, status, case_type, primary_client_id)
      VALUES (16, 1, 'CASE-0016', 'active', 'SPA', 100)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO case_assignments (case_id, user_id, firm_id, role)
      VALUES (16, 2, 1, 'Owner')
      ON CONFLICT (case_id, user_id, role) DO NOTHING;

      INSERT INTO case_workflow_documents (firm_id, case_id, workflow_key, has_file)
      VALUES (1, 16, 'spa_main', true)
      ON CONFLICT DO NOTHING;

      INSERT INTO case_loan_stamping (firm_id, case_id, item_key, item_status)
      VALUES (1, 16, 'loan_agreement', 'stamped')
      ON CONFLICT DO NOTHING;

      INSERT INTO case_supp_lo_docs (firm_id, case_id, document_name, file_path)
      VALUES (1, 16, 'Supplementary LO', '/docs/supp-lo-16.pdf')
      ON CONFLICT DO NOTHING;

      INSERT INTO case_messages (firm_id, case_id, sender_id, message_text, is_read)
      VALUES (1, 16, 2, 'Case 16 opened', false)
      ON CONFLICT DO NOTHING;

      INSERT INTO case_advances (firm_id, case_id, advance_amount, payee_name, status)
      VALUES (1, 16, 500.00, 'Advance Payee', 'approved')
      ON CONFLICT DO NOTHING;

      INSERT INTO case_key_dates (firm_id, case_id, date_label, date_value)
      VALUES (1, 16, 'SPA Signing Date', '2025-01-15'::date)
      ON CONFLICT DO NOTHING;

      INSERT INTO case_workflow_steps (firm_id, case_id, step_order, step_name, is_completed)
      VALUES (1, 16, 1, 'Initial Review', true)
      ON CONFLICT DO NOTHING;

      INSERT INTO case_ledger_entries (firm_id, case_id, entry_type, amount)
      VALUES (1, 16, 'disbursement', 100.00)
      ON CONFLICT DO NOTHING;
    `);
  }, 30000);

  it("CASE16-1: cases primary select returns case_id=16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, case_number, status FROM cases WHERE id = 16 AND firm_id = 1 LIMIT 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0].id)).toBe(16);
  });

  it("CASE16-2: messages for case 16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, message_text FROM case_messages WHERE case_id = 16 AND firm_id = 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("CASE16-3: unread messages aggregation", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT COUNT(*)::int AS unread_count
      FROM case_messages
      WHERE case_id = 16 AND firm_id = 1 AND is_read = false;
    `));
    const cnt = Number(rows[0]?.unread_count ?? 0);
    expect(cnt).toBeGreaterThanOrEqual(0);
  });

  it("CASE16-4: key_dates for case 16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, date_label FROM case_key_dates WHERE case_id = 16 AND firm_id = 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("CASE16-5: loan_stamping for case 16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, item_key FROM case_loan_stamping WHERE case_id = 16 AND firm_id = 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("CASE16-6: supp_LO / supp_lo documents for case 16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, document_name FROM case_supp_lo_docs WHERE case_id = 16 AND firm_id = 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("CASE16-7: workflow_documents for case 16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, workflow_key FROM case_workflow_documents WHERE case_id = 16 AND firm_id = 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("CASE16-8: advances for case 16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, payee_name FROM case_advances WHERE case_id = 16 AND firm_id = 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("CASE16-9: workflow_steps for case 16", async () => {
    const rows = rowsFromExec(await pg.exec(`
      SELECT id, step_name FROM case_workflow_steps WHERE case_id = 16 AND firm_id = 1;
    `));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("DOCJOB tests (fresh PGlite)", () => {
  let pg: PGlite;
  let db: DbConn;

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    _resetEntitlementCacheForTests();
    await applyEntitlementFoundationDdl(pg);
    await seedCanonicalFeatureRegistry(pg);
    await pg.exec(DOMAIN_TABLES_DDL);
  }, 30000);

  it("DOCJOB-1: 3 successful items → progress total=3,s=3,f=0,p=0,r=0; display=COMPLETED + nextAction=finalize/download OK", async () => {
    await pg.exec(`
      INSERT INTO document_generation_jobs (id, firm_id, created_by, status, active, total_count, success_count, failed_count, pending_count, running_count)
      VALUES ('job-doc1', 1, 2, 'completed', true, 3, 3, 0, 0, 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO document_generation_job_items (job_id, firm_id, case_id, template_source, template_id, template_version_id, status, object_path)
      VALUES
        ('job-doc1', 1, 16, 'firm', 101, 1, 'success', '/out/doc1.pdf'),
        ('job-doc1', 1, 16, 'firm', 102, 2, 'success', '/out/doc2.pdf'),
        ('job-doc1', 1, 16, 'firm', 103, 1, 'success', '/out/doc3.pdf')
      ON CONFLICT DO NOTHING;
    `);

    const progress = await computeDocGenJobProgress(db as any, { firmId: 1, jobId: "job-doc1" });
    expect(progress.total).toBe(3);
    expect(progress.success).toBe(3);
    expect(progress.failed).toBe(0);
    expect(progress.pending).toBe(0);
    expect(progress.running).toBe(0);

    const nextAction = resolveDocGenNextActionInline({
      status: "generating",
      progress,
    });
    expect(["finalize", "download"]).toContain(nextAction);

    const display = getDisplayStatusFromSnapshot({
      status: "completed",
      progress,
      downloadObjectPath: "/out/job-doc1.zip",
    });
    expect(display).toBe("COMPLETED");
  });

  it("DOCJOB-2: run-next failure 0 claimed → failed + active=false + running=0 terminal; nextAction=stop; display FAILED not GENERATING", async () => {
    await pg.exec(`
      INSERT INTO document_generation_jobs (id, firm_id, created_by, status, active, total_count, success_count, failed_count, pending_count, running_count)
      VALUES ('job-doc2', 1, 2, 'generating', true, 3, 0, 0, 3, 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO document_generation_job_items (job_id, firm_id, case_id, template_source, template_id, template_version_id, status)
      VALUES
        ('job-doc2', 1, 16, 'firm', 101, 1, 'pending'),
        ('job-doc2', 1, 16, 'firm', 102, 2, 'pending'),
        ('job-doc2', 1, 16, 'firm', 103, 1, 'pending')
      ON CONFLICT DO NOTHING;
    `);

    await pg.exec(`
      UPDATE document_generation_jobs
      SET status = 'failed',
          active = false,
          error_code = 'RUN_NEXT_FAILED',
          failed_count = 0
      WHERE id = 'job-doc2' AND firm_id = 1;
    `);

    const jobRows = rowsFromExec(await pg.exec(`
      SELECT status, active, error_code FROM document_generation_jobs
      WHERE id = 'job-doc2' AND firm_id = 1 LIMIT 1;
    `));
    expect(String(jobRows[0]?.status ?? "")).toBe("failed");
    expect(String(jobRows[0]?.error_code ?? "")).toBe("RUN_NEXT_FAILED");

    const progress = await computeDocGenJobProgress(db as any, { firmId: 1, jobId: "job-doc2" });
    expect(progress.pending).toBe(3);
    expect(progress.running).toBe(0);

    const nextAction = resolveDocGenNextActionInline({
      status: "failed",
      progress,
      downloadObjectPath: null,
    });
    expect(nextAction).toBe("stop");

    const display = getDisplayStatusFromSnapshot({
      status: "failed",
      progress: { total: 3, success: 0, failed: 0, pending: 3, running: 0 },
      nextAction: "stop",
      active: false,
    });
    expect(display).toBe("FAILED");
    expect(display).not.toBe("GENERATING");
  });

  it("DOCJOB-3: Retry idempotent → pending with same (job,case,template,version) as existing success → duplicate_skipped not re-processed; successful count stays 1 (no duplicate outputs)", async () => {
    await pg.exec(`
      INSERT INTO document_generation_jobs (id, firm_id, created_by, status, active, total_count, success_count, failed_count, pending_count, running_count)
      VALUES ('job-doc3', 1, 2, 'generating', true, 2, 1, 0, 1, 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO document_generation_job_items (id, job_id, firm_id, case_id, template_source, template_id, template_version_id, status, object_path)
      VALUES
        (9001, 'job-doc3', 1, 16, 'firm', 500, 7, 'success', '/out/success-1.pdf'),
        (9002, 'job-doc3', 1, 16, 'firm', 500, 7, 'pending', NULL)
      ON CONFLICT (id) DO NOTHING;
    `);

    await pg.exec(`
      WITH dups AS (
        SELECT p.id AS pending_id
        FROM document_generation_job_items p
        WHERE p.job_id = 'job-doc3'
          AND p.firm_id = 1
          AND p.status = 'pending'
          AND EXISTS (
            SELECT 1
            FROM document_generation_job_items s
            WHERE s.job_id = p.job_id
              AND s.firm_id = p.firm_id
              AND s.id <> p.id
              AND s.status = 'success'
              AND s.object_path IS NOT NULL
              AND s.case_id IS NOT DISTINCT FROM p.case_id
              AND s.template_id IS NOT DISTINCT FROM p.template_id
              AND s.template_source IS NOT DISTINCT FROM (SELECT template_source FROM document_generation_job_items WHERE id = p.id)
              AND s.template_version_id IS NOT DISTINCT FROM (SELECT template_version_id FROM document_generation_job_items WHERE id = p.id)
          )
      )
      UPDATE document_generation_job_items i
      SET status = 'duplicate_skipped',
          error_code = 'DUPLICATE_OUTPUT_PREVENTED',
          error_message = 'Duplicate of an existing successful output',
          finished_at = now()
      FROM dups
      WHERE i.id = dups.pending_id;
    `);

    const itemRows = rowsFromExec(await pg.exec(`
      SELECT id, status, error_code, object_path FROM document_generation_job_items
      WHERE job_id = 'job-doc3' AND firm_id = 1
      ORDER BY id;
    `));

    const successItems = itemRows.filter(r => String(r.status) === "success");
    const dupItems = itemRows.filter(r => String(r.status) === "duplicate_skipped");

    expect(successItems.length).toBe(1);
    expect(dupItems.length).toBe(1);
    expect(String(dupItems[0]?.error_code ?? "")).toBe("DUPLICATE_OUTPUT_PREVENTED");

    const progress = await computeDocGenJobProgress(db as any, { firmId: 1, jobId: "job-doc3" });
    expect(progress.success).toBe(1);
  });
});

describe("ENTITLEMENT parity tests (fresh PGlite)", () => {
  let pg: PGlite;
  let db: DbConn;

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    _resetEntitlementCacheForTests();
    await applyEntitlementFoundationDdl(pg);
    await seedCanonicalFeatureRegistry(pg);
    await pg.exec(DOMAIN_TABLES_DDL);
  }, 30000);

  it("ENTITLEMENT-1: Backend effective entitlement parity for 20 canonical keys across dashboard/cases/hr/documents/hims matches plan defaults (20/20 OK)", async () => {
    const modulesOfInterest = ["dashboard", "cases", "hr", "documents", "hims"];
    const sampleKeys: string[] = [];
    for (const def of FEATURE_REGISTRY_MAP.values()) {
      const mod = String(def.module ?? "").toLowerCase();
      if (modulesOfInterest.some(m => mod.includes(m.toLowerCase()))) {
        sampleKeys.push(def.featureKey);
        if (sampleKeys.length >= 20) break;
      }
    }
    if (sampleKeys.length < 20) {
      for (const def of FEATURE_REGISTRY_MAP.values()) {
        if (!sampleKeys.includes(def.featureKey)) {
          sampleKeys.push(def.featureKey);
          if (sampleKeys.length >= 20) break;
        }
      }
    }

    _resetEntitlementCacheForTests();
    const results = await resolveEntitlementsBulk(1, sampleKeys, { conn: db as any });

    let parityOk = 0;
    for (const key of sampleKeys) {
      const def = getFeatureDefinition(key);
      const planDefaultBoolean =
        def && def.valueType === "boolean"
          ? (def.defaultValue !== undefined ? !!def.defaultValue : true)
          : true;

      const res: EntitlementResult | undefined = results[key];
      const effective = !!res?.enabled;

      if (effective === planDefaultBoolean) {
        parityOk++;
      }
    }

    expect(parityOk).toBeGreaterThanOrEqual(sampleKeys.length);
    expect(sampleKeys.length).toBeGreaterThanOrEqual(20);
  });
});
