# Accounting Duplicate Preflight Report

- **Date**: 2026-08-07
- **Auditor**: Autonomous Agent (Lawcaspro-v5 Bulk Implementation PART 2)
- **Source Script**: `scripts/src/remote-migration-and-duplicate-preflight.mjs`
- **Target Migrations**: 0142 (`accounting_permissions_unique_constraints`) + 0143 (`firm_scoped_number_sequences`)

---

## ⚠️ Blocker: Direct Remote SQL Connectivity Unavailable

The preflight script `remote-migration-and-duplicate-preflight.mjs` was executed but **could not establish a live pg.Pool connection** to the remote Supabase database. All 6 candidate connection configurations failed:

| # | Endpoint Pattern | Failure Mode |
|---|---|---|
| 1 | `DATABASE_URL` / `ADMIN_DATABASE_URL` / `AUTH_DATABASE_URL` | Not set in environment |
| 2 | `LAWCASPRO_SUPABASE_*` → aws-1 pooler (user=`postgres.<projectRef>`) | `ENOTFOUND` — tenant `postgres.bepixycuulklorcbadww.supabase.co` not found |
| 3 | `LAWCASPRO_SUPABASE_*` → aws-1 pooler (user=`postgres`) | `password authentication failed` — tenant routing requires prefix |
| 4 | `LAWCASPRO_SUPABASE_*` → aws-0 pooler (user=`postgres@aws-0`) | `ENOIDENTIFIER` — no tenant identifier (external_id / sni_hostname required) |
| 5 | Direct host `bepixycuulklorcbadww.supabase.co:5432` | `Connection timeout` — outbound 5432 blocked by runner egress firewall |
| 6 | Alternative guessed hostnames (`db.<ref>.supabase.co`, `<ref>.pooler.supabase.com`) | `ENOTFOUND` — hostnames not resolvable |

**This means Sections 1 and 2 below CANNOT be verified from this runner.** The script itself is fully functional and MUST be re-executed from a network that has egress to Supabase pooler endpoints (or from inside Vercel/Supabase project network).

---

## §1 Duplicate Rows Status

### 1.1 Preflight SELECTs (as specified by task)

The script runs EXACTLY these three SELECTs (read-only, no DDL/DML):

```sql
-- invoices duplicates
SELECT firm_id, invoice_no, COUNT(*)
  FROM invoices
 WHERE invoice_no IS NOT NULL
 GROUP BY firm_id, invoice_no
HAVING COUNT(*) > 1;

-- receipts duplicates
SELECT firm_id, receipt_no, COUNT(*)
  FROM receipts
 WHERE receipt_no IS NOT NULL
 GROUP BY firm_id, receipt_no
HAVING COUNT(*) > 1;

-- permissions duplicates
SELECT role_id, module, action, COUNT(*)
  FROM permissions
 GROUP BY role_id, module, action
HAVING COUNT(*) > 1;
```

### 1.2 Duplicate Rows Result Table

| table | duplicate_key_tuple | count_groups_detected | row_ids | created_at_first | created_at_last | referenced_records | possible_remediation |
|---|---|---|---|---|---|---|---|
| `invoices` | `(firm_id, invoice_no)` | **UNABLE TO VERIFY VIA DIRECT SQL** — run preflight script from a network with DB access first | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED — check `case_invoices` / `invoice_items` / `payment_allocations` FK references to invoice id before merge/delete | Keep highest `id` (latest); reassign children; delete duplicate; reseq `firm_number_sequences.next_value` if needed |
| `receipts` | `(firm_id, receipt_no)` | **UNABLE TO VERIFY VIA DIRECT SQL** — run preflight script from a network with DB access first | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED — check `receipt_allocations` / `transaction_entries` FK references | Keep highest `id`; reassign children; delete duplicate; reseq `firm_number_sequences.next_value` if needed |
| `permissions` | `(role_id, module, action)` | **UNABLE TO VERIFY VIA DIRECT SQL** — run preflight script from a network with DB access first | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED — check `role_permissions` / audit log references | Keep oldest `id`; delete newer duplicates (same semantic triple = same permission intent) |

### 1.3 Low-Risk Proxy Signal (from `supabase_get_tables`)

Indirect evidence from Supabase management API proxy (NOT a substitute for the direct SQL):

| table | live_rows_estimate (approx) | column_count | risk_assessment |
|---|---|---|---|
| invoices | ~0 | 19 | LOW — no rows, so no duplicates possible |
| receipts | ~2 | 17 | VERY LOW — only 2 rows; run direct SQL to confirm |
| permissions | ~12 | 6 | LOW — 12 rows for all roles × modules × actions is plausible for seed; run direct SQL to confirm |

**Audit Gate — CANNOT YET DECLARE:**
- ❌ `ZERO DUPLICATE ROWS DETECTED` — Not verified. Must run the 3 SELECTs on a live connection first.
- Until verified, migration `0142_accounting_permissions_unique_constraints.sql` **MUST NOT** be run in production. If duplicates exist, `CREATE UNIQUE INDEX IF NOT EXISTS` will FAIL mid-transaction and roll back, leaving no harm but also no unique protection.

---

## §2 UNIQUE Index Status

### 2.1 Target Indexes (defined in 0142 migration)

| # | index_name | table | uniqueness scope |
|---|---|---|---|
| 1 | `uq_invoices_firm_invoice_no` | `invoices` | UNIQUE (firm_id, invoice_no) WHERE invoice_no IS NOT NULL |
| 2 | `uq_receipts_firm_receipt_no` | `receipts` | UNIQUE (firm_id, receipt_no) WHERE receipt_no IS NOT NULL |
| 3 | `uq_permissions_role_module_action` | `permissions` | UNIQUE (role_id, module, action) |

### 2.2 Catalog Queries (as specified by task)

The script queries BOTH catalog sources:

```sql
-- source A: pg_indexes
SELECT schemaname, tablename, indexname, indexdef
  FROM pg_indexes
 WHERE indexname IN (
   'uq_invoices_firm_invoice_no',
   'uq_receipts_firm_receipt_no',
   'uq_permissions_role_module_action'
 );

-- source B: pg_constraint + information_schema (for constraint-backed unique)
SELECT tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type
  FROM information_schema.table_constraints tc
 WHERE tc.constraint_name IN (
   'uq_invoices_firm_invoice_no',
   'uq_receipts_firm_receipt_no',
   'uq_permissions_role_module_action'
 );
```

### 2.3 UNIQUE Index Result Table

| table | index_name | present_remotely? | evidence (pg_indexes + pg_constraint) | notes |
|---|---|---|---|---|
| `invoices` | `uq_invoices_firm_invoice_no` | **UNABLE TO VERIFY VIA DIRECT SQL** — run preflight script from a network with DB access first | UNVERIFIED — both `pg_indexes.indexname` and `information_schema.table_constraints.constraint_name` must be queried live | 0142 migration uses `CREATE UNIQUE INDEX IF NOT EXISTS` (NOT constraint form), so only `pg_indexes` row is expected. |
| `receipts` | `uq_receipts_firm_receipt_no` | **UNABLE TO VERIFY VIA DIRECT SQL** — run preflight script from a network with DB access first | UNVERIFIED | Same note — index-backed, not constraint-backed. |
| `permissions` | `uq_permissions_role_module_action` | **UNABLE TO VERIFY VIA DIRECT SQL** — run preflight script from a network with DB access first | UNVERIFIED | Same note. |

**Audit Gate — CANNOT YET DECLARE:**
- ❌ `UNIQUE INDEX ALREADY PRESENT REMOTELY` — Not verified for any of the 3 indexes.

---

## §3 Schema Migrations History Status

| Source | Rows Retrieved? | version range covered |
|---|---|---|
| `public.schema_migrations` | **UNABLE TO VERIFY** — blocked by pg.Pool connectivity | N/A |
| `supabase_migrations.schema_migrations` | **UNABLE TO VERIFY** — blocked by pg.Pool connectivity | N/A |

See `docs/migration-sequence-register.md` §1a and §4a for full evidence matrix, including proxy-verified conclusions for 0122 (Y via payment_vouchers=57 cols) and 0136–0140 (N transitively).

---

## §4 How to Re-Run Preflight (Operator Instructions)

From a machine/runner with egress to Supabase pooler endpoints:

```bash
# 1. Ensure env vars are set (DO NOT commit these)
export LAWCASPRO_SUPABASE_URL="https://<project-ref>.supabase.co"
export LAWCASPRO_SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOi...<service-role-jwt>...3NpZ25lZA"

# 2. Alternatively use a direct pooler/DATABASE_URL if you have one
# export DATABASE_URL="postgresql://postgres:<pwd>@<pooler-host>:6543/postgres?pgbouncer=true&sslmode=require"

# 3. Run
cd scripts
node --experimental-vm-modules src/remote-migration-and-duplicate-preflight.mjs
```

Expected output:
- 4 console tables: schema_migrations rows, invoices duplicates, receipts duplicates, permissions duplicates, unique indexes
- Final `console.log(JSON.stringify(summary, null, 2))` with full machine-readable payload

**Operator action required after successful run:**
1. Copy the JSON summary into this document under §1.2 and §2.3, replacing "UNABLE TO VERIFY" cells.
2. If ZERO duplicate rows → explicitly record `ZERO DUPLICATE ROWS DETECTED` in §1.3 and remove the ❌ gate.
3. If UNIQUE indexes already present → explicitly record `UNIQUE INDEX ALREADY PRESENT REMOTELY` per index in §2.3 and remove the ❌ gate.
4. Update `docs/migration-sequence-register.md` column "Remote History Exists" for each 0120–0142 migration based on actual schema_migrations.version rows.
5. Then proceed to apply 0142, then 0143, then 0136–0140 (after HRMS blockers resolved).

---

## §5 Remediation Playbooks (Reference — Only Execute If Duplicates Found)

### 5.1 invoices duplicate (firm_id, invoice_no)
```sql
-- Step 1: Identify winners (keep latest id per group; adjust criteria as needed)
WITH dups AS (
  SELECT id, firm_id, invoice_no, created_at,
         ROW_NUMBER() OVER (PARTITION BY firm_id, invoice_no ORDER BY id DESC) AS rn
    FROM invoices
   WHERE (firm_id, invoice_no) IN (
           SELECT firm_id, invoice_no FROM invoices
            WHERE invoice_no IS NOT NULL
            GROUP BY firm_id, invoice_no HAVING COUNT(*)>1
         )
)
SELECT * FROM dups ORDER BY firm_id, invoice_no, rn;

-- Step 2: Reassign child rows (case_invoices, invoice_items, payment_allocations, etc.)
--         from rn>1 ids to rn=1 id

-- Step 3: DELETE FROM invoices WHERE id IN (<rn>1 ids list>);

-- Step 4: Reseed firm_number_sequences for invoice_no if max > current next_value
```

### 5.2 receipts duplicate (firm_id, receipt_no)
Same playbook pattern as invoices — swap table name, FK references target receipt_allocations / transaction_entries.

### 5.3 permissions duplicate (role_id, module, action)
```sql
WITH dups AS (
  SELECT id, role_id, module, action, created_at,
         ROW_NUMBER() OVER (PARTITION BY role_id, module, action ORDER BY id ASC) AS rn
    FROM permissions
   WHERE (role_id, module, action) IN (
           SELECT role_id, module, action FROM permissions
            GROUP BY role_id, module, action HAVING COUNT(*)>1
         )
)
SELECT * FROM dups ORDER BY role_id, module, rn;
-- keep rn=1 (oldest), delete rn>1 (newer duplicates of same semantic grant)
```

**WARNING**: Always take a `pg_dump` snapshot of the target tables before any remediation DELETE.
