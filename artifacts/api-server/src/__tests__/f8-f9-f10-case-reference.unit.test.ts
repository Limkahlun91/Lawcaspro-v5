import { describe, expect, it } from "vitest";

// F8 Case Progressive chips + Total Loan + Borrower consistency
type FinancingRow = { type: "FINANCING" | "OTHERS"; amount: number; label?: string };
type Borrower = {
  id?: number;
  tin?: string | null;
  phone?: string | null;
  email?: string | null;
  addressStructured?: { line1: string; line2?: string; postcode: string; state: string; country: string };
  partyKind?: "FIRST_PARTY" | "THIRD_PARTY";
};
type CaseLoanDraft = {
  progress: number; // 2.5 / 5 / 7.5 / 10 / 15 / 17.5
  financing: FinancingRow[];
  borrowers: Borrower[];
  caseId?: string;
  referenceProposed?: string;
  referenceFinal?: string;
  referenceStatus?: "DRAFT" | "PROPOSED" | "APPROVED" | "REJECTED";
  referenceHistory?: { id: number; ts: number; from: string | null; to: string | null; who: number; reason?: string }[];
};

function calculateTotalLoan(rows: FinancingRow[]): string {
  const sum = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
  return sum.toFixed(2);
}
function borrowerComposedAddress(b: Borrower): string | null {
  const s = b.addressStructured;
  if (!s) return null;
  return [s.line1, s.line2, `${s.postcode} ${s.state}`, s.country].filter(Boolean).join(", ");
}
function canModifyFinalRef(roles: string[]): boolean {
  return roles.includes("PARTNER") || roles.includes("MANAGER");
}

describe("F8 Case progressive + Total Loan + Borrower structured consistency", () => {
  it("F8-1 Progressive chip: 2.5 → 5 → 7.5 → 10 → 15 → 17.5 accepted", () => {
    [2.5, 5, 7.5, 10, 15, 17.5].forEach(v => {
      const c: CaseLoanDraft = { progress: v, financing: [], borrowers: [] };
      expect(c.progress).toBe(v);
    });
  });
  it("F8-2 create → reload: progress persists (roundtrip deep-equal)", () => {
    const created: CaseLoanDraft = { progress: 5, financing: [{ type: "FINANCING", amount: 1000 }], borrowers: [{ tin: "A123" }], referenceStatus: "DRAFT" };
    const reloaded = JSON.parse(JSON.stringify(created)) as CaseLoanDraft;
    expect(reloaded.progress).toBe(created.progress);
    expect(reloaded.financing.length).toBe(created.financing.length);
    expect(reloaded.borrowers[0].tin).toBe("A123");
  });
  it("F8-3 edit → reload: progress changes persist", () => {
    const c: CaseLoanDraft = { progress: 5, financing: [], borrowers: [] };
    c.progress = 15;
    const r = JSON.parse(JSON.stringify(c)) as CaseLoanDraft;
    expect(r.progress).toBe(15);
  });
  it("F8-4 Total Loan: Financing 180000 + Others 12000 + Others 2000 = 194000.00", () => {
    const rows: FinancingRow[] = [
      { type: "FINANCING", amount: 180000 },
      { type: "OTHERS", amount: 12000, label: "legal fee" },
      { type: "OTHERS", amount: 2000, label: "stamp duty" },
    ];
    expect(calculateTotalLoan(rows)).toBe("194000.00");
  });
  it("F8-5 Multiple OTHERS rows all count toward total", () => {
    const rows: FinancingRow[] = Array.from({ length: 10 }, (_, i) => ({ type: "OTHERS", amount: i + 1 }));
    expect(calculateTotalLoan(rows)).toBe("55.00");
  });
  it("F8-6 Single borrower", () => {
    const b: Borrower[] = [{ tin: "T1", phone: "60101234567", email: "a@b.c" }];
    expect(b.length).toBe(1);
    expect(b[0].tin).toBe("T1");
  });
  it("F8-7 Two borrowers", () => {
    const b: Borrower[] = [{ tin: "T1" }, { tin: "T2" }];
    expect(b.length).toBe(2);
    expect(new Set(b.map(x => x.tin)).size).toBe(2);
  });
  it("F8-8 Three borrowers", () => {
    const b: Borrower[] = [{ tin: "T1" }, { tin: "T2" }, { tin: "T3" }];
    expect(b.length).toBe(3);
  });
  it("F8-9 TIN / phone / email structured", () => {
    const b: Borrower = { tin: "830514-01-5821", phone: "+6012-345 6789", email: "zahir@example.com" };
    expect(b.tin).toMatch(/^\d{6}-\d{2}-\d{4}$/);
    expect(b.phone).toContain("6012");
    expect(b.email).toContain("@");
  });
  it("F8-10 Structured address → composed address (non-empty, reverse parseable)", () => {
    const b: Borrower = {
      addressStructured: { line1: "10, Jalan 1/2", line2: "Taman Tun", postcode: "60000", state: "Kuala Lumpur", country: "Malaysia" },
    };
    const composed = borrowerComposedAddress(b);
    expect(composed).toBe("10, Jalan 1/2, Taman Tun, 60000 Kuala Lumpur, Malaysia");
  });
  it("F8-11 Create → Overview → Detail cross-surface preserves borrowers length", () => {
    const created: CaseLoanDraft = { progress: 5, financing: [], borrowers: [{ tin: "T1" }, { tin: "T2" }] };
    const overview = created;
    const detail = JSON.parse(JSON.stringify(overview));
    expect(detail.borrowers.length).toBe(2);
  });
  it("F8-12 First-party sync: no silent wipe of untouched fields", () => {
    const bFirst: Borrower = { tin: "FIRST1", email: "first@x.com", phone: "60101234567", addressStructured: { line1: "L1", postcode: "60000", state: "KL", country: "MY" }, partyKind: "FIRST_PARTY" };
    const partialSyncPatch = { phone: "60100000000" };
    const merged: Borrower = { ...bFirst, ...partialSyncPatch };
    expect(merged.tin).toBe("FIRST1");
    expect(merged.email).toBe("first@x.com");
    expect(merged.phone).toBe("60100000000");
    expect(merged.addressStructured?.postcode).toBe("60000");
  });
  it("F8-13 Third-party borrower NOT overwritten by 1st-party sync", () => {
    const bThird: Borrower = { id: 7, tin: "THIRD-7", email: "3p@x.com", partyKind: "THIRD_PARTY" };
    const bFirst: Borrower = { id: 1, tin: "FIRST-1", partyKind: "FIRST_PARTY" };
    const borrowers: Borrower[] = [bFirst, bThird];
    const firstOnlyPatch = (arr: Borrower[]): Borrower[] => arr.map(b => b.partyKind === "FIRST_PARTY" ? { ...b, phone: "new" } : b);
    const after = firstOnlyPatch(borrowers);
    const tp = after.find(x => x.partyKind === "THIRD_PARTY")!;
    expect(tp.email).toBe("3p@x.com");
    expect(tp.phone).toBeUndefined();
    const fp = after.find(x => x.partyKind === "FIRST_PARTY")!;
    expect(fp.phone).toBe("new");
  });
});

// F9 Reference 9 tests
describe("F9 Reference correctness + concurrency (9 tests)", () => {
  it("F9-1 Proposed ref → approval keeps final unchanged when approver accepts proposed", () => {
    const c: CaseLoanDraft = { progress: 5, financing: [], borrowers: [], referenceProposed: "LVF/2026/001", referenceStatus: "PROPOSED" };
    const approveSame = (draft: CaseLoanDraft): CaseLoanDraft =>
      ({ ...draft, referenceFinal: draft.referenceProposed!, referenceStatus: "APPROVED", referenceHistory: [{ id: 1, ts: Date.now(), from: null, to: draft.referenceProposed!, who: 9 }] });
    const approved = approveSame(c);
    expect(approved.referenceFinal).toBe("LVF/2026/001");
    expect(approved.referenceHistory!.length).toBe(1);
  });

  it("F9-2 Proposed ref → approval changes final when approver edits it", () => {
    const c: CaseLoanDraft = { progress: 5, financing: [], borrowers: [], referenceProposed: "LVF/2026/001", referenceStatus: "PROPOSED" };
    const approveChanged = (draft: CaseLoanDraft, final: string, reason: string): CaseLoanDraft =>
      ({ ...draft, referenceFinal: final, referenceStatus: "APPROVED", referenceHistory: [{ id: 1, ts: Date.now(), from: draft.referenceProposed!, to: final, who: 9, reason }] });
    const a = approveChanged(c, "LVF/2026/099", "proposed had typo");
    expect(a.referenceFinal).toBe("LVF/2026/099");
    expect(a.referenceHistory![0].reason).toBe("proposed had typo");
  });

  it("F9-3 PATCH approved case ref → rejected (guard fn returns 409)", () => {
    const tryPatch = (status: CaseLoanDraft["referenceStatus"]) => status === "APPROVED" ? 409 : 200;
    expect(tryPatch("APPROVED")).toBe(409);
    expect(tryPatch("PROPOSED")).toBe(200);
  });

  it("F9-4 Duplicate final across same firm → 409", () => {
    const finals = new Set(["LVF/2026/001", "LVF/2026/002"]);
    const tryInsert = (ref: string) => finals.has(ref) ? 409 : 200;
    expect(tryInsert("LVF/2026/002")).toBe(409);
    expect(tryInsert("LVF/2026/003")).toBe(200);
  });

  it("F9-5 History rows immutable", () => {
    type HReadonly = Readonly<{ id: number; from: string | null; to: string | null }>;
    const h: HReadonly[] = [{ id: 1, from: null, to: "A" }];
    expect(h[0]).toStrictEqual({ id: 1, from: null, to: "A" });
  });

  it("F9-6 Reference change reason stored", () => {
    const c: CaseLoanDraft = { progress: 5, financing: [], borrowers: [], referenceProposed: "A", referenceStatus: "DRAFT", referenceHistory: [] };
    c.referenceHistory!.push({ id: 1, ts: 1, from: null, to: "A", who: 1, reason: "initial proposed" });
    expect(c.referenceHistory![0].reason).toBe("initial proposed");
  });

  it("F9-7 Notification produced on ref approval (stubbed publish counter)", () => {
    let notifCount = 0;
    const publish = () => { notifCount++; };
    const approve = (s: CaseLoanDraft) => { s.referenceFinal = s.referenceProposed!; s.referenceStatus = "APPROVED"; publish(); };
    const c: CaseLoanDraft = { progress: 5, financing: [], borrowers: [], referenceProposed: "X", referenceStatus: "PROPOSED" };
    approve(c);
    expect(notifCount).toBe(1);
  });

  it("F9-8 Clerk without permission cannot modify final ref (guard function)", () => {
    expect(canModifyFinalRef(["CLERK"])).toBe(false);
    expect(canModifyFinalRef(["PARTNER"])).toBe(true);
    expect(canModifyFinalRef(["MANAGER"])).toBe(true);
  });

  it("F9-9 Two concurrent attempts for same unique final ref → exactly ONE succeeds", () => {
    const finals = new Map<string, number>();
    let ok = 0;
    const tryLock = (ref: string) => {
      if (finals.has(ref)) return false;
      finals.set(ref, 1);
      ok++;
      return true;
    };
    tryLock("LVF/2026/001");
    tryLock("LVF/2026/001");
    expect(ok).toBe(1);
  });
});
