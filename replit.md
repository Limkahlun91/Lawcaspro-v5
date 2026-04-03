# Lawcaspro — Legal Operations System

## Overview
Lawcaspro is a multi-tenant legal operations SaaS designed for Malaysian law firms, specifically focusing on real estate conveyancing cases. Its primary goal is to streamline legal workflows, manage case documents, facilitate communication, and provide financial oversight. The platform offers dedicated, secure workspaces for firm users and a founder/platform administrator. Key capabilities include comprehensive case management, document generation (DOCX and PDF) from templates, client and project tracking, role-based access control, a robust communication hub, detailed billing, quotation generation, and reporting functionalities. Lawcaspro aims to be a complete solution for modern legal practices, enhancing efficiency and compliance.

## User Preferences
- No emojis in UI
- Professional, dense data-rich interface for legal professionals
- Dark navy/slate theme with amber/gold accents

## System Architecture
Lawcaspro is built as a full-stack monorepo using `pnpm` workspaces. The frontend uses React, Vite, Tailwind CSS, Wouter for routing, and React Query for data fetching. The backend is an Express 5 API written in TypeScript, leveraging Drizzle ORM with a PostgreSQL database. Authentication is cookie-based, using bcryptjs for password hashing and SHA-256 for token hashing, stored in HttpOnly cookies. API contracts are defined with OpenAPI specifications, and `orval` codegen generates typed React Query hooks and Zod validators for type safety.

The architecture supports multi-tenancy with distinct routing for the `/platform/*` founder workspace and `/app/*` firm workspace, with firm context derived from the session. Document generation uses `docxtemplater` for DOCX and `pdf-lib` for PDFs, including a visual PDF mapping editor for variable replacement.

UI/UX emphasizes a professional, data-rich interface with a dark navy/slate theme and amber/gold accents. Navigation features a consolidated sidebar with unread notification badges and tabbed layouts. Data models include entities for firms, users, roles, permissions, projects, clients, cases, and various case-related entities. A dynamic workflow engine generates case steps based on `purchaseMode` and `titleType`. Communication is thread-based per case, with unread tracking.

Key features include:
- **Financial Foundation**: Regulatory rules engine for seeded Malaysian rates, a robust quotation engine with auto-calculation, and a comprehensive legal accounting engine supporting invoices, receipts, payment vouchers, and ledger entries.
- **Time & Task Management**: Per-case, per-user billable time tracking and task management with priority, due dates, and status.
- **Compliance Reports**: Generation of Bills Delivered Book, Trust Account Statement, and Matter Aging Report, all accessible via a dedicated reports index.
- **Security & Hardening**: Implemented rate limiting with `express-rate-limit` and security headers with `helmet`. Comprehensive audit logging for authentication and sensitive events. TOTP (Time-based One-Time Password) / 2FA infrastructure for enhanced user security, including a frontend settings tab for management. Support sessions allow founders secure debug access with detailed logging.
- **Robust Database Management**: Schema includes unique indexes, 55 new performance indexes, soft delete for key entities, optimistic locking, and TOTP fields. A robust migration infrastructure is in place.
- **Row-Level Security (RLS)**: PostgreSQL RLS is enforced on 38 firm-scoped tables, ensuring strict tenant isolation. `app_user` role and tenant context setting mechanisms prevent cross-tenant data access.
- **AML/CDD/KYC Compliance**: New schema and routes for managing parties, compliance profiles, CDD checks, risk assessments, sanctions screenings, PEP flags, source of funds/wealth, and suspicious activity notes.
- **Conflict Check Engine**: A sophisticated conflict check system performs name fuzzy matching and exact identifier matching (NRIC/passport/company_reg) against existing cases and parties, with partner-only override capabilities and re-authentication requirements for sensitive actions.
- **Automated Testing**: Extensive test suites using `vitest` and `supertest` cover authentication, tenant isolation, support sessions, case creation, RLS, re-authentication flows, and all compliance/conflict check functionalities.

## External Dependencies
- **PostgreSQL**: Main database, managed by Drizzle ORM.
- **Replit Object Storage (GCS)**: Used for storing document templates and generated case documents.
- **docxtemplater**: For generating DOCX documents.
- **pdf-lib**: For manipulating and generating PDF documents.
- **bcryptjs**: For secure password hashing.
- **Recharts**: For charts and data visualizations.
- **Tailwind CSS**: For frontend styling.
- **Wouter**: For React routing.
- **React Query**: For server state management and data fetching.

## Recent Fixes (Post Phase 2)

### RLS Race Condition (PROD-RLS-001)
`requireFirmUser` middleware now uses session-level `SET` (not `SET LOCAL`) for `app.current_firm_id` so the GUC persists through async query execution. `clearTenantContext()` resets all GUCs before `client.release()`. This resolved firm workspace pages showing blank or stale data.

### TypeScript Build Fixes
- Rebuilt `lib/api-client-react/dist` so `.d.ts` type declarations reflect the latest generated hooks (`useGetMe`, `useLogout`, `useListCases`, etc.).
- Fixed `auth-context.tsx` to import `AuthUser` from the package root (`@workspace/api-client-react`) and added the required `queryKey: getGetMeQueryKey()` to the `useGetMe` call.
- Added `app.set("trust proxy", 1)` to Express so `express-rate-limit` correctly reads client IPs through Replit's reverse proxy (eliminates the trust-proxy warning).