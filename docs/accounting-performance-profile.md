# Accounting Performance Profile (Part 2 §24)

## Overview

This document tracks DB-level performance characteristics of accounting endpoints under the Lawcaspro-v5 `api-server` package. Before any pooling, query-shape, or index changes, populate this table with real measurements from staging or production-like loads.

---

## Identified Database Pools

| Pool Name | Source File | Scope | RLS Context |
|-----------|-------------|-------|-------------|
| `main_pool` | `@workspace/db/lib/db/src/index.ts:84` | Global `Pool` exported as `pool`; `DATABASE_URL` | Drives `requireFirmUser` (transaction-scoped `SET LOCAL`) and `db` fallback |
| `auth_admin_pool` | `artifacts/api-server/src/lib/auth-admin-db.ts:21-32` | Separate `AUTH_DATABASE_URL` / `ADMIN_DATABASE_URL` | Founder `SET LOCAL app.is_founder='true'`, used by auth-session fallback + platform ops |
| `rls_request_pool_client` | `artifacts/api-server/src/lib/auth.ts:821-1013` | Per-request `PoolClient` checkout from `main_pool` inside `requireFirmUser` | `BEGIN` → `SET LOCAL ROLE app_user` → `set_config('app.current_firm_id', ..., true)`; auto `COMMIT`/`ROLLBACK` + `clearTenantContext` before release |

---

## Endpoint Performance Baseline (to fill in by operator)

Legend:
- **Cold**: First hit after server start. No warm pool clients, no auth-session cache hit, no OS page cache benefit.
- **Warm**: Subsequent hit after at least one prior request.

| Endpoint | Method | Pool Used | DB Connect (ms) | # Queries | Total Query (ms) | Total Request (ms) | Cold vs Warm | Notes / Observations |
|----------|--------|-----------|-----------------|-----------|------------------|--------------------|---------------|-----------------------|
| `/auth/me` | GET | `auth_admin_pool` fallback + `rls_request_pool_client` | | | | | | Session lookup: primary admin pool → safe fallback → permissions hydration |
| `/accounting/summary` | GET | `rls_request_pool_client` | | | | | | 4 aggregates on `case_billing_entries` (top cases / monthly / totals / by category); indexes on `firm_id` + `created_at` needed |
| `/accounting/invoice-metrics` | GET | `rls_request_pool_client` | | | | | | Calls `computeInvoiceMetrics` — invoices joined with receipts + allocations (N+1 risk per case) |
| `/invoices` | GET | `rls_request_pool_client` | | | | | | Currently **NO LIMIT** — unbounded SELECT entire firm history; §26 adds `page`/`limit` (default 30 / max 200) |
| `/receipts` | GET | `main_pool` (fallback `db`) | | | | | | Currently **NO LIMIT**; also uses global `db` not `req.rlsDb` (audit: `receipts.ts:125`) — fix pending |
| `/payment-vouchers` | GET | `rls_request_pool_client` | | | | | | Already paginated (50/request); already uses `SET LOCAL statement_timeout = 2500ms` + `lock_timeout 500ms` |
| `/payment-vouchers/:id` | GET | `rls_request_pool_client` | | | | | | PV detail + items + actor names + case info ref lookups |
| `/payment-voucher-actions/my-work` | GET | `rls_request_pool_client` | | | | | | PV actions joined with vouchers + cases; currently **NO LIMIT**; §26 adds page/limit |
| `/payment-voucher-actions/my-work/overview` | GET | `rls_request_pool_client` | | | | | | Already uses `SET LOCAL statement_timeout = 2500ms`; paginated list portion (20 default, 50 max) |
| `/ledger` | GET | `rls_request_pool_client` | | | | | | **NO LIMIT**; full firm ledger + optional case filter; §26 page/limit |
| `/ledger/summary` | GET | `rls_request_pool_client` | | | | | | Aggregate only (SUM+GROUP BY account_type); no unbounded rows |
| `/cases/:caseId/ledger` | GET | `rls_request_pool_client` | | | | | | Per-case ledger entries; **NO LIMIT**; usually manageable but bad for very old cases |
| `/quotations` | GET | `main_pool` (global `db`) | | | | | | Already paginated `limit`/`offset` (default 200, max 500); but uses global `db` not `rlsDb` — audit |
| `/reports/trust-account-statement` | GET | `rls_request_pool_client` | | | | | | **NO LIMIT**; entries joined with vouchers for cheque status; CSV + XLSX export paths; §27 monetary parse risk at `num(e.debit)` / `num(e.credit)` |
| `/reports/client-account-statement` | GET | `main_pool` (global `db` fallback) | | | | | | **NO LIMIT**; uses `Number(e.credit) - Number(e.debit)` inline |
| `/dashboard/summary` | GET | `rls_request_pool_client` | | | | | | JS-level Promise.race 1800ms timeout on top of DB; COUNT queries × 4 |

---

## Known Top Queries / N+1 Suspects

1. **Invoices list (`/invoices`)**: No `LIMIT`. N=all-time firm invoice count.
2. **Receipts list (`/receipts`)**: Same; also not scoped to `req.rlsDb` so RLS app_user is not enforced (uses role of `pg` connection pool user, which typically has BYPASSRLS — confirm in staging).
3. **Quotations list (`/quotations`)**: Already paginated but uses global `db` (same RLS caveat). Also `inArray(qIds)` item-aggregate + item-load = 3 queries per page.
4. **Ledger `/ledger` & `/reports/trust-account-statement`**: Full scan of `ledger_entries`; trust statement also has secondary lookup for every voucher referenced.
5. **PV dashboard detail (`/payment-vouchers/:id`)**: Items + actor names + case info + audit timeline — multiple sequential selects.

---

## Operator Profiling Instructions

### Option A — Express request timing (low-overhead, recommended)

The `requireFirmUser` middleware already populates `req.timing.sections` with:
- `authSessionMs`
- `permissionMs`
- `tenantContextDbConnectMs`
- `tenantContextMs`
- `db_pool_connect`

For the remaining endpoints, wrap their query blocks with `process.hrtime.bigint()` and log the sum. Example snippet to paste per handler:

```ts
const t0 = process.hrtime.bigint();
let queryCount = 0;
const origExecute = (r as any).execute.bind(r);
(r as any).execute = async (...args: unknown[]) => {
  queryCount++;
  const qt0 = process.hrtime.bigint();
  try { return await origExecute(...args); }
  finally {
    const qt1 = process.hrtime.bigint();
    logger.debug({ ms: Number(qt1 - qt0) / 1e6, route: req.path }, 'query_time');
  }
};
const rows = await r.select()...;
const t1 = process.hrtime.bigint();
logger.info(
  { route: req.path, totalMs: Number(t1 - t0) / 1e6, queryCount, poolTotal: (pool as any).totalCount, poolIdle: (pool as any).idleCount },
  'endpoint_profile'
);
```

Also `payment-vouchers.ts:438-447` already writes `x-lawcaspro-timing` header — reuse that pattern.

### Option B — V8 `node --prof` (off-CPU analysis)

Run server with profiler:

```bash
cd artifacts/api-server
NODE_ENV=staging node --prof --enable-source-maps dist/index.mjs
```

Exert 2–3 min of load against the endpoints above, then:

```bash
node --prof-process isolate-0xNNNNNN-v8.log > profile.txt
grep -E "SharedLibs|Summary|tick.*total" profile.txt | head -50
```

### Option C — PostgreSQL `pg_stat_statements` (DB side)

Run on the firm DB to find top statements by mean time + calls:

```sql
SELECT
  queryid,
  calls,
  round(total_exec_time::numeric, 1) AS total_ms,
  round(mean_exec_time::numeric, 1) AS mean_ms,
  round(stddev_exec_time::numeric, 1) AS stddev_ms,
  left(query, 200) AS query_preview
FROM pg_stat_statements
WHERE query ILIKE '%ledger%' OR query ILIKE '%invoice%' OR query ILIKE '%receipt%' OR query ILIKE '%payment_voucher%'
ORDER BY total_exec_time DESC
LIMIT 20;
```

Reset with `SELECT pg_stat_statements_reset();` before each endpoint test run.

---

## Rule: No Silent Merging of Pools Until This Table Is Populated

DO NOT consolidate `auth_admin_pool` into `main_pool` until:
- rows for `/auth/me` + `/payment-vouchers` (cold vs warm) are filled;
- you can prove `auth_admin_pool` mean connect time ≥ 2× `main_pool`;
- you have confirmed that app_user RLS on the main pool still founder-visible to sessions table (i.e. `AUTH_DATABASE_URL` points to the **same physical cluster** as `DATABASE_URL` — otherwise pools cannot be merged).


---

## Automated Local Baseline (PART 3 §12)

> **Measurement truth source** (§12): `scripts/benchmark-accounting-performance.mjs` with `PERF_MODE=collect`.
>
> §12 Strict Assertion — Never write "Preview P95" unless measured on a deployed preview host:
> - ✅ "automated/local measured" = YES below (even if values are — pending)
> - ❌ "Preview P95 = 123ms" is FORBIDDEN unless actual Preview deploy was measured during Stabilisation

| Endpoint Name (click name) | Method | Environment Scope | Cold (ms, local) | Warm ×3 Avg (ms, local) | Status | Notes |
|---|---|---|---|---|---|---|
| `auth/me` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `accounting_summary` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `invoices_list` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `receipts_list` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `pv_dashboard` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `pv_list` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `reference_search` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `my_work` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `ledger_list` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |
| `quotations_list` | GET | LOCAL-ONLY | — | — | NOT_RUN (use PERF_MODE=collect) | PERF_MODE=collect required for values; server reachable today=false |

### How to run local measurement
```bash
# 1. start local API server (separate terminal)
pnpm --filter @workspace/api-server dev
# 2. set auth header if you have one (optional — without it you get 401_EXPECTED_NO_AUTH which is fine for status rows)
export PERF_AUTH_HEADER="Bearer <your-token>"
# 3. run collector
cd scripts && PERF_MODE=collect node ./benchmark-accounting-performance.mjs
```
