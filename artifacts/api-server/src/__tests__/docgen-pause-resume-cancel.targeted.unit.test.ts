import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTES_DOCS_PATH = path.resolve(
  __dirname,
  "..",
  "routes",
  "documents.ts",
);
const GUARDS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "lawcaspro",
  "src",
  "pages",
  "app",
  "documents",
  "automation-guards.ts",
);
const AUTOMATION_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "lawcaspro",
  "src",
  "pages",
  "app",
  "documents",
  "automation.tsx",
);

function findWriteAuditLogCallBlocks(src: string): Array<{
  full: string;
  action: string | null;
  hasDbROption: boolean;
}> {
  const results: Array<{
    full: string;
    action: string | null;
    hasDbROption: boolean;
  }> = [];
  let pos = 0;
  for (;;) {
    const start = src.indexOf("await writeAuditLog(", pos);
    if (start < 0) break;
    let depth = 0;
    let i = start;
    let started = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") { depth++; started = true; }
      else if (ch === ")") {
        depth--;
        if (started && depth === 0) break;
      }
    }
    const block = src.slice(start, i + 1);
    const actionMatch = block.match(/action:\s*"([^"]+)"/);
    const hasDbR = /,\s*\{\s*db:\s*r\s*\}\s*\)$/.test(block.trim());
    results.push({
      full: block,
      action: actionMatch ? actionMatch[1]! : null,
      hasDbROption: hasDbR,
    });
    pos = i + 1;
  }
  return results;
}

function extractRouteBody(src: string, routeSignature: string): string {
  const routeStart = src.indexOf(routeSignature);
  if (routeStart < 0) return "";
  const asyncIdx = src.indexOf("async (req", routeStart);
  if (asyncIdx < 0) return "";
  let depth = 0;
  let started = false;
  let i = asyncIdx;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") {
      depth--;
      if (started && depth === 0) break;
    }
  }
  return src.slice(asyncIdx, i + 1);
}

type LightJob = {
  status?: string | null;
  nextAction?: string | null;
  active?: boolean | null;
  progress?: { total?: number; success?: number; failed?: number; pending?: number; running?: number } | null;
  items?: Array<{ status?: string | null }> | null;
  successCount?: number | null;
  failedCount?: number | null;
  pendingCount?: number | null;
  runningCount?: number | null;
  totalCount?: number | null;
};

function mirror_progress(job: LightJob) {
  const total = Number(job.progress?.total ?? job.totalCount ?? 0);
  const success = Number(job.progress?.success ?? job.successCount ?? 0);
  const failed = Number(job.progress?.failed ?? job.failedCount ?? 0);
  const pending = Number(job.progress?.pending ?? job.pendingCount ?? 0);
  const running = Number(job.progress?.running ?? job.runningCount ?? 0);
  return { total, success, failed, pending, running };
}

function mirror_isComplete(job: LightJob) {
  const p = mirror_progress(job);
  if (p.total <= 0) return false;
  const done = p.success + p.failed;
  return done >= p.total && p.pending === 0 && p.running === 0;
}

function mirror_getDisplayStatus(job: LightJob | null): string | null {
  if (!job) return null;
  const st = String(job.status ?? "").toLowerCase();
  const na = String(job.nextAction ?? "").toLowerCase();
  const active = job.active;
  const p = mirror_progress(job);
  const progressComplete = mirror_isComplete(job);

  if (st === "failed") return "FAILED";
  if (st === "cancelled") return "CANCELLED";
  if (st === "paused") return "PAUSED";
  if (st === "generated_download_failed") return "GENERATED_DOWNLOAD_FAILED";
  if (st === "completed") return "COMPLETED";
  if (st === "completed_with_errors") return "PARTIALLY_COMPLETED";
  if (na === "stop" || st === "failed" || (active === false && !progressComplete)) {
    if (p.total === 0) return "FAILED";
    if (progressComplete) return p.failed > 0 ? "PARTIALLY_COMPLETED" : "COMPLETED";
    return "FAILED";
  }
  if (st === "running" || st === "pending" || st === "finalizing" || na === "run_next" || na === "wait" || na === "finalize" || na === "download") {
    return "GENERATING";
  }
  if (progressComplete) return p.failed > 0 ? "PARTIALLY_COMPLETED" : "COMPLETED";
  if (p.total > 0) return "GENERATING";
  return null;
}

function extractRouteBodyByPath(src: string, routePathLiteral: string): string {
  const pathIdx = src.indexOf(routePathLiteral);
  if (pathIdx < 0) return "";
  const preamble = src.slice(Math.max(0, pathIdx - 200), pathIdx);
  let rpIdx = preamble.lastIndexOf("router.post(");
  if (rpIdx < 0) rpIdx = preamble.lastIndexOf("router.get(");
  if (rpIdx < 0) return "";
  const baseStart = Math.max(0, pathIdx - 200) + rpIdx;
  const asyncIdx = src.indexOf("async (req", baseStart);
  if (asyncIdx < 0) return "";
  let depth = 0;
  let started = false;
  let i = asyncIdx;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") {
      depth--;
      if (started && depth === 0) break;
    }
  }
  return src.slice(asyncIdx, i + 1);
}

function extractFunctionBodyByName(src: string, fnName: string): string {
  const marker = `async function ${fnName}(`;
  const fnStart = src.indexOf(marker);
  if (fnStart < 0) return "";
  let parenDepth = 0;
  let i = fnStart;
  let parenStarted = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") { parenDepth++; parenStarted = true; }
    else if (ch === ")") {
      parenDepth--;
      if (parenStarted && parenDepth === 0) {
        i++;
        break;
      }
    }
  }
  let depthParen = 0;
  let depthAngles = 0;
  let depthSquares = 0;
  let bodyBraceStart = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '<') depthAngles++;
    else if (ch === '>') depthAngles--;
    else if (ch === '[') depthSquares++;
    else if (ch === ']') depthSquares--;
    else if (ch === '{' && depthParen === 0 && depthAngles === 0 && depthSquares === 0) {
      bodyBraceStart = i;
      break;
    }
  }
  if (bodyBraceStart < 0) return "";
  let depth = 0;
  let started = false;
  let j = bodyBraceStart;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") {
      depth--;
      if (started && depth === 0) break;
    }
  }
  return src.slice(bodyBraceStart, j + 1);
}

function extractArrowFunctionBodyByName(src: string, varName: string): string {
  const marker = `const ${varName} = `;
  const fnStart = src.indexOf(marker);
  if (fnStart < 0) return "";
  let i = fnStart + marker.length;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === "a" && src.slice(i, i + 5) === "async") i += 5;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  let parenDepth = 0;
  let parenStarted = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") { parenDepth++; parenStarted = true; }
    else if (ch === ")") {
      parenDepth--;
      if (parenStarted && parenDepth === 0) { i++; break; }
    }
  }
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] === "=" && src[i + 1] === ">") { i += 2; }
  let depthParen = 0;
  let depthAngles = 0;
  let depthSquares = 0;
  let bodyBraceStart = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '<') depthAngles++;
    else if (ch === '>') depthAngles--;
    else if (ch === '[') depthSquares++;
    else if (ch === ']') depthSquares--;
    else if (ch === '{' && depthParen === 0 && depthAngles === 0 && depthSquares === 0) {
      bodyBraceStart = i;
      break;
    }
  }
  if (bodyBraceStart < 0) return "";
  let depth = 0;
  let started = false;
  let j = bodyBraceStart;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") {
      depth--;
      if (started && depth === 0) break;
    }
  }
  return src.slice(bodyBraceStart, j + 1);
}

function extractAnyFnBody(src: string, name: string): string {
  const a = extractFunctionBodyByName(src, name);
  if (a.length > 0) return a;
  return extractArrowFunctionBodyByName(src, name);
}

describe("docgen pause/resume/cancel — focused regression suite (FAST FIX MODE)", () => {
  it("CASE 1: pause/resume/cancel routes all obtain tenant r via getRlsDb and scope by firm_id", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");

    const pathLiterals = [
      '"/documents/jobs/:jobId/pause"',
      '"/documents/jobs/:jobId/resume"',
      '"/documents/jobs/:jobId/cancel"',
    ];

    for (const lit of pathLiterals) {
      expect(src.indexOf(lit)).toBeGreaterThan(0);
      const body = extractRouteBodyByPath(src, lit);
      expect(body.length).toBeGreaterThan(500);
      expect(body.indexOf("const r = getRlsDb(req, res);")).toBeGreaterThan(0);
      expect(body.indexOf("if (!r) return;")).toBeGreaterThan(0);
      expect(body.indexOf(`firm_id = \${req.firmId!}`)).toBeGreaterThan(0);
    }
  });

  it("CASE 2: pause/resume/cancel audit calls (documents.generation_jobs.*) all pass { db: r } tenant rlsDb", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const allCalls = findWriteAuditLogCallBlocks(src);

    const pauseAudit = allCalls.filter(c => c.action === "documents.generation_jobs.pause");
    const resumeAudit = allCalls.filter(c => c.action === "documents.generation_jobs.resume");
    const cancelAudit = allCalls.filter(c => c.action === "documents.generation_jobs.cancel");

    expect(pauseAudit.length).toBe(1);
    expect(resumeAudit.length).toBe(1);
    expect(cancelAudit.length).toBe(1);

    for (const c of [...pauseAudit, ...resumeAudit, ...cancelAudit]) {
      expect(c.hasDbROption).toBe(true);
    }
  });

  it("CASE 3: run-next exits WITHOUT mutation (pre-claim) when job paused or cancelled — guards BEFORE lock-acquisition UPDATE", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");

    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/run-next"');
    expect(body.length).toBeGreaterThan(1000);

    const lockAcquisitionLine = body.indexOf("timeout_at = now() + interval");
    expect(lockAcquisitionLine).toBeGreaterThan(0);

    const pausedGuardIdx = body.indexOf('statusBefore === "paused"');
    const cancelledGuardIdx = body.indexOf('statusBefore === "cancelled"');

    expect(pausedGuardIdx).toBeGreaterThan(0);
    expect(cancelledGuardIdx).toBeGreaterThan(0);
    expect(pausedGuardIdx).toBeLessThan(lockAcquisitionLine);
    expect(cancelledGuardIdx).toBeLessThan(lockAcquisitionLine);

    const runNextSliceStart = src.indexOf('"/documents/jobs/:jobId/run-next"');
    const runNextRouteAll = src.slice(runNextSliceStart, runNextSliceStart + body.length + 4000);
    const pausedEarlyRetCount = (runNextRouteAll.match(/JOB_PAUSED/g) || []).length;
    const cancelledStopVarAssign = (runNextRouteAll.match(/nextActionBefore\s*\:\s*"stop"\s*=\s*"stop"/g) || []).length;
    const cancelledStopUsed = (runNextRouteAll.match(/nextAction\s*\:\s*nextActionBefore/g) || []).length;
    expect(pausedEarlyRetCount).toBeGreaterThanOrEqual(1);
    expect(cancelledStopVarAssign).toBeGreaterThanOrEqual(1);
    expect(cancelledStopUsed).toBeGreaterThanOrEqual(1);
  });

  it("CASE 4: cancel is idempotent — RETURNING-based race detection: RETURNING empty triggers re-read; actual cancelled → idempotent 200 no duplicate audit; other terminal → 409", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");

    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/cancel"');
    expect(body.length).toBeGreaterThan(500);

    const allowlistIdx = body.indexOf("AND status IN ('pending','running','paused')");
    expect(allowlistIdx).toBeGreaterThan(0);

    const returningPresent = body.indexOf("RETURNING *");
    expect(returningPresent).toBeGreaterThan(0);

    const zeroRowReread = body.indexOf('actualStatus === "cancelled"');
    expect(zeroRowReread).toBeGreaterThan(0);

    const code409 = body.indexOf("JOB_NOT_CANCELLABLE");
    expect(code409).toBeGreaterThan(0);

    const actualCancelledIdempotent = body.indexOf('actualStatus === "cancelled"');
    expect(actualCancelledIdempotent).toBeGreaterThan(0);

    const idempotentMeta = body.indexOf('idempotent: true');
    expect(idempotentMeta).toBeGreaterThan(0);

    const allCmpStatusReads = (body.match(/actualStatus === "([A-Za-z0-9_]+)"/g) ?? []) as string[];
    const nonCancelledReads = allCmpStatusReads.filter((s) => !s.includes('"cancelled"')).length;
    expect(nonCancelledReads).toBe(0);
    const idempotentBranch = body.indexOf('actualStatus === "cancelled"');
    expect(idempotentBranch).toBeGreaterThan(0);
    const notCancellable409 = body.indexOf("JOB_NOT_CANCELLABLE");
    expect(notCancellable409).toBeGreaterThan(idempotentBranch);
    const statusPassedThrough = body.indexOf("status: actualStatus", notCancellable409);
    expect(statusPassedThrough).toBeGreaterThan(notCancellable409);
    const fourOhNineBlock = body.slice(notCancellable409, notCancellable409 + 2000);
    const cancelledIn409Literal = fourOhNineBlock.indexOf('status: "cancelled"');
    expect(cancelledIn409Literal).toBe(-1);
  });

  it("CASE 5: pause/resume/cancel routes NEVER delete outputs — no DELETE statements, no count resets, items table untouched", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");

    const routeSlices = [
      extractRouteBodyByPath(src, '"/documents/jobs/:jobId/pause"'),
      extractRouteBodyByPath(src, '"/documents/jobs/:jobId/resume"'),
      extractRouteBodyByPath(src, '"/documents/jobs/:jobId/cancel"'),
    ];

    const neverKeywords = [
      "DELETE FROM",
      "document_generation_job_items",
      "object_storage",
      "generated_files",
      "case_documents",
    ];

    for (let i = 0; i < routeSlices.length; i++) {
      const slice = routeSlices[i]!;
      for (const kw of neverKeywords) {
        expect(slice.toUpperCase().indexOf(kw.toUpperCase())).toBe(-1);
      }
      const updateMatches = slice.match(/UPDATE[\s\S]*?SET[\s\S]*?WHERE/g) || [];
      for (const upd of updateMatches) {
        expect(upd).not.toMatch(/success_count\s*=/);
        expect(upd).not.toMatch(/failed_count\s*=/);
        expect(upd).not.toMatch(/pending_count\s*=/);
      }
    }
  });

  it("CASE 6: getDisplayStatus returns PAUSED for paused job — structural order check + semantic mirror", () => {
    expect(fs.existsSync(GUARDS_PATH)).toBe(true);
    const guardsSrc = fs.readFileSync(GUARDS_PATH, "utf8");

    const pausedIdx = guardsSrc.indexOf('st === "paused"');
    const cancelledIdx = guardsSrc.indexOf('st === "cancelled"');
    const activeFalseFailedBranch = guardsSrc.indexOf("(active === false && !isProgressComplete(snapshot))");

    expect(pausedIdx).toBeGreaterThan(0);
    expect(cancelledIdx).toBeGreaterThan(0);
    expect(activeFalseFailedBranch).toBeGreaterThan(0);
    expect(cancelledIdx).toBeLessThan(activeFalseFailedBranch);
    expect(pausedIdx).toBeLessThan(activeFalseFailedBranch);

    const pausedJob: LightJob = {
      status: "paused",
      nextAction: "wait",
      active: true,
      progress: { total: 5, success: 2, failed: 1, pending: 2, running: 0 },
      items: [],
    };
    const result = mirror_getDisplayStatus(pausedJob);
    expect(result).toBe("PAUSED");
  });

  it("CASE 7: getDisplayStatus returns CANCELLED for cancelled job (NOT FAILED even with active=false and incomplete progress)", () => {
    expect(fs.existsSync(GUARDS_PATH)).toBe(true);
    const guardsSrc = fs.readFileSync(GUARDS_PATH, "utf8");

    const cancelledIdx = guardsSrc.indexOf('st === "cancelled"');
    const failedEarlyCheck = guardsSrc.indexOf('st === "failed"');
    const activeFalseFailedBranch = guardsSrc.indexOf("(active === false && !isProgressComplete(snapshot))");
    const genericFailedReturnAfterActiveFalse = guardsSrc.indexOf('return "FAILED";', activeFalseFailedBranch);

    expect(cancelledIdx).toBeGreaterThan(0);
    expect(failedEarlyCheck).toBeGreaterThan(0);
    expect(activeFalseFailedBranch).toBeGreaterThan(0);
    expect(genericFailedReturnAfterActiveFalse).toBeGreaterThan(0);
    expect(cancelledIdx).toBeLessThan(genericFailedReturnAfterActiveFalse);

    const cancelledIncompleteJob: LightJob = {
      status: "cancelled",
      nextAction: "stop",
      active: false,
      progress: { total: 5, success: 2, failed: 1, pending: 2, running: 0 },
      items: [],
    };
    const result = mirror_getDisplayStatus(cancelledIncompleteJob);
    expect(result).toBe("CANCELLED");
    expect(result).not.toBe("FAILED");
  });

  it("CASE 8/H+I: Generate disabled blocks PAUSED but NOT CANCELLED (PAUSED locks single-slot activeJobId; Cancel is force-unlock)", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");

    const expectedPredicate = /disabled=\{busy \|\| \(hasActiveJob && \(displayStatus === "GENERATING" \|\| displayStatus === "PAUSED"\)\) \|\| blocksWordTemplates\}/g;
    const matches = Array.from(uiSrc.matchAll(expectedPredicate));
    expect(matches.length).toBeGreaterThanOrEqual(2);

    for (const m of matches) {
      const predicate = m[0]!;
      const includesPaused = predicate.includes('displayStatus === "PAUSED"');
      const includesGenerating = predicate.includes('displayStatus === "GENERATING"');
      const includesCancelled = predicate.toUpperCase().includes("CANCELLED");
      expect(includesPaused).toBe(true);
      expect(includesGenerating).toBe(true);
      expect(includesCancelled).toBe(false);
    }
  });

  it("CASE 9: paused status card exposes Resume Job button", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");

    const pausedConditional = uiSrc.indexOf('displayStatus === "PAUSED"');
    expect(pausedConditional).toBeGreaterThan(0);

    const afterPausedBlock = uiSrc.slice(pausedConditional, pausedConditional + 2000);
    const resumeBtnIdx = afterPausedBlock.indexOf("Resume Job");
    expect(resumeBtnIdx).toBeGreaterThan(0);

    const pauseCheckInButton = uiSrc.indexOf('handleResumeJob()');
    expect(pauseCheckInButton).toBeGreaterThan(0);
  });

  it("CASE 10: generating status card exposes both Pause button AND Cancel Job button", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");

    const generatingConditional = uiSrc.indexOf('displayStatus === "GENERATING"');
    expect(generatingConditional).toBeGreaterThan(0);

    const afterGeneratingBlock = uiSrc.slice(generatingConditional, generatingConditional + 2500);
    const pauseLabelMatch = afterGeneratingBlock.match(/>\s*Pause\s*</);
    const cancelBtnLabel1 = afterGeneratingBlock.indexOf("Cancel Job");
    expect(pauseLabelMatch).not.toBeNull();
    expect(cancelBtnLabel1).toBeGreaterThan(0);

    const pauseHandler = uiSrc.indexOf('handlePauseJob()');
    const cancelHandler = uiSrc.indexOf('handleCancelJob()');
    expect(pauseHandler).toBeGreaterThan(0);
    expect(cancelHandler).toBeGreaterThan(0);

    const cancelConfirm = uiSrc.indexOf("Cancel this generation job? Completed files will be kept. Pending documents will not continue.");
    expect(cancelConfirm).toBeGreaterThan(0);
  });

  // ================================================================
  // CONCURRENCY HARDENING REGRESSIONS (Phase3 allowlist + CTE locks)
  // ================================================================

  it("CONC-A: processAutomationGenerationJobStep uses strict status ALLOWLIST — only pending/running proceed (all other states early return)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    expect(body.length).toBeGreaterThan(1000);
    const allowlistGuard = body.indexOf('status !== "pending" && status !== "running"');
    expect(allowlistGuard).toBeGreaterThan(0);
    const returnAfterGuard = body.indexOf("return;", allowlistGuard);
    expect(returnAfterGuard).toBeGreaterThan(allowlistGuard);
    const beforePromotion = body.indexOf('if (status === "pending")');
    expect(beforePromotion).toBeGreaterThan(returnAfterGuard);
  });

  it("CONC-B: processAutomationGenerationJobStep early return runs BEFORE pending->running promo AND before duplicate-skip AND before claim CTE", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    expect(body.length).toBeGreaterThan(1000);
    const allowlistGuard = body.indexOf('status !== "pending" && status !== "running"');
    const pendingPromo = body.indexOf('if (status === "pending")');
    const activeJobDup = body.indexOf("WITH active_job AS (");
    const claimCte = body.indexOf("FOR UPDATE OF i SKIP LOCKED");
    expect(allowlistGuard).toBeGreaterThan(0);
    expect(pendingPromo).toBeGreaterThan(allowlistGuard);
    expect(activeJobDup).toBeGreaterThan(allowlistGuard);
    expect(claimCte).toBeGreaterThan(allowlistGuard);
  });

  it("CONC-C: only pending may auto-transition to running — guarded UPDATE WHERE ... AND status='pending' RETURNING id with re-check fallback", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    expect(body.length).toBeGreaterThan(1000);
    expect(body.indexOf('if (status === "pending")')).toBeGreaterThan(0);
    expect(body.indexOf("AND status = 'pending'")).toBeGreaterThan(0);
    expect(body.indexOf("RETURNING id")).toBeGreaterThan(0);
    expect(body.indexOf("(promoted as any[]).length < 1")).toBeGreaterThan(0);
    const pausedRecheck = body.indexOf('latestStatus !== "running"');
    expect(pausedRecheck).toBeGreaterThan(0);
    expect(body.indexOf('if (status !== "running")')).toBe(-1);
  });

  it("CONC-D: item claim uses locked active_job parent CTE (FOR UPDATE) + JOIN + next CTE JOIN active_job — ONE atomic SQL statement (no loose EXISTS)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    expect(body.length).toBeGreaterThan(1000);
    const skipLocked = body.indexOf("FOR UPDATE OF i SKIP LOCKED");
    expect(skipLocked).toBeGreaterThan(0);
    const claimActiveJob = body.lastIndexOf("WITH active_job AS (", skipLocked);
    expect(claimActiveJob).toBeGreaterThan(0);
    const activeJobRegion = body.slice(claimActiveJob, skipLocked + 400);
    expect(activeJobRegion.includes("status = 'running'")).toBe(true);
    expect(activeJobRegion.includes("FOR UPDATE")).toBe(true);
    expect(activeJobRegion.includes("JOIN active_job j")).toBe(true);
    expect(activeJobRegion.includes("UPDATE document_generation_job_items i")).toBe(true);
    expect(activeJobRegion.includes("EXISTS (")).toBe(false);
  });

  it("CONC-E: startDocumentGenerationJobRunner post-step check stops the loop for paused/cancelled (no further steps)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "startDocumentGenerationJobRunner");
    expect(body.length).toBeGreaterThan(500);
    const pauseCheck = body.indexOf(`status === "paused"`);
    const cancelCheck = body.indexOf(`status === "cancelled"`);
    expect(pauseCheck).toBeGreaterThan(0);
    expect(cancelCheck).toBeGreaterThan(0);
    const stepsRun = body.indexOf("stepsRun += 1;");
    const noWorkReturn = body.indexOf('stoppedReason: "no_work"', Math.max(pauseCheck, cancelCheck));
    expect(stepsRun).toBeGreaterThan(0);
    expect(noWorkReturn).toBeGreaterThan(stepsRun);
  });

  it("CONC-F: finalizeDocGenJobIfDone uses exact source ALLOWLIST, RETURNING * on guarded UPDATE, finished_at merged for failed, zero-row reread returns finalized:false (denylist NOT IN banned)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "finalizeDocGenJobIfDone");
    expect(body.length).toBeGreaterThan(500);
    const preAllowlist = body.indexOf('preStatus !== "pending" && preStatus !== "running"');
    expect(preAllowlist).toBeGreaterThan(0);
    const statusInAllowlistGuard = (body.match(/AND status IN \('pending','running'\)/g) || []).length;
    expect(statusInAllowlistGuard).toBeGreaterThanOrEqual(2);
    const denylistMatches = (body.match(/NOT IN \('paused','cancelled'\)/g) || []).length;
    expect(denylistMatches).toBe(0);
    const returningPresent = body.indexOf("RETURNING status, action, download_object_path");
    expect(returningPresent).toBeGreaterThan(0);
    const finishedAtMerge = body.indexOf("pending_count = 0");
    expect(finishedAtMerge).toBeGreaterThan(0);
    const finishedAtNow = body.indexOf("finished_at = now()", finishedAtMerge);
    expect(finishedAtNow).toBeGreaterThan(finishedAtMerge);
    const zeroRereadBranch = body.indexOf("!updatedRows || updatedRows.length === 0");
    expect(zeroRereadBranch).toBeGreaterThan(returningPresent);
    const finalizedFalse = body.indexOf('finalized: false,', zeroRereadBranch);
    expect(finalizedFalse).toBeGreaterThan(zeroRereadBranch);
  });

  it("CONC-G: runner catch + process step 2x failed-path UPDATEs all use exact allowlist AND status IN ('pending','running') — denylist banned", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");

    const procStep = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    const runnerFn = extractFunctionBodyByName(src, "startDocumentGenerationJobRunner");
    expect(procStep.length).toBeGreaterThan(500);
    expect(runnerFn.length).toBeGreaterThan(500);

    const procStepInGuards = (procStep.match(/AND status IN \('pending','running'\)/g) || []).length;
    const runnerCatchInGuards = (runnerFn.match(/AND status IN \('pending','running'\)/g) || []).length;
    expect(procStepInGuards).toBe(2);
    expect(runnerCatchInGuards).toBeGreaterThanOrEqual(1);

    const procStepDenylist = (procStep.match(/NOT IN \('paused','cancelled'\)/g) || []).length;
    const runnerDenylist = (runnerFn.match(/NOT IN \('paused','cancelled'\)/g) || []).length;
    expect(procStepDenylist).toBe(0);
    expect(runnerDenylist).toBe(0);

    const recoverFn = extractFunctionBodyByName(src, "recoverStaleDocumentGenerationJob");
    const recoverActiveJobCte = recoverFn.indexOf("WITH active_job AS (");
    expect(recoverActiveJobCte).toBeGreaterThan(0);
    const recoverForUpdateCte = recoverFn.indexOf("active_job AS (", recoverActiveJobCte);
    const recoverInClause = recoverFn.indexOf("status IN ('pending','running')", recoverForUpdateCte);
    expect(recoverInClause).toBeGreaterThan(recoverActiveJobCte);
    const recoverForUpdateKw = recoverFn.indexOf("FOR UPDATE", recoverInClause);
    expect(recoverForUpdateKw).toBeGreaterThan(recoverInClause);
    const recoverItemsJoinJ = recoverFn.indexOf("i.job_id = j.id");
    const recoverOuterJoin = recoverFn.indexOf("FROM active_job a");
    expect(recoverItemsJoinJ).toBeGreaterThan(recoverForUpdateKw);
    expect(recoverOuterJoin).toBeGreaterThan(recoverItemsJoinJ);
  });

  // ================================================================
  // FINAL HARDENING ITEMS A..X
  // ================================================================

  it("A. Pause button is clickable while generation busy=true — disabled predicate uses jobControlBusy NOT busy", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");
    const pauseLabelRe = />\s*Pause\s*</;
    const match = uiSrc.match(pauseLabelRe);
    expect(match).not.toBeNull();
    const pauseBtnIdx = (match!.index ?? 0) + 1;
    const pauseBtnArea = uiSrc.slice(Math.max(0, pauseBtnIdx - 500), pauseBtnIdx + 50);
    const usesJobBusyNotBusy =
      pauseBtnArea.includes("!activeJobId || jobControlBusy") &&
      !pauseBtnArea.match(/disabled=\{\s*busy\s*\|\|/);
    expect(usesJobBusyNotBusy).toBe(true);
  });

  it("B. Cancel button is clickable while generation busy=true — disabled predicate uses jobControlBusy NOT busy", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");
    const cancelLabelRe = />\s*Cancel Job\s*</;
    const match = uiSrc.match(cancelLabelRe);
    expect(match).not.toBeNull();
    const cancelTextIdx = (match!.index ?? 0) + 1;
    expect(cancelTextIdx).toBeGreaterThan(0);
    const btnArea = uiSrc.slice(Math.max(0, cancelTextIdx - 500), cancelTextIdx + 50);
    const usesJobBusyNotBusy =
      btnArea.includes("!activeJobId || jobControlBusy") &&
      !btnArea.match(/disabled=\{\s*busy\s*\|\|/);
    expect(usesJobBusyNotBusy).toBe(true);
  });

  it("C. jobControlBusy dedicated control state: useState declaration, handlers setBusy top + finally clear (anti double-click)", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");
    const stateLine1 = uiSrc.indexOf("const [jobControlBusy, setJobControlBusy]");
    expect(stateLine1).toBeGreaterThan(0);
    const useStateNear = uiSrc.indexOf('"pause"', stateLine1);
    expect(useStateNear).toBeGreaterThan(stateLine1);
    const useStateC = uiSrc.indexOf('"cancel"', stateLine1);
    expect(useStateC).toBeGreaterThan(stateLine1);

    for (const fn of ["handlePauseJob", "handleResumeJob", "handleCancelJob"]) {
      const fnBody = extractAnyFnBody(uiSrc, fn);
      expect(fnBody.length).toBeGreaterThan(100);
      const setBusyTop = fnBody.indexOf('setJobControlBusy("');
      const finallyClearRe = /finally\s*\{[\s\S]*?setJobControlBusy\(\s*null\s*\)/;
      const finallyClear = finallyClearRe.exec(fnBody);
      expect(setBusyTop).toBeGreaterThan(0);
      expect(finallyClear).not.toBeNull();
      expect(((finallyClear?.index ?? 0) + fnBody.indexOf("finally"))).toBeGreaterThan(setBusyTop);
    }
  });

  it("D. processAutomationGenerationJobStep strict allowlist only pending/running — exact item 3 requirement", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    expect(body.indexOf('status !== "pending" && status !== "running"')).toBeGreaterThan(0);
    const retAfter = body.indexOf("return;", body.indexOf('status !== "pending" && status !== "running"'));
    expect(retAfter).toBeGreaterThan(0);
    expect(body.indexOf("WITH active_job AS (")).toBeGreaterThan(retAfter);
  });

  it("E. pending -> running guarded UPDATE requires status='pending' and RETURNING, no blanket force-running", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    const pendingPromoIf = body.indexOf('if (status === "pending")');
    const pendingGuard = body.indexOf("AND status = 'pending'", pendingPromoIf);
    const returningId = body.indexOf("RETURNING id", pendingGuard);
    expect(pendingPromoIf).toBeGreaterThan(0);
    expect(pendingGuard).toBeGreaterThan(pendingPromoIf);
    expect(returningId).toBeGreaterThan(pendingGuard);
    expect(body.indexOf("!== 'running') SET status='running'")).toBe(-1);
    expect(body.indexOf('if (status !== "running")')).toBe(-1);
  });

  it("F. claim SQL contains in SAME statement: active_job parent CTE, status='running', FOR UPDATE, next JOIN active_job, item UPDATE", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    const claimRegionEnd = body.indexOf("FOR UPDATE OF i SKIP LOCKED");
    expect(claimRegionEnd).toBeGreaterThan(0);
    const stmtStart = body.lastIndexOf("WITH active_job AS (", claimRegionEnd);
    expect(stmtStart).toBeGreaterThan(0);
    const stmt = body.slice(stmtStart, claimRegionEnd + 400);
    expect(stmt.includes("WITH active_job AS (")).toBe(true);
    expect(stmt.includes("status = 'running'")).toBe(true);
    expect(stmt.includes("FOR UPDATE")).toBe(true);
    expect(stmt.includes("JOIN active_job j")).toBe(true);
    expect(stmt.includes("UPDATE document_generation_job_items i")).toBe(true);
    expect(stmt.includes("RETURNING i.*")).toBe(true);
  });

  it("G. duplicate-skip SQL contains in SAME statement: locked active_job parent status='running' FOR UPDATE + duplicate item mutation", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "processAutomationGenerationJobStep");
    const allActiveJobs = body.match(/WITH active_job AS \(/g) || [];
    expect(allActiveJobs.length).toBeGreaterThanOrEqual(2);
    const firstActiveJob = body.indexOf("WITH active_job AS (");
    const secondActiveJob = body.indexOf("WITH active_job AS (", firstActiveJob + 20);
    expect(secondActiveJob).toBeGreaterThan(firstActiveJob);
    const dupsEnd = body.indexOf("RETURNING i.id, i.case_id, i.template_id", firstActiveJob);
    expect(dupsEnd).toBeGreaterThan(firstActiveJob);
    const dupsRegion = body.slice(firstActiveJob, dupsEnd + 100);
    expect(dupsRegion.includes("dups AS (")).toBe(true);
    expect(dupsRegion.includes("JOIN active_job j")).toBe(true);
    expect(dupsRegion.includes("status = 'running'")).toBe(true);
    expect(dupsRegion.includes("FOR UPDATE")).toBe(true);
    expect(dupsRegion.includes("UPDATE document_generation_job_items i")).toBe(true);
  });

  it("H. stale recovery SQL contains in SAME statement: locked active_job parent status IN (pending,running) FOR UPDATE + running-item -> pending mutation", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const recoverFn = extractFunctionBodyByName(src, "recoverStaleDocumentGenerationJob");
    expect(recoverFn.indexOf("WITH active_job AS (")).toBeGreaterThan(0);
    const inIdx = recoverFn.indexOf("status IN ('pending','running')");
    expect(inIdx).toBeGreaterThan(0);
    const forUpd = recoverFn.indexOf("FOR UPDATE", inIdx);
    expect(forUpd).toBeGreaterThan(inIdx);
    expect(recoverFn.indexOf("i.job_id = j.id", forUpd)).toBeGreaterThan(forUpd);
    expect(recoverFn.indexOf("FROM active_job a", forUpd)).toBeGreaterThan(forUpd);
    expect(recoverFn.indexOf("UPDATE document_generation_job_items i", forUpd)).toBeGreaterThan(forUpd);
  });

  it("I. runner loop stops on paused/cancelled after every processAutomationGenerationJobStep", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const runner = extractFunctionBodyByName(src, "startDocumentGenerationJobRunner");
    const postStepBlock = runner.indexOf("processAutomationGenerationJobStep");
    const stopCheck = runner.indexOf('status === "paused"', postStepBlock);
    const cancelCheck = runner.indexOf('status === "cancelled"', postStepBlock);
    const noWorkRet = runner.indexOf('stoppedReason: "no_work"', Math.max(stopCheck, cancelCheck));
    expect(postStepBlock).toBeGreaterThan(0);
    expect(stopCheck).toBeGreaterThan(postStepBlock);
    expect(cancelCheck).toBeGreaterThan(postStepBlock);
    expect(noWorkRet).toBeGreaterThan(Math.max(stopCheck, cancelCheck));
  });

  it("J. finalize transition uses exact allowed source states via IN ('pending','running') allowlist NOT denylist", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "finalizeDocGenJobIfDone");
    const allowlistGuards = (body.match(/AND status IN \('pending','running'\)/g) || []).length;
    expect(allowlistGuards).toBeGreaterThanOrEqual(2);
    const denylistGuards = (body.match(/NOT IN \('paused','cancelled'\)/g) || []).length;
    expect(denylistGuards).toBe(0);
  });

  it("K. finalize guarded UPDATE uses RETURNING clause with actual row columns", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "finalizeDocGenJobIfDone");
    const ret1 = body.indexOf("RETURNING status, action, download_object_path");
    expect(ret1).toBeGreaterThan(0);
  });

  it("L. finalize zero-row race: re-reads actual job, returns finalized:false, returns actual paused/cancelled state, does not emit fake lifecycle log", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "finalizeDocGenJobIfDone");
    const zeroBranch = body.indexOf("!updatedRows || updatedRows.length === 0");
    expect(zeroBranch).toBeGreaterThan(0);
    const reread = body.indexOf("SELECT status, action, download_object_path", zeroBranch);
    expect(reread).toBeGreaterThan(zeroBranch);
    const finalizedFalse = body.indexOf('finalized: false,', reread);
    expect(finalizedFalse).toBeGreaterThan(reread);
    const zeroBranchBlock = body.slice(zeroBranch, finalizedFalse + 400);
    expect(zeroBranchBlock.includes("writeDocumentGenerationLog")).toBe(false);
    expect(zeroBranchBlock.match(/DOCUMENT_GENERATION_(SUCCEEDED|PARTIAL|FAILED)/g)?.length ?? 0).toBe(0);
    const writeLogBlockStart = body.indexOf("writeDocumentGenerationLog(");
    expect(writeLogBlockStart).toBeGreaterThan(finalizedFalse);
    const zeroBranchReturn = body.indexOf("return {", reread);
    expect(zeroBranchReturn).toBeGreaterThan(reread);
    expect(zeroBranchReturn).toBeLessThan(writeLogBlockStart);
    expect(writeLogBlockStart).toBeGreaterThan(zeroBranchReturn);
  });

  it("M. pause UPDATE: status IN ('pending','running') RETURNING, failed transition does not audit (zero rows → 409 before audit)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/pause"');
    expect(body.indexOf("AND status IN ('pending','running')")).toBeGreaterThan(0);
    expect(body.indexOf("RETURNING *")).toBeGreaterThan(0);
    const jnaIndex = body.indexOf("JOB_NOT_ACTIVE");
    const auditIdx = body.indexOf('documents.generation_jobs.pause');
    expect(jnaIndex).toBeGreaterThan(0);
    expect(auditIdx).toBeGreaterThan(jnaIndex);
  });

  it("N. resume UPDATE: status='paused' RETURNING, failed transition does not audit (JOB_NOT_PAUSED 409 before audit)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/resume"');
    expect(body.indexOf("AND status = 'paused'")).toBeGreaterThan(0);
    expect(body.indexOf("RETURNING *")).toBeGreaterThan(0);
    const jnpIndex = body.indexOf("JOB_NOT_PAUSED");
    const auditIdx = body.indexOf('documents.generation_jobs.resume');
    expect(jnpIndex).toBeGreaterThan(0);
    expect(auditIdx).toBeGreaterThan(jnpIndex);
  });

  it("O. cancel only transitions from pending/running/paused allowlist in single guarded UPDATE", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/cancel"');
    expect(body.indexOf("AND status IN ('pending','running','paused')")).toBeGreaterThan(0);
    expect(body.indexOf("RETURNING *")).toBeGreaterThan(0);
  });

  it("P. completed / completed_with_errors / failed / finalizing / generated_download_failed CANNOT become cancelled (return 409 JOB_NOT_CANCELLABLE)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/cancel"');
    const jncIndex = body.indexOf("JOB_NOT_CANCELLABLE");
    expect(jncIndex).toBeGreaterThan(0);
    const rereadCancelledStart = body.indexOf('actualStatus === "cancelled"');
    expect(rereadCancelledStart).toBeGreaterThan(0);
    const check409Block = body.slice(rereadCancelledStart, rereadCancelledStart + 2500);
    expect(check409Block.includes("JOB_NOT_CANCELLABLE")).toBe(true);
    expect(check409Block.includes("res.status(409)") || check409Block.includes("status: 409") || check409Block.includes(".status(409)")).toBe(true);
    expect(check409Block.includes('status: actualStatus')).toBe(true);
  });

  it("Q. already-cancelled request is idempotent — zero RETURNING rereads actual cancelled → 200 with idempotent:true, no duplicate cancel audit", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/cancel"');
    const rereadCancelled = body.indexOf('actualStatus === "cancelled"');
    const idempotentTrue = body.indexOf('idempotent: true', rereadCancelled);
    expect(rereadCancelled).toBeGreaterThan(0);
    expect(idempotentTrue).toBeGreaterThan(rereadCancelled);
    expect(body.indexOf('documents.generation_jobs.cancel', rereadCancelled)).toBe(-1);
  });

  it("R. terminal no-op NEVER returns fake status='cancelled' unless DB actually has cancelled (409 always returns DB status)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/cancel"');
    const jnc409 = body.indexOf("JOB_NOT_CANCELLABLE");
    const region409 = body.slice(jnc409, jnc409 + 1500);
    expect(region409.includes('status: actualStatus')).toBe(true);
    expect(region409.toUpperCase().includes("STATUS: \"CANCELLED\"")).toBe(false);
  });

  it("S. cancelled response preserves truthful running_count = progress.running NOT hardcoded 0", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/cancel"');
    const hardcodedZero = body.match(/running_count:\s*0/g) || [];
    expect(hardcodedZero.length).toBe(0);
    const actualRunning = body.match(/running_count:\s*progress\.running/g) || [];
    expect(actualRunning.length).toBeGreaterThanOrEqual(2);
  });

  it("T. all 3 read/status endpoints preserve paused→nextAction=wait + cancelled→nextAction=stop/active=false semantics", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");

    const routeJobsFull = (() => {
      const needle = 'router.get(\n  "/documents/jobs/:jobId"';
      let idx = src.indexOf(needle);
      if (idx < 0) {
        const re2 = /router\.(get|post)\s*\(\s*"\/documents\/jobs\/:jobId"\s*,/g;
        let m: RegExpExecArray | null;
        while ((m = re2.exec(src)) != null) {
          const rest = src.slice(m.index, m.index + 100);
          if (!/\/(pause|resume|cancel|status|run-next|download)/.test(rest)) {
            idx = m.index;
            break;
          }
        }
      }
      if (idx < 0) return "";
      const startAsync = src.indexOf("async (req", idx);
      if (startAsync < 0) return "";
      let d = 0, s = false, i2 = startAsync;
      for (; i2 < src.length; i2++) {
        const ch = src[i2];
        if (ch === "{") { d++; s = true; }
        else if (ch === "}") { d--; if (s && d === 0) break; }
      }
      return src.slice(startAsync, i2 + 1);
    })();
    expect(routeJobsFull.length).toBeGreaterThan(1000);
    expect(routeJobsFull.indexOf('status === "cancelled"')).toBeGreaterThan(0);
    expect(routeJobsFull.indexOf('"stop" as const')).toBeGreaterThan(0);
    expect(routeJobsFull.indexOf('status === "paused"')).toBeGreaterThan(0);
    expect(routeJobsFull.indexOf('"wait" as const')).toBeGreaterThan(0);
    expect(routeJobsFull.indexOf('statusForcedActiveFalse = status === "failed" || status === "cancelled"')).toBeGreaterThan(0);
    expect(routeJobsFull.indexOf('active: false')).toBeGreaterThan(0);

    const routeStatusShort = (() => {
      const rp = src.lastIndexOf('"/documents/status/:jobId"');
      expect(rp).toBeGreaterThan(0);
      const preamble = src.slice(Math.max(0, rp - 1500), rp);
      const rgIdx = preamble.lastIndexOf("router.get(");
      expect(rgIdx).toBeGreaterThan(-1);
      const baseStart = Math.max(0, rp - 1500) + rgIdx;
      const startAsync = src.indexOf("async (req", baseStart);
      expect(startAsync).toBeGreaterThan(0);
      let d = 0, s = false, i2 = startAsync;
      for (; i2 < src.length; i2++) {
        const ch = src[i2];
        if (ch === "{") { d++; s = true; }
        else if (ch === "}") { d--; if (s && d === 0) break; }
      }
      return src.slice(startAsync, i2 + 1);
    })();
    expect(routeStatusShort.indexOf('st === "paused"')).toBeGreaterThan(0);
    expect(routeStatusShort.indexOf('nextAction: "wait"')).toBeGreaterThan(0);
    expect(routeStatusShort.indexOf('st === "cancelled"')).toBeGreaterThan(0);
    expect(routeStatusShort.indexOf('nextAction: "stop"')).toBeGreaterThan(0);
    expect(routeStatusShort.indexOf("active: false")).toBeGreaterThan(0);

    const routeJobsStatus = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/status"');
    expect(routeJobsStatus.length).toBeGreaterThan(1000);
    const jscancelled = routeJobsStatus.indexOf('"cancelled"');
    const jspaused = routeJobsStatus.indexOf('"paused"');
    expect(jscancelled).toBeGreaterThan(0);
    expect(jspaused).toBeGreaterThan(0);
    const jsStopAfter = routeJobsStatus.indexOf('"stop"', jscancelled);
    const jsWaitAfter = routeJobsStatus.indexOf('"wait"', Math.min(jspaused, jscancelled));
    expect(jsStopAfter).toBeGreaterThan(jscancelled);
    expect(jsWaitAfter).toBeGreaterThan(0);
  });

  it("U. PAUSED display status blocks Generate button start-new (activeJobId single slot locked)", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");
    const predRe = /disabled=\{busy \|\| \(hasActiveJob && \(displayStatus === "GENERATING" \|\| displayStatus === "PAUSED"\)\) \|\| blocksWordTemplates\}/g;
    const preds = Array.from(uiSrc.matchAll(predRe));
    expect(preds.length).toBeGreaterThanOrEqual(2);
    for (const p of preds) {
      expect(p[0]!.includes('displayStatus === "PAUSED"')).toBe(true);
    }
  });

  it("V. CANCELLED display status does NOT block Generate button (force-unlock activeJobId slot)", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");
    const predRe = /disabled=\{busy \|\| \(hasActiveJob && \(displayStatus === "GENERATING" \|\| displayStatus === "PAUSED"\)\) \|\| blocksWordTemplates\}/g;
    const preds = Array.from(uiSrc.matchAll(predRe));
    expect(preds.length).toBeGreaterThanOrEqual(2);
    for (const p of preds) {
      expect(p[0]!.toUpperCase().includes("CANCELLED")).toBe(false);
    }
  });

  it("W. pause/cancel API failure refreshes REAL server status via catch → getGenerationJobStatus instead of leaving client silently stopped", () => {
    expect(fs.existsSync(AUTOMATION_PATH)).toBe(true);
    const uiSrc = fs.readFileSync(AUTOMATION_PATH, "utf8");
    for (const fnName of ["handlePauseJob", "handleResumeJob", "handleCancelJob"]) {
      const fn = extractAnyFnBody(uiSrc, fnName);
      expect(fn.length).toBeGreaterThan(150);
      const catchBlock = fn.indexOf("catch");
      expect(catchBlock).toBeGreaterThan(0);
      const hasStatusRefresh = fn.indexOf("getGenerationJobStatus(jobId)", catchBlock);
      expect(hasStatusRefresh).toBeGreaterThan(catchBlock);
    }
  });

  it("X. pause/resume/cancel audit writeAuditLog calls all pass explicit { db: r } tenant rlsDb context", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const allCalls = findWriteAuditLogCallBlocks(src);
    const pa = allCalls.find(c => c.action === "documents.generation_jobs.pause")!;
    const re = allCalls.find(c => c.action === "documents.generation_jobs.resume")!;
    const ca = allCalls.find(c => c.action === "documents.generation_jobs.cancel")!;
    expect(pa?.hasDbROption).toBe(true);
    expect(re?.hasDbROption).toBe(true);
    expect(ca?.hasDbROption).toBe(true);
  });

  it("FIN-A. finalizeDocGenJobIfDone SELECT/RETURNING queries use created_by (document_generation_jobs column), not user_id", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "finalizeDocGenJobIfDone");
    expect(body.length).toBeGreaterThan(500);
    const createdByCount = (body.match(/created_by/g) ?? []).length;
    expect(createdByCount).toBeGreaterThanOrEqual(3);
  });

  it("FIN-B. finalizeDocGenJobIfDone document_generation_jobs queries contain ZERO user_id references", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "finalizeDocGenJobIfDone");
    expect(body.length).toBeGreaterThan(500);
    const userIdMatch = body.match(/document_generation_jobs[^;]*user_id/g) ?? [];
    expect(userIdMatch.length).toBe(0);
  });

  it("FIN-C. outer finalize route captures `const fin = await finalizeDocGenJobIfDone(...)`", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const finIdx = body.indexOf("const fin = await finalizeDocGenJobIfDone(");
    expect(finIdx).toBeGreaterThan(0);
  });

  it("FIN-D. outer finalize route checks `fin.finalized` BEFORE continuing packaging", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const fin = body.indexOf("const fin = await finalizeDocGenJobIfDone(");
    expect(fin).toBeGreaterThan(0);
    const check = body.indexOf("fin.finalized", fin);
    expect(check).toBeGreaterThan(fin);
    const printAction = body.indexOf('finalAction === "print"', check);
    expect(printAction).toBeGreaterThan(check);
  });

  it("FIN-E. outer finalize route does NOT use an unguarded direct failed UPDATE (no standalone status='failed' WRITE independent of fin)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const finIdx = body.indexOf("const fin = await finalizeDocGenJobIfDone(");
    expect(finIdx).toBeGreaterThan(0);
    const updatesBefore: string[] = [];
    const updateRe = /UPDATE document_generation_jobs[\s\S]*?(?=;)/g;
    let m: RegExpExecArray | null;
    while ((m = updateRe.exec(body)) !== null) {
      if (m.index < finIdx) updatesBefore.push(m[0]!);
    }
    const hasUnguardedFailedBefore = updatesBefore.some(
      (u) => /status\s*=\s*'failed'/.test(u) && !/AND\s+status\s*(?:IN\s*\(|\s*=)/.test(u),
    );
    expect(hasUnguardedFailedBefore).toBe(false);
    const bareRouteFailedUpdate = body.indexOf("SET status = 'failed'");
    if (bareRouteFailedUpdate >= 0) {
      const block = body.slice(Math.max(0, bareRouteFailedUpdate - 100), bareRouteFailedUpdate + 100);
      expect(/finalizeDocGenJobIfDone|fin\.finalized/.test(block)).toBe(true);
    }
  });

  it("FIN-F. print final status UPDATE requires status='finalizing' guard + RETURNING *", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const printAction = body.indexOf('finalAction === "print"');
    expect(printAction).toBeGreaterThan(0);
    const trailing = body.slice(printAction, printAction + 3000);
    const stmtRe =
      /UPDATE document_generation_jobs[\s\S]*?SET[\s\S]*?finished_at\s*=\s*now\(\)[\s\S]*?WHERE id\s*=\s*\$\{jobId\}[\s\S]*?AND firm_id\s*=\s*\$\{req\.firmId!\}[\s\S]*?AND\s+status\s*=\s*'finalizing'[\s\S]*?RETURNING\s+\*/;
    const match = stmtRe.exec(trailing);
    expect(match).not.toBeNull();
  });

  it("FIN-G. zip/download final status UPDATE requires status='finalizing' guard + RETURNING *", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const zipFileLine = body.indexOf("Document_Automation_");
    expect(zipFileLine).toBeGreaterThan(0);
    const trailing = body.slice(zipFileLine, zipFileLine + 3000);
    const stmtRe =
      /UPDATE document_generation_jobs[\s\S]*?SET[\s\S]*?finished_at\s*=\s*now\(\)[\s\S]*?WHERE id\s*=\s*\$\{jobId\}[\s\S]*?AND firm_id\s*=\s*\$\{req\.firmId!\}[\s\S]*?AND\s+status\s*=\s*'finalizing'[\s\S]*?RETURNING\s+\*/;
    const match = stmtRe.exec(trailing);
    expect(match).not.toBeNull();
  });

  it("FIN-H/I. zero-row final transition does NOT write documents.generation_jobs.finalize audit and does NOT return fake completed status", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const finalizeAuditAction = 'documents.generation_jobs.finalize';
    const auditIndexes: number[] = [];
    let aIdx = -1;
    while ((aIdx = body.indexOf(finalizeAuditAction, aIdx + 1)) >= 0) auditIndexes.push(aIdx);
    expect(auditIndexes.length).toBeGreaterThan(0);
    const zipZero = body.indexOf("zipTransitioned.length === 0");
    const printZero = body.indexOf("transitioned.length === 0");
    const finFalse = body.indexOf("!fin.finalized");
    const zeros = [zipZero, printZero, finFalse].filter((i) => i >= 0).sort((a, b) => a - b);
    expect(zeros.length).toBe(3);
    for (const z of zeros) {
      const nextSemicolonReturn = body.indexOf("return;", z + 1);
      const end = nextSemicolonReturn > z ? nextSemicolonReturn + 7 : z + 1200;
      const block = body.slice(z, end);
      const hasAuditInsideZeroBranch = block.includes(finalizeAuditAction);
      expect(hasAuditInsideZeroBranch).toBe(false);
      const hasFakeCompleted =
        block.includes('status: "completed"') ||
        block.includes("status: completed");
      const returnsActual = block.includes("actualState") || block.includes("realState");
      expect(hasFakeCompleted && !returnsActual).toBe(false);
      expect(block.includes("res.status")).toBe(true);
    }
    for (const ai of auditIndexes) {
      const returningBefore =
        body.lastIndexOf("RETURNING *", ai) > body.lastIndexOf("const transitioned", ai) ||
        body.lastIndexOf("RETURNING *", ai) > body.lastIndexOf("const zipTransitioned", ai);
      expect(returningBefore).toBe(true);
    }
  });

  it("FIN-J. finalize route documents.generation_jobs.finalize audit calls use { db: r }", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const allCalls = findWriteAuditLogCallBlocks(src);
    const finals = allCalls.filter(c => c.action === "documents.generation_jobs.finalize");
    expect(finals.length).toBeGreaterThanOrEqual(2);
    for (const f of finals) {
      expect(f.hasDbROption).toBe(true);
    }
  });

  it("RACE-A. readFreshFinalizeState helper SELECTs * FROM document_generation_jobs inside outer finalize route", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const helperIdx = body.indexOf("const readFreshFinalizeState = async (");
    expect(helperIdx).toBeGreaterThan(0);
    const selectIdx = body.indexOf(
      "SELECT * FROM document_generation_jobs WHERE id = ${jobId} AND firm_id = ${req.firmId!} LIMIT 1",
      helperIdx,
    );
    expect(selectIdx).toBeGreaterThan(helperIdx);
  });

  it("RACE-B. readFreshFinalizeState recomputes progress via computeDocGenJobProgress(r, { firmId, jobId })", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const helperStart = body.indexOf("const readFreshFinalizeState = async (");
    expect(helperStart).toBeGreaterThan(0);
    const computeInHelper = body.indexOf(
      "computeDocGenJobProgress(r, { firmId: req.firmId!, jobId })",
      helperStart,
    );
    const nextHelperStart = body.indexOf("const buildResponseFromFresh = (", helperStart);
    const helperEnd = nextHelperStart > helperStart ? nextHelperStart : body.indexOf("};", helperStart);
    expect(computeInHelper).toBeGreaterThan(helperStart);
    expect(computeInHelper).toBeLessThan(helperEnd);
  });

  it("RACE-C/D/E. print zero-row / zip zero-row / fin.finalized=false paths all call readFreshFinalizeState()", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const printZero = body.indexOf("transitioned.length === 0");
    const zipZero = body.indexOf("zipTransitioned.length === 0");
    const finFalse = body.indexOf("!fin.finalized");
    expect(printZero).toBeGreaterThan(0);
    expect(zipZero).toBeGreaterThan(0);
    expect(finFalse).toBeGreaterThan(0);
    for (const idx of [printZero, zipZero, finFalse]) {
      const nextReturn = body.indexOf("return;", idx);
      const end = nextReturn > idx ? nextReturn : idx + 1500;
      const block = body.slice(idx, end);
      expect(block.includes("readFreshFinalizeState()")).toBe(true);
    }
  });

  it("RACE-F/G. fresh finalizing maps to nextAction=wait and is never nextAction=run_next", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const helperStart = body.indexOf("const readFreshFinalizeState = async (");
    const nextHelperStart = body.indexOf("const buildResponseFromFresh = (", helperStart);
    const helperEnd = nextHelperStart > helperStart ? nextHelperStart : body.indexOf("};", helperStart);
    const helperRegion = body.slice(helperStart, helperEnd);
    const finalizingLine = helperRegion.indexOf("freshStatus === \"finalizing\"");
    expect(finalizingLine).toBeGreaterThan(0);
    const endOfFinalizingBranch = helperRegion.indexOf("pending\"", finalizingLine);
    const searchRegion = helperRegion.slice(finalizingLine, endOfFinalizingBranch > finalizingLine ? endOfFinalizingBranch : finalizingLine + 500);
    const waitBranch = searchRegion.indexOf('nextAction = "wait"');
    expect(waitBranch).toBeGreaterThan(0);
    const runNextFinalizing = searchRegion.indexOf("run_next");
    expect(runNextFinalizing).toBe(-1);
  });

  it("RACE-H/I/J/K. lock zero-row calls readFreshFinalizeState; paused/cancelled returns real state NOT FINALIZE_IN_FLIGHT; FINALIZE_IN_FLIGHT reserved for active recent-heartbeat finalizing only; pending/running -> run_next", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const lockFailed = body.indexOf("lockAcquired = acquiredRows.length > 0");
    expect(lockFailed).toBeGreaterThan(0);
    const branchStart = body.indexOf("if (!lockAcquired)", lockFailed);
    expect(branchStart).toBeGreaterThan(lockFailed);
    const nextReturn = body.indexOf("FINALIZE_IN_FLIGHT", branchStart);
    const lockBlock = body.slice(branchStart, nextReturn > branchStart ? nextReturn + 1200 : branchStart + 3500);
    expect(lockBlock.includes("readFreshFinalizeState()")).toBe(true);
    const oldThreeStateList = lockBlock.indexOf('"pending", "running", "finalizing"');
    expect(oldThreeStateList).toBe(-1);
    const terminalOrPaused = lockBlock.indexOf('terminalOrPaused');
    const pausedStr = lockBlock.indexOf('s === "paused"');
    const cancelledStr = lockBlock.indexOf('s === "cancelled"');
    const completedStr = lockBlock.indexOf('s === "completed"');
    const pendingStr = lockBlock.indexOf('s === "pending"');
    const runningStr = lockBlock.indexOf('s === "running"');
    const finalizingStr = lockBlock.indexOf('s === "finalizing"');
    const inFlightCode = lockBlock.indexOf('"FINALIZE_IN_FLIGHT"');
    const runNextInBlock = lockBlock.indexOf('"run_next"');
    expect(terminalOrPaused > 0 || pausedStr > 0 || cancelledStr > 0 || completedStr > 0).toBe(true);
    expect(pendingStr).toBeGreaterThan(0);
    expect(runningStr).toBeGreaterThan(0);
    expect(finalizingStr).toBeGreaterThan(0);
    expect(inFlightCode).toBeGreaterThan(0);
    const firstTerminalCheck = Math.min(
      pausedStr > 0 ? pausedStr : Infinity,
      cancelledStr > 0 ? cancelledStr : Infinity,
      completedStr > 0 ? completedStr : Infinity,
      terminalOrPaused > 0 ? terminalOrPaused : Infinity,
    );
    expect(firstTerminalCheck).toBeLessThan(inFlightCode);
    expect(pendingStr).toBeLessThan(inFlightCode);
    expect(runningStr).toBeLessThan(inFlightCode);
    expect(finalizingStr).toBeLessThan(inFlightCode);
    const realRespB4InFlight = lockBlock.lastIndexOf("res.status(", inFlightCode - 1);
    expect(realRespB4InFlight).toBeGreaterThan(firstTerminalCheck);
    const pendingRespLoc = lockBlock.indexOf("res.status", pendingStr);
    const runningRespLoc = lockBlock.indexOf("res.status", runningStr);
    expect(pendingRespLoc).toBeGreaterThan(pendingStr);
    expect(runningRespLoc).toBeGreaterThan(runningStr);
    expect(pendingRespLoc).toBeLessThan(inFlightCode);
    expect(runningRespLoc).toBeLessThan(inFlightCode);
    const pendingRespSlice = lockBlock.slice(pendingStr, pendingRespLoc + 300);
    const runningRespSlice = lockBlock.slice(runningStr, runningRespLoc + 300);
    const pendingHasBuildFresh = pendingRespSlice.includes("buildResponseFromFresh");
    const runningHasBuildFresh = runningRespSlice.includes("buildResponseFromFresh");
    expect(pendingHasBuildFresh).toBe(true);
    expect(runningHasBuildFresh).toBe(true);
  });

  it("RACE-L. recoverStale active_job SAME SQL CTE contains status IN (pending,running) + last_heartbeat_at stale check + FOR UPDATE lock", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "recoverStaleDocumentGenerationJob");
    expect(body.length).toBeGreaterThan(200);
    const activeJobStart = body.indexOf("WITH active_job AS (");
    const forUpdateIdx = body.indexOf("FOR UPDATE", activeJobStart);
    expect(activeJobStart).toBeGreaterThan(0);
    expect(forUpdateIdx).toBeGreaterThan(activeJobStart);
    const region = body.slice(activeJobStart, forUpdateIdx + 30);
    expect(region.includes("status IN ('pending','running')")).toBe(true);
    expect(region.includes("last_heartbeat_at IS NULL")).toBe(true);
    expect(region.includes("last_heartbeat_at <")).toBe(true);
    expect(region.includes("::int * interval '1 millisecond'")).toBe(true);
    const secondUpdate = body.indexOf("UPDATE document_generation_job_items i");
    expect(secondUpdate).toBeGreaterThan(activeJobStart);
  });

  it("RACE-M. recoverStale item stale check still guards started_at IS NOT NULL + started_at < stale interval", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "recoverStaleDocumentGenerationJob");
    expect(body.length).toBeGreaterThan(200);
    const activeJobStart = body.indexOf("WITH active_job AS (");
    expect(activeJobStart).toBeGreaterThan(0);
    const itemBlock = body.slice(activeJobStart);
    expect(itemBlock.includes("started_at IS NOT NULL")).toBe(true);
    expect(itemBlock.includes("started_at < now()")).toBe(true);
  });

  it("RESUME-A. finalize lock allowlist contains only pending/running/finalizing (not completed/cwe/gdf/paused/cancelled)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const lockUpdate = body.indexOf("UPDATE document_generation_jobs");
    expect(lockUpdate).toBeGreaterThan(0);
    const lockEnd = body.indexOf("RETURNING id", lockUpdate);
    const region = body.slice(lockUpdate, lockEnd);
    expect(region.includes("status IN ('pending','running','finalizing')")).toBe(true);
    expect(region.includes("'completed'")).toBe(false);
    expect(region.includes("'completed_with_errors'")).toBe(false);
    expect(region.includes("'generated_download_failed'")).toBe(false);
    expect(region.includes("'paused'")).toBe(false);
    expect(region.includes("'cancelled'")).toBe(false);
  });

  it("RESUME-B/C/D. existing finalizing + complete progress resumes packaging (no run_next emitted; paused/cancelled cannot enter packaging)", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const finalizingBranch = body.indexOf('freshAfterLock.status === "finalizing"');
    expect(finalizingBranch).toBeGreaterThan(0);
    const pendingRunningBranch = body.indexOf('freshAfterLock.status === "pending" || freshAfterLock.status === "running"');
    expect(pendingRunningBranch).toBeGreaterThan(finalizingBranch);
    const otherBranchStart = body.indexOf("} else {", pendingRunningBranch);
    expect(otherBranchStart).toBeGreaterThan(pendingRunningBranch);
    const regionFinalizing = body.slice(finalizingBranch, pendingRunningBranch);
    expect(regionFinalizing.includes("finalAction = String((freshAfterLock.row as any).action")).toBe(true);
    const packagingStart = body.indexOf("const finalStatus: string =", otherBranchStart);
    const resumePathEndsInPackaging = packagingStart > finalizingBranch;
    expect(resumePathEndsInPackaging).toBe(true);
    const finalizingRunNext = regionFinalizing.indexOf('nextAction: "run_next"');
    expect(finalizingRunNext).toBe(-1);
    const otherRegion = body.slice(otherBranchStart, packagingStart);
    expect(otherRegion.includes('freshAfterLock.status === "paused"')).toBe(true);
    expect(otherRegion.includes('freshAfterLock.status === "cancelled"')).toBe(true);
    expect(otherRegion.includes("realState = buildResponseFromFresh(freshAfterLock)")).toBe(true);
    expect(otherRegion.indexOf("finalAction = ")).toBe(-1);
  });

  it("RESUME-E. print & zip final status UPDATEs still guarded status='finalizing' RETURNING *", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractRouteBodyByPath(src, '"/documents/jobs/:jobId/finalize"');
    expect(body.length).toBeGreaterThan(1000);
    const finalStatusLine = body.indexOf("const finalStatus: string =");
    expect(finalStatusLine).toBeGreaterThan(0);
    const trailing = body.slice(finalStatusLine, finalStatusLine + 6000);
    const printStmt = trailing.match(
      /UPDATE document_generation_jobs[\s\S]*?WHERE id\s*=\s*\$\{jobId\}[\s\S]*?AND status\s*=\s*'finalizing'[\s\S]*?RETURNING\s+\*/,
    );
    expect(printStmt).not.toBeNull();
    const zipStmt = trailing.match(
      /UPDATE document_generation_jobs[\s\S]*?download_mime_type\s*=\s*'application\/zip'[\s\S]*?WHERE id\s*=\s*\$\{jobId\}[\s\S]*?AND status\s*=\s*'finalizing'[\s\S]*?RETURNING\s+\*/,
    );
    expect(zipStmt).not.toBeNull();
  });

  it("RESUME-F/G/H. recoverStale ONE atomic SQL: active_job + heartbeat + FOR UPDATE + recovered_items UPDATE + final parent UPDATE, no second standalone parent UPDATE; item started_at guard present", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "recoverStaleDocumentGenerationJob");
    expect(body.length).toBeGreaterThan(200);
    const activeJobStart = body.indexOf("WITH active_job AS (");
    const forUpdate = body.indexOf("FOR UPDATE", activeJobStart);
    const recoveredItems = body.indexOf("recovered_items AS (", forUpdate);
    const finalParent = body.indexOf("UPDATE document_generation_jobs j", recoveredItems);
    expect(activeJobStart).toBeGreaterThan(0);
    const firstCTERegion = body.slice(activeJobStart, forUpdate + 30);
    expect(firstCTERegion.includes("status IN ('pending','running')")).toBe(true);
    expect(firstCTERegion.includes("last_heartbeat_at IS NULL")).toBe(true);
    expect(firstCTERegion.includes("last_heartbeat_at <")).toBe(true);
    expect(recoveredItems).toBeGreaterThan(forUpdate);
    const recoveredRegion = body.slice(recoveredItems, finalParent);
    expect(recoveredRegion.includes("UPDATE document_generation_job_items i")).toBe(true);
    expect(recoveredRegion.includes("RETURNING i.id")).toBe(true);
    expect(finalParent).toBeGreaterThan(recoveredItems);
    const finalRegion = body.slice(finalParent, finalParent + 4000);
    expect(finalRegion.includes("FROM active_job a")).toBe(true);
    const pendingCount = body.indexOf("pending_count");
    const countStar = body.indexOf("COUNT(*)");
    expect(pendingCount).toBeGreaterThan(0);
    expect(countStar).toBeGreaterThan(0);
    expect(countStar).toBeGreaterThan(pendingCount);
    const secondStandaloneUpdate = body.indexOf(
      "UPDATE document_generation_jobs",
      finalParent + 50,
    );
    expect(secondStandaloneUpdate).toBe(-1);
    expect(body.indexOf("started_at IS NOT NULL")).toBeGreaterThan(activeJobStart);
  });

  it("RACE-A/B/C/D. parent RETURNING j.id + conditional active runner delete: recoveredJobs.length>0 guard, 0-row race keeps marker, ONE atomic CTE, no second parent UPDATE", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "recoverStaleDocumentGenerationJob");
    expect(body.length).toBeGreaterThan(200);

    const finalParent = body.indexOf("UPDATE document_generation_jobs j");
    expect(finalParent).toBeGreaterThan(0);

    const returningIdx = body.indexOf("RETURNING j.id", finalParent);
    expect(returningIdx).toBeGreaterThan(finalParent);

    const recoveredJobsVar = body.indexOf("const recoveredJobs = await queryRows");
    expect(recoveredJobsVar).toBeGreaterThan(0);
    expect(recoveredJobsVar).toBeLessThan(finalParent);

    const ifCond = body.indexOf("if (recoveredJobs.length > 0) {", returningIdx);
    expect(ifCond).toBeGreaterThan(returningIdx);

    const deleteBlock = body.slice(ifCond, ifCond + 500);
    expect(deleteBlock.includes("activeDocumentGenerationJobRunners.delete(key)")).toBe(true);

    const activeJobCte = body.indexOf("WITH active_job AS (");
    const forUpdate = body.indexOf("FOR UPDATE", activeJobCte);
    const recoveredItems = body.indexOf("recovered_items AS (", forUpdate);
    expect(activeJobCte).toBeGreaterThan(0);
    expect(forUpdate).toBeGreaterThan(activeJobCte);
    expect(recoveredItems).toBeGreaterThan(forUpdate);
    expect(finalParent).toBeGreaterThan(recoveredItems);

    const secondStandaloneUpdate = body.indexOf(
      "UPDATE document_generation_jobs",
      finalParent + 50,
    );
    expect(secondStandaloneUpdate).toBe(-1);

    const uncondDeleteAfter = body.indexOf(
      "activeDocumentGenerationJobRunners.delete(key)",
      ifCond + 400,
    );
    expect(uncondDeleteAfter).toBe(-1);
  });

  it("SCHEMA-A. ensureDocGenJobDownloadObject SELECT uses created_by (DGJ col); ZERO user_id refs", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const body = extractFunctionBodyByName(src, "ensureDocGenJobDownloadObject");
    expect(body.length).toBeGreaterThan(500);
    const selectRegion = body.match(
      /SELECT[\s\S]*?FROM document_generation_jobs[\s\S]*?LIMIT 1/,
    );
    expect(selectRegion).not.toBeNull();
    const selectStr = selectRegion![0];
    expect(selectStr.includes("created_by")).toBe(true);
    expect(selectStr.includes("user_id")).toBe(false);
    expect(body.indexOf("job.user_id")).toBe(-1);
    expect(body.indexOf("job?.user_id")).toBe(-1);
    expect(body.indexOf(")?.user_id")).toBe(-1);
    expect(body.indexOf(`(job as any)?.user_id`)).toBe(-1);
  });
});
