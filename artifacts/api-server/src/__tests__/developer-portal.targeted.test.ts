import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySpaLoanStage,
  deriveMotStatus,
  deriveNextAction,
  deriveSpaStatus,
  deriveLoanStatus,
  formatPurchasePrice,
  getDeveloperPortalUnitLabel,
  summarizeCards,
  collectAttentionItems,
  mapJoinedCaseToListDto,
  buildRecentActivity,
  extractLawyerClerk,
  type DevPortalStatus,
  type UnitListDto,
  type KeyDatesRow,
} from "../lib/developer-portal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devPortalSrcPath = path.resolve(__dirname, "..", "lib", "developer-portal.ts");
const DEV_PORTAL_SRC_TEXT = fs.existsSync(devPortalSrcPath) ? fs.readFileSync(devPortalSrcPath, "utf8") : "";

type AnyRow = any;

function joinedCase(partial: Partial<AnyRow> = {}): AnyRow {
  return {
    id: 1,
    referenceNo: "CON/001",
    parcelNo: null,
    purchaseMode: "loan",
    status: "Loan Documentation",
    updatedAt: new Date("2026-08-13T15:20:00Z"),
    createdAt: new Date("2026-05-25T09:00:00Z"),
    propertyDetails: {},
    loanDetails: {},
    titleType: "master",
    spaPrice: null,
    endFinancierBank: null,
    projectName: "LEGASI",
    phase: "Phase 1",
    purchaserNames: "LIMKL, LIMKL 1",
    lawyerName: null,
    clerkName: null,
    ...partial,
  };
}

function kd(p: Partial<KeyDatesRow> = {}): KeyDatesRow {
  return {
    spaSignedDate: null,
    spaStampedDate: null,
    spaDate: null,
    spaForwardToDeveloperExecutionOn: null,
    letterOfOfferDate: null,
    letterOfOfferStampedDate: null,
    actingLetterIssuedDate: null,
    bankLuReceivedDate: null,
    adviceToBankDate: null,
    motReceivedDate: null,
    motSignedDate: null,
    motStampedDate: null,
    motRegisteredDate: null,
    completionDate: null,
    ...p,
  };
}

describe("DEVPORTAL-1 · unit label priority", () => {
  it("parcel-only uses parcel, not dash", () => {
    const r1 = getDeveloperPortalUnitLabel({ parcelNo: null, propertyDetails: { parcelNo: "PT21085", lotNo: "Z-0002" } });
    expect(r1).toBe("PT21085 (Z-0002)");
  });
  it("unitNo returns Unit 1519", () => {
    expect(getDeveloperPortalUnitLabel({ propertyDetails: { unitNo: "1519" } })).toBe("Unit 1519");
  });
  it("parcel missing, parcelNo direct set, lotNo via details → Lot fallback", () => {
    expect(getDeveloperPortalUnitLabel({ propertyDetails: { lotNo: "1023" } })).toBe("Lot 1023");
  });
  it("parcelNo direct set from cases.parcel_no", () => {
    expect(getDeveloperPortalUnitLabel({ parcelNo: "A-08-01" })).toBe("A-08-01");
  });
  it("all identifiers empty → falls back to project+ref", () => {
    const r = getDeveloperPortalUnitLabel({ projectName: "LEGASI", phase: "Phase 1", referenceNo: "CON/001" });
    expect(r).toBe("LEGASI · Phase 1 · CON/001");
  });
  it("never returns plain dash when another identifier exists", () => {
    const variants = [
      { parcelNo: "PT21085" },
      { propertyDetails: { lotNo: "1023" } },
      { propertyDetails: { hakmilikNo: "HAK-1" } },
      { referenceNo: "CON/001", projectName: "LEGASI" },
    ];
    for (const v of variants) {
      expect(getDeveloperPortalUnitLabel(v as any)).not.toBe("—");
      expect(getDeveloperPortalUnitLabel(v as any).length).toBeGreaterThan(0);
    }
  });
});

describe("DEVPORTAL-2 · SPA completed shows status Completed + date", () => {
  it("deriveSpaStatus sets Completed + date + label for stamped", () => {
    const r = deriveSpaStatus(kd({ spaStampedDate: "2026-04-09" }));
    expect(r.status).toBe("Completed" as DevPortalStatus);
    expect(r.label).toBe("SPA Stamped");
    expect(r.date).toBe("2026-04-09");
  });
});

describe("DEVPORTAL-3 · future MOT stage Not Yet Required", () => {
  it("loan stage → mot Not Yet Required, not Missing", () => {
    const stage = classifySpaLoanStage(kd({ actingLetterIssuedDate: "2026-08-01" }));
    const mot = deriveMotStatus(kd(), stage);
    expect(mot.status).toBe("Not Yet Required" as DevPortalStatus);
    expect(mot.label).toMatch(/MOT|Title/);
  });
  it("pre-spa stage → mot Not Yet Required", () => {
    const mot = deriveMotStatus(kd(), "pre_spa");
    expect(mot.status).toBe("Not Yet Required" as DevPortalStatus);
  });
});

describe("DEVPORTAL-4 · overdue milestone → Attention Required", () => {
  it("Acting letter >5d old without Bank LU → Attention Required + true attn flag on nextAction", () => {
    const base = kd({ actingLetterIssuedDate: "2026-08-01" });
    const now = new Date("2026-08-14T00:00:00Z");
    const loan = deriveLoanStatus(base, "loan");
    expect(loan.status).toBe("Attention Required" as DevPortalStatus);
    expect(loan.waitingFor).toMatch(/Bank/);
    expect(loan.ageDays).toBeGreaterThanOrEqual(13 - 1);
    const next = deriveNextAction(base, "loan");
    expect(next?.attentionRequired).toBe(true);
  });
});

describe("DEVPORTAL-5 · summary card stage filters", () => {
  it("counts spaStamped / spaInProgress / loanInProgress / attention / completed correctly", () => {
    const rows: UnitListDto[] = [
      listOf({ spaStatus: "Completed", spaLabel: "SPA Stamped", loanStatus: "In Progress", completed: false }),
      listOf({ spaStatus: "Completed", spaLabel: "SPA Stamped", loanStatus: "In Progress", completed: false }),
      listOf({ spaStatus: "In Progress", spaLabel: "SPA Signing", loanStatus: "Not Yet Required", completed: false }),
      listOf({ spaStatus: "Attention Required", spaLabel: "SPA Signing", loanStatus: "Not Yet Required", completed: false, attention: true }),
      listOf({ spaStatus: "Completed", spaLabel: "SPA Stamped", loanStatus: "Completed", completed: true }),
    ];
    const s = summarizeCards(rows);
    expect(s.totalUnits).toBe(5);
    expect(s.spaStamped).toBe(3);
    expect(s.spaInProgress).toBe(2);
    expect(s.loanInProgress).toBe(2);
    expect(s.needsAttention).toBeGreaterThanOrEqual(1);
    expect(s.completedHandover).toBe(1);
  });
});

describe("DEVPORTAL-7 · detail DTO carries correct project/case metadata", () => {
  it("joined row maps → DTO keeps project/phase/reference/purchasers", () => {
    const row = joinedCase({
      propertyDetails: { parcelNo: "PT21085", lotNo: "Z-0002" },
      kd_spaStampedDate: "2026-04-09",
      kd_actingLetterIssuedDate: "2026-08-09",
    });
    const dto = mapJoinedCaseToListDto(row);
    expect(dto.referenceNo).toBe("CON/001");
    expect(dto.projectName).toBe("LEGASI");
    expect(dto.phase).toBe("Phase 1");
    expect(dto.purchasers.map((p) => p.displayName)).toEqual(["LIMKL", "LIMKL 1"]);
  });
});

describe("DEVPORTAL-8 · current action derives automatically from workflow", () => {
  it("acting letter + no Bank LU → nextAction label + wait-for Bank/Lawyer/Purchaser non-empty", () => {
    const k = kd({ actingLetterIssuedDate: "2026-08-09", bankLuReceivedDate: null });
    const a = deriveNextAction(k, "loan");
    expect(a).not.toBeNull();
    expect(a!.label.length).toBeGreaterThan(0);
    expect(["Bank", "Law Firm", "Purchaser"].some((v) => a!.waitingFor.includes(v))).toBe(true);
  });
});

describe("DEVPORTAL-9 · Developer user cannot see NRIC/TIN fields in DTO", () => {
  it("mapJoinedCaseToListDto scrubs sensitive data in loanDetails / propertyDetails", () => {
    const row = joinedCase({ loanDetails: { nric: "880101-10-5001", tin: "C1234567" }, propertyDetails: { nric: "880101-10-5002" } });
    const dto = mapJoinedCaseToListDto(row);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toMatch(/880101-10-5001/);
    expect(serialized).not.toMatch(/880101-10-5002/);
    expect(serialized).not.toMatch(/"nric"/i);
    expect(serialized).not.toMatch(/"tin"/i);
  });
});

describe("DEVPORTAL-10 · developerOnlyAllowlist middleware replaces legacy deny list", () => {
  it("dead isDeveloperForbiddenApi export removed from developer-portal.ts", () => {
    expect(DEV_PORTAL_SRC_TEXT).not.toMatch(/isDeveloperForbiddenApi|DEV_PORTAL_DENY_APIS_RE/);
  });
});

describe("DEVPORTAL-12 · one canonical workflow update reflects in same status", () => {
  it("SPA stamped flips from In Progress → Completed", () => {
    const before = classifySpaLoanStage(kd({ spaSignedDate: "2026-04-01" }));
    const after = classifySpaLoanStage(kd({ spaSignedDate: "2026-04-01", spaStampedDate: "2026-04-09" }));
    expect(before).toBe("spa");
    expect(after).toBe("spa_stamped");
    expect(deriveSpaStatus(kd({ spaStampedDate: "2026-04-09" })).status).toBe("Completed" as DevPortalStatus);
  });
});

describe("DEVPORTAL-13 · no duplicate manual status tables introduced", () => {
  it("helper module never references developer_spa_status / developer_loan_status columns", () => {
    expect(DEV_PORTAL_SRC_TEXT).not.toMatch(/developer_spa_status/);
    expect(DEV_PORTAL_SRC_TEXT).not.toMatch(/developer_loan_status/);
    expect(DEV_PORTAL_SRC_TEXT).not.toMatch(/developer_mot_status/);
  });
});

describe("DEVPORTAL · additional small rules", () => {
  it("Attention summary returns oldest items first by age", () => {
    const items = [
      unitAttention("a", 5, false),
      unitAttention("b", 12, true),
      unitAttention("c", 8, true),
    ];
    const att = collectAttentionItems(items, 5);
    expect(att[0].ageDays).toBeGreaterThanOrEqual(att[1].ageDays);
  });
  it("formatPurchasePrice handles numeric and string", () => {
    expect(formatPurchasePrice(450_000)).toMatch(/RM/);
    expect(formatPurchasePrice("450000.00")).toMatch(/RM/);
    expect(formatPurchasePrice(null)).toBeNull();
  });
  it("extractLawyerClerk maps roles", () => {
    const r = extractLawyerClerk([
      { userId: 1, name: "Lawyer No. 2", roleInCase: "lawyer" },
      { userId: 2, name: "Clerk No. 2", roleInCase: "clerk" },
    ]);
    expect(r.lawyer).toBe("Lawyer No. 2");
    expect(r.clerk).toBe("Clerk No. 2");
  });
  it("Recent Activity includes canonical key-date events", () => {
    const act = buildRecentActivity(
      kd({ spaStampedDate: "2026-08-10", actingLetterIssuedDate: "2026-08-13", bankLuReceivedDate: "2026-08-01" }),
      "loan",
      [],
      new Date("2026-08-14T12:00:00Z")
    );
    const labels = act.map((a) => a.label);
    expect(labels).toContain("SPA stamped");
    expect(labels).toContain("Acting Letter issued");
  });
});

function listOf(p: {
  spaStatus: DevPortalStatus;
  spaLabel: string;
  loanStatus: DevPortalStatus;
  completed: boolean;
  attention?: boolean;
}): UnitListDto {
  return {
    caseId: Math.floor(Math.random() * 1e9),
    referenceNo: "REF",
    projectName: "LEGASI",
    phase: "Phase 1",
    unitLabel: "Unit 1",
    propertySummary: null,
    purchasers: [{ displayName: "LIMKL" }],
    spa: { status: p.spaStatus, label: p.spaLabel, date: "2026-04-09" },
    loan: { status: p.loanStatus, label: "Loan Documentation", bankName: null, date: "2026-08-01" },
    mot: { status: p.completed ? "Completed" : "Not Yet Required", label: "MOT / Title", date: null },
    currentStage: p.completed ? "Completed / Handover" : (p.loanStatus !== "Not Yet Required" ? "Loan Documentation" : "SPA Signing"),
    nextAction: p.attention
      ? { label: "SPA Signing", waitingFor: "Purchaser", since: "2026-08-01", ageDays: 13, attentionRequired: true }
      : { label: "SPA Stamped", waitingFor: "Law Firm", since: "2026-04-09", ageDays: 0, attentionRequired: false },
    lastUpdatedAt: "2026-08-13T12:00:00Z",
  };
}

function unitAttention(label: string, age: number, att: boolean): UnitListDto {
  return {
    caseId: Math.floor(Math.random() * 1e9),
    referenceNo: "R-" + label,
    projectName: "LEGASI",
    phase: "Phase 1",
    unitLabel: `Unit ${label}`,
    propertySummary: null,
    purchasers: [{ displayName: "P1" }],
    spa: { status: att ? ("Attention Required" as DevPortalStatus) : "Completed", label: "SPA Signing", date: "2026-08-01" },
    loan: { status: "In Progress", label: "Loan Documentation", bankName: null, date: null },
    mot: { status: "Not Yet Required", label: "MOT / Title", date: null },
    currentStage: "Loan Documentation",
    nextAction: {
      label: `Action ${label}`,
      waitingFor: "Bank",
      since: new Date(Date.now() - age * 86400000).toISOString().slice(0, 10),
      ageDays: age,
      attentionRequired: age > 5 || att,
    },
    lastUpdatedAt: new Date().toISOString(),
  };
}
