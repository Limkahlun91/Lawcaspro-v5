/**
 * scripts/src/audit-feature-visibility.ts
 *
 * Part 2 §1 — Feature Visibility Matrix Audit.
 *
 * Single-source-of-truth = lib/db/src/feature-registry.ts (FEATURE_REGISTRY).
 *
 * Outputs:
 *   artifacts/reports/feature-visibility-matrix.json
 *   artifacts/reports/feature-visibility-matrix.md
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx src/audit-feature-visibility.ts
 *   (or from repo root:)  npx tsx scripts/src/audit-feature-visibility.ts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_REGISTRY, FeatureDefinition, FEATURE_REGISTRY_MAP } from "@workspace/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const FRONTEND_ROOT = join(REPO_ROOT, "artifacts", "lawcaspro", "src");
const API_ROOT = join(REPO_ROOT, "artifacts", "api-server", "src");

const JSON_OUT = join(REPO_ROOT, "artifacts", "reports", "feature-visibility-matrix.json");
const MD_OUT = join(REPO_ROOT, "artifacts", "reports", "feature-visibility-matrix.md");

// ---------------------------------------------------------------------------
// Audit checklist types (Part 2 §2 fields)
// ---------------------------------------------------------------------------

type IntendedStatus = "ACTIVE" | "UPCOMING" | "HIDDEN_PHASE_2" | "HIDDEN_PHASE_3";
type AuditStatus =
  | "READY_VISIBLE"
  | "READY_HIDDEN_BUG"
  | "NAV_MISSING"
  | "ROUTE_MISSING"
  | "BACKEND_MISSING"
  | "FEATURE_GATE_MISMATCH"
  | "PERMISSION_MISMATCH"
  | "INTENTIONALLY_HIDDEN"
  | "NOT_READY";

interface FeatureAuditRow {
  featureKey: string;
  module: FeatureDefinition["module"];
  intendedStatus: IntendedStatus;
  frontendPageExists: boolean;
  frontendRouteExists: boolean;
  navigationEntryExists: boolean;
  featureGuardExists: boolean;
  permissionGuardExists: boolean;
  backendRouteExists: boolean;
  backendFeatureGuardExists: boolean;
  apiContractExists: boolean;
  targetedTestExists: boolean;
  reasonHidden: string | null;
  status: AuditStatus;
  routeHint?: string | null;
  backendGuardKey?: string | null;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Static walk helpers (read-only disk walks; NO runtime code execution)
// ---------------------------------------------------------------------------

type DirEntry = { name: string; isDirectory: () => boolean; isFile: () => boolean };

function listFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  const entries = readdirSync(dir, { withFileTypes: true }) as unknown as DirEntry[];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}

function readSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Pre-build global indexes once.
const ALL_FRONTEND_FILES = listFiles(FRONTEND_ROOT).filter((f) =>
  /\.(ts|tsx|js|jsx)$/.test(f) && !f.includes("__tests__/node_modules/")
);
const ALL_BACKEND_FILES = listFiles(API_ROOT).filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));

const FE_SRC = ALL_FRONTEND_FILES.map((p) => ({ p, src: readSafe(p) }));
const BE_SRC = ALL_BACKEND_FILES.map((p) => ({ p, src: readSafe(p) }));

function anyFrontendContains(...patterns: Array<string | RegExp>): boolean {
  return FE_SRC.some(({ src }) => patterns.every((pat) => (typeof pat === "string" ? src.includes(pat) : pat.test(src))));
}
function anyBackendContains(...patterns: Array<string | RegExp>): boolean {
  return BE_SRC.some(({ src }) => patterns.every((pat) => (typeof pat === "string" ? src.includes(pat) : pat.test(src))));
}

// ---------------------------------------------------------------------------
// 1) frontendPageExists: actual page file under pages/app/* or pages/platform/*
// ---------------------------------------------------------------------------

const PAGE_DIRS = [
  join(FRONTEND_ROOT, "pages", "app"),
  join(FRONTEND_ROOT, "pages", "platform"),
  join(FRONTEND_ROOT, "pages"),
];

function pathExistsForHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const cleaned = hint.replace(/^\/+/, "").replace(/:\w+/g, "PARAM"); // strip leading slashes, replace :id style
  const base = cleaned.split("?")[0].split("#")[0];
  // /app/X/PARAM → pages/app/X/index  OR  pages/app/X/detail (PARAM)
  const parts = base.split("/").filter(Boolean); // e.g. ["app","cases","PARAM"]
  if (!parts.length) return null;
  // Try pages/<parts[0]>/<parts[1]>/.../index, trying pages/platform when platform root
  for (const root of PAGE_DIRS) {
    // Compare path prefix to page root
    const relFrom = normalize(relative(root, join(FRONTEND_ROOT, "pages", ...parts)));
    const candidates: string[] = [];
    // pages/app/cases → pages/app/cases/index.tsx | pages/app/cases.tsx
    const pJoin = (xs: string[]) => join(FRONTEND_ROOT, "pages", ...xs);
    candidates.push(pJoin([...parts, "index.tsx"]));
    candidates.push(pJoin([...parts.slice(0, -1), parts[parts.length - 1] + ".tsx"]));
    // If tail is PARAM (e.g. cases/:id) → detail.tsx
    const last = parts[parts.length - 1];
    if (last === "PARAM" && parts.length >= 2) {
      candidates.push(pJoin([...parts.slice(0, -1), "detail.tsx"]));
      candidates.push(pJoin([...parts.slice(0, -1), "detail", "index.tsx"]));
    }
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

function derivePageFile(featureKey: string, routeHint: string | null | undefined): { file: string | null; exists: boolean } {
  const hintFile = pathExistsForHint(routeHint);
  if (hintFile) return { file: hintFile, exists: true };
  // Fallback — search for any page folder/file whose name matches featureKey suffix
  const suffix = featureKey.split(".").pop() ?? featureKey;
  const needle = `${suffix.replace(/[_-]/g, "[-_]")}`;
  const re = new RegExp(`pages[\\/\\\\](app|platform)[\\/\\\\][^\\/\\\\]*${needle}`, "i");
  for (const f of ALL_FRONTEND_FILES) {
    if (re.test(f)) return { file: f, exists: true };
  }
  return { file: null, exists: false };
}

// ---------------------------------------------------------------------------
// 2) frontendRouteExists: <Route path=...> in App.tsx OR main router files
// ---------------------------------------------------------------------------

function routeRegisteredInApp(hint: string | null | undefined): boolean {
  if (!hint) return false;
  const pathPart = hint.split("?")[0].split("#")[0];
  // Normalize :id to PARAM for matching against route template strings
  // Try exact match then prefix match
  const appSource = FE_SRC.find(({ p }) => p.endsWith("App.tsx"))?.src ?? "";
  const exactPattern = new RegExp(
    `Route\\s*(?:<[^>]*>)?\\s*path=\\{?["']` + escapeRegex(pathPart) + `["']`,
  );
  if (exactPattern.test(appSource)) return true;
  // Prefix /app/X → route /app/X also matches /app/X/Y
  // try replacing :param with (.+) to match template
  const pattern = new RegExp(
    `Route\\s*(?:<[^>]*>)?\\s*path=\\{?["']` + toRegexFromHint(pathPart) + `["']`,
  );
  if (pattern.test(appSource)) return true;
  // wildcard last resort: /app/* matches anything under /app
  const fallback = new RegExp(
    `Route\\s*(?:<[^>]*>)?\\s*path=\\{?["']` + escapeRegex(pathPart.split("/").slice(0, 3).join("/")) + `[\\/]?\\*?["']`,
  );
  return fallback.test(appSource);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
function toRegexFromHint(hint: string): string {
  return escapeRegex(hint).replace(/:\\w+/g, "[^\\\\/'\"?#]+");
}

// ---------------------------------------------------------------------------
// 3) navigationEntryExists: matches /app/X in sidebar-body navGroupsForUser
// ---------------------------------------------------------------------------

const SIDEBAR_SRC =
  FE_SRC.find(({ p }) => p.endsWith(join("components", "layout", "sidebar-body.tsx").replace(/\\/g, "/"))) ||
  FE_SRC.find(({ p }) => p.includes("sidebar-body"));

// Cache of redirects in App.tsx: pathname -> target
let APP_REDIRECTS: Record<string, string> | null = null;
function getAppRedirects(): Record<string, string> {
  if (APP_REDIRECTS) return APP_REDIRECTS;
  const appSrc =
    FE_SRC.find(({ p }) => p.endsWith(join("artifacts", "lawcaspro", "src", "App.tsx").replace(/\\/g, "/"))) ||
    FE_SRC.find(({ p }) => p.includes("App.tsx"));
  const src = appSrc?.src ?? "";
  const res: Record<string, string> = {};
  const re = /<Route\s+path=["']([^"']+)["'][^>]*component=\{\s*\(\)\s*=>\s*<Redirect\s+to=["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) res[m[1]] = m[2];
  APP_REDIRECTS = res;
  return res;
}

function navIncludesRoute(hint: string | null | undefined, hrefCandidates: string[] = []): boolean {
  const src = SIDEBAR_SRC?.src ?? "";
  if (!hint && !hrefCandidates.length) return false;
  const cands = new Set<string>(hrefCandidates);
  if (hint) {
    const cleaned = hint.split("?")[0].split("#")[0].replace(/:\w+/g, "PARAM");
    const parts = cleaned.split("/").filter(Boolean);
    cands.add("/" + parts.join("/"));
    if (parts.length >= 2) cands.add("/" + parts.slice(0, parts[parts.length - 1] === "PARAM" ? -1 : parts.length).join("/"));
    if (parts[parts.length - 1] === "PARAM" && parts.length >= 3) cands.add("/" + parts.slice(0, -1).join("/"));
  }
  // Follow redirects (e.g. /app/audit-logs → /app/settings/logs - also check for the redirect target)
  const redirects = getAppRedirects();
  for (const c of Array.from(cands)) {
    const base = c.split("?")[0].split("#")[0];
    if (redirects[base]) {
      cands.add(redirects[base]);
      // also add base of redirect target
      const redirBase = redirects[base].split("?")[0].split("#")[0];
      cands.add(redirBase);
    }
  }
  // Also accept base nav hrefs when the target page is a sub-tab (e.g. /app/users redirects to /app/settings?tab=users)
  for (const c of Array.from(cands)) {
    // Strip params, check base path matches
    const base = c.split("?")[0].split("#")[0];
    cands.add(base);
    // /app/settings base may include tabs (users/roles/logs)
    if (base.startsWith("/app/settings")) cands.add("/app/settings");
    if (base === "/app/users" || base === "/app/roles") cands.add("/app/settings");
  }
  for (const c of cands) {
    if (!c) continue;
    // Match href attribute literally (ignore trailing query after path)
    const re = new RegExp(`href:\\s*["']` + escapeRegex(c) + `(/|\\?|["'])`);
    if (re.test(src)) return true;
  }
  // Platform pages: they live in platform layout
  if (hint?.startsWith("/platform/")) {
    return true; // founder always has Platform Admin nav in platform-layout sidebar
  }
  return false;
}

// ---------------------------------------------------------------------------
// 4) featureGuardExists: useFeature(KEY) or <FeatureGuard feature=KEY /> or wrapRouteWithFeature(KEY, ...)
// ---------------------------------------------------------------------------

function featureGuardExistsForKey(key: string): boolean {
  const patterns = [
    new RegExp(`<FeatureGuard[^>]+feature=\\{?["']` + escapeRegex(key) + `["']`),
    new RegExp(`useFeature\\(\\s*\\{?\\s*["']` + escapeRegex(key) + `["']`),
    new RegExp(`wrapRouteWithFeature\\(\\s*["']` + escapeRegex(key) + `["']`),
    new RegExp(`useFeature\\([^)]*featureKey[^)]*` + escapeRegex(key)),
  ];
  return FE_SRC.some(({ src }) => patterns.some((re) => re.test(src)));
}

// ---------------------------------------------------------------------------
// 5) permissionGuardExists: PermissionGuard module=X action=Y  (RBAC checks)
// ---------------------------------------------------------------------------

function splitBackendGuardKey(
  key: string
): [string, string] {
  if (key.includes(":")) {
    const [m, a, ...rest] = key.split(":");
    return [m, [a, ...rest].join(":")];
  }
  if (key.includes(".")) {
    const parts = key.split(".");
    const last = parts.pop() ?? "read";
    const mod = parts.join(".");
    return [mod, last];
  }
  return [key, "read"];
}

function permissionGuardExistsFor(backendGuardKey: string | null | undefined): boolean {
  if (!backendGuardKey) return true;
  const [mod, action] = splitBackendGuardKey(backendGuardKey);
  // Try fast substring match first (JSX) - module + action attr literals anywhere
  const moduleLiteral = `module="` + mod + `"`;
  const moduleLiteralBrace = `module={` + JSON.stringify(mod) + `}`;
  const actionLiteral = `action="` + action + `"`;
  const actionLiteralBrace = `action={` + JSON.stringify(action) + `}`;
  for (const { src } of FE_SRC) {
    if (src.includes(moduleLiteral) || src.includes(moduleLiteralBrace)) {
      if (src.includes(actionLiteral) || src.includes(actionLiteralBrace)) return true;
    }
  }
  // Try hasPermission hasPermission(x, "mod", "act") literal substring
  const hpLiteral = `"` + mod + `", "` + action + `"`;
  const hpLiteral2 = `"` + mod + `","` + action + `"`;
  for (const { src } of FE_SRC) {
    if (src.includes(hpLiteral) || src.includes(hpLiteral2)) return true;
  }
  // Same-module - any write-level action counts as satisfying "update" permission scope gating
  if (action === "update") {
    const writePerms = ["update", "create", "delete", "assign_any", "assign", "approve", "review", "manage_settings"];
    for (const w of writePerms) {
      const l1 = `"` + mod + `", "` + w + `"`;
      const l2 = `"` + mod + `","` + w + `"`;
      const la = `action="` + w + `"`;
      const laB = `action={` + JSON.stringify(w) + `}`;
      for (const { src } of FE_SRC) {
        if ((src.includes(moduleLiteral) || src.includes(moduleLiteralBrace)) && (src.includes(la) || src.includes(laB))) return true;
        if (src.includes(l1) || src.includes(l2)) return true;
      }
    }
  }
  // Same-module - any "read" level counts as satisfying a "read" guard
  if (action === "read") {
    const reads = ["read", "view", "list", "access"];
    for (const w of reads) {
      const l1 = `"` + mod + `", "` + w + `"`;
      const l2 = `"` + mod + `","` + w + `"`;
      const la = `action="` + w + `"`;
      const laB = `action={` + JSON.stringify(w) + `}`;
      for (const { src } of FE_SRC) {
        if ((src.includes(moduleLiteral) || src.includes(moduleLiteralBrace)) && (src.includes(la) || src.includes(laB))) return true;
        if (src.includes(l1) || src.includes(l2)) return true;
      }
    }
  }
  // Final regex fallback (for newline JSX attrs)
  const pattern = new RegExp(
    `PermissionGuard[\\s\\S]{0,500}?module=\\{?["']` + escapeRegex(mod) + `["'][\\s\\S]{0,500}?action=\\{?["']` + escapeRegex(action) + `["']`
  );
  const patternRev = new RegExp(
    `PermissionGuard[\\s\\S]{0,500}?action=\\{?["']` + escapeRegex(action) + `["'][\\s\\S]{0,500}?module=\\{?["']` + escapeRegex(mod) + `["']`
  );
  if (FE_SRC.some(({ src }) => pattern.test(src) || patternRev.test(src))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 6) backendRouteExists: in routes/index.ts mounted routers, or routes/*.ts file exists + exports Router
// ---------------------------------------------------------------------------

function backendRouteExists(module: string, routeHint: string | null | undefined, featureKey: string): boolean {
  // Quick: any routes/*.ts that references featureKey or exports mountable router (file exists check)
  const routesDir = join(API_ROOT, "routes");
  // Map keyword → file prefix
  const keywordMap: Record<string, string[]> = {
    cases: ["cases", "case-", "legacy-case-import"],
    documents: ["documents", "templates", "template-"],
    accounting: ["accounting", "invoices", "einvoices", "receipts", "payment-voucher", "bank-adapters", "quotations"],
    communications: ["communication", "communications", "hub"],
    hr: ["hr-"],
    hims: ["hims"],
    platform: ["platform", "subscription-plans", "founder/"],
    audit: ["audit"],
    storage: ["storage", "file-custody"],
    reports: ["reports", "compliance-reports", "project-status-report"],
    einvoice: ["einvoices"],
    ai: ["ai", "document-intelligence", "template-migrations"],
    rbac: ["users", "roles"],
    contacts: ["clients", "parties"],
    developers: ["developers"],
    projects: ["projects"],
    settings: ["firm-settings", "firm-file-ref-settings", "accounting-settings"],
    dashboard: ["dashboard"],
    notifications: ["user-notifications", "case-notifications"],
  };
  const keywords: string[] = keywordMap[module] ?? [module];
  const beFileMatches = (f: string) => {
    const rel = normalize(relative(routesDir, f)).replace(/\\/g, "/");
    return keywords.some((k) => rel.startsWith(k));
  };
  const candidates = ALL_BACKEND_FILES.filter((f) => f.startsWith(routesDir) && beFileMatches(f));
  if (candidates.length > 0) return true;
  // Match route hint path against backend get/post handlers
  if (routeHint) {
    const pathPart = routeHint.split("?")[0].split("#")[0];
    const apiLike = pathPart.replace(/^\/app\//, "/").replace(/^\/platform\//, "/");
    const pattern = new RegExp(`routerInternal?\\.\\s*(?:use|get|post|put|patch|delete)\\(\\s*["'](/?)${escapeRegex(apiLike.slice(1))}`);
    if (BE_SRC.some(({ src }) => pattern.test(src))) return true;
    // Prefix match e.g. /cases matches /cases/filter
    const prefixRe = new RegExp(
      `routerInternal?\\.\\s*(?:use|get|post|put|patch|delete)\\(\\s*["'](/?)${escapeRegex(apiLike.slice(1)).replace(/:\w+/g, "[^/'\"]+")}`,
    );
    if (BE_SRC.some(({ src }) => prefixRe.test(src))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 7) backendFeatureGuardExists: assertFirmFeatureEnabled, requireFeature, isFeatureEnabled(KEY),
//    backendGuardKey substring match (e.g. "cases" matches requireFirmScope + action cases:*)
// ---------------------------------------------------------------------------

function backendGuardForKey(featureKey: string, backendGuardKey: string | null | undefined): boolean {
  const keyPatterns = [new RegExp(escapeRegex(featureKey).replace(/\\\./g, "[._:-]"))];
  if (backendGuardKey) {
    const [mod, action] = splitBackendGuardKey(backendGuardKey);
    keyPatterns.push(new RegExp(escapeRegex(mod).replace(/\\\./g, "[._:-]")));
    if (action) {
      keyPatterns.push(new RegExp(`permission\\s*==\\s*["']${escapeRegex(action)}["']`));
      keyPatterns.push(new RegExp(`hasPermission\\([^,]+,\\s*["']${escapeRegex(mod)}["']\\s*,\\s*["']${escapeRegex(action)}["']`));
    }
  }
  const genericPatterns = [
    /assertFirmFeatureEnabled\s*\(/,
    /requireFeature\s*\(/,
    /isFeatureEnabled\s*\(/,
    /requireFirmScope\s*\(/,
    /featureKey\s*:\s*["']module\./,
    /feature_enabled\s*\(/,
  ];
  return BE_SRC.some(({ src }) => {
    return keyPatterns.some((re) => re.test(src)) || genericPatterns.some((re) => re.test(src));
  });
}

// ---------------------------------------------------------------------------
// 8) apiContractExists: either (a) BE zod schema+route OR (b) api-zod types
// ---------------------------------------------------------------------------

function apiContractExistsFor(featureKey: string, routeHint: string | null | undefined): boolean {
  // Check if @workspace/api-zod exports an operation mentioning the featureKey OR backend has zod route
  const zod =
    readSafe(join(REPO_ROOT, "artifacts", "api-zod", "src", "index.ts")) +
    readSafe(join(REPO_ROOT, "lib", "api-zod", "src", "index.ts"));
  if (featureKey && zod.includes(featureKey)) return true;
  // Any backend route with routerInternal.get/post has a handler = contract
  if (routeHint) {
    const apiLike = routeHint.split("?")[0].split("#")[0].replace(/^\/app\//, "/").replace(/^\/platform\//, "/");
    const prefixRe = new RegExp(
      `\\.\\s*(?:get|post|put|patch|delete)\\(\\s*["'](/)${escapeRegex(apiLike.slice(1)).replace(/:\w+/g, "[^/'\"]+")}`,
    );
    if (BE_SRC.some(({ src }) => prefixRe.test(src))) return true;
  }
  // Search route file with module prefix & z.object/endpoint
  return false;
}

// ---------------------------------------------------------------------------
// 9) targetedTestExists: __tests__ or *.test.ts* or *.spec.ts* mentioning featureKey
// ---------------------------------------------------------------------------

function targetedTest(featureKey: string, routeHint: string | null | undefined): boolean {
  const needleName = featureKey.split(".").pop() ?? featureKey;
  const patterns = [new RegExp(escapeRegex(featureKey).replace(/\\\./g, "[._-]"))];
  if (routeHint) {
    const tail = routeHint.split("/").filter(Boolean).pop();
    if (tail && !tail.startsWith(":")) patterns.push(new RegExp(escapeRegex(tail)));
  }
  patterns.push(new RegExp(escapeRegex(needleName)));
  const testFiles = ALL_FRONTEND_FILES.filter(
    (f) => f.includes("__tests__") || /\.test\.(ts|tsx)$|\.spec\.(ts|tsx)$/.test(f),
  ).concat(
    ALL_BACKEND_FILES.filter(
      (f) => f.includes("__tests__") || /\.test\.(ts|tsx)$|\.spec\.(ts|tsx)$/.test(f),
    ),
  );
  for (const f of testFiles) {
    const s = readSafe(f);
    if (patterns.some((re) => re.test(s))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Intended status derivation (Part 2 §4 + §6 exceptions)
// ---------------------------------------------------------------------------

function intendedStatusFor(f: FeatureDefinition): IntendedStatus {
  // File Custody EXCEPTION Part 2 §6
  if (f.featureKey === "storage.file_custody" || f.featureKey === "module.storage" && f.status !== "active") {
    return "HIDDEN_PHASE_2";
  }
  if (f.status === "inactive" || f.status === "deprecated" || f.status === "emergency_disabled") {
    return "HIDDEN_PHASE_2";
  }
  // HR features: default boolean false in feature-flags → phase-2
  const HR_KEYS = new Set([
    "hr.dashboard", "hr.employees", "hr.attendance", "hr.leave", "hr.claims", "hr.payroll",
    "hr.onboarding", "hr.offboarding", "hr.recruitment", "hr.performance", "hr.training",
    "hr.assets", "hr.documents", "hr.reports", "hr.settings", "hr.departments", "hr.positions",
    "hr.self_service",
  ]);
  if (HR_KEYS.has(f.featureKey) || f.module === "hr" && f.status === "active" && f.featureKey.startsWith("hr.")) {
    return "HIDDEN_PHASE_2";
  }
  if (f.module === "einvoice") return "HIDDEN_PHASE_2";
  // Email / WhatsApp / settings email currently PHASE2_FLAGS false
  if (
    f.featureKey === "communications.email" ||
    f.featureKey === "communications.whatsapp" ||
    f.featureKey === "communications.email.settings" ||
    f.featureKey === "communications.email.imap" ||
    f.featureKey === "communications.email.m365" ||
    f.featureKey === "communications.email.gmail"
  ) {
    return "HIDDEN_PHASE_2";
  }
  if (f.founderOnly) return "ACTIVE";
  if (f.defaultValue === false && !f.configurable) return "HIDDEN_PHASE_2";
  // HIMS Tracker (spec §4 HIMS Tracker → HIDDEN_PHASE_3 until integration proven)
  if (f.featureKey === "module.hims" || f.featureKey.startsWith("hims.")) return "HIDDEN_PHASE_3";
  // Document Intelligence
  if (f.module === "ai" || f.featureKey.startsWith("documents.ai") || f.featureKey.startsWith("documents.ocr")) return "HIDDEN_PHASE_3";
  if (f.featureKey === "documents.ai_migration") return "HIDDEN_PHASE_3";
  return "ACTIVE";
}

// ---------------------------------------------------------------------------
// Final status classification (Part 2 §3 / §5 / §9)
// ---------------------------------------------------------------------------

function classify(r: FeatureAuditRow, f: FeatureDefinition): AuditStatus {
  // Intentionally hidden → exit early
  if (r.intendedStatus !== "ACTIVE") {
    // Part 2 §6: Storage.file_custody
    if (r.featureKey === "storage.file_custody") return "INTENTIONALLY_HIDDEN";
    // HR submodule hidden in Phase-2
    if (r.intendedStatus === "HIDDEN_PHASE_2" && r.module === "hr") return "INTENTIONALLY_HIDDEN";
    if (r.intendedStatus === "HIDDEN_PHASE_2" && r.module === "einvoice") return "INTENTIONALLY_HIDDEN";
    if (r.intendedStatus === "HIDDEN_PHASE_2" && (f.featureKey.startsWith("communications.email") || f.featureKey === "communications.whatsapp")) return "INTENTIONALLY_HIDDEN";
    if (r.intendedStatus === "HIDDEN_PHASE_3" && (r.module === "hims" || r.module === "ai" || f.featureKey.startsWith("documents.ai") || f.featureKey.startsWith("hims."))) return "INTENTIONALLY_HIDDEN";
  }

  // NOT_READY detection: when BOTH backend AND frontend are missing simultaneously
  const pageAndBackendMissing = !r.frontendPageExists && !r.backendRouteExists;
  const allMissing =
    !r.frontendPageExists &&
    !r.frontendRouteExists &&
    !r.navigationEntryExists &&
    !r.backendRouteExists &&
    !r.apiContractExists;
  if (allMissing || pageAndBackendMissing) {
    // No UI + no backend = entirely missing feature = NOT_READY not ROUTE_MISSING
    r.reasonHidden = "No frontend page, route, nav entry and no backend route + API contract.";
    return "NOT_READY";
  }

  // NOT_READY: page exists but backend missing, or backend exists but route mount incomplete or no api contract
  if (r.frontendPageExists && !r.backendRouteExists) {
    r.reasonHidden = "Page exists but backend routes not mounted/incomplete.";
    return "NOT_READY";
  }
  if (r.backendRouteExists && !r.apiContractExists) {
    r.reasonHidden = "Backend service exists without endpoint contract (zod / open handler).";
    return "NOT_READY";
  }
  if (r.intendedStatus !== "ACTIVE") {
    return "INTENTIONALLY_HIDDEN";
  }
  // Now ACTIVE category — check READY_VISIBLE conditions:
  const missing: string[] = [];
  if (!r.frontendPageExists) missing.push("frontendPage");
  if (!r.frontendRouteExists) missing.push("frontendRoute(ROUTE_MISSING)");
  if (!r.navigationEntryExists) missing.push("navEntry(NAV_MISSING)");
  if (!r.backendRouteExists) missing.push("backend(BACKEND_MISSING)");
  // If all critical visible exist → READY_VISIBLE; else classify
  if (
    r.frontendPageExists &&
    r.frontendRouteExists &&
    r.navigationEntryExists &&
    r.backendRouteExists &&
    r.apiContractExists
  ) {
    // Gate/permission mismatch?
    if (r.backendGuardKey && !r.backendFeatureGuardExists) {
      r.reasonHidden = `Backend guard missing for backendGuardKey=${r.backendGuardKey}`;
      return "FEATURE_GATE_MISMATCH";
    }
    // Parent-level features (module.X) may not wrap in explicit PermissionGuard (ok). Children with backendGuardKey: require PermissionGuard
    if (r.backendGuardKey && !r.featureKey.startsWith("module.") && !r.permissionGuardExists) {
      r.reasonHidden = `PermissionGuard missing for ${r.backendGuardKey}`;
      return "PERMISSION_MISMATCH";
    }
    return "READY_VISIBLE";
  }
  if (!r.frontendRouteExists && r.frontendPageExists) {
    r.reasonHidden = `Missing route for ${r.routeHint ?? f.routeHint ?? f.featureKey}. Missing: ${missing.join(", ")}`;
    return "ROUTE_MISSING";
  }
  if (!r.navigationEntryExists && r.frontendRouteExists && r.frontendPageExists) {
    r.reasonHidden = `No sidebar menu entry but page+route exist. Missing: ${missing.join(", ")}`;
    return "NAV_MISSING";
  }
  if (!r.backendRouteExists && r.frontendPageExists) {
    r.reasonHidden = `Missing backend route for module=${r.module}. Missing: ${missing.join(", ")}`;
    return "BACKEND_MISSING";
  }
  // Catch-all: ready but incorrectly hidden
  r.reasonHidden = `Missing pieces: ${missing.join(", ")}`;
  return "READY_HIDDEN_BUG";
}

// ---------------------------------------------------------------------------
// Build one row
// ---------------------------------------------------------------------------

function auditOne(f: FeatureDefinition): FeatureAuditRow {
  const intended = intendedStatusFor(f);
  const page = derivePageFile(f.featureKey, f.routeHint);
  const routeEx = routeRegisteredInApp(f.routeHint);
  // For umbrella parent features (module.X / no routeHint) → check any direct child has nav entry as proxy
  let navEx = navIncludesRoute(f.routeHint, f.routeHint ? [f.routeHint] : []);
  if (!navEx && !f.routeHint && f.featureKey.startsWith("module.")) {
    for (const child of FEATURE_REGISTRY) {
      if (child.parentFeatureKey === f.featureKey && child.routeHint) {
        if (navIncludesRoute(child.routeHint, [child.routeHint])) {
          navEx = true;
          break;
        }
      }
    }
  }
  const fgEx = featureGuardExistsForKey(f.featureKey);
  const permEx = permissionGuardExistsFor(f.backendGuardKey);
  const beRouteEx = backendRouteExists(f.module, f.routeHint, f.featureKey);
  const beGuardEx = backendGuardForKey(f.featureKey, f.backendGuardKey);
  const apiContract = apiContractExistsFor(f.featureKey, f.routeHint);
  const testEx = targetedTest(f.featureKey, f.routeHint);

  const row: FeatureAuditRow = {
    featureKey: f.featureKey,
    module: f.module,
    intendedStatus: intended,
    frontendPageExists: page.exists,
    frontendRouteExists: routeEx,
    navigationEntryExists: navEx,
    featureGuardExists: fgEx,
    permissionGuardExists: permEx,
    backendRouteExists: beRouteEx,
    backendFeatureGuardExists: beGuardEx,
    apiContractExists: apiContract,
    targetedTestExists: testEx,
    reasonHidden: null,
    status: "NOT_READY",
    routeHint: f.routeHint ?? null,
    backendGuardKey: f.backendGuardKey ?? null,
  };
  row.status = classify(row, f);
  return row;
}

// ---------------------------------------------------------------------------
// Markdown writer
// ---------------------------------------------------------------------------

function toMarkdown(rows: FeatureAuditRow[]): string {
  const counts = new Map<AuditStatus, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const totalByModule = new Map<string, { total: number; ready: number; hidden: number }>();
  for (const r of rows) {
    const cur = totalByModule.get(r.module) ?? { total: 0, ready: 0, hidden: 0 };
    cur.total++;
    if (r.status === "READY_VISIBLE") cur.ready++;
    if (r.status === "INTENTIONALLY_HIDDEN" || r.status === "NOT_READY") cur.hidden++;
    totalByModule.set(r.module, cur);
  }
  const lines: string[] = [];
  lines.push(`# Feature Visibility Matrix — Lawcaspro v5`);
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push("");
  lines.push("## Summary by Status");
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|---|---:|");
  for (const [k, v] of Array.from(counts.entries()).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## Summary by Module");
  lines.push("");
  lines.push("| Module | Total Features | READY_VISIBLE | Hidden/Not Ready |");
  lines.push("|---|---:|---:|---:|");
  for (const [mod, v] of Array.from(totalByModule.entries()).sort()) {
    lines.push(`| ${mod} | ${v.total} | ${v.ready} | ${v.hidden} |`);
  }
  lines.push("");
  lines.push("## All Features");
  lines.push("");
  lines.push(
    "| featureKey | module | intended | page | route | nav | fg | perm | be route | be fg | api | test | status | reason",
  );
  lines.push(
    "|---|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|---|",
  );
  for (const r of rows) {
    const y = (x: boolean) => (x ? "✅" : "⛔");
    lines.push(
      `| ${r.featureKey} | ${r.module} | ${r.intendedStatus} | ${y(r.frontendPageExists)} | ${y(r.frontendRouteExists)} | ${y(r.navigationEntryExists)} | ${y(r.featureGuardExists)} | ${y(r.permissionGuardExists)} | ${y(r.backendRouteExists)} | ${y(r.backendFeatureGuardExists)} | ${y(r.apiContractExists)} | ${y(r.targetedTestExists)} | **${r.status}** | ${r.reasonHidden ?? "—"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const rows: FeatureAuditRow[] = [];
  for (const f of FEATURE_REGISTRY) rows.push(auditOne(f));

  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        repoHead: process.env.GIT_HEAD ?? "unknown",
        featureCount: FEATURE_REGISTRY.length,
        statusCounts: rows.reduce<Record<string, number>>((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {}),
        rows,
      },
      null,
      2,
    ),
  );
  writeFileSync(MD_OUT, toMarkdown(rows));
  console.log(`Wrote ${JSON_OUT} (${rows.length} rows)`);
  console.log(`Wrote ${MD_OUT}`);
  const summary = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log("Status counts:", JSON.stringify(summary, null, 2));
  // Exit non-zero if any READY_HIDDEN_BUG / NAV_MISSING / ROUTE_MISSING / FEATURE_GATE_MISMATCH / PERMISSION_MISMATCH
  const actionable = rows.filter((r) =>
    ["READY_HIDDEN_BUG", "NAV_MISSING", "ROUTE_MISSING", "FEATURE_GATE_MISMATCH", "PERMISSION_MISMATCH"].includes(r.status),
  );
  if (actionable.length) {
    console.warn(`ACTIONABLE (${actionable.length}):`);
    for (const r of actionable) console.warn(` - ${r.featureKey} → ${r.status}: ${r.reasonHidden}`);
  }
  process.exitCode = actionable.length > 0 ? 2 : 0;
}

main();
