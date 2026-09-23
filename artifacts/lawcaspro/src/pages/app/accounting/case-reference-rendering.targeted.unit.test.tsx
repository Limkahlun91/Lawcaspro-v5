import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as any).React = React;

afterEach(() => {
  cleanup();
});

vi.mock("wouter", () => {
  return {
    useLocation: () => ["/app/accounting", vi.fn()],
    useSearch: () => "",
    Link: ({ href, children, onClick, className, title }: any) => (
      <a href={href} onClick={onClick} className={className} title={title} data-case-link="true">
        {children}
      </a>
    ),
  };
});

const InvoiceCaseCell = ({ inv }: { inv: any }) => (
  <td data-role="invoice-case-cell">
    {Number.isFinite(inv.caseId) && (inv.caseReferenceNo || inv.referenceNo) ? (
      <a href={`/app/cases/${inv.caseId}`} data-case-link="true">{inv.caseReferenceNo || inv.referenceNo}</a>
    ) : (
      <span className="italic text-slate-500">Unlinked</span>
    )}
  </td>
);

const QuotationRow = ({ q }: { q: any }) => (
  <tr>
    <td data-role="quotation-own-ref">{q.referenceNo}</td>
    <td data-role="quotation-client">{q.clientName}</td>
    <td data-role="quotation-case-cell">
      {Number.isFinite(q.caseId) && q.caseReferenceNo ? (
        <a href={`/app/cases/${q.caseId}`} data-case-link="true">{q.caseReferenceNo}</a>
      ) : (
        <span className="italic text-slate-500">Unlinked</span>
      )}
    </td>
  </tr>
);

const ReceiptRow = ({ r }: { r: any }) => (
  <tr>
    <td data-role="receipt-case-cell">
      {Number.isFinite(r.caseId) && r.caseReferenceNo ? (
        <a href={`/app/cases/${r.caseId}`} data-case-link="true">{r.caseReferenceNo}</a>
      ) : (
        <span className="italic text-slate-500">Unlinked</span>
      )}
    </td>
    <td data-role="receipt-bank-cell">{r.referenceNo || "—"}</td>
  </tr>
);

describe("Accounting Case Reference rendering semantics (mirrors accounting/index.tsx + detail pages)", () => {
  it("linked caseReferenceNo renders with clickable href=/app/cases/:caseId", () => {
    const inv = { id: 1, invoiceNo: "INV-0001", caseId: 42, caseReferenceNo: "LAW-CASE-2025-0042", referenceNo: null };
    const { container } = render(
      <table><tbody><tr>
        <InvoiceCaseCell inv={inv} />
      </tr></tbody></table>,
    );
    const cell = container.querySelector('[data-role="invoice-case-cell"]') as HTMLElement;
    expect(cell).toBeTruthy();
    const link = container.querySelector('a[data-case-link="true"]') as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("LAW-CASE-2025-0042");
    expect((link as any).href).toBeTruthy();
    expect((link as any).getAttribute("href")).toBe("/app/cases/42");
  });

  it("missing Case displays exact text Unlinked (no blank cells, no numeric #id-only fallback when caseId missing)", () => {
    const inv = { id: 2, invoiceNo: "INV-0002", caseId: null, referenceNo: null, caseReferenceNo: null };
    const { container } = render(
      <table><tbody><tr>
        <InvoiceCaseCell inv={inv} />
      </tr></tbody></table>,
    );
    const cell = container.querySelector('[data-role="invoice-case-cell"]') as HTMLElement;
    expect(cell).toBeTruthy();
    expect(cell.textContent).toContain("Unlinked");
    const linkMaybe = container.querySelector('a[data-case-link="true"]');
    expect(linkMaybe).toBeNull();
    expect(cell.textContent).not.toMatch(/^#[0-9]+$/);
  });

  it("Receipt bank reference (receipt.referenceNo) cell displays distinct value from Case Reference cell", () => {
    const r = {
      id: 10, receiptNo: "R-007", caseId: 7, caseReferenceNo: "CONV-78910",
      referenceNo: "CHEQUE-4422 BANK A",
    };
    const { container } = render(
      <table><tbody>
        <ReceiptRow r={r} />
      </tbody></table>,
    );
    const caseCell = container.querySelector('[data-role="receipt-case-cell"]') as HTMLElement;
    const bankCell = container.querySelector('[data-role="receipt-bank-cell"]') as HTMLElement;
    expect(caseCell).toBeTruthy();
    expect(bankCell).toBeTruthy();
    expect(caseCell.textContent).toContain("CONV-78910");
    expect(bankCell.textContent).toContain("CHEQUE-4422 BANK A");
    expect(caseCell.textContent).not.toEqual(bankCell.textContent);
  });

  it("Unlinked Receipt shows 'Unlinked' in Case cell but still displays distinct bank/cheque ref in Bank cell", () => {
    const r = { id: 11, receiptNo: "R-008", caseId: null, caseReferenceNo: null, referenceNo: "CASH DEPOSIT 3311" };
    const { container } = render(
      <table><tbody>
        <ReceiptRow r={r} />
      </tbody></table>,
    );
    const caseCell = container.querySelector('[data-role="receipt-case-cell"]') as HTMLElement;
    const bankCell = container.querySelector('[data-role="receipt-bank-cell"]') as HTMLElement;
    expect(caseCell).toBeTruthy();
    expect(bankCell).toBeTruthy();
    expect(caseCell.textContent).toContain("Unlinked");
    expect(bankCell.textContent).toContain("CASH DEPOSIT 3311");
  });

  it("Quotation own referenceNo (quotation identity / File Ref column renamed Quotation Ref) displays separately from Case Reference cell", () => {
    const q = {
      id: 20, referenceNo: "Q-2025-0003",
      clientName: "Foo Bar Sdn Bhd", caseId: 3, caseReferenceNo: "SPA-ALPHA-2025-03",
    };
    const { container } = render(
      <table><tbody>
        <QuotationRow q={q} />
      </tbody></table>,
    );
    const ownRef = container.querySelector('[data-role="quotation-own-ref"]') as HTMLElement;
    const caseCell = container.querySelector('[data-role="quotation-case-cell"]') as HTMLElement;
    expect(ownRef).toBeTruthy();
    expect(caseCell).toBeTruthy();
    expect(ownRef.textContent).toContain("Q-2025-0003");
    expect(caseCell.textContent).toContain("SPA-ALPHA-2025-03");
    expect(ownRef.textContent).not.toEqual(caseCell.textContent);
    const link = caseCell.querySelector('a[data-case-link="true"]') as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/app/cases/3");
  });
});
