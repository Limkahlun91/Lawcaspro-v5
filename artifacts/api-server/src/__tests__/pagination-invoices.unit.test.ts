import { describe, it, expect } from "vitest";
import { parsePageLimit } from "../routes/invoices";

type InvoiceRow = { id: number; invoiceNo: string; amount: number; firmId: number };

function makeMockInvoices(n: number, firmId = 77): InvoiceRow[] {
  const rows: InvoiceRow[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: i,
      invoiceNo: `INV-${String(i).padStart(5, "0")}`,
      amount: i,
      firmId,
    });
  }
  return rows;
}

function applyPagination<T>(rows: T[], page: number, limit: number) {
  const offset = (page - 1) * limit;
  const sliced = rows.slice(offset, offset + limit);
  return { totalCount: rows.length, rows: sliced, page, limit, offset };
}

describe("§26 — Server pagination for unbounded lists (invoices)", () => {
  const all500 = makeMockInvoices(500, 77);

  it("parsePageLimit: default limit 30, page 1", () => {
    const r = parsePageLimit({});
    expect(r).toEqual({ page: 1, limit: 30, offset: 0 });
  });

  it("parsePageLimit: clamps limit > 200 to 200", () => {
    const r = parsePageLimit({ query: { page: "1", limit: "10000" } });
    expect(r.limit).toBe(200);
  });

  it("parsePageLimit: rejects non-numeric page → falls back to 1", () => {
    const r = parsePageLimit({ query: { page: "xyz", limit: "10" } });
    expect(r.page).toBe(1);
  });

  it("mock 500 invoices rows — page=2 limit=20 returns rows 21-40 (ids 21..40)", () => {
    const { page, limit, offset } = parsePageLimit({ query: { page: "2", limit: "20" } });
    expect(page).toBe(2);
    expect(limit).toBe(20);
    expect(offset).toBe(20);

    const { totalCount, rows } = applyPagination(all500, page, limit);
    expect(totalCount).toBe(500);
    expect(rows.length).toBe(20);
    expect(rows[0]!.id).toBe(21);
    expect(rows[rows.length - 1]!.id).toBe(40);
    expect(rows.map((r) => r.invoiceNo)).toEqual(
      Array.from({ length: 20 }, (_, i) => `INV-${String(i + 21).padStart(5, "0")}`),
    );
  });

  it("page beyond total returns empty rows but totalCount preserved (X-Total-Count integrity)", () => {
    const { page, limit } = parsePageLimit({ query: { page: "100", limit: "100" } });
    const { totalCount, rows } = applyPagination(all500, page, limit);
    expect(totalCount).toBe(500);
    expect(rows.length).toBe(0);
  });
});
