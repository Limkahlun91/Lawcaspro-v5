import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const oneArg = (name) => {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const v = args[idx + 1];
  return typeof v === "string" && v.length ? v : undefined;
};

const hasFlag = (name) => args.includes(name);

const base = oneArg("--base") ?? process.env.SMOKE_BASE_URL;
if (!base) {
  throw new Error("Missing base URL. Provide --base https://<domain> or set SMOKE_BASE_URL.");
}
const useSeedDefaults = hasFlag("--use-seed-defaults");

const seedFile = path.resolve(process.cwd(), "artifacts/api-server/src/lib/seed.ts");

const parseSeedDefaults = () => {
  const src = fs.readFileSync(seedFile, "utf8");
  const extract = (re) => {
    const m = src.match(re);
    return m?.[1] ?? null;
  };
  return {
    founderEmail: extract(/SEED_FOUNDER_EMAIL\s*\|\|\s*"([^"]+)"/),
    founderPassword: extract(/SEED_FOUNDER_PASSWORD\s*\|\|\s*"([^"]+)"/),
    partnerEmail: extract(/SEED_PARTNER_EMAIL\s*\|\|\s*"([^"]+)"/),
    partnerPassword: extract(/SEED_PARTNER_PASSWORD\s*\|\|\s*"([^"]+)"/),
    clerkEmail: extract(/SEED_CLERK_EMAIL\s*\|\|\s*"([^"]+)"/),
    clerkPassword: extract(/SEED_CLERK_PASSWORD\s*\|\|\s*"([^"]+)"/),
  };
};

const json = async (res) => {
  const txt = await res.text();
  try {
    return { ok: true, value: JSON.parse(txt), raw: txt };
  } catch {
    return { ok: false, value: null, raw: txt };
  }
};

const reqJson = async (method, url, body, headers = {}) => {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await json(res);
  return { status: res.status, headers: res.headers, body: data.value, raw: data.raw };
};

const getSetCookie = (headers) => {
  const sc = headers.get("set-cookie");
  return typeof sc === "string" && sc.length ? sc : null;
};

const pickCookieHeader = (setCookie) => {
  if (!setCookie) return null;
  const parts = setCookie.split(",");
  const auth = parts.find((p) => p.trim().startsWith("auth_token=")) ?? setCookie;
  const cookie = auth.split(";", 1)[0];
  return cookie ? `auth_token=${cookie.split("=", 2)[1]}` : null;
};

const now = () => new Date().toISOString();

const classify = (step, status, body, raw) => {
  const error = typeof body?.error === "string" ? body.error : typeof raw === "string" ? raw : "";
  const lowered = error.toLowerCase();
  if (step === "login" && status === 401) return "credential_failure";
  if (status === 403) return "permission_failure";
  if (status === 503 || lowered.includes("temporarily unavailable") || lowered.includes("timeout")) return "transient_db_or_network";
  if (status >= 500) return "application_bug";
  return "application_bug";
};

const run = async () => {
  const version = await reqJson("GET", `${base}/api/healthz/version`);
  const commit = typeof version.body?.commit === "string" ? version.body.commit : null;
  console.log(JSON.stringify({ at: now(), step: "version", base, status: version.status, body: version.body }, null, 2));
  if (version.status !== 200) {
    console.error(JSON.stringify({ at: now(), ok: false, classification: classify("version", version.status, version.body, version.raw) }, null, 2));
    process.exitCode = 20;
    return;
  }

  const candidates = [];
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (email && password) candidates.push({ email, password, label: "smoke" });
  if (!candidates.length && useSeedDefaults) {
    const d = parseSeedDefaults();
    if (d.partnerEmail && d.partnerPassword) candidates.push({ email: d.partnerEmail, password: d.partnerPassword, label: "seed.partner" });
    if (d.clerkEmail && d.clerkPassword) candidates.push({ email: d.clerkEmail, password: d.clerkPassword, label: "seed.clerk" });
    if (d.founderEmail && d.founderPassword) candidates.push({ email: d.founderEmail, password: d.founderPassword, label: "seed.founder" });
  }

  if (!candidates.length) {
    console.error(JSON.stringify({ at: now(), ok: false, error: "No credentials configured. Provide SMOKE_EMAIL/SMOKE_PASSWORD (preferred)." }));
    process.exitCode = 21;
    return;
  }

  let cookieHeader = null;
  let authedLabel = null;
  let lastLoginStatus = null;
  for (const c of candidates) {
    const login = await reqJson("POST", `${base}/api/auth/login`, { email: c.email, password: c.password });
    const setCookie = getSetCookie(login.headers);
    const cookie = pickCookieHeader(setCookie);
    lastLoginStatus = login.status;
    console.log(JSON.stringify({ at: now(), step: "login", base, commit, label: c.label, status: login.status, hasSetCookie: Boolean(setCookie), body: login.body ?? login.raw }, null, 2));
    if (login.status === 200 && cookie) {
      cookieHeader = cookie;
      authedLabel = c.label;
      break;
    }
  }

  if (!cookieHeader) {
    const classification = classify("login", lastLoginStatus ?? 0, null, "");
    console.error(JSON.stringify({ at: now(), ok: false, base, commit, classification, error: "Login did not succeed" }, null, 2));
    process.exitCode = classification === "credential_failure" ? 10 : 30;
    return;
  }

  const me = await reqJson("GET", `${base}/api/auth/me`, undefined, { cookie: cookieHeader });
  console.log(JSON.stringify({ at: now(), step: "me", base, commit, label: authedLabel, status: me.status, body: me.body ?? me.raw }, null, 2));
  if (me.status !== 200) {
    const classification = classify("me", me.status, me.body, me.raw);
    console.error(JSON.stringify({ at: now(), ok: false, base, commit, classification }, null, 2));
    process.exitCode = classification === "permission_failure" ? 11 : classification === "transient_db_or_network" ? 12 : 13;
    return;
  }

  const docs = await reqJson("GET", `${base}/api/hub/documents`, undefined, { cookie: cookieHeader });
  console.log(JSON.stringify({ at: now(), step: "hub.documents", base, commit, status: docs.status, count: Array.isArray(docs.body) ? docs.body.length : null, body: docs.body ?? docs.raw }, null, 2));
  if (docs.status !== 200) {
    const classification = classify("hub.documents", docs.status, docs.body, docs.raw);
    console.error(JSON.stringify({ at: now(), ok: false, base, commit, classification }, null, 2));
    process.exitCode = classification === "permission_failure" ? 11 : classification === "transient_db_or_network" ? 12 : 13;
    return;
  }

  const testEmail = `smoke+${crypto.randomBytes(6).toString("hex")}@example.com`;
  const create = await reqJson("POST", `${base}/api/users`, { email: testEmail, name: "Smoke User", password: "P@ssw0rd123!", roleId: (me.body?.roleId ?? 1) }, { cookie: cookieHeader });
  console.log(JSON.stringify({ at: now(), step: "users.create", base, commit, status: create.status, body: create.body ?? create.raw }, null, 2));
  if (create.status !== 201) {
    const classification = classify("users.create", create.status, create.body, create.raw);
    console.error(JSON.stringify({ at: now(), ok: false, base, commit, classification }, null, 2));
    process.exitCode = classification === "permission_failure" ? 11 : classification === "transient_db_or_network" ? 12 : 13;
    return;
  }

  const createdId = typeof create.body?.id === "number" ? create.body.id : null;
  if (createdId) {
    const del = await reqJson("DELETE", `${base}/api/users/${createdId}`, undefined, { cookie: cookieHeader });
    console.log(JSON.stringify({ at: now(), step: "users.cleanup", base, commit, status: del.status, body: del.body ?? del.raw }, null, 2));
  }

  console.log(JSON.stringify({ at: now(), ok: true, base, commit }, null, 2));
};

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  console.error(JSON.stringify({ at: now(), ok: false, error: msg.slice(0, 500) }, null, 2));
  process.exit(1);
});
