import { describe, it, expect } from "vitest";
import {
  classifyInvoiceLineForEInvoice,
  resolveHeaderClassification,
  type EInvoiceClassification,
  type InvoiceLineLike,
} from "../services/einvoice/classification.js";
import {
  buildSubmissionIdempotencyKey,
  isTransitionAllowed,
  VALID_TRANSITIONS,
  type EInvoiceStatus,
} from "../services/einvoice/sandbox-adapter.js";

describe("eInvoice: classifyInvoiceLineForEInvoice (§29)", () => {
  it("OFFICE_INCOME for professional fee by default", () => {
    const line: InvoiceLineLike = { description: "Legal retainer for company incorporation", itemType: "professional_fee", itemCategory: "fee" };
    expect(classifyInvoiceLineForEInvoice(line)).toBe("OFFICE_INCOME");
  });

  it("CLIENT_STAKEHOLDER_MONEY for stamp duty / registration keywords", () => {
    const cases: InvoiceLineLike[] = [
      { description: "Stamp Duty on Sale & Purchase Agreement", itemType: "disbursement" },
      { description: "Land Office Registration Fee (SPA)", itemType: "disbursement" },
      { description: "NPFT assessment", itemType: "disbursement" },
      { description: "Quit Rent 2025 - Cukai Tanah", itemType: "disbursement" },
      { description: "E-filing fee for submission", itemType: "disbursement" },
      { description: "Court filing fee", itemType: "disbursement" },
      { description: "Bar Council stamp", itemType: "disbursement" },
    ];
    for (const c of cases) {
      expect(classifyInvoiceLineForEInvoice(c)).toBe("CLIENT_STAKEHOLDER_MONEY");
    }
  });

  it("TAXABLE_TRAVEL_MISC for travel/mileage/hotel keywords", () => {
    const cases: InvoiceLineLike[] = [
      { description: "Travel to JB for signing", itemType: "disbursement" },
      { description: "Toll + parking for court hearing", itemType: "disbursement" },
      { description: "Mileage claim (180km)", itemType: "disbursement" },
      { description: "Hotel stay KL per 2 nights", itemType: "disbursement" },
      { description: "Grab to Putrajaya", itemType: "disbursement" },
      { description: "Client entertainment dinner", itemType: "disbursement" },
    ];
    for (const c of cases) {
      expect(classifyInvoiceLineForEInvoice(c)).toBe("TAXABLE_TRAVEL_MISC");
    }
  });

  it("REIMBURSEMENT for reimbursement keywords", () => {
    expect(classifyInvoiceLineForEInvoice({ description: "Reimbursement of courier fee", itemType: "pass_through" })).toBe("REIMBURSEMENT");
    expect(classifyInvoiceLineForEInvoice({ description: "Reimburse printing fee paid earlier", itemType: "professional_fee", itemCategory: "fee" })).toBe("REIMBURSEMENT");
  });

  it("DISBURSEMENT for generic disbursement category without match", () => {
    expect(classifyInvoiceLineForEInvoice({ description: "Courier DHL document", itemType: "disbursement", itemCategory: "disbursement" })).toBe("DISBURSEMENT");
    expect(classifyInvoiceLineForEInvoice({ description: "Document printing", itemType: "trust_amount" })).toBe("DISBURSEMENT");
  });

  it("resolveHeaderClassification uses priority ordering: CLIENT_STAKEHOLDER_MONEY > DISBURSEMENT > OFFICE_INCOME", () => {
    const mixed: InvoiceLineLike[] = [
      { description: "Legal fee", itemType: "professional_fee", itemCategory: "fee" },
      { description: "Stamp Duty SPA", itemType: "disbursement" },
      { description: "Courier DHL", itemType: "disbursement" },
    ];
    expect(resolveHeaderClassification(mixed)).toBe("CLIENT_STAKEHOLDER_MONEY");
  });

  it("resolveHeaderClassification returns OFFICE_INCOME when all are fees", () => {
    const lines: InvoiceLineLike[] = [
      { description: "Retainer fee", itemType: "professional_fee", itemCategory: "fee" },
      { description: "Advisory services", itemType: "professional_fee", itemCategory: "fee" },
    ];
    expect(resolveHeaderClassification(lines)).toBe("OFFICE_INCOME");
  });

  it("resolveHeaderClassification returns null for empty", () => {
    expect(resolveHeaderClassification([])).toBeNull();
  });
});

describe("eInvoice: status transitions (§31)", () => {
  it("DRAFT -> READY allowed, DRAFT -> VALID not allowed", () => {
    expect(isTransitionAllowed("DRAFT", "READY")).toBe(true);
    expect(isTransitionAllowed("DRAFT", "VALID")).toBe(false);
  });

  it("READY -> SUBMITTING allowed; READY -> VALID disallowed", () => {
    expect(isTransitionAllowed("READY", "SUBMITTING")).toBe(true);
    expect(isTransitionAllowed("READY", "VALID")).toBe(false);
  });

  it("SUBMITTING -> SUBMITTED / ERROR / RETRY_PENDING allowed", () => {
    expect(isTransitionAllowed("SUBMITTING", "SUBMITTED")).toBe(true);
    expect(isTransitionAllowed("SUBMITTING", "ERROR")).toBe(true);
    expect(isTransitionAllowed("SUBMITTING", "RETRY_PENDING")).toBe(true);
  });

  it("SUBMITTED -> VALID / INVALID allowed; SUBMITTED -> DRAFT disallowed", () => {
    expect(isTransitionAllowed("SUBMITTED", "VALID")).toBe(true);
    expect(isTransitionAllowed("SUBMITTED", "INVALID")).toBe(true);
    expect(isTransitionAllowed("SUBMITTED", "DRAFT")).toBe(false);
  });

  it("VALID is a terminal state (nothing allowed except CANCELLED)", () => {
    expect(VALID_TRANSITIONS["VALID"]).toEqual(["CANCELLED"]);
    expect(isTransitionAllowed("VALID", "ERROR")).toBe(false);
    expect(isTransitionAllowed("VALID", "RETRY_PENDING")).toBe(false);
  });

  it("CANCELLED is terminal (nothing allowed)", () => {
    expect(VALID_TRANSITIONS["CANCELLED"]).toEqual([]);
  });

  it("ERROR / RETRY_PENDING retry flow", () => {
    expect(isTransitionAllowed("ERROR", "RETRY_PENDING")).toBe(true);
    expect(isTransitionAllowed("ERROR", "SUBMITTING")).toBe(true);
    expect(isTransitionAllowed("RETRY_PENDING", "SUBMITTING")).toBe(true);
    expect(isTransitionAllowed("RETRY_PENDING", "VALID")).toBe(false);
  });

  it("INVALID -> RETRY_PENDING | CANCELLED", () => {
    expect(isTransitionAllowed("INVALID", "RETRY_PENDING")).toBe(true);
    expect(isTransitionAllowed("INVALID", "CANCELLED")).toBe(true);
    expect(isTransitionAllowed("INVALID", "SUBMITTED")).toBe(false);
  });
});

describe("eInvoice: idempotency key (§31)", () => {
  it("buildSubmissionIdempotencyKey is deterministic per (firm, invoice, version)", () => {
    const a = buildSubmissionIdempotencyKey(7, 42, 1);
    const b = buildSubmissionIdempotencyKey(7, 42, 1);
    expect(a).toBe(b);
    expect(a).toBe("firm_7_inv_42_submission_v1");
  });

  it("different version produces different key (for retry v2)", () => {
    const a = buildSubmissionIdempotencyKey(7, 42, 1);
    const b = buildSubmissionIdempotencyKey(7, 42, 2);
    expect(a).not.toBe(b);
    expect(b).toBe("firm_7_inv_42_submission_v2");
  });

  it("different firm/invoice produce different keys", () => {
    const a = buildSubmissionIdempotencyKey(1, 10, 1);
    const b = buildSubmissionIdempotencyKey(2, 10, 1);
    const c = buildSubmissionIdempotencyKey(1, 11, 1);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("eInvoice: sandbox adapter constants", () => {
  it("VALID_TRANSITIONS keys cover full enum", () => {
    const expected: EInvoiceStatus[] = ["DRAFT", "READY", "SUBMITTING", "SUBMITTED", "VALID", "INVALID", "CANCELLED", "ERROR", "RETRY_PENDING"];
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual(expected.sort());
  });

  it("classification enum covers 6 categories", () => {
    const expected: EInvoiceClassification[] = ["OFFICE_INCOME", "TAXABLE_TRAVEL_MISC", "CLIENT_STAKEHOLDER_MONEY", "REIMBURSEMENT", "DISBURSEMENT", "OVERCOLLECT_TRANSFER"];
    expected.forEach((c) => expect(typeof c).toBe("string"));
    expect(expected.length).toBe(6);
  });
});
