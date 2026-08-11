import { and, eq } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, boolean, index, uniqueIndex, date, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  casesTable,
  caseKeyDatesTable,
  casePurchasersTable,
  clientsTable,
  userNotificationsTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

const himsDataComparisonsTable = pgTable("hims_data_comparisons", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  comparisonBatchId: text("comparison_batch_id").notNull(),
  fieldKey: text("field_key").notNull(),
  sourceSystem: text("source_system").notNull().default("HIMS"),
  targetSystem: text("target_system").notNull().default("LAWCASPRO"),
  sourceValueText: text("source_value_text"),
  targetValueText: text("target_value_text"),
  sourceValueJson: jsonb("source_value_json"),
  targetValueJson: jsonb("target_value_json"),
  matchStatus: text("match_status").notNull().default("match"),
  matchScore: numeric("match_score", { precision: 5, scale: 4 }),
  mismatchReason: text("mismatch_reason"),
  normalizedSourceValue: text("normalized_source_value"),
  normalizedTargetValue: text("normalized_target_value"),
  notificationIdempotencyKey: text("notification_idempotency_key"),
  notificationCreated: boolean("notification_created").notNull().default(false),
  comparedByUserId: integer("compared_by_user_id"),
  comparedAt: timestamp("compared_at", { withTimezone: true }).notNull().defaultNow(),
  autoCorrectedInLawcaspro: boolean("auto_corrected_in_lawcaspro").notNull().default(false),
  correctionNote: text("correction_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_hims_data_comparisons_firm").on(t.firmId),
  firmCaseIdx: index("idx_hims_data_comparisons_firm_case").on(t.firmId, t.caseId, t.createdAt),
  firmStatusIdx: index("idx_hims_data_comparisons_status").on(t.firmId, t.matchStatus, t.createdAt),
  firmBatchIdx: index("idx_hims_data_comparisons_batch").on(t.firmId, t.comparisonBatchId),
  uqCaseField: uniqueIndex("uq_hims_data_comparisons_case_field_batch").on(t.firmId, t.caseId, t.fieldKey, t.comparisonBatchId),
}));

export type HimsMatchStatus = "match" | "mismatch" | "missing_in_source" | "missing_in_target" | "error";

export interface HimsCaseFieldValue {
  fieldKey: string;
  valueText?: string | null;
  valueJson?: Record<string, unknown> | null;
}

export interface HimsEkycSourceRecord {
  caseId?: number | null;
  himsCaseRef?: string | null;
  ekycTransactionId?: string | null;
  ekycVerifiedAt?: Date | string | null;
  fields: HimsCaseFieldValue[];
  purchasers?: Array<{
    name?: string | null;
    icNumber?: string | null;
    passportNo?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  }>;
}

export interface CompareLawcasproHimsEkycInput {
  firmId: number;
  caseId: number;
  actorUserId?: number | null;
  himsRecord?: HimsEkycSourceRecord | null;
  ekycRecord?: HimsEkycSourceRecord | null;
  comparisonBatchId?: string | null;
  notifyOnMismatch?: boolean;
}

export interface HimsDataComparisonRow {
  id: number;
  fieldKey: string;
  sourceValueText: string | null;
  targetValueText: string | null;
  matchStatus: HimsMatchStatus;
  matchScore: string | null;
  mismatchReason: string | null;
  notificationIdempotencyKey: string | null;
  notificationCreated: boolean;
}

export interface CompareLawcasproHimsEkycResult {
  comparisonBatchId: string;
  caseId: number;
  firmId: number;
  comparedAt: Date;
  totalFields: number;
  matchedCount: number;
  mismatchedCount: number;
  missingInSourceCount: number;
  missingInTargetCount: number;
  errorCount: number;
  notificationsCreated: number;
  comparisons: HimsDataComparisonRow[];
}

function normalizeFieldValue(input: unknown): string {
  if (input === null || input === undefined) return "";
  let s: string;
  if (typeof input === "string") s = input;
  else if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) return "";
    const y = input.getFullYear();
    const m = String(input.getMonth() + 1).padStart(2, "0");
    const d = String(input.getDate()).padStart(2, "0");
    s = `${y}-${m}-${d}`;
  } else if (typeof input === "number") s = String(input);
  else s = JSON.stringify(input);

  return s
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.,;:()\[\]{}'\"`\-_/\\|!@#$%^&*+=<>?~]/g, "")
    .trim();
}

function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > Math.max(la, lb)) return 0;
  let matches = 0;
  const shortLen = Math.min(la, lb);
  for (let i = 0; i < shortLen; i++) {
    if (a[i] === b[i]) matches++;
  }
  const subseq = matches / Math.max(la, lb);
  let overlap = 0;
  const setA = new Set(a);
  for (const ch of b) if (setA.has(ch)) overlap++;
  const charSim = overlap / Math.max(la, lb);
  return Math.max(subseq, charSim);
}

async function loadLawcasproCaseFields(
  conn: DbConnLike,
  firmId: number,
  caseId: number,
): Promise<{ [fieldKey: string]: { valueText: string | null; valueJson: unknown | null } }> {
  const out: { [k: string]: { valueText: string | null; valueJson: unknown | null } } = {};

  try {
    const caseCols: any = { id: (casesTable as any).id };
    const candidateCaseCols = [
      "referenceNo", "caseType", "status", "purchaseMode", "titleType", "tenure",
      "actingFor", "perfectionType", "parcelNo", "spaDetails",
      "spaPrice", "apdlPrice", "developerDiscount", "bumiputraDiscount",
      "amountPaid", "outstandingBalance", "approvalStatus",
    ];
    for (const col of candidateCaseCols) {
      if ((casesTable as any)[col] !== undefined) caseCols[col] = (casesTable as any)[col];
    }
    if ((casesTable as any).propertyDetails) caseCols.propertyDetails = (casesTable as any).propertyDetails;
    if ((casesTable as any).loanDetails) caseCols.loanDetails = (casesTable as any).loanDetails;
    if ((casesTable as any).borrowers) caseCols.borrowers = (casesTable as any).borrowers;

    const caseRow = (await conn
      .select(caseCols)
      .from(casesTable as any)
      .where(and(
        eq((casesTable as any).firmId, firmId),
        eq((casesTable as any).id, caseId),
      ))
      .limit(1))?.[0] as any;

    if (caseRow) {
      for (const col of Object.keys(caseCols)) {
        if (col === "id") continue;
        const val = caseRow[col];
        if (val === null || val === undefined) continue;
        const key = `cases.${col}`;
        if (typeof val === "object" && val !== null) {
          out[key] = { valueText: null, valueJson: val };
        } else {
          out[key] = { valueText: String(val), valueJson: null };
        }
      }
    }
  } catch {
    // non-fatal
  }

  try {
    const keyDateCols: any = { id: (caseKeyDatesTable as any).id };
    const keyDateFields = [
      "spaSignedDate", "spaDate", "spaStampedDate",
      "spaForwardToDeveloperExecutionOn", "spaReceivedDevReturnSpaOn",
      "stampedSpaSendToDeveloperOn", "stampedSpaReceivedFromDeveloperOn", "stampedSpaSentToPurchaserOn",
      "liDate", "liReceivedOn", "letterOfOfferDate", "letterOfOfferStampedDate", "suppLoDate",
      "loanDocsPendingDate", "loanDocsSignedDate", "actingLetterIssuedDate",
      "developerConfirmationReceivedOn", "developerConfirmationDate",
      "loanSentBankExecutionDate", "loanBankExecutedDate",
      "bankLuDated", "bankLuReceivedDate", "bankLuForwardToDeveloperOn",
      "developerLuReceivedOn", "developerLuDated",
      "letterDisclaimerReceivedOn", "letterDisclaimerDated",
      "loanAgreementDated", "loanAgreementSubmittedStampingDate", "loanAgreementStampedDate",
      "faDate", "faAdjudicationNumber", "faStampOn",
      "doaDate", "doaStampOn", "poaDate", "poaStampOn",
      "noaDated", "registerPaOn", "paNo", "registerPoaOn", "registeredPoaRegistrationNumber",
      "noaServedOn", "adviceToBankDate", "bank1stReleaseOn",
      "dischargeDate", "dischargeTitleReceivedOn",
      "consentToTransferDate", "consentToChargeDate", "caveatLodgedDate", "chargeDate",
      "chargeSubmitStamping", "chargeStamped", "presentationDate",
      "motReceivedDate", "motSignedDate", "motSubmitStamping", "motStampedDate", "motRegisteredDate",
      "progressivePaymentDate", "fullSettlementDate", "completionDate",
    ];
    for (const f of keyDateFields) {
      if ((caseKeyDatesTable as any)[f] !== undefined) keyDateCols[f] = (caseKeyDatesTable as any)[f];
    }

    const kdRow = (await conn
      .select(keyDateCols)
      .from(caseKeyDatesTable as any)
      .where(and(
        eq((caseKeyDatesTable as any).firmId, firmId),
        eq((caseKeyDatesTable as any).caseId, caseId),
      ))
      .limit(1))?.[0] as any;

    if (kdRow) {
      for (const f of keyDateFields) {
        if (kdRow[f] === null || kdRow[f] === undefined) continue;
        const key = `case_key_dates.${f}`;
        const v = kdRow[f];
        if (v instanceof Date) {
          const y = v.getFullYear();
          const m = String(v.getMonth() + 1).padStart(2, "0");
          const d = String(v.getDate()).padStart(2, "0");
          out[key] = { valueText: `${y}-${m}-${d}`, valueJson: null };
        } else {
          out[key] = { valueText: String(v), valueJson: null };
        }
      }
    }
  } catch {
    // non-fatal
  }

  try {
    const purchasers = await conn
      .select({
        clientId: casePurchasersTable.clientId,
        role: casePurchasersTable.role,
        orderNo: casePurchasersTable.orderNo,
      })
      .from(casePurchasersTable)
      .where(eq(casePurchasersTable.caseId, caseId))
      .limit(10);

    for (let idx = 0; idx < (purchasers ?? []).length; idx++) {
      const p = purchasers![idx];
      const clientId = Number((p as any).clientId);
      if (!clientId) continue;
      const cli = (await conn
        .select({
          id: clientsTable.id,
          name: (clientsTable as any).name,
          icNumber: (clientsTable as any).icNumber ?? (clientsTable as any).icNo ?? (clientsTable as any).nric,
          phone: (clientsTable as any).phone ?? (clientsTable as any).mobile,
          email: (clientsTable as any).email,
          address: (clientsTable as any).address,
          tin: (clientsTable as any).tin,
        } as any)
        .from(clientsTable as any)
        .where(and(
          eq((clientsTable as any).firmId, firmId),
          eq((clientsTable as any).id, clientId),
        ))
        .limit(1))?.[0] as any;
      if (!cli) continue;
      const prefix = `purchasers[${idx}]`;
      if (cli.name) out[`${prefix}.name`] = { valueText: String(cli.name), valueJson: null };
      if (cli.icNumber) out[`${prefix}.icNumber`] = { valueText: String(cli.icNumber), valueJson: null };
      if (cli.phone) out[`${prefix}.phone`] = { valueText: String(cli.phone), valueJson: null };
      if (cli.email) out[`${prefix}.email`] = { valueText: String(cli.email), valueJson: null };
      if (cli.address) out[`${prefix}.address`] = { valueText: String(cli.address), valueJson: null };
      if (cli.tin) out[`${prefix}.tin`] = { valueText: String(cli.tin), valueJson: null };
    }
  } catch {
    // non-fatal
  }

  return out;
}

export async function compareLawcasproHimsEkyc(
  input: CompareLawcasproHimsEkycInput,
  opts: { tx?: unknown } = {},
): Promise<CompareLawcasproHimsEkycResult> {
  const conn = pickDbConn(opts.tx);

  const batchId = input.comparisonBatchId ?? `HIMS_EKYC_COMPARE:${input.caseId}:${Date.now()}`;
  const notifyOnMismatch = input.notifyOnMismatch !== false;

  const lawcasproFields = await loadLawcasproCaseFields(conn, input.firmId, input.caseId);

  const sourceFields: { [k: string]: { valueText: string | null; valueJson: unknown | null } } = {};
  if (input.himsRecord) {
    for (const f of input.himsRecord.fields ?? []) {
      sourceFields[`HIMS.${f.fieldKey}`] = { valueText: f.valueText ?? null, valueJson: f.valueJson ?? null };
    }
  }
  if (input.ekycRecord) {
    for (const f of input.ekycRecord.fields ?? []) {
      sourceFields[`EKYC.${f.fieldKey}`] = { valueText: f.valueText ?? null, valueJson: f.valueJson ?? null };
    }
  }

  const candidateFieldPairs: Array<{ fieldKey: string; src: { valueText: string | null; valueJson: unknown | null } | null; tgt: { valueText: string | null; valueJson: unknown | null } | null }> = [];
  const allKeys = new Set<string>();
  for (const k of Object.keys(sourceFields)) allKeys.add(k);
  for (const k of Object.keys(lawcasproFields)) allKeys.add(k);

  for (const key of allKeys) {
    const src = sourceFields[key] ?? null;
    const tgt = lawcasproFields[key] ?? null;
    candidateFieldPairs.push({ fieldKey: key, src, tgt });
  }

  for (const idx of [0, 1, 2, 3]) {
    const prefix = `purchasers[${idx}]`;
    const himsPurchaser = (input.himsRecord?.purchasers ?? [])[idx];
    if (himsPurchaser) {
      const hFields = [
        ["name", himsPurchaser.name],
        ["icNumber", himsPurchaser.icNumber],
        ["phone", himsPurchaser.phone],
        ["email", himsPurchaser.email],
        ["address", himsPurchaser.address],
      ] as const;
      for (const [suffix, v] of hFields) {
        if (!v) continue;
        const fieldKey = `HIMS.${prefix}.${suffix}`;
        allKeys.add(fieldKey);
        candidateFieldPairs.push({
          fieldKey,
          src: { valueText: String(v), valueJson: null },
          tgt: lawcasproFields[`${prefix}.${suffix}`] ?? null,
        });
      }
    }
  }

  const insertValues: any[] = [];
  const outRows: HimsDataComparisonRow[] = [];
  let matchedCount = 0;
  let mismatchedCount = 0;
  let missingInSourceCount = 0;
  let missingInTargetCount = 0;
  let errorCount = 0;
  let notificationsCreated = 0;
  const now = new Date();

  for (const pair of candidateFieldPairs) {
    const srcTxt = pair.src?.valueText ?? null;
    const tgtTxt = pair.tgt?.valueText ?? null;
    const normSrc = normalizeFieldValue(srcTxt);
    const normTgt = normalizeFieldValue(tgtTxt);

    let matchStatus: HimsMatchStatus;
    let mismatchReason: string | null = null;
    let matchScoreNum: number;

    if (!pair.src) {
      matchStatus = "missing_in_source";
      missingInSourceCount++;
      mismatchReason = "No value in HIMS/eKYC source record";
      matchScoreNum = 0;
    } else if (!pair.tgt) {
      matchStatus = "missing_in_target";
      missingInTargetCount++;
      mismatchReason = "No value in Lawcaspro case fields";
      matchScoreNum = 0;
    } else if (normSrc && normTgt && normSrc === normTgt) {
      matchStatus = "match";
      matchedCount++;
      matchScoreNum = 1;
    } else if (!normSrc && !normTgt) {
      matchStatus = "match";
      matchedCount++;
      matchScoreNum = 1;
    } else {
      const sim = computeSimilarity(normSrc, normTgt);
      if (sim >= 0.92) {
        matchStatus = "match";
        matchedCount++;
        matchScoreNum = sim;
      } else {
        matchStatus = "mismatch";
        mismatchedCount++;
        matchScoreNum = sim;
        mismatchReason = `Normalized values differ (similarity=${sim.toFixed(2)})`;
      }
    }

    const fieldKeyShort = pair.fieldKey;
    const notificationIdemKey =
      matchStatus === "mismatch" || matchStatus === "missing_in_source" || matchStatus === "missing_in_target"
        ? `HIMS_MISMATCH:${input.caseId}:${fieldKeyShort.replace(/[^a-zA-Z0-9_:.-]/g, "_")}`
        : null;

    let notificationCreated = false;
    if (notifyOnMismatch && notificationIdemKey && matchStatus !== "match") {
      try {
        const existingNotif = (await conn
          .select({ id: userNotificationsTable.id })
          .from(userNotificationsTable as any)
          .where(and(
            eq(userNotificationsTable.firmId, input.firmId),
            eq(userNotificationsTable.correlationId as any, notificationIdemKey),
          ))
          .limit(1))?.[0] as any;
        if (!existingNotif) {
          const severity = matchStatus === "mismatch" ? "warning" : "info";
          const titleParts = fieldKeyShort.split(".");
          const prettyField = titleParts[titleParts.length - 1] ?? fieldKeyShort;
          await conn
            .insert(userNotificationsTable as any)
            .values({
              firmId: input.firmId,
              userId: 0,
              sourceType: "HIMS_EKYC_COMPARE",
              sourceId: input.caseId,
              caseId: input.caseId,
              notificationType: "HIMS_DATA_MISMATCH",
              title: `HIMS/eKYC Data Discrepancy: ${prettyField}`,
              message: mismatchReason ?? `Case field ${fieldKeyShort} differs between systems. Source=${srcTxt ?? "null"} Target=${tgtTxt ?? "null"}`,
              meta: {
                comparisonBatchId: batchId,
                fieldKey: fieldKeyShort,
                matchStatus,
                sourceValue: srcTxt,
                targetValue: tgtTxt,
                normalizedSource: normSrc,
                normalizedTarget: normTgt,
                matchScore: matchScoreNum,
              } as any,
              isRead: false,
              status: "unread",
              dismissible: true,
              severity,
              correlationId: notificationIdemKey,
              resolutionMode: "MANUAL_ALLOWED",
              ruleCode: "HIMS_EKYC_COMPARE",
              entityType: "case",
              entityId: input.caseId,
              targetScope: "firm",
              deliveryCount: 1,
              lastNotifiedAt: now,
              createdAt: now,
              updatedAt: now,
            } as any)
            .onConflictDoNothing();
          notificationCreated = true;
          notificationsCreated++;
        } else {
          notificationCreated = true;
        }
      } catch {
        // notification best-effort
      }
    }

    insertValues.push({
      firmId: input.firmId,
      caseId: input.caseId,
      comparisonBatchId: batchId,
      fieldKey: fieldKeyShort,
      sourceSystem: fieldKeyShort.startsWith("EKYC.") ? "EKYC" : "HIMS",
      targetSystem: "LAWCASPRO",
      sourceValueText: srcTxt,
      targetValueText: tgtTxt,
      sourceValueJson: pair.src?.valueJson ?? null,
      targetValueJson: pair.tgt?.valueJson ?? null,
      matchStatus,
      matchScore: matchScoreNum.toFixed(4),
      mismatchReason,
      normalizedSourceValue: normSrc || null,
      normalizedTargetValue: normTgt || null,
      notificationIdempotencyKey: notificationIdemKey,
      notificationCreated,
      comparedByUserId: typeof input.actorUserId === "number" ? input.actorUserId : null,
      comparedAt: now,
      autoCorrectedInLawcaspro: false,
      correctionNote: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (insertValues.length) {
    try {
      const rows = await conn
        .insert(himsDataComparisonsTable as any)
        .values(insertValues as any[])
        .onConflictDoNothing()
        .returning({
          id: himsDataComparisonsTable.id,
          fieldKey: himsDataComparisonsTable.fieldKey,
          sourceValueText: himsDataComparisonsTable.sourceValueText,
          targetValueText: himsDataComparisonsTable.targetValueText,
          matchStatus: himsDataComparisonsTable.matchStatus,
          matchScore: himsDataComparisonsTable.matchScore,
          mismatchReason: himsDataComparisonsTable.mismatchReason,
          notificationIdempotencyKey: himsDataComparisonsTable.notificationIdempotencyKey,
          notificationCreated: himsDataComparisonsTable.notificationCreated,
        });

      for (const r of (rows ?? [])) {
        const row = r as any;
        outRows.push({
          id: Number(row.id),
          fieldKey: String(row.fieldKey ?? ""),
          sourceValueText: row.sourceValueText ?? null,
          targetValueText: row.targetValueText ?? null,
          matchStatus: (String(row.matchStatus ?? "error") as HimsMatchStatus),
          matchScore: row.matchScore != null ? String(row.matchScore) : null,
          mismatchReason: row.mismatchReason ?? null,
          notificationIdempotencyKey: row.notificationIdempotencyKey ?? null,
          notificationCreated: Boolean(row.notificationCreated),
        });
      }
    } catch (err: any) {
      const isUnique = /unique|uq_|23505|duplicate/i.test(String(err?.message ?? err?.code ?? ""));
      if (!isUnique) throw err;
      for (const v of insertValues) {
        outRows.push({
          id: 0,
          fieldKey: String(v.fieldKey ?? ""),
          sourceValueText: v.sourceValueText,
          targetValueText: v.targetValueText,
          matchStatus: v.matchStatus,
          matchScore: v.matchScore,
          mismatchReason: v.mismatchReason,
          notificationIdempotencyKey: v.notificationIdempotencyKey,
          notificationCreated: Boolean(v.notificationCreated),
        });
        if (v.matchStatus === "match") matchedCount = Math.max(0, matchedCount - 1);
        else if (v.matchStatus === "mismatch") mismatchedCount = Math.max(0, mismatchedCount - 1);
        else if (v.matchStatus === "missing_in_source") missingInSourceCount = Math.max(0, missingInSourceCount - 1);
        else if (v.matchStatus === "missing_in_target") missingInTargetCount = Math.max(0, missingInTargetCount - 1);
      }
    }
  }

  return {
    comparisonBatchId: batchId,
    caseId: input.caseId,
    firmId: input.firmId,
    comparedAt: now,
    totalFields: outRows.length,
    matchedCount,
    mismatchedCount,
    missingInSourceCount,
    missingInTargetCount,
    errorCount,
    notificationsCreated,
    comparisons: outRows,
  };
}
