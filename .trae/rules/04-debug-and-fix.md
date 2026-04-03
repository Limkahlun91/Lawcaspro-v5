\# Debug and Fix Rules



Do not guess. Investigate.



Debug flow:

1\. read exact error

2\. inspect full call chain

3\. classify issue:

&#x20;  - UI state

&#x20;  - API/service

&#x20;  - auth/session

&#x20;  - permission/RLS

&#x20;  - schema/migration

&#x20;  - env/config

&#x20;  - build/deploy

4\. fix root cause

5\. check side effects



Priority checks for Lawcaspro-v5:

\- firm\_id binding

\- founder vs firm access

\- consent logic

\- auth hydration

\- middleware redirect loops

\- missing permission seeds

\- stale migrations

\- env mismatch

\- SSR/client mismatch





Never remove security checks just to make UI load.

Never patch around errors without understanding them.



Priority debug order for Lawcaspro-v5:

1\. build/typecheck

2\. env/config mismatch

3\. auth/session

4\. tenant scoping / firm\_id

5\. RBAC / permissions

6\. schema/migration mismatch

7\. SSR/client mismatch

8\. UI state only



Rule:

\- do not debug UI first when build/typecheck is red

\- do not modify runtime code before reading exact compiler error



