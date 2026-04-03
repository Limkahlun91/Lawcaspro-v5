# Schema and Query Integrity Rules

Never guess database fields.

Mandatory before using any table field:
- inspect the real schema/type definition
- confirm exact field name from source table definition
- reuse existing query helpers/patterns when available

Never:
- invent fields like `fileRef` without schema confirmation
- force-cast query results into custom shapes without narrowing
- use unsafe assertions on DB result rows when generic typing or safe guards are possible

For raw query results:
- prefer typed query helpers
- if casting is unavoidable, narrow through `unknown` and validate shape explicitly