import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ALLOWED_STATUSES = [
  "BLOCKED",
  "IN_PROGRESS",
  "DOCUMENTED",
  "CODED",
  "RESOLVED_SIGNED_OFF",
];

const ALLOWED_BLOCKS_APPLY = ["YES", "SOFT"];
const ALLOWED_MIGRATIONS = new Set(
  Array.from({ length: 135 - 127 + 1 }, (_, i) =>
    String(127 + i).padStart(4, "0"),
  ),
);

const EXPECTED_PREFIXES = [
  "0127",
  "0128",
  "0129",
  "0130",
  "0131",
  "0132",
  "0133",
  "0134",
  "0135",
];

const REGISTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../docs/hrms-corrective-blocker-register.md",
);

function main() {
  const raw = readFileSync(REGISTER_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  const rowRegex =
    /^\|\s*(B\d{4}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/;

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(rowRegex);
    if (!m) continue;
    const [, id, migrationCol, issue, status, evidence, blocksApply] = m;
    rows.push({
      id: id.trim(),
      migration: migrationCol.trim(),
      issue: issue.trim(),
      status: status.trim(),
      evidence: evidence.trim(),
      blocksApply: blocksApply.trim(),
      lineNumber: i + 1,
    });
  }

  const errors = [];

  // (1) Blocker ID uniqueness
  {
    const seen = new Map();
    for (const r of rows) {
      const arr = seen.get(r.id) ?? [];
      arr.push(r.lineNumber);
      seen.set(r.id, arr);
    }
    for (const [id, lns] of seen.entries()) {
      if (lns.length > 1) {
        errors.push(`Duplicate Blocker ID ${id} on lines ${lns.join(", ")}`);
      }
    }
  }

  const perMigrationCounts = new Map();
  let applyBlockingCount = 0;
  let softCount = 0;
  let unresolvedCount = 0;
  let resolvedCount = 0;

  for (const r of rows) {
    const prefixMatch = r.migration.match(/^(0\d{3})_?/);
    const prefix = prefixMatch?.[1];
    if (!prefix || !ALLOWED_MIGRATIONS.has(prefix)) {
      errors.push(
        `Line ${r.lineNumber}: Blocker ${r.id} Migration File=[${r.migration}] prefix not in 0127..0135`,
      );
    } else {
      perMigrationCounts.set(
        prefix,
        (perMigrationCounts.get(prefix) ?? 0) + 1,
      );
    }

    if (!ALLOWED_STATUSES.includes(r.status)) {
      errors.push(
        `Line ${r.lineNumber}: Blocker ${r.id} status=[${r.status}] not one of ${ALLOWED_STATUSES.join(", ")}`,
      );
    }
    if (r.status === "RESOLVED_SIGNED_OFF") {
      resolvedCount += 1;
    } else {
      unresolvedCount += 1;
    }

    if (!ALLOWED_BLOCKS_APPLY.includes(r.blocksApply)) {
      errors.push(
        `Line ${r.lineNumber}: Blocker ${r.id} Blocks Apply?=[${r.blocksApply}] not in ${ALLOWED_BLOCKS_APPLY.join(", ")}`,
      );
    } else if (r.blocksApply === "YES") {
      applyBlockingCount += 1;
    } else if (r.blocksApply === "SOFT") {
      softCount += 1;
    }

    if (!r.evidence || /^\s*$/.test(r.evidence)) {
      errors.push(`Line ${r.lineNumber}: Blocker ${r.id} Evidence is empty`);
    }
  }

  const totalFromRows = rows.length;

  // (9) Cross-check against declared totals in FINAL Summary section.
  // Because per-migration sub-sections may write their own row-count lines
  // that include the substring, we take the LAST match of each pattern.
  function lastMatch(regex, text) {
    const allMatches = [...text.matchAll(new RegExp(regex, "gm"))];
    return allMatches.length === 0 ? null : allMatches[allMatches.length - 1];
  }

  const totalDeclaredMatch = lastMatch(/^.*Total BLOCKED unresolved:.*$/m, raw);
  let totalDeclared = NaN;
  if (totalDeclaredMatch) {
    const line = totalDeclaredMatch[0] ?? "";
    // If line has form "... = <N>" take N; otherwise take the last integer on the line.
    const equalsMatch = line.match(/=\s*(\d+)\s*$/);
    if (equalsMatch) {
      totalDeclared = Number(equalsMatch[1]);
    } else {
      const lastInt = [...line.matchAll(/\d+/g)].slice(-1)[0];
      if (lastInt) totalDeclared = Number(lastInt);
    }
  }

  const breakdownMatch = lastMatch(
    /Total BLOCKED unresolved:\s*(?<expr>(?:\d+\+){8}\d+)\s*=\s*(?<sum>\d+)/,
    raw,
  );
  const breakdownExpr = breakdownMatch?.groups?.expr ?? "";
  const breakdownSum = breakdownMatch?.groups?.sum
    ? Number(breakdownMatch.groups.sum)
    : NaN;

  const perFileFromBreakdown = breakdownExpr
    ? breakdownExpr.split("+").map((s) => Number(s.trim()))
    : [];

  if (!Number.isFinite(totalDeclared)) {
    errors.push(
      "Summary missing `Total BLOCKED unresolved: <N>` declared total",
    );
  } else if (totalDeclared !== unresolvedCount) {
    errors.push(
      `Declared Total BLOCKED unresolved = ${totalDeclared}; actual unresolved (status != RESOLVED_SIGNED_OFF) = ${unresolvedCount}`,
    );
  }
  if (!Number.isFinite(breakdownSum)) {
    errors.push("Summary missing 9-operand per-file breakdown = <sum> line");
  } else if (breakdownSum !== totalFromRows) {
    errors.push(
      `Summary breakdown line sum = ${breakdownSum}; actual total register rows = ${totalFromRows}`,
    );
  }
  if (perFileFromBreakdown.length === EXPECTED_PREFIXES.length) {
    for (let i = 0; i < EXPECTED_PREFIXES.length; i++) {
      const prefix = EXPECTED_PREFIXES[i];
      const rowsCount = perMigrationCounts.get(prefix) ?? 0;
      const exprCount = perFileFromBreakdown[i];
      if (exprCount !== rowsCount) {
        errors.push(
          `Per-file breakdown mismatch: ${prefix} register=${rowsCount} vs summary line=${exprCount}`,
        );
      }
    }
  } else if (perFileFromBreakdown.length > 0) {
    errors.push(
      `Per-file breakdown operand count=${perFileFromBreakdown.length} (expected 9 for 0127..0135)`,
    );
  }

  const clsYesMatch = lastMatch(
    /Blocks Apply\? = YES["`]*:\s*(\d+)\s*rows?/,
    raw,
  );
  const clsSoftMatch = lastMatch(
    /Blocks Apply\? = SOFT["`]*:\s*(\d+)\s*rows?/,
    raw,
  );
  const clsResolvedMatch = lastMatch(
    /Status = RESOLVED_SIGNED_OFF["`]*:\s*(\d+)\s*rows?/,
    raw,
  );
  if (clsYesMatch) {
    const n = Number(clsYesMatch[1]);
    if (n !== applyBlockingCount) {
      errors.push(
        `Classified YES-blocking declared=${n}; actual row count=${applyBlockingCount}`,
      );
    }
  }
  if (clsSoftMatch) {
    const n = Number(clsSoftMatch[1]);
    if (n !== softCount) {
      errors.push(
        `Classified SOFT declared=${n}; actual row count=${softCount}`,
      );
    }
  }
  if (clsResolvedMatch) {
    const n = Number(clsResolvedMatch[1]);
    if (n !== resolvedCount) {
      errors.push(
        `Classified RESOLVED_SIGNED_OFF declared=${n}; actual row count=${resolvedCount}`,
      );
    }
  }

  const perMigrationReport = {};
  for (const p of EXPECTED_PREFIXES) {
    perMigrationReport[p] = perMigrationCounts.get(p) ?? 0;
  }

  const report = {
    registerFile: REGISTER_PATH,
    totalRows: totalFromRows,
    unresolvedRows: unresolvedCount,
    applyBlockingRows: applyBlockingCount,
    softRows: softCount,
    resolvedRows: resolvedCount,
    perMigrationCounts: perMigrationReport,
    declaredTotalUnresolved: Number.isFinite(totalDeclared)
      ? totalDeclared
      : null,
    declaredBreakdownSum: Number.isFinite(breakdownSum) ? breakdownSum : null,
    uniqueIds: new Set(rows.map((r) => r.id)).size,
  };

  process.stdout.write(
    "HRMS Blocker Register Validator Report\n" +
      "-------------------------------------\n" +
      JSON.stringify(report, null, 2) +
      "\n",
  );

  if (errors.length > 0) {
    process.stdout.write(`\nVALIDATION ERRORS (${errors.length}):\n`);
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
    process.stdout.write("\nResult: FAIL\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("\nResult: PASS\n");
    process.exitCode = 0;
  }
}

main();
