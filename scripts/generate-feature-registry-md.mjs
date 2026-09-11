// Generate LAWCASEPRO_FEATURE_REGISTRY.md from the CANONICAL TypeScript
// FEATURE_REGISTRY array defined in lib/db/src/feature-registry.ts.
//
// Source of truth (per Part 2 architecture):
//   1. FEATURE_REGISTRY (TypeScript) = developer-maintained canonical list.
//   2. DB platform_features table = persisted runtime mirror of the registry.
//   3. Migrations (0150_full_feature_registry_reseed.sql +
//      p6_entitlement_runtime_foundation.sql) = historical + forward DB
//      population / idempotent reseed. They DO NOT auto-execute at startup.
//   4. No automatic registry sync happens at startup — migrations are the
//      delivery mechanism to keep DB mirror in sync with TS.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Repo-relative path resolution (no absolute / machine-specific paths)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const REGISTRY_MODULE_URL = pathToFileURL(
  join(REPO_ROOT, "lib/db/dist/feature-registry.js"),
).href;

const OUTPUT_PATH = join(REPO_ROOT, "LAWCASEPRO_FEATURE_REGISTRY.md");

// Load compiled registry JS (dist must be present — root typecheck builds it).
const mod = await import(REGISTRY_MODULE_URL);
const FEATURE_REGISTRY = mod.FEATURE_REGISTRY;
if (!Array.isArray(FEATURE_REGISTRY) || FEATURE_REGISTRY.length === 0) {
  throw new Error(
    `FEATURE_REGISTRY not loadable from ${REGISTRY_MODULE_URL}. ` +
      `Run 'pnpm -C lib/db run build' first.`,
  );
}

const rows = FEATURE_REGISTRY.map((f) => ({
  featureKey: f.featureKey,
  name: f.name ?? "",
  module: f.module ?? "",
  parent: f.parentFeatureKey ?? "",
  valueType: f.valueType ?? "boolean",
  configurable: f.configurable === false ? "no" : "yes",
  founderOnly: f.founderOnly === true ? "yes" : "no",
  dependencies: Array.isArray(f.dependencies) ? [...f.dependencies] : [],
  routeHint: f.routeHint ?? "",
  status: f.status ?? "active",
  description: f.description ?? "",
}));

const byModule = new Map();
for (const r of rows) {
  if (!byModule.has(r.module)) byModule.set(r.module, []);
  byModule.get(r.module).push(r);
}
const modules = [...byModule.keys()].sort();
const total = rows.length;

const rel = (repoRelativePath) => {
  // Repository-relative markdown links only. No file:// URLs; no absolute machine paths.
  // Works in GitHub / IDE viewers that understand relative paths in repo context.
  return `[${repoRelativePath}](${repoRelativePath})`;
};

let md = "# Lawcaspro Global Feature Registry\n\n";
md += "> Inventory generated from the **canonical TypeScript `FEATURE_REGISTRY`** " +
  "array in " + rel("lib/db/src/feature-registry.ts") + ".\n\n";
md += "## Architecture & Source of Truth\n\n";
md += "- **Developer source of truth:** TypeScript `FEATURE_REGISTRY` array " +
  "(" + rel("lib/db/src/feature-registry.ts") + ").\n";
md += "- **Runtime mirror:** `platform_features` DB table + Drizzle schema " +
  "(" + rel("lib/db/src/schema/platform-entitlements.ts") + ").\n";
md += "- **Historical/DB population (0150):** Lib/DB reseed migration — " +
  rel("lib/db/migrations/0150_full_feature_registry_reseed.sql") + ".\n";
md += "- **Forward/Preview DB foundation (p6):** Supabase idempotent seed — " +
  rel("supabase/migrations/p6_entitlement_runtime_foundation.sql") + ".\n";
md += "- **No automatic startup registry sync:** migrations are the delivery " +
  "mechanism. Nothing compares / rewrites `platform_features` at boot " +
  "(DENY BY DEFAULT on unknown keys catches drift).\n\n";

md += "## Principles (Part 2)\n\n";
md += "- Unknown / unregistered configurable feature = **DENY BY DEFAULT** (§11)\n";
md += "- Parent OFF → every child feature Effective = OFF at runtime merge " +
  "without mutating stored override rows (§3).\n";
md += "- Dependency array auto-walked with cycle detection (§12)\n";
md += "- RBAC permissions evaluated AFTER entitlements layer (§7)\n";
md += "- Emergency kill switches at global + firm-specific level (§9)\n";
md += "- Cache invalidation immediate on Founder override change (§8)\n\n";

md += `**Inventory:** ${modules.length} modules · ${total} features total\n\n`;

md += "## Per-Module Counts\n\n";
md += "| Module | Count |\n|---|---:|\n";
for (const m of modules) md += `| \`${m}\` | ${byModule.get(m).length} |\n`;
md += "\n";

md += "## Full Feature Inventory\n\n";
md += "| feature key | name | parent | module | dependencies | route | value_type | configurable | founder_only | status |\n";
md += "|---|---|---|---|---|---|---|---|---|---|\n";

for (const r of rows) {
  const keyCell = `\`${r.featureKey}\``;
  const nameCell = String(r.name).replaceAll("|", "\\|");
  const parentCell = r.parent ? `\`${r.parent}\`` : "";
  const depCell = r.dependencies.length ? r.dependencies.map((d) => `\`${d}\``).join(", ") : "";
  const routeCell = r.routeHint ? `\`${r.routeHint}\`` : "";
  md += `| ${keyCell} | ${nameCell} | ${parentCell} | ${r.module} | ${depCell} | ${routeCell} | ${r.valueType} | ${r.configurable} | ${r.founderOnly} | ${r.status} |\n`;
}
md += "\n";

md += "## Implementation Locations\n\n";
md += "| Layer | Component | File |\n|---|---|---|\n";
md += `| Registry code (canonical) | FEATURE_REGISTRY + helpers | ${rel("lib/db/src/feature-registry.ts")} |\n`;
md += "| Schema | platform_features, plan_entitlements, firm_entitlement_overrides | " +
  rel("lib/db/src/schema/platform-entitlements.ts") + " |\n";
md += "| Migration — lib/db reseed  | 0150 historical snapshot | " +
  rel("lib/db/migrations/0150_full_feature_registry_reseed.sql") + " |\n";
md += "| Migration — Supabase foundation + all 238 keys | p6 idempotent platform seed | " +
  rel("supabase/migrations/p6_entitlement_runtime_foundation.sql") + " |\n";
md += "| Resolver | 9-layer merge + parent/dependency chain + cache + dirty epochs | " +
  rel("artifacts/api-server/src/services/entitlement-resolver.ts") + " |\n";
md += "| Backend middleware | requireFirmFeature(featureKey) wrapped per module | " +
  rel("artifacts/api-server/src/routes/index.ts") + " barrel + individual endpoint guards |\n";
md += "| REST endpoints | overrides, bulk, emergency, registry JSON endpoints | " +
  rel("artifacts/api-server/src/routes/entitlements.ts") + " |\n";
md += "| Job/worker guard | canFirmRunJobsFor / filterFirmsForJob | entitlement-resolver + cron/scheduler loop sites |\n";
md += "| Billing ledger | append-only + trigger protection | " +
  rel("artifacts/api-server/src/services/billing-ledger.ts") + " |\n";
md += "| Usage metering | atomic bump per firm × metric × period | " +
  rel("artifacts/api-server/src/services/usage-meter.ts") + " |\n";
md += "| Frontend guard | useFeature / FeatureGuard / FeatureNotEnabledPage | " +
  rel("artifacts/lawcaspro/src/lib/feature-guards.tsx") + " |\n";
md += "| Route guard | FeatureRouteGuard wraps every /app/* route in App.tsx | " +
  rel("artifacts/lawcaspro/src/App.tsx") + " |\n";
md += "| Founder UI | Firm Details → Modules & Features tab | " +
  rel("artifacts/lawcaspro/src/pages/platform/firms/modules-features-tab.tsx") + " |\n";
md += "| Firm UI | Settings → Subscription & Billing (read-only feature view) | " +
  rel("artifacts/lawcaspro/src/pages/app/settings/FirmSubscriptionFeaturesTab.tsx") + " |\n";
md += "\n";

md += "## Parent / Child / Dependency behaviour\n\n";
md += "- **Parent OFF** (in plan OR override) → every child feature Effective = FALSE at " +
  "runtime merge Layer 7.\n";
md += "- **Parent OFF never mutates child rows in `firm_entitlement_overrides`** (§3).\n";
md += "- When Parent is re-enabled, any stored Founder Override for children is immediately honoured.\n";
md += "- **Dependency chain (Layer 8):** any dependency disabled disables the dependent feature. " +
  "Cycles detected via DFS colouring and reported as resolution error.\n";
md += "- **Unknown key** is denied BEFORE running the 9-layer chain " +
  "(deny by default, §11) → `{ enabled:false, denialReason:'Feature not registered' }`.\n\n";

md += "## Cache invalidation (Part 2 §8)\n\n";
md += "```\nFirm override mutation         → setFirmEntitlementsCacheDirty(firmId)\n" +
     "Plan entitlement change       → setGlobalCacheDirty()\n" +
     "Emergency global kill-switch  → setGlobalCacheDirty()\n```\n\n";
md += "- Firm cache keyed by `firmId::actingAsFounder::fingerprint` with 60s default TTL.\n";
md += "- On mutation: in-memory map entry deleted synchronously. Next DB read = fresh row.\n";
md += "- Frontend polls every 15s + refetchOnWindowFocus to ensure UI sees new state before logout.\n\n";

md += "## Background jobs / notifications (Part 2 §13)\n\n";
md += "Jobs loop over firms and skip feature-disabled firms; they never delete data:\n\n";
md += "- `payment_voucher_sla` → PV SLA escalations / alerts (gated by `cases.monitor`)\n";
md += "- `case_sla_monitor` → per-case completion SLA checks\n";
md += "- `hr_event_delivery` → HR email/delivery events (gated by `hr.*` features)\n";
md += "- `case_monitor` → case bottleneck / SLA monitor batches\n";
md += "- Notification producers inside each loop use the same feature guard.\n\n";

md += "## Deny by default enforcement\n\n";
md += "Two independent layers guarantee unknown keys = denied:\n\n";
md += "1. **Backend:** head of `resolveEntitlementsBulk()` partitions keys into " +
  "known (in registry) vs unknown; unknown immediately appended with " +
  "`{ enabled:false, denialReason:'Feature not registered (deny by default)' }`.\n";
md += "2. **Frontend:** `useFeature(featureKey)` returns `enabled=false, " +
  "denialCode='feature_not_found'` when the key is absent from downloaded registry.\n\n";

md += "## Not suitable for standalone OFF (tightly-coupled)\n\n";
md += "- Cases tab parts (parties / property / loan) — hide component but page container " +
  "still loads; outer `cases.overview` route guard blocks access when parent is OFF.\n";
md += "- Document AI sub-features (OCR / AI read / AI migration) depend on sibling " +
  "`module.ai` being ON; dependency array enforces this.\n";
md += "- HIMS tracker features + eKYC are Starter deny-listed by plan default, " +
  "not feature-level individual OFF.\n";
md += "- Firm Settings tabs sharing `/app/settings` URL guarded by single `module.settings` " +
  "then RBAC tab permissions; tab-level entitlement uses JS conditional, not separate route guard.\n\n";

md += "## Manual test checklist (Part 2 — feature hardening)\n\n";
md += "1. Founder → /platform/firms → any Firm → **Modules & Features** tab opens with search/filter/tree/flat/summary.\n";
md += "2. Override one feature (e.g. `storage.file_custody`) → Disabled → save → Effective badge flips immediately.\n";
md += "3. Open firm workspace in another browser → refresh entitlements (DO NOT logout) → page shows explicit feature-not-enabled banner.\n";
md += "4. Parent OFF: disable `module.accounting` → all accounting.* rows Effective column = Disabled; stored child overrides preserved. Re-enable → children restore.\n";
md += "5. Emergency Disable: triangle icon per row → prompts reason → Source = **Emergency** badge.\n";
md += "6. Bulk Enable All/Disable All/Reset filtered: HR module filter + disable → confirm denied.\n";
md += "7. Reset All to Plan button: clears all overrides single confirm.\n";
md += "8. Firm Settings → Subscription & Billing shows read-only Included / Not Included features.\n";
md += "9. Direct URL /app/hr with HR OFF → shows explicit FeatureNotEnabledPage, no blank screen.\n";
md += "10. Direct API call on disabled-accounting firm → /accounting/payment-vouchers returns 403 FEATURE_NOT_ENABLED (backend guard, not UI only).\n";
md += "11. Background job filter: disable `cases.monitor` for a firm → PV SLA escalations skip; logs show skipped.\n";
md += "12. Kill switch global: POST /founder/platform/features/emergency → all firms see feature OFF within seconds.\n";

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, md, "utf8");
// eslint-disable-next-line no-console
console.log(`Wrote ${OUTPUT_PATH}: ${modules.length} modules, ${total} features.`);
