import { sql } from "@workspace/db";

type DbConn = { execute: (q: any) => any };

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

export type WritebackOutcome = { applied: boolean; skippedReason: string | null; oldValue: unknown; newValue: unknown; target: string };

export async function applyExtractionSuggestion(params: {
  r: DbConn;
  firmId: number;
  caseId: number;
  actorId: number;
  suggestion: {
    fieldKey: string;
    suggestedValue: string | null;
    targetEntityType: string | null;
    targetEntityId?: number | null;
    targetEntityPath?: string | null;
    chosenTargetCandidate?: unknown;
  };
  overrideExisting: boolean;
  dryRun?: boolean;
}): Promise<WritebackOutcome> {
  const fieldKey = String(params.suggestion.fieldKey || "");
  const value = params.suggestion.suggestedValue === null ? "" : String(params.suggestion.suggestedValue || "");
  const chosen = params.suggestion.chosenTargetCandidate && typeof params.suggestion.chosenTargetCandidate === "object"
    ? (params.suggestion.chosenTargetCandidate as Record<string, unknown>)
    : null;
  const targetType = String((chosen?.targetEntityType as any) ?? params.suggestion.targetEntityType ?? "");
  const targetPath = String((chosen?.targetEntityPath as any) ?? params.suggestion.targetEntityPath ?? "");
  const targetId = typeof (chosen?.targetEntityId) === "number" ? Number(chosen?.targetEntityId) : (typeof params.suggestion.targetEntityId === "number" ? params.suggestion.targetEntityId : null);
  const dryRun = Boolean(params.dryRun);

  const [caseRow] = await queryRows(params.r, sql`
    SELECT id, reference_no, parcel_no, spa_price, spa_details, property_details, loan_details
    FROM cases
    WHERE id = ${params.caseId} AND firm_id = ${params.firmId}
    LIMIT 1
  `);
  if (!caseRow) return { applied: false, skippedReason: "Case not found", oldValue: null, newValue: value, target: "case" };

  const spa = parseJsonObject(caseRow.spa_details);
  const prop = parseJsonObject(caseRow.property_details);
  const loan = parseJsonObject(caseRow.loan_details);

  const updateCaseJson = async (updates: { spa?: Record<string, unknown>; prop?: Record<string, unknown>; loan?: Record<string, unknown>; parcelNo?: string | null; spaPrice?: string | number | null }) => {
    const nextSpa = updates.spa ?? spa;
    const nextProp = updates.prop ?? prop;
    const nextLoan = updates.loan ?? loan;
    if (!dryRun) {
      await queryRows(params.r, sql`
        UPDATE cases
        SET
          parcel_no = COALESCE(${updates.parcelNo as any}, parcel_no),
          spa_price = COALESCE(${updates.spaPrice as any}, spa_price),
          spa_details = ${JSON.stringify(nextSpa)},
          property_details = ${JSON.stringify(nextProp)},
          loan_details = ${JSON.stringify(nextLoan)},
          updated_at = now()
        WHERE id = ${params.caseId} AND firm_id = ${params.firmId}
      `);
    }
  };

  if (targetType === "client_primary_purchaser" || targetType === "client") {
    let clientId = targetId;
    if (!clientId) {
      const [cp] = await queryRows(params.r, sql`
        SELECT cp.client_id
        FROM case_purchasers cp
        WHERE cp.case_id = ${params.caseId}
        ORDER BY cp.order_no ASC
        LIMIT 1
      `);
      clientId = cp && typeof cp.client_id === "number" ? (cp.client_id as number) : null;
    }
    if (!clientId) return { applied: false, skippedReason: "Primary purchaser not found", oldValue: null, newValue: value, target: "client_primary_purchaser" };
    const [client] = await queryRows(params.r, sql`SELECT id, name, ic_no, address, nationality FROM clients WHERE id = ${clientId} AND firm_id = ${params.firmId} LIMIT 1`);
    if (!client) return { applied: false, skippedReason: "Client not found", oldValue: null, newValue: value, target: "client" };

    if (fieldKey === "full_name") {
      if (!params.overrideExisting && !isEmptyValue(client.name)) return { applied: false, skippedReason: "Existing value not empty", oldValue: client.name, newValue: value, target: "client.name" };
      if (!dryRun) await queryRows(params.r, sql`UPDATE clients SET name = ${value}, updated_at = now() WHERE id = ${clientId} AND firm_id = ${params.firmId}`);
      return { applied: true, skippedReason: null, oldValue: client.name, newValue: value, target: "client.name" };
    }
    if (fieldKey === "ic_passport_no") {
      const old = client.ic_no;
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "client.ic_no" };
      if (!dryRun) await queryRows(params.r, sql`UPDATE clients SET ic_no = ${value}, updated_at = now() WHERE id = ${clientId} AND firm_id = ${params.firmId}`);
      return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "client.ic_no" };
    }
    if (fieldKey === "address") {
      const old = client.address;
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "client.address" };
      if (!dryRun) await queryRows(params.r, sql`UPDATE clients SET address = ${value}, updated_at = now() WHERE id = ${clientId} AND firm_id = ${params.firmId}`);
      return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "client.address" };
    }
    if (fieldKey === "nationality") {
      const old = client.nationality;
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "client.nationality" };
      if (!dryRun) await queryRows(params.r, sql`UPDATE clients SET nationality = ${value}, updated_at = now() WHERE id = ${clientId} AND firm_id = ${params.firmId}`);
      return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "client.nationality" };
    }
  }

  if (fieldKey === "our_ref") {
    const old = (caseRow as any).reference_no;
    if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.reference_no" };
    if (!dryRun) await queryRows(params.r, sql`UPDATE cases SET reference_no = ${value}, updated_at = now() WHERE id = ${params.caseId} AND firm_id = ${params.firmId}`);
    return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "cases.reference_no" };
  }

  if (fieldKey === "parcel_no") {
    const old = caseRow.parcel_no;
    if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.parcel_no" };
    await updateCaseJson({ parcelNo: value });
    return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "cases.parcel_no" };
  }

  if (fieldKey === "purchase_price") {
    const old = caseRow.spa_price;
    if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.spa_price" };
    const numeric = Number(String(value).replace(/[^\d.]/g, ""));
    const next = Number.isFinite(numeric) ? numeric : null;
    await updateCaseJson({ spaPrice: next });
    return { applied: true, skippedReason: null, oldValue: old, newValue: next, target: "cases.spa_price" };
  }

  if (targetType === "case_spa" && fieldKey === "purchaser_names") {
    const purchasers = Array.isArray((spa as any).purchasers) ? ((spa as any).purchasers as any[]) : [];
    const old = purchasers.map((p) => p?.name).filter(Boolean).join(", ");
    if (!params.overrideExisting && old.trim()) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.spa_details.purchasers" };
    const names = value.split(/,|&|and/i).map((x) => x.trim()).filter(Boolean).slice(0, 2);
    const nextPurchasers = names.map((n, i) => ({ ...(purchasers[i] ?? {}), name: n }));
    (spa as any).purchasers = nextPurchasers;
    await updateCaseJson({ spa });
    return { applied: true, skippedReason: null, oldValue: old, newValue: names.join(", "), target: "cases.spa_details.purchasers" };
  }

  if (targetType === "case_property" && fieldKey === "unit_no") {
    const old = (prop as any).buildingNo ?? "";
    if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.property_details.buildingNo" };
    (prop as any).buildingNo = value;
    await updateCaseJson({ prop });
    return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "cases.property_details.buildingNo" };
  }

  if (targetType === "case_property") {
    const map: Record<string, string> = {
      unit_no: "buildingNo",
      building_no: "buildingNo",
      storey_no: "floorNo",
      lot_no: "lotNo",
      hakmilik_no: "hakmilikNo",
      mukim: "mukim",
      bandar_pekan: "bandarPekan",
      title_type: "titleType",
      title_sub_type: "titleSubType",
      project_name: "projectName",
    };
    const key = map[fieldKey];
    if (key) {
      const old = (prop as any)[key] ?? "";
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: `cases.property_details.${key}` };
      (prop as any)[key] = value;
      await updateCaseJson({ prop });
      return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: `cases.property_details.${key}` };
    }
  }

  if (targetType === "case_loan") {
    if (fieldKey === "bank_name") {
      const old = (loan as any).endFinancier ?? "";
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.loan_details.endFinancier" };
      (loan as any).endFinancier = value;
      await updateCaseJson({ loan });
      return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "cases.loan_details.endFinancier" };
    }
    if (fieldKey === "bank_ref_no") {
      const old = (loan as any).bankRef ?? "";
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.loan_details.bankRef" };
      (loan as any).bankRef = value;
      await updateCaseJson({ loan });
      return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: "cases.loan_details.bankRef" };
    }
    if (fieldKey === "borrower_name") {
      const dest = targetPath && /borrower\dName$/.test(targetPath) ? targetPath.split(".").slice(-1)[0] : "borrower1Name";
      const old = (loan as any)[dest] ?? "";
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: `cases.loan_details.${dest}` };
      (loan as any)[dest] = value;
      await updateCaseJson({ loan });
      return { applied: true, skippedReason: null, oldValue: old, newValue: value, target: `cases.loan_details.${dest}` };
    }
    if (fieldKey === "financing_amount") {
      const old = (loan as any).financingSum ?? null;
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.loan_details.financingSum" };
      const numeric = Number(String(value).replace(/[^\d.]/g, ""));
      const next = Number.isFinite(numeric) ? numeric : null;
      (loan as any).financingSum = next;
      await updateCaseJson({ loan });
      return { applied: true, skippedReason: null, oldValue: old, newValue: next, target: "cases.loan_details.financingSum" };
    }
    if (fieldKey === "loan_percentage") {
      const old = (loan as any).loanPercentage ?? null;
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "cases.loan_details.loanPercentage" };
      const numeric = Number(String(value).replace(/[^\d.]/g, ""));
      const next = Number.isFinite(numeric) ? numeric : null;
      (loan as any).loanPercentage = next;
      await updateCaseJson({ loan });
      return { applied: true, skippedReason: null, oldValue: old, newValue: next, target: "cases.loan_details.loanPercentage" };
    }
  }

  if (targetType === "case_key_dates") {
    if (fieldKey === "lo_date") {
      const [kd] = await queryRows(params.r, sql`SELECT id, letter_of_offer_date FROM case_key_dates WHERE firm_id = ${params.firmId} AND case_id = ${params.caseId} LIMIT 1`);
      const old = kd?.letter_of_offer_date ?? null;
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "case_key_dates.letter_of_offer_date" };
      const [d, m, y] = value.split(/[\/\-]/).map((x) => x.trim());
      const iso = (y && m && d) ? `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : null;
      if (!dryRun) {
        if (kd?.id) {
          await queryRows(params.r, sql`UPDATE case_key_dates SET letter_of_offer_date = ${iso as any}, updated_at = now() WHERE id = ${kd.id} AND firm_id = ${params.firmId} AND case_id = ${params.caseId}`);
        } else {
          await queryRows(params.r, sql`INSERT INTO case_key_dates (firm_id, case_id, letter_of_offer_date) VALUES (${params.firmId}, ${params.caseId}, ${iso as any})`);
        }
      }
      return { applied: true, skippedReason: null, oldValue: old, newValue: iso, target: "case_key_dates.letter_of_offer_date" };
    }
    if (fieldKey === "spa_date") {
      const [kd] = await queryRows(params.r, sql`SELECT id, spa_date FROM case_key_dates WHERE firm_id = ${params.firmId} AND case_id = ${params.caseId} LIMIT 1`);
      const old = kd?.spa_date ?? null;
      if (!params.overrideExisting && !isEmptyValue(old)) return { applied: false, skippedReason: "Existing value not empty", oldValue: old, newValue: value, target: "case_key_dates.spa_date" };
      const [d, m, y] = value.split(/[\/\-]/).map((x) => x.trim());
      const iso = (y && m && d) ? `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : null;
      if (!dryRun) {
        if (kd?.id) {
          await queryRows(params.r, sql`UPDATE case_key_dates SET spa_date = ${iso as any}, updated_at = now() WHERE id = ${kd.id} AND firm_id = ${params.firmId} AND case_id = ${params.caseId}`);
        } else {
          await queryRows(params.r, sql`INSERT INTO case_key_dates (firm_id, case_id, spa_date) VALUES (${params.firmId}, ${params.caseId}, ${iso as any})`);
        }
      }
      return { applied: true, skippedReason: null, oldValue: old, newValue: iso, target: "case_key_dates.spa_date" };
    }
  }

  return { applied: false, skippedReason: "No writeback mapping for field", oldValue: null, newValue: value, target: `${targetType}:${fieldKey}` };
}
