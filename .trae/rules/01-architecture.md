\# Architecture Rules



Lawcaspro-v5 is a modular, multi-tenant SaaS platform.



Main domains:

\- Auth / Identity

\- Firms / Tenancy

\- RBAC / Permissions

\- Case Hub

\- Finance Hub

\- Transactions

\- Document Automation

\- AI Drafting

\- Billing

\- Governance

\- Notifications

\- Audit / Logs



Rules:

\- keep business logic in services, not scattered in UI

\- keep components focused and reusable

\- reuse shared types/constants

\- preserve existing architecture patterns

\- think through database, API, UI, permission, audit, and tenant impact before adding features



Founder is platform-level.

Firm users are tenant-level.

Founder access to firm space must be explicit, controlled, and logged.

