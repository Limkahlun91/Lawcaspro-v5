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
      "select to_regclass('public.document_template_versions') as dtv, to_regclass('public.templates') as templates, to_regclass('public.platform_founder_roles') as pfr, to_regclass('public.support_sessions') as ss",
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

