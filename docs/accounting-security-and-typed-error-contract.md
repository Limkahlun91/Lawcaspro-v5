# Accounting Security + Typed Error Contract (PART 3 §11 + §21)
Last updated: 2026-08-08

---

## §11 Accounting Endpoints Security Sweep — 7 Scenario Matrix Enforced

All endpoints under `/accounting/**`, `/payment-vouchers/**`, `/invoices/**`, `/receipts/**`, `/quotations/**`, `/file-custody/**`, `/case-monitor/**`, `/einvoices/**` MUST pass these 7 scenarios. Scenarios run both as route unit tests (mocked req) AND integration tests (DB transaction rollback).

| # | Scenario | Expected behaviour |
|---|---|---|
| A | Unauthenticated (no auth token / invalid token / expired) | 401. Response body = `{ code: "AUTH_REQUIRED", message:"Authentication required." }`. **Never** leak entity existence. |
| B | Wrong role (e.g. Clerk role attempting `/payment-vouchers/:id/approve` when Clerk lacks `payment_voucher:approve`) | 403. Response body = `{ code: "PERMISSION_DENIED", message:"Missing permission payment_voucher:approve." }`. **Never** leak "entity ID exists in other role". |
| C | Same-firm but unauthorised case / voucher / invoice / quotation (user is Clerk in Firm A, case belongs to Firm A but is owned by a different department with no shared access) | 404 scoped-not-found (NOT 403). Code = `SCOPED_NOT_FOUND`. |
| D | Cross firm (firm A user supplies `/cases/<firm-B-id>` numeric id guess) | 404 SCOPED_NOT_FOUND. **NEVER** 403 or any message containing "you do not have permission for that firm" / "case belongs to another firm" (would create an oracle — §11 explicit prohibition). |
| E | Guessed numeric ID (sequential brute 1,2,3,…) | 404 SCOPED_NOT_FOUND. Count of distinct 404 responses = exactly the same whether ID exists in another firm or not. No timing oracle. |
| F | Disabled / deleted user account (`users.deleted_at is not null` or `users.disabled=true`) | 401 on any auth bearer for disabled user — token is rejected. Response = 401 AUTH_REQUIRED (same as #A so no oracle). |
| G | Firm id hardcoded literal in route handler | **ZERO occurrences**. Static scan: `grep -E "firm_id\s*=\s*[0-9]+|firmId\s*:\s*[0-9]+"` → 0 matches in WHERE clauses of `src/routes/**/*.ts` and `src/services/**/*.ts`. Fallback defaults only allowed in audit write fallback with explicit comment `// audit non-fatal fallback`. |

### Cross-firm Oracle Prohibition (§11 explicit rule)
Forbidden phrases in response body (any status):
- "belongs to another firm"
- "not in your firm"
- "case/pv/invoice/receipt exists"
- "invalid firm_id for entity"

Preferred response for D/E = `{ code: "SCOPED_NOT_FOUND", message: "Not found." }`. Lengths of 404 strings MUST be stable so no length oracle.

### Script
Static lint implementation lives at: `scripts/security/accounting-route-sweep.ps1` — created Stabilisation phase. Runs weekly in CI. Asserts 0 literal firm_id numbers and 0 forbidden response phrases.

---

## §21 Financial Route Typed Error Contract
All financial route error handlers:
- **Must return typed response** with fields: `{ code, message, details?, requestId? }`
- **Never unhandled rejection** → every async route wrapped `try { await handler() } catch(err) { handleRouteError(res,err) }` with standard handler.
- **Never leak raw SQL / credentials / stack trace** to frontend (production). `NODE_ENV=production` → stack & sql excluded from response body (but captured in audit logs).
- **Must not silently change existing status codes already depended on by clients** unless a documented migration period is done. If any existing route returns 400 where contract below prefers 409, leave as-is, add a comment `// BACK_COMPAT status retained 400 → will migrate 409 in vNEXT`.

### §21 Allowed Statuses per Class
| Status | Code | Use case | Example |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` / `INVALID_PARAMETER` | Missing required parameter, string expected int, date format invalid. Always include `details` array with `field` + `message`. | `GET /invoices?due_before=not-a-date → 400 VALIDATION_ERROR` |
| 401 | `AUTH_REQUIRED` / `SESSION_EXPIRED` | No token / bad token / disabled user. | Bearer header empty → 401. |
| 403 | `PERMISSION_DENIED` / `CONSENT_REQUIRED` | Role lacks permission OR consent/terms required. Note: when entity is in another firm, use 404 (#D). | Attempt approve without permission → 403. |
| 404 | `SCOPED_NOT_FOUND` | Anything that does not exist in current user's permission + firm scope. No oracle. | `GET /invoices/9999999 → 404 SCOPED_NOT_FOUND` |
| 409 | `CONFLICT` / `STALE_VERSION` / `DUPLICATE_REFERENCE` / `IDEMPOTENCY_HIT` / `INVALID_STATE_TRANSITION` | Duplicate key, optimistic lock version mismatch, receipt against invoice already paid, double release in custody, double-approve PV. **Preferred for business invariants over 422 if it's a state collision.** | PV already approved → resubmit → 409 INVALID_STATE_TRANSITION. |
| 422 | `RULE_CONFIGURATION_MISSING` / `BUSINESS_VALIDATION_FAILED` | Business rule can't compute because missing configuration (e.g. Quotation `auto-calc` with no SRO rule). List missing rules explicitly as string-array `missing_rules[]`. Return 422 — **NEVER 200 with zero values silent**, per §00-core-rules. | `POST /quotations/:id/auto-calc` without approval_rules.sro_rates → 422 RULE_CONFIGURATION_MISSING `missing_rules:["sro_fixed_fee","sro_percentage_scale"]` |
| 503 | `DEPENDENCY_FAILURE` / `EINVOICE_SANDBOX_DISABLED` / `DOWNSTREAM_UNAVAILABLE` | External dependency (LHDN MyInvois, storage, cron lock) unavailable. Controlled 503. Retry-After header set when known. Never 500 when the error is a planned dependency failure. | `POST /einvoices/:id/submit` with `EINVOICE_SANDBOX≠1` → 503 EINVOICE_SANDBOX_DISABLED with message "Production submit disabled; set EINVOICE_SANDBOX=1 in this build." |

### Error Handler Non-Leakage Guarantee
`function handleRouteError(res, err)` guarantees:
- If `NODE_ENV === "production"` AND err is raw DB (PG) error → filter response = `{ code, message }` without `err.detail`, `err.where`, `err.hint`, `err.schema`, `err.table`.
- If err.message matches regex `(password|secret|credential|bearer|eyJ|sk_|service_role)` → redact mask.
- Always writes structured error to audit_logs as `entityType=http_error`.
- `process.on('unhandledRejection', ...)` = global guard that does not crash but writes to audit.
- `uncaughtException` = 1 retry attempt on same request, then response 503 DEPENDENCY_FAILURE.

### Permitted Backwards Compat Carveouts
None today (no route status changes from PART 1/2 legacy are changed in PART 3; all above are future strict contract).
