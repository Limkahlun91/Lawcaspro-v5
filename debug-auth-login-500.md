# Debug Session: auth-login-500
- **Status**: [OPEN]
- **Issue**: Production `POST /api/auth/login` returns generic HTTP 500 for valid-shaped unknown-email and wrong-password submissions, while invalid bodies correctly return 400. Local linked-env reproduction currently shows a DB auth failure during `user_lookup` that degrades to 503, so the live 500 path is still unconfirmed.
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-auth-login-500.ndjson

## Reproduction Steps
1. Send `POST /api/auth/login` with invalid body `{}` and confirm 400.
2. Send `POST /api/auth/login` with valid-shaped unknown email and password, observe Production 500.
3. Send `POST /api/auth/login` with valid-shaped existing/wrong password payload, observe Production 500.
4. Reproduce locally against linked production-like env and compare stage logs and response codes.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | A DB/auth client acquisition or lookup failure occurs before credential classification, and Production escapes the route-level 503 path. | High | Low | Pending |
| B | A surrounding middleware or response/error wrapper throws after the auth route catches an internal error, converting the intended 503/401 into the global 500 envelope. | High | Medium | Pending |
| C | Production runtime config differs from local linked env, causing a different auth DB path than the one reproduced locally. | Medium | Medium | Pending |
| D | Structured logging or error serialization itself throws on the live error object, short-circuiting the route response. | Medium | Medium | Pending |
| E | Session/cookie response handling is reached and fails only for valid-shaped payloads, while invalid body returns earlier. | Low | Medium | Pending |

## Log Evidence
- Local direct API replay with linked `.vercel/.env.production.local`:
  - `local-auth-invalid-2` -> 400 at validation stage.
  - `local-auth-unknown-2` -> route catch reached at `user_lookup`, error class `_DrizzleQueryError`, response 503.
  - `local-auth-wrongpw-2` -> route catch reached at `user_lookup`, error class `_DrizzleQueryError`, response 503.
- Local forced `AUTH_DATABASE_URL` replay:
  - `local-auth-admin-unknown` -> route catch reached at `user_lookup`, error class `Error`, code/sqlState `ENOTFOUND`, response 503.
  - `local-auth-admin-wrongpw` -> same behavior, response 503.
- No local replay reached the global app error handler for `/api/auth/login`.
- Fresh live Production probe on commit `0ec5631b927fd7153000bc87634ebfe435de7c22`:
  - `prod-auth-invalid-728` -> 400.
  - `prod-auth-unknown-728` -> 401 `AUTH_INVALID_CREDENTIALS`.
  - `prod-auth-wrongpw-728` -> 401 `AUTH_INVALID_CREDENTIALS`.

## Verification Conclusion
- Hypothesis A: **Partially confirmed locally**. DB/auth lookup failures can occur at `user_lookup`, but the route catch still converts them to 503 locally.
- Hypothesis B: **Rejected locally**. The surrounding middleware and global error handler were not reached in the local reproductions.
- Hypothesis C: **Likely confirmed**. Local `.vercel` metadata/env is unstable or stale and cannot be treated as runtime-confirmed Production identity.
- Hypothesis D: **Rejected locally**. Logger/error serialization did not prevent the route catch from sending 503 in either local failure path.
- Hypothesis E: **Rejected locally**. The failing local requests never reached membership resolution, session creation, cookie creation, or response success stages.
- Live Production login behavior improved between probes and is no longer reproducing the prior 500 for bad credentials, but the exact historical live exception remains unconfirmed without Vercel runtime-log access.
