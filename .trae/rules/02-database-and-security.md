\# Database and Security Rules



All firm data must respect tenant isolation.



Mandatory:

\- scope firm data by firm\_id where applicable

\- never expose one firm's data to another

\- never expose founder/platform data to firms

\- respect auth, RBAC, RLS, and consent rules

\- audit sensitive actions



Before schema changes:

\- inspect existing tables and relations

\- reuse current patterns when possible

\- prefer additive migrations

\- add indexes and foreign keys where needed

\- seed permissions for new features



Sensitive actions requiring audit:

\- role or permission changes

\- approval actions

\- financial actions

\- document generation

\- founder access

\- consent changes

\- workflow overrides

