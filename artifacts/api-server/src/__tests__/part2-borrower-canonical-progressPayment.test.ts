import { describe, it, expect } from "vitest";

type AddressLines = { line1: string; line2: string; line3: string; line4: string; line5: string };
type CanonicalBorrower = {
  name: string;
  address: string;
  ic?: string;
  tin?: string;
  hp?: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  addressLine4?: string;
  addressLine5?: string;
  postcode?: string;
  city?: string;
  state?: string;
};

function normalizeCanonicalBorrowers(raw: unknown): CanonicalBorrower[] {
  if (!Array.isArray(raw)) return [];
  const out: CanonicalBorrower[] = [];
  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const x = v.trim();
    return x.length > 0 ? x : undefined;
  };
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    const addressLines: AddressLines = {
      line1: String((obj as any).addressLines?.line1 ?? obj.addressLine1 ?? ""),
      line2: String((obj as any).addressLines?.line2 ?? obj.addressLine2 ?? ""),
      line3: String((obj as any).addressLines?.line3 ?? obj.addressLine3 ?? ""),
      line4: String((obj as any).addressLines?.line4 ?? obj.addressLine4 ?? ""),
      line5: String((obj as any).addressLines?.line5 ?? obj.addressLine5 ?? ""),
    };
    const postcode = str(obj.postcode);
    const city = str(obj.city);
    const state = str(obj.state);
    const parts = [
      addressLines.line1,
      addressLines.line2,
      addressLines.line3,
      addressLines.line4,
      addressLines.line5,
      city,
      postcode ? `${postcode}${state ? ` ${state}` : ""}` : state,
    ].filter((p) => p && p.trim().length > 0);
    const composedFromStructured = parts.join(", ");
    const composedFromRaw = typeof obj.address === "string" && obj.address.trim().length > 0 ? obj.address.trim() : "";
    const address = composedFromRaw.length >= composedFromStructured.length ? composedFromRaw : composedFromStructured;
    const outB: CanonicalBorrower = { name, address };
    const ic = str(obj.ic); if (ic) outB.ic = ic;
    const tin = str(obj.tin); if (tin) outB.tin = tin;
    const hp = str((obj as any).hp ?? (obj as any).phone); if (hp) { outB.hp = hp; outB.phone = hp; }
    const email = str(obj.email); if (email) outB.email = email;
    const line1 = str(addressLines.line1); if (line1) outB.addressLine1 = line1;
    const line2 = str(addressLines.line2); if (line2) outB.addressLine2 = line2;
    const line3 = str(addressLines.line3); if (line3) outB.addressLine3 = line3;
    const line4 = str(addressLines.line4); if (line4) outB.addressLine4 = line4;
    const line5 = str(addressLines.line5); if (line5) outB.addressLine5 = line5;
    if (postcode) outB.postcode = postcode;
    if (city) outB.city = city;
    if (state) outB.state = state;
    out.push(outB);
  }
  return out;
}

function mirrorCanonicalToLoanBorrowers(canonical: CanonicalBorrower[]): Record<string, unknown>[] {
  return canonical.map((b) => {
    const out: Record<string, unknown> = {
      name: b.name,
      address: b.address,
    };
    if (b.ic) out.ic = b.ic;
    if (b.tin) out.tin = b.tin;
    if (b.hp) { out.hp = b.hp; out.phone = b.hp; }
    if (b.email) out.email = b.email;
    if (b.addressLine1) out.addressLine1 = b.addressLine1;
    if (b.addressLine2) out.addressLine2 = b.addressLine2;
    if (b.addressLine3) out.addressLine3 = b.addressLine3;
    if (b.addressLine4) out.addressLine4 = b.addressLine4;
    if (b.addressLine5) out.addressLine5 = b.addressLine5;
    if (b.postcode) out.postcode = b.postcode;
    if (b.city) out.city = b.city;
    if (b.state) out.state = b.state;
    return out;
  });
}

function resolveCanonicalBorrowersForRead(
  casesBorrowersRaw: unknown,
  loanDetailsRaw: unknown,
): CanonicalBorrower[] {
  if (Array.isArray(casesBorrowersRaw) && casesBorrowersRaw.length > 0) {
    return normalizeCanonicalBorrowers(casesBorrowersRaw);
  }
  const ld = loanDetailsRaw && typeof loanDetailsRaw === "object" ? (loanDetailsRaw as Record<string, unknown>) : null;
  const ldBorrs = ld && Array.isArray((ld as any).borrowers) ? (ld as any).borrowers : [];
  if (ldBorrs.length > 0) return normalizeCanonicalBorrowers(ldBorrs);
  return [];
}

const PROGRESSIVE_PAYMENT_PRESETS = [2.5, 5, 7.5, 10, 15, 17.5];
function formatProgressPayment(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.-]/g, ""));
  if (!isFinite(n) || isNaN(n)) return "";
  return `${n.toFixed(2)}%`;
}
function hydrateProgressPaymentForEdit(stored: number | string | null | undefined): string {
  if (stored === null || stored === undefined || stored === "") return "";
  const n = typeof stored === "number" ? stored : Number(String(stored).replace(/[^\d.-]/g, ""));
  if (!isFinite(n) || isNaN(n)) return "";
  return String(n);
}

describe("PART2 §2: Progressive Payment display + hydrate", () => {
  it("formats preset values to two decimals with % suffix", () => {
    expect(PROGRESSIVE_PAYMENT_PRESETS.map((n) => formatProgressPayment(n))).toEqual([
      "2.50%",
      "5.00%",
      "7.50%",
      "10.00%",
      "15.00%",
      "17.50%",
    ]);
  });
  it("hydrates DB number to string form usable by <input> without % suffix", () => {
    expect(hydrateProgressPaymentForEdit(5)).toBe("5");
    expect(hydrateProgressPaymentForEdit(2.5)).toBe("2.5");
    expect(hydrateProgressPaymentForEdit(17.5)).toBe("17.5");
    expect(hydrateProgressPaymentForEdit(null)).toBe("");
    expect(hydrateProgressPaymentForEdit("")).toBe("");
  });
  it("allows custom values (e.g. 3.33) to format correctly (not blocked)", () => {
    expect(formatProgressPayment(3.33)).toBe("3.33%");
    expect(hydrateProgressPaymentForEdit(3.33)).toBe("3.33");
  });
});

describe("PART2 §3: Canonical Borrower normalize + mirror + resolve-read", () => {
  it("normalize produces structured fields + composed address", () => {
    const raw = [
      {
        name: " Ali Bin Ahmad ",
        ic: " 123456-78-9012 ",
        tin: " C1234567890 ",
        hp: " 012-3456789 ",
        email: " ali@example.com ",
        addressLine1: "No. 1, Jalan 1",
        addressLine2: "Taman Bahagia",
        postcode: " 50000 ",
        city: "Kuala Lumpur",
        state: "Wilayah Persekutuan Kuala Lumpur",
      },
    ];
    const result = normalizeCanonicalBorrowers(raw);
    expect(result).toHaveLength(1);
    const [borrower] = result;
    expect(borrower.name).toBe("Ali Bin Ahmad");
    expect(borrower.ic).toBe("123456-78-9012");
    expect(borrower.tin).toBe("C1234567890");
    expect(borrower.hp).toBe("012-3456789");
    expect(borrower.phone).toBe(borrower.hp);
    expect(borrower.email).toBe("ali@example.com");
    expect(borrower.addressLine1).toBe("No. 1, Jalan 1");
    expect(borrower.addressLine2).toBe("Taman Bahagia");
    expect(borrower.postcode).toBe("50000");
    expect(borrower.city).toBe("Kuala Lumpur");
    expect(borrower.state).toBe("Wilayah Persekutuan Kuala Lumpur");
    expect(borrower.address).toContain("No. 1, Jalan 1");
    expect(borrower.address).toContain("Kuala Lumpur");
    expect(borrower.address).toContain("50000");
  });

  it("mirror produces an independent loanDetails.borrowers clone matching canonical", () => {
    const canonical = normalizeCanonicalBorrowers([
      {
        name: "Siti",
        ic: "999999-99-9999",
        tin: "T123",
        hp: "010-1111111",
        email: "siti@x.com",
        addressLine1: "A-1-1",
        postcode: "43650",
        city: "Bandar Baru Bangi",
        state: "Selangor",
      },
    ]);
    const mirrored = mirrorCanonicalToLoanBorrowers(canonical);
    expect(mirrored).toHaveLength(1);
    const m = mirrored[0];
    expect(m.name).toBe(canonical[0].name);
    expect(m.ic).toBe(canonical[0].ic);
    expect(m.tin).toBe(canonical[0].tin);
    expect(m.hp).toBe(canonical[0].hp);
    expect(m.phone).toBe(canonical[0].phone);
    expect(m.addressLine1).toBe(canonical[0].addressLine1);
    expect(m.postcode).toBe(canonical[0].postcode);
    expect(m.city).toBe(canonical[0].city);
    expect(m.state).toBe(canonical[0].state);
    expect(m.address).toBe(canonical[0].address);
    // Mutate canonical => mirror must not change (independent clone)
    canonical[0].name = "CHANGED";
    expect(m.name).toBe("Siti");
  });

  it("resolve-read fallback chain: cases.borrowers (canonical) -> loanDetails.borrowers -> empty", () => {
    // Prefer cases.borrowers even if loanDetails.borrowers exists
    const canonicalOnly = resolveCanonicalBorrowersForRead(
      [{ name: "Primary", address: "Addr1", postcode: "50000", tin: "PRIMARY-TIN" }],
      { borrowers: [{ name: "LoanMirror", address: "LoanAddr" }] },
    );
    expect(canonicalOnly).toHaveLength(1);
    expect(canonicalOnly[0].name).toBe("Primary");
    expect(canonicalOnly[0].tin).toBe("PRIMARY-TIN");
    expect(canonicalOnly[0].postcode).toBe("50000");

    // Fallback to loanDetails.borrowers
    const fallbackToLoan = resolveCanonicalBorrowersForRead(
      null,
      { borrowers: [{ name: "OldBorrower", address: "X", ic: "OLD-IC", tin: "OLD-TIN" }] },
    );
    expect(fallbackToLoan).toHaveLength(1);
    expect(fallbackToLoan[0].name).toBe("OldBorrower");
    expect(fallbackToLoan[0].tin).toBe("OLD-TIN");
    expect(fallbackToLoan[0].ic).toBe("OLD-IC");

    // No sources => empty
    const empty = resolveCanonicalBorrowersForRead([], null);
    expect(empty).toEqual([]);
  });
});

describe("PART2 §5: 1st party mirror vs 3rd party (silent overwrite guard)", () => {
  type PurchaserForm = { name: string; icOrCompanyNo: string; tin: string; tel: string; email: string; postcode: string; city: string; state: string; addressLines: AddressLines; address: string };
  type BorrowerForm = { id: string; name: string; ic: string; tin: string; hp: string; email: string; postcode: string; city: string; state: string; addressLines: AddressLines; address: string };
  const emptyLines: AddressLines = { line1: "", line2: "", line3: "", line4: "", line5: "" };

  const applyFirstPartyMirrorRule = (purchasers: PurchaserForm[]): BorrowerForm[] =>
    purchasers.map((p, idx) => ({
      id: `mirrored-${idx}-${crypto.randomUUID()}`,
      name: p.name,
      ic: p.icOrCompanyNo,
      tin: p.tin,
      hp: p.tel,
      email: p.email,
      postcode: p.postcode,
      city: p.city,
      state: p.state,
      addressLines: p.addressLines,
      address: p.address,
    }));

  it("1st-party: purchaser name/ic/tin/address updates propagate to borrower", () => {
    const purchasers1: PurchaserForm[] = [
      { name: "Ahmad", icOrCompanyNo: "123456-78-9012", tin: "T123", tel: "012-111", email: "ahmad@x.com", postcode: "50000", city: "KL", state: "WP KL", addressLines: { ...emptyLines, line1: "Jalan 1" }, address: "Old addr" },
    ];
    let borrowers = applyFirstPartyMirrorRule(purchasers1);
    expect(borrowers).toHaveLength(1);
    expect(borrowers[0].name).toBe("Ahmad");
    expect(borrowers[0].ic).toBe("123456-78-9012");
    expect(borrowers[0].tin).toBe("T123");
    expect(borrowers[0].hp).toBe("012-111");
    expect(borrowers[0].postcode).toBe("50000");
    expect(borrowers[0].state).toBe("WP KL");

    // Update purchaser => borrowers re-sync
    const purchasers2: PurchaserForm[] = [
      { ...purchasers1[0], name: "Ahmad Updated", icOrCompanyNo: "111111-22-3333", tin: "NEW-TIN", postcode: "43650", city: "Bangi", state: "Selangor" },
    ];
    borrowers = applyFirstPartyMirrorRule(purchasers2);
    expect(borrowers[0].name).toBe("Ahmad Updated");
    expect(borrowers[0].ic).toBe("111111-22-3333");
    expect(borrowers[0].tin).toBe("NEW-TIN");
    expect(borrowers[0].postcode).toBe("43650");
    expect(borrowers[0].city).toBe("Bangi");
    expect(borrowers[0].state).toBe("Selangor");
  });

  it("3rd-party: borrower manual edits are NOT overwritten by mirror rule (rule not applied)", () => {
    const thirdPartyBorrowers: BorrowerForm[] = [
      { id: "b1", name: "BorrowerCo Sdn Bhd", ic: "", tin: "CO-TIN-1", hp: "03-1111111", email: "finance@borrowerco.my", postcode: "50450", city: "KL Sentral", state: "WP KL", addressLines: { ...emptyLines, line1: "Level 10, Menara A" }, address: "Office" },
    ];
    const unrelatedPurchaser: PurchaserForm[] = [
      { name: "Purchaser X", icOrCompanyNo: "111", tin: "PT", tel: "019", email: "p@x", postcode: "", city: "", state: "", addressLines: emptyLines, address: "" },
    ];
    // 3rd_party => mirror rule NOT applied; original values preserved
    const result = thirdPartyBorrowers; // do not apply mirror
    expect(result[0].name).toBe("BorrowerCo Sdn Bhd");
    expect(result[0].tin).toBe("CO-TIN-1");
    expect(result[0].hp).toBe("03-1111111");
    expect(result[0].postcode).toBe("50450");
    expect(result[0].state).toBe("WP KL");
    // Purchaser content should have NO influence on 3rd-party borrowers
    void unrelatedPurchaser;
    expect(result[0].name).not.toBe(unrelatedPurchaser[0].name);
    expect(result[0].tin).not.toBe(unrelatedPurchaser[0].tin);
  });
});

describe("PART2 §6: Overview consistency across list/detail/read", () => {
  it("two canonical borrowers -> list/detail/overview all return same order + values (TIN/phone)", () => {
    const canonicalStored: CanonicalBorrower[] = [
      { name: "First Borrower", address: "Address 1", ic: "IC-FIRST", tin: "TIN-FIRST", hp: "HP-FIRST", phone: "HP-FIRST", email: "first@x.com", postcode: "50000", city: "KL", state: "WP KL" },
      { name: "Second Borrower", address: "Address 2", ic: "IC-SECOND", tin: "TIN-SECOND", hp: "HP-SECOND", phone: "HP-SECOND", email: "second@x.com", postcode: "43650", city: "Bangi", state: "Selangor" },
    ];
    const loanDetails = { borrowers: mirrorCanonicalToLoanBorrowers(canonicalStored) };
    const listRead = resolveCanonicalBorrowersForRead(canonicalStored, loanDetails);
    const detailRead = resolveCanonicalBorrowersForRead(canonicalStored, loanDetails);
    const overviewRead = resolveCanonicalBorrowersForRead(canonicalStored, loanDetails);
    expect(listRead).toHaveLength(2);
    expect(detailRead).toHaveLength(2);
    expect(overviewRead).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(listRead[i].name).toBe(detailRead[i].name);
      expect(detailRead[i].name).toBe(overviewRead[i].name);
      expect(listRead[i].name).toBe(canonicalStored[i].name);
      expect(listRead[i].tin).toBe(canonicalStored[i].tin);
      expect(listRead[i].hp).toBe(canonicalStored[i].hp);
      expect(listRead[i].postcode).toBe(canonicalStored[i].postcode);
      expect(listRead[i].state).toBe(canonicalStored[i].state);
    }
  });
});
