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

