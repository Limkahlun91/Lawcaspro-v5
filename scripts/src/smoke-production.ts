export {};

const BASE_URL = process.env.SMOKE_BASE_URL || "https://lawcaspro-v5.vercel.app";
const AUTH_COOKIE = process.env.SMOKE_AUTH_COOKIE || "";

type SmokeTarget = {
  name: string;
  path: string;
  method?: "GET" | "POST";
  kind: "api" | "page";
  allowStatuses: number[];
};

type ResultRow = {
  name: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  note: string;
};

function headerValue(h: Headers, name: string): string {
  return h.get(name) || "";
}

async function fetchTarget(target: SmokeTarget): Promise<ResultRow> {
  const method = target.method ?? "GET";
  const url = `${BASE_URL}${target.path}`;
  const headers: Record<string, string> = {};
  if (AUTH_COOKIE) headers.cookie = AUTH_COOKIE;

  const res = await fetch(url, {
    method,
    headers,
    redirect: "manual",
  });

  const status = res.status;
  const ok = target.allowStatuses.includes(status) && status < 500;

  const contentType = headerValue(res.headers, "content-type").toLowerCase();
  const note = (() => {
    if (status >= 500) return "server_error";
    if (target.kind === "page") {
      if (contentType.includes("text/html")) return "html";
      return contentType || "non_html";
    }
    if (contentType.includes("application/json")) return "json";
    return contentType || "non_json";
  })();

  return { name: target.name, method, path: target.path, status, ok, note };
}

function printTable(rows: ResultRow[]): void {
  const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const c1 = Math.max(6, ...rows.map((r) => r.status.toString().length));
  const c2 = Math.max(4, ...rows.map((r) => r.method.length));
  const c3 = Math.max(14, ...rows.map((r) => r.name.length));
  console.log(`${pad("status", c1)}  ${pad("verb", c2)}  ${pad("name", c3)}  path`);
  for (const r of rows) {
    console.log(`${pad(String(r.status), c1)}  ${pad(r.method, c2)}  ${pad(r.name, c3)}  ${r.path}  (${r.note})`);
  }
}

async function main(): Promise<void> {
  console.log(`Smoke base: ${BASE_URL}`);
  console.log(`Auth cookie: ${AUTH_COOKIE ? "present" : "missing"}`);

  const targets: SmokeTarget[] = [
    { kind: "api", name: "auth/me", path: "/api/auth/me", allowStatuses: [200, 401] },
    { kind: "api", name: "ops/actions", path: "/api/platform/firms/1/maintenance/actions?limit=1", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "ops/history", path: "/api/platform/firms/1/history?limit=50", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "ops/mhist", path: "/api/platform/firms/1/maintenance/history?limit=50", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "ops/summary", path: "/api/platform/firms/1/ops/summary", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "ops/snaps", path: "/api/platform/firms/1/snapshots?limit=1", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "docvars(platform)", path: "/api/platform/document-variables?active=1", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "docvars(firm)", path: "/api/document-variables?active=1", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "support-sessions", path: "/api/support-sessions?firmId=1", allowStatuses: [200, 401, 403] },
    { kind: "api", name: "storage/upload", path: "/api/storage/upload", method: "POST", allowStatuses: [200, 400, 401, 403, 503] },
    { kind: "page", name: "login", path: "/auth/login", allowStatuses: [200] },
    { kind: "page", name: "platform/ops", path: "/platform/operations", allowStatuses: [200, 302, 307] },
    { kind: "page", name: "platform/firm", path: "/platform/firms/1", allowStatuses: [200, 302, 307] },
    { kind: "page", name: "platform/docs", path: "/platform/documents", allowStatuses: [200, 302, 307] },
    { kind: "page", name: "platform/msg", path: "/platform/messages", allowStatuses: [200, 302, 307] },
    { kind: "page", name: "app/dashboard", path: "/app/dashboard", allowStatuses: [200, 302, 307] },
    { kind: "page", name: "app/users", path: "/app/users", allowStatuses: [200, 302, 307] },
    { kind: "page", name: "app/clients", path: "/app/clients", allowStatuses: [200, 302, 307] },
  ];

  const rows: ResultRow[] = [];
  for (const t of targets) rows.push(await fetchTarget(t));
  printTable(rows);

  const hardFails = rows.filter((r) => r.status >= 500);
  const softFails = rows.filter((r) => !r.ok);

  if (hardFails.length) {
    console.error(`\nFAIL: ${hardFails.length} target(s) returned 5xx`);
    process.exit(1);
  }

  if (softFails.length) {
    console.error(`\nWARN: ${softFails.length} target(s) returned unexpected status (non-5xx)`);
    process.exit(2);
  }

  console.log("\nOK: smoke passed (no 5xx, all statuses allowed)");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FAIL: smoke script crashed: ${msg}`);
  process.exit(1);
});
