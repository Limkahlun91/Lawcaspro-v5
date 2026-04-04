# Deploy api-server (Docker)

This repo is a pnpm workspace monorepo. The most stable way to deploy `artifacts/api-server` on common Node platforms is to run it as a Docker container built from the repo root.

## Recommended target

Run a Docker container on a platform that supports long-running services (Render / Railway / Fly.io / VPS). Avoid serverless for this API server.

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

- `PORT`
- `NODE_ENV` (use `production` in real deployments)
- `DATABASE_URL` (Postgres connection string)

Optional but recommended:

- `LOG_LEVEL` (default: `info`)

Object storage (required for document/object routes that use object storage):

- `PUBLIC_OBJECT_SEARCH_PATHS` (comma-separated object search roots)
- `PRIVATE_OBJECT_DIR` (object directory root)

Note: current object storage integration expects the Replit Object Storage sidecar at `127.0.0.1:1106`. For non-Replit deployments, object-storage-backed endpoints will require a future adapter (e.g. GCS service account / S3).

## One-time DB setup

Provision a Postgres database, then apply schema + migrations using the workspace DB package:

```bash
pnpm install
pnpm -C lib/db migrate
pnpm -C lib/db apply-rls
```

## Optional: seed demo accounts (production-safe)

By default, production deployments do NOT auto-seed. To seed only when the DB is empty, set:

- `SEED_DEMO_DATA=true`
- `SEED_FOUNDER_PASSWORD`, `SEED_PARTNER_PASSWORD`, `SEED_LAWYER_PASSWORD`, `SEED_CLERK_PASSWORD`

You can also override emails/slugs via the other `SEED_*` variables in `artifacts/api-server/.env.example`.

