# API Route Safety Rules

For Express/Fastify style handlers:

Mandatory:
- normalize all `req.params.*`, `req.query.*`, and similar values before use
- never pass `string | string[] | undefined` directly into parseInt, DB filters, service calls, or validators expecting `string`
- use a shared helper for single-value extraction

Example standard:
const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

Rules:
- parse only normalized values
- return 400 for missing/invalid required params
- route handlers must return consistently across all branches
- do not leave partial response branches without `return`