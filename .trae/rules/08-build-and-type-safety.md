\# Build and Type Safety Rules



Any code change must preserve monorepo build health.



Mandatory before claiming completion:

\- run `pnpm run typecheck`

\- run `pnpm run build`

\- if change affects one workspace package, also inspect downstream packages impacted by exports/types

\- do not claim success based on file edit only



Never:

\- silence TypeScript with `any`, `as any`, `@ts-ignore`, or by weakening tsconfig unless explicitly approved

\- skip build or typecheck to force deploy

\- fix one package while ignoring downstream breakage in dependent packages



Required output:

\- exact commands run

\- whether typecheck passed

\- whether build passed

\- remaining errors, if any

