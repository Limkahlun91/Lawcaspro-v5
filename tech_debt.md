# Lawcaspro — Known Technical Debts

## TD-001: RLS not embedded in migration lifecycle
**Status**: Open  
**Severity**: Medium  
**Description**: PostgreSQL Row-Level Security policies are applied via a separate `pnpm apply-rls` step that runs a standalone SQL script (`lib/db/scripts/apply-rls.sql`). This step is not automatically triggered by `drizzle-kit migrate`, so adding a new firm-scoped table requires a manual `apply-rls` run.  
**Risk**: A newly added table may go live without RLS if the operator forgets to re-run the script after a migration.  
**Mitigation in place**: `apply-rls.sql` is fully idempotent and the deployment checklist documents the step.  
**Proposed resolution**: Embed `apply-rls.sql` as a post-migration hook or generate per-table RLS migration files. Do not address until a proper migration hook mechanism is chosen.

---

## TD-002: Founder support access uses postgres/BYPASSRLS
**Status**: Open  
**Severity**: Medium  
**Description**: The API server connects to PostgreSQL as the `postgres` superuser (BYPASSRLS=true). Row-Level Security is only enforced when the application explicitly calls `SET ROLE app_user`. Founder platform routes and support-session queries run as the superuser, so they bypass RLS entirely and rely on application-layer filtering (`WHERE firm_id = $1`).  
**Risk**: A bug in the application-layer filter on a founder route could expose cross-tenant data, with no DB-level backstop.  
**Mitigation in place**: Founder routes are gated by `requireFounder` middleware; superuser is not accessible to firm users.  
**Proposed resolution**: Issue a dedicated `founder_user` PostgreSQL role with appropriate RLS policies, and connect founder requests under that role. Do not address until the multi-instance deployment architecture is defined.

---

## TD-003: Re-auth token store is in-memory (single-instance only)
**Status**: Open  
**Severity**: Low (current), High (if multi-instance)  
**Description**: Short-lived re-auth tokens are stored in a Node.js `Map` in the API server process. If the application is scaled horizontally (multiple instances / replicas), a re-auth token issued by instance A will not be recognised by instance B.  
**Risk**: Re-auth flows fail randomly under horizontal scaling.  
**Mitigation in place**: Currently single-instance deployment. Tokens expire in 5 minutes and are single-use, limiting attack surface.  
**Proposed resolution**: Migrate the re-auth token store to Redis (with TTL) or a dedicated short-lived `reauth_tokens` database table before any horizontal scaling is introduced.
