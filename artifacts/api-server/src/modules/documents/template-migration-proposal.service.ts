import { and, eq, desc, isNull } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, boolean, index, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  templatesTable,
  documentTemplatesTable,
  documentTemplateVersionsTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

const templateMigrationProposalsTable = pgTable("template_migration_proposals", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  oldTemplateId: integer("old_template_id").notNull(),
  newTemplateId: integer("new_template_id").notNull(),
  oldTemplateVersionId: integer("old_template_version_id"),
  newTemplateVersionId: integer("new_template_version_id"),
  fieldKeyOld: text("field_key_old").notNull(),
  fieldKeyNew: text("field_key_new"),
  matchStatus: text("match_status").notNull().default("review_required"),
  matchScore: numeric("match_score", { precision: 5, scale: 4 }),
  matchingSignals: jsonb("matching_signals").$type<Record<string, unknown>>().notNull().default({}),
  sameBank: boolean("same_bank").notNull().default(false),
  sameDocumentType: boolean("same_document_type").notNull().default(false),
  nearbyLabels: boolean("nearby_labels").notNull().default(false),
  relativePositionMatch: boolean("relative_position_match").notNull().default(false),
  dimensionSimilarity: boolean("dimension_similarity").notNull().default(false),
  surroundingTextMatch: boolean("surrounding_text_match").notNull().default(false),
  reviewedByUserId: integer("reviewed_by_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewDecision: text("review_decision"),
  reviewNotes: text("review_notes"),
  publishedByUserId: integer("published_by_user_id"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_template_migration_proposals_firm").on(t.firmId),
  firmOldIdx: index("idx_template_migration_proposals_old").on(t.firmId, t.oldTemplateId),
  firmNewIdx: index("idx_template_migration_proposals_new").on(t.firmId, t.newTemplateId),
  firmStatusIdx: index("idx_template_migration_proposals_status").on(t.firmId, t.matchStatus, t.createdAt),
  uqFieldPair: uniqueIndex("uq_template_migration_proposals_field_pair").on(t.firmId, t.oldTemplateId, t.newTemplateId, t.fieldKeyOld),
  uqIdem: uniqueIndex("uq_template_migration_proposals_idem").on(t.firmId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
}));

export type TemplateMatchStatus = "auto_matched" | "review_required" | "unmatched";

export interface TemplateFieldBinding {
  fieldKey: string;
  label?: string | null;
  positionX?: number | null;
  positionY?: number | null;
  width?: number | null;
  height?: number | null;
  pageNo?: number | null;
  surroundingText?: string | null;
  bankName?: string | null;
  documentType?: string | null;
  dataType?: string | null;
  variableKey?: string | null;
}

export interface TemplateVersionSnapshot {
  templateId: number;
  templateVersionId?: number | null;
  templateName: string | null;
  documentType?: string | null;
  bankName?: string | null;
  fields: TemplateFieldBinding[];
  variablesSnapshot?: Record<string, unknown> | null;
  pdfMappingsSnapshot?: Record<string, unknown> | null;
}

export interface CompareTemplateVersionsInput {
  firmId: number;
  oldTemplateId: number;
  newTemplateId: number;
  oldTemplateVersionId?: number | null;
  newTemplateVersionId?: number | null;
  requestedByUserId?: number | null;
  idempotencyKey?: string | null;
}

export interface TemplateMigrationProposal {
  proposalId: number;
  fieldKeyOld: string;
  fieldKeyNew: string | null;
  matchStatus: TemplateMatchStatus;
  matchScore: string | null;
  matchingSignals: Record<string, unknown>;
  sameBank: boolean;
  sameDocumentType: boolean;
  nearbyLabels: boolean;
  relativePositionMatch: boolean;
  dimensionSimilarity: boolean;
  surroundingTextMatch: boolean;
}

export interface CompareTemplateVersionsResult {
  oldSnapshot: TemplateVersionSnapshot;
  newSnapshot: TemplateVersionSnapshot;
  proposals: TemplateMigrationProposal[];
  autoMatchedCount: number;
  reviewRequiredCount: number;
  unmatchedCount: number;
  proposalIds: number[];
}

function normalizeText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .toLowerCase()
    .replace(/[\s\-_./,;:()\[\]{}'"`~!@#$%^&*+=|\\<>?]/g, "")
    .trim();
}

function numericDistance(a: number | null | undefined, b: number | null | undefined): number {
  if (typeof a !== "number" || typeof b !== "number") return Infinity;
  return Math.abs(a - b);
}

function extractBankName(templateName: string | null, fields: TemplateFieldBinding[]): string {
  const fromName = templateName ?? "";
  const bankPatterns = ["maybank", "cimb", "publicbank", "rhb", "hlb", "hongleong", "ambank", "affin", "alliance", "bsn", "mbsb", "rhb", "uob", "ocbc", "hsbc", "standardchartered"];
  const nameNorm = normalizeText(fromName);
  for (const bank of bankPatterns) {
    if (nameNorm.includes(bank)) return bank;
  }
  for (const f of fields) {
    const fn = normalizeText(f.bankName ?? f.surroundingText ?? f.label);
    for (const bank of bankPatterns) {
      if (fn.includes(bank)) return bank;
    }
  }
  return "";
}

function extractDocumentType(templateName: string | null, fields: TemplateFieldBinding[]): string {
  const fromName = templateName ?? "";
  const docPatterns = ["spa", "loanagreement", "facilityletter", "letterofoffer", "lo", "fa", "doa", "poa", "memorandum", "deedofassignment", "charge", "memorandumofcharge"];
  const nameNorm = normalizeText(fromName);
  for (const doc of docPatterns) {
    if (nameNorm.includes(doc)) return doc;
  }
  for (const f of fields) {
    const fn = normalizeText(f.documentType ?? f.label ?? f.surroundingText);
    for (const doc of docPatterns) {
      if (fn.includes(doc)) return doc;
    }
  }
  return "";
}

function buildFieldFromPdfMapping(entry: any, idx: number): TemplateFieldBinding {
  const fieldKey = String(entry?.fieldKey ?? entry?.variableKey ?? entry?.name ?? `field_${idx}`);
  return {
    fieldKey,
    label: typeof entry?.label === "string" ? entry.label : null,
    positionX: typeof entry?.x === "number" ? entry.x : typeof entry?.left === "number" ? entry.left : null,
    positionY: typeof entry?.y === "number" ? entry.y : typeof entry?.top === "number" ? entry.top : null,
    width: typeof entry?.width === "number" ? entry.width : null,
    height: typeof entry?.height === "number" ? entry.height : null,
    pageNo: typeof entry?.page === "number" ? entry.page : typeof entry?.pageNo === "number" ? entry.pageNo : null,
    surroundingText: typeof entry?.contextText === "string" ? entry.contextText : typeof entry?.surroundingText === "string" ? entry.surroundingText : null,
    bankName: typeof entry?.bank === "string" ? entry.bank : null,
    documentType: typeof entry?.docType === "string" ? entry.docType : null,
    dataType: typeof entry?.dataType === "string" ? entry.dataType : null,
    variableKey: typeof entry?.variableKey === "string" ? entry.variableKey : null,
  };
}

async function loadTemplateSnapshot(
  conn: DbConnLike,
  firmId: number,
  templateId: number,
  versionId: number | null | undefined,
): Promise<TemplateVersionSnapshot> {
  const templateCols: any = {
    id: (documentTemplatesTable as any).id,
    name: (documentTemplatesTable as any).name,
    firmId: (documentTemplatesTable as any).firmId,
    documentType: (documentTemplatesTable as any).documentType,
    category: (documentTemplatesTable as any).category,
  };

  const tplRow = (await conn
    .select(templateCols)
    .from(documentTemplatesTable as any)
    .where(and(
      eq((documentTemplatesTable as any).firmId, firmId),
      eq((documentTemplatesTable as any).id, templateId),
    ))
    .limit(1))?.[0] as any;

  const tplName = tplRow?.name ?? null;
  const tplDocType = tplRow?.documentType ?? tplRow?.category ?? null;

  const versionCols: any = {
    id: (documentTemplateVersionsTable as any).id,
    variablesSnapshot: (documentTemplateVersionsTable as any).variablesSnapshot,
    pdfMappingsSnapshot: (documentTemplateVersionsTable as any).pdfMappingsSnapshot,
    versionNo: (documentTemplateVersionsTable as any).versionNo,
    status: (documentTemplateVersionsTable as any).status,
  };

  let versionRow: any = null;
  if (typeof versionId === "number") {
    versionRow = (await conn
      .select(versionCols)
      .from(documentTemplateVersionsTable as any)
      .where(and(
        eq((documentTemplateVersionsTable as any).firmId, firmId),
        eq((documentTemplateVersionsTable as any).templateId, templateId),
        eq((documentTemplateVersionsTable as any).id, versionId),
      ))
      .limit(1))?.[0] as any;
  }

  if (!versionRow) {
    versionRow = (await conn
      .select(versionCols)
      .from(documentTemplateVersionsTable as any)
      .where(and(
        eq((documentTemplateVersionsTable as any).firmId, firmId),
        eq((documentTemplateVersionsTable as any).templateId, templateId),
      ))
      .orderBy(desc((documentTemplateVersionsTable as any).versionNo), desc((documentTemplateVersionsTable as any).createdAt))
      .limit(1))?.[0] as any;
  }

  const pdfMappings = versionRow?.pdfMappingsSnapshot ?? {};
  const fieldsArr: any[] = Array.isArray(pdfMappings?.fields) ? pdfMappings.fields : Array.isArray(pdfMappings?.mappings) ? pdfMappings.mappings : [];
  const fields: TemplateFieldBinding[] = fieldsArr.map((entry, idx) => buildFieldFromPdfMapping(entry, idx));

  const bankName = extractBankName(tplName, fields);
  const docType = extractDocumentType(tplName ?? tplDocType, fields);

  return {
    templateId,
    templateVersionId: versionRow?.id ?? null,
    templateName: tplName,
    documentType: docType || (typeof tplDocType === "string" ? normalizeText(tplDocType) : ""),
    bankName,
    fields,
    variablesSnapshot: versionRow?.variablesSnapshot ?? null,
    pdfMappingsSnapshot: versionRow?.pdfMappingsSnapshot ?? null,
  };
}

function matchFieldPair(
  oldField: TemplateFieldBinding,
  newFields: TemplateFieldBinding[],
  oldSnap: TemplateVersionSnapshot,
  newSnap: TemplateVersionSnapshot,
): { bestMatch: TemplateFieldBinding | null; score: number; signals: Record<string, unknown> } {
  let bestMatch: TemplateFieldBinding | null = null;
  let bestScore = 0;
  let bestSignals: Record<string, unknown> = {};

  const oldKeyNorm = normalizeText(oldField.fieldKey);
  const oldLabelNorm = normalizeText(oldField.label);
  const oldVarKeyNorm = normalizeText(oldField.variableKey);
  const oldPage = oldField.pageNo;

  for (const newField of newFields) {
    const signals: any = {};
    let score = 0;

    const newKeyNorm = normalizeText(newField.fieldKey);
    const newLabelNorm = normalizeText(newField.label);
    const newVarKeyNorm = normalizeText(newField.variableKey);

    let keyMatch = false;
    if (oldKeyNorm && newKeyNorm && oldKeyNorm === newKeyNorm) { score += 40; keyMatch = true; }
    else if (oldKeyNorm && newKeyNorm && (oldKeyNorm.includes(newKeyNorm) || newKeyNorm.includes(oldKeyNorm))) { score += 20; keyMatch = true; }
    signals.keyMatch = keyMatch;

    let labelMatch = false;
    if (oldLabelNorm && newLabelNorm && oldLabelNorm === newLabelNorm) { score += 25; labelMatch = true; }
    else if (oldLabelNorm && newLabelNorm && (oldLabelNorm.includes(newLabelNorm) || newLabelNorm.includes(oldLabelNorm))) { score += 12; labelMatch = true; }
    else if (oldLabelNorm && newLabelNorm) {
      const overlap = [...oldLabelNorm].filter((ch) => newLabelNorm.includes(ch)).length;
      const sim = overlap / Math.max(1, oldLabelNorm.length, newLabelNorm.length);
      if (sim >= 0.7) { score += 8; labelMatch = sim >= 0.85; }
    }
    signals.labelMatch = labelMatch;

    let varKeyMatch = false;
    if (oldVarKeyNorm && newVarKeyNorm && oldVarKeyNorm === newVarKeyNorm) { score += 30; varKeyMatch = true; }
    else if (oldVarKeyNorm && newVarKeyNorm && (oldVarKeyNorm.includes(newVarKeyNorm) || newVarKeyNorm.includes(oldVarKeyNorm))) { score += 15; varKeyMatch = true; }
    signals.variableKeyMatch = varKeyMatch;

    const samePage = typeof oldPage === "number" && typeof newField.pageNo === "number" && oldPage === newField.pageNo;
    if (samePage) { score += 5; }
    signals.samePage = samePage;

    const dx = numericDistance(oldField.positionX, newField.positionX);
    const dy = numericDistance(oldField.positionY, newField.positionY);
    const positionClose = dx !== Infinity && dy !== Infinity && dx <= 40 && dy <= 40;
    const relativePositionMatch = samePage && positionClose;
    if (dx !== Infinity && dy !== Infinity) {
      const maxDeviation = Math.max(dx, dy);
      if (maxDeviation <= 10) score += 15;
      else if (maxDeviation <= 30) score += 10;
      else if (maxDeviation <= 60) score += 5;
    }
    signals.relativePositionMatch = relativePositionMatch;
    signals.positionDeltaPx = dx === Infinity ? null : { dx: Math.round(dx), dy: Math.round(dy) };

    const dw = numericDistance(oldField.width, newField.width);
    const dh = numericDistance(oldField.height, newField.height);
    const dimensionSimilarity = dw !== Infinity && dh !== Infinity && dw <= 20 && dh <= 10;
    if (dw !== Infinity && dh !== Infinity) {
      const dimDelta = Math.max(dw, dh);
      if (dimDelta <= 5) score += 10;
      else if (dimDelta <= 15) score += 5;
    }
    signals.dimensionSimilarity = dimensionSimilarity;

    const oldSurrounding = normalizeText(oldField.surroundingText);
    const newSurrounding = normalizeText(newField.surroundingText);
    let surroundingTextMatch = false;
    if (oldSurrounding && newSurrounding && oldSurrounding === newSurrounding) { score += 15; surroundingTextMatch = true; }
    else if (oldSurrounding && newSurrounding) {
      const overlap = [...oldSurrounding].filter((ch) => newSurrounding.includes(ch)).length;
      const sim = overlap / Math.max(1, oldSurrounding.length, newSurrounding.length);
      if (sim >= 0.8) { score += 8; surroundingTextMatch = sim >= 0.9; }
    }
    signals.surroundingTextMatch = surroundingTextMatch;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = newField;
      bestSignals = {
        ...signals,
        scoreBreakdown: {
          keyMatch: signals.keyMatch ? (oldKeyNorm === newKeyNorm ? 40 : 20) : 0,
          labelMatch: signals.labelMatch ? 25 : 0,
          variableKeyMatch: signals.variableKeyMatch ? (oldVarKeyNorm === newVarKeyNorm ? 30 : 15) : 0,
          position: signals.positionDeltaPx ? (Math.max(0, 15 - Math.max(signals.positionDeltaPx.dx, signals.positionDeltaPx.dy) / 4)) : 0,
          dimension: dimensionSimilarity ? 10 : 0,
          surroundingText: surroundingTextMatch ? 15 : 0,
          samePage: samePage ? 5 : 0,
        },
      };
    }
  }

  return { bestMatch, score: bestScore, signals: bestSignals };
}

export async function compareTemplateVersions(
  input: CompareTemplateVersionsInput,
  opts: { tx?: unknown } = {},
): Promise<CompareTemplateVersionsResult> {
  const conn = pickDbConn(opts.tx);

  if (input.oldTemplateId === input.newTemplateId) {
    throw new ApiError({ status: 400, code: "TEMPLATE_MIGRATION_SAME_ID", message: "Old and new template must be different", retryable: false });
  }

  const oldSnap = await loadTemplateSnapshot(conn, input.firmId, input.oldTemplateId, input.oldTemplateVersionId);
  const newSnap = await loadTemplateSnapshot(conn, input.firmId, input.newTemplateId, input.newTemplateVersionId);

  if (!oldSnap.templateName) {
    throw new ApiError({ status: 404, code: "OLD_TEMPLATE_NOT_FOUND", message: `Old template ${input.oldTemplateId} not found in firm scope`, retryable: false });
  }
  if (!newSnap.templateName) {
    throw new ApiError({ status: 404, code: "NEW_TEMPLATE_NOT_FOUND", message: `New template ${input.newTemplateId} not found in firm scope`, retryable: false });
  }

  const sameBank = oldSnap.bankName && newSnap.bankName ? oldSnap.bankName === newSnap.bankName : false;
  const sameDocumentType = oldSnap.documentType && newSnap.documentType ? oldSnap.documentType === newSnap.documentType : false;

  const proposals: TemplateMigrationProposal[] = [];
  const proposalIds: number[] = [];
  let autoMatchedCount = 0;
  let reviewRequiredCount = 0;
  let unmatchedCount = 0;

  const now = new Date();
  const insertValues: any[] = [];

  for (const oldField of oldSnap.fields) {
    const { bestMatch, score, signals } = matchFieldPair(oldField, newSnap.fields, oldSnap, newSnap);

    const nearbyLabels = Boolean(signals.labelMatch);
    const relativePositionMatch = Boolean(signals.relativePositionMatch);
    const dimensionSimilarity = Boolean(signals.dimensionSimilarity);
    const surroundingTextMatch = Boolean(signals.surroundingTextMatch);

    const globalBonus = (sameBank ? 1 : 0) * 5 + (sameDocumentType ? 1 : 0) * 10;
    const adjustedScore = Math.min(100, score + globalBonus);

    let matchStatus: TemplateMatchStatus;
    if (!bestMatch || adjustedScore < 35) {
      matchStatus = "unmatched";
      unmatchedCount++;
    } else if (adjustedScore >= 70 && (signals.keyMatch || signals.variableKeyMatch)) {
      matchStatus = "auto_matched";
      autoMatchedCount++;
    } else {
      matchStatus = "review_required";
      reviewRequiredCount++;
    }

    const scoreStr = (adjustedScore / 100).toFixed(4);
    const idemKey = input.idempotencyKey ? `${input.idempotencyKey}:${oldField.fieldKey}` : undefined;

    insertValues.push({
      firmId: input.firmId,
      oldTemplateId: input.oldTemplateId,
      newTemplateId: input.newTemplateId,
      oldTemplateVersionId: typeof oldSnap.templateVersionId === "number" ? oldSnap.templateVersionId : null,
      newTemplateVersionId: typeof newSnap.templateVersionId === "number" ? newSnap.templateVersionId : null,
      fieldKeyOld: oldField.fieldKey,
      fieldKeyNew: bestMatch?.fieldKey ?? null,
      matchStatus,
      matchScore: scoreStr,
      matchingSignals: {
        ...signals,
        globalSignals: { sameBank, sameDocumentType },
        oldFieldSnapshot: oldField,
        newFieldSnapshot: bestMatch,
      } as any,
      sameBank,
      sameDocumentType,
      nearbyLabels,
      relativePositionMatch,
      dimensionSimilarity,
      surroundingTextMatch,
      reviewedByUserId: null,
      reviewedAt: null,
      reviewDecision: null,
      reviewNotes: null,
      publishedByUserId: null,
      publishedAt: null,
      idempotencyKey: idemKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (insertValues.length) {
    try {
      const rows = await conn
        .insert(templateMigrationProposalsTable as any)
        .values(insertValues as any[])
        .onConflictDoNothing()
        .returning({
          id: templateMigrationProposalsTable.id,
          fieldKeyOld: templateMigrationProposalsTable.fieldKeyOld,
          fieldKeyNew: templateMigrationProposalsTable.fieldKeyNew,
          matchStatus: templateMigrationProposalsTable.matchStatus,
          matchScore: templateMigrationProposalsTable.matchScore,
          matchingSignals: templateMigrationProposalsTable.matchingSignals,
          sameBank: templateMigrationProposalsTable.sameBank,
          sameDocumentType: templateMigrationProposalsTable.sameDocumentType,
          nearbyLabels: templateMigrationProposalsTable.nearbyLabels,
          relativePositionMatch: templateMigrationProposalsTable.relativePositionMatch,
          dimensionSimilarity: templateMigrationProposalsTable.dimensionSimilarity,
          surroundingTextMatch: templateMigrationProposalsTable.surroundingTextMatch,
        });

      for (const r of (rows ?? [])) {
        const row = r as any;
        proposalIds.push(Number(row.id));
        proposals.push({
          proposalId: Number(row.id),
          fieldKeyOld: String(row.fieldKeyOld ?? ""),
          fieldKeyNew: row.fieldKeyNew ?? null,
          matchStatus: (String(row.matchStatus ?? "review_required") as TemplateMatchStatus),
          matchScore: row.matchScore != null ? String(row.matchScore) : null,
          matchingSignals: row.matchingSignals ?? {},
          sameBank: Boolean(row.sameBank),
          sameDocumentType: Boolean(row.sameDocumentType),
          nearbyLabels: Boolean(row.nearbyLabels),
          relativePositionMatch: Boolean(row.relativePositionMatch),
          dimensionSimilarity: Boolean(row.dimensionSimilarity),
          surroundingTextMatch: Boolean(row.surroundingTextMatch),
        });
      }
    } catch (err: any) {
      const isUnique = /unique|uq_duplicate/i.test(String(err?.message ?? err?.code ?? ""));
      if (!isUnique) throw err;
      for (const v of insertValues) {
        proposals.push({
          proposalId: 0,
          fieldKeyOld: String(v.fieldKeyOld ?? ""),
          fieldKeyNew: v.fieldKeyNew,
          matchStatus: v.matchStatus,
          matchScore: v.matchScore,
          matchingSignals: v.matchingSignals,
          sameBank: v.sameBank,
          sameDocumentType: v.sameDocumentType,
          nearbyLabels: v.nearbyLabels,
          relativePositionMatch: v.relativePositionMatch,
          dimensionSimilarity: v.dimensionSimilarity,
          surroundingTextMatch: v.surroundingTextMatch,
        });
      }
    }
  }

  return {
    oldSnapshot: oldSnap,
    newSnapshot: newSnap,
    proposals,
    autoMatchedCount,
    reviewRequiredCount,
    unmatchedCount,
    proposalIds,
  };
}
