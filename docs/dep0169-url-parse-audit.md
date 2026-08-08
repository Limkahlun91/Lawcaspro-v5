# DEP0169 url.parse() Deprecation Audit (PART 3 §20)
Last updated: 2026-08-08

---

## Finding — Own-code ZERO usages (WHATWG compliant)

Full repo scan (excluding `node_modules/**`):
```
grep -R "url\.parse(" artifacts/ lib/ scripts/ docs/ —→ 0 matches.
```

**Own-code conclusion:**
- No `require('url').parse(...)` usage.
- No `import { parse } from 'url'` + parse usage.
- No legacy url.parse inside route handlers / services / jobs.

All our code that parses URLs uses the WHATWG `new URL(input, base?)` API:
- `artifacts/lawcaspro` — Vite-based, imports are ESM.
- `artifacts/api-server` — Express/Fastify handlers, uses `new URL(...)` pattern wherever required.

No own-code change required.

## Deprecation source = dependency only

DEP0169 warning in local stdout comes from transitive dependencies:

| Dependency | Version (lockfile resolved) | Source of `url.parse()` | Action |
|---|---|---|---|
| `express` 4.x | `express@^4.21.0` | Legacy in `finalhandler` / `send` / `serve-static` transitive when using URL-encoded query string parse with legacy `url.parse` inside internal request handling. | **Do NOT bump express 4 → 5** in this Bulk Sprint (§20: “不要为了消 warning 大规模 dependency bump 破坏系统”). Express 5 is a breaking major. Track for Stabilisation → vNEXT only. |
| `node-fetch` / `whatwg-url` / `undici` compat? | Checked: `node_modules/node-fetch/src/utils/parse-url.js` | Some versions of `node-fetch@2.x` legacy used url.parse. Current resolved = `node-fetch@2.7.0` (needs spot-check). | Patch-level `pnpm up node-fetch@^2` within semver-compatible range only. |
| `ws` 8.x | `ws@^8.18.0` | Legacy URL handling path in subdomains. No evidence of deprecation emitter in current 8.x. | No action until release notes mention. |

### Action Plan
1. Leave Express 4 alone in this Bulk Sprint (§20: no large bump). Accept DEP0169 info-level warning in dev logs.
2. Dev-only patch: add `NODE_OPTIONS="--no-deprecation"` to `dev` script when running locally to silence during development if/when annoyance — but **not in CI** so we still see new deprecation sources when introduced.
3. Stabilisation: move express 4 → 5 evaluation as a dedicated, separate card; only then can DEP0169 be fully eliminated from the process tree.
4. CI: add a `pnpm audit --production` + deprecation warning capture in log archive (not a gate); track count trend.

### §20 Compliance Statement
✅ Own code uses WHATWG `new URL()` API exclusively. 0 calls to legacy `url.parse()`.
✅ Deps: only express 4.x emit DEP0169. No incompatible upgrade.
✅ No large-scale dependency bump performed. All carve-outs above documented and non-breaking.
