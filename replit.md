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
- [ ] **Phase 2**: Document management (DOCX templates, PDF, Replit Object Storage)
- [ ] **Phase 3**: Accounting & invoicing (billing statements, e-invoice UI)
- [ ] **Phase 4**: Reporting & analytics
- [ ] **Phase 5**: Communications (Email/WhatsApp UI structure)
- [ ] **Phase 6**: Founder debug workspace (impersonation, full audit)

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
