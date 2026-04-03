# Generated Code and Export Rules

Generated code must not be mixed with manual exports carelessly.

Rules:
- avoid broad `export *` when generated modules may contain overlapping names
- prefer explicit exports for shared package entrypoints
- do not re-export both runtime schemas and same-named types from the same barrel unless verified safe
- when changing package entrypoints, inspect downstream imports before commit

Mandatory:
- if editing package public exports, run full workspace typecheck and build