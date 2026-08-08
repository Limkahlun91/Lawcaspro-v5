import { describe, it, expect, vi } from "vitest";
import { Decimal } from "decimal.js";
import {
  parseLedgerAmount,
  parseLedgerAmountToNumber,
  normalizeLedgerAmountString,
  type LedgerBadRowInfo,
} from "../modules/accounting/ledger-money";

describe("§27 — Trust/Ledger monetary parse safe helper", () => {
  it("normalizeLedgerAmountString strips commas and whitespace", () => {
    expect(normalizeLedgerAmountString("1,234.56")).toBe("1234.56");
    expect(normalizeLedgerAmountString("  - 12,345.67 ")).toBe("-12345.67");
    expect(normalizeLedgerAmountString("RM")).toBeNull();
    expect(normalizeLedgerAmountString("1.2.3")).toBeNull();
  });

  it("parseLedgerAmount('123.45') => Decimal('123.45') exactly", () => {
    const d = parseLedgerAmount("123.45");
    expect(d instanceof Decimal || (d && typeof d === "object" && "toFixed" in d)).toBe(true);
    expect(String(d)).toBe("123.45");
    expect(d.toFixed(2)).toBe("123.45");
  });

  it("parseLedgerAmount number input 123.45 => Decimal 123.45", () => {
    const d = parseLedgerAmount(123.45);
    expect(d.toFixed(2)).toBe("123.45");
  });

  it("parseLedgerAmount('not-a-number') calls badRowCb with row info and returns 0", () => {
    const badRowCb = vi.fn((_info: LedgerBadRowInfo) => { /* no-op */ });
    const info: LedgerBadRowInfo = {
      rowId: 987,
      table: "ledger_entries",
      column: "debit",
      lineNumber: 42,
      rawValue: "not-a-number",
      reason: "malformed_amount",
    };
    const result = parseLedgerAmount("not-a-number", badRowCb, info);
    expect(badRowCb).toHaveBeenCalledTimes(1);
    expect(badRowCb).toHaveBeenCalledWith(
      expect.objectContaining({
        rowId: 987,
        table: "ledger_entries",
        rawValue: "not-a-number",
        reason: "malformed_amount",
      }),
    );
    expect(result.toNumber()).toBe(0);
  });

  it("parseLedgerAmount(null) → normalized as missing, returns 0, reports malformed per helper semantics", () => {
    const cb = vi.fn();
    const r = parseLedgerAmount(null, cb, {});
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]!.reason).toBe("malformed_amount");
    expect(r.toNumber()).toBe(0);
  });

  it("parseLedgerAmount('Infinity') → regex rejects before Decimal, reason malformed_amount", () => {
    const cb = vi.fn();
    const r = parseLedgerAmount("Infinity", cb, { lineNumber: 7 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]!.reason).toBe("malformed_amount");
    expect(r.toNumber()).toBe(0);
  });

  it("parseLedgerAmountToNumber returns numeric for valid", () => {
    expect(parseLedgerAmountToNumber("-1,000.50")).toBeCloseTo(-1000.5, 8);
  });
});
