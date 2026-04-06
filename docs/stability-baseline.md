# Stability Baseline

This document captures the current “known-good” baseline for Lawcaspro-v5 after restoring production login, tenant context (RLS), and firm workspace loading.

## Scope

- Goal: freeze a stable baseline for production operations and permission testing.
- Non-goals: new features, UI redesigns, broad refactors.

## What Was Fixed

- Monorepo build health: typecheck/build pipeline restored for deployment.
- API server type safety: fixed query/params typing issues in routes and safer parsing.
- Auth/login: restored login flow and session creation; improved failure-stage visibility in logs.
- Tenant context/RLS: eliminated firm-wide 500s caused by tenant context initialization failures.
- Demo seed: made seed idempotent for missing demo accounts and default-off unless explicitly enabled.

## Supported Login Identities

- Founder (platform-level): `founder@lawcaspro.com` (platform routes only)
- Firm users (tenant-level):
  - Partner: `partner@tan-associates.my`
  - Clerk: `clerk@tan-associates.my`

## Verified Pages (Firm Workspace)

Verified after login as partner/clerk:

- `/app/dashboard`
- `/app/cases`
- `/app/projects`
- `/app/developers`
- `/app/documents`
- `/app/hub` (communications)
- `/app/accounting`
- `/app/reports`
- `/app/settings`

Notes:
- Some firm pages depend on optional backend endpoints; pages should still render with empty states when data is absent.
- Founder is not allowed to enter firm workspace by design; platform-only access is enforced.

## Operational Baseline (Production)

### Health endpoints

- `GET /api/healthz` must return `{"status":"ok"}`
- `GET /api/healthz/db` must return `{"status":"ok","db":"ok"}`

### Demo seed controls

- Seed must be treated as a one-time bootstrap mechanism.
- Seed only runs when `SEED_DEMO_DATA=true` is explicitly set on the API server runtime.
- After seeding is complete, remove all seed-related environment variables from production.

## Rollback

If production becomes unstable after baseline changes:

1. Roll back the deployment to the previous known-good image/revision (Render).
2. Revert the most recent baseline commits in Git and redeploy.
3. If the issue is tenant-context related, validate `SET ROLE app_user` and RLS/app role settings in the database.

## Suggested Tag Name (Do Not Create Automatically)

- `stability-baseline-2026-04-06`

