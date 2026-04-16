import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const args = new Set(process.argv.slice(2));
const skipDb = args.has("--skip-db");
const codeOnly = args.has("--code-only");
const dbOnly = args.has("--db-only");

function walkFiles(root) {
  const out = [];
  const stack = [root];
  const ignored = new Set(["node_modules", ".git", "dist", ".turbo", ".next", "coverage"]);
  while (stack.length) {
    const p = stack.pop();
    if (!p) continue;
    const base = path.basename(p);
    if (ignored.has(base)) continue;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(p);
      for (const e of entries) stack.push(path.join(p, e));
      continue;
    }
    out.push(p);
  }
  return out;
}

function scanTextFile(filePath, patterns) {
  const ext = path.extname(filePath).toLowerCase();
  const allow = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".env", ".md", ".sql", ".yml", ".yaml"]);
  if (!allow.has(ext) && !filePath.endsWith(".env.example")) return [];
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const p of patterns) {
      if (!p.re.test(line)) continue;
      hits.push({ filePath, line: i + 1, label: p.label, excerpt: line.slice(0, 240) });
    }
  }
  return hits;
}

function codeScan() {
  const patterns = [
    { label: "service-role env", re: /\bSUPABASE_SERVICE_ROLE_KEY\b/ },
    { label: "db url env", re: /\bDATABASE_URL\b/ },
    { label: "supabase createClient", re: /\bcreateClient\s*\(/ },
    { label: "public env", re: /\bNEXT_PUBLIC_[A-Z0-9_]+\b/ },
  ];

  const frontendRoots = [
    path.join(repoRoot, "artifacts", "lawcaspro", "src"),
    path.join(repoRoot, "artifacts", "lawcaspro-mobile"),
  ];

  const forbiddenInFrontend = [
    { label: "service-role env", re: /\bSUPABASE_SERVICE_ROLE_KEY\b/ },
    { label: "service_role role string", re: /\bservice_role\b/i },
    { label: "db url env", re: /\bDATABASE_URL\b/ },
  ];

  const repoFiles = walkFiles(repoRoot);
  const repoHits = [];
  for (const f of repoFiles) repoHits.push(...scanTextFile(f, patterns));

  const frontendHits = [];
  for (const root of frontendRoots) {
    if (!fs.existsSync(root)) continue;
    const files = walkFiles(root);
    for (const f of files) frontendHits.push(...scanTextFile(f, forbiddenInFrontend));
  }

  return { repoHits, frontendHits };
}

function normalizeDbConfig(databaseUrl) {
  const u = String(databaseUrl || "").trim();
  const isPooler = u.toLowerCase().includes("pooler.supabase.com");
  if (!isPooler) return { connectionString: u };
  return { connectionString: u, ssl: { rejectUnauthorized: false } };
}

async function dbScan() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { skipped: true, reason: "DATABASE_URL not set" };
  }
  const { default: pg } = await import("pg");
  const cfg = normalizeDbConfig(databaseUrl);
  const client = new pg.Client(cfg);
  await client.connect();
  try {
    const tablesRes = await client.query(
      `
      select
        n.nspname as schema,
        c.relname as table,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname in ('public','storage')
        and c.relname not like '\\_%'
      order by n.nspname, c.relname
      `
    );

    const policiesRes = await client.query(
      `
      select
        schemaname,
        tablename,
        policyname,
        roles,
        cmd,
        permissive,
        qual,
        with_check
      from pg_policies
      where schemaname in ('public','storage')
      order by schemaname, tablename, policyname
      `
    );

    const grantsRes = await client.query(
      `
      select table_schema, table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema in ('public','storage')
        and grantee in ('anon','authenticated','public')
      order by table_schema, table_name, grantee, privilege_type
      `
    );

    const secdefRes = await client.query(
      `
      select
        n.nspname as schema,
        p.proname as name,
        pg_get_function_identity_arguments(p.oid) as args,
        p.prosecdef as security_definer,
        p.proconfig as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef is true
        and n.nspname not in ('pg_catalog','information_schema')
      order by n.nspname, p.proname
      `
    );

    const routineGrantsRes = await client.query(
      `
      select routine_schema, routine_name, grantee, privilege_type
      from information_schema.role_routine_grants
      where routine_schema not in ('pg_catalog','information_schema')
        and grantee in ('anon','authenticated','public')
      order by routine_schema, routine_name, grantee
      `
    );

    const tables = tablesRes.rows;
    const policies = policiesRes.rows;
    const grants = grantsRes.rows;
    const secdef = secdefRes.rows;
    const routineGrants = routineGrantsRes.rows;

    const rlsMissing = tables.filter((t) => t.schema === "public" && t.rls_enabled !== true);
    const openSelectPolicies = policies.filter((p) => {
      const cmd = String(p.cmd || "").toLowerCase();
      if (cmd !== "select" && cmd !== "all") return false;
      const roles = Array.isArray(p.roles) ? p.roles.map((x) => String(x)) : [];
      const targets = new Set(["public", "anon", "authenticated"]);
      const hasWideRole = roles.some((r) => targets.has(r));
      if (!hasWideRole) return false;
      const qual = String(p.qual || "");
      const lowered = qual.toLowerCase().replace(/\s+/g, " ").trim();
      if (lowered === "true" || lowered === "(true)" || lowered === "((true))") return true;
      if (lowered.includes("using (true)")) return true;
      return false;
    });

    const secdefMissingSearchPath = secdef.filter((f) => {
      const cfgArr = Array.isArray(f.config) ? f.config.map((x) => String(x)) : [];
      return !cfgArr.some((x) => x.toLowerCase().startsWith("search_path="));
    });

    return {
      skipped: false,
      tables,
      policies,
      grants,
      secdef,
      routineGrants,
      findings: {
        rlsMissing,
        openSelectPolicies,
        secdefMissingSearchPath,
      },
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const output = { code: null, db: null };

  if (!dbOnly) {
    const { repoHits, frontendHits } = codeScan();
    output.code = {
      repoHitsCount: repoHits.length,
      frontendViolationsCount: frontendHits.length,
      frontendViolations: frontendHits.slice(0, 50),
    };
  }

  if (!codeOnly && !skipDb) {
    output.db = await dbScan();
  } else if (!codeOnly) {
    output.db = { skipped: true, reason: "--skip-db" };
  }

  const critical = [];
  if (output.code?.frontendViolationsCount) {
    critical.push(`frontend_sensitive_env=${output.code.frontendViolationsCount}`);
  }
  if (output.db && output.db.skipped === false) {
    if (output.db.findings.rlsMissing.length) critical.push(`rls_missing=${output.db.findings.rlsMissing.length}`);
    if (output.db.findings.openSelectPolicies.length) critical.push(`open_select_policies=${output.db.findings.openSelectPolicies.length}`);
    if (output.db.findings.secdefMissingSearchPath.length) critical.push(`secdef_missing_search_path=${output.db.findings.secdefMissingSearchPath.length}`);
  }

  process.stdout.write(JSON.stringify({ ok: critical.length === 0, critical, ...output }, null, 2) + "\n");
  process.exit(critical.length === 0 ? 0 : 2);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err?.message || err) + "\n");
  process.exit(1);
});
