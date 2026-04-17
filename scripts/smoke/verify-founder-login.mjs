const requiredEnv = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const base = process.env.SMOKE_BASE_URL ?? "https://lawcaspro-v5.vercel.app";
const email = requiredEnv("FOUNDER_EMAIL").trim().toLowerCase();
const password = requiredEnv("FOUNDER_PASSWORD");

const now = () => new Date().toISOString();

const reqJson = async (method, url, body, headers = {}) => {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(txt);
  } catch {
  }
  return { status: res.status, headers: res.headers, body: parsed, raw: txt };
};

const run = async () => {
  const ver = await reqJson("GET", `${base}/api/healthz/version`);
  const commit = typeof ver.body?.commit === "string" ? ver.body.commit : null;

  const login = await reqJson("POST", `${base}/api/auth/login`, { email, password });
  const setCookie = login.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0];

  const me = cookie ? await reqJson("GET", `${base}/api/auth/me`, undefined, { cookie }) : null;

  const ok = login.status === 200 && me?.status === 200;
  console.log(
    JSON.stringify(
      {
        at: now(),
        base,
        commit,
        ok,
        loginStatus: login.status,
        meStatus: me?.status ?? null,
        loginBody: login.body ?? login.raw,
        meBody: me?.body ?? me?.raw ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
};

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  console.error(JSON.stringify({ at: now(), ok: false, error: msg.slice(0, 500) }, null, 2));
  process.exit(1);
});

