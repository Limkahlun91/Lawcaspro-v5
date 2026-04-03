# Lawcaspro — Legal Operations System

## Overview
Lawcaspro is a multi-tenant legal operations SaaS specifically designed for Malaysian law firms, focusing on real estate conveyancing cases. It aims to streamline legal workflows, manage case-related documents, facilitate communication, and provide financial oversight for law firms. The platform offers dedicated workspaces for both firm users and a founder/platform administrator, ensuring secure and segregated data management. Its core capabilities include comprehensive case management, document generation from templates (DOCX and PDF), client and project tracking, role-based access control, and a robust communication hub. The system also supports detailed billing, quotation generation, and reporting functionalities, making it a complete solution for modern legal practices.

## User Preferences
- No emojis in UI
- Professional, dense data-rich interface for legal professionals
- Dark navy/slate theme with amber/gold accents

## System Architecture
Lawcaspro is built as a full-stack monorepo using `pnpm` workspaces. The frontend is developed with React, Vite, Tailwind CSS, Wouter for routing, and React Query for data fetching. The backend is an Express 5 API written in TypeScript, utilizing Drizzle ORM with a PostgreSQL database. Authentication is cookie-based, employing bcryptjs for password hashing and SHA-256 for token hashing, stored in HttpOnly cookies. The API contract is defined using OpenAPI specifications, with `orval` codegen generating typed React Query hooks and Zod validators for robust type safety and validation.

The architecture supports multi-tenancy with distinct routing for the `/platform/*` founder workspace and `/app/*` firm workspace. Firm context is derived from the session, not the URL. Document generation leverages `docxtemplater` for DOCX files and `pdf-lib` for PDFs, including a visual PDF mapping editor for overlaying text onto PDF templates with variable replacement.

Key UI/UX decisions include a professional, data-rich interface with a dark navy/slate theme accented by amber/gold. Navigation is structured with a consolidated sidebar (with unread notification badges for Communications) and tabbed layouts for settings and case details. Data modeling includes tables for firms, users, roles, permissions, developers, projects, clients, cases, and various case-related entities like workflow steps, notes, documents, billing entries, communication threads, and thread messages. A workflow engine dynamically generates case steps based on `purchaseMode` and `titleType`.

Communications follow a subject-based thread model: users create a "subject" (thread) per case, then chat within it. Unread tracking uses a `communication_read_status` table with per-user last-read timestamps. The sidebar shows an unread count badge that auto-refreshes every 30 seconds.

Projects support full CRUD including edit via the PATCH endpoint. The edit page pre-fills all fields from the existing project and accepts all fields including phase, developerName, title metadata, location fields, and extraFields (property types).

## Group A — Financial Foundation (Completed)

### Regulatory Rules Engine
- **Tables**: `regulatory_rule_sets`, `regulatory_rule_versions` — versioned rules with JSONB formula data
- **Seeded Malaysian rates**: SRO SPA (sliding scale 1%→0.4%), SRO Loan (same scale), Stamp Duty MOT (1%→4%), Stamp Duty Loan (0.5% flat), SST 8% (from Mar 2024), SST 6% (historical)
- **Drizzle schema**: `lib/db/src/schema/regulatory.ts` exported from schema index
- **API routes** (`/api/regulatory/...`): list rule sets, get versions, get active version by date, calculate fee from any rule

### Quotation Engine 2.0
- **DB upgrades**: `rule_version_id`, `loan_amount_num`, `fee_override_reason`, `fee_override_approved_by`, `accepted_at`, `sent_at` on `quotations`; `is_system_generated`, `item_type` on `quotation_items`
- **Auto-calculate endpoint** (`POST /api/quotations/:id/auto-calculate`): Applies SRO sliding scale + stamp duty tiers + 8% SST; generates system line items with tier breakdowns; preserves manual items
- **Frontend**: "Auto-Calculate Fees" button on quotation detail page (shown when purchasePrice or loanAmount is set)

### Legal Accounting Engine — Schema
- **New DB tables**: `invoices`, `invoice_items`, `receipts`, `receipt_allocations`, `payment_vouchers`, `payment_voucher_items`, `ledger_entries`, `credit_notes`
- **Account types**: client | office | trust (never mixed)
- **Drizzle schema**: `lib/db/src/schema/accounting.ts` updated with all new tables

### Legal Accounting Engine — API
- **`/api/invoices`**: CRUD + generate from quotation + issue + void + auto payment status update
- **`/api/receipts`**: record receipt + allocate to invoice + reverse + auto-post to ledger
- **`/api/payment-vouchers`**: create + full approval workflow (draft→prepared→lawyer_approved→partner_approved→submitted→paid) + ledger posting on payment
- **`/api/ledger`**: list entries (filterable by account type), summary (balance per account type)

### Legal Accounting Engine — Frontend
- **Accounting page** (`/app/accounting`): 5-tab layout — Overview, Invoices, Receipts, Payment Vouchers, Ledger
- **Invoice detail page** (`/app/accounting/invoices/:id`): line items by category, record payment inline, issue/void actions
- **Ledger tab**: 3-account balance cards (client/office/trust), filterable transaction history

## Group B — Time & Task Management (Completed)

### Time Entries
- **Table**: `time_entries` — per-case, per-user billable hours tracking (date, description, hours, rate/hr, is_billable, is_billed, invoice_id)
- **Drizzle schema**: `lib/db/src/schema/time-tasks.ts`
- **API routes**: `GET/POST/PUT/DELETE /api/time-entries`, `GET /api/time-entries/summary?caseId=`
- **Frontend**: `CaseTimeTab` component on case detail (8th tab) — 4 summary cards (total/billable hours, total value, unbilled), log time dialog with billable switch

### Case Tasks
- **Table**: `case_tasks` — per-case task management (title, description, assigned_to, due_date, priority: low/normal/high/urgent, status: open/in_progress/done)
- **API routes**: `GET/POST/PUT/DELETE /api/case-tasks`, `GET /api/case-tasks/upcoming` (for dashboard widgets)
- **Frontend**: `CaseTasksTab` component on case detail (7th tab) — filter by status, priority badges, overdue highlighting, add task dialog, mark done with checkbox toggle

## Group C — Compliance Reports (Completed)

### Bills Delivered Book
- **API**: `GET /api/reports/bills-delivered-book?from=&to=` — all issued invoices with totals, enriched with case ref and client name
- **Page**: `/app/reports/bills-delivered-book` — date-range filter, summary KPI cards, full statutory table with tfoot totals, print button

### Trust Account Statement
- **API**: `GET /api/reports/trust-account-statement?caseId=` — all trust ledger entries with running balance
- **Page**: `/app/reports/trust-account-statement` — optional case filter, running balance column, debit/credit columns (SAR 1990 r.7 compliant)

### Matter Aging Report
- **API**: `GET /api/reports/matter-aging` — outstanding invoices bucketed: current / 1-30 / 31-60 / 61-90 / 90+ days overdue
- **Page**: `/app/reports/matter-aging` — visual progress bars per bucket, item-level detail tables, grand total

### Reports Index
- Updated `/app/reports` with a **Statutory Reports** section at the top — 3 clickable cards linking to each compliance report, then existing analytics charts below

## Group D — Mobile App Enhancement (Completed)

### Tasks on Mobile
- **Dashboard** (`index.tsx`): Upcoming Tasks section showing next 5 open tasks across all cases, with overdue highlighting, taps through to case detail
- **Tasks screen** (`/tasks`): Full tasks list with open/all filter, overdue/upcoming grouping, mark-done action, priority colour dots, registered in Expo Router Stack
- **Case detail**: Added "Tasks" as 5th tab — shows per-case tasks with overdue highlighting, priority dots, done state

## Phase 0 — Engineering Foundation (Completed)

### Schema Corrections
- **Unique index naming**: All unique constraints aligned to DB-native names (`firms_slug_key`, `users_email_key`, `sessions_token_hash_key`, `regulatory_rule_sets_code_key`) using `uniqueIndex()` in Drizzle schema
- **55 new indexes**: Added across all major tables for query performance
- **Soft delete**: `deleted_at timestamp` added to `cases`, `clients`, `invoices`, `quotations`
- **Optimistic locking**: `version integer` added to `invoices` and `payment_vouchers`
- **TOTP fields**: `totp_secret`, `totp_enabled`, `totp_last_used_at` added to `users`
- **Session enrichment**: `user_agent`, `ip_address` added to `sessions`; `user_agent`, `ip_address` added to `audit_logs`
- **New table**: `support_sessions` (founder debug access tracking) in `lib/db/src/schema/security.ts`
- **Migration baseline**: `lib/db/migrations/0000_000_baseline.sql` — full from-scratch recreation SQL

### Migration Infrastructure
- `lib/db/drizzle.config.ts`: `out: "./migrations"` configured
- `pnpm generate` in `lib/db` creates tracked migration files
- `pnpm migrate` in `lib/db` applies unapplied migrations

## Phase 1 — Tenant Security (Completed)

### Rate Limiting (express-rate-limit + helmet)
- `authRateLimiter`: 10 requests per 15-minute window on login endpoint
- `sensitiveRateLimiter`: 30 requests per minute (exported from `lib/rate-limit.ts`)
- `helmet`: Security headers on all responses; cross-origin resource policy set to cross-origin for API access
- Rate limiting skipped in `NODE_ENV=test`

### Audit Logging on Auth Events
- `requireAuth` logs `auth.missing_token`, `auth.session_expired`, `auth.user_inactive`
- `requireFounder` logs `auth.forbidden.founder_required` on 403
- `requireFirmUser` logs `auth.forbidden.firm_user_required` on 403
- Login logs `auth.login_success` / `auth.login_failed` / `auth.totp_failed`
- Logout logs `auth.logout`
- All logs include `ip_address` and `user_agent`

### TOTP / 2FA Infrastructure
- `POST /auth/totp/setup` — generates secret + QR code (otpauth library)
- `POST /auth/totp/confirm` — verifies first code and enables TOTP
- `POST /auth/totp/disable` — disables TOTP after code verification
- Login flow: if `totp_enabled`, returns `{ needsTotp: true }`, then client submits `totpCode`
- `requireReAuth` middleware exported for protecting sensitive operations

### Support Sessions (Founder Debug Access)
- `POST /support-sessions` — starts a support session (founder only)
- `PATCH /support-sessions/:id/end` — ends a session
- `GET /support-sessions` / `GET /support-sessions/active` — lists sessions
- `POST /support-sessions/:id/log` — logs an action within a session
- Every action creates an audit log entry
- Routes in `artifacts/api-server/src/routes/support-sessions.ts`

### Frontend — Settings Security Tab
- Security tab added to `/app/settings` with `?tab=security`
- TOTP enable flow: "Enable 2FA" → QR code display → manual secret → 6-digit confirm → enabled
- TOTP disable flow: "Disable 2FA" → 6-digit confirm → disabled
- Active sessions list with per-session revoke button
- Login page updated to show TOTP step when `needsTotp: true` returned

## Phase 0/1 Security Hardening (Completed)

### BLOCKER 1 — Migration control
- `lib/db/scripts/reconcile-live-db.mjs` seeds baseline hash into `__drizzle_migrations` for existing DBs
- `pnpm --filter @workspace/db run reconcile` then `pnpm --filter @workspace/db run migrate` are the safe procedures
- `lib/db/MIGRATION_GUIDE.md` documents fresh-DB and live-DB procedures

### BLOCKER 2 — PostgreSQL Row-Level Security
- `lib/db/scripts/apply-rls.sql` — idempotent RLS setup (run with `pnpm --filter @workspace/db run apply-rls`)
- `app_user` PostgreSQL role created (NOLOGIN, no BYPASSRLS); RLS enforced when connection uses `SET ROLE app_user`
- **22 firm-scoped tables** all have `ENABLE ROW LEVEL SECURITY` and `tenant_isolation` policies
- Policy: `firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer OR app.is_founder = 'true'`
- `lib/db/src/tenant-context.ts` exports `setTenantContext(client, firmId)`, `setFounderContext(client)`, `clearTenantContext(client)`
- App connects as `postgres` (superuser, BYPASSRLS) — RLS only active when explicitly SET ROLE app_user

### BLOCKER 3 — sensitiveRateLimiter mounted
- 30 req/min window; `skip: () => NODE_ENV === 'test'`
- Mounted on: POST /invoices, /invoices/from-quotation/:id, /invoices/:id/issue, /invoices/:id/void
- POST /receipts, /receipts/:id/reverse
- POST /payment-vouchers, /payment-vouchers/:id/transition
- POST /support-sessions, /support-sessions/:id/log
- POST /auth/totp/setup, /auth/totp/confirm, /auth/totp/disable

### BLOCKER 4 — requireReAuth + frontend ReAuthDialog
- `requireReAuth` middleware checks `x-reauth-token` header matches current session → 403 REAUTH_REQUIRED if missing, 403 REAUTH_FAILED if invalid
- Mounted on: POST /invoices/:id/void, /receipts/:id/reverse, /payment-vouchers/:id/transition, /auth/totp/disable
- Frontend: `artifacts/lawcaspro/src/components/re-auth-dialog.tsx` — `ReAuthProvider` + `useReAuth()` hook
- `wrapWithReAuth(action, message)` wraps any async action; shows confirmation dialog; retries with `x-reauth-token` on confirm
- Auth context now stores token in sessionStorage (`_lcp_tok`) and exposes `token` field
- `ReAuthProvider` wraps entire app in `App.tsx`

### Automated Tests (vitest + supertest)
- **53 tests** across 6 test files in `artifacts/api-server/src/__tests__/`
- `auth.test.ts`: login success/failure, logout, /me, sessions, audit logs, TOTP endpoints (incl. re-auth on disable)
- `tenant-isolation.test.ts`: firm user blocked from platform routes, DB-level isolation verified
- `support-sessions.test.ts`: session lifecycle, audit log creation, error cases
- `create-case.test.ts`: 40 tests covering all P0/1 case-creation features
- `rls-isolation.test.ts`: DB-level RLS policy tests (firm B can't see firm A data, founder sees all, empty context sees nothing)
- `reauth.test.ts`: requireReAuth on invoice void, receipt reverse, PV transition (403 without token, 403 on invalid, 200 with valid)
- Run with `pnpm --filter @workspace/api-server run test`

## Phase 2 — AML/CDD/KYC Compliance + Conflict Check Engine (Completed)

### Database Schema (16 new tables)
- **`lib/db/src/schema/compliance.ts`**: `parties`, `case_parties`, `compliance_profiles`, `cdd_checks`, `cdd_documents`, `beneficial_owners`, `sanctions_screenings`, `pep_flags`, `risk_assessments`, `source_of_funds_records`, `source_of_wealth_records`, `suspicious_review_notes`, `compliance_retention_records`
- **`lib/db/src/schema/conflict.ts`**: `conflict_checks`, `conflict_matches`, `conflict_overrides`
- All 16 tables have firm-scoped RLS (`tenant_isolation` policy)
- Migration applied: `lib/db/migrations/0001_illegal_vapor.sql`

### Backend — Parties Routes (`routes/parties.ts`)
- `GET/POST /parties` — list/create parties (natural person, company, trust)
- `GET/PUT/DELETE /parties/:id` — individual party CRUD
- `GET /parties/search?q=` — name/NRIC/company reg search
- `GET /cases/:caseId/parties` — list parties linked to a case
- `POST /cases/:caseId/parties` — link a party to a case
- `DELETE /cases/:caseId/parties/:partyId` — unlink party from case

### Backend — Compliance Routes (`routes/compliance.ts`)
- `GET/POST /parties/:id/compliance-profile` — create or fetch CDD profile
- `POST /compliance/cdd-checks` — create a CDD check run
- `GET/POST /parties/:id/risk-assessment` — RBIM risk scoring (PEP=30, high-risk jurisdiction=25, complex ownership=20, nominee=20, missing SOF=15, suspicious=25; ≥45=high, ≥70=very_high)
- `POST /parties/:id/edd-trigger` — trigger enhanced due diligence
- `GET/POST /parties/:id/sanctions` — OFAC/UN/BNM sanctions screening records
- `GET/POST /parties/:id/pep-flags` — PEP (politically exposed person) flags
- `GET/POST /parties/:id/source-of-funds` / `source-of-wealth` — SOF/SOW declarations
- `GET/POST /parties/:id/suspicious-notes` — suspicious activity notes
- `GET/POST /parties/:id/retention` — compliance retention records

### Backend — Conflict Check Engine (`routes/conflict.ts`)
- `POST /conflict/check` — run full conflict check: name fuzzy (≥75%=warning, ≥95%=blocked), NRIC/passport/company_reg exact match (=blocked)
- `GET /conflict/checks?caseId=` — list checks for a case
- `GET /conflict/checks/:id` — get check with matches and overrides
- `POST /conflict/checks/:id/override` — partner-only override of a blocked match; requires `requirePartner` + `requireReAuth` (x-reauth-token header)
- Deduplication: one match per (partyName, matchedCaseId); identifier matches take priority over name matches
- Checks against both `case_purchasers` (legacy) and `case_parties` (new) tables
- `requirePartner` middleware added to `lib/auth.ts` (checks `req.roleId === 1`)

### Frontend — Compliance & Conflict UI
- **`CaseComplianceTab.tsx`** — party list, CDD status badge, risk score, SOF/SOW section, suspicious notes per case
- **`PartyForm.tsx`** — full party capture (natural person, company, trust) with PEP flag and identity fields
- **`BeneficialOwnerForm.tsx`** — beneficial owner capture form
- **`CaseConflictPanel.tsx`** — conflict check trigger, results table with override modal (uses `wrapWithReAuth`)
- Case detail page updated to `grid-cols-9` with "Compliance" as 9th tab

### Automated Tests — Phase 2
- **102 tests** total (8 test files)
- `compliance.test.ts` — profile creation, EDD trigger, PEP/sanctions, SOF/SOW, audit log, tenant isolation
- `conflict.test.ts` — no match, NRIC blocked match, get results, access control (lawyer blocked), partner override flow, single-use re-auth token, duplicate override rejected, name fuzzy match, audit log, input validation
- All 102 tests pass

## External Dependencies
- **PostgreSQL**: Primary database for all application data, managed via Drizzle ORM.
- **Replit Object Storage (GCS)**: Used for storing document templates and generated case documents.
- **docxtemplater**: Library for generating DOCX documents from templates with data substitution.
- **pdf-lib**: Library for manipulating and generating PDF documents, including overlaying text based on visual mappings.
- **bcryptjs**: Used for secure password hashing.
- **Recharts**: Utilized for rendering charts and visualizations in reports and dashboards.
- **Tailwind CSS**: Utility-first CSS framework for styling the frontend.
- **Wouter**: A minimalistic routing library for React.
- **React Query**: For server state management and data fetching in the frontend.