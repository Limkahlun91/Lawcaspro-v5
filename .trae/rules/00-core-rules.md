\## 🛑 AI CODE INTEGRITY \& ANTI-SHORTCUTTING RED LINES (STRICTLY ENFORCED)



1\. ZERO TOLERANCE \& NO CRITERIA TAMPERING:

&#x20;  - NEVER relax acceptance criteria, add tolerance/soft assertions, or mock away mismatches to make tests pass.

&#x20;  - A test MUST verify exact behavior. Typecheck and build passes are supporting evidence ONLY and NEVER replace behavioral assertions.



2\. FIX THE ROUTE, NEVER ROUTE AROUND THE BUG:

&#x20;  - If a test fails due to a real production API/route bug (e.g. 500 Internal Server Error / 409 Conflict), you MUST fix the production bug.

&#x20;  - NEVER change the test to call a different endpoint or bypass the failing code path just to force a green test result.



3\. PRESERVE PRODUCTION ENCAPSULATION:

&#x20;  - NEVER export internal functions, private methods, or DB queries solely for testing convenience.

&#x20;  - Tests must exercise public contracts or use dedicated, clean test utilities without polluting production module exports.



4\. NO UNEVIDENCED "DEFENCE-IN-DEPTH" IN RECOVERY MODE:

&#x20;  - Do NOT modify working production logic unless you can provide a real, reproducible failing test demonstrating the defect.

&#x20;  - Do NOT add redundant layers, ancestor expansions, or extra wrappers "just in case" or for "potential future edge cases".



5\. BOUNDARY VALIDATION OVER BROAD CATCH-ALLS:

&#x20;  - Do NOT wrap code in broad `try/catch` blocks that silently swallow errors or obscure real programming bugs.

&#x20;  - Use strict boundary type-guards (`isValidBundle()`) at external data ingress points, and fail closed predictably.



\# Core Rules



You are building Lawcaspro-v5, an enterprise multi-tenant legal SaaS for Malaysian law firms.



Always prioritize:

1\. Security

2\. Tenant isolation

3\. Stability

4\. Auditability

5\. Maintainability



Before any change:

\- inspect relevant files first

\- understand current flow

\- identify impacted modules

\- explain root cause or plan

\- then implement safely



Never:

\- guess schema or API

\- break working features silently

\- bypass auth, RBAC, RLS, consent, or audit logs

\- hardcode firm-specific production data

\- perform broad refactors unless requested



Always output:

\- what changed

\- why changed

\- files affected

\- migration/env steps

\- risks or follow-up

