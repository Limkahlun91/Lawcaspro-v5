export type PurchaserRowLike = {
  role?: unknown;
  order_no?: unknown;
  name?: unknown;
  ic_no?: unknown;
  nationality?: unknown;
  address?: unknown;
  phone?: unknown;
  email?: unknown;
};

export type NormalizedPurchaserRow = PurchaserRowLike & {
  name: string;
  ic_no: string;
};

function isNotNull<T>(v: T | null | undefined): v is T {
  return v != null;
}

export function normalizePurchaserRows(rows: PurchaserRowLike[] | null | undefined): NormalizedPurchaserRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((p) => {
      const name = typeof p?.name === "string" ? p.name.trim() : String(p?.name ?? "").trim();
      const icNo = typeof p?.ic_no === "string" ? p.ic_no.trim() : String(p?.ic_no ?? "").trim();
      if (!name) return null;
      const row: NormalizedPurchaserRow = {
        ...p,
        name,
        ic_no: icNo,
      };
      return row;
    })
    .filter(isNotNull);
}

export function normalizeSpaPurchasers(rows: unknown): NormalizedPurchaserRow[] {
  const arr = Array.isArray(rows) ? rows : [];
  return arr
    .map((p: any, idx: number) => {
      const name = typeof p?.name === "string" ? p.name.trim() : "";
      if (!name) return null;
      const ic = typeof (p?.ic ?? p?.nric ?? p?.id_no ?? p?.identity_no) === "string"
        ? String(p.ic ?? p.nric ?? p.id_no ?? p.identity_no).trim()
        : "";
      const row: NormalizedPurchaserRow = {
        role: idx === 0 ? "main" : "purchaser",
        order_no: idx + 1,
        name,
        ic_no: ic,
        nationality: typeof p?.nationality === "string" ? p.nationality : "",
        address: typeof p?.address === "string" ? p.address : "",
        phone: typeof p?.phone === "string" ? p.phone : "",
        email: typeof p?.email === "string" ? p.email : "",
      };
      return row;
    })
    .filter(isNotNull);
}

export function selectPurchaserSource(args: {
  fromCasePurchasers: PurchaserRowLike[] | null | undefined;
  fromCaseParties: PurchaserRowLike[] | null | undefined;
  fromSpaDetails: unknown;
}): { purchaserSourceUsed: "case_purchasers" | "case_parties" | "spa_details" | "none"; purchaserRows: PurchaserRowLike[] } {
  const a = normalizePurchaserRows(args.fromCasePurchasers);
  if (a.length > 0) return { purchaserSourceUsed: "case_purchasers", purchaserRows: a };
  const b = normalizePurchaserRows(args.fromCaseParties);
  if (b.length > 0) return { purchaserSourceUsed: "case_parties", purchaserRows: b };
  const c = normalizeSpaPurchasers(args.fromSpaDetails);
  if (c.length > 0) return { purchaserSourceUsed: "spa_details", purchaserRows: c };
  return { purchaserSourceUsed: "none", purchaserRows: [] };
}

function setAlias(out: Record<string, unknown>, key: string, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(out, key)) return;
  out[key] = value;
}

export function applyCaseVariableAliases(context: Record<string, unknown>): Record<string, unknown> {
  const out = { ...context };
  const referenceNo = typeof out.reference_no === "string" ? out.reference_no : typeof (out as any).case_reference === "string" ? (out as any).case_reference : "";
  const status = typeof out.status === "string" ? out.status : typeof (out as any).case_status === "string" ? (out as any).case_status : "";

  setAlias(out, "case_reference", referenceNo);
  setAlias(out, "our_reference", referenceNo);
  setAlias(out, "file_reference", referenceNo);
  setAlias(out, "case_status", status);

  const purchaserName =
    typeof out.purchaser_name === "string" ? out.purchaser_name
      : typeof (out as any).client_name === "string" ? (out as any).client_name
        : typeof (out as any).buyer_name === "string" ? (out as any).buyer_name
          : "";
  const purchaserNric =
    typeof out.purchaser_nric === "string" ? out.purchaser_nric
      : typeof out.purchaser_ic === "string" ? out.purchaser_ic
        : typeof (out as any).client_nric === "string" ? (out as any).client_nric
          : typeof (out as any).buyer_nric === "string" ? (out as any).buyer_nric
            : "";

  setAlias(out, "purchaser_full_name", purchaserName);
  setAlias(out, "buyer_name", purchaserName);
  setAlias(out, "client_name", purchaserName);
  setAlias(out, "purchaser_nric", purchaserNric);
  setAlias(out, "buyer_nric", purchaserNric);
  setAlias(out, "client_nric", purchaserNric);
  setAlias(out, "purchaser_ic", purchaserNric);

  setAlias(out, "property_project", out.project_name);
  setAlias(out, "project_name", out.project_name);
  setAlias(out, "developer_name", out.developer_name);
  setAlias(out, "loan_bank", out.end_financier);
  setAlias(out, "loan_amount", out.financing_sum);

  const p1 = typeof (out as any).purchaser_1_name === "string" ? String((out as any).purchaser_1_name) : "";
  const p2 = typeof (out as any).purchaser_2_name === "string" ? String((out as any).purchaser_2_name) : "";
  const p3 = typeof (out as any).purchaser_3_name === "string" ? String((out as any).purchaser_3_name) : "";

  setAlias(out, "purchaser1_name", p1);
  setAlias(out, "purchaser2_name", p2);
  setAlias(out, "purchaser3_name", p3);
  setAlias(out, "buyer1_name", p1);
  setAlias(out, "buyer2_name", p2);
  setAlias(out, "buyer3_name", p3);

  const purchaserNamesJoined =
    typeof (out as any).purchaser_names === "string" ? String((out as any).purchaser_names)
      : typeof (out as any).purchasers_names === "string" ? String((out as any).purchasers_names)
        : "";
  setAlias(out, "purchaser_names", purchaserNamesJoined);
  setAlias(out, "purchasers_names", purchaserNamesJoined);
  setAlias(out, "buyer_names", purchaserNamesJoined);
  setAlias(out, "client_names", purchaserNamesJoined);

  return out;
}
