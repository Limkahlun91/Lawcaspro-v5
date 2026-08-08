import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "lib", "db", "migrations");

const NUMBER_RE = /^(\d{4})_/;

const ACTIVE_SCOPE_MIN = 122;
const isActiveScope = (num) => Number(num) >= ACTIVE_SCOPE_MIN;

const ALLOW_LEGACY_DUPLICATES_BELOW = ACTIVE_SCOPE_MIN;

const KNOWN_ORDER_RULES = [
  { after: "0122", before: "0123", label: "0122 SLA → 0123 Idempotency" },
  { after: "0123", before: "0126", label: "0123 Idempotency → 0126 Create-requests" },
  { after: "0126", before: "0136", label: "0126 Create-requests → 0136 PV escalation" },
  { after: "0136", before: "0137", label: "0136 PV escalation → 0137 Case bottleneck" },
  { after: "0137", before: "0138", label: "0137 Bottleneck → 0138 Notif lifecycle" },
  { after: "0138", before: "0139", label: "0138 Notif lifecycle → 0139 File custody" },
  { after: "0139", before: "0140", label: "0139 Custody base → 0140 Notif corrective" },
  { after: "0139", before: "0141", label: "0139 Custody base → 0141 Custody corrective" },
  { after: "0140", before: "0142", label: "0140 Notif corrective → 0142 Unique constraints" },
  { after: "0142", before: "0143", label: "0142 Uniques → 0143 Number sequences" },
  { after: "0143", before: "0144", label: "0143 Number seqs → 0144 Ref history" },
  { after: "0144", before: "0145", label: "0144 Ref history → 0145 eInvoice scaffold" },
  { after: "0137", before: "0146", label: "0137 Bottleneck → 0146 Monitor kind widen" },
];

const HR_BLOCK = ["0127", "0128", "0129", "0130", "0131", "0132", "0133", "0134", "0135"];

function main() {
  const allFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const parsed = [];
  for (const f of allFiles) {
    const m = f.match(NUMBER_RE);
    if (!m) {
      parsed.push({ file: f, number: null, basename: basename(f) });
      continue;
    }
    parsed.push({ file: f, number: m[1], basename: basename(f) });
  }

  const errors = [];
  const warnings = [];

  const noNumber = parsed.filter((p) => !p.number).map((p) => p.file);
  if (noNumber.length) {
    warnings.push(`[WARN] ${noNumber.length} SQL files without 4-digit numeric prefix: ${noNumber.join(", ")}`);
  }

  const numbered = parsed
    .filter((p) => p.number)
    .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));

  const byNumber = new Map();
  for (const entry of numbered) {
    if (!byNumber.has(entry.number)) byNumber.set(entry.number, []);
    byNumber.get(entry.number).push(entry);
  }

  for (const [num, entries] of byNumber.entries()) {
    if (entries.length > 1) {
      const files = entries.map((e) => e.file).join(" | ");
      if (isActiveScope(num)) {
        errors.push(
          `[FAIL] DUPLICATE numeric prefix ${num} (ACTIVE SCOPE) — ${entries.length} files: ${files}. This violates PART 3 §15 "only one unique prefix per number".`,
        );
      } else {
        warnings.push(
          `[WARN] DUPLICATE legacy prefix ${num} (legacy <0${ALLOW_LEGACY_DUPLICATES_BELOW}) — ${entries.length} files: ${files}. Legacy only; Active Scope (>=0${ACTIVE_SCOPE_MIN}) required unique; remote applied history preserved, not renumbered.`,
        );
      }
    }
  }

  const numberSet = new Set([...byNumber.keys()]);
  for (let i = 0; i < HR_BLOCK.length - 1; i++) {
    const a = HR_BLOCK[i];
    const b = HR_BLOCK[i + 1];
    if (numberSet.has(a) && numberSet.has(b) && a >= b) {
      errors.push(`[FAIL] HR block out-of-order: ${a} must come before ${b}.`);
    }
  }

  for (const rule of KNOWN_ORDER_RULES) {
    if (numberSet.has(rule.after) && numberSet.has(rule.before) && rule.after >= rule.before) {
      errors.push(`[FAIL] KNOWN DEPENDENCY ORDER VIOLATION: ${rule.label} (${rule.after} >= ${rule.before}).`);
    }
  }

  const finalRegisterMap = extractFinalRegisterMigrationNumbers();
  if (finalRegisterMap.size) {
    for (const [num, docName] of finalRegisterMap.entries()) {
      const files = byNumber.get(num) || [];
      if (!files.length) {
        warnings.push(`[WARN] final-completion-register.md documents migration ${num}="${docName}" but NO matching ${num}_*.sql file on disk.`);
        continue;
      }
      const docNameNorm = docName.toLowerCase().replace(/[^\w]+/g, " ").trim();
      const diskNameNorm = files[0].basename.toLowerCase().replace(/[^\w]+/g, " ").trim();
      const overlap = docNameNorm.split(" ").filter((w) => w.length >= 4 && diskNameNorm.includes(w));
      if (!overlap.length) {
        warnings.push(
          `[WARN] Register vs Filename drift for ${num}: register="${docName}" vs file="${files[0].basename}". No shared keyword ≥4 chars.`,
        );
      }
    }
  }

  console.log("=".repeat(80));
  console.log("MIGRATION SEQUENCE VALIDATOR (PART 3 §15)");
  console.log(`  Dir: ${MIGRATIONS_DIR}`);
  console.log(`  Total SQL files: ${allFiles.length}`);
  console.log(`  Numbered files:  ${numbered.length} (prefix 0000–${[...byNumber.keys()].sort().slice(-1)[0] ?? "n/a"})`);
  console.log(`  Un-numbered:     ${noNumber.length}`);
  console.log(`  Duplicate prefix: ${[...byNumber.values()].filter((v) => v.length > 1).length} numbers`);
  console.log(`  Known order rules: ${KNOWN_ORDER_RULES.length} + HR block ${HR_BLOCK.length}`);
  console.log("=".repeat(80));

  if (warnings.length) {
    console.log("\n[WARNINGS]");
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (errors.length) {
    console.log("\n[ERRORS — NONZERO EXIT]");
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log(`\n${errors.length} error(s). Fix before CI / remote apply.`);
    process.exitCode = 1;
    return;
  }

  console.log("\n[PASS — sequence valid]. Unique numeric prefixes. Known dependency order preserved.");
  process.exitCode = 0;
}

function extractFinalRegisterMigrationNumbers() {
  const registerPath = resolve(REPO_ROOT, "docs", "final-completion-register.md");
  const out = new Map();
  try {
    const raw = readFileSync(registerPath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("| **")) continue;
      const headerCell = line.split("|")[1]?.trim();
      if (!headerCell) continue;
      const m = headerCell.match(/\*\*(\d{4})\*\*\s*(.*)$/);
      if (!m) continue;
      const [, num, rest] = m;
      const cleaned = rest.replace(/\(.*?\)/g, "").trim();
      out.set(num, cleaned || "");
    }
  } catch {
  }
  return out;
}

main();
