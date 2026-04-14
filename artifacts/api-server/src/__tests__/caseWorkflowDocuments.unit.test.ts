import { describe, it, expect } from "vitest";
import { normalizeWorkflowDocumentKeyFromDb, workflowDocumentLegacyKeys, WORKFLOW_DOCUMENT_ALLOWED_KEYS } from "../lib/caseWorkflowDocuments";

describe("caseWorkflowDocuments", () => {
  it("normalizes legacy keys to stable keys", () => {
    expect(normalizeWorkflowDocumentKeyFromDb("spa_stamped_date")).toBe("spa_stamped");
    expect(normalizeWorkflowDocumentKeyFromDb("letter_of_offer_stamped_date")).toBe("lo_stamped");
    expect(normalizeWorkflowDocumentKeyFromDb("register_poa_on")).toBe("register_poa");
    expect(normalizeWorkflowDocumentKeyFromDb("letter_disclaimer_dated")).toBe("letter_disclaimer");
    expect(normalizeWorkflowDocumentKeyFromDb("letter_disclaimer_received_on")).toBe("letter_disclaimer");
    expect(normalizeWorkflowDocumentKeyFromDb("unknown")).toBeNull();
  });

  it("exposes legacy keys for a stable key", () => {
    expect(workflowDocumentLegacyKeys("spa_stamped")).toContain("spa_stamped_date");
    expect(workflowDocumentLegacyKeys("letter_disclaimer")).toEqual(expect.arrayContaining(["letter_disclaimer_dated", "letter_disclaimer_received_on"]));
  });

  it("allowed keys are stable keys only", () => {
    expect(WORKFLOW_DOCUMENT_ALLOWED_KEYS.has("spa_stamped")).toBe(true);
    expect(WORKFLOW_DOCUMENT_ALLOWED_KEYS.has("spa_stamped_date")).toBe(false);
  });
});

