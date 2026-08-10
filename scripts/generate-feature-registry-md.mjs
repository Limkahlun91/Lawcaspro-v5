// Generate LAWCASEPRO_FEATURE_REGISTRY.md from the SQL migration VALUES list
// which mirrors the FEATURE_REGISTRY. Schema:
// (feature_key, name, module, parent_feature_key, value_type, default_value,
//  configurable, founder_only, dependency_json, route_hint, status)

import { readFileSync, writeFileSync } from "node:fs";

const SQL_PATH = "c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/migrations/0150_full_feature_registry_reseed.sql";
const OUTPUT_PATH = "c:/Users/User/Documents/GitHub/Lawcaspro-v5/LAWCASEPRO_FEATURE_REGISTRY.md";

const sql = readFileSync(SQL_PATH, "utf8");

// Match the INSERT VALUES block: capture lines with '....'),
const rowRegex = /^\s*\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(NULL|'[^']*')\s*,\s*'([^']*)'\s*,\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*('[^']*'|\[[^\]]*\])\s*,\s*(NULL|'[^']*')\s*,\s*'([^']*)'\s*\)/gm;

const rows = [];
let m = null;
while ((m = rowRegex.exec(sql)) !== null) {
  const unquote = (s) => {
    if (!s) return "";
    if (s === "NULL" || s === "null") return "";
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    return s;
  };
  const depsStr = m[9]?.startsWith("[") ? m[9] : unquote(m[9]);
  const deps = [];
  if (depsStr && depsStr !== "NULL" && depsStr.startsWith("[")) {
    const dm = [...depsStr.matchAll(/"([^"]+)"/g)];
    for (const d of dm) deps.push(d[1]);
  }
  rows.push({
    featureKey: m[1],
    name: m[2],
    module: m[3],
    parent: unquote(m[4]),
    valueType: m[5],
    configurable: m[6]?.trim() === "true" ? "yes" : "no",
    founderOnly: m[7]?.trim() === "true" ? "yes" : "no",
    dependencies: deps,
    routeHint: unquote(m[10]),
    status: m[11] ?? "active",
  });
}

const byModule = new Map();
for (const r of rows) {
  if (!byModule.has(r.module)) byModule.set(r.module, []);
  byModule.get(r.module).push(r);
}
const modules = [...byModule.keys()].sort();
const total = rows.length;

let md = "# Lawcaspro Global Feature Registry\n\n";
md += "> Inventory generated from the canonical migration snapshot derived from source-of-truth";
md += " [feature-registry.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/feature-registry.ts).";
md += " DB platform_features table + TypeScript registry = joint source of truth per Part 2 §14.\n\n";

md += "**Principles (Part 2)**\n\n";
md += "- Unknown/unregistered configurable feature = **DENY BY DEFAULT** (§11)\n";
md += "- Parent OFF → children Effective = OFF runtime-only (§3). Child DB rows preserved.\n";
md += "- Dependency array auto-walked with cycle detection (§12)\n";
md += "- Role permissions evaluated AFTER entitlements layer (§7)\n";
md += "- Emergency kill switches at global + firm-specific level (§9)\n";
md += "- Cache invalidation immediate on Founder override change (§8)\n\n";

md += `**Inventory:** ${modules.length} modules · ${total} features total\n\n`;

md += "## Per-Module Counts\n\n";
md += "| Module | Count |\n|---|---:|\n";
for (const m of modules) md += `| \`${m}\` | ${byModule.get(m).length} |\n`;
md += "\n";

md += "## Full Feature Inventory\n\n";
md += "| feature key | name | parent | module | dependencies | route | value_type | plan_ctrl | founder_only | status |\n";
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
md += "| Registry code | FEATURE_REGISTRY, FEATURE_REGISTRY_MAP, helpers | [feature-registry.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/feature-registry.ts) |\n";
md += "| Registry DB | platform_features, plan_entitlements, firm_entitlement_overrides | [platform-entitlements.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/lib/db/src/schema/platform-entitlements.ts) + migration `0150_full_feature_registry_reseed.sql` |\n";
md += "| Resolver | 9-layer + parent/dependency chain + cache + dirty epochs | [entitlement-resolver.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/services/entitlement-resolver.ts) |\n";
md += "| Backend middleware | requireFirmFeature(featureKey) wrapped per module | [routes/index.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/index.ts) barrel + individual endpoint guards |\n";
md += "| REST endpoints | overrides, bulk, emergency, registry JSON | [routes/entitlements.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/routes/entitlements.ts) |\n";
md += "| Job/worker guard | canFirmRunJobsFor / filterFirmsForJob | entitlement-resolver + cron/scheduler loop sites |\n";
md += "| Billing ledger | append-only + trigger protection | [billing-ledger.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/services/billing-ledger.ts) |\n";
md += "| Usage metering | atomic bump per firm × metric × period | [usage-meter.ts](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/api-server/src/services/usage-meter.ts) |\n";
md += "| Frontend guard | useFeature / <FeatureGuard> / FeatureNotEnabledPage | [feature-guards.tsx](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/lib/feature-guards.tsx) |\n";
md += "| Route guard | FeatureRouteGuard wraps every /app/* route in App.tsx | [App.tsx](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/App.tsx) |\n";
md += "| Founder UI | Firm Details → Modules & Features tab | [modules-features-tab.tsx](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/pages/platform/firms/modules-features-tab.tsx) |\n";
md += "| Firm UI | Settings → Subscription & Billing (read-only) | [FirmSubscriptionFeaturesTab.tsx](file:///c:/Users/User/Documents/GitHub/Lawcaspro-v5/artifacts/lawcaspro/src/pages/app/settings/FirmSubscriptionFeaturesTab.tsx) |\n";
md += "\n";

md += "## Parent / Child / Dependency behaviour\n\n";
md += "- **Parent OFF** (in plan OR override) → every child Feature effective = FALSE at runtime merge Layer 7.\n";
md += "- **Parent OFF never mutates child rows in `firm_entitlement_overrides`** (per §3).\n";
md += "- When Parent is re-enabled, child's stored Founder Override is immediately honoured.\n";
md += "- **Dependency chain** (Layer 8): any dependency disabled disables the feature. Cycles detected via call-stack and reported as resolution error.\n";
md += "- **Unknown key** is denied BEFORE running the 9-layer chain (deny by default, §11).\n\n";

md += "## Cache invalidation (Part 2 §8)\n\n";
md += "```\nFirm override mutation  → setFirmEntitlementsCacheDirty(firmId)\nPlan entitlement change → setGlobalCacheDirty()\nEmergency global switch → setGlobalCacheDirty()\n```\n\n";
md += "- Firm cache keyed by `firmId::actingAsFounder::fingerprint` with 60s default TTL.\n";
md += "- On mutation: in-memory map entry deleted synchronously. Next DB read = fresh row.\n";
md += "- Frontend polls every 15s + refetchOnWindowFocus to ensure UI sees new state before logout.\n\n";

md += "## Background jobs / notifications (Part 2 §13)\n\n";
md += "Jobs skip per-firm loops, they do NOT delete historic data:\n\n";
md += "- `payment_voucher_sla` → PV SLA escalations / alerts (cases.monitor gated)\n";
md += "- `case_sla_monitor` → per-case completion SLA checks\n";
md += "- `hr_event_delivery` → HR email/delivery events (hr.* gated)\n";
md += "- `case_monitor` → case bottleneck / SLA monitor batches\n";
md += "- Notification producers within each loop use the same guard.\n\n";

md += "## Deny by default enforcement\n\n";
md += "Two independent layers guarantee unknown keys = denied:\n\n";
md += "1. **Backend:** head of `resolveEntitlementsBulk()` partitions input keys into known (in registry) vs unknown; unknown immediately appended with `{ enabled:false, denialReason: 'Feature not registered (deny by default)' }`.\n";
md += "2. **Frontend:** `useFeature(featureKey)` returns `enabled=false, denialCode='feature_not_found'` when key absent from downloaded registry.\n\n";

md += "## Not suitable for standalone OFF (incomplete / tightly-coupled)\n\n";
md += "- Cases tab components (parties / property / loan) — disabling individually hides tab but route still renders tab container (route guard still blocks page when parent `cases.overview` OFF).\n";
md += "- Document AI sub-features (OCR/AI read/AI migration) depend on sibling `module.ai` being ON — dependency array enforces this.\n";
md += "- HIMS tracker features and eKYC are Starter deny-listed by plan default, not feature-level.\n";
md += "- Firm Settings tabs sharing `/app/settings` URL guarded by single `module.settings` then tab permission RBAC — tab-level entitlement gating uses JS conditional, not separate route guard.\n\n";

md += "## Manual test checklist\n\n";
md += "1. Founder → /platform/firms → click any Firm → **Modules & Features** tab opens with search/filter/tree/flat/summary tabs.\n";
md += "2. Override one feature (e.g. `storage.file_custody`) to Disabled → save → Effective badge flips immediately.\n";
md += "3. Open firm workspace in another browser → refresh entitlements (do NOT logout) → /app/file-custody shows **This feature is not enabled for your firm.**\n";
md += "4. Parent OFF: disable `module.accounting` → all accounting.* rows Effective column shows Disabled; stored child overrides remain. Re-enable → children restore.\n";
md += "5. Emergency Disable: triangle icon per row → prompts reason → Source becomes **Emergency** badge.\n";
md += "6. Bulk Enable All/Disable All/Reset filtered: select HR module + disable → confirm denied.\n";
md += "7. Reset All to Plan button: clears all overrides in single confirm.\n";
md += "8. Firm Settings → Subscription & Billing shows readonly Features tab with Included/Not Included.\n";
md += "9. Direct URL /app/hr with HR OFF → shows explicit FeatureNotEnabledPage, no blank screen.\n";
md += "10. Direct API call to disabled-accounting firm on /accounting/payment-vouchers → returns 403 FEATURE_NOT_ENABLED (backend middleware, not UI-only).\n";
md += "11. Background job filter: disable cases.monitor for a firm → its PV SLA escalations row skipped; logs show skipped.\n";
md += "12. Kill switch global: POST via emergency /founder/platform/features/emergency → all firms see feature OFF within seconds.\n";

writeFileSync(OUTPUT_PATH, md, "utf8");
console.log(`Wrote ${OUTPUT_PATH}: ${modules.length} modules, ${total} features.`);
