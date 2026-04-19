# Production Closeout Checklist

This checklist locks down production after demo seeding and baseline recovery work. It focuses on security (secrets hygiene, tenant isolation) and on verifying the system remains usable.

## Why This Matters

- Seed variables must not remain in production because they keep a privileged bootstrap path available (known passwords / account recreation), which increases blast radius if environment access is compromised.
- Database password rotation reduces the risk of credential leakage persistence (old leaked credentials stop working).

## Minimal Manual Steps (Required)

### 1) Rotate Supabase DB password

- In Supabase: rotate the Postgres password for the production database user used by the app.
- Copy the new connection string.

### 2) Update production `DATABASE_URL`

- In the deployment platform (Vercel project env), update `DATABASE_URL` to the rotated connection string.
- Trigger a redeploy (or restart) so the new env is picked up.

### 3) Verify DB health

- Call: `GET https://lawcaspro-v5.vercel.app/api/healthz/db`
- Expect: `{"status":"ok","db":"ok"}`

### 4) Remove *all* seed environment variables from production

In the deployment platform (Vercel project env), delete:

- `SEED_DEMO_DATA`
- `SEED_FOUNDER_PASSWORD`
- `SEED_PARTNER_PASSWORD`
- `SEED_CLERK_PASSWORD`
- Any other `SEED_*` variables (emails, firm slug/name overrides, etc.)

Then redeploy/restart once more.

### 5) Post-closeout verification (must pass)

- Login works for:
  - `lun.6923@hotmail.com` (platform-only)
  - `partner@tan-associates.my` (firm workspace)
  - `clerk@tan-associates.my` (firm workspace)
- Firm workspace pages load without infinite loading:
  - Dashboard, Cases, Projects, Developers, Documents, Communications, Accounting, Reports, Settings
- Permission boundaries hold:
  - Founder cannot access firm endpoints (403)
  - Clerk cannot perform users/roles/settings writes (403 + audit log entry)

## Notes / Preconditions

- Ensure DB migrations are applied (including permissions baseline migration) before expecting RBAC enforcement to behave consistently.

