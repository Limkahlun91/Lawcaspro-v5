import { spawn, fork } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const API_SERVER_DIR = resolve(REPO_ROOT, "artifacts", "api-server");
const OUT_FILE = resolve(REPO_ROOT, "docs", "generated-accounting-perf-local.json");
const PROFILE_MD = resolve(REPO_ROOT, "docs", "accounting-performance-profile.md");

const ENDPOINTS = [
  { name: "auth/me", method: "GET", path: "/api/auth/me", requireAuth: true, base: "user" },
  { name: "accounting_summary", method: "GET", path: "/api/accounting/summary", requireAuth: true, base: "firm" },
  { name: "invoices_list", method: "GET", path: "/api/invoices?limit=50", requireAuth: true, base: "firm" },
  { name: "receipts_list", method: "GET", path: "/api/receipts?limit=50", requireAuth: true, base: "firm" },
  { name: "pv_dashboard", method: "GET", path: "/api/payment-voucher-actions/my-work/overview", requireAuth: true, base: "firm" },
  { name: "pv_list", method: "GET", path: "/api/payment-vouchers?limit=50", requireAuth: true, base: "firm" },
  { name: "reference_search", method: "GET", path: "/api/cases/ref-search?projectId=1&limit=10", requireAuth: true, base: "firm" },
  { name: "my_work", method: "GET", path: "/api/payment-voucher-actions/my-work?status=pending_approval&limit=50", requireAuth: true, base: "firm" },
  { name: "ledger_list", method: "GET", path: "/api/ledger?limit=200", requireAuth: true, base: "firm" },
  { name: "quotations_list", method: "GET", path: "/api/quotations?limit=200", requireAuth: true, base: "firm" },
];

async function serverReachable(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return true;
  } catch {
    return false;
  }
}

function headerBar() {
  const line = "=".repeat(90);
  console.log(line);
  console.log("ACCOUNTING PERFORMANCE BENCHMARK — AUTOMATED LOCAL ONLY (PART 3 §12)");
  console.log("Disclaimer: numbers are local-dev-only measured. NOT Preview P95. NOT Production.");
  console.log(`Output JSON: ${OUT_FILE}`);
  console.log(line);
}

async function run() {
  headerBar();
  const baseUrl = process.env.LAWCASPRO_LOCAL_API || "http://127.0.0.1:3001";
  const mode = process.env.PERF_MODE || "check";
  const measurements = [];
  const rows = [];

  if (mode === "collect") {
    if (!(await serverReachable(baseUrl))) {
      console.log(`[WARN] Local API server not reachable at ${baseUrl}. Start 'pnpm --filter @workspace/api-server dev' then re-run with PERF_MODE=collect.`);
      console.log(`All endpoint rows below are marked STATUS='PENDING (server not running)'.`);
      for (const ep of ENDPOINTS) {
        measurements.push({ endpoint: ep.name, method: ep.method, path: ep.path, cold_ms: null, warm_avg_ms: null, n_warm: 0, status: "PENDING_SERVER_NOT_RUNNING" });
      }
    } else {
      const authHeader = process.env.PERF_AUTH_HEADER || null;
      const hdrs = authHeader ? { "authorization": authHeader } : {};
      console.log(`[OK] Server reachable at ${baseUrl}. AUTH_HEADER=${authHeader ? "PRESENT" : "MISSING (expect 401s)"}`);
      for (const ep of ENDPOINTS) {
        const url = `${baseUrl}${ep.path}`;
        let cold_ms = null;
        const warm_ms = [];
        let status = "OK";
        try {
          const t0 = Date.now();
          const r1 = await fetch(url, { method: ep.method, headers: hdrs });
          cold_ms = Date.now() - t0;
          if (r1.status >= 400 && !authHeader) status = "401_EXPECTED_NO_AUTH";
          for (let i = 0; i < 3; i++) {
            await sleep(50);
            const t = Date.now();
            await fetch(url, { method: ep.method, headers: hdrs });
            warm_ms.push(Date.now() - t);
          }
        } catch (err) {
          status = `FETCH_ERR:${err.code}`;
        }
        const warm_avg = warm_ms.length ? Math.round(warm_ms.reduce((a,b)=>a+b, 0) / warm_ms.length) : null;
        measurements.push({
          endpoint: ep.name, method: ep.method, path: ep.path,
          cold_ms, warm_avg_ms: warm_avg, n_warm: warm_ms.length,
          status,
        });
      }
    }
  } else {
    console.log(`[INFO] PERF_MODE='${mode}'. Use PERF_MODE=collect to hit local server. Recording skeleton row only.`);
    for (const ep of ENDPOINTS) {
      measurements.push({ endpoint: ep.name, method: ep.method, path: ep.path, cold_ms: null, warm_avg_ms: null, n_warm: 0, status: "NOT_RUN (use PERF_MODE=collect)" });
    }
  }

  writeFileSync(OUT_FILE, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode, baseUrl: process.env.LAWCASPRO_LOCAL_API || "http://127.0.0.1:3001",
    environment: "LOCAL_DEVELOPMENT_ONLY",
    disclaimer: "These measurements are LOCAL ONLY. DO NOT REPORT AS 'PREVIEW P95' or any Preview number.",
    endpoints: measurements,
  }, null, 2), "utf8");
  console.log(`\n[OK] Wrote ${measurements.length} endpoint rows to ${OUT_FILE}.`);

  for (const m of measurements) {
    rows.push(`| \`${m.endpoint}\` | ${m.method} | LOCAL-ONLY | ${m.cold_ms ?? "—"} | ${m.warm_avg_ms ?? "—"} | ${m.status} | PERF_MODE=collect required for values; server reachable today=${mode === "collect"} |`);
  }

  appendIfMissing(rows);
  console.log(`\n[DONE] ${measurements.length} endpoints benchmark record updated. LOCAL MEASURED ONLY. NO Preview P95 reported.`);
}

function appendIfMissing(rows) {
  let md = readFileSync(PROFILE_MD, "utf8");
  const section = "## Automated Local Baseline (PART 3 §12)";
  if (md.includes(section)) return;
  const appendix = `

---

${section}

> **Measurement truth source** (§12): \`scripts/benchmark-accounting-performance.mjs\` with \`PERF_MODE=collect\`.
>
> §12 Strict Assertion — Never write "Preview P95" unless measured on a deployed preview host:
> - ✅ "automated/local measured" = YES below (even if values are — pending)
> - ❌ "Preview P95 = 123ms" is FORBIDDEN unless actual Preview deploy was measured during Stabilisation

| Endpoint Name (click name) | Method | Environment Scope | Cold (ms, local) | Warm ×3 Avg (ms, local) | Status | Notes |
|---|---|---|---|---|---|---|
${rows.join("\n")}

### How to run local measurement
\`\`\`bash
# 1. start local API server (separate terminal)
pnpm --filter @workspace/api-server dev
# 2. set auth header if you have one (optional — without it you get 401_EXPECTED_NO_AUTH which is fine for status rows)
export PERF_AUTH_HEADER="Bearer <your-token>"
# 3. run collector
cd scripts && PERF_MODE=collect node ./benchmark-accounting-performance.mjs
\`\`\`
`;
  md = md.trimEnd() + "\n" + appendix;
  writeFileSync(PROFILE_MD, md, "utf8");
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
