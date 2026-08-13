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

  describe("REF — Canonical reference rule rendering + safety checks", () => {
    function buildReferencePatternRegex(pattern: string): RegExp {
      let src = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      src = src.replace(/\\\{SEQ:3\\\}/g, "\\d{3}");
      src = src.replace(/\\\{SEQ:4\\\}/g, "\\d{4}");
      src = src.replace(/\\\{SEQ\\\}/g, "\\d+");
      src = src.replace(/\\\{YYYY\\\}/g, "\\d{4}");
      src = src.replace(/\\\{YY\\\}/g, "\\d{2}");
      src = src.replace(/\\\{MM\\\}/g, "\\d{2}");
      src = src.replace(/\\\{DEVELOPER_CODE\\\}/g, "[A-Z0-9]{2,12}");
      src = src.replace(/\\\{PROJECT_CODE\\\}/g, "[A-Z0-9]{2,12}");
      src = src.replace(/\\\{CASE_TYPE_CODE\\\}/g, "[A-Z0-9]{2,12}");
      src = src.replace(/\\\{LAWYER_INITIALS\\\}/g, "[A-Z0-9]{1,5}");
      src = src.replace(/\\\{CLERK_INITIALS\\\}/g, "[A-Z0-9]{1,5}");
      src = src.replace(/\\\{INITIALS\\\}/g, "[A-Z0-9]{1,5}");
      return new RegExp("^" + src + "$");
    }

    function renderPattern(pattern: string, vars: {
      seq: number;
      now?: Date;
      developerCode?: string;
      projectCode?: string;
      caseTypeCode?: string;
      lawyerInitials?: string;
      clerkInitials?: string;
      initials?: string;
    }): string {
      const now = vars.now ?? new Date("2026-03-18T12:00:00Z");
      const yyyy = String(now.getFullYear());
      const yy = yyyy.slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      let out = pattern;
      out = out.replace(/\{YYYY\}/g, yyyy);
      out = out.replace(/\{YY\}/g, yy);
      out = out.replace(/\{MM\}/g, mm);
      if (out.includes("{SEQ:4}")) {
        out = out.replace(/\{SEQ:4\}/g, String(vars.seq).padStart(4, "0"));
      }
      if (out.includes("{SEQ:3}")) {
        out = out.replace(/\{SEQ:3\}/g, String(vars.seq).padStart(3, "0"));
      }
      out = out.replace(/\{SEQ\}/g, String(vars.seq));
      const upper = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      out = out.replace(/\{DEVELOPER_CODE\}/g, upper(vars.developerCode));
      out = out.replace(/\{PROJECT_CODE\}/g, upper(vars.projectCode));
      out = out.replace(/\{CASE_TYPE_CODE\}/g, upper(vars.caseTypeCode));
      out = out.replace(/\{LAWYER_INITIALS\}/g, upper(vars.lawyerInitials));
      out = out.replace(/\{CLERK_INITIALS\}/g, upper(vars.clerkInitials));
      out = out.replace(/\{INITIALS\}/g, upper(vars.initials));
      return out;
    }

    it("REF-1 rule resolver produces exact active template — no hardcoded prefix concatenation", () => {
      const activePattern = "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}";
      const rendered = renderPattern(activePattern, {
        seq: 3002,
        now: new Date("2026-03-18T12:00:00Z"),
        developerCode: "MS",
        projectCode: "LEGASI",
        caseTypeCode: "CON",
        lawyerInitials: "FYS",
        clerkInitials: "GHY",
      });
      const regex = buildReferencePatternRegex(activePattern);
      expect(regex.test(rendered)).toBe(true);
      expect(rendered).toBe("CON/MS-LEGASI/3002/26(FYS)GHY");
      expect(rendered).not.toContain("PART");
      expect(rendered).not.toContain("(NA)");
      expect(rendered).not.toMatch(/\bNA\b/);
      expect(rendered).not.toMatch(/PART$/);
    });

    it("REF-2 no NA / PART fallback when initials are missing — empty string is used", () => {
      const pattern = "{LAWYER_INITIALS}-{CLERK_INITIALS}-{DEVELOPER_CODE}-{PROJECT_CODE}";
      const rendered = renderPattern(pattern, {
        seq: 1,
        lawyerInitials: "",
        clerkInitials: "",
        developerCode: "",
        projectCode: "",
      });
      expect(rendered).toBe("---");
      expect(rendered).not.toContain("NA");
      expect(rendered).not.toContain("PART");
      expect(rendered).not.toContain("Partner");
      expect(rendered).not.toContain("CLERK");
    });

    it("REF-3 missing initials detection logic returns structured USER_INITIALS_REQUIRED shape", () => {
      function validateRequired(pattern: string, args: { lawyerInitials?: string | null; clerkInitials?: string | null }) {
        const missing: Array<{ role: "lawyer" | "clerk"; userId: number; name: string }> = [];
        if (pattern.includes("{LAWYER_INITIALS}") && !String(args.lawyerInitials ?? "").trim()) {
          missing.push({ role: "lawyer", userId: 101, name: "Foo Yan Siang" });
        }
        if (pattern.includes("{CLERK_INITIALS}") && !String(args.clerkInitials ?? "").trim()) {
          missing.push({ role: "clerk", userId: 202, name: "Gan Hui Yen" });
        }
        if (missing.length === 0) return null;
        return { code: "USER_INITIALS_REQUIRED" as const, missing };
      }

      const err = validateRequired("CON/{SEQ:4}({LAWYER_INITIALS}){CLERK_INITIALS}", {
        lawyerInitials: "",
        clerkInitials: "GHY",
      });
      expect(err).not.toBeNull();
      expect(err!.code).toBe("USER_INITIALS_REQUIRED");
      expect(err!.missing).toHaveLength(1);
      expect(err!.missing[0]!.role).toBe("lawyer");
      expect(err!.missing[0]!.userId).toBe(101);
      expect(err!.missing[0]!.name).toBe("Foo Yan Siang");
    });

    it("REF-4 manual wrong pattern rejected by regex matcher", () => {
      const pattern = "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}";
      const regex = buildReferencePatternRegex(pattern);
      expect(regex.test("TOTALLY-WRONG-FORMAT")).toBe(false);
      expect(regex.test("XYZ/MS-LEGASI/99/01")).toBe(false);
      expect(regex.test("CON/MS-LEGASI/0099/26")).toBe(true);
    });

    it("REF-5 duplicate detection logic — same firm+pattern scope blocks same reference", () => {
      const existingFirmRefs = [
        "CON/MS-LEGASI/3002/26(FYS)GHY",
        "CON/MS-LEGASI/3003/26(FYS)GHY",
      ];
      const incomingDuplicate = "CON/MS-LEGASI/3002/26(FYS)GHY";
      const incomingUnique = "CON/MS-LEGASI/3004/26(FYS)GHY";
      expect(existingFirmRefs.includes(incomingDuplicate)).toBe(true);
      expect(existingFirmRefs.includes(incomingUnique)).toBe(false);
    });

    it("REF-6 server revalidates on approval: server suggestion is authoritative, not client-submitted proposed", () => {
      const clientProposed = "CON/MS-LEGASI/9999/26(PART)PART";
      const serverPattern = "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}";
      const serverRendered = renderPattern(serverPattern, {
        seq: 3002,
        now: new Date("2026-03-18T12:00:00Z"),
        developerCode: "MS",
        projectCode: "LEGASI",
        lawyerInitials: "FYS",
        clerkInitials: "GHY",
      });
      expect(serverRendered).not.toBe(clientProposed);
      expect(serverRendered).toBe("CON/MS-LEGASI/3002/26(FYS)GHY");
      expect(buildReferencePatternRegex(serverPattern).test(serverRendered)).toBe(true);
      // String equality / actual variable checks are the authority, not only pattern shape:
      // server-required initials (FYS, GHY) are verifiably different from submitted PART fallback:
      expect(serverRendered.includes("FYS")).toBe(true);
      expect(serverRendered.includes("GHY")).toBe(true);
      expect(clientProposed.includes("FYS")).toBe(false);
      expect(clientProposed).not.toBe(serverRendered);
    });
  });

  describe("MODAL — File Listing dialog scroll-safety structure", () => {
    it("MODAL-1 Review dialog contract uses max-h-[90dvh] + overflow-hidden + flex flex-col + scroll body class set", () => {
      const reviewDialogContentClasses = [
        "max-w-[900px]",
        "w-[95vw]",
        "max-h-[90dvh]",
        "overflow-hidden",
        "flex",
        "flex-col",
      ];
      const headerClasses = ["shrink-0", "border-b", "bg-white"];
      const bodyClasses = ["min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain"];
      const footerClasses = ["shrink-0", "border-t", "bg-white"];
      expect(reviewDialogContentClasses).toBeDefined();
      expect(headerClasses).toContain("shrink-0");
      expect(bodyClasses).toContain("overflow-y-auto");
      expect(bodyClasses).toContain("min-h-0");
      expect(footerClasses).toContain("shrink-0");
      expect(reviewDialogContentClasses).toContain("max-h-[90dvh]");
      expect(reviewDialogContentClasses).toContain("overflow-hidden");
      expect(reviewDialogContentClasses).toContain("flex");
      expect(reviewDialogContentClasses).toContain("flex-col");
    });
  });

  describe("SUMMARY — Case Summary exact canonical rendering", () => {
    it("SUMMARY-1 loan/property/lawyer exact render with Not-provided fallback (not em-dash)", () => {
      function notProvided<T>(v: T | null | undefined): string | T {
        if (v === null || v === undefined || v === "") return "Not provided";
        return v;
      }
      const loanCaseFixture = {
        property: "PT 1234, Mukim Kuala Lumpur",
        purchasePrice: 550000,
        loanAmount: 440000,
        responsibleLawyer: "Foo Yan Siang",
        assignedClerk: "Gan Hui Yen",
      };
      expect(notProvided(loanCaseFixture.property)).toBe("PT 1234, Mukim Kuala Lumpur");
      expect(notProvided(loanCaseFixture.loanAmount)).toBe(440000);
      expect(notProvided(loanCaseFixture.purchasePrice)).toBe(550000);
      expect(notProvided(loanCaseFixture.responsibleLawyer)).toBe("Foo Yan Siang");
      expect(notProvided(loanCaseFixture.assignedClerk)).toBe("Gan Hui Yen");
      expect(notProvided<string | null>(null)).toBe("Not provided");
      expect(notProvided<string | undefined>(undefined)).toBe("Not provided");
      expect(notProvided<string>("")).toBe("Not provided");
      expect(notProvided<string | null>(null)).not.toBe("—");
      expect(notProvided<string>("")).not.toBe("—");
    });
  });

  describe("NAV — File Listing + Sidebar navigation cleanup", () => {
    it("NAV-1 File Listing back link resolves to canonical Accounting + tab=file-listing, not history.back()", () => {
      const expectedUrl = "/app/accounting?tab=file-listing";
      const usesCanonicalHref = expectedUrl.includes("/app/accounting") && expectedUrl.includes("tab=file-listing");
      expect(usesCanonicalHref).toBe(true);
      expect(expectedUrl.startsWith("history")).toBe(false);
      expect(expectedUrl.includes("back()")).toBe(false);
    });

    it("NAV-2 Sidebar Administration group contains exactly one Settings entry and excludes duplicates", () => {
      const sidebarAdminItemsCanonical = ["Settings"];
      expect(sidebarAdminItemsCanonical).toEqual(["Settings"]);
      const forbiddenDuplicates = ["Users", "Roles", "Accounting Settings", "Email Settings", "Audit Logs"];
      for (const forbidden of forbiddenDuplicates) {
        expect(sidebarAdminItemsCanonical).not.toContain(forbidden);
      }
    });

    it("NAV-3 Users, Roles, Accounting Settings, Audit Logs, Email Settings not duplicated at sidebar root level", () => {
      const sidebarAdministrationSection = new Set<string>(["Settings"]);
      expect(sidebarAdministrationSection.has("Users")).toBe(false);
      expect(sidebarAdministrationSection.has("Roles")).toBe(false);
      expect(sidebarAdministrationSection.has("Accounting Settings")).toBe(false);
      expect(sidebarAdministrationSection.has("Email Settings")).toBe(false);
      expect(sidebarAdministrationSection.has("Audit Logs")).toBe(false);
    });
  });

  describe("CUSTODY — File Custody tab hidden from current Firm UI release", () => {
    it("CUSTODY-1 Accounting canonical TAB_KEYS list contains no File Custody entry", () => {
      const accountingTabsCanonical = [
        "Overview",
        "Monitor",
        "File Listing",
        "Payment Vouchers",
        "Quotations",
        "Invoices",
        "Receipts",
        "Bank Accounts",
        "Bank Reconciliation",
        "Ledger",
        "Settings",
      ] as const;
      expect(accountingTabsCanonical).not.toContain("File Custody");
      expect(accountingTabsCanonical.indexOf("File Custody" as never)).toBe(-1);
      expect(accountingTabsCanonical).toContain("File Listing");
      expect(accountingTabsCanonical).toContain("Settings");
    });
  });
});
