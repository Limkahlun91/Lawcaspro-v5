const baseUrl = process.env.SMOKE_BASE_URL;
const email = process.env.SMOKE_FOUNDER_EMAIL;
const password = process.env.SMOKE_FOUNDER_PASSWORD;

if (!baseUrl) {
  console.error("Missing env: SMOKE_BASE_URL");
  process.exit(2);
}
if (!email) {
  console.error("Missing env: SMOKE_FOUNDER_EMAIL");
  process.exit(2);
}
if (!password) {
  console.error("Missing env: SMOKE_FOUNDER_PASSWORD");
  process.exit(2);
}

const redactTokenFields = (text) =>
  String(text)
    .replaceAll(/"token"\s*:\s*"[^"]+"/g, '"token":"[REDACTED]"')
    .replaceAll(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");

const cut = (text, max = 300) => {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
};

const urlJoin = (base, path) => {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
};

const parseSetCookieHeader = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
};

const cookieJarFromSetCookie = (setCookieHeaders) => {
  const parts = [];
  for (const raw of setCookieHeaders) {
    const first = String(raw).split(";")[0];
    if (first && first.includes("=")) parts.push(first.trim());
  }
  return parts.join("; ");
};

const fetchJson = async (path, { method = "GET", headers = {}, body, cookieJar } = {}) => {
  const res = await fetch(urlJoin(baseUrl, path), {
    method,
    headers: {
      accept: "application/json",
      ...(cookieJar ? { cookie: cookieJar } : {}),
      ...headers,
    },
    body,
    redirect: "manual",
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
};

const endpoints = [
  "/api/auth/me",
  "/api/platform/documents",
  "/api/support-sessions?firmId=1",
  "/api/platform/firms/1/actions?limit=1",
  "/api/platform/firms/1/snapshots?limit=1",
  "/api/platform/firms/1/ops/summary",
  "/api/platform/audit-logs?limit=20",
  "/api/audit-logs?limit=20",
];

const run = async () => {
  console.log(`SMOKE_BASE_URL=${baseUrl}`);

  const login = await fetch(urlJoin(baseUrl, "/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  const loginSetCookie = parseSetCookieHeader(login.headers.getSetCookie?.() ?? login.headers.get("set-cookie"));
  const cookieJar = cookieJarFromSetCookie(loginSetCookie);

  if (!cookieJar) {
    console.error("Login did not return Set-Cookie (auth_token).");
    process.exit(1);
  }

  console.log(`POST /api/auth/login -> ${login.status}`);
  if (login.status !== 200) {
    const t = await login.text();
    console.error("Login failed:", cut(redactTokenFields(t)));
    process.exit(1);
  }

  let failed = false;

  for (const p of endpoints) {
    const { res, text, json } = await fetchJson(p, { cookieJar });
    const status = res.status;

    const safeBody = cut(redactTokenFields(text));
    console.log(`${status} ${p}`);
    console.log(`  body: ${safeBody}`);

    if (status >= 500) failed = true;
    if (p === "/api/auth/me") {
      const ok = json && typeof json === "object" && json.ok === true;
      const hasUser = ok && json.data && typeof json.data === "object";
      if (!hasUser) failed = true;
      if (status !== 200) failed = true;
    } else {
      if (status !== 200) failed = true;
    }
  }

  if (failed) {
    console.error("SMOKE FAILED");
    process.exit(1);
  }

  console.log("SMOKE OK");
};

run().catch((err) => {
  console.error("SMOKE FAILED:", err?.message ?? String(err));
  process.exit(1);
});

