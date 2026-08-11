import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  documentTemplateVersionsTable,
  documentGenerationRunsTable,
  caseDocumentsTable,
  documentTemplatesTable,
  type AppDb,
  type RlsDb,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

export interface DocumentActorVersionRecord {
  versionId: number;
  versionNo: number;
  templateId: number;
  templateName: string | null;
  status: string;
  sourceObjectPath: string | null;
  filename: string | null;
  category: string | null;
  documentGroup: string | null;
  variablesSnapshot: Record<string, unknown> | null;
  pdfMappingsSnapshot: Record<string, unknown> | null;
  applicabilityRulesSnapshot: Record<string, unknown> | null;
  readinessRulesSnapshot: Record<string, unknown> | null;
  createdBy: number | null;
  createdAt: Date | null;
  publishedBy: number | null;
  publishedAt: Date | null;
  archivedBy: number | null;
  archivedAt: Date | null;
}

export interface DocumentGenerationTrace {
  runId: number;
  templateSource: string;
  templateId: number | null;
  templateVersionId: number | null;
  caseDocumentId: number | null;
  documentName: string;
  renderMode: string;
  status: string;
  renderedVariablesSnapshot: Record<string, unknown> | null;
  checklistSnapshot: Record<string, unknown> | null;
  readinessSnapshot: Record<string, unknown> | null;
  triggeredBy: number | null;
  triggeredAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestConfig: Record<string, unknown> | null;
}

export interface CaseDocumentTraceBundle {
  caseDocument: {
    id: number;
    caseId: number | null;
    firmId: number;
    name: string;
    documentType: string;
    status: string;
    templateId: number | null;
    templateSource: string | null;
    generatedBy: number | null;
    generatedAt: Date | null;
    objectPath: string | null;
    fileName: string | null;
    clauseSnapshot: Record<string, unknown> | null;
    namingSnapshot: Record<string, unknown> | null;
    notes: string | null;
  } | null;
  generations: DocumentGenerationTrace[];
  templateVersions: DocumentActorVersionRecord[];
  linkedTemplateName: string | null;
}

const addColIfExists = <T extends Record<string, any>>(obj: T, tbl: any, key: string, alias?: string): T => {
  if (tbl[key] !== undefined) {
    (obj as any)[alias ?? key] = tbl[key];
  }
  return obj;
};

export async function getTemplateVersionHistory(
  firmId: number,
  templateId: number,
  opts: { tx?: unknown; limit?: number } = {},
): Promise<DocumentActorVersionRecord[]> {
  const conn = pickDbConn(opts.tx);
  const limit = typeof opts.limit === "number" ? Math.max(1, Math.min(opts.limit, 200)) : 50;

  const tvCols: any = {};
  addColIfExists(tvCols, documentTemplateVersionsTable, "id", "versionId");
  addColIfExists(tvCols, documentTemplateVersionsTable, "versionNo");
  addColIfExists(tvCols, documentTemplateVersionsTable, "templateId");
  addColIfExists(tvCols, documentTemplateVersionsTable, "status");
  addColIfExists(tvCols, documentTemplateVersionsTable, "sourceObjectPath");
  addColIfExists(tvCols, documentTemplateVersionsTable, "filename");
  addColIfExists(tvCols, documentTemplateVersionsTable, "templateKind");
  addColIfExists(tvCols, documentTemplateVersionsTable, "category");
  addColIfExists(tvCols, documentTemplateVersionsTable, "documentGroup");
  addColIfExists(tvCols, documentTemplateVersionsTable, "variablesSnapshot");
  addColIfExists(tvCols, documentTemplateVersionsTable, "pdfMappingsSnapshot");
  addColIfExists(tvCols, documentTemplateVersionsTable, "applicabilityRulesSnapshot");
  addColIfExists(tvCols, documentTemplateVersionsTable, "readinessRulesSnapshot");
  addColIfExists(tvCols, documentTemplateVersionsTable, "createdBy");
  addColIfExists(tvCols, documentTemplateVersionsTable, "createdAt");
  addColIfExists(tvCols, documentTemplateVersionsTable, "publishedBy");
  addColIfExists(tvCols, documentTemplateVersionsTable, "publishedAt");
  addColIfExists(tvCols, documentTemplateVersionsTable, "archivedBy");
  addColIfExists(tvCols, documentTemplateVersionsTable, "archivedAt");

  const rows = await conn
    .select({
      ...tvCols,
      templateName: documentTemplatesTable.name,
    })
    .from(documentTemplateVersionsTable)
    .leftJoin(documentTemplatesTable, eq(documentTemplateVersionsTable.templateId, documentTemplatesTable.id))
    .where(and(
      eq(documentTemplateVersionsTable.firmId, firmId),
      eq(documentTemplateVersionsTable.templateId, templateId),
    ))
    .orderBy(desc(documentTemplateVersionsTable.versionNo), desc(documentTemplateVersionsTable.createdAt))
    .limit(limit);

  return (rows ?? []).map((r: any) => ({
    versionId: Number(r.versionId ?? r.id ?? 0),
    versionNo: Number(r.versionNo ?? 0),
    templateId: Number(r.templateId ?? templateId),
    templateName: typeof r.templateName === "string" ? r.templateName : null,
    status: typeof r.status === "string" ? r.status : "draft",
    sourceObjectPath: typeof r.sourceObjectPath === "string" ? r.sourceObjectPath : null,
    filename: typeof r.filename === "string" ? r.filename : null,
    category: typeof r.category === "string" ? r.category : null,
    documentGroup: typeof r.documentGroup === "string" ? r.documentGroup : null,
    variablesSnapshot: r.variablesSnapshot ?? null,
    pdfMappingsSnapshot: r.pdfMappingsSnapshot ?? null,
    applicabilityRulesSnapshot: r.applicabilityRulesSnapshot ?? null,
    readinessRulesSnapshot: r.readinessRulesSnapshot ?? null,
    createdBy: typeof r.createdBy === "number" ? r.createdBy : null,
    createdAt: r.createdAt instanceof Date ? r.createdAt : null,
    publishedBy: typeof r.publishedBy === "number" ? r.publishedBy : null,
    publishedAt: r.publishedAt instanceof Date ? r.publishedAt : null,
    archivedBy: typeof r.archivedBy === "number" ? r.archivedBy : null,
    archivedAt: r.archivedAt instanceof Date ? r.archivedAt : null,
  }));
}

export async function getDocumentGenerationTraceForCaseDocument(
  firmId: number,
  caseDocumentId: number,
  opts: { tx?: unknown; limit?: number } = {},
): Promise<DocumentGenerationTrace[]> {
  const conn = pickDbConn(opts.tx);
  const limit = typeof opts.limit === "number" ? Math.max(1, Math.min(opts.limit, 100)) : 25;

  const grCols: any = {};
  addColIfExists(grCols, documentGenerationRunsTable, "id", "runId");
  addColIfExists(grCols, documentGenerationRunsTable, "templateSource");
  addColIfExists(grCols, documentGenerationRunsTable, "templateId");
  addColIfExists(grCols, documentGenerationRunsTable, "templateVersionId");
  addColIfExists(grCols, documentGenerationRunsTable, "caseDocumentId");
  addColIfExists(grCols, documentGenerationRunsTable, "documentName");
  addColIfExists(grCols, documentGenerationRunsTable, "renderMode");
  addColIfExists(grCols, documentGenerationRunsTable, "status");
  addColIfExists(grCols, documentGenerationRunsTable, "renderedVariablesSnapshot");
  addColIfExists(grCols, documentGenerationRunsTable, "checklistSnapshot");
  addColIfExists(grCols, documentGenerationRunsTable, "readinessSnapshot");
  addColIfExists(grCols, documentGenerationRunsTable, "triggeredBy");
  addColIfExists(grCols, documentGenerationRunsTable, "triggeredAt");
  addColIfExists(grCols, documentGenerationRunsTable, "startedAt");
  addColIfExists(grCols, documentGenerationRunsTable, "finishedAt");
  addColIfExists(grCols, documentGenerationRunsTable, "errorCode");
  addColIfExists(grCols, documentGenerationRunsTable, "errorMessage");
  addColIfExists(grCols, documentGenerationRunsTable, "requestConfig");

  const rows = await conn
    .select(grCols)
    .from(documentGenerationRunsTable)
    .where(and(
      eq(documentGenerationRunsTable.firmId, firmId),
      eq(documentGenerationRunsTable.caseDocumentId, caseDocumentId),
    ))
    .orderBy(desc(documentGenerationRunsTable.triggeredAt), desc(documentGenerationRunsTable.id))
    .limit(limit);

  return (rows ?? []).map((r: any) => ({
    runId: Number(r.runId ?? r.id ?? 0),
    templateSource: typeof r.templateSource === "string" ? r.templateSource : "firm",
    templateId: typeof r.templateId === "number" ? r.templateId : null,
    templateVersionId: typeof r.templateVersionId === "number" ? r.templateVersionId : null,
    caseDocumentId: typeof r.caseDocumentId === "number" ? r.caseDocumentId : null,
    documentName: typeof r.documentName === "string" ? r.documentName : "",
    renderMode: typeof r.renderMode === "string" ? r.renderMode : "docx",
    status: typeof r.status === "string" ? r.status : "pending",
    renderedVariablesSnapshot: r.renderedVariablesSnapshot ?? null,
    checklistSnapshot: r.checklistSnapshot ?? null,
    readinessSnapshot: r.readinessSnapshot ?? null,
    triggeredBy: typeof r.triggeredBy === "number" ? r.triggeredBy : null,
    triggeredAt: r.triggeredAt instanceof Date ? r.triggeredAt : null,
    startedAt: r.startedAt instanceof Date ? r.startedAt : null,
    finishedAt: r.finishedAt instanceof Date ? r.finishedAt : null,
    errorCode: typeof r.errorCode === "string" ? r.errorCode : null,
    errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : null,
    requestConfig: r.requestConfig ?? null,
  }));
}

export async function getCaseDocumentTraceBundle(
  firmId: number,
  caseDocumentId: number,
  opts: { tx?: unknown } = {},
): Promise<CaseDocumentTraceBundle> {
  const conn = pickDbConn(opts.tx);

  const cdCols: any = {};
  addColIfExists(cdCols, caseDocumentsTable, "id");
  addColIfExists(cdCols, caseDocumentsTable, "caseId");
  addColIfExists(cdCols, caseDocumentsTable, "firmId");
  addColIfExists(cdCols, caseDocumentsTable, "name");
  addColIfExists(cdCols, caseDocumentsTable, "documentType");
  addColIfExists(cdCols, caseDocumentsTable, "status");
  addColIfExists(cdCols, caseDocumentsTable, "templateId");
  addColIfExists(cdCols, caseDocumentsTable, "templateSource");
  addColIfExists(cdCols, caseDocumentsTable, "generatedBy");
  addColIfExists(cdCols, caseDocumentsTable, "generatedAt");
  addColIfExists(cdCols, caseDocumentsTable, "objectPath");
  addColIfExists(cdCols, caseDocumentsTable, "fileName");
  addColIfExists(cdCols, caseDocumentsTable, "clauseSnapshot");
  addColIfExists(cdCols, caseDocumentsTable, "namingSnapshot");
  addColIfExists(cdCols, caseDocumentsTable, "notes");

  const docRow = await conn
    .select({
      ...cdCols,
      linkedTemplateName: documentTemplatesTable.name,
    })
    .from(caseDocumentsTable)
    .leftJoin(documentTemplatesTable, eq(caseDocumentsTable.templateId as any, documentTemplatesTable.id))
    .where(and(
      eq(caseDocumentsTable.firmId, firmId),
      eq(caseDocumentsTable.id, caseDocumentId),
    ))
    .limit(1)
    .then((rs: any[]) => (rs?.length ? rs[0] : null));

  if (!docRow) {
    throw new ApiError({ status: 404, code: "CASE_DOCUMENT_NOT_FOUND", message: "Case document not found in firm scope", retryable: false });
  }

  const caseDocEntry: CaseDocumentTraceBundle["caseDocument"] = {
    id: Number(docRow.id ?? caseDocumentId),
    caseId: typeof docRow.caseId === "number" ? docRow.caseId : null,
    firmId: Number(docRow.firmId ?? firmId),
    name: typeof docRow.name === "string" ? docRow.name : "",
    documentType: typeof docRow.documentType === "string" ? docRow.documentType : "generated",
    status: typeof docRow.status === "string" ? docRow.status : "draft",
    templateId: typeof docRow.templateId === "number" ? docRow.templateId : null,
    templateSource: typeof docRow.templateSource === "string" ? docRow.templateSource : null,
    generatedBy: typeof docRow.generatedBy === "number" ? docRow.generatedBy : null,
    generatedAt: docRow.generatedAt instanceof Date ? docRow.generatedAt : null,
    objectPath: typeof docRow.objectPath === "string" ? docRow.objectPath : null,
    fileName: typeof docRow.fileName === "string" ? docRow.fileName : null,
    clauseSnapshot: docRow.clauseSnapshot ?? null,
    namingSnapshot: docRow.namingSnapshot ?? null,
    notes: typeof docRow.notes === "string" ? docRow.notes : null,
  };

  const generations = await getDocumentGenerationTraceForCaseDocument(firmId, caseDocumentId, { tx: conn });
  const templateVersions: DocumentActorVersionRecord[] = caseDocEntry.templateId
    ? await getTemplateVersionHistory(firmId, caseDocEntry.templateId, { tx: conn })
    : [];

  return {
    caseDocument: caseDocEntry,
    generations,
    templateVersions,
    linkedTemplateName: typeof docRow.linkedTemplateName === "string" ? docRow.linkedTemplateName : null,
  };
}

export async function getRecentGenerationRunsByActor(
  firmId: number,
  actorUserId: number,
  opts: { tx?: unknown; limit?: number; from?: Date } = {},
): Promise<DocumentGenerationTrace[]> {
  const conn = pickDbConn(opts.tx);
  const limit = typeof opts.limit === "number" ? Math.max(1, Math.min(opts.limit, 200)) : 50;

  const grCols: any = {};
  addColIfExists(grCols, documentGenerationRunsTable, "id", "runId");
  addColIfExists(grCols, documentGenerationRunsTable, "templateSource");
  addColIfExists(grCols, documentGenerationRunsTable, "templateId");
  addColIfExists(grCols, documentGenerationRunsTable, "templateVersionId");
  addColIfExists(grCols, documentGenerationRunsTable, "caseDocumentId");
  addColIfExists(grCols, documentGenerationRunsTable, "caseId");
  addColIfExists(grCols, documentGenerationRunsTable, "documentName");
  addColIfExists(grCols, documentGenerationRunsTable, "renderMode");
  addColIfExists(grCols, documentGenerationRunsTable, "status");
  addColIfExists(grCols, documentGenerationRunsTable, "renderedVariablesSnapshot");
  addColIfExists(grCols, documentGenerationRunsTable, "checklistSnapshot");
  addColIfExists(grCols, documentGenerationRunsTable, "readinessSnapshot");
  addColIfExists(grCols, documentGenerationRunsTable, "triggeredBy");
  addColIfExists(grCols, documentGenerationRunsTable, "triggeredAt");
  addColIfExists(grCols, documentGenerationRunsTable, "startedAt");
  addColIfExists(grCols, documentGenerationRunsTable, "finishedAt");
  addColIfExists(grCols, documentGenerationRunsTable, "errorCode");
  addColIfExists(grCols, documentGenerationRunsTable, "errorMessage");
  addColIfExists(grCols, documentGenerationRunsTable, "requestConfig");

  const where = [
    eq(documentGenerationRunsTable.firmId, firmId),
    eq(documentGenerationRunsTable.triggeredBy as any, actorUserId),
  ];
  if (opts.from instanceof Date) {
    where.push(sql`${documentGenerationRunsTable.triggeredAt} >= ${opts.from}` as any);
  }

  const rows = await conn
    .select(grCols)
    .from(documentGenerationRunsTable)
    .where(and(...(where as any)))
    .orderBy(desc(documentGenerationRunsTable.triggeredAt), desc(documentGenerationRunsTable.id))
    .limit(limit);

  return (rows ?? []).map((r: any) => ({
    runId: Number(r.runId ?? r.id ?? 0),
    templateSource: typeof r.templateSource === "string" ? r.templateSource : "firm",
    templateId: typeof r.templateId === "number" ? r.templateId : null,
    templateVersionId: typeof r.templateVersionId === "number" ? r.templateVersionId : null,
    caseDocumentId: typeof r.caseDocumentId === "number" ? r.caseDocumentId : null,
    documentName: typeof r.documentName === "string" ? r.documentName : "",
    renderMode: typeof r.renderMode === "string" ? r.renderMode : "docx",
    status: typeof r.status === "string" ? r.status : "pending",
    renderedVariablesSnapshot: r.renderedVariablesSnapshot ?? null,
    checklistSnapshot: r.checklistSnapshot ?? null,
    readinessSnapshot: r.readinessSnapshot ?? null,
    triggeredBy: typeof r.triggeredBy === "number" ? r.triggeredBy : null,
    triggeredAt: r.triggeredAt instanceof Date ? r.triggeredAt : null,
    startedAt: r.startedAt instanceof Date ? r.startedAt : null,
    finishedAt: r.finishedAt instanceof Date ? r.finishedAt : null,
    errorCode: typeof r.errorCode === "string" ? r.errorCode : null,
    errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : null,
    requestConfig: r.requestConfig ?? null,
  }));
}
