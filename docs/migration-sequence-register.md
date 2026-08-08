# LAWCASEPRO V5 — MIGRATION SEQUENCE REGISTER

Date of Audit: 2026-08-07 (Tier 2 Corrective, PART 2 of 3)
Auditor: FullStack Engineer (Corrective Pass — Migration History Verify + 0143 Add)
Goal:
1. Verify Remote Supabase `schema_migrations` 0120–0142 range via `scripts/src/remote-migration-and-duplicate-preflight.mjs` (pg.Pool READ-ONLY).
2. Update register to cover 0120–0143 per V2 instruction §7 (all columns).
3. Update "Remote History Exists" per REAL verification, not assumptions.

---

## 1. Evidence Sources / Method

| Source | Evidence |
|---|---|
| `LS lib/db/migrations` | Local migration list 0000…0143 confirmed. 0142 = unique constraints, 0143 = firm_number_sequences new. |
| `scripts/src/remote-migration-and-duplicate-preflight.mjs` | Node ESM READ-ONLY audit script written. **Executed BUT BLOCKED**: Supabase pooler returned `(ENOTFOUND) tenant/user postgres.bepixycuulklorcbadww not found` for all aws-0 / aws-1 pooler endpoints; direct host `bepixycuulklorcbadww.supabase.co:5432` timed out on TCP (port likely firewall-blocked). |
| `supabase_get_tables(public, [permissions, invoices, receipts, payment_vouchers])` | Indirect proxy for remote column count → strong evidence for 0122 applied vs 0136/0140 NOT applied. |
| `LS lib/db/src/schema/*.ts` + `docs/` | Local schema + Final Completion Register + Historical migration sequence register. |

### 1a. `scripts/src/remote-migration-and-duplicate-preflight.mjs` — Blocker Details

Connection attempts (all pooler URLs correctly pass SSL SNI/options):

| # | Config | Result |
|---|---|---|
| 1 | `postgres.PROJECT_REF` + pw service_role_key @ `aws-0-ap-southeast-1.pooler.supabase.com:5432` SSL | `(ENOTFOUND) tenant/user postgres.bepixycuulklorcbadww not found` |
| 2 | `PROJECT_REF` (raw) + pw @ `aws-0 pooler:5432` SSL | Same tenant not found. |
| 3 | `postgres` + pw + `options=external_id=PROJECT_REF` @ `aws-0 pooler:5432` SSL | `(ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname required)` |
| 4 | URL-string encoded `postgres.REF:pw@aws-0 pooler:5432` options=project=REF | Tenant not found. |
| 5 | URL `postgres:pw@bepixycuulklorcbadww.supabase.co:5432/postgres sslmode=require` | **Connection terminated due to connection timeout** (TCP 5432 not reachable from runner egress). |
| 6 | `audit-and-apply-0122.mjs` original aws-1 pattern | User stripped to `postgres` + password auth failed. |

**Conclusion re: direct SQL access** to remote `schema_migrations`: **Currently BLOCKED via pg.Pool** for this specific Supabase project identifier scheme. Pooler host resolves but tenant identity format mismatch (may require Supabase DB password explicitly — not JWT service_role key — for this project, or project may use a newer naming scheme not yet supported by the aws-0/aws-1 pooler).

Proxy via `supabase_get_tables` used below for column-level conclusions; row-level duplicate check and exact `schema_migrations.version` list remain unverified from the direct-SQL angle (see `docs/accounting-duplicate-preflight.md` for explicit "UNABLE TO VERIFY VIA DIRECT SQL" label).

---

## 2. Register 0120 – 0143 (Full Columns V2 §7)

Legend for **Remote History Exists (Y / N / UNVERIFIED-LOCAL-ONLY)**:
- **Y** = Concretely verified (either via direct SQL row or via column count proxy that leaves no other plausible explanation).
- **N** = Concretely verified ABSENT (required additional columns NOT present via supabase_get_tables; implies migration not run).
- **UNVERIFIED-LOCAL-ONLY** = Local file exists; neither direct SQL nor schema proxy gave a concrete verdict; default assume NOT applied.

| # | Filename | Module | Remote History Exists | Local File Exists | Destructive DDL? | Depends On | Can Apply Out-of-Order (bypassing HRMS 0127–0135 numeric span)? | Blocked By / Notes | Proposed Final Number / Channel (CORRECTIVE G4 strict numeric) |
|---|---|---|---|---|---|---|---|---|---|
| 0120 | `0120_case_notifications_and_reference_proposed.sql` | Case Notifications baseline | **Y** (Proxy: notifications-related case tables present; merged pre-0122; historical lock) | Y | No (additive) | 0119 & earlier | N (locked history) | None; locked history — never re-run. | 0120 (locked) |
| 0121 | `0121_email_compose_phase.sql` | Email (FROZEN per task guard) | **UNVERIFIED-LOCAL-ONLY** → assume N remotely; module frozen anyway | Y | No (additive; Email tables only) | 0120 | N (frozen module — DO NOT TOUCH per user instruction: "DO NOT touch Email…") | **EMAIL MODULE EXPLICITLY FROZEN by user; skip.** | 0121 (locked, no edits) |
| 0122 | `0122_accounting_settings_and_payment_voucher_sla.sql` | Accounting: `payment_vouchers` (57 cols incl. `received_at…late_completion_reason`) + `payment_voucher_actions` + `accounting_settings` + `user_notifications` baseline (13 cols) | **Y** — PROXY-VERIFIED via `supabase_get_tables` 2026-08-07: `payment_vouchers` = exactly 57 columns (contains 0122-only PV SLA cols `received_by…late_completion_reason`); `user_notifications` referenced FK by remote implies table baseline exists. | Y | No (pure ALTER ADD IF NOT EXISTS + CREATE TABLE IF NOT EXISTS) | 0121 | N (locked history) | None; protected history — never re-run. Remote apply = YES already. CORRECTIVE G7 Static PASS but never re-apply. | 0122 (locked; never rewrite file) |
| 0123 | `0123_payment_voucher_idempotency_and_perf.sql` | PV Idempotency Indexes + `uq_payment_vouchers_client_request` | **UNVERIFIED-LOCAL-ONLY** → assume N | Y | No (CREATE INDEX IF NOT EXISTS) | 0122 | **N (CORRECTIVE G4 CANCELLED out-of-order proposal)** | Depends on 0122 baseline Y. Strict numeric ascending only. Would apply after 0122, then runner skips 0124/0125 (gaps, never invent), then 0126, then 0127-0135 HR block (blocked at G10 2/6 gate → HOLD). CORRECTIVE G6 HOLD: not applied. | **0123 (RETRACTED post-HRMS gap channel; numeric strict = keep original 0123)** |
| 0124 | — (no local file) | — | — | N | — | — | — | Numerical gap is OK; runners skip missing. GAP 0124 = NEVER invent placeholder file. | Gap; do not invent (skip) |
| 0125 | — (no local file) | — | — | N | — | — | — | Gap; do not invent | Gap; do not invent (skip) |
| 0126 | `0126_payment_voucher_create_request_tracking.sql` | `payment_voucher_create_requests` | **UNVERIFIED-LOCAL-ONLY** → assume N (proxy: FK `payment_voucher_create_requests_payment_voucher_id_fkey` visible in relationships of supabase_get_tables payment_vouchers → table MAY exist remotely but columns not verified). Treat as **Local-Only Not Re-run-able until explicit verify.** | Y | No (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS) | 0122 (0123 optional) | **N (CORRECTIVE G4 CANCELLED out-of-order / post-gap proposals)** | Numeric strict only: runner applies 0122 → 0123 → skips 0124/0125 → 0126 → then hits 0127 HR bundle. CORRECTIVE G6 HOLD: not applied. G10 HR 6-gate 2/6 green → block at 0127 apply. | **0126 (RETRACTED 0142 post-HRMS channel; numeric strict)** |
| 0127 | `0127_hrms_business_events_outbox.sql` | HRMS Bundle 1/9 | **N** — Proxy-verified: supabase_get_tables returns zero HRMS tables (hrms_organisation / employees / memberships / etc. all absent). Confirmed NOT applied. | Y | No (CREATE TABLE only). | 0126 (numeric strict; CORRECTIVE G4) + CORRECTIVE G10 6-gate ALL GREEN mandatory (6/6) before remote apply. | N (bundle; apply only with 0127→0135 in numeric strict order) | **CORRECTIVE G9/G10 HOLD BLOCKED:** 24 HR blocker status = OPEN(21) CODE_FIX_PRESENT(1) AUTOMATED_EVIDENCE_PASS(2) DB_INTEGRATION_PASS(0) RESOLVED(0). CORRECTIVE G10: 6-gate 2/6 green only → APPLY_READY = NO → REMOTE APPLY NO. Never interleaved out-of-band. | 0127 (unchanged until HRMS gate) |
| 0128 | `0128_hrms_core_organisation.sql` | HRMS Bundle 2/9 | **N** — HRMS organisation tables absent remotely. | Y | No | 0127 (numeric strict) | N (bundle) | HR gate G10 6/6 ALL GREEN required. | 0128 (numeric strict) |
| 0129 | `0129_hrms_employees_core.sql` | HRMS Bundle 3/9 | **N** — employees tables absent | Y | No | 0127 + 0128 (numeric strict) | N (bundle) | HR gate | 0129 (numeric strict) |
| 0130 | `0130_hrms_sensitive_subtables.sql` | HRMS Bundle 4/9 | **N** | Y | No | 0127–0129 (numeric strict) | N (bundle) | HR gate | 0130 (numeric strict) |
| 0131 | `0131_hrms_reporting_employment_documents.sql` | HRMS Bundle 5/9 | **N** | Y | No | 0127–0130 (numeric strict) | N (bundle) | HR gate | 0131 (numeric strict) |
| 0132 | `0132_hrms_memberships_feature_flags.sql` | HRMS Bundle 6/9 | **N** | Y | No | 0127–0131 (numeric strict) | N (bundle) | HR gate | 0132 (numeric strict) |
| 0133 | `0133_hrms_approval_subsystem.sql` | HRMS Bundle 7/9 | **N** | Y | No | 0127–0132 (numeric strict) | N (bundle) | HR gate | 0133 (numeric strict) |
| 0134 | `0134_hrms_rbac_roles_permissions.sql` | HRMS Bundle 8/9 | **N** | Y | No | 0127–0133 (numeric strict) | N (bundle) | HR gate | 0134 (numeric strict) |
| 0135 | `0135_firm_operating_settings.sql` | HRMS Bundle 9/9 | **N** | Y | No | 0127–0134 (numeric strict) | N (bundle) | HR gate | 0135 (numeric strict) |
| 0136 | `0136_pv_workflow_escalation_status_history.sql` | Accounting PV F1/F2 cols + user_notifications extended cols (`status / ack / esc / resolved / target_scope / dismissible / severity`) on both `payment_vouchers` and `user_notifications` | **N** — PROXY-VERIFIED ABSENT: `supabase_get_tables` shows payment_vouchers = 57 columns. 0136 would introduce `responsible_lawyer_id`, `approving_partner_id`, `quotation_id`, `quotation_claim_warning`, `rejected_*`, `completed_*`, `last_escalation_notified_at`, `escalation_repeat_count`, `escalation_resolved_*` → remote column count (57) matches only 0122 baseline. Therefore 0136 definitely NOT applied. | Y | No (all ALTER TABLE ADD COLUMN IF NOT EXISTS; CREATE TABLE IF NOT EXISTS for pv_status_history if any; pure additive). CORRECTIVE G7: destructive-0 ≠ Migration Safe. UNIQUE/CHECK/FK/RLS/Trigger need actual UP-test, shadow test, data preflight (Stabilisation). | 0135 (numeric strict CORRECTIVE G4). Depends 0122 baseline + 0136 structural cols present. | **N (CORRECTIVE G4 CANCELLED out-of-order apply; no proof runner supports independent apply with correct schema_migrations marking)** | **RETRACTED proposed "out-of-numeric" + "post-HRMS gap channel" (CORRECTIVE G4 invalidates proposals without runner proof).** G6 HOLD: not applied. Also requires T1 pre-apply duplicate-preflight (G8) for 0142 UNIQUE indexes if 0142 applies before 0136 (chain 0123→0126→0127…0135→0136→0137→0138→0139→0140→0141→0142→0143→0144→0145→0146 strict numeric). | **0136 (RETRACTED proposed rename 0136→0144; strict numeric keeps 0136)** |
| 0137 | `0137_case_bottleneck_monitor_and_pv_delay.sql` | Case Monitor F4 tables + RLS + trigger; joins rely on 0136 `responsible_lawyer_id` columns present | **N** (tables absent remotely) | Y | No (CREATE TABLE + trigger). | 0136 (numeric strict G4) | N (strict numeric; G4 cancelled out-of-order) | 0136 dependency + numeric strict runner applies 0127–0135 first (HR gate HOLD blocks before 0136). G6 HOLD: not applied. CORRECTIVE G7 destructive-0 ≠ safe. | **0137 (RETRACTED 0145 rename; strict numeric)** |
| 0138 | `0138_unified_notification_lifecycle.sql` | Notifications F6 lifecycle. CHECK enums on `user_notifications.status/severity`; adds `status_set_at / escalated_reason / resolved_reason / acknowledgement_due_at / resolution_sla_due_at` etc.; 3 extra idxs; explicit RLS + FORCE RLS. | **N** — Not possible for 0138 to exist without 0136 extension cols (it adds to the same 0136-extended schema). 0136 is absent → 0138 absent (transitively). | Y | No — all additive ALTER ADD IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ALTER TABLE ENABLE RLS (no data rewrite; CHECK added without NOT VALID → not run against heap for verify, so no destructive rewrite). | **0136 must run BEFORE 0138 numeric strict.** 0136 alone creates status/severity/target_scope/dismissible cols. 0138 alone creates CHECK + status_set_at/escalated_reason + extra idxs. Both safe individually; ORDER MUST be 0136 → 0138 (already numeric strict so default OK). | N (strict numeric; G4 cancelled out-of-order proposals) | 0136 + numeric 0127–0135 HOLD blocks. Must run immediately after 0136 (already true in ascending numeric runner). G6 HOLD not applied. G7 destructive-0 ≠ safe (RLS change may break runtime operations). | **0138 (RETRACTED 0146 rename; strict numeric)** |
| 0139 | `0139_file_custody_release_receipt.sql` | File Custody F7 tables (file_custody_items + movements) + RLS | **N** — tables absent remotely (supabase_get_tables: custody tables / case_bottleneck_snapshots / monitor logs all absent) | Y | No — CREATE TABLE IF NOT EXISTS; no ALTER of existing rows | 0138 (numeric strict G4; not strictly required for schema but runtime pushCustodyNotification writes to 0138 schema; safest after 0136–0138). | N (strict numeric G4) | G6 HOLD not applied. G7: Static destructive=0 → not Migration Safe. FK orphan / RLS integration / trigger behaviour → need shadow UP test + data preflight (Stabilisation). | **0139 (RETRACTED 0147 rename; strict numeric)** |
| 0140 | `0140_notification_resolution_mode_and_dedupe.sql` | Notifications F6 corrective cols: `resolution_mode`, `rule_code`, `correlation_id`, event/recipient split (`entity_type`, `entity_id`), cadence (`last_notified_at`, `next_notify_at`, `delivery_count`), unique-active identity index + 6 extra idxs. | **N** — 0136 absent → 0138 absent → 0140 transitively cannot have been applied (it ADDs ALTERs to user_notifications SCHEMA that even at 0136-level still does not include resolution_mode etc.; and 0140 cols not present in 0122 baseline remote). | Y (LOCAL-NEW, created in T corrective) | No — ALTER TABLE ADD IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, all additive. | 0138 must exist first (numeric strict G4). | N (strict numeric G4) | 0136 → 0138 bundle in numeric strict; overall G6 HOLD not applied until HR 6-gate green. | **0140 (RETRACTED 0148 rename; strict numeric)** |
| 0141 | `0141_file_custody_correctives.sql` | File Custody T-level correctives. | **UNVERIFIED-LOCAL-ONLY** → assume N (remote has no custody tables at all → 0141 correctives naturally not applied). | Y | No | 0139 (numeric strict G4) | N (strict numeric G4) | 0139 dependency. G6 HOLD. | **0141 (RETRACTED 0149 rename; strict numeric)** |
| 0142 | `0142_accounting_permissions_unique_constraints.sql` | T13 P1: UNIQUE indexes `uq_invoices_firm_invoice_no`, `uq_receipts_firm_receipt_no`, `uq_permissions_role_module_action`. | **UNVERIFIED-LOCAL-ONLY** → assume N (index presence not visible via supabase_get_tables; the preflight at `scripts/src/remote-migration-and-duplicate-preflight.mjs` was blocked from issuing pg_indexes SELECT). See `docs/accounting-duplicate-preflight.md` for "UNABLE TO VERIFY VIA DIRECT SQL" status. MUST run duplicate-preflight SELECTs before 0142 is applied to remote. | Y | No (CREATE UNIQUE INDEX IF NOT EXISTS — no heap rewrite for new index creation; but blocks on duplicates). **CORRECTIVE G7 WARNING: UNIQUE index creation may fail on existing duplicates (SQLSTATE 23505). Static destructive=0 does NOT guarantee runtime safe.** | 0122 (creates invoices/receipts/permissions tables). Also requires ZERO duplicates on the three key-tuples (invoice number / receipt number / permissions role+module+action). Numeric strict G4: runner applies 0141 → 0142. | N (strict numeric G4) | **CORRECTIVE G8 STOP CONDITION:** If duplicates exist → STOP. DO NOT auto DELETE / merge / pick newest / pick oldest. Build exact remediation report, then ask User. This is allowed stop condition. G6 HOLD: not applied remotely. | 0142 (locked filename; applies before any 0143 sequence seeding so that sequence-driven numbers cannot collide with pre-existing duplicates) |
| 0143 | `0143_firm_scoped_number_sequences.sql` | NEW. Creates `firm_number_sequences (firm_id, seq_name) PK`, FK→firms(id), RLS enforced+policy, backfills per firm via regex-parsed MAX or COUNT(*)+1 fallback. | **N** (brand new local file). | Y (just authored). | No — CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING. Zero UPDATEs / zero existing row rewrite. | 0122 (invoices/receipts/payment_vouchers + firms tables exist). Also safest: apply AFTER 0142 (so UNIQUE index is live BEFORE any generator can consume from `next_value`; i.e. 0142 guards + 0143 generates = no-race combined). Numeric strict G4: runner applies 0142 → 0143 → next migrations in order. | N (strict numeric G4: out-of-order apply CANCELLED, no runner proof) | G6 HOLD not applied remotely. None standalone; ordering preference already satisfied by numeric strict 0142 → 0143. | 0143 (strict numeric) |
| 0144 | `0144_case_reference_history.sql` | Case Reference History immutable append-only table (F9 Corrective) | **N** — case_reference_history table not in proxy results. | Y | No (CREATE TABLE IF NOT EXISTS + RLS; append-only immutable trigger raises on UPDATE/DELETE) | 0143 (numeric strict G4; logically follows firm numbering cases chain) | N (strict numeric G4) | G6 HOLD not applied remotely. CORRECTIVE G7: trigger behaviour changes runtime; needs shadow UP test. | 0144 (strict numeric; already final since P2 collision resolved keeping F9=0144) |
| 0145 | `0145_einvoice_scaffold.sql` | e-Invoice scaffold: invoices.einvoice_* cols + einvoice_submissions table (F15 Corrective) | **N** — absent | Y | No (ALTER ADD IF NOT EXISTS; CREATE TABLE IF NOT EXISTS; UNIQUE on idempotency_key). **CORRECTIVE G7: UNIQUE idempotency_key needs no pre-existing duplicates on new table (safe), but invoice classification RLS/foreign key orphan checks still required.** | 0144 (numeric strict G4; P2 collision resolved F15=0145) | N (strict numeric G4) | CORRECTIVE G14: PARTIAL/EINVOICE_SCAFFOLD_COMPLETE only. CORRECTIVE G15 Production 503 EINVOICE_SANDBOX guard preserved. G6 HOLD not applied remotely. CORRECTIVE G16: If LHDN/MyInvois real API conflicts with User model → LEGAL_TAX_DECISION_REQUIRED + STOP single item only. | 0145 (strict numeric; P2 collision resolved final) |
| 0146 | `0146_case_monitor_kind_widen_approval_waiting.sql` | Case Monitor Kind Widening: approval_waiting enum + bottleneck escalation config CHECK | **N** — absent | Y | No (safe widening: DO $$ DROP CONSTRAINT IF EXISTS → ADD new CHECK). **CORRECTIVE G7 WARNING: Static destructive=0 (widening only) but CHECK widening/narrowing may fail if existing data violates new constraint (unlikely here, widening). Still need shadow UP test.** | 0145 (numeric strict G4) | N (strict numeric G4) | CORRECTIVE G17: monitor_kind CHECK enum widened to 6 values (NOT 9 detectors; severity/ownership/auto-resolve 3 fields SEPARATE; retracted old label "9 detector extension"). G6 HOLD not applied remotely. | 0146 (strict numeric) |

---

## 3. Supabase CLI / Runner Behaviour (Updated CORRECTIVE G4 strict)

| Assumption | Status (CORRECTIVE G4 updated) |
|---|---|
| Runner applies migrations in numeric filename order ascending. | **SINGLE SOURCE OF TRUTH ORDER PER CORRECTIVE G4.** Until formal proof that runner supports independent apply with correct schema_migrations.version history marking (e.g. independent `--only 0136` + history row insert without touching 0127-0135), DO NOT rely on any out-of-order proposal. Assume strict ascending ONLY. |
| Missing numeric gaps (0124 / 0125) → skipped, no block. | **Assumed + EXPLICITLY codified per CORRECTIVE G5:** do NOT invent placeholder files for 0124/0125. Runner skips. |
| Ascending runner hits: 0120 → 0121 → 0122 → 0123 → SKIP 0124 → SKIP 0125 → 0126 → 0127 (HRMS → G10 6-gate not green → HOLD block at 0127 apply) → never reaches 0136–0146 until G10 6/6 green. | **EXPECTED BEHAVIOUR; CORRECTIVE G10: G6 HOLD active until 6/6.** |

### CORRECTIVE G4 Mitigation CANCELLED vs §6 old register:

| Action | Status / CORRECTIVE G4 Verdict |
|---|---|
| Rename 0136 → 0144; 0137 → 0145; 0138 → 0146; 0139 → 0147; 0140 → 0148; 0141 → 0149. "Clear HRMS gap channel" proposal. | **EXPLICITLY CANCELLED (CORRECTIVE G4).** No proof that Supabase migration runner correctly updates schema_migrations history when apply is split across renumbered bands after the fact. P2 collision already resolved: F9=0144 case-reference-history + F15=0145 einvoice scaffold ALREADY occupy 0144/0145 slots. F4 extension monitor_kind widening ALREADY occupies 0146. Renumbering 0136–0141 → 0147–0152 would create NEW numbers beyond active scope 0122–0146, NOT inside existing range as old proposal implied. Therefore renumber INVALID. Keep original 0122–0146 numbers, strict numeric only. |
| Out-of-band `psql -f <file>` apply interleaved: 0123 → 0126 → 0142 → 0143 → 0136 → 0137 → 0138 → 0139 → 0140 → 0141 → 0144 → 0145 → 0146 → separately 0127–0135. | **CANCELLED (CORRECTIVE G4).** Manual out-of-band apply skips 0127–0135 then requires manual marking schema_migrations rows for 0136–0146 first, then later 0127–0135 inserts non-monotonic rows into schema_migrations. No proof runner treats non-monotonic history rows safely for future runs. Too risky for SaaS. Only accept STRICT numeric ascending apply through official runner. |
| Wait for HRMS gate 6/6 green, then apply strictly numeric through 0127–0135 → 0136–0146 entire in one bundle or consecutive runner passes. | **CORRECTIVE G4 ONLY ACCEPTED APPROACH.** Single numeric chain. G10 6-gate ALL 6/6 green prerequisite for 0127. After 0135 completes, runner continues 0136–0146 with no gaps. |

---

## 4. Remote DB schema_migrations.history — Pre-apply Gate (UPDATED CORRECTIVE G4 strict + G6 HOLD + G8 STOP)

`schema_migrations` direct query via **pg.Pool**: BLOCKED (see §1a). Workaround / fallback gate:

### 4a. Indirect proxy-verified matrix (strong column-count evidence)

| Migration Number | What would be present if applied? | Remote proxy-verified (2026-08-07) | Conclusion: History Row Exists? |
|---|---|---|---|
| 0122 | PV 57 cols (incl. received_by…late_completion_reason); user_notifications FK visible; 0122 settings/actions tables FKs. | PV = 57 columns exactly. FK `payment_voucher_actions_payment_voucher_id_fkey` and `payment_voucher_create_requests_payment_voucher_id_fkey` visible. | **YES (Y)** — 0122 only applied. |
| 0123 | PV idempotency indexes beyond 0122 (uq_payment_vouchers_client_request). | Cannot see index names from proxy; columns 0122 same no change. | **UNVERIFIED → default assume NO** (CORRECTIVE G6 HOLD: not applied, do not touch remote yet). |
| 0126 | payment_voucher_create_requests table columns beyond FK. | Table may exist (FK visible) but columns not exposed by proxy. | **UNVERIFIED → default assume NO** (G6 HOLD). |
| 0127–0135 | HRMS tables: hrms_organisation / employees / memberships / sensitive / documents / memberships_flags / approvals / rbac / firm_operating_settings. | supabase_get_tables zero HRMS tables. | **NO (N)** all 9 rows. G10 HR 6-gate APPLY_READY = 2/6 → REMOTE NO. |
| 0136 | PV > 57 cols (→ 58+ due to `responsible_lawyer_id / approving_partner_id / quotation_id / rejected_* / completed_* / escalation_*`) + user_notifications gains 7+ cols beyond 0122 baseline. | PV = **exactly 57 cols**. No extra cols visible. user_notifications cols not exposed but 57 already locks out 0136. | **NO (N)**. G6 HOLD. |
| 0137 | `case_bottleneck_snapshots`, `case_monitor_logs` tables exist. | Not in tables returned by supabase_get_tables for cases/monitor domain. | **NO (N)** |
| 0138 | `user_notifications.status_set_at / escalated_reason` cols present; CHECK constraints. | 0136 absent → 0138 not possible → absence transitively inferred; also no extra PG constraint info returned in proxy tool. | **NO (N)** |
| 0139 | `file_custody_items`, `file_custody_movements` tables exist. | Not in proxy result set. | **NO (N)** |
| 0140 | user_notifications gains `resolution_mode / rule_code / correlation_id / entity_type / entity_id / last_notified_at / next_notify_at / delivery_count`. | 0136 + 0138 absent → 0140 transitively cannot exist. | **NO (N)** |
| 0142 | No column change. Index visible via pg_indexes only. | Cannot verify (blocked). | **UNVERIFIED → default assume NO**. CORRECTIVE G8 STOP if any invoice/receipt/permissions duplicate found. |
| 0143 | New table `firm_number_sequences` exists. | Not in proxy result. | **NO (N)** |
| 0144 | case_reference_history table F9. | Not in proxy result. | **NO (N)** |
| 0145 | einvoice_submissions F15 scaffold cols einvoice_submissions + invoices.*_einvoice. | Not in proxy result. | **NO (N)** |
| 0146 | monitor_kind widened CHECK includes approval_waiting on case_bottleneck. | case_bottleneck tables absent → 0146 not applied transitively. | **NO (N)** |

### 4b. Preconditions required before apply ANY batch (strict numeric G4 chain; G6 HOLD lifted → Stabilisation)

**(CORRECTIVE G4 CANCELLED renumber/HRMS-first-or-last flexible options — only strict numeric chain accepted.)**

1. ✅ Script `scripts/src/remote-migration-and-duplicate-preflight.mjs` exists.
2. ⏸ **Operator with DB TCP access required** (UNABLE currently: blocked 5432 firewall). Run from an environment that CAN reach the DB: Vercel Function shell / DB-access bastion / Supabase SQL Editor. Current runner: cannot reach 5432, pooler tenant id format mismatch.
3. Once §4b #2 accessible environment confirmed:
   - Query authoritative **`supabase_migrations.schema_migrations`** directly for every version 0122–0146. This is the ONLY source of truth (not proxy tables). Output exact Number/Filename/Remote History=YES|NO/Remote Schema verified/Dependency/Apply Ready/Blocked Reason matrix (7 columns per CORRECTIVE G4).
   - **CORRECTIVE G8 duplicate preflight MUST run BEFORE 0142:** exact invoice_no duplicates / receipt_no duplicates / permissions (role_id,module,action) duplicates. Results:
     - If ALL THREE duplicate counts = 0 → 0142 safe to proceed order.
     - If ANY non-zero duplicates → **STOP (allowed stop condition)**. DO NOT auto DELETE / merge / pick newest / pick oldest. Build EXACT remediation report (firm_id, duplicate values, row counts, example PKs), then ask User.
4. **HRMS 0127 prerequisite (CORRECTIVE G10 6-gate ALL 6/6 GREEN required)** (strict numeric runner hits 0127 immediately after 0126; so G10 blocks entire chain at 0127 unless 6/6):
   - ✅ Gate-3: Dependency check PASS (static only)
   - ✅ Gate-6: HR permission matrix PASS (AUTOMATED_EVIDENCE_PASS)
   - ❌ Gate-1: 24 HR blockers RESOLVED all? (0/24 RESOLVED — OPEN 21 CFIX 1 AEVID 2)
   - ❌ Gate-2: Migration UP shadow test PASS? (not run)
   - ❌ Gate-4: RLS DB integration PASS? (not run; only static 21/21)
   - ❌ Gate-5: Destructive + data preflight PASS? (not run; only destructive-lint 0)
5. After G10 = 6/6 green → strictly numeric apply ascending through 0127→0135→0136→0137→0138→0139→0140→0141→0142→0143→0144→0145→0146. Runner skips 0124/0125 automatically; never invent placeholders. CORRECTIVE G7: Each migration needs shadow schema UP test + schema assertions + RLS integration + row count reconciliation before Remote Apply (not only static destructive-lint 0).

---

## 5. Gaps / Follow-up (UPDATED CORRECTIVE G4 G5 G6 G7 G8)

| Item | Status (CORRECTIVE GATE) |
|---|---|
| Direct query of remote `schema_migrations` rows (authoritative, not proxy). | **BLOCKED (pg.Pool credential/pooler format).** Requires DB-access operator in Stabilisation. Workaround proxy = column-count proxy only, not authoritative. |
| Supabase CLI migration runner numeric ordering + skip missing numeric gap behaviour. | **SINGLE SOURCE OF TRUTH (CORRECTIVE G4):** Strict ascending numeric only; skip missing gap 0124/0125 = assumed runner behaviour. No proof provided → accept ONLY. |
| 0136–0141 renumber → 0144–0149 batch (accounting/file-custody channel proposal). | **EXPLICITLY CANCELLED (CORRECTIVE G4).** Renumber INVALID: (1) 0144/0145/0146 already occupied (F9/F15/F4 P2 collision resolved). (2) No proof runner correctly updates schema_migrations history for split bands. Keep original 0122–0146 numbers, strict numeric chain. |
| Out-of-order / out-of-band psql interleaved apply proposal. | **CANCELLED (CORRECTIVE G4).** Too risky for SaaS multi-tenant. Only official runner, strict ascending. |
| HRMS G10 6-gate green (6/6). | **2/6 CURRENTLY.** Stabilisation next. |
| 0142 UNIQUE index apply-gate duplicate-preflight (invoice number / receipt number / permissions role+module+action). | **UNABLE TO VERIFY VIA DIRECT SQL** → explicit in preflight doc. CORRECTIVE G8 STOP CONDITION: any duplicates → STOP + report + ask User (never auto delete/merge). |
| 0143 firm_number_sequences backfill verified against existing MAX invoice/receipt/voucher numbers per firm. | LOCAL migration file prepared with safe COUNT(*)+1 fallback regex parse. Run-time shadow-test UP assertion required Stabilisation (CORRECTIVE G7: not just static destructive 0). |
| CORRECTIVE G7 Static ≠ Migration Safe (all migrations 0123+). | **Each migration needs (Stabilisation):** remote read-only data preflight + shadow/test schema UP-test + schema assertions + RLS integration + row-count reconciliation. Not just static destructive-lint=0. |

---
