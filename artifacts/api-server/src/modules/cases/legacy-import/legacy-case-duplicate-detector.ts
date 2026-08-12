import { and, eq, or, sql, inArray } from "drizzle-orm";
import {
  casesTable,
  casePurchasersTable,
  clientsTable,
  legacyCaseImportRowsTable,
} from "@workspace/db";

export type LegacyHardDuplicateType = "reference_no" | "idempotency_key" | "already_created";

export type LegacyPossibleDuplicateResult = {
  caseId: number;
  referenceNo?: string | null;
  score: number;
};

export type LegacyDuplicateResult = {
  hard: null | { type: LegacyHardDuplicateType; caseId?: number };
  possible: LegacyPossibleDuplicateResult[];
};

type DbConnLike = any;

export function normalizeLegacyReference(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}

export function normalizeLegacyNric(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
}

export function normalizeLegacyName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}

export function normalizeLegacyParcel(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}

export function buildIdempotencyKey(
  firmId: number,
  batchId: number,
  sourceRowNo: number,
  rowHash: string,
): string {
  return `LEGACY_CASE_IMPORT:${firmId}:${batchId}:${sourceRowNo}:${rowHash}`;
}

type DetectLegacyDuplicatesParams = {
  firmId: number;
  batchId: number;
  sourceRowNo: number;
  idempotencyKey: string;
  referenceRaw: string | null;
  normalizedRef: string;
  projectId: number | null;
  developerId: number | null;
  normalizedParcel: string;
  purchaserIcArray: string[];
  purchaserNameArray: string[];
};

export async function detectLegacyDuplicates(
  r: DbConnLike,
  params: DetectLegacyDuplicatesParams,
): Promise<LegacyDuplicateResult> {
  const {
    firmId,
    batchId,
    sourceRowNo,
    idempotencyKey,
    normalizedRef,
    projectId,
    developerId,
    normalizedParcel,
    purchaserIcArray,
    purchaserNameArray,
  } = params;

  let hard: LegacyDuplicateResult["hard"] = null;

  const idemOrAlready = await r
    .select()
    .from(legacyCaseImportRowsTable)
    .where(
      and(
        eq(legacyCaseImportRowsTable.firmId, firmId),
        or(
          eq(legacyCaseImportRowsTable.idempotencyKey, idempotencyKey),
          and(
            eq(legacyCaseImportRowsTable.batchId, batchId),
            eq(legacyCaseImportRowsTable.sourceRowNo, sourceRowNo),
            sql`${legacyCaseImportRowsTable.createdCaseId} IS NOT NULL`,
          ),
        ),
      ),
    )
    .limit(1);

  if (idemOrAlready.length > 0) {
    const row = idemOrAlready[0];
    const isIdem = row.idempotencyKey === idempotencyKey;
    hard = {
      type: isIdem ? "idempotency_key" : "already_created",
      caseId: row.createdCaseId ?? undefined,
    };
  }

  if (!hard && normalizedRef.length > 0) {
    const refMatches = await r
      .select({ id: casesTable.id, referenceNo: casesTable.referenceNo })
      .from(casesTable)
      .where(
        and(
          eq(casesTable.firmId, firmId),
          sql`LOWER(${casesTable.referenceNo}) = LOWER(${normalizedRef})`,
        ),
      )
      .limit(1);

    if (refMatches.length > 0) {
      hard = { type: "reference_no", caseId: refMatches[0].id };
    }
  }

  if (hard !== null) {
    return { hard, possible: [] };
  }

  const possibleMap = new Map<number, LegacyPossibleDuplicateResult>();

  if (projectId !== null && normalizedParcel.length > 0 && purchaserIcArray.length > 0) {
    const score95Rows = await r
      .select({
        caseId: casesTable.id,
        referenceNo: casesTable.referenceNo,
      })
      .from(casesTable)
      .innerJoin(
        casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
      .innerJoin(
        clientsTable, eq(clientsTable.id, casePurchasersTable.clientId),
      )
      .where(
        and(
          eq(casesTable.firmId, firmId),
          eq(casesTable.projectId, projectId),
          sql`UPPER(${casesTable.parcelNo}) = UPPER(${normalizedParcel})`,
          inArray(sql`UPPER(${clientsTable.icNo})`, purchaserIcArray),
        ),
      );

    for (const row of score95Rows) {
        const existing = possibleMap.get(row.caseId);
        if (!existing || existing.score < 95) {
          possibleMap.set(row.caseId, { caseId: row.caseId, referenceNo: row.referenceNo, score: 95 });
        }
      }
  }

  if (developerId !== null && normalizedParcel.length > 0 && purchaserNameArray.length > 0) {
    const score85Rows = await r
      .select({
        caseId: casesTable.id,
        referenceNo: casesTable.referenceNo,
      })
      .from(casesTable)
      .innerJoin(
        casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
      .innerJoin(
        clientsTable, eq(clientsTable.id, casePurchasersTable.clientId),
      )
      .where(
        and(
          eq(casesTable.firmId, firmId),
          eq(casesTable.developerId, developerId),
          sql`UPPER(${casesTable.parcelNo}) = UPPER(${normalizedParcel})`,
          inArray(sql`UPPER(${clientsTable.name})`, purchaserNameArray),
        ),
      );

    for (const row of score85Rows) {
      const existing = possibleMap.get(row.caseId);
      if (!existing || existing.score < 85) {
        possibleMap.set(row.caseId, { caseId: row.caseId, referenceNo: row.referenceNo, score: 85 });
      }
    }
  }

  const possible = Array.from(possibleMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return { hard, possible };
}
