const { Client } = require("pg");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const ssl = /pooler\.supabase\.com|supabase\.(co|com)/i.test(databaseUrl)
  ? { rejectUnauthorized: false }
  : undefined;

(async () => {
  const c = new Client({ connectionString: databaseUrl, ssl });
  await c.connect();
  try {
    const r = await c.query(
      "select to_regclass('public.document_template_versions') as dtv, to_regclass('public.templates') as templates, to_regclass('public.platform_founder_roles') as pfr, to_regclass('public.support_sessions') as ss, to_regclass('public.cases') as cases, to_regclass('public.case_progress') as case_progress, to_regclass('public.case_key_dates') as case_key_dates, to_regclass('public.case_workflow_steps') as case_workflow_steps, to_regclass('public.case_workflow_documents') as case_workflow_documents, to_regclass('public.loan_stamping') as loan_stamping, to_regclass('public.case_loan_stamping_items') as case_loan_stamping_items, to_regclass('public.case_assignments') as case_assignments, to_regclass('public.case_purchasers') as case_purchasers",
    );
    const b = await c.query(
      "select count(*)::int as c from storage.buckets where id = $1",
      ["lawcaspro-private"],
    );
    process.stdout.write(
      JSON.stringify({
        document_template_versions: Boolean(r.rows[0]?.dtv),
        templates: Boolean(r.rows[0]?.templates),
        platform_founder_roles: Boolean(r.rows[0]?.pfr),
        support_sessions: Boolean(r.rows[0]?.ss),
        cases: Boolean(r.rows[0]?.cases),
        case_progress: Boolean(r.rows[0]?.case_progress),
        case_key_dates: Boolean(r.rows[0]?.case_key_dates),
        case_workflow_steps: Boolean(r.rows[0]?.case_workflow_steps),
        case_workflow_documents: Boolean(r.rows[0]?.case_workflow_documents),
        loan_stamping: Boolean(r.rows[0]?.loan_stamping),
        case_loan_stamping_items: Boolean(r.rows[0]?.case_loan_stamping_items),
        case_assignments: Boolean(r.rows[0]?.case_assignments),
        case_purchasers: Boolean(r.rows[0]?.case_purchasers),
        private_bucket_count: b.rows[0]?.c ?? null,
      }),
    );
  } finally {
    await c.end();
  }
})().catch((e) => {
  const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  process.stderr.write(msg);
  process.exit(1);
});
