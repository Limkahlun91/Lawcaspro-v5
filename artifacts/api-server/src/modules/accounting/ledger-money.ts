/**
 * ledger-money.ts
 *
 * Safe monetary amount parsing for ledger/trust accounting pipelines.
 *
 * Problem context:
 *   `ledger_entries.debit`, `.credit`, `.balance_after` are stored as strings
 *   (to preserve exact DB decimal formatting). The original report routes used
 *   `num(v) => Number.isFinite(Number(v)) ? n : 0` which silently converts
 *   any malformed row to 0 — meaning bad data never surfaces, totals drift
 *   and reconciliation silently fails.
 *
 * Strategy:
 *   - Wrap every parse with explicit callbacks.
 *   - Prefer zeroing the render + surfacing the bad row PK in a structured
 *     `problem_rows` response field + warn-level audit log.
 *   - Excel export: a bad body row does not crash the export (no 500 mid-xlsx
 *     header flush); instead we zero, mark the cell with a note text, and
 *     append a trailing summary `error_markers` tab or trailing rows listing
 *     bad PKs so admins can reconcile offline.
 */

import Decimal from "decimal.js";
import pino from "pino";

const logger = pino({ name: "ledger-money" });

export type LedgerBadRowInfo = {
  rowId?: number | string;
  lineNumber?: number;
  column?: "debit" | "credit" | "balance" | "amount";
  rawValue?: unknown;
  reason?: string;
  table?: "ledger_entries" | "case_ledger" | "receipt_allocations";
};

export type LedgerBadRowCallback = (info: LedgerBadRowInfo) => void;

export const LEDGER_MONEY_RULE_VERSION = "LEDGER_MONEY_V1_DECIMALJS";

Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  minE: -9e14,
  maxE: 9e14,
  toExpNeg: -9e14,
  toExpPos: 9e14,
});

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

const AMOUNT_RE = /^-?\d{1,15}(\.\d{0,6})?$/;

export function normalizeLedgerAmountString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (isFiniteNumber(raw)) return String(raw);
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/,/g, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  if (cleaned === "-" || cleaned === "+") return null;
  if (AMOUNT_RE.test(cleaned)) return cleaned;
  return null;
}

export function parseLedgerAmount(
  raw: unknown,
  badRowCb?: LedgerBadRowCallback,
  info: LedgerBadRowInfo = {},
): Decimal {
  const normalized = normalizeLedgerAmountString(raw);
  if (normalized === null) {
    const msg =
      `Malformed ledger amount raw=${JSON.stringify(raw)} rowId=${String(info.rowId ?? "?")} col=${info.column ?? "?"}`;
    logger.warn({ raw, ...info }, "ledger_money_malformed");
    if (badRowCb) {
      try {
        badRowCb({
          reason: "malformed_amount",
          rawValue: raw,
          ...info,
        });
      } catch {
      }
    }
    return new Decimal(0);
  }
  try {
    const d = new Decimal(normalized);
    if (!d.isFinite()) {
      const msg = `Non-finite Decimal for raw=${JSON.stringify(raw)}`;
      logger.warn({ raw, ...info }, "ledger_money_nonfinite");
      if (badRowCb) {
        try {
          badRowCb({
            reason: "non_finite",
            rawValue: raw,
            ...info,
          });
        } catch {
        }
      }
      return new Decimal(0);
    }
    return d;
  } catch (err) {
    logger.warn({ raw, err: err instanceof Error ? err.message : String(err), ...info }, "ledger_money_parse_error");
    if (badRowCb) {
      try {
        badRowCb({
          reason: err instanceof Error ? err.message : "parse_exception",
          rawValue: raw,
          ...info,
        });
      } catch {
      }
    }
    return new Decimal(0);
  }
}

export function parseLedgerAmountToNumber(
  raw: unknown,
  badRowCb?: LedgerBadRowCallback,
  info: LedgerBadRowInfo = {},
): number {
  const d = parseLedgerAmount(raw, badRowCb, info);
  return d.toNumber();
}

export function toLedgerString(d: Decimal | number, scale = 2): string {
  const dec = isFiniteNumber(d) ? new Decimal(d) : d;
  if (!(dec instanceof Decimal) || !dec.isFinite()) return "0.00";
  return dec.toFixed(scale, Decimal.ROUND_HALF_UP);
}
