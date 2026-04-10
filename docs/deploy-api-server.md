# Deploy api-server on Render (Docker)

This repo is a pnpm workspace monorepo. The most stable way to deploy `artifacts/api-server` is to run it on Render as a Docker-based Web Service built from the repo root.

## Render service settings (summary)

- Service type: Web Service
- Environment: Docker
- Root directory: repo root
- Dockerfile path: `artifacts/api-server/Dockerfile`
- Health check path: `/api/healthz`

## Build image (from repo root)

```bash
docker build -f artifacts/api-server/Dockerfile -t lawcaspro-api .
```

## Run locally (Docker)

```bash
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME" \
  lawcaspro-api
```

Health check:

```bash
curl http://localhost:3000/api/healthz
```

## Required environment variables

Minimum required to start:

- `DATABASE_URL` (Postgres connection string)

Provided by Render automatically:

- `PORT` (do not hardcode; the server reads `process.env.PORT`)

Recommended:

- `NODE_ENV` (set to `production`)
- `DATABASE_URL` (Postgres connection string)
- `LOG_LEVEL` (default: `info`)

Supabase Storage (required for private document/object routes):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET_PRIVATE`

Legacy Object Storage (only used by endpoints that still rely on @google-cloud/storage / sidecar):

- `PUBLIC_OBJECT_SEARCH_PATHS` (comma-separated object search roots)
- `PRIVATE_OBJECT_DIR` (object directory root)

## One-time DB setup

Provision a Postgres database (Render Postgres is fine), then apply schema + migrations using the workspace DB package:

```bash
pnpm install
pnpm -C lib/db migrate
pnpm -C lib/db apply-rls
```

## Optional: seed demo accounts (production-safe)

By default, production deployments do NOT auto-seed. Seed runs only when explicitly enabled, and is idempotent (it ensures demo accounts exist rather than assuming an empty DB). To enable seeding, set:

- `SEED_DEMO_DATA=true`
- `SEED_FOUNDER_PASSWORD`, `SEED_PARTNER_PASSWORD`, `SEED_LAWYER_PASSWORD`, `SEED_CLERK_PASSWORD`

You can also override emails/slugs via the other `SEED_*` variables in `artifacts/api-server/.env.example`.
