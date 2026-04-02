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