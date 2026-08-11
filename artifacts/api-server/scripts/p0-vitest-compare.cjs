// STEP 4 machine compare: baseline vs current vitest JSON
// Identity: relative file path || full test name
// Failure fingerprint: normalized 1st failure message

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const BASELINE_P = path.join(ROOT, "artifacts", "api-server", "test-results-baseline-2c2c151.json");
const CURRENT_P  = path.join(ROOT, "artifacts", "api-server", "test-results-current.json");
const OUT_P      = path.join(ROOT, "artifacts", "api-server", "p0-compare-report.json");

const makeRel = (abs) => {
  let r = abs.replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/");
  if (r.startsWith(root + "/")) r = r.slice(root.length + 1);
  const wtPrefix = "/AppData/Local/Temp/lawcaspro-v5-baseline-2c2c1512/";
  const idx = r.indexOf(wtPrefix);
  if (idx >= 0) r = r.slice(idx + wtPrefix.length);
  return r;
};

function normalize(msg) {
  if (typeof msg !== "string") msg = msg == null ? "" : String(msg);
  msg = msg.replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<TS>");
  msg = msg.replace(/\b[A-Z]:\\[^\s"'()]+\\(?:node_modules|\.pnpm)[^\s"'()]*/g, "<NODE>");
  msg = msg.replace(/\b\/(?:tmp|temp|var\/folders|Users\/[^\s/]+\/AppData\/Local\/Temp)\/[^\s"'()<>]+/g, "<TMP>");
  msg = msg.replace(/file:\/\/\/[^\s"'()]+/g, "<FILE>");
  msg = msg.replace(/\bat\s+[^\n]+/g, "");
  msg = msg.replace(/\s+/g, " ").trim();
  return msg;
}

function loadSuite(p) {
  const raw = fs.readFileSync(p, "utf8");
  const j = JSON.parse(raw);
  const failures = new Map(); // key => normalized msg
  const all = new Map();      // key => status (string)
  for (const r of j.testResults || []) {
    const rel = makeRel(r.name);
    for (const t of r.assertionResults || []) {
      const key = `${rel}||${t.fullName}`;
      all.set(key, t.status);
      if (t.status === "failed") {
        const m = normalize((t.failureMessages && t.failureMessages[0]) || "");
        failures.set(key, m);
      }
    }
  }
  return {
    passed:  j.numPassedTests  ?? 0,
    failed:  j.numFailedTests  ?? 0,
    skipped: j.numPendingTests ?? 0,
    todo:    j.numTodoTests    ?? 0,
    failures,
    all,
  };
}

const b = loadSuite(BASELINE_P);
const c = loadSuite(CURRENT_P);

const unchanged = [];
const newFails  = [];
const resolved  = [];

for (const [key, bMsg] of b.failures.entries()) {
  if (!c.all.has(key)) continue; // dropped test -> skip
  const cMsg = c.failures.get(key);
  if (cMsg === undefined) resolved.push({ key, baselineFingerprint: bMsg });
  else if (cMsg === bMsg) unchanged.push({ key, fingerprint: bMsg });
  else newFails.push({ key, baselineFingerprint: bMsg, currentFingerprint: cMsg });
}

for (const [key, cMsg] of c.failures.entries()) {
  if (b.all.has(key)) continue; // already in baseline (handled above)
  newFails.push({ key, baselineFingerprint: "<NEW_TEST_NOT_IN_BASELINE>", currentFingerprint: cMsg });
}

const out = {
  baseline: { passed: b.passed, failed: b.failed, skipped: b.skipped, todo: b.todo },
  current:  { passed: c.passed, failed: c.failed, skipped: c.skipped, todo: c.todo },
  unchangedFailures: unchanged.map(x => x.key),
  newFailures: newFails,
  resolvedFailures: resolved.map(x => x.key),
  newFailuresCount: newFails.filter(x => x.baselineFingerprint !== "<NEW_TEST_NOT_IN_BASELINE>").length,
  newTestFailuresCount: newFails.filter(x => x.baselineFingerprint === "<NEW_TEST_NOT_IN_BASELINE>").length,
};

fs.writeFileSync(OUT_P, JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify({
  newFailures: out.newFailuresCount,
  newTestFailures: out.newTestFailuresCount,
  resolved: out.resolvedFailures.length,
  unchanged: out.unchangedFailures.length,
  baselineFailed: b.failed,
  currentFailed: c.failed,
  outFile: OUT_P,
  NEW_FAILURES_GATE: (out.newFailuresCount === 0) ? "PASS" : "FAIL",
}, null, 2));

process.exit(out.newFailuresCount === 0 ? 0 : 1);
