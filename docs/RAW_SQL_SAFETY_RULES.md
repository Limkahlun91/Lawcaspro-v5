# RAW SQL Safety Rules

Lawcaspro-v5 uses Postgres with strict tenant isolation. Any raw SQL must preserve:

- Security
- Tenant isolation
- Stability
- Auditability
- Maintainability

## Non-negotiables

- Do not use string concatenation to build SQL from user input.
- Always parameterize queries.
- Never bypass auth / RBAC / RLS checks in application code.
- Never introduce cross-tenant reads/writes (always scope by firm_id where applicable).
- Never log secrets, tokens, cookies, or raw SQL containing sensitive values.

## Migration safety

- Never delete existing migrations.
- Never edit existing migrations once merged/applied.
- Prefer additive changes and idempotent patterns:
  - ADD COLUMN IF NOT EXISTS
  - DROP CONSTRAINT IF EXISTS
  - CREATE INDEX IF NOT EXISTS
- Avoid data-destructive statements:
  - No DROP TABLE
  - No TRUNCATE
  - No blanket DELETE/UPDATE without strict WHERE conditions

## Query safety checklist

- Normalize and validate all request params before use (especially query/params values).
- Ensure the effective firm_id is correctly bound to the request context before querying.
- For founder actions touching firm data, require explicit, consented support access and audit it.
- Use least-privilege DB roles and respect row_security settings.

## Data backfill guidelines

- Backfills must be safe to run multiple times.
- When setting NOT NULL constraints:
  - Backfill NULLs first
  - Set DEFAULTs
  - Only then SET NOT NULL
- Use partial unique indexes when NULL values should be allowed (e.g. UNIQUE ... WHERE col IS NOT NULL).
