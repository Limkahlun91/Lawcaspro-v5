# DEP0169 url.parse() Deprecation Audit (PART 3 §20, retracted PART 2 §1 clean-gate update)
Last updated: 2026-08-13

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

## Deprecation source classification — RETRACTED EXPRESS_CONFIRMED CLAIM (PART 2 §1)

**Previous report stated:**
> DEP0169_SOURCE = third_party:express@4.22.1  (EXPRESS_CONFIRMED)

**Evidence review:**
- Local stdout logs showed DEP0169 line items, but `NODE_OPTIONS=--trace-deprecation` was never captured on a real Vercel Preview Runtime Logs before this gate.
- Existing references to `express url.parse` inside the codebase were predominantly static comments / audit observations, not a full stack trace with `package/file/line` captured on Preview runtime.
- Therefore, previous `EXPRESS CONFIRMED` classification was **evidence insufficient**.

**Retracted classification (PART 2 §1):**
```
DEP0169_SOURCE       = UNRESOLVED_RUNTIME_SOURCE
FOLLOW_UP_REQUIRED   = YES
```

**Current candidates (HYPOTHESIS ONLY, NOT CONFIRMED until §3 stack captured):**

| Hypothesis | Lockfile candidate | Suspected `url.parse()` path | Status |
|---|---|---|---|
| Express 4.x transitive | `express@^4.21.0` lock → `finalhandler` / `send` / `serve-static` legacy URL-encoded query path inside internals | HYPOTHESIS ONLY — NOT CONFIRMED without real Preview `--trace-deprecation` stack |
| `node-fetch@2.7.0` legacy parse | `node_modules/node-fetch/src/utils/parse-url.js` | HYPOTHESIS ONLY |
| Vercel Node.js runtime bootstrap | Vercel provided Node 20.x server handler | HYPOTHESIS ONLY |

### Action Plan (PART 2 §2 — do NOT modify backend / upgrade Express now)
1. **Do NOT upgrade Express 4 → 5** in this clean gate. (§2 explicit.)
2. **Do NOT patch node_modules** for this gate. (§2 explicit.)
3. **Do NOT modify backend business code** only to chase DEP0169 this round. (§2 explicit.)
4. Capture ONE real Preview stack with `NODE_OPTIONS=--trace-deprecation` only on Preview env (§3), then classify with exact package/file/line:
   - OWN_SOURCE
   - DIRECT_DEPENDENCY
   - TRANSITIVE_DEPENDENCY
   - VERCEL_RUNTIME
5. If stack still not captured after §3, keep `UNRESOLVED_RUNTIME_SOURCE` + `FOLLOW_UP_REQUIRED = YES` — no guessing.

### §20 Compliance Statement (revised PART 2 §1)
✅ Own code uses WHATWG `new URL()` API exclusively. 0 calls to legacy `url.parse()`.
⚠️ Previous "only express 4.x emit DEP0169" classification → **RETRACTED**. Insufficient `--trace-deprecation` stack evidence from real Vercel Runtime.
⚠️ DEP0169_SOURCE now = `UNRESOLVED_RUNTIME_SOURCE` / `FOLLOW_UP_REQUIRED = YES` until §3 produces exact stack.
✅ No large-scale dependency bump performed. No backend code touched for DEP0169 in this gate per §2.
