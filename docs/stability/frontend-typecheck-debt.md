# Frontend Typecheck Debt

## Context
- Root `pnpm run typecheck` currently excludes `@workspace/lawcaspro` and `@workspace/lawcaspro-mobile`.
- This means the Production frontend is not covered by the normal workspace TypeScript gate.
- The auth P0 should not be blocked by this pre-existing gap, but it must remain visible.

## Known Problem
- `pnpm -C artifacts/lawcaspro run typecheck` is not part of the current root validation path.
- The frontend has unresolved TS2307/path-alias or module-resolution debt that needs dedicated repair.

## Follow-up Task
1. Reproduce the exact `artifacts/lawcaspro` typecheck failures in isolation.
2. Repair the TS2307/path-alias or module-resolution issues without weakening TypeScript rules.
3. Add `artifacts/lawcaspro` to CI and root typecheck coverage.
4. Re-run full workspace validation after the frontend typecheck path is restored.

## Out Of Scope For This Incident
- No frontend alias refactor is included in the current auth/custom-variable incident fix.
