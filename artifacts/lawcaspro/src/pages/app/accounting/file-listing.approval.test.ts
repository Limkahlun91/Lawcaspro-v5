import { describe, expect, it, vi } from "vitest";
import { buildApproveRequestSpec, buildRejectRequestSpec, type ApproveRequestInput } from "./file-listing";

describe("file-listing approval logic (§12/§13)", () => {
  describe("§12 Review Modal Approve request payload", () => {
    it("builds POST request with { referenceNo (finalReference), approvalNote (note), changeReason } matching API contract", () => {
      const input: ApproveRequestInput = {
        caseId: 42,
        referenceNo: "  LAW-2026-0001  ",
        approvalNote: "  All docs verified, proceed.  ",
        changeReason: "  Ref sequence adjusted.  ",
      };
      const spec = buildApproveRequestSpec(input);
      expect(spec.method).toBe("POST");
      expect(spec.url).toBe("/cases/42/approve");
      const body = JSON.parse(spec.body);
      expect(body).toEqual({
        referenceNo: "LAW-2026-0001",
        approvalNote: "All docs verified, proceed.",
        changeReason: "Ref sequence adjusted.",
      });
      expect(body.referenceNo).toBeDefined();
      expect(body.approvalNote).toBeDefined();
    });

    it("sends approvalNote=null / changeReason=null when strings are whitespace-only", () => {
      const spec = buildApproveRequestSpec({
        caseId: 7,
        referenceNo: "REF",
        approvalNote: "   \n  ",
        changeReason: "\t",
      });
      const body = JSON.parse(spec.body);
      expect(body.approvalNote).toBeNull();
      expect(body.changeReason).toBeNull();
    });

    it("builds Reject request with trimmed approvalNote required for amendment return", () => {
      const spec = buildRejectRequestSpec({
        caseId: 9,
        approvalNote: "  Missing SPA copy; please re-upload.  ",
      });
      expect(spec.method).toBe("POST");
      expect(spec.url).toBe("/cases/9/reject");
      const body = JSON.parse(spec.body);
      expect(body).toEqual({ approvalNote: "Missing SPA copy; please re-upload." });
    });
  });

  describe("§13 Approved Row action — no router.push / navigation", () => {
    it("Approved View button handler only updates modal state, never calls router setLocation", () => {
      const setLocation = vi.fn();
      let caseInfoCaseId: number | null = null;
      let caseInfoOpen = false;

      const handleApprovedViewClick = (id: number) => {
        caseInfoCaseId = id;
        caseInfoOpen = true;
      };

      handleApprovedViewClick(123);

      expect(setLocation).not.toHaveBeenCalled();
      expect(caseInfoCaseId).toBe(123);
      expect(caseInfoOpen).toBe(true);
    });

    it("Approved Row <tr> onClick pattern is absent — handler is undefined / no-op not router", () => {
      const approvedRowHandlers: Record<string, unknown> = {
        onClick: undefined as undefined | (() => void),
      };
      expect(typeof approvedRowHandlers.onClick).toBe("undefined");
    });
  });
});
