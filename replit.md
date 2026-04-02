# Lawcaspro — Legal Operations System

## Overview
Multi-tenant legal operations SaaS for Malaysian law firms managing real estate conveyancing cases. Built as a full-stack monorepo with a React Vite frontend and Express API backend.

## Architecture

### Stack
- **Frontend**: React + Vite + Tailwind CSS + Wouter routing + React Query
- **Backend**: Express 5 + TypeScript + Drizzle ORM
- **Database**: PostgreSQL (via Drizzle)
- **Auth**: Cookie-based sessions (bcryptjs + SHA-256 token hashing, HttpOnly cookies)
- **API Contract**: OpenAPI spec → orval codegen → typed React Query hooks + Zod validators
- **Monorepo**: pnpm workspaces

### Multi-tenant Routing
- `/platform/*` — Founder workspace (manages all firms)
- `/app/*` — Firm workspace (cases, users, roles, data per firm)
- User types: `founder` (firmId = null) | `firm_user` (firmId = their firm)
- Firm context comes from session (not URL slug)

### Artifacts
- `artifacts/lawcaspro` — React Vite frontend (port from env, path `/`)
- `artifacts/api-server` — Express API (port 8080, routes at `/api/*`)

### Shared Libraries
- `lib/db` — Drizzle schema + db client
- `lib/api-spec` — OpenAPI YAML spec
- `lib/api-client-react` — Generated React Query hooks (orval)
- `lib/api-zod` — Generated Zod validation schemas (orval)

## Database Schema

All tables created in PostgreSQL:

| Table | Purpose |
|---|---|
| `firms` | Law firm tenants |
| `users` | Founders + firm users |
| `roles` | Per-firm roles (Partner, Lawyer, Clerk) |
| `permissions` | Per-role module/action grants |
| `sessions` | Auth session tokens (hashed) |
| `developers` | Real estate developers |
| `projects` | Development projects per developer |
| `clients` | Purchaser/client registry |
| `cases` | Core conveyancing case records |
| `case_purchasers` | Case ↔ client relationships (main/joint) |
| `case_assignments` | Case ↔ user (lawyer/clerk) assignments |
| `case_workflow_steps` | Workflow step instances per case |
| `case_notes` | Internal case notes |
| `audit_logs` | Action audit trail |
| `document_templates` | DOCX template files per firm (stored in Replit Object Storage) |
| `case_documents` | Generated/uploaded documents per case |
| `case_billing_entries` | Per-case billing entries (legal fees, disbursements, stamp duty, etc.) |
| `case_communications` | Per-case communication log (email, WhatsApp, phone, letter, portal) |
| `platform_documents` | System documents uploaded by founder, shared with all/specific firms |
| `platform_messages` | Direct messages between founder and law firms (bidirectional) |
| `platform_message_attachments` | File attachments on platform messages (PDF, Word, Excel, images) |

## API Routes (all under /api prefix)

### Auth
- `POST /api/auth/login` — Email/password login, sets httpOnly cookie
- `POST /api/auth/logout` — Clears session cookie
- `GET /api/auth/me` — Current user info

### Platform (Founder only)
- `GET /api/platform/firms` — List all firms
- `POST /api/platform/firms` — Create firm + partner user
- `GET /api/platform/firms/:firmId` — Firm detail
- `PATCH /api/platform/firms/:firmId` — Update firm
- `GET /api/platform/stats` — Platform-level statistics
- `GET /api/platform/firms/:firmId/users` — List all users in a firm
- `POST /api/platform/firms/:firmId/users/:userId/reset-password` — Reset a firm user's password
- `GET /api/platform/documents` — List system documents (optionally filter by firmId)
- `POST /api/platform/documents` — Upload a system document (via object storage)
- `DELETE /api/platform/documents/:docId` — Delete a system document
- `GET /api/platform/messages` — List messages (founder ↔ all firms; filter by firmId)
- `POST /api/platform/messages` — Send message from founder to a firm (with attachments)
- `PATCH /api/platform/messages/:msgId/read` — Mark message as read

### Communication Hub (Firm users)
- `GET /api/hub/messages` — Firm's message thread with Lawcaspro
- `POST /api/hub/messages` — Firm sends message to Lawcaspro (with attachments)
- `PATCH /api/hub/messages/:msgId/read` — Mark incoming message as read
- `GET /api/hub/documents` — List system documents available to the firm

### Firm Workspace
- `GET /api/dashboard` — Firm dashboard stats
- `GET/POST /api/users` — List/create firm users
- `GET/PATCH/DELETE /api/users/:userId`
- `GET/POST /api/roles` — List/create roles
- `GET/PATCH/DELETE /api/roles/:roleId`
- `GET/POST /api/developers`
- `GET/PATCH/DELETE /api/developers/:developerId`
- `GET/POST /api/projects`
- `GET/PATCH/DELETE /api/projects/:projectId`
- `GET/POST /api/clients`
- `GET/PATCH/DELETE /api/clients/:clientId`
- `GET/POST /api/cases`
- `GET/PATCH /api/cases/:caseId`
- `GET /api/cases/:caseId/workflow`
- `PATCH /api/cases/:caseId/workflow/:stepId`
- `GET/POST /api/cases/:caseId/notes`
- `GET /api/cases/stats/by-status`
- `GET /api/cases/stats/by-type`
- `GET /api/cases/recent`
- `GET /api/cases/:caseId/documents` — List case documents
- `POST /api/cases/:caseId/documents/generate` — Generate document from DOCX template (docxtemplater)
- `POST /api/cases/:caseId/documents/upload` — Register manually uploaded document
- `GET /api/cases/:caseId/documents/:docId/download` — Download document binary
- `DELETE /api/cases/:caseId/documents/:docId`
- `GET/POST /api/document-templates` — Firm DOCX templates (list/upload)
- `DELETE /api/document-templates/:templateId`
- `POST /api/storage/uploads/request-url` — Get GCS presigned upload URL
- `GET /api/storage/objects/*` — Serve private objects (auth required)

### Accounting (Phases 3)
- `GET /api/cases/:caseId/billing` — List billing entries for a case
- `POST /api/cases/:caseId/billing` — Add billing entry
- `PATCH /api/cases/:caseId/billing/:entryId` — Update billing entry (incl. toggle paid)
- `DELETE /api/cases/:caseId/billing/:entryId` — Delete billing entry
- `GET /api/cases/:caseId/billing/summary` — Case billing summary by category
- `GET /api/accounting/summary` — Firm-wide billing overview, monthly, top cases

### Communications (Phase 5)
- `GET /api/communications` — Firm-wide communications log (supports ?type filter)
- `GET /api/cases/:caseId/communications` — Case-level comms log
- `POST /api/cases/:caseId/communications` — Log communication
- `DELETE /api/cases/:caseId/communications/:commId` — Delete communication record

### Reports (Phase 4/6)
- `GET /api/reports/overview` — Full analytics: cases by status, by month, lawyer workload, workflow completion, billing totals, comms stats

## Workflow Engine

Case workflow steps are auto-generated at case creation based on:
- **purchaseMode**: `cash` (no loan steps) | `loan` (adds loan path steps)
- **titleType**: `individual` or `strata` → MOT path | `master` → NOA/PA path

Step paths: `common` → `loan` (if loan) → `mot` (individual/strata) or `noa_pa` (master)

## Seed Data (Demo)

**Founder:**
- Email: `founder@lawcaspro.com` / Password: `founder123`

**Firm: Messrs. Tan & Associates (tan-associates)**
- Partner: `partner@tan-associates.my` / `lawyer123`
- Lawyer: `lawyer@tan-associates.my` / `lawyer123`
- Clerk: `clerk@tan-associates.my` / `clerk123`

**Roles:** Partner, Lawyer, Clerk

**Developers:** Platinum Heights Sdn Bhd, Green Valley Development Bhd

**Projects:** Platinum Residences @ KLCC (strata), Platinum Heights Tower B (master), Green Valley Bungalows Phase 2 (individual)

**Clients:** Lee Chong Wei, Nurul Aina binti Abdullah, Kumar Selvam, Wong Mei Ling, Tan Ah Kow

**Cases:** LCP-1-001 through LCP-1-005

## Development Phases

- [x] **Phase 1**: Auth, multi-tenant architecture, CRUD for Users, Roles, Developers, Projects, Clients, Cases, Workflow Engine
- [x] **Phase 2**: Document management — DOCX template upload, docxtemplater field substitution, document generation per case, file upload, download. Object Storage (GCS via Replit). Settings page for template management. Documents tab on case detail.
- [x] **Phase 3**: Accounting — `case_billing_entries` table, billing CRUD per case (with paid toggle), firm-wide accounting dashboard with charts
- [x] **Phase 4**: Reporting — `/reports/overview` aggregation, Reports page with Recharts (cases by status, by month, lawyer workload, workflow completion, billing totals, comms pie chart)
- [x] **Phase 5**: Communications — `case_communications` table, per-case comms log (email/WhatsApp/phone/letter/portal), firm-wide Communications Hub with channel filter
- [x] **Phase 6**: Platform monitoring — enhanced with real metrics (Documents Generated), per-tenant breakdown (Users, Cases, Docs, Billing, Comms columns)
- [x] **Founder Features**: Firm user management (list users per firm, reset any user's password), System Documents page (upload/download/delete platform docs shared with firms), Communication Hub (founder ↔ firm bidirectional messaging with multi-format file attachments)
- [x] **Firm Hub**: `/app/hub` page with Messages tab (thread with Lawcaspro, compose/read, mark-as-read) and System Documents tab (view/download documents shared by platform)

## Design Decisions

- **No Replit Auth** — custom email/password with bcrypt + session tokens
- **No JWT** — server-side sessions in PostgreSQL for security
- **DOCX primary** (docxtemplater) for document generation, PDF secondary
- **SameSite=None; Secure** on auth cookie for cross-origin Replit proxy compatibility
- **No emojis** in UI per user preference
- **Malaysia-specific**: IC numbers, Malaysian developer/project patterns

## User Preferences
- No emojis in UI
- Professional, dense data-rich interface for legal professionals
- Dark navy/slate theme with amber/gold accents
