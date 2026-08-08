import { describe, expect, it } from "vitest";
import {
  scrubPayload,
  FORBIDDEN_PII_KEYS,
  buildIdempotencyKey,
} from "../modules/hr/events/business-event-writer.js";
import {
  enforceMaskOnWrite,
  malaysianNricMask,
  maskBankAccountNumber,
} from "../modules/hr/employees/hr-employee-write-service.js";
import {
  buildHrStoragePath,
  HR_STORAGE_PATH_REGEX,
  assertStoragePathMatchesFirmAndEmployee,
} from "../modules/hr/services/hr-storage-path.js";
import {
  validateHrDocIntegrity,
  issueHrSignedUrl,
} from "../modules/hr/services/hr-document-signed-url.js";
import { buildSubmissionPayload } from "../modules/hr/approvals/submission-payload-builder.js";
import {
  legacyToCanonical,
  canonicalPermission,
} from "../modules/hr/permissions/canonical.js";
import {
  malaysianNricMask as maskImported,
} from "../modules/hr/employees/hr-employee-write-service.js";

describe("B0127-02 + B0129-02 + B0131-02 + B0131-04 + B0133-03 + B0134-02 core service unit tests (no DB)", () => {
  it("B0127-02 scrubPayload drops forbidden keys (nric, icPassportNo, salaryAmount, bankAccount, homeAddress, salaryFigures)", () => {
    const payload = {
      employeeName: "Ali",
      nric: "880101-12-1234",
      icPassportNo: "880101-12-1234",
      salaryAmount: "5000.00",
      bankAccount: "1234567890",
      homeAddress: "1, Jalan Merdeka",
      salaryFigures: { basic: 5000, allowance: 500 },
      passportNo: "A12345678",
      bankAccountNo: "CIMB-001",
      notes: "ok",
      nested: {
        salary: 5000,
        identity_number: "880101-12-1234",
        safe_key: "1",
      },
    };
    const scrubbed = scrubPayload(payload as any);
    expect(scrubbed.employeeName).toBe("Ali");
    expect(scrubbed.notes).toBe("ok");
    for (const fk of ["nric","icPassportNo","salaryAmount","bankAccount","homeAddress","salaryFigures","passportNo","bankAccountNo"]) {
      expect(scrubbed).not.toHaveProperty(fk);
    }
    expect((scrubbed as any).nested).not.toHaveProperty("salary");
    expect((scrubbed as any).nested).not.toHaveProperty("identity_number");
    expect((scrubbed as any).nested.safe_key).toBe("1");
  });

  it("B0127-02 FORBIDDEN_PII_KEYS list contains blocker-mandated scrub list", () => {
    const canon = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
    const mandated = ["nric","icPassportNo","passportNo","bankAccount","bankAccountNo","salaryAmount","homeAddress","salaryFigures"].map(canon);
    for (const m of mandated) {
      expect(FORBIDDEN_PII_KEYS.some((f) => canon(f).includes(m) || m.includes(canon(f)))).toBe(true);
    }
  });

  it("B0127-02 buildIdempotencyKey produces firm-scoped deterministic key", () => {
    const a = buildIdempotencyKey(7, "EMPLOYEE_CREATED", "EMPLOYEE", "42");
    const b = buildIdempotencyKey(7, "EMPLOYEE_CREATED", "EMPLOYEE", "42");
    expect(a).toBe(b);
    expect(a).toContain("7");
    expect(a).toContain("EMPLOYEE_CREATED");
  });

  it("B0129-02 enforceMaskOnWrite full NRIC 880101-12-1234 writes masked ******-**-1234", () => {
    const result = enforceMaskOnWrite("880101-12-1234");
    expect(result.maskedValue).toBe("******-**-1234");
    expect(result.fullValue).toBe("880101-12-1234");
  });

  it("B0129-02 mask never returns empty string (Decision E1+)", () => {
    const short = malaysianNricMask("A");
    expect(short).not.toBe("");
    const norm = maskImported("880101-12-1234");
    expect(norm).not.toBe("");
  });

  it("B0130-03 maskBankAccountNumber returns last-4-masked ****1234 pattern", () => {
    const m = maskBankAccountNumber("56781234");
    expect(m).toBe("****1234");
    const m2 = maskBankAccountNumber("1234");
    expect(m2).toBe("1234");
    const m3 = maskBankAccountNumber(null);
    expect(m3).toBe("");
  });

  it("B0131-02 buildHrStoragePath returns C1 convention string and matches regex", () => {
    const path = buildHrStoragePath({
      firmId: 123,
      employeeId: 456,
      category: "contracts",
      ext: "pdf",
      date: new Date("2026-03-15T00:00:00Z"),
      providedUuid: "12345678-1234-1234-1234-123456789abc",
    });
    expect(HR_STORAGE_PATH_REGEX.test(path)).toBe(true);
    expect(path).toBe("firms/123/hr/employees/456/contracts/2026/03/12345678-1234-1234-1234-123456789abc.pdf");
  });

  it("B0131-02 assertStoragePathMatchesFirmAndEmployee cross-firm = HR_CROSS_FIRM_ACCESS_DENIED", () => {
    const path = "firms/1/hr/employees/2/general/2026/01/12345678-1234-1234-1234-123456789abc.pdf";
    expect(() => assertStoragePathMatchesFirmAndEmployee(path, 1, 2)).not.toThrow();
    function assertThrowsCrossFirm(fn: () => void): void {
      let threw = false;
      try { fn(); } catch (e: any) {
        threw = true;
        const code = e?.code ?? e?.error?.code;
        const msg = String(e?.message ?? "");
        expect(code === "HR_CROSS_FIRM_ACCESS_DENIED" || /CROSS_FIRM/i.test(msg) || /crosses firm/.test(msg)).toBe(true);
      }
      expect(threw).toBe(true);
    }
    assertThrowsCrossFirm(() => assertStoragePathMatchesFirmAndEmployee(path, 99, 2));
    assertThrowsCrossFirm(() => assertStoragePathMatchesFirmAndEmployee(path, 1, 99));
  });

  it("B0131-04 validateHrDocIntegrity sha256 mismatch returns matches=false; issueHrSignedUrl throws on mismatch", async () => {
    const row = {
      id: 1, firmId: 1, employeeId: 2,
      storagePath: "firms/1/hr/employees/2/general/2026/01/uuid.pdf",
      storageBucket: "private",
      fileName: "a.pdf",
      fileSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fileSizeBytes: 100,
    };
    const mismatch = validateHrDocIntegrity(row, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(mismatch.matches).toBe(false);
    await expect(
      issueHrSignedUrl({ docRow: row, actualBytesSha256Hex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    ).rejects.toThrow(/integrity/);
  });

  it("B0133-03 buildSubmissionPayload drops unknown keys and hard-rejects NRIC/salary/bank inline", () => {
    const good = { title: "Claim", note: "lunch", amount: "50" };
    const res1 = buildSubmissionPayload(good);
    expect(res1.payload.title).toBe("Claim");
    expect(res1.droppedKeys.length).toBe(0);
    expect(res1.rejectedKeys.length).toBe(0);
    const withUnknown = { title: "X", suspiciousExtra: "1", anotherBadKey: "2" };
    const res2 = buildSubmissionPayload(withUnknown as any);
    expect(res2.droppedKeys).toContain("suspiciousExtra");
    expect(res2.droppedKeys).toContain("anotherBadKey");
    expect(res2.malformedLogged).toBe(true);
    const withNric = { title: "X", nric: "880101-12-1234" };
    expect(() => buildSubmissionPayload(withNric as any)).toThrow(/FORBIDDEN/i);
    const withBank = { title: "X", bank_account_number: "123" };
    expect(() => buildSubmissionPayload(withBank as any)).toThrow(/FORBIDDEN/i);
    const withSalary = { title: "X", salaryFigures: { basic: 1 } };
    expect(() => buildSubmissionPayload(withSalary as any)).toThrow(/FORBIDDEN/i);
  });

  it("B0134-02 canonicalPermission converts legacy colon/slash → dot form with deprecation", () => {
    expect(canonicalPermission("hr_salary:view")).toBe("hr.salary.view");
    expect(canonicalPermission("hr_bank_details:view")).toBe("hr.bank_details.view");
    expect(legacyToCanonical("hr_settings.manage_organisation")).toBe("hr.settings.manage_organisation");
    expect(canonicalPermission("hr.identity.view")).toBe("hr.identity.view");
  });

  it("B0134-02 canonical form stable for HR routes: hr.salary.view = hr.salary.view (no-op)", () => {
    expect(canonicalPermission("hr.salary.view")).toBe("hr.salary.view");
  });
});
