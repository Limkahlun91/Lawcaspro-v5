import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, documentTemplatesTable, caseDocumentsTable } from "@workspace/db";
import { PRINT_ACTIONS, isLetterheadApplicableDocumentType, isMasterDocumentLetterLike } from "@workspace/documents-registry";
import { requireAuth, requireFirmUser, requireFounder, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";
import { logger } from "../lib/logger";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import { getSupabaseStorageConfigError, ObjectNotFoundError, ObjectStorageService, SupabaseStorageService } from "../lib/objectStorage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import * as yazl from "yazl";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { z } from "zod";
import { normalizePurchaseMode, normalizeTitleType } from "../lib/documentApplicability";
import { evaluateTemplateApplicabilityV2 } from "../lib/templateApplicabilityEngine";
import { evaluateTemplateChecklist, normalizeChecklistMode } from "../lib/templateChecklistEngine";
import { evaluateTemplateReadiness, type TemplateReadinessInputs } from "../lib/documentReadiness";
import { resolveSmartFilename } from "../lib/smartFileNaming";
import { ensureUniqueCaseDocumentFileName, resolveDocumentFileName } from "../lib/documentFileName";
import { normalizeWorkflowDocumentKeyFromDb, workflowDocumentLabel } from "../lib/caseWorkflowDocuments";
import { LOAN_STAMPING_ITEM_KEYS, isLoanStampingItemKeyAllowedForTitleType, normalizeTitleType as normalizeLoanTitleType, type LoanStampingItemKey } from "../lib/loanStamping";
import { listDocumentVariables, resolveVariablesForTemplate, type PlaceholderWarning } from "../lib/documentVariables";
import { getFirmTemplateBindings, getPlatformDocumentBindings, replaceFirmTemplateBindings, replacePlatformDocumentBindings } from "../lib/documentBindings";
import { getFirmTemplateApplicabilityRules, getPlatformDocumentApplicabilityRules, upsertFirmTemplateApplicabilityRules, upsertPlatformDocumentApplicabilityRules } from "../lib/documentApplicabilityRules";
import { runDocumentPreview } from "../lib/documentPreview";
import { findUnknownVariablesInClause, getFirmClauseById, getPlatformClauseById, isClauseApplicable, normalizeClauseCode } from "../lib/clauseLibrary";
import { applyClauseInsertionToDocx, buildClauseInsertion, decideClauseInsertion, normalizeClauseInsertionMode, type SelectedClauseRef } from "../lib/documentClauses";
import { detectClausePlaceholders } from "../lib/docxPlaceholder";
import { classifyDocumentForExtraction, extractDocumentText, guessDocumentTypeFromText, mapExtractedTextToSuggestions } from "../lib/documentExtraction";
import { applyExtractionSuggestion } from "../lib/extractionWriteback";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const supabaseStorage = new SupabaseStorageService();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const truthy = (v: string | string[] | undefined): boolean => {
  const s = one(v);
  if (!s) return false;
  return s === "1" || s.toLowerCase() === "true" || s.toLowerCase() === "yes";
};

async function nextCaseDocumentSequence(r: DbConn, firmId: number, caseId: number): Promise<number> {
  const rows = await queryRows(r, sql`
    SELECT COUNT(*)::int AS c
    FROM case_documents
    WHERE firm_id = ${firmId} AND case_id = ${caseId}
  `);
  const cRaw = rows[0]?.c;
  const c = typeof cRaw === "number" ? cRaw : (typeof cRaw === "string" ? Number(cRaw) : 0);
  const n = Number.isFinite(c) ? c : 0;
  return Math.max(1, Math.floor(n) + 1);
}

function buildNamingContext(params: {
  caseId: number;
  firmId: number;
  context: Record<string, unknown>;
  documentName: string;
  templateName?: string;
  sequence: number;
}): Parameters<typeof resolveDocumentFileName>[0]["ctx"] {
  const c = params.context as any;
  const purchaserNames = [c.spa_purchaser1_name, c.spa_purchaser2_name].filter((x: unknown): x is string => typeof x === "string" && Boolean(String(x).trim())).join(", ");
  const borrowerNames = [c.borrower1_name, c.borrower2_name].filter((x: unknown): x is string => typeof x === "string" && Boolean(String(x).trim())).join(", ");
  const primaryClient = typeof c.spa_purchaser1_name === "string" && c.spa_purchaser1_name.trim()
    ? String(c.spa_purchaser1_name)
    : typeof c.borrower1_name === "string"
      ? String(c.borrower1_name)
      : "";

  return {
    caseId: params.caseId,
    firmId: params.firmId,
    caseReferenceNo: String(c.reference_no ?? ""),
    parcelNo: String(c.parcel_no ?? ""),
    unitNo: String(c.property_building_no ?? c.property_floor_no ?? ""),
    clientName: primaryClient,
    primaryClientName: primaryClient,
    purchaserNames,
    borrowerNames,
    projectName: String(c.project_name ?? ""),
    propertyDescriptionShort: String(c.property_type ?? ""),
    developerName: String(c.developer_name ?? ""),
    documentName: params.documentName,
    templateName: params.templateName ?? "",
    bankName: String(c.end_financier ?? c.loan_end_financier ?? ""),
    status: String(c.case_status ?? c.status ?? ""),
    titleType: String(c.title_type ?? ""),
    loanBank: String(c.end_financier ?? c.loan_end_financier ?? ""),
    sequence: params.sequence,
  };
}

function buildApplicabilityContext(caseContext: Record<string, unknown>): Record<string, unknown> {
  const c = caseContext as any;
  return {
    purchase_mode: c.purchase_mode ?? null,
    case_status: c.case_status ?? null,
    lawyer_in_charge: c.case_handler_name ?? null,
    clerk_in_charge: c.case_assistant_name ?? null,
    project_type: c.project_type ?? null,
    title_type: c.title_type ?? null,
    title_sub_type: c.title_sub_type ?? null,
    development_condition: c.project_development_condition ?? null,
    unit_category: c.unit_category ?? null,
    developer_id: c.developer_id ?? null,
    developer_name: c.developer_name ?? null,
    bank_name: c.end_financier ?? c.loan_end_financier ?? null,
    has_loan: String(c.purchase_mode ?? "").toLowerCase() === "loan",
    purchaser_count: [1, 2].filter((i) => Boolean(c[`spa_purchaser${i}_name`])).length,
    borrower_count: [1, 2].filter((i) => Boolean(c[`borrower${i}_name`])).length,
    has_company_party: Boolean(c.spa_purchaser1_is_company || c.spa_purchaser2_is_company || c.borrower1_is_company || c.borrower2_is_company),
  };
}

function buildChecklistMilestones(params: {
  workflowDocs?: Record<string, { hasFile: boolean }>;
  context: Record<string, unknown>;
}): Record<string, { completed: boolean }> {
  const out: Record<string, { completed: boolean }> = {};
  const workflow = params.workflowDocs ?? {};
  for (const [k, v] of Object.entries(workflow)) out[k] = { completed: Boolean(v?.hasFile) };
  for (const [k, v] of Object.entries(params.context)) {
    if (k.endsWith("_ymd")) {
      const mk = k.replace(/_ymd$/, "");
      out[mk] = { completed: Boolean(v) };
    }
  }
  return out;
}

const getRlsDb = (req: AuthRequest, res: any): NonNullable<AuthRequest["rlsDb"]> | null => {
  const r = req.rlsDb;
  if (!r) {
    (req as any).log?.error?.({ route: req.originalUrl, userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
    res.status(500).json({ error: "Internal Server Error" });
    return null;
  }
  return r;
};

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function tableExists(r: DbConn, fullName: string): Promise<boolean> {
  const rows = await queryRows(r, sql`SELECT to_regclass(${fullName}) AS reg`);
  return Boolean(rows[0]?.reg);
}

function safeJson(str: unknown): Record<string, unknown> {
  if (!str || typeof str !== "string") return {};
  try { return JSON.parse(str); } catch { return {}; }
}

function safeFilenameAscii(filename: string): string {
  const base = filename.replace(/[\r\n"]/g, "").trim();
  if (!base) return "download";
  return base.replace(/[^\x20-\x7E]/g, "_");
}

function encodeRFC5987ValueChars(str: string): string {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A")
    .replace(/%(7C|60|5E)/g, (m) => m.toLowerCase());
}

function contentDispositionAttachment(filename: string): string {
  const ascii = safeFilenameAscii(filename);
  const encoded = encodeRFC5987ValueChars(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function isDocxTemplateRenderError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  if (rec.name === "TemplateError") return true;
  const msg = typeof rec.message === "string" ? rec.message.toLowerCase() : "";
  return msg.includes("docxtemplater") || msg.includes("template");
}

function newGeneratedDocObjectPath(firmId: number, caseId: number, extension: string): string {
  const ext = extension.replace(/^\./, "").toLowerCase() || "docx";
  return `/objects/cases/${firmId}/case-${caseId}/generated/${randomUUID()}.${ext}`;
}

function isLoanStampingItemKey(v: string): v is LoanStampingItemKey {
  return (LOAN_STAMPING_ITEM_KEYS as readonly string[]).includes(v);
}

async function streamSupabasePrivateObjectToResponse({
  objectPath,
  res,
  fileName,
  fallbackContentType,
}: {
  objectPath: string;
  res: any;
  fileName: string;
  fallbackContentType: string;
}): Promise<void> {
  const storageResp = await supabaseStorage.fetchPrivateObjectResponse(objectPath);
  const ct = storageResp.headers.get("content-type") || fallbackContentType;
  const cl = storageResp.headers.get("content-length");
  if (ct) res.setHeader("Content-Type", ct);
  if (cl) res.setHeader("Content-Length", cl);
  res.setHeader("Content-Disposition", contentDispositionAttachment(fileName));
  if (!storageResp.body) throw new Error("Failed to stream file");
  const nodeStream = Readable.fromWeb(storageResp.body as any);
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("error", reject);
    res.on("finish", resolve);
    nodeStream.pipe(res);
  });
}

async function readSupabasePrivateObjectBytes(objectPath: string): Promise<Buffer> {
  const storageResp = await supabaseStorage.fetchPrivateObjectResponse(objectPath);
  if (!storageResp.body) throw new Error("Failed to read file");
  const nodeStream = Readable.fromWeb(storageResp.body as any);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    nodeStream.on("error", reject);
    nodeStream.on("end", resolve);
  });
  return Buffer.concat(chunks);
}

function wrapText(text: string, font: any, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  if (lines.length === 0) lines.push("");
  return lines;
}

function fmtRM(val: unknown): string {
  if (!val) return "";
  const n = Number(val);
  if (isNaN(n)) return String(val);
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;
}

const FIRM_DOCUMENT_ALLOWED_EXTENSIONS = new Set([
  "docx",
  "doc",
  "pdf",
  "xlsx",
  "xls",
  "csv",
  "txt",
  "jpg",
  "jpeg",
  "png",
]);

function fileExtensionFromName(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  if (i < 0) return "";
  return fileName.slice(i + 1).trim().toLowerCase();
}

function formatDateValue(raw: unknown): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function fmtDateDDMMYYYY(raw: unknown): string {
  const d = formatDateValue(raw);
  if (!d) return "";
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtDateLong(raw: unknown): string {
  const d = formatDateValue(raw);
  if (!d) return "";
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "long", year: "numeric" });
}

function fmtDateIso(raw: unknown): string {
  const d = formatDateValue(raw);
  if (!d) return "";
  return d.toISOString();
}

function fmtDateYMD(raw: unknown): string {
  const d = formatDateValue(raw);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

const DOCX_HEADER_XML_PREFIX =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
  `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ` +
  `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="wps">`;

const DOCX_FOOTER_XML_PREFIX =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
  `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ` +
  `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="wps">`;

function zipReadText(zip: PizZip, path: string): string {
  const f = zip.file(path);
  return f ? f.asText() : "";
}

function zipReadBytes(zip: PizZip, path: string): Buffer | null {
  const f = zip.file(path);
  if (!f) return null;
  const u8 = f.asUint8Array();
  return Buffer.from(u8);
}

function detectDocxVariables(fileBytes: Buffer): string[] {
  const zip = new PizZip(fileBytes);
  const paths = Object.keys(zip.files).filter((p) =>
    p === "word/document.xml" || (/^word\/(header|footer)\d*\.xml$/).test(p)
  );
  const keys = new Set<string>();
  const re = /\{\{\s*([^{}\s]+)\s*\}\}/g;
  for (const p of paths) {
    const xml = zipReadText(zip, p);
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const k = (m[1] ?? "").trim();
      if (k) keys.add(k);
    }
  }
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function placeholdersFromVariablesSnapshot(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const rec = snapshot as Record<string, unknown>;
  const keys = rec.keys;
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => String(k)).filter(Boolean);
}

function extractPdfMappingPlaceholders(mappings: unknown): string[] {
  if (!mappings || typeof mappings !== "object") return [];
  const rec = mappings as Record<string, unknown>;
  const pages = rec.pages;
  if (!Array.isArray(pages)) return [];
  const keys = new Set<string>();
  const re = /\{\{\s*([^{}\s]+)\s*\}\}/g;
  for (const p of pages) {
    const pr = p && typeof p === "object" ? (p as Record<string, unknown>) : null;
    const tbs = pr?.textBoxes;
    if (!Array.isArray(tbs)) continue;
    for (const tb of tbs) {
      const tr = tb && typeof tb === "object" ? (tb as Record<string, unknown>) : null;
      const content = typeof tr?.content === "string" ? tr.content : "";
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        const k = (m[1] ?? "").trim();
        if (k) keys.add(k);
      }
    }
  }
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function extractDocxBodyInnerXml(documentXml: string): string {
  const m = documentXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  if (!m) return "";
  const inner = m[1] ?? "";
  return inner.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, "");
}

function collectRelationshipIdsFromXml(xml: string): Set<string> {
  const ids = new Set<string>();
  const re = /\sr:(?:embed|id)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

type RelationshipEntry = { id: string; xml: string; target: string; targetMode?: string };

function pickRelationships(relsXml: string, ids: Set<string>): RelationshipEntry[] {
  const entries: RelationshipEntry[] = [];
  const re = /<Relationship\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml))) {
    const xml = m[0];
    const idMatch = xml.match(/\sId="([^"]+)"/);
    const targetMatch = xml.match(/\sTarget="([^"]+)"/);
    if (!idMatch || !targetMatch) continue;
    const id = idMatch[1];
    if (!ids.has(id)) continue;
    const target = targetMatch[1];
    const targetModeMatch = xml.match(/\sTargetMode="([^"]+)"/);
    entries.push({ id, xml, target, targetMode: targetModeMatch?.[1] });
  }
  return entries;
}

function buildRelsXml(entries: RelationshipEntry[]): string {
  const prefix =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  const body = entries.map((e) => e.xml).join("");
  return `${prefix}${body}</Relationships>`;
}

function normalizeTargetToZipPath(target: string): string | null {
  if (!target) return null;
  if (target.startsWith("http://") || target.startsWith("https://")) return null;
  if (target.startsWith("/")) return target.slice(1);
  if (target.startsWith("../")) return `word/${target.replace(/^\.\.\//, "")}`;
  return `word/${target}`;
}

function ensureContentTypeOverride(ctXml: string, partName: string, contentType: string): string {
  if (ctXml.includes(`PartName="${partName}"`)) return ctXml;
  const override = `<Override PartName="${partName}" ContentType="${contentType}"/>`;
  return ctXml.replace(/<\/Types>\s*$/, `${override}</Types>`);
}

function nextRelationshipId(relsXml: string): string {
  const re = /\sId="rId(\d+)"/g;
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml))) {
    const n = Number(m[1]);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `rId${max + 1}`;
}

function addDocumentRelationship(relsXml: string, id: string, type: string, target: string): string {
  if (relsXml.includes(`Id="${id}"`)) return relsXml;
  const entry = `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  return relsXml.replace(/<\/Relationships>\s*$/, `${entry}</Relationships>`);
}

function replaceOrInsertSectPr(documentXml: string, replace: (sectPrXml: string) => string): string {
  const all = [...documentXml.matchAll(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)];
  if (all.length === 0) return documentXml;
  const last = all[all.length - 1]!;
  const sect = last[0];
  const updated = replace(sect);
  return documentXml.slice(0, last.index!) + updated + documentXml.slice(last.index! + sect.length);
}

function stripSectPrRefs(sectPrXml: string): string {
  return sectPrXml
    .replace(/<w:headerReference\b[^>]*\/>/g, "")
    .replace(/<w:footerReference\b[^>]*\/>/g, "")
    .replace(/<w:titlePg\b[^>]*\/>/g, "");
}

async function downloadPrivateObjectBytes(objectPath: string): Promise<Buffer> {
  const response = await supabaseStorage.fetchPrivateObjectResponse(objectPath);
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

async function buildZipBufferFromPrivateObjects(entries: Array<{ zipPath: string; objectPath: string }>): Promise<Buffer> {
  const zipfile = new yazl.ZipFile();
  const nameCounts = new Map<string, number>();
  for (const e of entries) {
    const base = e.zipPath.replace(/^\/*/, "");
    const n = (nameCounts.get(base) ?? 0) + 1;
    nameCounts.set(base, n);
    const zipPath = n === 1 ? base : base.replace(/(\.[^./\\]+)?$/, (_m, ext) => ` (${n})${ext ?? ""}`);
    const bytes = await downloadPrivateObjectBytes(e.objectPath);
    zipfile.addBuffer(bytes, zipPath);
  }
  zipfile.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    zipfile.outputStream.on("error", reject);
    zipfile.outputStream.on("end", resolve);
  });
  return Buffer.concat(chunks);
}

async function applyLetterheadToDocxBuffer({
  baseDocx,
  firstPageTemplateDocx,
  continuationHeaderTemplateDocx,
  footerTemplateDocx,
  footerMode,
}: {
  baseDocx: Buffer;
  firstPageTemplateDocx: Buffer;
  continuationHeaderTemplateDocx: Buffer;
  footerTemplateDocx: Buffer | null;
  footerMode: "every_page" | "last_page_only";
}): Promise<Buffer> {
  const baseZip = new PizZip(baseDocx);
  const baseDocXml = zipReadText(baseZip, "word/document.xml");
  const baseDocRelsPath = "word/_rels/document.xml.rels";
  let baseDocRels = zipReadText(baseZip, baseDocRelsPath);
  let ctXml = zipReadText(baseZip, "[Content_Types].xml");

  const firstZip = new PizZip(firstPageTemplateDocx);
  const contZip = new PizZip(continuationHeaderTemplateDocx);
  const footerZip = footerTemplateDocx ? new PizZip(footerTemplateDocx) : null;

  const firstBody = extractDocxBodyInnerXml(zipReadText(firstZip, "word/document.xml"));
  const contBody = extractDocxBodyInnerXml(zipReadText(contZip, "word/document.xml"));
  const footerBody = footerZip ? extractDocxBodyInnerXml(zipReadText(footerZip, "word/document.xml")) : "";

  const firstRelIds = collectRelationshipIdsFromXml(firstBody);
  const contRelIds = collectRelationshipIdsFromXml(contBody);
  const footerRelIds = footerZip ? collectRelationshipIdsFromXml(footerBody) : new Set<string>();

  const firstDocRels = zipReadText(firstZip, "word/_rels/document.xml.rels");
  const contDocRels = zipReadText(contZip, "word/_rels/document.xml.rels");
  const footerDocRels = footerZip ? zipReadText(footerZip, "word/_rels/document.xml.rels") : "";

  const firstPicked = pickRelationships(firstDocRels, firstRelIds);
  const contPicked = pickRelationships(contDocRels, contRelIds);
  const footerPicked = footerZip ? pickRelationships(footerDocRels, footerRelIds) : [];

  for (const e of [...firstPicked, ...contPicked, ...footerPicked]) {
    if (e.targetMode && e.targetMode.toLowerCase() === "external") continue;
    const srcPath = normalizeTargetToZipPath(e.target);
    if (!srcPath) continue;
    if (baseZip.file(srcPath)) continue;
    const srcZip = firstPicked.includes(e) ? firstZip : contPicked.includes(e) ? contZip : footerZip!;
    const bytes = zipReadBytes(srcZip, srcPath);
    if (bytes) baseZip.file(srcPath, bytes);
  }

  baseZip.file("word/header1.xml", `${DOCX_HEADER_XML_PREFIX}${firstBody}</w:hdr>`);
  baseZip.file("word/header2.xml", `${DOCX_HEADER_XML_PREFIX}${contBody}</w:hdr>`);
  baseZip.file("word/_rels/header1.xml.rels", buildRelsXml(firstPicked));
  baseZip.file("word/_rels/header2.xml.rels", buildRelsXml(contPicked));

  ctXml = ensureContentTypeOverride(ctXml, "/word/header1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml");
  ctXml = ensureContentTypeOverride(ctXml, "/word/header2.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml");

  const headerType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
  const footerType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";

  const headerFirstRelId = nextRelationshipId(baseDocRels);
  baseDocRels = addDocumentRelationship(baseDocRels, headerFirstRelId, headerType, "header1.xml");
  const headerDefaultRelId = nextRelationshipId(baseDocRels);
  baseDocRels = addDocumentRelationship(baseDocRels, headerDefaultRelId, headerType, "header2.xml");

  let footerRelId: string | null = null;
  if (footerZip && footerBody) {
    baseZip.file("word/footer1.xml", `${DOCX_FOOTER_XML_PREFIX}${footerBody}</w:ftr>`);
    baseZip.file("word/_rels/footer1.xml.rels", buildRelsXml(footerPicked));
    ctXml = ensureContentTypeOverride(ctXml, "/word/footer1.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml");
    footerRelId = nextRelationshipId(baseDocRels);
    baseDocRels = addDocumentRelationship(baseDocRels, footerRelId, footerType, "footer1.xml");
  }

  const updatedDocXml = replaceOrInsertSectPr(baseDocXml, (sectPrXml) => {
    const stripped = stripSectPrRefs(sectPrXml);
    const inner = stripped.replace(/^<w:sectPr[^>]*>/, "").replace(/<\/w:sectPr>$/, "");
    const refs =
      `<w:titlePg/>` +
      `<w:headerReference w:type="first" r:id="${headerFirstRelId}"/>` +
      `<w:headerReference w:type="default" r:id="${headerDefaultRelId}"/>` +
      (footerMode === "every_page" && footerRelId ? `<w:footerReference w:type="first" r:id="${footerRelId}"/><w:footerReference w:type="default" r:id="${footerRelId}"/>` : "");
    return `<w:sectPr>${refs}${inner}</w:sectPr>`;
  });

  let finalDocXml = updatedDocXml;
  if (footerMode === "last_page_only" && footerRelId) {
    const sectPr =
      `<w:sectPr>` +
      `<w:type w:val="continuous"/>` +
      `<w:headerReference w:type="default" r:id="${headerDefaultRelId}"/>` +
      `<w:footerReference w:type="default" r:id="${footerRelId}"/>` +
      `</w:sectPr>`;
    const breakPara = `<w:p><w:pPr>${sectPr}</w:pPr></w:p>`;
    finalDocXml = finalDocXml.replace(/<\/w:body>/, `${breakPara}</w:body>`);
  }

  baseZip.file("word/document.xml", finalDocXml);
  baseZip.file(baseDocRelsPath, baseDocRels);
  baseZip.file("[Content_Types].xml", ctXml);

  return baseZip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

async function buildCaseContext(r: DbConn, caseId: number, firmId: number): Promise<Record<string, unknown> | null> {
  const caseRows = await queryRows(r, sql`SELECT * FROM cases WHERE id = ${caseId} AND firm_id = ${firmId}`);
  if (!caseRows[0]) return null;
  const c = caseRows[0];

  const projectRows = await queryRows(r, sql`SELECT * FROM projects WHERE id = ${c.project_id} AND firm_id = ${firmId}`);
  const developerRows = await queryRows(r, sql`SELECT * FROM developers WHERE id = ${c.developer_id} AND firm_id = ${firmId}`);
  const firmRows = await queryRows(r, sql`SELECT * FROM firms WHERE id = ${firmId}`);
  const bankRows = await queryRows(r, sql`SELECT * FROM firm_bank_accounts WHERE firm_id = ${firmId} ORDER BY is_default DESC`);
  const purchaserRows = await queryRows(r, sql`
    SELECT cp.*, cl.name, cl.ic_no, cl.nationality, cl.address, cl.phone, cl.email
    FROM case_purchasers cp JOIN clients cl ON cp.client_id = cl.id
    WHERE cp.case_id = ${caseId} AND cl.firm_id = ${firmId} ORDER BY cp.order_no`);
  const lawyerRows = await queryRows(r, sql`
    SELECT ca.*, u.name as user_name, u.email as user_email
    FROM case_assignments ca JOIN users u ON ca.user_id = u.id
    WHERE ca.case_id = ${caseId} AND ca.role_in_case = 'lawyer' AND ca.unassigned_at IS NULL
    LIMIT 1`);
  const clerkRows = await queryRows(r, sql`
    SELECT ca.*, u.name as user_name
    FROM case_assignments ca JOIN users u ON ca.user_id = u.id
    WHERE ca.case_id = ${caseId} AND ca.role_in_case = 'clerk' AND ca.unassigned_at IS NULL
    LIMIT 1`);

  const proj = projectRows[0] ?? {};
  const dev = developerRows[0] ?? {};
  const firm = firmRows[0] ?? {};
  const lawyer = lawyerRows[0] ?? {};
  const clerk = clerkRows[0] ?? {};
  const mainPurchaser = purchaserRows.find((p) => p.role === "main") ?? purchaserRows[0] ?? {};

  const spa = safeJson(c.spa_details);
  const prop = safeJson(c.property_details);
  const loan = safeJson(c.loan_details);
  const comp = safeJson(c.company_details);
  const devContacts = typeof dev.contacts === "string" ? (() => { try { return JSON.parse(dev.contacts as string); } catch { return []; } })() : [];

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-MY", { day: "2-digit", month: "long", year: "numeric" });
  const dateShort = today.toLocaleDateString("en-MY", { day: "2-digit", month: "2-digit", year: "numeric" });

  const workflowRows = await queryRows(r, sql`
    SELECT ws.step_key, ws.step_name, ws.step_order, ws.path_type, ws.status, ws.completed_at
    FROM case_workflow_steps ws
    JOIN cases cc ON cc.id = ws.case_id
    WHERE ws.case_id = ${caseId} AND cc.firm_id = ${firmId}
    ORDER BY ws.step_order ASC
  `);
  const workflowSteps = workflowRows
    .map((row) => {
      const stepKey = typeof (row as any).step_key === "string" ? String((row as any).step_key) : "";
      const stepName = typeof (row as any).step_name === "string" ? String((row as any).step_name) : "";
      const stepOrder = typeof (row as any).step_order === "number" ? Number((row as any).step_order) : null;
      const pathType = typeof (row as any).path_type === "string" ? String((row as any).path_type) : "";
      const status = typeof (row as any).status === "string" ? String((row as any).status) : "";
      const completedAt = (row as any).completed_at ?? null;
      return { stepKey, stepName, stepOrder, pathType, status, completedAt };
    })
    .filter((s) => Boolean(s.stepKey));

  const currentStepNameForPath = (pathType: string): string => {
    const completed = workflowSteps
      .filter((s) => s.pathType === pathType && s.status === "completed" && typeof s.stepOrder === "number")
      .sort((a, b) => (b.stepOrder ?? 0) - (a.stepOrder ?? 0));
    if (completed[0]?.stepName) return completed[0].stepName;
    if (pathType === "loan" && (c.purchase_mode ?? "") !== "loan") return "";
    return "Pending";
  };

  const workflowCompletedAtByKey = new Map<string, unknown>();
  for (const s of workflowSteps) {
    if (s.status !== "completed") continue;
    workflowCompletedAtByKey.set(s.stepKey, s.completedAt);
  }

  const workflowDebugVars: Record<string, unknown> = {};
  for (const s of workflowSteps) {
    const key = s.stepKey;
    workflowDebugVars[`workflow_${key}_date_raw`] = fmtDateYMD(s.completedAt);
    workflowDebugVars[`workflow_${key}_date`] = fmtDateDDMMYYYY(s.completedAt);
    workflowDebugVars[`workflow_${key}_date_long`] = fmtDateLong(s.completedAt);
  }

  const kdRows = await queryRows(r, sql`SELECT * FROM case_key_dates WHERE firm_id = ${firmId} AND case_id = ${caseId} LIMIT 1`);
  const kd = kdRows[0] ?? null;

  const pickDate = (structured: unknown, fallback: unknown): unknown => {
    const s = fmtDateYMD(structured);
    if (s) return structured;
    return fallback;
  };

  const keyDateVars: Record<string, unknown> = {};
  const addDateTriplet = (base: string, structured: unknown, fallback: unknown) => {
    const v = pickDate(structured, fallback);
    keyDateVars[`${base}_raw`] = fmtDateYMD(v);
    keyDateVars[base] = fmtDateDDMMYYYY(v);
    keyDateVars[`${base}_long`] = fmtDateLong(v);
  };

  const wf = (stepKey: string): unknown => workflowCompletedAtByKey.get(stepKey) ?? null;
  const kdVal = (col: string): unknown => (kd && typeof kd === "object" && col in kd ? (kd as any)[col] : null);

  addDateTriplet("spa_signed_date", kdVal("spa_signed_date"), null);
  addDateTriplet("spa_forward_to_developer_execution_on", kdVal("spa_forward_to_developer_execution_on"), null);
  addDateTriplet("spa_date", kdVal("spa_date"), null);
  addDateTriplet("spa_stamped_date", kdVal("spa_stamped_date"), wf("spa_stamped"));
  addDateTriplet("stamped_spa_send_to_developer_on", kdVal("stamped_spa_send_to_developer_on"), null);
  addDateTriplet("stamped_spa_received_from_developer_on", kdVal("stamped_spa_received_from_developer_on"), null);
  addDateTriplet("letter_of_offer_date", kdVal("letter_of_offer_date"), null);
  addDateTriplet("letter_of_offer_stamped_date", kdVal("letter_of_offer_stamped_date"), wf("lof_stamped"));

  addDateTriplet("loan_docs_pending_date", kdVal("loan_docs_pending_date"), wf("loan_docs_pending"));
  addDateTriplet("loan_docs_signed_date", kdVal("loan_docs_signed_date"), wf("loan_docs_signed"));
  addDateTriplet("acting_letter_issued_date", kdVal("acting_letter_issued_date"), wf("acting_letter_issued"));
  addDateTriplet("developer_confirmation_received_on", kdVal("developer_confirmation_received_on"), null);
  addDateTriplet("developer_confirmation_date", kdVal("developer_confirmation_date"), null);
  addDateTriplet("loan_sent_bank_execution_date", kdVal("loan_sent_bank_execution_date"), wf("loan_sent_bank_exec"));
  addDateTriplet("loan_bank_executed_date", kdVal("loan_bank_executed_date"), wf("loan_bank_executed"));
  addDateTriplet("bank_lu_received_date", kdVal("bank_lu_received_date"), wf("blu_received"));
  addDateTriplet("bank_lu_forward_to_developer_on", kdVal("bank_lu_forward_to_developer_on"), null);
  addDateTriplet("developer_lu_received_on", kdVal("developer_lu_received_on"), null);
  addDateTriplet("developer_lu_dated", kdVal("developer_lu_dated"), null);
  addDateTriplet("letter_disclaimer_received_on", kdVal("letter_disclaimer_received_on"), null);
  addDateTriplet("letter_disclaimer_dated", kdVal("letter_disclaimer_dated"), null);
  addDateTriplet("loan_agreement_dated", kdVal("loan_agreement_dated"), null);
  addDateTriplet("loan_agreement_submitted_stamping_date", kdVal("loan_agreement_submitted_stamping_date"), null);
  addDateTriplet("loan_agreement_stamped_date", kdVal("loan_agreement_stamped_date"), null);
  addDateTriplet("register_poa_on", kdVal("register_poa_on"), wf("pa_registered"));
  addDateTriplet("noa_served_on", kdVal("noa_served_on"), wf("noa_served"));
  addDateTriplet("advice_to_bank_date", kdVal("advice_to_bank_date"), null);
  addDateTriplet("bank_1st_release_on", kdVal("bank_1st_release_on"), null);

  addDateTriplet("mot_received_date", kdVal("mot_received_date"), wf("mot_received"));
  addDateTriplet("mot_signed_date", kdVal("mot_signed_date"), null);
  addDateTriplet("mot_stamped_date", kdVal("mot_stamped_date"), wf("mot_stamp"));
  addDateTriplet("mot_registered_date", kdVal("mot_registered_date"), null);

  addDateTriplet("progressive_payment_date", kdVal("progressive_payment_date"), null);
  addDateTriplet("full_settlement_date", kdVal("full_settlement_date"), null);
  addDateTriplet("completion_date", kdVal("completion_date"), null);

  keyDateVars.letter_disclaimer_reference_nos = typeof kdVal("letter_disclaimer_reference_nos") === "string" ? String(kdVal("letter_disclaimer_reference_nos")) : "";
  keyDateVars.registered_poa_registration_number = typeof kdVal("registered_poa_registration_number") === "string" ? String(kdVal("registered_poa_registration_number")) : "";

  const redemptionSumVal = kdVal("redemption_sum");
  keyDateVars.redemption_sum_raw = redemptionSumVal ?? "";
  keyDateVars.redemption_sum = fmtRM(redemptionSumVal);

  const firstReleaseVal = kdVal("first_release_amount_rm");
  keyDateVars.first_release_amount_rm_raw = firstReleaseVal ?? "";
  keyDateVars.first_release_amount_rm = fmtRM(firstReleaseVal);

  const officeBanks = bankRows.filter((b) => b.account_type === "office");
  const clientBanks = bankRows.filter((b) => b.account_type === "client");

  return {
    case_id: caseId,
    reference_no: c.reference_no ?? "",
    date: dateStr,
    date_short: dateShort,
    case_type: c.case_type ?? "",
    parcel_no: c.parcel_no ?? "",
    spa_price: fmtRM(c.spa_price),
    spa_price_raw: c.spa_price ?? "",
    purchase_mode: c.purchase_mode ?? "",
    title_type: c.title_type ?? "",
    status: c.status ?? "",
    spa_status: currentStepNameForPath("common"),
    loan_status: currentStepNameForPath("loan"),

    // SPA Details
    spa_purchaser1_name: (spa.purchasers as any)?.[0]?.name ?? "",
    spa_purchaser1_ic: (spa.purchasers as any)?.[0]?.ic ?? "",
    spa_purchaser2_name: (spa.purchasers as any)?.[1]?.name ?? "",
    spa_purchaser2_ic: (spa.purchasers as any)?.[1]?.ic ?? "",
    spa_address_line1: spa.addressLine1 ?? "",
    spa_address_line2: spa.addressLine2 ?? "",
    spa_address_line3: spa.addressLine3 ?? "",
    spa_address_line4: spa.addressLine4 ?? "",
    spa_address_line5: spa.addressLine5 ?? "",
    spa_mailing_address: spa.mailingAddress ?? "",
    spa_contact_number: spa.contactNumber ?? "",
    spa_email: spa.emailAddress ?? "",

    // Property Details
    property_parcel_no: prop.parcelNo ?? "",
    property_floor_no: prop.floorNo ?? "",
    property_building_no: prop.buildingNo ?? "",
    property_car_park_no: prop.carParkNo ?? "",
    property_type: prop.propertyType ?? "",
    property_area_sqm: prop.areaSqm ?? "",
    property_purchase_price: fmtRM(prop.purchasePrice),
    property_purchase_price_raw: prop.purchasePrice ?? "",
    property_progress_payment: prop.progressPayment ?? "",
    property_dev_discount: fmtRM(prop.devDiscount),
    property_dev_discount_raw: prop.devDiscount ?? "",
    property_bumi_discount: fmtRM(prop.bumiDiscount),
    property_bumi_discount_raw: prop.bumiDiscount ?? "",
    property_approved_price: fmtRM(prop.approvedPurchasePrice),
    property_approved_price_raw: prop.approvedPurchasePrice ?? "",

    // Loan Details
    borrower1_name: loan.borrower1Name ?? "",
    borrower1_ic: loan.borrower1Ic ?? "",
    borrower2_name: loan.borrower2Name ?? "",
    borrower2_ic: loan.borrower2Ic ?? "",
    end_financier: loan.endFinancier ?? "",
    bank_ref: loan.bankRef ?? "",
    bank_branch: loan.bankBranch ?? "",
    financing_sum: fmtRM(loan.financingSum),
    financing_sum_raw: loan.financingSum ?? "",
    other_charges: fmtRM(loan.otherCharges),
    other_charges_raw: loan.otherCharges ?? "",
    total_loan: fmtRM(loan.totalLoan),
    total_loan_raw: loan.totalLoan ?? "",

    // Company Details
    director1_name: comp.director1Name ?? "",
    director1_ic: comp.director1Ic ?? "",
    director2_name: comp.director2Name ?? "",
    director2_ic: comp.director2Ic ?? "",

    // Project Details
    project_name: proj.name ?? "",
    project_phase: proj.phase ?? "",
    project_type: proj.project_type ?? "",
    project_title_type: proj.title_type ?? "",
    project_title_subtype: proj.title_subtype ?? "",
    project_master_title_no: proj.master_title_number ?? "",
    project_master_title_size: proj.master_title_land_size ?? "",
    project_mukim: proj.mukim ?? "",
    project_daerah: proj.daerah ?? "",
    project_negeri: proj.negeri ?? "",
    project_land_use: proj.land_use ?? "",
    project_development_condition: proj.development_condition ?? "",
    project_developer_name: proj.developer_name ?? "",
    unit_category: proj.unit_category ?? "",
    project_property_types: (() => {
      const ef = proj.extra_fields;
      const parsed = typeof ef === "string" ? (() => { try { return JSON.parse(ef); } catch { return {}; } })() : (ef ?? {});
      const pts = Array.isArray(parsed.propertyTypes) ? parsed.propertyTypes : [];
      return pts.map((pt: any, i: number) => ({ index: i + 1, building_type: pt.buildingType ?? "" }));
    })(),

    // Developer Details
    developer_name: dev.name ?? "",
    developer_reg_no: dev.company_reg_no ?? "",
    developer_address: dev.address ?? "",
    developer_business_address: dev.business_address ?? "",
    developer_contact: dev.contact_person ?? "",
    developer_phone: dev.phone ?? "",
    developer_email: dev.email ?? "",
    developer_contacts: Array.isArray(devContacts) ? devContacts.map((dc: any, i: number) => ({
      index: i + 1,
      department: dc.department ?? "",
      phone: dc.phone ?? "",
      ext: dc.ext ?? "",
      email: dc.email ?? "",
    })) : [],

    // Purchaser (Main)
    purchaser_name: mainPurchaser.name ?? "",
    purchaser_ic: mainPurchaser.ic_no ?? "",
    purchaser_nationality: mainPurchaser.nationality ?? "",
    purchaser_address: mainPurchaser.address ?? "",
    purchaser_phone: mainPurchaser.phone ?? "",
    purchaser_email: mainPurchaser.email ?? "",

    // All Purchasers (loop)
    purchasers: purchaserRows.map((p, i) => ({
      index: i + 1,
      name: p.name ?? "",
      ic: p.ic_no ?? "",
      nationality: p.nationality ?? "",
      address: p.address ?? "",
      phone: p.phone ?? "",
      email: p.email ?? "",
      role: p.role ?? "",
    })),

    // Assignments
    lawyer_name: lawyer.user_name ?? "",
    lawyer_email: lawyer.user_email ?? "",
    clerk_name: clerk.user_name ?? "",

    // Firm Details
    firm_name: firm.name ?? "",
    firm_address: firm.address ?? "",
    firm_st_number: firm.st_number ?? "",
    firm_tin_number: firm.tin_number ?? "",

    // Bank Accounts
    office_bank_name: officeBanks[0]?.bank_name ?? "",
    office_bank_account_no: officeBanks[0]?.account_no ?? "",
    client_bank_name: clientBanks[0]?.bank_name ?? "",
    client_bank_account_no: clientBanks[0]?.account_no ?? "",
    bank_accounts: bankRows.map((b, i) => ({
      index: i + 1,
      bank_name: b.bank_name ?? "",
      account_no: b.account_no ?? "",
      account_type: b.account_type ?? "",
    })),
    ...keyDateVars,
    ...workflowDebugVars,
  };
}

router.get("/firm-document-folders", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const rows = await queryRows(
    r,
    sql`SELECT * FROM firm_document_folders WHERE firm_id = ${req.firmId!} ORDER BY parent_id NULLS FIRST, sort_order ASC, name ASC`
  );
  res.json(rows);
});

router.post("/firm-document-folders", requireAuth, requireFirmUser, requirePermission("documents", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const { name, parentId } = req.body as { name: string; parentId?: number | null };
  const folderName = typeof name === "string" ? name.trim() : "";
  const pid = typeof parentId === "number" ? parentId : null;
  if (!folderName) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (pid !== null) {
    const parentRows = await queryRows(
      r,
      sql`SELECT id FROM firm_document_folders WHERE id = ${pid} AND firm_id = ${req.firmId!}`
    );
    if (!parentRows[0]) {
      res.status(400).json({ error: "Invalid parent folder" });
      return;
    }
  }
  try {
    const rows = await queryRows(
      r,
      sql`INSERT INTO firm_document_folders (firm_id, name, parent_id, sort_order)
          VALUES (${req.firmId!}, ${folderName}, ${pid}, 0)
          RETURNING *`
    );
    const created = rows[0];
    const createdId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : undefined;
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_folder.create", entityType: "firm_document_folder", entityId: createdId, detail: `name=${folderName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Folder name already exists", code: "DUPLICATE_FOLDER_NAME" });
      return;
    }
    res.status(500).json({ error: "Failed to create folder" });
  }
});

router.patch("/firm-document-folders/:folderId", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const folderIdStr = one((req.params as any).folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : NaN;
  if (Number.isNaN(folderId)) {
    res.status(400).json({ error: "Invalid folder ID" });
    return;
  }
  const { name } = req.body as { name?: string };
  const folderName = typeof name === "string" ? name.trim() : "";
  if (!folderName) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const rows = await queryRows(
      r,
      sql`UPDATE firm_document_folders
          SET name = ${folderName}, updated_at = now()
          WHERE id = ${folderId} AND firm_id = ${req.firmId!}
          RETURNING *`
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_folder.rename", entityType: "firm_document_folder", entityId: folderId, detail: `name=${folderName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.json(rows[0]);
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Folder name already exists", code: "DUPLICATE_FOLDER_NAME" });
      return;
    }
    res.status(500).json({ error: "Failed to rename folder" });
  }
});

router.delete("/firm-document-folders/:folderId", requireAuth, requireFirmUser, requirePermission("documents", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const folderIdStr = one((req.params as any).folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : NaN;
  if (Number.isNaN(folderId)) {
    res.status(400).json({ error: "Invalid folder ID" });
    return;
  }
  const childRows = await queryRows(
    r,
    sql`SELECT 1 FROM firm_document_folders WHERE firm_id = ${req.firmId!} AND parent_id = ${folderId} LIMIT 1`
  );
  if (childRows[0]) {
    res.status(409).json({ error: "Folder has subfolders", code: "FOLDER_NOT_EMPTY" });
    return;
  }
  const docRows = await queryRows(
    r,
    sql`SELECT 1 FROM document_templates WHERE firm_id = ${req.firmId!} AND folder_id = ${folderId} LIMIT 1`
  );
  if (docRows[0]) {
    res.status(409).json({ error: "Folder has documents", code: "FOLDER_NOT_EMPTY" });
    return;
  }
  const rows = await queryRows(
    r,
    sql`DELETE FROM firm_document_folders WHERE id = ${folderId} AND firm_id = ${req.firmId!} RETURNING *`
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_folder.delete", entityType: "firm_document_folder", entityId: folderId, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

router.get("/document-templates", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const folderIdStr = one((req.query as any).folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : null;
  const kind = one((req.query as any).kind);
  const templateCapable = truthy((req.query as any).templateCapable);
  const clauses: Array<ReturnType<typeof sql>> = [sql`firm_id = ${req.firmId!}`];
  if (folderIdStr) {
    if (folderId === null || Number.isNaN(folderId)) {
      res.status(400).json({ error: "Invalid folderId" });
      return;
    }
    clauses.push(sql`folder_id = ${folderId}`);
  }
  if (kind) clauses.push(sql`kind = ${kind}`);
  if (templateCapable) clauses.push(sql`is_template_capable = true`);
  const where = sql.join(clauses, sql` AND `);
  const rows = await queryRows(
    r,
    sql`SELECT * FROM document_templates WHERE ${where} ORDER BY created_at DESC`
  );
  res.json(rows);
});

router.post("/document-templates", requireAuth, requireFirmUser, requirePermission("documents", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const { name, documentType, description, objectPath, fileName, folderId, kind, mimeType, extension, fileSize } = req.body as {
    name: string;
    documentType?: string;
    description?: string;
    objectPath: string;
    fileName: string;
    folderId?: number | null;
    kind?: string;
    mimeType?: string;
    extension?: string;
    fileSize?: number;
  };

  if (!name || !objectPath || !fileName) {
    res.status(400).json({ error: "name, objectPath, and fileName are required" });
    return;
  }

  const folderIdNum = typeof folderId === "number" ? folderId : null;
  const kindVal = typeof kind === "string" ? kind : "template";
  if (kindVal !== "template" && kindVal !== "reference") {
    res.status(400).json({ error: "Invalid kind" });
    return;
  }
  if (folderIdNum !== null) {
    const folderRows = await queryRows(
      r,
      sql`SELECT id FROM firm_document_folders WHERE id = ${folderIdNum} AND firm_id = ${req.firmId!}`
    );
    if (!folderRows[0]) {
      res.status(400).json({ error: "Invalid folder" });
      return;
    }
  }

  const ext = (typeof extension === "string" ? extension : "").trim().toLowerCase() || fileExtensionFromName(fileName);
  if (!ext || !FIRM_DOCUMENT_ALLOWED_EXTENSIONS.has(ext)) {
    res.status(400).json({ error: "Unsupported file type", code: "UNSUPPORTED_FILE_TYPE" });
    return;
  }
  const effectiveKind: "template" | "reference" = ext === "docx" ? kindVal : "reference";
  if (effectiveKind === "template" && ext !== "docx") {
    res.status(400).json({ error: "Template must be a .docx file", code: "TEMPLATE_MUST_BE_DOCX" });
    return;
  }
  const isTemplateCapable = effectiveKind === "template" && ext === "docx";

  const rows = await queryRows(
    r,
    sql`INSERT INTO document_templates (firm_id, name, document_type, description, object_path, file_name, created_by)
        VALUES (${req.firmId!}, ${name}, ${effectiveKind === "template" ? (documentType ?? "other") : "other"}, ${description ?? null}, ${objectPath}, ${fileName}, ${req.userId!})
        RETURNING *`
  );

  const created = rows[0];
  const createdId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : undefined;

  const patched = await queryRows(
    r,
    sql`UPDATE document_templates
        SET folder_id = ${folderIdNum},
            kind = ${effectiveKind},
            mime_type = ${mimeType ?? null},
            extension = ${ext || null},
            file_size = ${typeof fileSize === "number" ? fileSize : null},
            is_template_capable = ${isTemplateCapable},
            updated_at = now()
        WHERE id = ${createdId ?? 0} AND firm_id = ${req.firmId!}
        RETURNING *`
  );

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_document.upload", entityType: "firm_document", entityId: createdId, detail: `name=${name} kind=${effectiveKind} ext=${ext}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(patched[0] ?? rows[0]);
});

router.patch("/document-templates/:templateId", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const hasFolderId = Object.prototype.hasOwnProperty.call(body, "folderId");
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const hasDocumentType = Object.prototype.hasOwnProperty.call(body, "documentType");
  const hasIsActive = Object.prototype.hasOwnProperty.call(body, "isActive");
  const hasAppliesToPurchaseMode = Object.prototype.hasOwnProperty.call(body, "appliesToPurchaseMode");
  const hasAppliesToTitleType = Object.prototype.hasOwnProperty.call(body, "appliesToTitleType");
  const hasAppliesToCaseType = Object.prototype.hasOwnProperty.call(body, "appliesToCaseType");
  const hasDocumentGroup = Object.prototype.hasOwnProperty.call(body, "documentGroup");
  const hasSortOrder = Object.prototype.hasOwnProperty.call(body, "sortOrder");
  const hasFileNamingRule = Object.prototype.hasOwnProperty.call(body, "fileNamingRule");
  const hasClauseInsertionMode = Object.prototype.hasOwnProperty.call(body, "clauseInsertionMode");
  const hasChecklistMode = Object.prototype.hasOwnProperty.call(body, "checklistMode");
  const hasChecklistItems = Object.prototype.hasOwnProperty.call(body, "checklistItems");

  const folderId = body.folderId;
  const kind = body.kind;
  const name = body.name;
  const description = body.description;
  const documentType = body.documentType;
  const isActive = body.isActive;
  const appliesToPurchaseMode = body.appliesToPurchaseMode;
  const appliesToTitleType = body.appliesToTitleType;
  const appliesToCaseType = body.appliesToCaseType;
  const documentGroup = body.documentGroup;
  const sortOrder = body.sortOrder;
  const fileNamingRule = body.fileNamingRule;
  const clauseInsertionMode = body.clauseInsertionMode;
  const checklistMode = body.checklistMode;
  const checklistItems = body.checklistItems;

  const folderIdNum: number | null | undefined = hasFolderId ? (typeof folderId === "number" ? folderId : folderId === null ? null : undefined) : undefined;
  if (hasFolderId && folderIdNum === undefined) {
    res.status(400).json({ error: "Invalid folderId" });
    return;
  }

  const kindVal = typeof kind === "string" ? kind : undefined;
  const nameVal = typeof name === "string" ? name.trim() : undefined;
  if (hasName && !nameVal) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const descriptionVal: string | null | undefined =
    hasDescription
      ? (typeof description === "string" ? description.trim() : description === null ? null : undefined)
      : undefined;
  if (hasDescription && descriptionVal === undefined) {
    res.status(400).json({ error: "Invalid description" });
    return;
  }
  const docTypeVal: string | undefined =
    hasDocumentType
      ? (typeof documentType === "string" ? (documentType.trim() || "other") : undefined)
      : undefined;
  if (hasDocumentType && !docTypeVal) {
    res.status(400).json({ error: "Invalid documentType" });
    return;
  }

  const isActiveVal: boolean | undefined = hasIsActive ? (typeof isActive === "boolean" ? isActive : undefined) : undefined;
  if (hasIsActive && isActiveVal === undefined) {
    res.status(400).json({ error: "Invalid isActive" });
    return;
  }
  const purchaseModeVal: string | null | undefined =
    hasAppliesToPurchaseMode
      ? (typeof appliesToPurchaseMode === "string" ? (appliesToPurchaseMode.trim() || null) : appliesToPurchaseMode === null ? null : undefined)
      : undefined;
  if (hasAppliesToPurchaseMode && purchaseModeVal === undefined) {
    res.status(400).json({ error: "Invalid appliesToPurchaseMode" });
    return;
  }
  const titleTypeVal: string | undefined =
    hasAppliesToTitleType
      ? (typeof appliesToTitleType === "string" ? (appliesToTitleType.trim() || "any") : undefined)
      : undefined;
  if (hasAppliesToTitleType && !titleTypeVal) {
    res.status(400).json({ error: "Invalid appliesToTitleType" });
    return;
  }
  const caseTypeVal: string | null | undefined =
    hasAppliesToCaseType
      ? (typeof appliesToCaseType === "string" ? (appliesToCaseType.trim() || null) : appliesToCaseType === null ? null : undefined)
      : undefined;
  if (hasAppliesToCaseType && caseTypeVal === undefined) {
    res.status(400).json({ error: "Invalid appliesToCaseType" });
    return;
  }
  const groupVal: string | undefined =
    hasDocumentGroup
      ? (typeof documentGroup === "string" ? (documentGroup.trim() || "Others") : undefined)
      : undefined;
  if (hasDocumentGroup && !groupVal) {
    res.status(400).json({ error: "Invalid documentGroup" });
    return;
  }
  const sortOrderVal: number | undefined = hasSortOrder ? (typeof sortOrder === "number" && Number.isFinite(sortOrder) ? sortOrder : undefined) : undefined;
  if (hasSortOrder && sortOrderVal === undefined) {
    res.status(400).json({ error: "Invalid sortOrder" });
    return;
  }
  const fileNamingRuleVal: string | null | undefined =
    hasFileNamingRule
      ? (typeof fileNamingRule === "string" ? (fileNamingRule.trim() || null) : fileNamingRule === null ? null : undefined)
      : undefined;
  if (hasFileNamingRule && fileNamingRuleVal === undefined) {
    res.status(400).json({ error: "Invalid fileNamingRule" });
    return;
  }
  const clauseInsertionModeVal: string | null | undefined =
    hasClauseInsertionMode
      ? (typeof clauseInsertionMode === "string" ? (clauseInsertionMode.trim() || null) : clauseInsertionMode === null ? null : undefined)
      : undefined;
  if (hasClauseInsertionMode && clauseInsertionModeVal === undefined) {
    res.status(400).json({ error: "Invalid clauseInsertionMode" });
    return;
  }
  const checklistModeVal: string | null | undefined =
    hasChecklistMode
      ? (typeof checklistMode === "string" ? (checklistMode.trim() || null) : checklistMode === null ? null : undefined)
      : undefined;
  if (hasChecklistMode && checklistModeVal === undefined) {
    res.status(400).json({ error: "Invalid checklistMode" });
    return;
  }
  const checklistItemsVal: Record<string, unknown>[] | null | undefined =
    hasChecklistItems
      ? (Array.isArray(checklistItems) ? (checklistItems as Record<string, unknown>[]) : checklistItems === null ? null : undefined)
      : undefined;
  if (hasChecklistItems && checklistItemsVal === undefined) {
    res.status(400).json({ error: "Invalid checklistItems" });
    return;
  }
  if (kindVal && kindVal !== "template" && kindVal !== "reference") {
    res.status(400).json({ error: "Invalid kind" });
    return;
  }
  if (hasFolderId && folderIdNum !== null) {
    const folderRows = await queryRows(
      r,
      sql`SELECT id FROM firm_document_folders WHERE id = ${folderIdNum} AND firm_id = ${req.firmId!}`
    );
    if (!folderRows[0]) {
      res.status(400).json({ error: "Invalid folder" });
      return;
    }
  }

  const existingRows = await queryRows(
    r,
    sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`
  );
  const existing = existingRows[0];
  if (!existing) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const existingExt = typeof (existing as any).extension === "string" ? String((existing as any).extension) : fileExtensionFromName(String((existing as any).file_name ?? ""));
  const existingKindRaw = typeof (existing as any).kind === "string" ? String((existing as any).kind) : "template";
  const requestedKindRaw = kindVal ?? existingKindRaw;
  const requestedKind: "template" | "reference" = requestedKindRaw === "reference" ? "reference" : "template";
  const effectiveKind: "template" | "reference" = (existingExt || "").toLowerCase() === "docx" ? requestedKind : "reference";
  if (effectiveKind === "template" && String(existingExt || "").toLowerCase() !== "docx") {
    res.status(400).json({ error: "Template must be a .docx file", code: "TEMPLATE_MUST_BE_DOCX" });
    return;
  }

  const rows = await queryRows(
    r,
    sql`UPDATE document_templates
        SET folder_id = CASE WHEN ${hasFolderId} THEN ${folderIdNum ?? null} ELSE folder_id END,
            kind = ${effectiveKind},
            name = CASE WHEN ${hasName} THEN ${nameVal ?? ""} ELSE name END,
            description = CASE WHEN ${hasDescription} THEN ${descriptionVal ?? null} ELSE description END,
            document_type = CASE WHEN ${hasDocumentType} THEN ${effectiveKind === "template" ? (docTypeVal ?? "other") : "other"} ELSE document_type END,
            is_active = CASE WHEN ${hasIsActive} THEN ${isActiveVal ?? true} ELSE is_active END,
            applies_to_purchase_mode = CASE WHEN ${hasAppliesToPurchaseMode} THEN ${purchaseModeVal ?? null} ELSE applies_to_purchase_mode END,
            applies_to_title_type = CASE WHEN ${hasAppliesToTitleType} THEN ${titleTypeVal ?? "any"} ELSE applies_to_title_type END,
            applies_to_case_type = CASE WHEN ${hasAppliesToCaseType} THEN ${caseTypeVal ?? null} ELSE applies_to_case_type END,
            document_group = CASE WHEN ${hasDocumentGroup} THEN ${groupVal ?? "Others"} ELSE document_group END,
            sort_order = CASE WHEN ${hasSortOrder} THEN ${sortOrderVal ?? 0} ELSE sort_order END,
            file_naming_rule = CASE WHEN ${hasFileNamingRule} THEN ${fileNamingRuleVal ?? null} ELSE file_naming_rule END,
            clause_insertion_mode = CASE WHEN ${hasClauseInsertionMode} THEN ${clauseInsertionModeVal ?? null} ELSE clause_insertion_mode END,
            checklist_mode = CASE WHEN ${hasChecklistMode} THEN ${checklistModeVal ?? null} ELSE checklist_mode END,
            checklist_items = CASE WHEN ${hasChecklistItems} THEN ${checklistItemsVal as any} ELSE checklist_items END,
            is_template_capable = (
              ${effectiveKind} = 'template'
              AND LOWER(COALESCE(NULLIF(extension,''), split_part(file_name, '.', array_length(string_to_array(file_name, '.'), 1)))) = 'docx'
            ),
            updated_at = now()
        WHERE id = ${templateId} AND firm_id = ${req.firmId!}
        RETURNING *`
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const prevFolderId = (existing as any).folder_id ?? null;
  const moved = hasFolderId ? prevFolderId !== folderIdNum : false;
  const action = moved ? "documents.firm_document.move" : "documents.firm_document.update";
  const detailParts: string[] = [];
  if (moved) detailParts.push(`folderId=${folderIdNum ?? "null"}`);
  if (nameVal !== undefined) detailParts.push(`name=${nameVal}`);
  if (hasDescription) detailParts.push("description=updated");
  if (docTypeVal !== undefined) detailParts.push(`documentType=${docTypeVal}`);
  if (kindVal !== undefined) detailParts.push(`kind=${effectiveKind}`);
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action, entityType: "firm_document", entityId: templateId, detail: detailParts.length ? detailParts.join(" ") : undefined, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(rows[0]);
});

router.get("/document-variables", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const category = one((req.query as any).category);
  const activeRaw = one((req.query as any).active);
  const active =
    activeRaw === undefined ? undefined
    : activeRaw === "0" || activeRaw.toLowerCase() === "false" || activeRaw.toLowerCase() === "no" ? false
    : true;
  const vars = await listDocumentVariables(r, { category: category || undefined, active });
  res.json(vars);
});

const variableCategorySchema = z.enum(["case", "purchaser", "property", "loan", "developer", "project", "workflow", "custom"]);
const variableValueTypeSchema = z.enum(["string", "number", "date", "boolean", "richtext", "array"]);

const createVariableBodySchema = z.object({
  key: z.string().trim().min(1).max(120).regex(/^[a-z0-9_]+$/i),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  category: variableCategorySchema,
  valueType: variableValueTypeSchema,
  sourcePath: z.string().trim().max(300).nullable().optional(),
  formatter: z.string().trim().max(80).nullable().optional(),
  exampleValue: z.string().trim().max(300).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

const updateVariableBodySchema = createVariableBodySchema
  .omit({ key: true })
  .extend({ key: z.string().trim().min(1).max(120).regex(/^[a-z0-9_]+$/i).optional() })
  .partial();

router.get("/platform/document-variables", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const category = one((req.query as any).category);
  const activeRaw = one((req.query as any).active);
  const active =
    activeRaw === undefined ? undefined
    : activeRaw === "0" || activeRaw.toLowerCase() === "false" || activeRaw.toLowerCase() === "no" ? false
    : true;

  try {
    const reqId = (req as any).id;
    const vars = await withAuthSafeDb(
      async (authDb) => await listDocumentVariables(authDb, { category: category || undefined, active }),
      { retry: true, ctx: { route: req.path, stage: "platform_document_variables.list", reqId, firmId: null, userId: req.userId ?? null } },
    );
    res.json(vars);
  } catch (err) {
    logger.error({ err, userId: req.userId }, "[platform-document-variables]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/platform/document-variables", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const parsed = createVariableBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    const reqId = (req as any).id;
    const v = parsed.data;
    const created = await withAuthSafeDb(async (authDb) => {
      const rows = await queryRows(authDb, sql`
        INSERT INTO document_variable_definitions
          (key, label, description, category, value_type, source_path, formatter, example_value, is_system, is_active, sort_order)
        VALUES
          (${v.key}, ${v.label}, ${v.description ?? null}, ${v.category}, ${v.valueType}, ${v.sourcePath ?? null}, ${v.formatter ?? null}, ${v.exampleValue ?? null}, TRUE, ${v.isActive ?? true}, ${v.sortOrder ?? 0})
        RETURNING *
      `);
      const row = rows[0];
      const id = typeof row?.id === "number" ? row.id : Number(row?.id);
      await writeAuditLog(
        { firmId: null, actorId: req.userId, actorType: req.userType, action: "documents.variable_registry.create", entityType: "document_variable_definition", entityId: Number.isFinite(id) ? id : undefined, detail: `key=${v.key}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
        { db: authDb },
      );
      return row;
    }, { retry: true, ctx: { route: req.path, stage: "platform_document_variables.create", reqId, firmId: null, userId: req.userId ?? null } });

    res.status(201).json(created);
  } catch (err) {
    logger.error({ err, userId: req.userId }, "[platform-document-variables-create]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/platform/document-variables/:id", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid variable ID" });
    return;
  }

  const parsed = updateVariableBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    const reqId = (req as any).id;
    const patch = parsed.data;
    const updated = await withAuthSafeDb(async (authDb) => {
      const existingRows = await queryRows(authDb, sql`SELECT * FROM document_variable_definitions WHERE id = ${id}`);
      const existing = existingRows[0];
      if (!existing) return null;

      const existingKey = typeof existing.key === "string" ? existing.key : String(existing.key ?? "");
      if (typeof patch.key === "string" && patch.key !== existingKey) {
        return { status: 400 as const, body: { error: "Variable key cannot be changed" } };
      }

      const nextRows = await queryRows(authDb, sql`
        UPDATE document_variable_definitions
        SET
          label = COALESCE(${patch.label ?? null}, label),
          description = CASE WHEN ${Object.prototype.hasOwnProperty.call(patch, "description")} THEN ${patch.description ?? null} ELSE description END,
          category = COALESCE(${patch.category ?? null}, category),
          value_type = COALESCE(${patch.valueType ?? null}, value_type),
          source_path = CASE WHEN ${Object.prototype.hasOwnProperty.call(patch, "sourcePath")} THEN ${patch.sourcePath ?? null} ELSE source_path END,
          formatter = CASE WHEN ${Object.prototype.hasOwnProperty.call(patch, "formatter")} THEN ${patch.formatter ?? null} ELSE formatter END,
          example_value = CASE WHEN ${Object.prototype.hasOwnProperty.call(patch, "exampleValue")} THEN ${patch.exampleValue ?? null} ELSE example_value END,
          is_active = COALESCE(${typeof patch.isActive === "boolean" ? patch.isActive : null}, is_active),
          sort_order = COALESCE(${typeof patch.sortOrder === "number" ? patch.sortOrder : null}, sort_order),
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `);
      const row = nextRows[0];
      await writeAuditLog(
        { firmId: null, actorId: req.userId, actorType: req.userType, action: "documents.variable_registry.update", entityType: "document_variable_definition", entityId: id, detail: `key=${existingKey}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
        { db: authDb },
      );
      return { status: 200 as const, body: row };
    }, { retry: true, ctx: { route: req.path, stage: "platform_document_variables.update", reqId, firmId: null, userId: req.userId ?? null } });

    if (!updated) {
      res.status(404).json({ error: "Variable not found" });
      return;
    }
    if ("status" in updated && updated.status === 400) {
      res.status(400).json(updated.body);
      return;
    }
    res.status(updated.status).json(updated.body);
  } catch (err) {
    logger.error({ err, userId: req.userId, variableId: id }, "[platform-document-variables-update]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

async function getFirmTemplatePlaceholders(r: DbConn, firmId: number, templateId: number): Promise<string[]> {
  const rows = await queryRows(r, sql`
    SELECT v.variables_snapshot, v.source_object_path, v.filename
    FROM document_template_versions v
    WHERE v.firm_id = ${firmId} AND v.template_id = ${templateId} AND v.status = 'published'
    ORDER BY v.published_at DESC NULLS LAST, v.version_no DESC
    LIMIT 1
  `);
  const v = rows[0];
  const fromSnap = placeholdersFromVariablesSnapshot(v?.variables_snapshot);
  if (fromSnap.length > 0) return fromSnap;
  const obj = typeof v?.source_object_path === "string" ? String(v.source_object_path) : "";
  const filename = typeof v?.filename === "string" ? String(v.filename) : "";
  if (obj && fileExtensionFromName(filename) === "docx") {
    try {
      const bytes = await downloadPrivateObjectBytes(obj);
      return detectDocxVariables(bytes);
    } catch {
      return [];
    }
  }
  return [];
}

async function getPlatformDocPlaceholders(r: DbConn, firmId: number | null, docId: number): Promise<string[]> {
  const docRows = await queryRows(r, sql`SELECT * FROM platform_documents WHERE id = ${docId} AND (firm_id IS NULL OR firm_id = ${firmId ?? null})`);
  const d = docRows[0];
  if (!d) return [];
  const fileName = typeof d.file_name === "string" ? String(d.file_name) : "";
  const ext = fileExtensionFromName(fileName);
  if (ext === "docx") {
    const obj = typeof d.object_path === "string" ? String(d.object_path) : "";
    if (!obj) return [];
    try {
      const bytes = await downloadPrivateObjectBytes(obj);
      return detectDocxVariables(bytes);
    } catch {
      return [];
    }
  }
  if (ext === "pdf") {
    return extractPdfMappingPlaceholders((d as any).pdf_mappings);
  }
  return [];
}

router.get("/document-templates/:templateId/bindings", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const tplRows = await queryRows(r, sql`SELECT id, firm_id FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
  if (!tplRows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const [vars, bindings, placeholders] = await Promise.all([
    listDocumentVariables(r, { active: true }),
    getFirmTemplateBindings(r, req.firmId!, templateId),
    getFirmTemplatePlaceholders(r, req.firmId!, templateId),
  ]);
  res.json({ placeholders, variables: vars, bindings });
});

router.put("/document-templates/:templateId/bindings", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const tplRows = await queryRows(r, sql`SELECT id FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
  if (!tplRows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const list = Array.isArray(body.bindings) ? body.bindings : [];
  const normalized = list
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => !!x)
    .map((x) => ({
      variableKey: String(x.variableKey ?? x.variable_key ?? "").trim(),
      sourceMode: (String(x.sourceMode ?? x.source_mode ?? "registry_default").trim() as "registry_default" | "custom_path" | "fixed_value"),
      sourcePath: typeof (x.sourcePath ?? x.source_path) === "string" ? String(x.sourcePath ?? x.source_path).trim() || null : null,
      fixedValue: typeof (x.fixedValue ?? x.fixed_value) === "string" ? String(x.fixedValue ?? x.fixed_value) : null,
      formatterOverride: typeof (x.formatterOverride ?? x.formatter_override) === "string" ? String(x.formatterOverride ?? x.formatter_override).trim() || null : null,
      isRequired: Boolean(x.isRequired ?? x.is_required ?? false),
      fallbackValue: typeof (x.fallbackValue ?? x.fallback_value) === "string" ? String(x.fallbackValue ?? x.fallback_value) : null,
      notes: typeof x.notes === "string" ? x.notes : null,
    }))
    .filter((b) => b.variableKey.length > 0);

  await replaceFirmTemplateBindings(r, req.firmId!, templateId, normalized);
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.template.bindings.update", entityType: "document_template", entityId: templateId, detail: `count=${normalized.length}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  const bindings = await getFirmTemplateBindings(r, req.firmId!, templateId);
  res.json({ bindings });
});

router.get("/platform/documents/:documentId/bindings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const documentIdStr = one((req.params as any).documentId);
  const documentId = documentIdStr ? parseInt(documentIdStr, 10) : NaN;
  if (Number.isNaN(documentId)) {
    res.status(400).json({ error: "Invalid document ID" });
    return;
  }
  const result = await withAuthSafeDb(async (authDb) => {
    const doc = await queryRows(authDb, sql`SELECT id FROM platform_documents WHERE id = ${documentId}`);
    if (!doc[0]) return { status: 404 as const, body: { error: "Document not found" } };
    const [vars, bindings, placeholders] = await Promise.all([
      listDocumentVariables(authDb, { active: true }),
      getPlatformDocumentBindings(authDb, null, documentId),
      getPlatformDocPlaceholders(authDb, null, documentId),
    ]);
    return { status: 200 as const, body: { placeholders, variables: vars, bindings } };
  }, { retry: true, ctx: { route: req.path, stage: "platform_document_bindings.get", userId: req.userId ?? null, firmId: null } });
  res.status(result.status).json(result.body);
});

router.put("/platform/documents/:documentId/bindings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const documentIdStr = one((req.params as any).documentId);
  const documentId = documentIdStr ? parseInt(documentIdStr, 10) : NaN;
  if (Number.isNaN(documentId)) {
    res.status(400).json({ error: "Invalid document ID" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const list = Array.isArray(body.bindings) ? body.bindings : [];
  const normalized = list
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => !!x)
    .map((x) => ({
      variableKey: String(x.variableKey ?? x.variable_key ?? "").trim(),
      sourceMode: (String(x.sourceMode ?? x.source_mode ?? "registry_default").trim() as "registry_default" | "custom_path" | "fixed_value"),
      sourcePath: typeof (x.sourcePath ?? x.source_path) === "string" ? String(x.sourcePath ?? x.source_path).trim() || null : null,
      fixedValue: typeof (x.fixedValue ?? x.fixed_value) === "string" ? String(x.fixedValue ?? x.fixed_value) : null,
      formatterOverride: typeof (x.formatterOverride ?? x.formatter_override) === "string" ? String(x.formatterOverride ?? x.formatter_override).trim() || null : null,
      isRequired: Boolean(x.isRequired ?? x.is_required ?? false),
      fallbackValue: typeof (x.fallbackValue ?? x.fallback_value) === "string" ? String(x.fallbackValue ?? x.fallback_value) : null,
      notes: typeof x.notes === "string" ? x.notes : null,
    }))
    .filter((b) => b.variableKey.length > 0);

  const result = await withAuthSafeDb(async (authDb) => {
    const doc = await queryRows(authDb, sql`SELECT id FROM platform_documents WHERE id = ${documentId}`);
    if (!doc[0]) return { status: 404 as const, body: { error: "Document not found" } };
    await replacePlatformDocumentBindings(authDb, null, documentId, normalized);
    await writeAuditLog({ actorId: req.userId, actorType: req.userType, action: "documents.template.bindings.update", entityType: "platform_document", entityId: documentId, detail: `scope=global count=${normalized.length}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb });
    const bindings = await getPlatformDocumentBindings(authDb, null, documentId);
    return { status: 200 as const, body: { bindings } };
  }, { retry: true, ctx: { route: req.path, stage: "platform_document_bindings.put", userId: req.userId ?? null, firmId: null } });
  res.status(result.status).json(result.body);
});

router.get("/document-templates/:templateId/applicability", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const tplRows = await queryRows(r, sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
  const tpl = tplRows[0];
  if (!tpl) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const rules = await getFirmTemplateApplicabilityRules(r, req.firmId!, templateId);
  res.json({
    template: tpl,
    rules,
    effective: {
      isActive: rules?.isActive ?? Boolean((tpl as any).is_active ?? true),
      isRequired: rules?.isRequired ?? false,
      purchaseMode: rules?.purchaseMode ?? ((tpl as any).applies_to_purchase_mode ?? null),
      titleType: rules?.titleType ?? ((tpl as any).applies_to_title_type ?? "any"),
      caseType: (tpl as any).applies_to_case_type ?? null,
      projectType: rules?.projectType ?? null,
      titleSubType: rules?.titleSubType ?? null,
      developmentCondition: rules?.developmentCondition ?? null,
      unitCategory: rules?.unitCategory ?? null,
      isTemplateCapable: rules?.isTemplateCapable ?? Boolean((tpl as any).is_template_capable ?? true),
      applicabilityMode: typeof (tpl as any).applicability_mode === "string" ? String((tpl as any).applicability_mode) : "universal",
      applicabilityRules: (tpl as any).applicability_rules ?? null,
      checklistMode: typeof (tpl as any).checklist_mode === "string" ? String((tpl as any).checklist_mode) : "off",
      checklistItems: (tpl as any).checklist_items ?? null,
    },
  });
});

router.put("/document-templates/:templateId/applicability", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const tplRows = await queryRows(r, sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
  const tpl = tplRows[0];
  if (!tpl) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const isActive = Object.prototype.hasOwnProperty.call(body, "isActive") ? Boolean(body.isActive) : undefined;
  const isRequired = Object.prototype.hasOwnProperty.call(body, "isRequired") ? Boolean(body.isRequired) : undefined;
  const purchaseMode = typeof body.purchaseMode === "string" ? body.purchaseMode : undefined;
  const titleType = typeof body.titleType === "string" ? body.titleType : undefined;
  const caseType = typeof body.caseType === "string" ? body.caseType : undefined;
  const projectType = typeof body.projectType === "string" ? body.projectType : undefined;
  const titleSubType = typeof body.titleSubType === "string" ? body.titleSubType : undefined;
  const developmentCondition = typeof body.developmentCondition === "string" ? body.developmentCondition : undefined;
  const unitCategory = typeof body.unitCategory === "string" ? body.unitCategory : undefined;
  const isTemplateCapable = Object.prototype.hasOwnProperty.call(body, "isTemplateCapable") ? Boolean(body.isTemplateCapable) : undefined;
  const applicabilityMode = typeof body.applicabilityMode === "string" ? body.applicabilityMode : undefined;
  const applicabilityRules = Object.prototype.hasOwnProperty.call(body, "applicabilityRules")
    ? (body.applicabilityRules && typeof body.applicabilityRules === "object" ? body.applicabilityRules : null)
    : undefined;
  const checklistMode = typeof body.checklistMode === "string" ? body.checklistMode : undefined;
  const checklistItems = Object.prototype.hasOwnProperty.call(body, "checklistItems")
    ? (Array.isArray(body.checklistItems) ? body.checklistItems : body.checklistItems === null ? null : undefined)
    : undefined;

  await queryRows(r, sql`
    UPDATE document_templates
    SET
      is_active = COALESCE(${isActive as any}, is_active),
      applies_to_purchase_mode = COALESCE(${purchaseMode ?? null}, applies_to_purchase_mode),
      applies_to_title_type = COALESCE(${titleType ?? null}, applies_to_title_type),
      applies_to_case_type = COALESCE(${caseType ?? null}, applies_to_case_type),
      is_template_capable = COALESCE(${isTemplateCapable as any}, is_template_capable),
      applicability_mode = COALESCE(${applicabilityMode ?? null}, applicability_mode),
      applicability_rules = COALESCE(${applicabilityRules as any}, applicability_rules),
      checklist_mode = COALESCE(${checklistMode ?? null}, checklist_mode),
      checklist_items = COALESCE(${checklistItems as any}, checklist_items),
      updated_at = now()
    WHERE id = ${templateId} AND firm_id = ${req.firmId!}
  `);

  await upsertFirmTemplateApplicabilityRules(r, req.firmId!, templateId, {
    isActive: isActive ?? null,
    isRequired: isRequired ?? null,
    purchaseMode: purchaseMode ?? null,
    titleType: titleType ?? null,
    titleSubType: titleSubType ?? null,
    projectType: projectType ?? null,
    developmentCondition: developmentCondition ?? null,
    unitCategory: unitCategory ?? null,
    isTemplateCapable: isTemplateCapable ?? null,
  });

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.template.applicability.update", entityType: "document_template", entityId: templateId, detail: `updated mode=${applicabilityMode ?? "unchanged"} rules=${applicabilityRules ? "yes" : "no"} checklistMode=${checklistMode ?? "unchanged"} checklistItems=${checklistItems ? "set" : "nochange"}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  const rules = await getFirmTemplateApplicabilityRules(r, req.firmId!, templateId);
  res.json({ ok: true, rules });
});

router.get("/platform/documents/:documentId/applicability", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const documentIdStr = one((req.params as any).documentId);
  const documentId = documentIdStr ? parseInt(documentIdStr, 10) : NaN;
  if (Number.isNaN(documentId)) {
    res.status(400).json({ error: "Invalid document ID" });
    return;
  }
  const result = await withAuthSafeDb(async (authDb) => {
    const doc = await queryRows(authDb, sql`SELECT * FROM platform_documents WHERE id = ${documentId}`);
    if (!doc[0]) return { status: 404 as const, body: { error: "Document not found" } };
    const rules = await getPlatformDocumentApplicabilityRules(authDb, null, documentId);
    return {
      status: 200 as const,
      body: {
        document: doc[0],
        rules,
        effective: {
          isActive: rules?.isActive ?? Boolean((doc[0] as any).is_active ?? true),
          isRequired: rules?.isRequired ?? false,
          purchaseMode: rules?.purchaseMode ?? ((doc[0] as any).applies_to_purchase_mode ?? null),
          titleType: rules?.titleType ?? ((doc[0] as any).applies_to_title_type ?? "any"),
          caseType: (doc[0] as any).applies_to_case_type ?? null,
          projectType: rules?.projectType ?? null,
          titleSubType: rules?.titleSubType ?? null,
          developmentCondition: rules?.developmentCondition ?? null,
          unitCategory: rules?.unitCategory ?? null,
          isTemplateCapable: rules?.isTemplateCapable ?? Boolean((doc[0] as any).is_template_capable ?? true),
          applicabilityMode: typeof (doc[0] as any).applicability_mode === "string" ? String((doc[0] as any).applicability_mode) : "universal",
          applicabilityRules: (doc[0] as any).applicability_rules ?? null,
          checklistMode: typeof (doc[0] as any).checklist_mode === "string" ? String((doc[0] as any).checklist_mode) : "off",
          checklistItems: (doc[0] as any).checklist_items ?? null,
        },
      },
    };
  }, { retry: true, ctx: { route: req.path, stage: "platform_document_applicability.get", userId: req.userId ?? null, firmId: null } });
  res.status(result.status).json(result.body);
});

router.put("/platform/documents/:documentId/applicability", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const documentIdStr = one((req.params as any).documentId);
  const documentId = documentIdStr ? parseInt(documentIdStr, 10) : NaN;
  if (Number.isNaN(documentId)) {
    res.status(400).json({ error: "Invalid document ID" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const isActive = Object.prototype.hasOwnProperty.call(body, "isActive") ? Boolean(body.isActive) : undefined;
  const isRequired = Object.prototype.hasOwnProperty.call(body, "isRequired") ? Boolean(body.isRequired) : undefined;
  const purchaseMode = typeof body.purchaseMode === "string" ? body.purchaseMode : undefined;
  const titleType = typeof body.titleType === "string" ? body.titleType : undefined;
  const caseType = typeof body.caseType === "string" ? body.caseType : undefined;
  const projectType = typeof body.projectType === "string" ? body.projectType : undefined;
  const titleSubType = typeof body.titleSubType === "string" ? body.titleSubType : undefined;
  const developmentCondition = typeof body.developmentCondition === "string" ? body.developmentCondition : undefined;
  const unitCategory = typeof body.unitCategory === "string" ? body.unitCategory : undefined;
  const isTemplateCapable = Object.prototype.hasOwnProperty.call(body, "isTemplateCapable") ? Boolean(body.isTemplateCapable) : undefined;
  const applicabilityMode = typeof body.applicabilityMode === "string" ? body.applicabilityMode : undefined;
  const applicabilityRules = Object.prototype.hasOwnProperty.call(body, "applicabilityRules")
    ? (body.applicabilityRules && typeof body.applicabilityRules === "object" ? body.applicabilityRules : null)
    : undefined;
  const checklistMode = typeof body.checklistMode === "string" ? body.checklistMode : undefined;
  const checklistItems = Object.prototype.hasOwnProperty.call(body, "checklistItems")
    ? (Array.isArray(body.checklistItems) ? body.checklistItems : body.checklistItems === null ? null : undefined)
    : undefined;

  const result = await withAuthSafeDb(async (authDb) => {
    const doc = await queryRows(authDb, sql`SELECT * FROM platform_documents WHERE id = ${documentId}`);
    if (!doc[0]) return { status: 404 as const, body: { error: "Document not found" } };
    await queryRows(authDb, sql`
      UPDATE platform_documents
      SET
        is_active = COALESCE(${isActive as any}, is_active),
        applies_to_purchase_mode = COALESCE(${purchaseMode ?? null}, applies_to_purchase_mode),
        applies_to_title_type = COALESCE(${titleType ?? null}, applies_to_title_type),
        applies_to_case_type = COALESCE(${caseType ?? null}, applies_to_case_type),
        is_template_capable = COALESCE(${isTemplateCapable as any}, is_template_capable),
        applicability_mode = COALESCE(${applicabilityMode ?? null}, applicability_mode),
        applicability_rules = COALESCE(${applicabilityRules as any}, applicability_rules),
        checklist_mode = COALESCE(${checklistMode ?? null}, checklist_mode),
        checklist_items = COALESCE(${checklistItems as any}, checklist_items)
      WHERE id = ${documentId}
    `);
    await upsertPlatformDocumentApplicabilityRules(authDb, null, documentId, {
      isActive: isActive ?? null,
      isRequired: isRequired ?? null,
      purchaseMode: purchaseMode ?? null,
      titleType: titleType ?? null,
      titleSubType: titleSubType ?? null,
      projectType: projectType ?? null,
      developmentCondition: developmentCondition ?? null,
      unitCategory: unitCategory ?? null,
      isTemplateCapable: isTemplateCapable ?? null,
    });
    await writeAuditLog({ actorId: req.userId, actorType: req.userType, action: "documents.template.applicability.update", entityType: "platform_document", entityId: documentId, detail: `scope=global updated mode=${applicabilityMode ?? "unchanged"} rules=${applicabilityRules ? "yes" : "no"} checklistMode=${checklistMode ?? "unchanged"} checklistItems=${checklistItems ? "set" : "nochange"}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb });
    const rules = await getPlatformDocumentApplicabilityRules(authDb, null, documentId);
    return { status: 200 as const, body: { ok: true, rules } };
  }, { retry: true, ctx: { route: req.path, stage: "platform_document_applicability.put", userId: req.userId ?? null, firmId: null } });
  res.status(result.status).json(result.body);
});

router.get("/document-templates/:templateId/versions", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }

  const tplRows = await queryRows(r, sql`SELECT id FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
  if (!tplRows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const rows = await queryRows(r, sql`
    SELECT
      v.*,
      cu.name AS created_by_name,
      pu.name AS published_by_name,
      au.name AS archived_by_name
    FROM document_template_versions v
    LEFT JOIN users cu ON cu.id = v.created_by
    LEFT JOIN users pu ON pu.id = v.published_by
    LEFT JOIN users au ON au.id = v.archived_by
    WHERE v.firm_id = ${req.firmId!} AND v.template_id = ${templateId}
    ORDER BY v.version_no DESC
  `);
  res.json(rows);
});

router.post("/document-templates/:templateId/versions", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const objectPath = typeof body.objectPath === "string" ? body.objectPath.trim() : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim() : null;
  const patch = (body.patch && typeof body.patch === "object") ? (body.patch as Record<string, unknown>) : {};

  const tplRows = await queryRows(r, sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
  const tpl = tplRows[0];
  if (!tpl) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const effectiveObjectPath = objectPath || String((tpl as any).object_path ?? "");
  const effectiveFileName = fileName || String((tpl as any).file_name ?? "");
  if (!effectiveObjectPath || !effectiveFileName) {
    res.status(422).json({ error: "Missing template file", code: "TEMPLATE_FILE_MISSING" });
    return;
  }

  const maxRows = await queryRows(r, sql`SELECT COALESCE(MAX(version_no), 0) AS max_no FROM document_template_versions WHERE firm_id = ${req.firmId!} AND template_id = ${templateId}`);
  const maxNo = Number((maxRows[0] as any)?.max_no ?? 0) || 0;
  const nextNo = maxNo + 1;

  const ext = fileExtensionFromName(effectiveFileName);
  let variablesSnapshot: unknown = null;
  if (ext === "docx") {
    try {
      const bytes = await downloadPrivateObjectBytes(effectiveObjectPath);
      variablesSnapshot = { keys: detectDocxVariables(bytes) };
    } catch (err) {
      const cfgErr = getSupabaseStorageConfigError(err);
      if (cfgErr) {
        res.status(cfgErr.statusCode).json({ error: cfgErr.error });
        return;
      }
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Template file not found", code: "TEMPLATE_FILE_NOT_FOUND" });
        return;
      }
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, templateId }, "[documents] detect_variables_failed");
    }
  }

  const isActive = Object.prototype.hasOwnProperty.call(patch, "isActive") ? Boolean(patch.isActive) : Boolean((tpl as any).is_active ?? true);
  const appliesToPurchaseMode = Object.prototype.hasOwnProperty.call(patch, "appliesToPurchaseMode")
    ? (typeof patch.appliesToPurchaseMode === "string" ? patch.appliesToPurchaseMode : null)
    : ((tpl as any).applies_to_purchase_mode ? String((tpl as any).applies_to_purchase_mode) : null);
  const appliesToTitleType = Object.prototype.hasOwnProperty.call(patch, "appliesToTitleType")
    ? (typeof patch.appliesToTitleType === "string" ? patch.appliesToTitleType : "any")
    : String((tpl as any).applies_to_title_type ?? "any");
  const appliesToCaseType = Object.prototype.hasOwnProperty.call(patch, "appliesToCaseType")
    ? (typeof patch.appliesToCaseType === "string" ? patch.appliesToCaseType : null)
    : ((tpl as any).applies_to_case_type ? String((tpl as any).applies_to_case_type) : null);
  const documentGroup = Object.prototype.hasOwnProperty.call(patch, "documentGroup")
    ? (typeof patch.documentGroup === "string" ? patch.documentGroup : "Others")
    : String((tpl as any).document_group ?? "Others");

  const rows = await queryRows(r, sql`
    INSERT INTO document_template_versions (
      firm_id, template_id, version_no, status,
      source_object_path, filename, mime_type,
      template_kind, category, document_group,
      variables_snapshot, pdf_mappings_snapshot, applicability_rules_snapshot, readiness_rules_snapshot,
      created_by
    )
    VALUES (
      ${req.firmId!}, ${templateId}, ${nextNo}, 'draft',
      ${effectiveObjectPath}, ${effectiveFileName}, ${mimeType},
      ${String((tpl as any).kind ?? "template")}, ${String((tpl as any).document_type ?? "other")}, ${documentGroup},
      ${variablesSnapshot as any}, ${null as any},
      ${{
        applies_to_purchase_mode: appliesToPurchaseMode,
        applies_to_title_type: appliesToTitleType,
        applies_to_case_type: appliesToCaseType,
        is_active: isActive,
      } as any},
      ${{ document_group: documentGroup } as any},
      ${req.userId!}
    )
    RETURNING *
  `);
  const created = rows[0];
  const versionId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : undefined;
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.template_version.create", entityType: "document_template_version", entityId: versionId, detail: `templateId=${templateId} versionNo=${nextNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(created);
});

router.post("/document-templates/:templateId/versions/:versionId/publish", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const versionIdStr = one((req.params as any).versionId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  const versionId = versionIdStr ? parseInt(versionIdStr, 10) : NaN;
  if (Number.isNaN(templateId) || Number.isNaN(versionId)) {
    res.status(400).json({ error: "Invalid template/version ID" });
    return;
  }

  const rows = await queryRows(r, sql`
    SELECT * FROM document_template_versions
    WHERE id = ${versionId} AND firm_id = ${req.firmId!} AND template_id = ${templateId}
  `);
  const v = rows[0];
  if (!v) {
    res.status(404).json({ error: "Version not found" });
    return;
  }
  if (String((v as any).status ?? "") === "archived") {
    res.status(409).json({ error: "Version is archived", code: "VERSION_ARCHIVED" });
    return;
  }

  await queryRows(r, sql`
    UPDATE document_template_versions
    SET status = 'archived', archived_by = ${req.userId!}, archived_at = now()
    WHERE firm_id = ${req.firmId!} AND template_id = ${templateId}
      AND status = 'published' AND id <> ${versionId}
  `);

  const publishedRows = await queryRows(r, sql`
    UPDATE document_template_versions
    SET status = 'published', published_by = ${req.userId!}, published_at = now()
    WHERE id = ${versionId} AND firm_id = ${req.firmId!} AND template_id = ${templateId}
    RETURNING *
  `);
  const published = publishedRows[0] ?? v;

  const app = (published as any).applicability_rules_snapshot ?? {};
  const purchaseMode = typeof app.applies_to_purchase_mode === "string" ? app.applies_to_purchase_mode : null;
  const titleType = typeof app.applies_to_title_type === "string" ? app.applies_to_title_type : "any";
  const caseType = typeof app.applies_to_case_type === "string" ? app.applies_to_case_type : null;
  const isActive = typeof app.is_active === "boolean" ? app.is_active : true;
  const fileName = String((published as any).filename ?? "");
  const objectPath = String((published as any).source_object_path ?? "");
  const ext = fileExtensionFromName(fileName);

  const updatedTplRows = await queryRows(r, sql`
    UPDATE document_templates
    SET object_path = ${objectPath},
        file_name = ${fileName},
        mime_type = ${((published as any).mime_type ?? null) as any},
        extension = ${ext || null},
        kind = ${String((published as any).template_kind ?? (published as any).kind ?? "template")},
        document_type = ${String((published as any).category ?? (published as any).document_type ?? "other")},
        document_group = ${String((published as any).document_group ?? "Others")},
        is_active = ${isActive},
        applies_to_purchase_mode = ${purchaseMode},
        applies_to_title_type = ${titleType},
        applies_to_case_type = ${caseType},
        updated_at = now()
    WHERE id = ${templateId} AND firm_id = ${req.firmId!}
    RETURNING *
  `);
  if (!updatedTplRows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.template_version.publish", entityType: "document_template_version", entityId: versionId, detail: `templateId=${templateId} versionNo=${(published as any).version_no ?? ""}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ version: published, template: updatedTplRows[0] });
});

router.post("/document-templates/:templateId/versions/:versionId/restore", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const versionIdStr = one((req.params as any).versionId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  const versionId = versionIdStr ? parseInt(versionIdStr, 10) : NaN;
  if (Number.isNaN(templateId) || Number.isNaN(versionId)) {
    res.status(400).json({ error: "Invalid template/version ID" });
    return;
  }

  const rows = await queryRows(r, sql`
    SELECT * FROM document_template_versions
    WHERE id = ${versionId} AND firm_id = ${req.firmId!} AND template_id = ${templateId}
  `);
  const src = rows[0];
  if (!src) {
    res.status(404).json({ error: "Version not found" });
    return;
  }

  const maxRows = await queryRows(r, sql`SELECT COALESCE(MAX(version_no), 0) AS max_no FROM document_template_versions WHERE firm_id = ${req.firmId!} AND template_id = ${templateId}`);
  const maxNo = Number((maxRows[0] as any)?.max_no ?? 0) || 0;
  const nextNo = maxNo + 1;

  const insertedRows = await queryRows(r, sql`
    INSERT INTO document_template_versions (
      firm_id, template_id, version_no, status,
      source_object_path, filename, mime_type,
      template_kind, category, document_group,
      variables_snapshot, pdf_mappings_snapshot, applicability_rules_snapshot, readiness_rules_snapshot,
      created_by
    )
    VALUES (
      ${req.firmId!}, ${templateId}, ${nextNo}, 'draft',
      ${String((src as any).source_object_path ?? "")}, ${String((src as any).filename ?? "")}, ${((src as any).mime_type ?? null) as any},
      ${String((src as any).template_kind ?? "")}, ${String((src as any).category ?? "")}, ${String((src as any).document_group ?? "")},
      ${((src as any).variables_snapshot ?? null) as any}, ${((src as any).pdf_mappings_snapshot ?? null) as any},
      ${((src as any).applicability_rules_snapshot ?? null) as any}, ${((src as any).readiness_rules_snapshot ?? null) as any},
      ${req.userId!}
    )
    RETURNING *
  `);
  const created = insertedRows[0];
  const newId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : undefined;
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.template_version.restore", entityType: "document_template_version", entityId: newId, detail: `templateId=${templateId} restoredFrom=${versionId} newVersionNo=${nextNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(created);
});

router.post("/document-templates/:templateId/versions/:versionId/archive", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const versionIdStr = one((req.params as any).versionId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  const versionId = versionIdStr ? parseInt(versionIdStr, 10) : NaN;
  if (Number.isNaN(templateId) || Number.isNaN(versionId)) {
    res.status(400).json({ error: "Invalid template/version ID" });
    return;
  }

  const rows = await queryRows(r, sql`
    UPDATE document_template_versions
    SET status = 'archived', archived_by = ${req.userId!}, archived_at = now()
    WHERE id = ${versionId} AND firm_id = ${req.firmId!} AND template_id = ${templateId}
    RETURNING *
  `);
  if (!rows[0]) {
    res.status(404).json({ error: "Version not found" });
    return;
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.template_version.archive", entityType: "document_template_version", entityId: versionId, detail: `templateId=${templateId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(rows[0]);
});

router.get("/document-templates/:templateId/download", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }

  const rows = await queryRows(
    r,
    sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`
  );
  const doc = rows[0];
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const objectPath = typeof (doc as any).object_path === "string" ? String((doc as any).object_path) : "";
  if (!objectPath) {
    res.status(404).json({ error: "File missing" });
    return;
  }

  try {
    const fileName = typeof (doc as any).file_name === "string" ? String((doc as any).file_name) : `document-${templateId}`;
    const fallbackContentType =
      typeof (doc as any).mime_type === "string"
        ? String((doc as any).mime_type)
        : "application/octet-stream";
    await streamSupabasePrivateObjectToResponse({ objectPath, res, fileName, fallbackContentType });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_document.download", entityType: "firm_document", entityId: templateId, detail: `fileName=${fileName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  } catch (err) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, templateId }, "[documents] supabase_storage_not_configured");
      res.status(cfgErr.statusCode).json({ error: cfgErr.error });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, templateId }, "[documents] download_failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/document-templates/:templateId", requireAuth, requireFirmUser, requirePermission("documents", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const templateIdStr = one((req.params as any).templateId);
  const templateId = templateIdStr ? parseInt(templateIdStr, 10) : NaN;
  if (Number.isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template ID" });
    return;
  }
  const rows = await queryRows(
    r,
    sql`DELETE FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!} RETURNING *`
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const deleted = rows[0];
  const deletedId = deleted && typeof deleted === "object" && "id" in deleted && typeof (deleted as { id?: unknown }).id === "number"
    ? (deleted as { id: number }).id
    : templateId;
  const deletedName = deleted && typeof deleted === "object" && "name" in deleted ? String((deleted as { name?: unknown }).name) : undefined;
  const deletedObjectPath = deleted && typeof deleted === "object" && "object_path" in deleted ? String((deleted as any).object_path) : undefined;
  if (deletedObjectPath) {
    try {
      await supabaseStorage.deletePrivateObject(deletedObjectPath);
    } catch {}
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_document.delete", entityType: "firm_document", entityId: deletedId, detail: deletedName ? `name=${deletedName}` : undefined, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

router.get("/firm-letterheads", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const rows = await queryRows(
    r,
    sql`SELECT * FROM firm_letterheads WHERE firm_id = ${req.firmId!} ORDER BY is_default DESC, created_at DESC`
  );
  res.json(rows);
});

router.post("/firm-letterheads", requireAuth, requireFirmUser, requirePermission("documents", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const body = req.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : null;
  const footerMode = typeof body.footerMode === "string" ? body.footerMode : "every_page";
  const status = typeof body.status === "string" ? body.status : "active";
  const isDefault = body.isDefault === true;

  const firstPageObjectPath = typeof body.firstPageObjectPath === "string" ? body.firstPageObjectPath : "";
  const firstPageFileName = typeof body.firstPageFileName === "string" ? body.firstPageFileName : "";
  const firstPageMimeType = typeof body.firstPageMimeType === "string" ? body.firstPageMimeType : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const firstPageExtension = typeof body.firstPageExtension === "string" ? body.firstPageExtension : "docx";
  const firstPageFileSize = typeof body.firstPageFileSize === "number" ? body.firstPageFileSize : null;

  const continuationHeaderObjectPath = typeof body.continuationHeaderObjectPath === "string" ? body.continuationHeaderObjectPath : "";
  const continuationHeaderFileName = typeof body.continuationHeaderFileName === "string" ? body.continuationHeaderFileName : "";
  const continuationHeaderMimeType = typeof body.continuationHeaderMimeType === "string" ? body.continuationHeaderMimeType : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const continuationHeaderExtension = typeof body.continuationHeaderExtension === "string" ? body.continuationHeaderExtension : "docx";
  const continuationHeaderFileSize = typeof body.continuationHeaderFileSize === "number" ? body.continuationHeaderFileSize : null;

  const footerObjectPath = typeof body.footerObjectPath === "string" ? body.footerObjectPath : null;
  const footerFileName = typeof body.footerFileName === "string" ? body.footerFileName : null;
  const footerMimeType = typeof body.footerMimeType === "string" ? body.footerMimeType : null;
  const footerExtension = typeof body.footerExtension === "string" ? body.footerExtension : null;
  const footerFileSize = typeof body.footerFileSize === "number" ? body.footerFileSize : null;

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!firstPageObjectPath || !firstPageFileName) {
    res.status(400).json({ error: "firstPage template is required" });
    return;
  }
  if (!continuationHeaderObjectPath || !continuationHeaderFileName) {
    res.status(400).json({ error: "continuationHeader template is required" });
    return;
  }
  if (firstPageExtension.toLowerCase() !== "docx" || continuationHeaderExtension.toLowerCase() !== "docx" || (footerExtension && footerExtension.toLowerCase() !== "docx")) {
    res.status(400).json({ error: "Letterhead templates must be .docx" });
    return;
  }
  if (footerMode !== "every_page" && footerMode !== "last_page_only") {
    res.status(400).json({ error: "Invalid footerMode" });
    return;
  }
  if (status !== "active" && status !== "inactive") {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  try {
    if (isDefault) {
      await queryRows(r, sql`UPDATE firm_letterheads SET is_default = false, updated_at = now() WHERE firm_id = ${req.firmId!}`);
    }
    const rows = await queryRows(
      r,
      sql`INSERT INTO firm_letterheads (
            firm_id, name, description, is_default, status, footer_mode,
            first_page_object_path, first_page_file_name, first_page_mime_type, first_page_extension, first_page_file_size,
            continuation_header_object_path, continuation_header_file_name, continuation_header_mime_type, continuation_header_extension, continuation_header_file_size,
            footer_object_path, footer_file_name, footer_mime_type, footer_extension, footer_file_size,
            created_by
          ) VALUES (
            ${req.firmId!}, ${name}, ${description}, ${isDefault}, ${status}, ${footerMode},
            ${firstPageObjectPath}, ${firstPageFileName}, ${firstPageMimeType}, ${firstPageExtension}, ${firstPageFileSize},
            ${continuationHeaderObjectPath}, ${continuationHeaderFileName}, ${continuationHeaderMimeType}, ${continuationHeaderExtension}, ${continuationHeaderFileSize},
            ${footerObjectPath}, ${footerFileName}, ${footerMimeType}, ${footerExtension}, ${footerFileSize},
            ${req.userId!}
          ) RETURNING *`
    );
    const created = rows[0];
    const createdId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : undefined;
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.letterhead.create", entityType: "firm_letterhead", entityId: createdId, detail: `name=${name} default=${isDefault}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Default letterhead already exists", code: "DUPLICATE_DEFAULT" });
      return;
    }
    res.status(500).json({ error: "Failed to create letterhead" });
  }
});

router.patch("/firm-letterheads/:letterheadId", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const letterheadIdStr = one((req.params as any).letterheadId);
  const letterheadId = letterheadIdStr ? parseInt(letterheadIdStr, 10) : NaN;
  if (Number.isNaN(letterheadId)) {
    res.status(400).json({ error: "Invalid letterhead ID" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const hasFooterPatch =
    Object.prototype.hasOwnProperty.call(body, "footerObjectPath") ||
    Object.prototype.hasOwnProperty.call(body, "footerFileName") ||
    Object.prototype.hasOwnProperty.call(body, "footerMimeType") ||
    Object.prototype.hasOwnProperty.call(body, "footerExtension") ||
    Object.prototype.hasOwnProperty.call(body, "footerFileSize");

  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const descriptionVal: string | null | undefined =
    hasDescription
      ? (typeof body.description === "string" ? String(body.description).trim() : body.description === null ? null : undefined)
      : undefined;
  if (hasDescription && descriptionVal === undefined) {
    res.status(400).json({ error: "Invalid description" });
    return;
  }
  const status = typeof body.status === "string" ? body.status : undefined;
  const footerMode = typeof body.footerMode === "string" ? body.footerMode : undefined;
  const firstPageObjectPath = typeof body.firstPageObjectPath === "string" ? body.firstPageObjectPath : undefined;
  const firstPageFileName = typeof body.firstPageFileName === "string" ? body.firstPageFileName : undefined;
  const firstPageMimeType = typeof body.firstPageMimeType === "string" ? body.firstPageMimeType : undefined;
  const firstPageExtension = typeof body.firstPageExtension === "string" ? body.firstPageExtension : undefined;
  const firstPageFileSize = typeof body.firstPageFileSize === "number" ? body.firstPageFileSize : undefined;

  const continuationHeaderObjectPath = typeof body.continuationHeaderObjectPath === "string" ? body.continuationHeaderObjectPath : undefined;
  const continuationHeaderFileName = typeof body.continuationHeaderFileName === "string" ? body.continuationHeaderFileName : undefined;
  const continuationHeaderMimeType = typeof body.continuationHeaderMimeType === "string" ? body.continuationHeaderMimeType : undefined;
  const continuationHeaderExtension = typeof body.continuationHeaderExtension === "string" ? body.continuationHeaderExtension : undefined;
  const continuationHeaderFileSize = typeof body.continuationHeaderFileSize === "number" ? body.continuationHeaderFileSize : undefined;

  const footerObjectPath: string | null | undefined =
    hasFooterPatch
      ? (body.footerObjectPath === null ? null : typeof body.footerObjectPath === "string" ? String(body.footerObjectPath) : undefined)
      : undefined;
  const footerFileName: string | null | undefined =
    hasFooterPatch
      ? (body.footerFileName === null ? null : typeof body.footerFileName === "string" ? String(body.footerFileName) : undefined)
      : undefined;
  const footerMimeType: string | null | undefined =
    hasFooterPatch
      ? (body.footerMimeType === null ? null : typeof body.footerMimeType === "string" ? String(body.footerMimeType) : undefined)
      : undefined;
  const footerExtension: string | null | undefined =
    hasFooterPatch
      ? (body.footerExtension === null ? null : typeof body.footerExtension === "string" ? String(body.footerExtension) : undefined)
      : undefined;
  const footerFileSize = typeof body.footerFileSize === "number" ? body.footerFileSize : undefined;
  if (status && status !== "active" && status !== "inactive") {
    res.status(400).json({ error: "Invalid status" });
    return;
  }
  if (footerMode && footerMode !== "every_page" && footerMode !== "last_page_only") {
    res.status(400).json({ error: "Invalid footerMode" });
    return;
  }

  const existingRows = await queryRows(
    r,
    sql`SELECT * FROM firm_letterheads WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}`
  );
  const existing = existingRows[0];
  if (!existing) {
    res.status(404).json({ error: "Letterhead not found" });
    return;
  }
  const isDefault = Boolean((existing as any).is_default);
  if (isDefault && status === "inactive") {
    res.status(409).json({ error: "Cannot set default letterhead to inactive. Set another default first.", code: "DEFAULT_INACTIVE_FORBIDDEN" });
    return;
  }
  if ((firstPageObjectPath || firstPageFileName || firstPageExtension) && (!firstPageObjectPath || !firstPageFileName)) {
    res.status(400).json({ error: "firstPageObjectPath and firstPageFileName are required to replace first page template" });
    return;
  }
  if ((continuationHeaderObjectPath || continuationHeaderFileName || continuationHeaderExtension) && (!continuationHeaderObjectPath || !continuationHeaderFileName)) {
    res.status(400).json({ error: "continuationHeaderObjectPath and continuationHeaderFileName are required to replace continuation header template" });
    return;
  }
  if (hasFooterPatch) {
    if (footerObjectPath === undefined) {
      res.status(400).json({ error: "footerObjectPath must be provided when updating footer template (use null to remove)" });
      return;
    }
    if (footerObjectPath !== null && !footerFileName) {
      res.status(400).json({ error: "footerFileName is required to replace footer template" });
      return;
    }
  }
  const firstExt = (firstPageExtension ?? "docx").toLowerCase();
  const contExt = (continuationHeaderExtension ?? "docx").toLowerCase();
  const footerExt = footerExtension === null ? null : (footerExtension ?? undefined)?.toLowerCase();
  if ((firstPageObjectPath && firstExt !== "docx") || (continuationHeaderObjectPath && contExt !== "docx") || (footerObjectPath && footerExt && footerExt !== "docx")) {
    res.status(400).json({ error: "Letterhead templates must be .docx" });
    return;
  }

  const footerObjectPathSql = footerObjectPath === undefined ? null : footerObjectPath;
  const footerFileNameSql = footerObjectPath === null ? null : footerFileName === undefined ? null : footerFileName;
  const footerMimeTypeSql = footerObjectPath === null ? null : footerMimeType === undefined ? null : footerMimeType;
  const footerExtensionSql = footerObjectPath === null ? null : footerExtension === undefined ? null : footerExtension;
  const footerFileSizeSql = footerObjectPath === null ? null : footerFileSize ?? null;

  const rows = await queryRows(
    r,
    sql`UPDATE firm_letterheads
        SET name = COALESCE(${name ?? null}, name),
            description = CASE WHEN ${hasDescription} THEN ${descriptionVal ?? null} ELSE description END,
            status = COALESCE(${status ?? null}, status),
            footer_mode = COALESCE(${footerMode ?? null}, footer_mode),
            first_page_object_path = COALESCE(${firstPageObjectPath ?? null}, first_page_object_path),
            first_page_file_name = COALESCE(${firstPageFileName ?? null}, first_page_file_name),
            first_page_mime_type = COALESCE(${firstPageMimeType ?? null}, first_page_mime_type),
            first_page_extension = COALESCE(${firstPageExtension ?? null}, first_page_extension),
            first_page_file_size = COALESCE(${firstPageFileSize ?? null}, first_page_file_size),
            continuation_header_object_path = COALESCE(${continuationHeaderObjectPath ?? null}, continuation_header_object_path),
            continuation_header_file_name = COALESCE(${continuationHeaderFileName ?? null}, continuation_header_file_name),
            continuation_header_mime_type = COALESCE(${continuationHeaderMimeType ?? null}, continuation_header_mime_type),
            continuation_header_extension = COALESCE(${continuationHeaderExtension ?? null}, continuation_header_extension),
            continuation_header_file_size = COALESCE(${continuationHeaderFileSize ?? null}, continuation_header_file_size),
            footer_object_path = CASE WHEN ${hasFooterPatch} THEN ${footerObjectPathSql} ELSE footer_object_path END,
            footer_file_name = CASE WHEN ${hasFooterPatch} THEN ${footerFileNameSql} ELSE footer_file_name END,
            footer_mime_type = CASE WHEN ${hasFooterPatch} THEN ${footerMimeTypeSql} ELSE footer_mime_type END,
            footer_extension = CASE WHEN ${hasFooterPatch} THEN ${footerExtensionSql} ELSE footer_extension END,
            footer_file_size = CASE WHEN ${hasFooterPatch} THEN ${footerFileSizeSql} ELSE footer_file_size END,
            updated_at = now()
        WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}
        RETURNING *`
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Letterhead not found" });
    return;
  }
  const oldPaths: string[] = [];
  if (firstPageObjectPath && (existing as any).first_page_object_path) oldPaths.push(String((existing as any).first_page_object_path));
  if (continuationHeaderObjectPath && (existing as any).continuation_header_object_path) oldPaths.push(String((existing as any).continuation_header_object_path));
  if (footerObjectPath && (existing as any).footer_object_path) oldPaths.push(String((existing as any).footer_object_path));
  if (footerObjectPath === null && (existing as any).footer_object_path) oldPaths.push(String((existing as any).footer_object_path));
  for (const p of oldPaths) {
    try { await supabaseStorage.deletePrivateObject(p); } catch {}
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.letterhead.update", entityType: "firm_letterhead", entityId: letterheadId, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(rows[0]);
});

router.post("/firm-letterheads/:letterheadId/set-default", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const letterheadIdStr = one((req.params as any).letterheadId);
  const letterheadId = letterheadIdStr ? parseInt(letterheadIdStr, 10) : NaN;
  if (Number.isNaN(letterheadId)) {
    res.status(400).json({ error: "Invalid letterhead ID" });
    return;
  }
  const exists = await queryRows(
    r,
    sql`SELECT id, status FROM firm_letterheads WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}`
  );
  if (!exists[0]) {
    res.status(404).json({ error: "Letterhead not found" });
    return;
  }
  const st = typeof (exists[0] as any).status === "string" ? String((exists[0] as any).status) : "active";
  if (st !== "active") {
    res.status(409).json({ error: "Cannot set inactive letterhead as default", code: "LETTERHEAD_INACTIVE" });
    return;
  }
  await queryRows(r, sql`UPDATE firm_letterheads SET is_default = false, updated_at = now() WHERE firm_id = ${req.firmId!}`);
  const rows = await queryRows(
    r,
    sql`UPDATE firm_letterheads SET is_default = true, updated_at = now() WHERE id = ${letterheadId} AND firm_id = ${req.firmId!} RETURNING *`
  );
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.letterhead.set_default", entityType: "firm_letterhead", entityId: letterheadId, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(rows[0]);
});

router.delete("/firm-letterheads/:letterheadId", requireAuth, requireFirmUser, requirePermission("documents", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const letterheadIdStr = one((req.params as any).letterheadId);
  const letterheadId = letterheadIdStr ? parseInt(letterheadIdStr, 10) : NaN;
  if (Number.isNaN(letterheadId)) {
    res.status(400).json({ error: "Invalid letterhead ID" });
    return;
  }
  const existing = await queryRows(
    r,
    sql`SELECT * FROM firm_letterheads WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}`
  );
  const row = existing[0];
  if (!row) {
    res.status(404).json({ error: "Letterhead not found" });
    return;
  }
  const isDefault = row && typeof row === "object" && "is_default" in row ? Boolean((row as any).is_default) : false;
  if (isDefault) {
    res.status(409).json({ error: "Cannot delete default letterhead", code: "DEFAULT_DELETE_FORBIDDEN" });
    return;
  }
  await queryRows(r, sql`DELETE FROM firm_letterheads WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}`);
  const paths: string[] = [];
  if (row && typeof row === "object") {
    if ((row as any).first_page_object_path) paths.push(String((row as any).first_page_object_path));
    if ((row as any).continuation_header_object_path) paths.push(String((row as any).continuation_header_object_path));
    if ((row as any).footer_object_path) paths.push(String((row as any).footer_object_path));
  }
  for (const p of paths) {
    try { await supabaseStorage.deletePrivateObject(p); } catch {}
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.letterhead.delete", entityType: "firm_letterhead", entityId: letterheadId, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

router.get("/firm-letterheads/:letterheadId/templates/:part/download", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const letterheadIdStr = one((req.params as any).letterheadId);
  const partStr = one((req.params as any).part);
  const letterheadId = letterheadIdStr ? parseInt(letterheadIdStr, 10) : NaN;
  if (Number.isNaN(letterheadId) || !partStr) {
    res.status(400).json({ error: "Invalid letterhead template request" });
    return;
  }
  const part = partStr === "first_page" || partStr === "continuation_header" || partStr === "footer" ? partStr : null;
  if (!part) {
    res.status(400).json({ error: "Invalid template part" });
    return;
  }
  const rows = await queryRows(
    r,
    sql`SELECT * FROM firm_letterheads WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}`
  );
  const lh = rows[0];
  if (!lh) {
    res.status(404).json({ error: "Letterhead not found" });
    return;
  }
  const objectPath =
    part === "first_page"
      ? String((lh as any).first_page_object_path)
      : part === "continuation_header"
        ? String((lh as any).continuation_header_object_path)
        : (lh as any).footer_object_path
          ? String((lh as any).footer_object_path)
          : "";
  const fileName =
    part === "first_page"
      ? String((lh as any).first_page_file_name)
      : part === "continuation_header"
        ? String((lh as any).continuation_header_file_name)
        : (lh as any).footer_file_name
          ? String((lh as any).footer_file_name)
          : "";
  if (!objectPath || !fileName) {
    res.status(404).json({ error: "Template not set", code: "TEMPLATE_NOT_SET" });
    return;
  }
  try {
    const fallbackContentType =
      part === "footer"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await streamSupabasePrivateObjectToResponse({ objectPath, res, fileName, fallbackContentType });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.letterhead.download_template", entityType: "firm_letterhead", entityId: letterheadId, detail: `part=${part} fileName=${fileName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  } catch (err) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, letterheadId, part }, "[documents] supabase_storage_not_configured");
      res.status(cfgErr.statusCode).json({ error: cfgErr.error });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, letterheadId, part }, "[documents] letterhead_download_failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/cases/:caseId/documents", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const rows = await queryRows(r, sql`
    SELECT cd.*, dt.name as template_name, u.name as generated_by_name
    FROM case_documents cd
    LEFT JOIN document_templates dt ON cd.template_id = dt.id
    LEFT JOIN platform_documents pd ON cd.platform_document_id = pd.id
    LEFT JOIN users u ON cd.generated_by = u.id
    WHERE cd.case_id = ${caseId} AND cd.firm_id = ${req.firmId!}
    ORDER BY cd.created_at DESC`
  );
  res.json(rows);
});

router.get("/cases/:caseId/document-instances", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }

  const rows = await queryRows(r, sql`
    SELECT
      gr.*,
      dt.name AS template_name,
      pd.name AS platform_document_name,
      u.name AS triggered_by_name
    FROM document_generation_runs gr
    LEFT JOIN document_templates dt ON gr.template_id = dt.id
    LEFT JOIN platform_documents pd ON gr.platform_document_id = pd.id
    LEFT JOIN users u ON gr.triggered_by = u.id
    WHERE gr.firm_id = ${req.firmId!} AND gr.case_id = ${caseId}
    ORDER BY gr.triggered_at DESC, gr.id DESC
    LIMIT 200`
  );
  res.json(rows);
});

router.get("/cases/:caseId/documents/checklist", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }

  const includeAllRequested = truthy((req.query as any).includeAll);
  const includeAll = includeAllRequested ? await canBypassApplicability(r, req.firmId!, req.roleId) : false;

  const context = await buildCaseContext(r, caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const wfDocs = (await tableExists(r, "public.case_workflow_documents"))
    ? await queryRows(r, sql`
      SELECT id, milestone_key, label, object_path, file_name, updated_at
      FROM case_workflow_documents
      WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `)
    : [];
  const workflowDocs: Record<string, { hasFile: boolean; workflowDocumentId?: number; fileName?: string | null; updatedAt?: string | null }> = {};
  for (const d of wfDocs) {
    const k = normalizeWorkflowDocumentKeyFromDb(String(d.milestone_key ?? ""));
    if (!k) continue;
    if (workflowDocs[k]) continue;
    workflowDocs[k] = {
      hasFile: Boolean(d.object_path && d.file_name),
      workflowDocumentId: typeof d.id === "number" ? Number(d.id) : undefined,
      fileName: d.file_name ? String(d.file_name) : null,
      updatedAt: d.updated_at ? String(d.updated_at) : null,
    };
  }

  const stampingRows = (await tableExists(r, "public.case_loan_stamping_items"))
    ? await queryRows(r, sql`
      SELECT id, item_key, custom_name, dated_on, stamped_on, object_path, file_name, sort_order, updated_at
      FROM case_loan_stamping_items
      WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND deleted_at IS NULL
      ORDER BY sort_order ASC, id ASC
    `)
    : [];

  const caseDocuments = await queryRows(r, sql`
    SELECT id, template_id, template_source, platform_document_id, name, file_name, status, is_uploaded, object_path, created_at, generated_by
    FROM case_documents
    WHERE firm_id = ${req.firmId!} AND case_id = ${caseId}
    ORDER BY created_at DESC
  `);

  const latestByFirmTemplateId = new Map<number, Record<string, unknown>>();
  const latestByPlatformDocId = new Map<number, Record<string, unknown>>();
  for (const cd of caseDocuments) {
    const tid = typeof cd.template_id === "number" ? Number(cd.template_id) : null;
    const pid = typeof cd.platform_document_id === "number" ? Number(cd.platform_document_id) : null;
    if (tid && !latestByFirmTemplateId.has(tid)) latestByFirmTemplateId.set(tid, cd);
    if (pid && !latestByPlatformDocId.has(pid)) latestByPlatformDocId.set(pid, cd);
  }

  const firmTemplates = await queryRows(r, sql`
    SELECT *
    FROM document_templates
    WHERE firm_id = ${req.firmId!}
      AND kind = 'template'
      AND is_template_capable = true
      AND (${includeAll} OR is_active = true)
    ORDER BY document_group ASC, sort_order ASC, name ASC
  `);

  const masterTemplates = await queryRows(r, sql`
    SELECT *
    FROM platform_documents
    WHERE (firm_id IS NULL OR firm_id = ${req.firmId!})
      AND (LOWER(file_name) LIKE '%.docx' OR LOWER(file_name) LIKE '%.doc' OR LOWER(file_name) LIKE '%.pdf')
      AND (${includeAll} OR is_active = true)
    ORDER BY document_group ASC, sort_order ASC, name ASC
  `);

  const firmTemplateIds = firmTemplates.map((t) => Number((t as any).id)).filter((id) => Number.isFinite(id));
  const firmRulesRows = firmTemplateIds.length === 0 ? [] : await queryRows(r, sql`
    SELECT *
    FROM document_template_applicability_rules
    WHERE firm_id = ${req.firmId!}
      AND template_id IN (${sql.join(firmTemplateIds.map((id) => sql`${id}`), sql`, `)})
  `);
  const firmRulesById = new Map<number, Record<string, unknown>>();
  for (const row of firmRulesRows) {
    const tid = typeof row.template_id === "number" ? Number(row.template_id) : null;
    if (tid) firmRulesById.set(tid, row);
  }

  const masterIds = masterTemplates.map((t) => Number((t as any).id)).filter((id) => Number.isFinite(id));
  const masterRulesRows = masterIds.length === 0 ? [] : await queryRows(r, sql`
    SELECT *
    FROM document_template_applicability_rules
    WHERE platform_document_id IN (${sql.join(masterIds.map((id) => sql`${id}`), sql`, `)})
      AND (firm_id = ${req.firmId!} OR firm_id IS NULL)
    ORDER BY firm_id DESC NULLS LAST
  `);
  const masterRulesById = new Map<number, Record<string, unknown>>();
  for (const row of masterRulesRows) {
    const pid = typeof row.platform_document_id === "number" ? Number(row.platform_document_id) : null;
    if (!pid) continue;
    if (!masterRulesById.has(pid)) masterRulesById.set(pid, row);
  }

  const purchaseMode = normalizePurchaseMode(String((context as any).purchase_mode ?? "")) ?? null;
  const titleType = normalizeTitleType(String((context as any).title_type ?? "")) ?? null;
  const caseType = typeof (context as any).case_type === "string" ? String((context as any).case_type) : null;
  const referenceNo = typeof (context as any).reference_no === "string" ? String((context as any).reference_no) : null;
  const projectName = typeof (context as any).project_name === "string" ? String((context as any).project_name) : null;
  const purchaser1Name = typeof (context as any).spa_purchaser1_name === "string" ? String((context as any).spa_purchaser1_name) : null;
  const purchaser1Ic = typeof (context as any).spa_purchaser1_ic === "string" ? String((context as any).spa_purchaser1_ic) : null;
  const loanTotal = typeof (context as any).total_loan_raw === "string" ? String((context as any).total_loan_raw) : (typeof (context as any).total_loan === "string" ? String((context as any).total_loan) : null);
  const loanEndFinancier = typeof (context as any).end_financier === "string" ? String((context as any).end_financier) : null;

  const keyDates = Object.fromEntries(
    Object.entries(context as Record<string, unknown>)
      .filter(([k]) => k.endsWith("_ymd"))
      .map(([k, v]) => [k.replace(/_ymd$/, ""), typeof v === "string" ? v : null])
  );

  const readinessInput: TemplateReadinessInputs = {
    purchaseMode,
    titleType,
    caseType,
    referenceNo,
    projectName,
    purchaser1Name,
    purchaser1Ic,
    loanTotal,
    loanEndFinancier,
    keyDates,
    workflowDocs,
    stampingItems: stampingRows.map((x) => ({
      itemKey: (() => {
        const raw = String(x.item_key ?? "");
        return isLoanStampingItemKey(raw) ? raw : "other";
      })(),
      customName: typeof x.custom_name === "string" ? String(x.custom_name) : null,
      datedOn: x.dated_on ? String(x.dated_on) : null,
      stampedOn: x.stamped_on ? String(x.stamped_on) : null,
      hasFile: Boolean(x.object_path && x.file_name),
      sortOrder: typeof x.sort_order === "number" ? Number(x.sort_order) : 0,
    })),
  };

  const checklistOverrides = (await tableExists(r, "public.case_document_checklist_items"))
    ? await queryRows(r, sql`
      SELECT *
      FROM case_document_checklist_items
      WHERE firm_id = ${req.firmId!} AND case_id = ${caseId}
      ORDER BY sort_order ASC, id ASC
    `)
    : [];
  const overrideByKey = new Map<string, Record<string, unknown>>();
  for (const row of checklistOverrides) {
    const k = typeof row.checklist_key === "string" ? row.checklist_key : String(row.checklist_key ?? "");
    if (!k) continue;
    if (!overrideByKey.has(k)) overrideByKey.set(k, row);
  }
  const checklistUploadedDocuments = [
    ...caseDocuments.map((d) => ({
      fileName: d.file_name ? String(d.file_name) : null,
      documentType: d.document_type ? String(d.document_type) : null,
      checklistKey: d.checklist_key ? String(d.checklist_key) : null,
      source: "case_document",
      hasFile: Boolean(d.object_path && d.file_name),
    })),
    ...wfDocs.map((d) => ({
      fileName: d.file_name ? String(d.file_name) : null,
      documentType: d.milestone_key ? String(d.milestone_key) : null,
      checklistKey: d.milestone_key ? `workflow:${String(d.milestone_key)}` : null,
      source: "workflow_document",
      hasFile: Boolean(d.object_path && d.file_name),
    })),
  ];
  const checklistMilestones = buildChecklistMilestones({ workflowDocs, context });

  function buildManualConfirmations(prefix: string, checklistItemsRaw: unknown): Record<string, { checkedBy?: number | null; checkedAt?: string | null; passed: boolean }> {
    const map: Record<string, { checkedBy?: number | null; checkedAt?: string | null; passed: boolean }> = {};
    const parsed = Array.isArray(checklistItemsRaw) ? checklistItemsRaw : [];
    for (const it of parsed) {
      const row = it && typeof it === "object" ? (it as Record<string, unknown>) : null;
      if (!row) continue;
      const type = typeof row.type === "string" ? row.type : "";
      const id = typeof row.id === "string" ? row.id : "";
      if (type !== "manual_confirmation" || !id) continue;
      const k = `${prefix}:confirm:${id}`;
      const ov = overrideByKey.get(k);
      const passed = Boolean(ov?.completed_at || ov?.received_at || ov?.status === "completed" || ov?.status === "received");
      map[id] = {
        passed,
        checkedBy: (ov?.completed_by ?? ov?.received_by) as number | null | undefined,
        checkedAt: (ov?.completed_at ?? ov?.received_at) ? String(ov?.completed_at ?? ov?.received_at) : null,
      };
    }
    return map;
  }

  type ChecklistStatus =
    | "pending"
    | "generated"
    | "uploaded"
    | "received"
    | "completed"
    | "waived"
    | "not_applicable";

  type ChecklistItem = {
    checklistKey: string;
    kind: "template" | "workflow" | "stamping" | "manual";
    source: "firm" | "master" | "workflow" | "stamping" | "manual";
    sourceType: "generated" | "uploaded" | "manual" | "external_received";
    isRequired: boolean;
    status: ChecklistStatus;
    blocked: boolean;
    updatedAt: string | null;
    notes: string | null;
    applicability: { status: "applicable" | "warning" | "not_applicable"; reasons: string[]; matchedRulesCount?: number; failedRulesCount?: number; manuallyOverridable?: boolean };
    readiness: { status: string; missing: Array<{ code: string; message: string }> } | null;
    checklistResult?: {
      checklistStatus: "ready" | "warning" | "blocked";
      totalItems: number;
      passedItems: number;
      missingRequiredItems: number;
      warningItems: number;
      manuallyOverridable: boolean;
      items: Array<{
        id: string;
        label: string;
        type: string;
        passed: boolean;
        required: boolean;
        message: string;
        source: string;
        checkedBy?: number | null;
        checkedAt?: string | null;
      }>;
    } | null;
    templateId?: number;
    name: string;
    documentType?: string;
    documentGroup: string;
    sortOrder: number;
    fileName: string | null;
    fileType: string | null;
    pdfMappings: unknown;
    latestDocument: Record<string, unknown> | null;
    workflowMilestoneKey?: string;
    workflowDocumentId?: number | null;
    loanStampingItemId?: number | null;
    loanStampingItemKey?: string | null;
    completedAt?: string | null;
    completedBy?: number | null;
    receivedAt?: string | null;
    receivedBy?: number | null;
    waivedAt?: string | null;
    waivedBy?: number | null;
    waivedReason?: string | null;
  };

  const items: ChecklistItem[] = [];

  const computeStatus = ({
    checklistKey,
    applicable,
    readiness,
    latestDocument,
    baseHasFile,
  }: {
    checklistKey: string;
    applicable: boolean;
    readiness: { status: string } | null;
    latestDocument: Record<string, unknown> | null;
    baseHasFile: boolean;
  }): { status: ChecklistStatus; blocked: boolean; updatedAt: string | null; override: Record<string, unknown> | null } => {
    if (!applicable) return { status: "not_applicable", blocked: false, updatedAt: null, override: overrideByKey.get(checklistKey) ?? null };
    const ov = overrideByKey.get(checklistKey) ?? null;
    const ovStatus = typeof ov?.status === "string" ? String(ov.status) : null;
    const waivedAt = ov?.waived_at ? String(ov.waived_at) : null;
    const completedAt = ov?.completed_at ? String(ov.completed_at) : null;
    const receivedAt = ov?.received_at ? String(ov.received_at) : null;
    if (ovStatus === "waived" || waivedAt) {
      return { status: "waived", blocked: false, updatedAt: ov?.updated_at ? String(ov.updated_at) : null, override: ov };
    }

    const hasFile = baseHasFile || !!latestDocument;
    if (completedAt && (hasFile || receivedAt)) {
      return { status: "completed", blocked: false, updatedAt: ov?.updated_at ? String(ov.updated_at) : null, override: ov };
    }
    if (receivedAt) {
      return { status: "received", blocked: false, updatedAt: ov?.updated_at ? String(ov.updated_at) : null, override: ov };
    }
    if (latestDocument) {
      const isUploaded = typeof (latestDocument as any).is_uploaded === "boolean" ? Boolean((latestDocument as any).is_uploaded) : false;
      const createdAt = (latestDocument as any).created_at ? String((latestDocument as any).created_at) : null;
      return { status: isUploaded ? "uploaded" : "generated", blocked: false, updatedAt: createdAt, override: ov };
    }
    if (baseHasFile) {
      return { status: "uploaded", blocked: false, updatedAt: ov?.updated_at ? String(ov.updated_at) : null, override: ov };
    }
    const blocked = readiness ? readiness.status !== "ready" : false;
    return { status: "pending", blocked, updatedAt: ov?.updated_at ? String(ov.updated_at) : null, override: ov };
  };

  for (const t of firmTemplates) {
    const templateId = Number((t as any).id);
    const documentGroup = String((t as any).document_group ?? "Others");
    const extra = firmRulesById.get(templateId) ?? null;
    const app = evaluateTemplateApplicabilityV2({
      legacyTemplate: {
      isActive: extra && typeof extra.is_active === "boolean" ? Boolean(extra.is_active) : Boolean((t as any).is_active ?? true),
      isTemplateCapable: extra && typeof extra.is_template_capable === "boolean" ? Boolean(extra.is_template_capable) : Boolean((t as any).is_template_capable ?? true),
      appliesToPurchaseMode: extra && typeof extra.purchase_mode === "string" ? String(extra.purchase_mode) : ((t as any).applies_to_purchase_mode ? String((t as any).applies_to_purchase_mode) : null),
      appliesToTitleType: extra && typeof extra.title_type === "string" ? String(extra.title_type) : ((t as any).applies_to_title_type ? String((t as any).applies_to_title_type) : null),
      appliesToCaseType: (t as any).applies_to_case_type ? String((t as any).applies_to_case_type) : null,
      projectType: extra && typeof extra.project_type === "string" ? String(extra.project_type) : null,
      titleSubType: extra && typeof extra.title_sub_type === "string" ? String(extra.title_sub_type) : null,
      developmentCondition: extra && typeof extra.development_condition === "string" ? String(extra.development_condition) : null,
      unitCategory: extra && typeof extra.unit_category === "string" ? String(extra.unit_category) : null,
      },
      legacyInput: {
      purchaseMode: (context as any).purchase_mode ?? null,
      titleType: (context as any).title_type ?? null,
      caseType,
      projectType: (context as any).project_type ?? null,
      developmentCondition: (context as any).project_development_condition ?? null,
      unitCategory: (context as any).unit_category ?? null,
      titleSubType: (context as any).title_sub_type ?? null,
      },
      context: {
        purchase_mode: (context as any).purchase_mode ?? null,
        case_status: (context as any).case_status ?? null,
        lawyer_in_charge: (context as any).case_handler_name ?? null,
        clerk_in_charge: (context as any).case_assistant_name ?? null,
        project_type: (context as any).project_type ?? null,
        title_type: (context as any).title_type ?? null,
        title_sub_type: (context as any).title_sub_type ?? null,
        development_condition: (context as any).project_development_condition ?? null,
        unit_category: (context as any).unit_category ?? null,
        developer_id: (context as any).developer_id ?? null,
        developer_name: (context as any).developer_name ?? null,
        bank_name: (context as any).end_financier ?? null,
        has_loan: ((context as any).purchase_mode ?? "").toLowerCase() === "loan",
        purchaser_count: [1, 2].filter((i) => Boolean((context as any)[`spa_purchaser${i}_name`])).length,
        borrower_count: [1, 2].filter((i) => Boolean((context as any)[`borrower${i}_name`])).length,
        has_company_party: Boolean((context as any).spa_purchaser1_is_company || (context as any).spa_purchaser2_is_company || (context as any).borrower1_is_company || (context as any).borrower2_is_company),
      },
      applicabilityMode: (t as any).applicability_mode,
      applicabilityRules: (t as any).applicability_rules,
    });
    if (!includeAll && app.applicabilityStatus === "not_applicable") continue;
    const ready = app.applicabilityStatus === "not_applicable" ? { status: "ready", missing: [] } : evaluateTemplateReadiness({ documentGroup, input: readinessInput });
    const checklistKey = `tpl:firm:${templateId}`;
    const checklistEval = evaluateTemplateChecklist({
      checklistMode: (t as any).checklist_mode,
      checklistItems: (t as any).checklist_items,
      caseContext: context as Record<string, unknown>,
      uploadedDocuments: checklistUploadedDocuments,
      milestones: checklistMilestones,
      manualConfirmations: buildManualConfirmations(checklistKey, (t as any).checklist_items),
    });
    const { status, blocked, updatedAt, override } = computeStatus({
      checklistKey,
      applicable: app.applicabilityStatus !== "not_applicable",
      readiness: checklistEval.checklistStatus === "blocked" ? { status: "blocked" } : ready,
      latestDocument: latestByFirmTemplateId.get(templateId) ?? null,
      baseHasFile: false,
    });
    const isRequired = extra && typeof extra.is_required === "boolean" ? Boolean(extra.is_required) : false;
    items.push({
      checklistKey,
      kind: "template",
      source: "firm",
      sourceType: status === "generated" ? "generated" : status === "uploaded" ? "uploaded" : "generated",
      isRequired,
      status,
      blocked,
      updatedAt,
      notes: typeof override?.notes === "string" ? String(override.notes) : null,
      templateId,
      name: String((t as any).name ?? ""),
      documentType: String((t as any).document_type ?? "other"),
      documentGroup,
      sortOrder: Number((t as any).sort_order ?? 0),
      fileName: (t as any).file_name ? String((t as any).file_name) : null,
      fileType: "docx",
      pdfMappings: null,
      applicability: {
        status: app.applicabilityStatus,
        reasons: app.applicabilityReasons,
        matchedRulesCount: app.matchedRulesCount,
        failedRulesCount: app.failedRulesCount,
        manuallyOverridable: app.manuallyOverridable,
      },
      readiness: ready,
      checklistResult: checklistEval,
      latestDocument: latestByFirmTemplateId.get(templateId) ?? null,
      completedAt: override?.completed_at ? String(override.completed_at) : null,
      completedBy: override?.completed_by === null ? null : (typeof override?.completed_by === "number" ? Number(override.completed_by) : (override?.completed_by ? Number(override.completed_by) : null)),
      receivedAt: override?.received_at ? String(override.received_at) : null,
      receivedBy: override?.received_by === null ? null : (typeof override?.received_by === "number" ? Number(override.received_by) : (override?.received_by ? Number(override.received_by) : null)),
      waivedAt: override?.waived_at ? String(override.waived_at) : null,
      waivedBy: override?.waived_by === null ? null : (typeof override?.waived_by === "number" ? Number(override.waived_by) : (override?.waived_by ? Number(override.waived_by) : null)),
      waivedReason: typeof override?.waived_reason === "string" ? String(override.waived_reason) : null,
    });
  }

  for (const t of masterTemplates) {
    const templateId = Number((t as any).id);
    const documentGroup = String((t as any).document_group ?? (t as any).category ?? "Others");
    const extra = masterRulesById.get(templateId) ?? null;
    const app = evaluateTemplateApplicabilityV2({
      legacyTemplate: {
      isActive: extra && typeof extra.is_active === "boolean" ? Boolean(extra.is_active) : Boolean((t as any).is_active ?? true),
      isTemplateCapable: extra && typeof extra.is_template_capable === "boolean" ? Boolean(extra.is_template_capable) : Boolean((t as any).is_template_capable ?? true),
      appliesToPurchaseMode: extra && typeof extra.purchase_mode === "string" ? String(extra.purchase_mode) : ((t as any).applies_to_purchase_mode ? String((t as any).applies_to_purchase_mode) : null),
      appliesToTitleType: extra && typeof extra.title_type === "string" ? String(extra.title_type) : ((t as any).applies_to_title_type ? String((t as any).applies_to_title_type) : null),
      appliesToCaseType: (t as any).applies_to_case_type ? String((t as any).applies_to_case_type) : null,
      projectType: extra && typeof extra.project_type === "string" ? String(extra.project_type) : null,
      titleSubType: extra && typeof extra.title_sub_type === "string" ? String(extra.title_sub_type) : null,
      developmentCondition: extra && typeof extra.development_condition === "string" ? String(extra.development_condition) : null,
      unitCategory: extra && typeof extra.unit_category === "string" ? String(extra.unit_category) : null,
      },
      legacyInput: {
      purchaseMode: (context as any).purchase_mode ?? null,
      titleType: (context as any).title_type ?? null,
      caseType,
      projectType: (context as any).project_type ?? null,
      developmentCondition: (context as any).project_development_condition ?? null,
      unitCategory: (context as any).unit_category ?? null,
      titleSubType: (context as any).title_sub_type ?? null,
      },
      context: {
        purchase_mode: (context as any).purchase_mode ?? null,
        case_status: (context as any).case_status ?? null,
        lawyer_in_charge: (context as any).case_handler_name ?? null,
        clerk_in_charge: (context as any).case_assistant_name ?? null,
        project_type: (context as any).project_type ?? null,
        title_type: (context as any).title_type ?? null,
        title_sub_type: (context as any).title_sub_type ?? null,
        development_condition: (context as any).project_development_condition ?? null,
        unit_category: (context as any).unit_category ?? null,
        developer_id: (context as any).developer_id ?? null,
        developer_name: (context as any).developer_name ?? null,
        bank_name: (context as any).end_financier ?? null,
        has_loan: ((context as any).purchase_mode ?? "").toLowerCase() === "loan",
        purchaser_count: [1, 2].filter((i) => Boolean((context as any)[`spa_purchaser${i}_name`])).length,
        borrower_count: [1, 2].filter((i) => Boolean((context as any)[`borrower${i}_name`])).length,
        has_company_party: Boolean((context as any).spa_purchaser1_is_company || (context as any).spa_purchaser2_is_company || (context as any).borrower1_is_company || (context as any).borrower2_is_company),
      },
      applicabilityMode: (t as any).applicability_mode,
      applicabilityRules: (t as any).applicability_rules,
    });
    if (!includeAll && app.applicabilityStatus === "not_applicable") continue;
    const ready = app.applicabilityStatus === "not_applicable" ? { status: "ready", missing: [] } : evaluateTemplateReadiness({ documentGroup, input: readinessInput });
    const checklistKey = `tpl:master:${templateId}`;
    const checklistEval = evaluateTemplateChecklist({
      checklistMode: (t as any).checklist_mode,
      checklistItems: (t as any).checklist_items,
      caseContext: context as Record<string, unknown>,
      uploadedDocuments: checklistUploadedDocuments,
      milestones: checklistMilestones,
      manualConfirmations: buildManualConfirmations(checklistKey, (t as any).checklist_items),
    });
    const { status, blocked, updatedAt, override } = computeStatus({
      checklistKey,
      applicable: app.applicabilityStatus !== "not_applicable",
      readiness: checklistEval.checklistStatus === "blocked" ? { status: "blocked" } : ready,
      latestDocument: latestByPlatformDocId.get(templateId) ?? null,
      baseHasFile: false,
    });
    const isRequired = extra && typeof extra.is_required === "boolean" ? Boolean(extra.is_required) : false;
    items.push({
      checklistKey,
      kind: "template",
      source: "master",
      sourceType: status === "generated" ? "generated" : status === "uploaded" ? "uploaded" : "generated",
      isRequired,
      status,
      blocked,
      updatedAt,
      notes: typeof override?.notes === "string" ? String(override.notes) : null,
      templateId,
      name: String((t as any).name ?? ""),
      documentType: String((t as any).category ?? "other"),
      documentGroup,
      sortOrder: Number((t as any).sort_order ?? 0),
      fileName: (t as any).file_name ? String((t as any).file_name) : null,
      fileType: (t as any).file_type ? String((t as any).file_type) : null,
      pdfMappings: (t as any).pdf_mappings ?? null,
      applicability: {
        status: app.applicabilityStatus,
        reasons: app.applicabilityReasons,
        matchedRulesCount: app.matchedRulesCount,
        failedRulesCount: app.failedRulesCount,
        manuallyOverridable: app.manuallyOverridable,
      },
      readiness: ready,
      checklistResult: checklistEval,
      latestDocument: latestByPlatformDocId.get(templateId) ?? null,
      completedAt: override?.completed_at ? String(override.completed_at) : null,
      completedBy: override?.completed_by === null ? null : (typeof override?.completed_by === "number" ? Number(override.completed_by) : (override?.completed_by ? Number(override.completed_by) : null)),
      receivedAt: override?.received_at ? String(override.received_at) : null,
      receivedBy: override?.received_by === null ? null : (typeof override?.received_by === "number" ? Number(override.received_by) : (override?.received_by ? Number(override.received_by) : null)),
      waivedAt: override?.waived_at ? String(override.waived_at) : null,
      waivedBy: override?.waived_by === null ? null : (typeof override?.waived_by === "number" ? Number(override.waived_by) : (override?.waived_by ? Number(override.waived_by) : null)),
      waivedReason: typeof override?.waived_reason === "string" ? String(override.waived_reason) : null,
    });
  }

  const workflowMilestones: Array<{ milestoneKey: string; label: string; applicable: boolean }> = [
    { milestoneKey: "spa_stamped", label: workflowDocumentLabel("spa_stamped") ?? "SPA Stamped File", applicable: true },
    { milestoneKey: "lo_stamped", label: workflowDocumentLabel("lo_stamped") ?? "Loan Offer Stamped File", applicable: purchaseMode === "loan" },
    { milestoneKey: "register_poa", label: workflowDocumentLabel("register_poa") ?? "Register POA File", applicable: purchaseMode === "loan" },
    { milestoneKey: "letter_disclaimer", label: workflowDocumentLabel("letter_disclaimer") ?? "Letter Disclaimer File", applicable: purchaseMode === "loan" },
  ];
  for (const m of workflowMilestones) {
    const checklistKey = `workflow:${m.milestoneKey}`;
    const app = m.applicable ? { status: "applicable" as const, reasons: [] } : { status: "not_applicable" as const, reasons: ["Not applicable for this case"] };
    if (!includeAll && app.status !== "applicable") continue;
    const existing = workflowDocs[m.milestoneKey];
    const { status, blocked, updatedAt, override } = computeStatus({
      checklistKey,
      applicable: app.status === "applicable",
      readiness: null,
      latestDocument: null,
      baseHasFile: Boolean(existing?.hasFile),
    });
    items.push({
      checklistKey,
      kind: "workflow",
      source: "workflow",
      sourceType: "uploaded",
      isRequired: app.status === "applicable",
      status,
      blocked,
      updatedAt: existing?.updatedAt ?? updatedAt,
      notes: typeof override?.notes === "string" ? String(override.notes) : null,
      name: m.label,
      documentGroup: "Workflow",
      sortOrder: 0,
      fileName: existing?.fileName ?? null,
      fileType: "file",
      pdfMappings: null,
      applicability: { status: app.status, reasons: app.reasons },
      readiness: null,
      latestDocument: null,
      workflowMilestoneKey: m.milestoneKey,
      workflowDocumentId: existing?.workflowDocumentId ?? null,
      completedAt: override?.completed_at ? String(override.completed_at) : null,
      completedBy: override?.completed_by === null ? null : (typeof override?.completed_by === "number" ? Number(override.completed_by) : (override?.completed_by ? Number(override.completed_by) : null)),
      receivedAt: override?.received_at ? String(override.received_at) : null,
      receivedBy: override?.received_by === null ? null : (typeof override?.received_by === "number" ? Number(override.received_by) : (override?.received_by ? Number(override.received_by) : null)),
      waivedAt: override?.waived_at ? String(override.waived_at) : null,
      waivedBy: override?.waived_by === null ? null : (typeof override?.waived_by === "number" ? Number(override.waived_by) : (override?.waived_by ? Number(override.waived_by) : null)),
      waivedReason: typeof override?.waived_reason === "string" ? String(override.waived_reason) : null,
    });
  }

  const loanTitleType = normalizeLoanTitleType((context as any).title_type ?? null);
  const shouldShowStamping = purchaseMode === "loan";
  if (shouldShowStamping) {
    const existingByKey = new Map<string, Record<string, unknown>>();
    const customRows: Record<string, unknown>[] = [];
    for (const row of stampingRows) {
      const itemKeyRaw = String(row.item_key ?? "");
      const itemKey = isLoanStampingItemKey(itemKeyRaw) ? itemKeyRaw : "other";
      if (itemKey === "other") {
        customRows.push(row);
        continue;
      }
      if (!existingByKey.has(itemKey)) existingByKey.set(itemKey, row);
    }

    for (const itemKey of LOAN_STAMPING_ITEM_KEYS) {
      if (itemKey === "other") continue;
      const applicable = isLoanStampingItemKeyAllowedForTitleType(loanTitleType, itemKey);
      const app = applicable ? { status: "applicable" as const, reasons: [] } : { status: "not_applicable" as const, reasons: ["Not applicable for this case"] };
      if (!includeAll && app.status !== "applicable") continue;
      const existing = existingByKey.get(itemKey) ?? null;
      const id = existing && typeof (existing as any).id === "number" ? Number((existing as any).id) : null;
      const checklistKey = `stamping:key:${itemKey}`;
      const hasFile = Boolean(existing && (existing as any).object_path && (existing as any).file_name);
      const { status, blocked, updatedAt, override } = computeStatus({
        checklistKey,
        applicable: app.status === "applicable",
        readiness: null,
        latestDocument: null,
        baseHasFile: hasFile,
      });
      items.push({
        checklistKey,
        kind: "stamping",
        source: "stamping",
        sourceType: "uploaded",
        isRequired: app.status === "applicable",
        status,
        blocked,
        updatedAt: existing && (existing as any).updated_at ? String((existing as any).updated_at) : updatedAt,
        notes: typeof override?.notes === "string" ? String(override.notes) : null,
        name:
          itemKey === "facility_agreement" ? "Facility Agreement"
          : itemKey === "deed_of_assignment" ? "Deed of Assignment"
          : itemKey === "power_of_attorney" ? "Power of Attorney"
          : itemKey === "charge_annexure" ? "Charge Annexure"
          : String(itemKey).split("_").join(" "),
        documentGroup: "Loan Stamping",
        sortOrder: existing && typeof (existing as any).sort_order === "number" ? Number((existing as any).sort_order) : 0,
        fileName: existing && (existing as any).file_name ? String((existing as any).file_name) : null,
        fileType: "file",
        pdfMappings: null,
        applicability: { status: app.status, reasons: app.reasons },
        readiness: null,
        latestDocument: null,
        loanStampingItemId: id,
        loanStampingItemKey: itemKey,
        completedAt: override?.completed_at ? String(override.completed_at) : null,
        completedBy: override?.completed_by === null ? null : (typeof override?.completed_by === "number" ? Number(override.completed_by) : (override?.completed_by ? Number(override.completed_by) : null)),
        receivedAt: override?.received_at ? String(override.received_at) : null,
        receivedBy: override?.received_by === null ? null : (typeof override?.received_by === "number" ? Number(override.received_by) : (override?.received_by ? Number(override.received_by) : null)),
        waivedAt: override?.waived_at ? String(override.waived_at) : null,
        waivedBy: override?.waived_by === null ? null : (typeof override?.waived_by === "number" ? Number(override.waived_by) : (override?.waived_by ? Number(override.waived_by) : null)),
        waivedReason: typeof override?.waived_reason === "string" ? String(override.waived_reason) : null,
      });
    }

    for (const row of customRows) {
      const id = typeof row.id === "number" ? Number(row.id) : NaN;
      if (!Number.isFinite(id)) continue;
      const label = typeof row.custom_name === "string" && row.custom_name.trim() ? String(row.custom_name) : "Other Stamping Item";
      const checklistKey = `stamping:other:${id}`;
      const app = { status: "applicable" as const, reasons: [] };
      const hasFile = Boolean(row.object_path && row.file_name);
      const { status, blocked, updatedAt, override } = computeStatus({
        checklistKey,
        applicable: true,
        readiness: null,
        latestDocument: null,
        baseHasFile: hasFile,
      });
      items.push({
        checklistKey,
        kind: "stamping",
        source: "stamping",
        sourceType: "uploaded",
        isRequired: false,
        status,
        blocked,
        updatedAt: row.updated_at ? String(row.updated_at) : updatedAt,
        notes: typeof override?.notes === "string" ? String(override.notes) : null,
        name: label,
        documentGroup: "Loan Stamping",
        sortOrder: typeof row.sort_order === "number" ? Number(row.sort_order) : 0,
        fileName: row.file_name ? String(row.file_name) : null,
        fileType: "file",
        pdfMappings: null,
        applicability: { status: app.status, reasons: app.reasons },
        readiness: null,
        latestDocument: null,
        loanStampingItemId: id,
        loanStampingItemKey: "other",
        completedAt: override?.completed_at ? String(override.completed_at) : null,
        completedBy: override?.completed_by === null ? null : (typeof override?.completed_by === "number" ? Number(override.completed_by) : (override?.completed_by ? Number(override.completed_by) : null)),
        receivedAt: override?.received_at ? String(override.received_at) : null,
        receivedBy: override?.received_by === null ? null : (typeof override?.received_by === "number" ? Number(override.received_by) : (override?.received_by ? Number(override.received_by) : null)),
        waivedAt: override?.waived_at ? String(override.waived_at) : null,
        waivedBy: override?.waived_by === null ? null : (typeof override?.waived_by === "number" ? Number(override.waived_by) : (override?.waived_by ? Number(override.waived_by) : null)),
        waivedReason: typeof override?.waived_reason === "string" ? String(override.waived_reason) : null,
      });
    }
  }

  for (const row of checklistOverrides) {
    const sourceType = typeof row.source_type === "string" ? String(row.source_type) : "manual";
    if (sourceType !== "manual" && sourceType !== "external_received") continue;
    const checklistKey = typeof row.checklist_key === "string" ? String(row.checklist_key) : "";
    if (!checklistKey) continue;
    const label = typeof row.label === "string" ? String(row.label) : checklistKey;
    const isRequired = typeof row.is_required === "boolean" ? Boolean(row.is_required) : false;
    const status = (() => {
      const s = typeof row.status === "string" ? String(row.status) : "pending";
      if (s === "waived") return "waived";
      if (s === "completed") return "completed";
      if (s === "received") return "received";
      if (s === "uploaded") return "uploaded";
      if (s === "generated") return "generated";
      if (s === "not_applicable") return "not_applicable";
      return "pending";
    })() as ChecklistStatus;
    const applicable = status !== "not_applicable";
    if (!includeAll && !applicable) continue;
    items.push({
      checklistKey,
      kind: "manual",
      source: "manual",
      sourceType: sourceType as any,
      isRequired,
      status,
      blocked: false,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
      notes: typeof row.notes === "string" ? String(row.notes) : null,
      name: label,
      documentGroup: "Manual",
      sortOrder: typeof row.sort_order === "number" ? Number(row.sort_order) : 0,
      fileName: null,
      fileType: null,
      pdfMappings: null,
      applicability: { status: applicable ? "applicable" : "not_applicable", reasons: [] },
      readiness: null,
      latestDocument: null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      completedBy: row.completed_by === null ? null : (typeof row.completed_by === "number" ? Number(row.completed_by) : (row.completed_by ? Number(row.completed_by) : null)),
      receivedAt: row.received_at ? String(row.received_at) : null,
      receivedBy: row.received_by === null ? null : (typeof row.received_by === "number" ? Number(row.received_by) : (row.received_by ? Number(row.received_by) : null)),
      waivedAt: row.waived_at ? String(row.waived_at) : null,
      waivedBy: row.waived_by === null ? null : (typeof row.waived_by === "number" ? Number(row.waived_by) : (row.waived_by ? Number(row.waived_by) : null)),
      waivedReason: typeof row.waived_reason === "string" ? String(row.waived_reason) : null,
    });
  }

  const sections = new Map<string, ChecklistItem[]>();
  for (const it of items) {
    const key = it.documentGroup || "Others";
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(it);
  }
  const sectionList = Array.from(sections.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, arr]) => ({
      section: k,
      items: arr.sort((x, y) => (x.sortOrder - y.sortOrder) || x.name.localeCompare(y.name)),
    }));

  const applicableItems = items.filter((it) => it.applicability.status !== "not_applicable" && it.status !== "not_applicable");
  const waivedCount = applicableItems.filter((it) => it.status === "waived").length;
  const completedCount = applicableItems.filter((it) => it.status === "completed").length;
  const requiredMissingCount = applicableItems.filter((it) => it.isRequired && it.status !== "waived" && it.status !== "completed" && it.status !== "received" && it.status !== "uploaded" && it.status !== "generated").length;

  res.json({
    case: { caseId, referenceNo, purchaseMode, titleType, caseType, projectName },
    summary: {
      totalApplicable: applicableItems.length,
      requiredMissing: requiredMissingCount,
      completed: completedCount,
      waived: waivedCount,
    },
    sections: sectionList,
  });
});

const CHECKLIST_ALLOWED_ATTACHMENT_EXTENSIONS = new Set<string>(["pdf", "doc", "docx", "jpg", "jpeg", "png"]);

function parseChecklistKeyTarget(checklistKey: string): { templateId?: number; platformDocumentId?: number } {
  const k = checklistKey.trim();
  if (k.startsWith("tpl:firm:")) {
    const id = parseInt(k.slice("tpl:firm:".length), 10);
    if (Number.isFinite(id)) return { templateId: id };
  }
  if (k.startsWith("tpl:master:")) {
    const id = parseInt(k.slice("tpl:master:".length), 10);
    if (Number.isFinite(id)) return { platformDocumentId: id };
  }
  return {};
}

async function resolveChecklistIsRequired(r: DbConn, firmId: number, caseId: number, checklistKey: string): Promise<boolean> {
  const existing = await queryRows(r, sql`
    SELECT is_required
    FROM case_document_checklist_items
    WHERE firm_id = ${firmId} AND case_id = ${caseId} AND checklist_key = ${checklistKey}
    LIMIT 1
  `);
  if (existing[0] && typeof existing[0].is_required === "boolean") return Boolean(existing[0].is_required);

  const { templateId, platformDocumentId } = parseChecklistKeyTarget(checklistKey);
  if (typeof templateId === "number") {
    const rows = await queryRows(r, sql`
      SELECT is_required
      FROM document_template_applicability_rules
      WHERE firm_id = ${firmId} AND template_id = ${templateId}
      LIMIT 1
    `);
    if (rows[0] && rows[0].is_required !== null && rows[0].is_required !== undefined) return Boolean(rows[0].is_required);
  }
  if (typeof platformDocumentId === "number") {
    const rows = await queryRows(r, sql`
      SELECT is_required
      FROM document_template_applicability_rules
      WHERE platform_document_id = ${platformDocumentId}
        AND (firm_id = ${firmId} OR firm_id IS NULL)
      ORDER BY firm_id DESC NULLS LAST
      LIMIT 1
    `);
    if (rows[0] && rows[0].is_required !== null && rows[0].is_required !== undefined) return Boolean(rows[0].is_required);
  }
  return false;
}

router.post("/cases/:caseId/documents/checklist/items", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const exists = await tableExists(r, "public.case_document_checklist_items");
  if (!exists) {
    res.status(503).json({ error: "Checklist tracking not available" });
    return;
  }
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const isRequired = Object.prototype.hasOwnProperty.call(body, "isRequired") ? Boolean(body.isRequired) : false;
  const notes = typeof body.notes === "string" ? body.notes.trim() : null;
  const sortOrder = typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder) ? Math.max(0, Math.floor(body.sortOrder)) : 0;
  if (!label) {
    res.status(400).json({ error: "Missing label" });
    return;
  }
  const caseGuard = await queryRows(r, sql`SELECT 1 FROM cases WHERE id = ${caseId} AND firm_id = ${req.firmId!}`);
  if (!caseGuard[0]) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const checklistKey = `manual:${randomUUID()}`;
  const rows = await queryRows(r, sql`
    INSERT INTO case_document_checklist_items (
      firm_id, case_id, checklist_key,
      template_id, platform_document_id, case_document_id,
      label, source_type, applicability_result,
      is_required, status, notes,
      sort_order, updated_at
    ) VALUES (
      ${req.firmId!}, ${caseId}, ${checklistKey},
      NULL, NULL, NULL,
      ${label}, 'manual', NULL,
      ${isRequired}, 'pending', ${notes as any},
      ${sortOrder}, now()
    )
    RETURNING *
  `);
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "checklist.manual.create",
    entityType: "case",
    entityId: caseId,
    detail: `checklistKey=${checklistKey} label=${label} required=${isRequired}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.status(201).json(rows[0]);
});

router.post("/cases/:caseId/documents/checklist/items/:checklistKey/received", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const rawKey = one((req.params as any).checklistKey);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const checklistKey = rawKey ? String(rawKey) : "";
  if (Number.isNaN(caseId) || !checklistKey) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_document_checklist_items");
  if (!exists) {
    res.status(503).json({ error: "Checklist tracking not available" });
    return;
  }
  const caseGuard = await queryRows(r, sql`SELECT 1 FROM cases WHERE id = ${caseId} AND firm_id = ${req.firmId!}`);
  if (!caseGuard[0]) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const label = typeof (req.body as any)?.label === "string" ? String((req.body as any).label).trim() : null;
  const notes = typeof (req.body as any)?.notes === "string" ? String((req.body as any).notes).trim() : null;
  const { templateId, platformDocumentId } = parseChecklistKeyTarget(checklistKey);
  const isRequired = await resolveChecklistIsRequired(r, req.firmId!, caseId, checklistKey);
  const rows = await queryRows(r, sql`
    INSERT INTO case_document_checklist_items (
      firm_id, case_id, checklist_key,
      template_id, platform_document_id,
      label, source_type, is_required,
      status, notes, received_at, received_by, updated_at
    ) VALUES (
      ${req.firmId!}, ${caseId}, ${checklistKey},
      ${templateId ?? null}, ${platformDocumentId ?? null},
      ${label ?? checklistKey}, 'external_received', ${isRequired},
      'received', ${notes as any}, now(), ${req.userId ?? null}, now()
    )
    ON CONFLICT (firm_id, case_id, checklist_key)
    DO UPDATE SET
      status = 'received',
      source_type = 'external_received',
      notes = COALESCE(EXCLUDED.notes, case_document_checklist_items.notes),
      received_at = now(),
      received_by = ${req.userId ?? null},
      updated_at = now()
    RETURNING *
  `);
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "checklist.received",
    entityType: "case",
    entityId: caseId,
    detail: `checklistKey=${checklistKey} label=${label ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json(rows[0]);
});

router.post("/cases/:caseId/documents/checklist/items/:checklistKey/completed", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const rawKey = one((req.params as any).checklistKey);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const checklistKey = rawKey ? String(rawKey) : "";
  if (Number.isNaN(caseId) || !checklistKey) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_document_checklist_items");
  if (!exists) {
    res.status(503).json({ error: "Checklist tracking not available" });
    return;
  }
  const caseGuard = await queryRows(r, sql`SELECT 1 FROM cases WHERE id = ${caseId} AND firm_id = ${req.firmId!}`);
  if (!caseGuard[0]) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const label = typeof (req.body as any)?.label === "string" ? String((req.body as any).label).trim() : null;
  const notes = typeof (req.body as any)?.notes === "string" ? String((req.body as any).notes).trim() : null;
  const { templateId, platformDocumentId } = parseChecklistKeyTarget(checklistKey);
  const isRequired = await resolveChecklistIsRequired(r, req.firmId!, caseId, checklistKey);
  const rows = await queryRows(r, sql`
    INSERT INTO case_document_checklist_items (
      firm_id, case_id, checklist_key,
      template_id, platform_document_id,
      label, source_type, is_required,
      status, notes, completed_at, completed_by, updated_at
    ) VALUES (
      ${req.firmId!}, ${caseId}, ${checklistKey},
      ${templateId ?? null}, ${platformDocumentId ?? null},
      ${label ?? checklistKey}, 'manual', ${isRequired},
      'completed', ${notes as any}, now(), ${req.userId ?? null}, now()
    )
    ON CONFLICT (firm_id, case_id, checklist_key)
    DO UPDATE SET
      status = 'completed',
      notes = COALESCE(EXCLUDED.notes, case_document_checklist_items.notes),
      completed_at = now(),
      completed_by = ${req.userId ?? null},
      updated_at = now()
    RETURNING *
  `);
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "checklist.completed",
    entityType: "case",
    entityId: caseId,
    detail: `checklistKey=${checklistKey} label=${label ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json(rows[0]);
});

router.post("/cases/:caseId/documents/checklist/items/:checklistKey/waive", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const rawKey = one((req.params as any).checklistKey);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const checklistKey = rawKey ? String(rawKey) : "";
  if (Number.isNaN(caseId) || !checklistKey) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_document_checklist_items");
  if (!exists) {
    res.status(503).json({ error: "Checklist tracking not available" });
    return;
  }
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "Missing reason" });
    return;
  }
  const label = typeof body.label === "string" ? body.label.trim() : null;
  const notes = typeof body.notes === "string" ? body.notes.trim() : null;
  const { templateId, platformDocumentId } = parseChecklistKeyTarget(checklistKey);
  const isRequired = await resolveChecklistIsRequired(r, req.firmId!, caseId, checklistKey);
  const rows = await queryRows(r, sql`
    INSERT INTO case_document_checklist_items (
      firm_id, case_id, checklist_key,
      template_id, platform_document_id,
      label, source_type, is_required,
      status, notes, waived_at, waived_by, waived_reason, updated_at
    ) VALUES (
      ${req.firmId!}, ${caseId}, ${checklistKey},
      ${templateId ?? null}, ${platformDocumentId ?? null},
      ${label ?? checklistKey}, 'manual', ${isRequired},
      'waived', ${notes as any}, now(), ${req.userId ?? null}, ${reason}, now()
    )
    ON CONFLICT (firm_id, case_id, checklist_key)
    DO UPDATE SET
      status = 'waived',
      notes = COALESCE(EXCLUDED.notes, case_document_checklist_items.notes),
      waived_at = now(),
      waived_by = ${req.userId ?? null},
      waived_reason = ${reason},
      updated_at = now()
    RETURNING *
  `);
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "checklist.waived",
    entityType: "case",
    entityId: caseId,
    detail: `checklistKey=${checklistKey} label=${label ?? ""} reason=${reason}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json(rows[0]);
});

router.post("/cases/:caseId/documents/checklist/items/:checklistKey/reopen", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const rawKey = one((req.params as any).checklistKey);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const checklistKey = rawKey ? String(rawKey) : "";
  if (Number.isNaN(caseId) || !checklistKey) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_document_checklist_items");
  if (!exists) {
    res.status(503).json({ error: "Checklist tracking not available" });
    return;
  }
  const rows = await queryRows(r, sql`
    UPDATE case_document_checklist_items
    SET
      status = 'pending',
      received_at = NULL,
      received_by = NULL,
      completed_at = NULL,
      completed_by = NULL,
      waived_at = NULL,
      waived_by = NULL,
      waived_reason = NULL,
      updated_at = now()
    WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND checklist_key = ${checklistKey}
    RETURNING *
  `);
  if (!rows[0]) {
    res.status(404).json({ error: "Checklist item not found" });
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "checklist.reopened",
    entityType: "case",
    entityId: caseId,
    detail: `checklistKey=${checklistKey}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json(rows[0]);
});

router.post("/cases/:caseId/documents/checklist/items/:checklistKey/upload", requireAuth, requireFirmUser, requirePermission("documents", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const rawKey = one((req.params as any).checklistKey);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const checklistKey = rawKey ? String(rawKey) : "";
  if (Number.isNaN(caseId) || !checklistKey) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_document_checklist_items");
  if (!exists) {
    res.status(503).json({ error: "Checklist tracking not available" });
    return;
  }
  const caseGuard = await queryRows(r, sql`SELECT 1 FROM cases WHERE id = ${caseId} AND firm_id = ${req.firmId!}`);
  if (!caseGuard[0]) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const objectPath = typeof body.objectPath === "string" ? body.objectPath.trim() : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim() : null;
  const fileSize = typeof body.fileSize === "number" && Number.isFinite(body.fileSize) ? Math.max(0, Math.floor(body.fileSize)) : null;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!objectPath || !fileName) {
    res.status(400).json({ error: "Missing objectPath or fileName" });
    return;
  }
  if (!objectPath.startsWith(`/objects/cases/${req.firmId!}/case-${caseId}/documents/`)) {
    res.status(400).json({ error: "Invalid objectPath" });
    return;
  }
  const ext = fileExtensionFromName(fileName);
  if (!ext || !CHECKLIST_ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
    res.status(422).json({ error: "Unsupported file type. Allowed: pdf, doc, docx, jpg, jpeg, png" });
    return;
  }
  const { templateId, platformDocumentId } = parseChecklistKeyTarget(checklistKey);
  const templateSource = templateId ? "firm" : platformDocumentId ? "master" : null;
  const isRequired = await resolveChecklistIsRequired(r, req.firmId!, caseId, checklistKey);

  const existingRows = await queryRows(r, sql`
    SELECT id, case_document_id
    FROM case_document_checklist_items
    WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND checklist_key = ${checklistKey}
    LIMIT 1
  `);
  const existingChecklist = existingRows[0] ?? null;
  const previousCaseDocumentId =
    existingChecklist && (existingChecklist as any).case_document_id
      ? Number((existingChecklist as any).case_document_id)
      : null;

  const inserted = await queryRows(r, sql`
    INSERT INTO case_documents (
      case_id, firm_id,
      template_id, template_source, platform_document_id,
      name, document_type, status,
      object_path, file_name, file_size,
      is_uploaded, generated_by, generated_at
    )
    VALUES (
      ${caseId}, ${req.firmId!},
      ${templateId ?? null}, ${templateSource as any}, ${platformDocumentId ?? null},
      ${label || checklistKey}, 'uploaded', 'uploaded',
      ${objectPath}, ${fileName}, ${fileSize as any},
      true, ${req.userId ?? null}, now()
    )
    RETURNING *
  `);
  const created = inserted[0];
  const createdId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : null;

  const upserted = await queryRows(r, sql`
    INSERT INTO case_document_checklist_items (
      firm_id, case_id, checklist_key,
      template_id, platform_document_id, case_document_id,
      label, source_type, is_required,
      status, notes, updated_at
    ) VALUES (
      ${req.firmId!}, ${caseId}, ${checklistKey},
      ${templateId ?? null}, ${platformDocumentId ?? null}, ${createdId as any},
      ${label || checklistKey}, 'uploaded', ${isRequired},
      'uploaded', NULL, now()
    )
    ON CONFLICT (firm_id, case_id, checklist_key)
    DO UPDATE SET
      case_document_id = EXCLUDED.case_document_id,
      status = 'uploaded',
      source_type = 'uploaded',
      label = COALESCE(EXCLUDED.label, case_document_checklist_items.label),
      updated_at = now()
    RETURNING *
  `);

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.upload", entityType: "case_document", entityId: createdId ?? undefined, detail: `caseId=${caseId} name=${label || checklistKey} fileName=${fileName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: previousCaseDocumentId ? "checklist.upload_replaced" : "checklist.upload",
    entityType: "case",
    entityId: caseId,
    detail: `checklistKey=${checklistKey} label=${label || ""} caseDocumentId=${createdId ?? ""} prevCaseDocumentId=${previousCaseDocumentId ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.status(201).json({ checklist: upserted[0], caseDocument: created });
});

router.post("/cases/:caseId/documents/checklist/items/:checklistKey/upload-event", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const rawKey = one((req.params as any).checklistKey);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const checklistKey = rawKey ? String(rawKey) : "";
  if (Number.isNaN(caseId) || !checklistKey) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const exists = await tableExists(r, "public.case_document_checklist_items");
  if (!exists) {
    res.status(503).json({ error: "Checklist tracking not available" });
    return;
  }
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const event = typeof body.event === "string" ? body.event.trim() : "";
  const allowed = new Set(["upload", "upload_replaced", "upload_removed"]);
  if (!allowed.has(event)) {
    res.status(400).json({ error: "Invalid event" });
    return;
  }
  const label = typeof body.label === "string" ? body.label.trim() : null;
  const { templateId, platformDocumentId } = parseChecklistKeyTarget(checklistKey);
  const isRequired = await resolveChecklistIsRequired(r, req.firmId!, caseId, checklistKey);
  const nextStatus = event === "upload_removed" ? "pending" : "pending";
  await queryRows(r, sql`
    INSERT INTO case_document_checklist_items (
      firm_id, case_id, checklist_key,
      template_id, platform_document_id,
      label, source_type, is_required,
      status, updated_at
    ) VALUES (
      ${req.firmId!}, ${caseId}, ${checklistKey},
      ${templateId ?? null}, ${platformDocumentId ?? null},
      ${label ?? checklistKey}, 'uploaded', ${isRequired},
      ${nextStatus}, now()
    )
    ON CONFLICT (firm_id, case_id, checklist_key)
    DO UPDATE SET
      status = CASE
        WHEN ${event} = 'upload_removed' AND case_document_checklist_items.status <> 'waived' THEN 'pending'
        ELSE case_document_checklist_items.status
      END,
      case_document_id = CASE
        WHEN ${event} = 'upload_removed' AND case_document_checklist_items.status <> 'waived' THEN NULL
        ELSE case_document_checklist_items.case_document_id
      END,
      received_at = CASE
        WHEN ${event} = 'upload_removed' AND case_document_checklist_items.status <> 'waived' THEN NULL
        ELSE case_document_checklist_items.received_at
      END,
      received_by = CASE
        WHEN ${event} = 'upload_removed' AND case_document_checklist_items.status <> 'waived' THEN NULL
        ELSE case_document_checklist_items.received_by
      END,
      completed_at = CASE
        WHEN ${event} = 'upload_removed' AND case_document_checklist_items.status <> 'waived' THEN NULL
        ELSE case_document_checklist_items.completed_at
      END,
      completed_by = CASE
        WHEN ${event} = 'upload_removed' AND case_document_checklist_items.status <> 'waived' THEN NULL
        ELSE case_document_checklist_items.completed_by
      END,
      updated_at = now()
  `);
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: `checklist.${event}`,
    entityType: "case",
    entityId: caseId,
    detail: `checklistKey=${checklistKey} label=${label ?? ""}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json({ ok: true });
});

router.get("/cases/:caseId/documents/checklist/history", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const exists = await tableExists(r, "public.audit_logs");
  if (!exists) {
    res.json([]);
    return;
  }
  const rows = await queryRows(r, sql`
    SELECT *
    FROM audit_logs
    WHERE firm_id = ${req.firmId!}
      AND entity_type = 'case'
      AND entity_id = ${caseId}
      AND action LIKE 'checklist.%'
    ORDER BY created_at DESC, id DESC
    LIMIT 200
  `);
  res.json(rows);
});

class DocumentGenerationError extends Error {
  statusCode: number;
  code: string;
  payload?: Record<string, unknown>;
  constructor(statusCode: number, code: string, message: string, payload?: Record<string, unknown>) {
    super(message);
    this.name = "DocumentGenerationError";
    this.statusCode = statusCode;
    this.code = code;
    this.payload = payload;
    Object.setPrototypeOf(this, DocumentGenerationError.prototype);
  }
}

async function ensureFirmTemplatePublishedVersionId(r: DbConn, firmId: number, templateId: number, actorId: number | null): Promise<number> {
  const existingRows = await queryRows(r, sql`
    SELECT id
    FROM document_template_versions
    WHERE firm_id = ${firmId} AND template_id = ${templateId} AND status = 'published'
    ORDER BY published_at DESC NULLS LAST, version_no DESC
    LIMIT 1
  `);
  const existingId = existingRows[0]?.id;
  if (typeof existingId === "number") return Number(existingId);

  const tplRows = await queryRows(r, sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${firmId}`);
  const tpl = tplRows[0];
  if (!tpl) throw new DocumentGenerationError(404, "TEMPLATE_NOT_FOUND", "Template not found");

  const insertedRows = await queryRows(r, sql`
    INSERT INTO document_template_versions (
      firm_id, template_id, version_no, status,
      source_object_path, filename, mime_type,
      template_kind, category, document_group,
      variables_snapshot, pdf_mappings_snapshot, applicability_rules_snapshot, readiness_rules_snapshot,
      created_by, created_at, published_by, published_at
    )
    VALUES (
      ${firmId}, ${templateId}, 1, 'published',
      ${String((tpl as any).object_path ?? "")}, ${String((tpl as any).file_name ?? "")}, ${((tpl as any).mime_type ?? null) as any},
      ${String((tpl as any).kind ?? "template")}, ${String((tpl as any).document_type ?? "other")}, ${String((tpl as any).document_group ?? "Others")},
      ${null as any}, ${null as any},
      ${{
        applies_to_purchase_mode: (tpl as any).applies_to_purchase_mode ?? null,
        applies_to_title_type: (tpl as any).applies_to_title_type ?? "any",
        applies_to_case_type: (tpl as any).applies_to_case_type ?? null,
        is_active: Boolean((tpl as any).is_active ?? true),
      } as any},
      ${{ document_group: String((tpl as any).document_group ?? "Others") } as any},
      ${actorId}, ${(tpl as any).created_at ?? null}, ${actorId}, now()
    )
    RETURNING id
  `);
  const newId = insertedRows[0]?.id;
  if (typeof newId !== "number") throw new Error("Failed to create template version");
  return Number(newId);
}

async function createGenerationRun(r: DbConn, row: Record<string, unknown>): Promise<number> {
  const rows = await queryRows(r, sql`
    INSERT INTO document_generation_runs (
      firm_id, case_id, template_source,
      template_id, template_version_id, platform_document_id,
      document_name, render_mode, status,
      rendered_variables_snapshot, checklist_snapshot, readiness_snapshot,
      triggered_by, triggered_at,
      error_code, error_message
    ) VALUES (
      ${row.firm_id as any}, ${row.case_id as any}, ${row.template_source as any},
      ${row.template_id as any}, ${row.template_version_id as any}, ${row.platform_document_id as any},
      ${row.document_name as any}, ${row.render_mode as any}, ${row.status as any},
      ${row.rendered_variables_snapshot as any}, ${row.checklist_snapshot as any}, ${row.readiness_snapshot as any},
      ${row.triggered_by as any}, now(),
      ${row.error_code as any}, ${row.error_message as any}
    )
    RETURNING id
  `);
  const id = rows[0]?.id;
  if (typeof id !== "number") throw new Error("Failed to create generation run");
  return Number(id);
}

async function finishGenerationRunSuccess(r: DbConn, firmId: number, runId: number, caseDocumentId: number | null, renderedVars: unknown, checklistSnapshot: unknown, readinessSnapshot: unknown): Promise<void> {
  await queryRows(r, sql`
    UPDATE document_generation_runs
    SET status = 'success',
        finished_at = now(),
        case_document_id = ${caseDocumentId},
        rendered_variables_snapshot = ${renderedVars as any},
        checklist_snapshot = ${checklistSnapshot as any},
        readiness_snapshot = ${readinessSnapshot as any}
    WHERE id = ${runId} AND firm_id = ${firmId}
  `);
}

async function finishGenerationRunFailed(r: DbConn, firmId: number, runId: number, errorCode: string, errorMessage: string): Promise<void> {
  await queryRows(r, sql`
    UPDATE document_generation_runs
    SET status = 'failed',
        finished_at = now(),
        error_code = ${errorCode},
        error_message = ${errorMessage}
    WHERE id = ${runId} AND firm_id = ${firmId}
  `);
}

async function generateFirmDocument({
  r,
  firmId,
  actorId,
  actorType,
  ipAddress,
  userAgent,
  caseId,
  templateId,
  documentName,
  letterheadId,
  runId,
  bypassApplicability,
  clauses,
}: {
  r: DbConn;
  firmId: number;
  actorId: number;
  actorType: string | undefined;
  ipAddress: string | undefined;
  userAgent: string | undefined;
  caseId: number;
  templateId: number;
  documentName?: string;
  letterheadId?: number | null;
  runId: number;
  bypassApplicability?: boolean;
  clauses?: SelectedClauseRef[];
}): Promise<{ caseDocument: Record<string, unknown>; caseDocumentId: number | null; templateVersionId: number | null; checklistSnapshot: unknown; readinessSnapshot: unknown; renderedVars: unknown; }> {
  const templateRows = await queryRows(r, sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${firmId}`);
  const template = templateRows[0];
  if (!template) throw new DocumentGenerationError(404, "TEMPLATE_NOT_FOUND", "Template not found");
  const templateCapable = Boolean((template as any).is_template_capable ?? true);
  const templateDocType = String((template as any).document_type ?? "other");
  if (!templateCapable) throw new DocumentGenerationError(422, "NOT_TEMPLATE_CAPABLE", "Selected document is not template-capable");

  const context = await buildCaseContext(r, caseId, firmId);
  if (!context) throw new DocumentGenerationError(404, "CASE_NOT_FOUND", "Case not found");

  const extraRules = await getFirmTemplateApplicabilityRules(r, firmId, templateId);
  const applicability = evaluateTemplateApplicabilityV2({
    legacyTemplate: {
      isActive: extraRules?.isActive ?? Boolean((template as any).is_active ?? true),
      isTemplateCapable: extraRules?.isTemplateCapable ?? Boolean((template as any).is_template_capable ?? true),
      appliesToPurchaseMode: extraRules?.purchaseMode ?? ((template as any).applies_to_purchase_mode ? String((template as any).applies_to_purchase_mode) : null),
      appliesToTitleType: extraRules?.titleType ?? ((template as any).applies_to_title_type ? String((template as any).applies_to_title_type) : null),
      appliesToCaseType: (template as any).applies_to_case_type ? String((template as any).applies_to_case_type) : null,
      projectType: extraRules?.projectType ?? null,
      titleSubType: extraRules?.titleSubType ?? null,
      developmentCondition: extraRules?.developmentCondition ?? null,
      unitCategory: extraRules?.unitCategory ?? null,
    },
    legacyInput: {
      purchaseMode: (context as any).purchase_mode ?? null,
      titleType: (context as any).title_type ?? null,
      caseType: (context as any).case_type ?? null,
      projectType: (context as any).project_type ?? null,
      developmentCondition: (context as any).project_development_condition ?? null,
      unitCategory: (context as any).unit_category ?? null,
      titleSubType: (context as any).title_sub_type ?? null,
    },
    context: buildApplicabilityContext(context),
    applicabilityMode: (template as any).applicability_mode,
    applicabilityRules: (template as any).applicability_rules,
  });
  const overrideUsed = Boolean(bypassApplicability && applicability.manuallyOverridable && applicability.applicabilityStatus === "not_applicable");
  if (applicability.applicabilityStatus === "not_applicable") {
    if (applicability.modeUsed === "rules_only") {
      await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "document_template", entityId: templateId, detail: `applicabilityStatus=not_applicable mode=${applicability.modeUsed} overrideUsed=0 reasons=${applicability.applicabilityReasons.join("|")}`, ipAddress, userAgent });
      throw new DocumentGenerationError(422, "TEMPLATE_APPLICABILITY_BLOCKED", "Template blocked by applicability", { reasons: applicability.applicabilityReasons, mode: applicability.modeUsed });
    }
    if (applicability.modeUsed === "rules_with_manual_override" && !overrideUsed) {
      await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "document_template", entityId: templateId, detail: `applicabilityStatus=not_applicable mode=${applicability.modeUsed} overrideUsed=0 reasons=${applicability.applicabilityReasons.join("|")}`, ipAddress, userAgent });
      throw new DocumentGenerationError(422, "TEMPLATE_APPLICABILITY_OVERRIDE_REQUIRED", "Template requires manual override", { reasons: applicability.applicabilityReasons, mode: applicability.modeUsed });
    }
  }

  const wfDocs = (await tableExists(r, "public.case_workflow_documents"))
    ? await queryRows(r, sql`
      SELECT milestone_key, object_path, file_name, updated_at
      FROM case_workflow_documents
      WHERE firm_id = ${firmId} AND case_id = ${caseId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `)
    : [];
  const workflowDocs: Record<string, { hasFile: boolean }> = {};
  for (const d of wfDocs) {
    const k = normalizeWorkflowDocumentKeyFromDb(String(d.milestone_key ?? ""));
    if (!k) continue;
    if (workflowDocs[k]) continue;
    workflowDocs[k] = { hasFile: Boolean(d.object_path && d.file_name) };
  }
  const stampingRows = (await tableExists(r, "public.case_loan_stamping_items"))
    ? await queryRows(r, sql`
      SELECT item_key, custom_name, dated_on, stamped_on, object_path, file_name, sort_order
      FROM case_loan_stamping_items
      WHERE firm_id = ${firmId} AND case_id = ${caseId} AND deleted_at IS NULL
      ORDER BY sort_order ASC, id ASC
    `)
    : [];
  const keyDates = Object.fromEntries(
    Object.entries(context as Record<string, unknown>)
      .filter(([k]) => k.endsWith("_ymd"))
      .map(([k, v]) => [k.replace(/_ymd$/, ""), typeof v === "string" ? v : null])
  );
  const readinessInput: TemplateReadinessInputs = {
    purchaseMode: normalizePurchaseMode(String((context as any).purchase_mode ?? "")) ?? null,
    titleType: normalizeTitleType(String((context as any).title_type ?? "")) ?? null,
    caseType: typeof (context as any).case_type === "string" ? String((context as any).case_type) : null,
    referenceNo: typeof (context as any).reference_no === "string" ? String((context as any).reference_no) : null,
    projectName: typeof (context as any).project_name === "string" ? String((context as any).project_name) : null,
    purchaser1Name: typeof (context as any).spa_purchaser1_name === "string" ? String((context as any).spa_purchaser1_name) : null,
    purchaser1Ic: typeof (context as any).spa_purchaser1_ic === "string" ? String((context as any).spa_purchaser1_ic) : null,
    loanTotal: typeof (context as any).total_loan_raw === "string" ? String((context as any).total_loan_raw) : null,
    loanEndFinancier: typeof (context as any).end_financier === "string" ? String((context as any).end_financier) : null,
    keyDates,
    workflowDocs,
    stampingItems: stampingRows.map((x) => ({
      itemKey: (() => {
        const raw = String(x.item_key ?? "");
        return isLoanStampingItemKey(raw) ? raw : "other";
      })(),
      customName: typeof x.custom_name === "string" ? String(x.custom_name) : null,
      datedOn: x.dated_on ? String(x.dated_on) : null,
      stampedOn: x.stamped_on ? String(x.stamped_on) : null,
      hasFile: Boolean(x.object_path && x.file_name),
      sortOrder: typeof x.sort_order === "number" ? Number(x.sort_order) : 0,
    })),
  };
  const readiness = evaluateTemplateReadiness({
    documentGroup: String((template as any).document_group ?? "Others"),
    input: readinessInput,
  });
  if (readiness.status !== "ready") throw new DocumentGenerationError(422, "TEMPLATE_NOT_READY", "Template not ready", { status: readiness.status, missing: readiness.missing });

  const templateVersionId = await ensureFirmTemplatePublishedVersionId(r, firmId, templateId, actorId);
  await queryRows(r, sql`UPDATE document_generation_runs SET template_version_id = ${templateVersionId} WHERE id = ${runId} AND firm_id = ${firmId}`);

  const versionRows = await queryRows(r, sql`SELECT * FROM document_template_versions WHERE id = ${templateVersionId} AND firm_id = ${firmId}`);
  const version = versionRows[0];
  const templateObjectPath = String((version as any)?.source_object_path ?? "");
  if (!templateObjectPath) throw new DocumentGenerationError(404, "TEMPLATE_FILE_MISSING", "Template file missing");

  let fileContents = await downloadPrivateObjectBytes(templateObjectPath);
  const placeholders = placeholdersFromVariablesSnapshot((version as any)?.variables_snapshot);
  const effectivePlaceholders = placeholders.length > 0 ? placeholders : detectDocxVariables(fileContents);
  const preview = await runDocumentPreview(r, {
    firmId,
    caseContext: context,
    templateRef: { kind: "firm", templateId },
    placeholders: effectivePlaceholders,
    overrides: null,
  });
  if (preview.usedMode === "bindings" && preview.missingRequiredVariables.length > 0) {
    throw new DocumentGenerationError(422, "TEMPLATE_BINDING_MISSING", "Missing required variables", { missingRequiredVariables: preview.missingRequiredVariables });
  }
  let input: Record<string, unknown> = preview.usedMode === "bindings" ? preview.resolvedVariables : (context as any);
  let clauseSnapshot: Record<string, unknown> | null = null;
  let checklistEval = evaluateTemplateChecklist({
    checklistMode: (template as any).checklist_mode,
    checklistItems: (template as any).checklist_items,
    caseContext: context as Record<string, unknown>,
    resolvedVariables: input,
    uploadedDocuments: [],
    milestones: buildChecklistMilestones({ workflowDocs, context }),
    manualConfirmations: {},
  });
  let checklistOverrideUsed = false;
  if (clauses && clauses.length > 0) {
    const ins = await buildClauseInsertion({ r, firmId, selected: clauses, resolvedVariables: input });
    const selectedCodes = ins.selectedClausesResolved.map((c) => c.clauseCode).filter(Boolean);
    const detection = detectClausePlaceholders(fileContents, selectedCodes);
    const mode = normalizeClauseInsertionMode((template as any).clause_insertion_mode);
    const decision = decideClauseInsertion({
      mode,
      hasClausesPlaceholder: detection.hasClausesPlaceholder,
      foundClauseCodes: detection.foundClauseCodes,
      selectedClauseCodes: selectedCodes,
    });
    if (decision.insertionTarget === "none") {
      throw new DocumentGenerationError(422, "CLAUSE_INSERTION_TARGET_NOT_FOUND", decision.insertionError || "Clause insertion target not found");
    }
    const applied = applyClauseInsertionToDocx({
      docxBytes: fileContents,
      data: input,
      clausesText: ins.clausesText,
      perClauseValues: ins.perClauseValues,
      insertionMode: mode,
      selectedClauseCodes: selectedCodes,
    });
    fileContents = applied.docxBytes;
    input = applied.data;
    clauseSnapshot = {
      insertionModeUsed: decision.insertionModeUsed,
      insertionTarget: decision.insertionTarget,
      hasClausesPlaceholder: detection.hasClausesPlaceholder,
      detectedClauseCodePlaceholders: detection.foundClauseCodes,
      clauseOrder: ins.clauseOrder,
      duplicateClauseWarnings: ins.duplicateClauseWarnings,
      selectedClausesResolved: ins.selectedClausesResolved.map((c) => ({
        scope: c.scope,
        id: c.id,
        clauseCode: c.clauseCode,
        title: c.title,
        includeTitle: c.includeTitle,
        body: c.body,
      })),
    };
  }
  {
    const caseDocs = await queryRows(r, sql`
      SELECT checklist_key, file_name, document_type, object_path
      FROM case_documents
      WHERE firm_id = ${firmId} AND case_id = ${caseId}
    `);
    const confirmPrefix = `tpl:firm:${templateId}:confirm:`;
    const confirmationRows = (await tableExists(r, "public.case_document_checklist_items"))
      ? await queryRows(r, sql`
        SELECT checklist_key, status, completed_at, completed_by, received_at, received_by
        FROM case_document_checklist_items
        WHERE firm_id = ${firmId} AND case_id = ${caseId} AND checklist_key LIKE ${`${confirmPrefix}%`}
      `)
      : [];
    const manualConfirmations: Record<string, { checkedBy?: number | null; checkedAt?: string | null; passed: boolean }> = {};
    for (const row of confirmationRows) {
      const k = typeof row.checklist_key === "string" ? String(row.checklist_key) : "";
      const itemId = k.startsWith(confirmPrefix) ? k.slice(confirmPrefix.length) : "";
      if (!itemId) continue;
      const passed = Boolean(row.completed_at || row.received_at || row.status === "completed" || row.status === "received");
      manualConfirmations[itemId] = {
        passed,
        checkedBy: (row.completed_by ?? row.received_by) as number | null | undefined,
        checkedAt: (row.completed_at ?? row.received_at) ? String(row.completed_at ?? row.received_at) : null,
      };
    }
    checklistEval = evaluateTemplateChecklist({
      checklistMode: (template as any).checklist_mode,
      checklistItems: (template as any).checklist_items,
      caseContext: context as Record<string, unknown>,
      resolvedVariables: input,
      uploadedDocuments: [
        ...caseDocs.map((d) => ({
          fileName: d.file_name ? String(d.file_name) : null,
          documentType: d.document_type ? String(d.document_type) : null,
          checklistKey: d.checklist_key ? String(d.checklist_key) : null,
          source: "case_document",
          hasFile: Boolean(d.object_path && d.file_name),
        })),
        ...wfDocs.map((d) => ({
          fileName: d.file_name ? String(d.file_name) : null,
          documentType: d.milestone_key ? String(d.milestone_key) : null,
          checklistKey: d.milestone_key ? `workflow:${String(d.milestone_key)}` : null,
          source: "workflow_document",
          hasFile: Boolean(d.object_path && d.file_name),
        })),
      ],
      milestones: buildChecklistMilestones({ workflowDocs, context }),
      manualConfirmations,
    });
    checklistOverrideUsed = Boolean(
      bypassApplicability
      && checklistEval.manuallyOverridable
      && checklistEval.checklistStatus === "blocked"
    );
    const checklistMode = normalizeChecklistMode((template as any).checklist_mode);
    if (checklistEval.checklistStatus === "blocked") {
      if (checklistMode === "required_to_generate") {
        await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "document_template", entityId: templateId, detail: `checklistStatus=blocked mode=${checklistMode} overrideUsed=0 missing=${checklistEval.missingRequiredItems}`, ipAddress, userAgent });
        throw new DocumentGenerationError(422, "TEMPLATE_CHECKLIST_BLOCKED", "Template blocked by checklist", { checklist: checklistEval, mode: checklistMode });
      }
      if (checklistMode === "required_with_manual_override" && !checklistOverrideUsed) {
        await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "document_template", entityId: templateId, detail: `checklistStatus=blocked mode=${checklistMode} overrideUsed=0 missing=${checklistEval.missingRequiredItems}`, ipAddress, userAgent });
        throw new DocumentGenerationError(422, "TEMPLATE_CHECKLIST_OVERRIDE_REQUIRED", "Template checklist requires manual override", { checklist: checklistEval, mode: checklistMode });
      }
    }
  }
  const zip = new PizZip(fileContents);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  try {
    doc.render(input);
  } catch {
    throw new DocumentGenerationError(422, "TEMPLATE_RENDER_FAILED", "Template render failed");
  }

  let buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  const isLetterLike = isLetterheadApplicableDocumentType(templateDocType);
  let usedLetterheadId: number | null = null;
  if (isLetterLike) {
    const letterheadIdNum = typeof letterheadId === "number" ? letterheadId : null;
    let lh: Record<string, unknown> | undefined;
    if (letterheadIdNum !== null) {
      const byId = await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE id = ${letterheadIdNum} AND firm_id = ${firmId}`);
      const candidate = byId[0];
      if (!candidate) throw new DocumentGenerationError(404, "LETTERHEAD_NOT_FOUND", "Letterhead not found");
      if (String((candidate as any).status ?? "active") !== "active") throw new DocumentGenerationError(409, "LETTERHEAD_INACTIVE", "Selected letterhead is inactive");
      lh = candidate;
    } else {
      const defaults = await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE firm_id = ${firmId} AND status = 'active' ORDER BY is_default DESC, created_at DESC LIMIT 1`);
      lh = defaults[0];
      if (!lh) throw new DocumentGenerationError(422, "NO_LETTERHEAD", "No active firm letterhead configured");
    }
    usedLetterheadId = typeof (lh as any).id === "number" ? Number((lh as any).id) : null;
    const firstPath = String((lh as any).first_page_object_path);
    const contPath = String((lh as any).continuation_header_object_path);
    const footerPath = (lh as any).footer_object_path ? String((lh as any).footer_object_path) : null;
    const footerMode = (lh as any).footer_mode === "last_page_only" ? "last_page_only" : "every_page";
    const firstBytes = await downloadPrivateObjectBytes(firstPath);
    const contBytes = await downloadPrivateObjectBytes(contPath);
    const footerBytes = footerPath ? await downloadPrivateObjectBytes(footerPath) : null;
    buffer = await applyLetterheadToDocxBuffer({
      baseDocx: buffer,
      firstPageTemplateDocx: firstBytes,
      continuationHeaderTemplateDocx: contBytes,
      footerTemplateDocx: footerBytes,
      footerMode,
    });
  }

  const normalizedPath = newGeneratedDocObjectPath(firmId, caseId, "docx");
  await supabaseStorage.uploadPrivateObject({
    objectPath: normalizedPath,
    fileBytes: buffer,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const docName = documentName ?? String((template as any).name ?? "Generated document");
  const templateCode = String((template as any).document_type ?? "DOC");
  const sequence = await nextCaseDocumentSequence(r, firmId, caseId);
  const namingRule = typeof (template as any).file_naming_rule === "string" ? String((template as any).file_naming_rule) : null;
  const namingPreview = resolveDocumentFileName({
    ctx: buildNamingContext({
      caseId,
      firmId,
      context,
      documentName: docName,
      templateName: String((template as any).name ?? ""),
      sequence,
    }),
    rule: namingRule,
    originalFileNameOrExt: "docx",
    fallbackExt: "docx",
  });
  const uniq = await ensureUniqueCaseDocumentFileName({
    r,
    firmId,
    caseId,
    desiredFileName: namingPreview.fileName,
  });
  const downloadName = uniq.fileName;
  const namingSnapshot = {
    namingRuleUsed: namingPreview.ruleUsed,
    resolvedFileName: downloadName,
    namingWarnings: namingPreview.warnings,
    namingFallbackUsed: namingPreview.fallbackUsed,
    collisionResolved: uniq.collisionResolved,
    collisionSuffixApplied: uniq.collisionSuffixApplied,
  };
  const templateSnapshotUpdatedAt = (version as any)?.published_at ?? (template as any).updated_at ?? null;
  const docRows = await queryRows(r, sql`
    INSERT INTO case_documents (case_id, firm_id, template_id, template_source, template_snapshot_name, template_snapshot_updated_at, name, document_type, status, object_path, file_name, generated_by, clause_snapshot, naming_snapshot)
    VALUES (${caseId}, ${firmId}, ${templateId}, 'firm', ${String((template as any).name ?? "")}, ${templateSnapshotUpdatedAt as any}, ${docName}, ${templateDocType}, 'generated', ${normalizedPath}, ${downloadName}, ${actorId}, ${clauseSnapshot as any}, ${namingSnapshot as any})
    RETURNING *
  `);
  const created = docRows[0];
  const createdId = created && typeof created === "object" && "id" in created && typeof (created as any).id === "number"
    ? Number((created as any).id)
    : null;
  await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate", entityType: "case_document", entityId: createdId ?? undefined, detail: `caseId=${caseId} templateId=${templateId} name=${docName} letterhead=${isLetterLike ? (usedLetterheadId ?? "default") : "n/a"} clauses=${clauseSnapshot ? "yes" : "no"} fileName=${downloadName} fallback=${namingPreview.fallbackUsed ? "1" : "0"} collision=${uniq.collisionResolved ? "1" : "0"} applicabilityStatus=${applicability.applicabilityStatus} applicabilityOverrideUsed=${overrideUsed ? "1" : "0"} checklistStatus=${checklistEval.checklistStatus} checklistOverrideUsed=${checklistOverrideUsed ? "1" : "0"}`, ipAddress, userAgent });
  if (preview.usedMode === "bindings") {
    await writeAuditLog({ firmId, actorId, actorType, action: "documents.generate.binding_used", entityType: "case_document", entityId: createdId ?? undefined, detail: `caseId=${caseId} templateId=${templateId} placeholders=${effectivePlaceholders.length} missing=${preview.missingRequiredVariables.length}`, ipAddress, userAgent });
  }
  return {
    caseDocument: created,
    caseDocumentId: createdId,
    templateVersionId,
    checklistSnapshot: { applicability, checklist: checklistEval, checklistOverrideUsed, bindingMode: preview.usedMode, placeholderWarnings: preview.placeholderWarnings },
    readinessSnapshot: { readiness },
    renderedVars: preview.usedMode === "bindings" ? preview.resolvedVariables : context,
  };
}

async function generateMasterDocument({
  r,
  firmId,
  actorId,
  actorType,
  ipAddress,
  userAgent,
  caseId,
  masterDocId,
  documentName,
  letterheadId,
  runId,
  bypassApplicability,
  clauses,
}: {
  r: DbConn;
  firmId: number;
  actorId: number;
  actorType: string | undefined;
  ipAddress: string | undefined;
  userAgent: string | undefined;
  caseId: number;
  masterDocId: number;
  documentName?: string;
  letterheadId?: number | null;
  runId: number;
  bypassApplicability?: boolean;
  clauses?: SelectedClauseRef[];
}): Promise<{ caseDocument: Record<string, unknown>; caseDocumentId: number | null; templateVersionId: number | null; checklistSnapshot: unknown; readinessSnapshot: unknown; renderedVars: unknown; renderMode: "docx" | "pdf" }> {
  const docRows2 = await queryRows(r, sql`SELECT * FROM platform_documents WHERE id = ${masterDocId} AND (firm_id IS NULL OR firm_id = ${firmId})`);
  const masterDoc = docRows2[0];
  if (!masterDoc) throw new DocumentGenerationError(404, "MASTER_DOCUMENT_NOT_FOUND", "Master document not found");
  const masterFileName = String((masterDoc as any).file_name ?? "");
  const isDocx = masterFileName.toLowerCase().endsWith(".docx") || masterFileName.toLowerCase().endsWith(".doc");
  const isPdf = masterFileName.toLowerCase().endsWith(".pdf");

  const context = await buildCaseContext(r, caseId, firmId);
  if (!context) throw new DocumentGenerationError(404, "CASE_NOT_FOUND", "Case not found");

  const extraRules = await getPlatformDocumentApplicabilityRules(r, firmId, masterDocId);
  const applicability = evaluateTemplateApplicabilityV2({
    legacyTemplate: {
      isActive: extraRules?.isActive ?? Boolean((masterDoc as any).is_active ?? true),
      isTemplateCapable: extraRules?.isTemplateCapable ?? Boolean((masterDoc as any).is_template_capable ?? true),
      appliesToPurchaseMode: extraRules?.purchaseMode ?? ((masterDoc as any).applies_to_purchase_mode ? String((masterDoc as any).applies_to_purchase_mode) : null),
      appliesToTitleType: extraRules?.titleType ?? ((masterDoc as any).applies_to_title_type ? String((masterDoc as any).applies_to_title_type) : null),
      appliesToCaseType: (masterDoc as any).applies_to_case_type ? String((masterDoc as any).applies_to_case_type) : null,
      projectType: extraRules?.projectType ?? null,
      titleSubType: extraRules?.titleSubType ?? null,
      developmentCondition: extraRules?.developmentCondition ?? null,
      unitCategory: extraRules?.unitCategory ?? null,
    },
    legacyInput: {
      purchaseMode: (context as any).purchase_mode ?? null,
      titleType: (context as any).title_type ?? null,
      caseType: (context as any).case_type ?? null,
      projectType: (context as any).project_type ?? null,
      developmentCondition: (context as any).project_development_condition ?? null,
      unitCategory: (context as any).unit_category ?? null,
      titleSubType: (context as any).title_sub_type ?? null,
    },
    context: buildApplicabilityContext(context),
    applicabilityMode: (masterDoc as any).applicability_mode,
    applicabilityRules: (masterDoc as any).applicability_rules,
  });
  const overrideUsed = Boolean(bypassApplicability && applicability.manuallyOverridable && applicability.applicabilityStatus === "not_applicable");
  if (applicability.applicabilityStatus === "not_applicable") {
    if (applicability.modeUsed === "rules_only") {
      await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "platform_document", entityId: masterDocId, detail: `applicabilityStatus=not_applicable mode=${applicability.modeUsed} overrideUsed=0 reasons=${applicability.applicabilityReasons.join("|")}`, ipAddress, userAgent });
      throw new DocumentGenerationError(422, "TEMPLATE_APPLICABILITY_BLOCKED", "Template blocked by applicability", { reasons: applicability.applicabilityReasons, mode: applicability.modeUsed });
    }
    if (applicability.modeUsed === "rules_with_manual_override" && !overrideUsed) {
      await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "platform_document", entityId: masterDocId, detail: `applicabilityStatus=not_applicable mode=${applicability.modeUsed} overrideUsed=0 reasons=${applicability.applicabilityReasons.join("|")}`, ipAddress, userAgent });
      throw new DocumentGenerationError(422, "TEMPLATE_APPLICABILITY_OVERRIDE_REQUIRED", "Template requires manual override", { reasons: applicability.applicabilityReasons, mode: applicability.modeUsed });
    }
  }

  const wfDocs = (await tableExists(r, "public.case_workflow_documents"))
    ? await queryRows(r, sql`
      SELECT milestone_key, object_path, file_name, updated_at
      FROM case_workflow_documents
      WHERE firm_id = ${firmId} AND case_id = ${caseId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `)
    : [];
  const workflowDocs: Record<string, { hasFile: boolean }> = {};
  for (const d of wfDocs) {
    const k = normalizeWorkflowDocumentKeyFromDb(String(d.milestone_key ?? ""));
    if (!k) continue;
    if (workflowDocs[k]) continue;
    workflowDocs[k] = { hasFile: Boolean(d.object_path && d.file_name) };
  }
  const stampingRows = (await tableExists(r, "public.case_loan_stamping_items"))
    ? await queryRows(r, sql`
      SELECT item_key, custom_name, dated_on, stamped_on, object_path, file_name, sort_order
      FROM case_loan_stamping_items
      WHERE firm_id = ${firmId} AND case_id = ${caseId} AND deleted_at IS NULL
      ORDER BY sort_order ASC, id ASC
    `)
    : [];
  const keyDates = Object.fromEntries(
    Object.entries(context as Record<string, unknown>)
      .filter(([k]) => k.endsWith("_ymd"))
      .map(([k, v]) => [k.replace(/_ymd$/, ""), typeof v === "string" ? v : null])
  );
  const readinessInput: TemplateReadinessInputs = {
    purchaseMode: normalizePurchaseMode(String((context as any).purchase_mode ?? "")) ?? null,
    titleType: normalizeTitleType(String((context as any).title_type ?? "")) ?? null,
    caseType: typeof (context as any).case_type === "string" ? String((context as any).case_type) : null,
    referenceNo: typeof (context as any).reference_no === "string" ? String((context as any).reference_no) : null,
    projectName: typeof (context as any).project_name === "string" ? String((context as any).project_name) : null,
    purchaser1Name: typeof (context as any).spa_purchaser1_name === "string" ? String((context as any).spa_purchaser1_name) : null,
    purchaser1Ic: typeof (context as any).spa_purchaser1_ic === "string" ? String((context as any).spa_purchaser1_ic) : null,
    loanTotal: typeof (context as any).total_loan_raw === "string" ? String((context as any).total_loan_raw) : null,
    loanEndFinancier: typeof (context as any).end_financier === "string" ? String((context as any).end_financier) : null,
    keyDates,
    workflowDocs,
    stampingItems: stampingRows.map((x) => ({
      itemKey: (() => {
        const raw = String(x.item_key ?? "");
        return isLoanStampingItemKey(raw) ? raw : "other";
      })(),
      customName: typeof x.custom_name === "string" ? String(x.custom_name) : null,
      datedOn: x.dated_on ? String(x.dated_on) : null,
      stampedOn: x.stamped_on ? String(x.stamped_on) : null,
      hasFile: Boolean(x.object_path && x.file_name),
      sortOrder: typeof x.sort_order === "number" ? Number(x.sort_order) : 0,
    })),
  };
  const readiness = evaluateTemplateReadiness({
    documentGroup: String((masterDoc as any).document_group ?? (masterDoc as any).category ?? "Others"),
    input: readinessInput,
  });
  if (readiness.status !== "ready") throw new DocumentGenerationError(422, "TEMPLATE_NOT_READY", "Template not ready", { status: readiness.status, missing: readiness.missing });

  const masterObjectPath = typeof (masterDoc as any).object_path === "string" ? String((masterDoc as any).object_path) : "";
  if (!masterObjectPath) throw new DocumentGenerationError(404, "MASTER_FILE_MISSING", "Master file missing");
  const fileContents = await downloadPrivateObjectBytes(masterObjectPath);

  const placeholders =
    isDocx ? detectDocxVariables(fileContents)
    : isPdf ? extractPdfMappingPlaceholders((masterDoc as any).pdf_mappings)
    : [];
  const preview = await runDocumentPreview(r, {
    firmId,
    caseContext: context,
    templateRef: { kind: "platform", documentId: masterDocId },
    placeholders,
    overrides: null,
  });
  if (preview.usedMode === "bindings" && preview.missingRequiredVariables.length > 0) {
    throw new DocumentGenerationError(422, "TEMPLATE_BINDING_MISSING", "Missing required variables", { missingRequiredVariables: preview.missingRequiredVariables });
  }
  let renderInput: Record<string, unknown> = preview.usedMode === "bindings" ? preview.resolvedVariables : (context as any);
  let docxBytesForRender: Buffer | null = null;
  let clauseSnapshot: Record<string, unknown> | null = null;
  if (isDocx) {
    docxBytesForRender = fileContents;
    if (clauses && clauses.length > 0) {
      const ins = await buildClauseInsertion({ r, firmId, selected: clauses, resolvedVariables: renderInput });
      const selectedCodes = ins.selectedClausesResolved.map((c) => c.clauseCode).filter(Boolean);
      const detection = detectClausePlaceholders(docxBytesForRender, selectedCodes);
      const mode = normalizeClauseInsertionMode((masterDoc as any).clause_insertion_mode);
      const decision = decideClauseInsertion({
        mode,
        hasClausesPlaceholder: detection.hasClausesPlaceholder,
        foundClauseCodes: detection.foundClauseCodes,
        selectedClauseCodes: selectedCodes,
      });
      if (decision.insertionTarget === "none") {
        throw new DocumentGenerationError(422, "CLAUSE_INSERTION_TARGET_NOT_FOUND", decision.insertionError || "Clause insertion target not found");
      }
      const applied = applyClauseInsertionToDocx({
        docxBytes: docxBytesForRender,
        data: renderInput,
        clausesText: ins.clausesText,
        perClauseValues: ins.perClauseValues,
        insertionMode: mode,
        selectedClauseCodes: selectedCodes,
      });
      docxBytesForRender = applied.docxBytes;
      renderInput = applied.data;
      clauseSnapshot = {
        insertionModeUsed: decision.insertionModeUsed,
        insertionTarget: decision.insertionTarget,
        hasClausesPlaceholder: detection.hasClausesPlaceholder,
        detectedClauseCodePlaceholders: detection.foundClauseCodes,
        clauseOrder: ins.clauseOrder,
        duplicateClauseWarnings: ins.duplicateClauseWarnings,
        selectedClausesResolved: ins.selectedClausesResolved.map((c) => ({
          scope: c.scope,
          id: c.id,
          clauseCode: c.clauseCode,
          title: c.title,
          includeTitle: c.includeTitle,
          body: c.body,
        })),
      };
    }
  }

  let checklistEval = evaluateTemplateChecklist({
    checklistMode: (masterDoc as any).checklist_mode,
    checklistItems: (masterDoc as any).checklist_items,
    caseContext: context as Record<string, unknown>,
    resolvedVariables: renderInput,
    uploadedDocuments: [],
    milestones: buildChecklistMilestones({ workflowDocs, context }),
    manualConfirmations: {},
  });
  let checklistOverrideUsed = false;
  {
    const caseDocs = await queryRows(r, sql`
      SELECT checklist_key, file_name, document_type, object_path
      FROM case_documents
      WHERE firm_id = ${firmId} AND case_id = ${caseId}
    `);
    const confirmPrefix = `tpl:master:${masterDocId}:confirm:`;
    const confirmationRows = (await tableExists(r, "public.case_document_checklist_items"))
      ? await queryRows(r, sql`
        SELECT checklist_key, status, completed_at, completed_by, received_at, received_by
        FROM case_document_checklist_items
        WHERE firm_id = ${firmId} AND case_id = ${caseId} AND checklist_key LIKE ${`${confirmPrefix}%`}
      `)
      : [];
    const manualConfirmations: Record<string, { checkedBy?: number | null; checkedAt?: string | null; passed: boolean }> = {};
    for (const row of confirmationRows) {
      const k = typeof row.checklist_key === "string" ? String(row.checklist_key) : "";
      const itemId = k.startsWith(confirmPrefix) ? k.slice(confirmPrefix.length) : "";
      if (!itemId) continue;
      const passed = Boolean(row.completed_at || row.received_at || row.status === "completed" || row.status === "received");
      manualConfirmations[itemId] = {
        passed,
        checkedBy: (row.completed_by ?? row.received_by) as number | null | undefined,
        checkedAt: (row.completed_at ?? row.received_at) ? String(row.completed_at ?? row.received_at) : null,
      };
    }
    checklistEval = evaluateTemplateChecklist({
      checklistMode: (masterDoc as any).checklist_mode,
      checklistItems: (masterDoc as any).checklist_items,
      caseContext: context as Record<string, unknown>,
      resolvedVariables: renderInput,
      uploadedDocuments: [
        ...caseDocs.map((d) => ({
          fileName: d.file_name ? String(d.file_name) : null,
          documentType: d.document_type ? String(d.document_type) : null,
          checklistKey: d.checklist_key ? String(d.checklist_key) : null,
          source: "case_document",
          hasFile: Boolean(d.object_path && d.file_name),
        })),
        ...wfDocs.map((d) => ({
          fileName: d.file_name ? String(d.file_name) : null,
          documentType: d.milestone_key ? String(d.milestone_key) : null,
          checklistKey: d.milestone_key ? `workflow:${String(d.milestone_key)}` : null,
          source: "workflow_document",
          hasFile: Boolean(d.object_path && d.file_name),
        })),
      ],
      milestones: buildChecklistMilestones({ workflowDocs, context }),
      manualConfirmations,
    });
    checklistOverrideUsed = Boolean(
      bypassApplicability
      && checklistEval.manuallyOverridable
      && checklistEval.checklistStatus === "blocked"
    );
    const checklistMode = normalizeChecklistMode((masterDoc as any).checklist_mode);
    if (checklistEval.checklistStatus === "blocked") {
      if (checklistMode === "required_to_generate") {
        await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "platform_document", entityId: masterDocId, detail: `checklistStatus=blocked mode=${checklistMode} overrideUsed=0 missing=${checklistEval.missingRequiredItems}`, ipAddress, userAgent });
        throw new DocumentGenerationError(422, "TEMPLATE_CHECKLIST_BLOCKED", "Template blocked by checklist", { checklist: checklistEval, mode: checklistMode });
      }
      if (checklistMode === "required_with_manual_override" && !checklistOverrideUsed) {
        await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate.blocked", entityType: "platform_document", entityId: masterDocId, detail: `checklistStatus=blocked mode=${checklistMode} overrideUsed=0 missing=${checklistEval.missingRequiredItems}`, ipAddress, userAgent });
        throw new DocumentGenerationError(422, "TEMPLATE_CHECKLIST_OVERRIDE_REQUIRED", "Template checklist requires manual override", { checklist: checklistEval, mode: checklistMode });
      }
    }
  }

  let buffer: Buffer;
  let outputMime: string;
  let outputExt: string;
  let renderMode: "docx" | "pdf" = "docx";

  if (isDocx) {
    const zip = new PizZip(docxBytesForRender ?? fileContents);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    try {
      doc.render(renderInput);
    } catch {
      throw new DocumentGenerationError(422, "TEMPLATE_RENDER_FAILED", "Template render failed");
    }
    buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
    outputMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    outputExt = ".docx";
    renderMode = "docx";
  } else if (isPdf && (masterDoc as any).pdf_mappings) {
    const mappings = (masterDoc as any).pdf_mappings as { pages: Array<{ pageIndex: number; textBoxes: Array<{ id: string; x: number; y: number; width: number; height: number; fontSize: number; content: string }> }> };
    const pdfDoc = await PDFDocument.load(fileContents);
    pdfDoc.registerFontkit(fontkit);
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    for (const pageMapping of mappings.pages) {
      const page = pages[pageMapping.pageIndex];
      if (!page) continue;
      const pageHeight = page.getHeight();
      for (const tb of pageMapping.textBoxes) {
        let text = tb.content || "";
        text = text.replace(/\{\{(\w+)\}\}/g, (_m: string, key: string) => {
            const val = (renderInput as Record<string, unknown>)[key];
          if (val === undefined || val === null) return "";
          return String(val);
        });
        const fontSize = tb.fontSize || 10;
        const pdfY = pageHeight - tb.y - fontSize;
        const pdfYBottom = pageHeight - tb.y - tb.height;
        const lines = wrapText(text, helvetica, fontSize, tb.width);
        let currentY = pdfY;
        for (const line of lines) {
          if (currentY < pdfYBottom) break;
          page.drawText(line, {
            x: tb.x,
            y: currentY,
            size: fontSize,
            font: helvetica,
            color: rgb(0, 0, 0),
          });
          currentY -= fontSize * 1.3;
        }
      }
    }
    const pdfBytes = await pdfDoc.save();
    buffer = Buffer.from(pdfBytes);
    outputMime = "application/pdf";
    outputExt = ".pdf";
    renderMode = "pdf";
  } else {
    buffer = Buffer.from(fileContents);
    outputMime = String((masterDoc as any).file_type ?? "application/octet-stream");
    outputExt = "." + (masterFileName.split(".").pop() || "bin");
    renderMode = "docx";
  }

  await queryRows(r, sql`UPDATE document_generation_runs SET render_mode = ${renderMode} WHERE id = ${runId} AND firm_id = ${firmId}`);

  if (isDocx) {
    const lhIdNum = typeof letterheadId === "number" ? letterheadId : null;
    const shouldApply = lhIdNum !== null || isMasterDocumentLetterLike({ name: (masterDoc as any).name, category: (masterDoc as any).category, fileName: masterFileName });
    if (shouldApply) {
      let lh: Record<string, unknown> | undefined;
      if (lhIdNum !== null) {
        const byId = await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE id = ${lhIdNum} AND firm_id = ${firmId}`);
        const candidate = byId[0];
        if (!candidate) throw new DocumentGenerationError(404, "LETTERHEAD_NOT_FOUND", "Letterhead not found");
        if (String((candidate as any).status ?? "active") !== "active") throw new DocumentGenerationError(409, "LETTERHEAD_INACTIVE", "Selected letterhead is inactive");
        lh = candidate;
      } else {
        const defaults = await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE firm_id = ${firmId} AND status = 'active' ORDER BY is_default DESC, created_at DESC LIMIT 1`);
        lh = defaults[0];
        if (!lh) throw new DocumentGenerationError(422, "NO_LETTERHEAD", "No active firm letterhead configured");
      }
      const firstBytes = await downloadPrivateObjectBytes(String((lh as any).first_page_object_path));
      const contBytes = await downloadPrivateObjectBytes(String((lh as any).continuation_header_object_path));
      const footerPath = (lh as any).footer_object_path ? String((lh as any).footer_object_path) : null;
      const footerBytes = footerPath ? await downloadPrivateObjectBytes(footerPath) : null;
      const footerMode = (lh as any).footer_mode === "last_page_only" ? "last_page_only" : "every_page";
      buffer = await applyLetterheadToDocxBuffer({
        baseDocx: buffer,
        firstPageTemplateDocx: firstBytes,
        continuationHeaderTemplateDocx: contBytes,
        footerTemplateDocx: footerBytes,
        footerMode,
      });
    }
  }

  const normalizedPath = newGeneratedDocObjectPath(firmId, caseId, outputExt);
  await supabaseStorage.uploadPrivateObject({
    objectPath: normalizedPath,
    fileBytes: buffer,
    contentType: outputMime,
  });
  const docName = documentName ?? String((masterDoc as any).name ?? "Generated document");
  const templateCode = String((masterDoc as any).category ?? (masterDoc as any).name ?? "DOC");
  const sequence = await nextCaseDocumentSequence(r, firmId, caseId);
  const namingRule = typeof (masterDoc as any).file_naming_rule === "string" ? String((masterDoc as any).file_naming_rule) : null;
  const namingPreview = resolveDocumentFileName({
    ctx: buildNamingContext({
      caseId,
      firmId,
      context,
      documentName: docName,
      templateName: String((masterDoc as any).name ?? ""),
      sequence,
    }),
    rule: namingRule,
    originalFileNameOrExt: outputExt,
    fallbackExt: outputExt,
  });
  const uniq = await ensureUniqueCaseDocumentFileName({
    r,
    firmId,
    caseId,
    desiredFileName: namingPreview.fileName,
  });
  const fileName = uniq.fileName;
  const namingSnapshot = {
    namingRuleUsed: namingPreview.ruleUsed,
    resolvedFileName: fileName,
    namingWarnings: namingPreview.warnings,
    namingFallbackUsed: namingPreview.fallbackUsed,
    collisionResolved: uniq.collisionResolved,
    collisionSuffixApplied: uniq.collisionSuffixApplied,
  };
  const savedRows = await queryRows(r, sql`
    INSERT INTO case_documents (case_id, firm_id, template_source, platform_document_id, template_snapshot_name, template_snapshot_updated_at, name, document_type, status, object_path, file_name, generated_by, clause_snapshot, naming_snapshot)
    VALUES (${caseId}, ${firmId}, 'master', ${masterDocId}, ${String((masterDoc as any).name ?? "")}, ${(masterDoc as any).created_at ?? null}, ${docName}, ${(masterDoc as any).category ?? "other"}, 'generated', ${normalizedPath}, ${fileName}, ${actorId}, ${clauseSnapshot as any}, ${namingSnapshot as any})
    RETURNING *
  `);
  const created = savedRows[0];
  const createdId = created && typeof created === "object" && "id" in created && typeof (created as any).id === "number"
    ? Number((created as any).id)
    : null;
  await writeAuditLog({ firmId, actorId, actorType, action: "documents.case.generate_from_master", entityType: "case_document", entityId: createdId ?? undefined, detail: `caseId=${caseId} masterDocId=${masterDocId} name=${docName} clauses=${clauseSnapshot ? "yes" : "no"} fileName=${fileName} fallback=${namingPreview.fallbackUsed ? "1" : "0"} collision=${uniq.collisionResolved ? "1" : "0"} applicabilityStatus=${applicability.applicabilityStatus} applicabilityOverrideUsed=${overrideUsed ? "1" : "0"} checklistStatus=${checklistEval.checklistStatus} checklistOverrideUsed=${checklistOverrideUsed ? "1" : "0"}`, ipAddress, userAgent });
  if (preview.usedMode === "bindings") {
    await writeAuditLog({ firmId, actorId, actorType, action: "documents.generate.binding_used", entityType: "case_document", entityId: createdId ?? undefined, detail: `caseId=${caseId} platformDocumentId=${masterDocId} placeholders=${placeholders.length} missing=${preview.missingRequiredVariables.length}`, ipAddress, userAgent });
  }
  return {
    caseDocument: created,
    caseDocumentId: createdId,
    templateVersionId: null,
    checklistSnapshot: { applicability, checklist: checklistEval, checklistOverrideUsed, bindingMode: preview.usedMode, placeholderWarnings: preview.placeholderWarnings },
    readinessSnapshot: { readiness },
    renderedVars: preview.usedMode === "bindings" ? preview.resolvedVariables : context,
    renderMode,
  };
}

router.post("/cases/:caseId/documents/batch-generate", requireAuth, requireFirmUser, requirePermission("documents", "generate"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const items = Array.isArray(body.items) ? body.items : [];
  const letterheadId = typeof body.letterheadId === "number" ? body.letterheadId : null;
  const bypass = Boolean(body.bypassApplicability ?? false) ? await canBypassApplicability(r, req.firmId!, req.roleId) : false;
  if (items.length === 0) {
    res.status(422).json({ error: "items is required", code: "ITEMS_REQUIRED" });
    return;
  }

  const jobId = randomUUID();
  await queryRows(r, sql`
    INSERT INTO document_batch_jobs (id, firm_id, case_id, job_type, status, total_count, pending_count, created_by, started_at)
    VALUES (${jobId}::uuid, ${req.firmId!}, ${caseId}, 'generate', 'running', ${items.length}, ${items.length}, ${req.userId!}, now())
  `);
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.batch_generate", entityType: "document_batch_job", entityId: undefined, detail: `jobId=${jobId} caseId=${caseId} total=${items.length}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });

  const results: Array<Record<string, unknown>> = [];
  let success = 0;
  let failed = 0;

  for (const raw of items) {
    const it = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const source = it.source === "master" ? "master" : "firm";
    const templateId = typeof it.templateId === "number" ? it.templateId : NaN;
    const documentName = typeof it.documentName === "string" ? it.documentName : undefined;
    const itemRows = await queryRows(r, sql`
      INSERT INTO document_batch_job_items (job_id, firm_id, case_id, template_source, template_id, platform_document_id, status)
      VALUES (${jobId}::uuid, ${req.firmId!}, ${caseId}, ${source}, ${source === "firm" ? templateId : null}, ${source === "master" ? templateId : null}, 'running')
      RETURNING id
    `);
    const itemId = typeof itemRows[0]?.id === "number" ? Number(itemRows[0].id) : null;

    const runId = await createGenerationRun(r, {
      firm_id: req.firmId!,
      case_id: caseId,
      template_source: source,
      template_id: source === "firm" ? templateId : null,
      template_version_id: null,
      platform_document_id: source === "master" ? templateId : null,
      document_name: documentName ?? "Generated document",
      render_mode: "docx",
      status: "running",
      rendered_variables_snapshot: null,
      checklist_snapshot: null,
      readiness_snapshot: null,
      triggered_by: req.userId!,
      error_code: null,
      error_message: null,
    });

    try {
      if (Number.isNaN(templateId)) throw new DocumentGenerationError(422, "INVALID_TEMPLATE_ID", "Invalid templateId");
      if (source === "firm") {
        const out = await generateFirmDocument({
          r,
          firmId: req.firmId!,
          actorId: req.userId!,
          actorType: req.userType,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
          caseId,
          templateId,
          documentName,
          letterheadId,
          runId,
          bypassApplicability: bypass,
        });
        await finishGenerationRunSuccess(r, req.firmId!, runId, out.caseDocumentId, out.renderedVars, out.checklistSnapshot, out.readinessSnapshot);
        await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.succeeded", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=${source} templateId=${templateId} jobId=${jobId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
        await queryRows(r, sql`UPDATE document_batch_job_items SET status='success', case_document_id=${out.caseDocumentId}, finished_at=now(), template_version_id=${out.templateVersionId} WHERE id=${itemId ?? 0} AND firm_id=${req.firmId!}`);
        success += 1;
        results.push({ itemId, runId, source, templateId, status: "success", caseDocumentId: out.caseDocumentId });
      } else {
        const out = await generateMasterDocument({
          r,
          firmId: req.firmId!,
          actorId: req.userId!,
          actorType: req.userType,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
          caseId,
          masterDocId: templateId,
          documentName,
          letterheadId,
          runId,
          bypassApplicability: bypass,
        });
        await finishGenerationRunSuccess(r, req.firmId!, runId, out.caseDocumentId, out.renderedVars, out.checklistSnapshot, out.readinessSnapshot);
        await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.succeeded", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=${source} templateId=${templateId} jobId=${jobId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
        await queryRows(r, sql`UPDATE document_batch_job_items SET status='success', case_document_id=${out.caseDocumentId}, finished_at=now() WHERE id=${itemId ?? 0} AND firm_id=${req.firmId!}`);
        success += 1;
        results.push({ itemId, runId, source, templateId, status: "success", caseDocumentId: out.caseDocumentId, renderMode: out.renderMode });
      }
    } catch (err: unknown) {
      const cfgErr = getSupabaseStorageConfigError(err);
      const e =
        cfgErr ? new DocumentGenerationError(cfgErr.statusCode, "STORAGE_NOT_CONFIGURED", cfgErr.error)
        : err instanceof ObjectNotFoundError
          ? new DocumentGenerationError(404, source === "firm" ? "TEMPLATE_FILE_NOT_FOUND" : "MASTER_FILE_NOT_FOUND", source === "firm" ? "Template file not found" : "Master file not found")
          : err instanceof DocumentGenerationError
            ? err
            : new DocumentGenerationError(500, "INTERNAL_ERROR", "Internal Server Error");
      await finishGenerationRunFailed(r, req.firmId!, runId, e.code, e.message);
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=${source} templateId=${templateId} jobId=${jobId} code=${e.code}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      await queryRows(r, sql`UPDATE document_batch_job_items SET status='failed', error_code=${e.code}, error_message=${e.message}, finished_at=now() WHERE id=${itemId ?? 0} AND firm_id=${req.firmId!}`);
      failed += 1;
      results.push({ itemId, runId, source, templateId, status: "failed", errorCode: e.code, errorMessage: e.message, ...(e.payload ? { payload: e.payload } : {}) });
    }
  }

  const pending = Math.max(items.length - success - failed, 0);
  const status = failed > 0 ? "completed" : "completed";
  await queryRows(r, sql`
    UPDATE document_batch_jobs
    SET status = ${status},
        total_count = ${items.length},
        success_count = ${success},
        failed_count = ${failed},
        pending_count = ${pending},
        finished_at = now()
    WHERE id = ${jobId}::uuid AND firm_id = ${req.firmId!}
  `);
  res.status(201).json({ jobId, total: items.length, success, failed, pending, items: results });
});

router.post("/cases/:caseId/documents/batch-export", requireAuth, requireFirmUser, requirePermission("documents", "export"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const idsRaw = Array.isArray(body.documentIds) ? body.documentIds : [];
  const docIds = Array.from(new Set(idsRaw.filter((x): x is number => typeof x === "number" && Number.isFinite(x))));
  if (docIds.length === 0) {
    res.status(422).json({ error: "documentIds is required", code: "DOCUMENT_IDS_REQUIRED" });
    return;
  }
  if (docIds.length > 50) {
    res.status(422).json({ error: "Too many documents", code: "TOO_MANY_DOCUMENTS", limit: 50 });
    return;
  }

  const rows = await queryRows(r, sql`
    SELECT id, object_path, file_name, name, template_source, template_id, platform_document_id
    FROM case_documents
    WHERE firm_id = ${req.firmId!} AND case_id = ${caseId}
      AND id IN (${sql.join(docIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY created_at DESC
  `);
  if (rows.length !== docIds.length) {
    res.status(404).json({ error: "One or more documents not found", code: "DOCUMENT_NOT_FOUND" });
    return;
  }

  const jobId = randomUUID();
  await queryRows(r, sql`
    INSERT INTO document_batch_jobs (id, firm_id, case_id, job_type, status, total_count, pending_count, created_by, started_at)
    VALUES (${jobId}::uuid, ${req.firmId!}, ${caseId}, 'export', 'running', ${rows.length}, ${rows.length}, ${req.userId!}, now())
  `);
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.batch_export", entityType: "document_batch_job", entityId: undefined, detail: `jobId=${jobId} caseId=${caseId} total=${rows.length}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });

  for (const d of rows) {
    const src =
      d.template_source === "master" ? "master"
      : d.template_source === "firm" ? "firm"
      : (d.platform_document_id ? "master" : "firm");
    await queryRows(r, sql`
      INSERT INTO document_batch_job_items (job_id, firm_id, case_id, template_source, template_id, platform_document_id, case_document_id, status)
      VALUES (${jobId}::uuid, ${req.firmId!}, ${caseId}, ${src}, ${src === "firm" ? (d.template_id as any) : null}, ${src === "master" ? (d.platform_document_id as any) : null}, ${d.id as any}, 'running')
    `);
  }

  try {
    const entries = rows.map((d) => ({
      zipPath: safeFilenameAscii(String(d.file_name ?? d.name ?? `document-${d.id}`)) || `document-${d.id}`,
      objectPath: String(d.object_path ?? ""),
    }));
    if (entries.some((e) => !e.objectPath)) {
      throw new DocumentGenerationError(422, "DOCUMENT_FILE_MISSING", "One or more document files missing");
    }
    const zipBytes = await buildZipBufferFromPrivateObjects(entries);
    const context = await buildCaseContext(r, caseId, req.firmId!);
    const outName = resolveSmartFilename({
      ctx: {
        caseId,
        firmId: req.firmId!,
        caseReferenceNo: String((context as any)?.reference_no ?? ""),
        parcelNo: String((context as any)?.parcel_no ?? ""),
        clientName: String((context as any)?.spa_purchaser1_name ?? (context as any)?.borrower1_name ?? ""),
        projectName: String((context as any)?.project_name ?? ""),
        developerName: String((context as any)?.developer_name ?? ""),
        documentName: "Documents Export",
        templateName: "",
        status: String((context as any)?.case_status ?? (context as any)?.status ?? ""),
        titleType: String((context as any)?.title_type ?? ""),
        loanBank: String((context as any)?.loan_end_financier ?? ""),
        sequence: await nextCaseDocumentSequence(r, req.firmId!, caseId),
      },
      rule: null,
      originalFileNameOrExt: "zip",
      fallbackExt: "zip",
    }).fileName;
    const objectPath = `/objects/cases/${req.firmId!}/case-${caseId}/batch-exports/${jobId}.zip`;
    await supabaseStorage.uploadPrivateObject({ objectPath, fileBytes: zipBytes, contentType: "application/zip" });

    await queryRows(r, sql`
      UPDATE document_batch_jobs
      SET status = 'completed',
          total_count = ${rows.length},
          success_count = ${rows.length},
          failed_count = 0,
          pending_count = 0,
          finished_at = now(),
          download_object_path = ${objectPath},
          download_file_name = ${outName},
          download_mime_type = 'application/zip'
      WHERE id = ${jobId}::uuid AND firm_id = ${req.firmId!}
    `);
    await queryRows(r, sql`
      UPDATE document_batch_job_items
      SET status = 'success', finished_at = now()
      WHERE job_id = ${jobId}::uuid AND firm_id = ${req.firmId!}
    `);
    res.status(201).json({ jobId, status: "completed", downloadPath: `/document-batch-jobs/${jobId}/download`, downloadFileName: outName });
  } catch (err: unknown) {
    const cfgErr = getSupabaseStorageConfigError(err);
    const e =
      cfgErr ? new DocumentGenerationError(cfgErr.statusCode, "STORAGE_NOT_CONFIGURED", cfgErr.error)
      : err instanceof ObjectNotFoundError ? new DocumentGenerationError(404, "DOCUMENT_FILE_NOT_FOUND", "One or more document files not found")
      : err instanceof DocumentGenerationError ? err
      : new DocumentGenerationError(500, "INTERNAL_ERROR", "Internal Server Error");

    await queryRows(r, sql`
      UPDATE document_batch_jobs
      SET status = 'failed',
          failed_count = ${rows.length},
          pending_count = 0,
          finished_at = now(),
          error_summary = ${`${e.code}: ${e.message}`}
      WHERE id = ${jobId}::uuid AND firm_id = ${req.firmId!}
    `);
    await queryRows(r, sql`
      UPDATE document_batch_job_items
      SET status = 'failed', error_code = ${e.code}, error_message = ${e.message}, finished_at = now()
      WHERE job_id = ${jobId}::uuid AND firm_id = ${req.firmId!}
    `);
    res.status(e.statusCode).json({ error: e.message, code: e.code });
  }
});

router.get("/document-batch-jobs/:jobId", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const jobId = one((req.params as any).jobId) ?? "";
  if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }
  const jobs = await queryRows(r, sql`SELECT * FROM document_batch_jobs WHERE id = ${jobId}::uuid AND firm_id = ${req.firmId!}`);
  const job = jobs[0];
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const items = await queryRows(r, sql`SELECT * FROM document_batch_job_items WHERE job_id = ${jobId}::uuid AND firm_id = ${req.firmId!} ORDER BY id ASC`);
  res.json({ job, items });
});

router.get("/document-batch-jobs/:jobId/download", requireAuth, requireFirmUser, requirePermission("documents", "export"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const jobId = one((req.params as any).jobId) ?? "";
  if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) {
    res.status(400).json({ error: "Invalid jobId" });
    return;
  }
  const jobs = await queryRows(r, sql`SELECT * FROM document_batch_jobs WHERE id = ${jobId}::uuid AND firm_id = ${req.firmId!}`);
  const job = jobs[0];
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const objectPath = typeof (job as any).download_object_path === "string" ? String((job as any).download_object_path) : "";
  if (!objectPath) {
    res.status(404).json({ error: "Download not available", code: "DOWNLOAD_NOT_READY" });
    return;
  }
  try {
    const fileName = typeof (job as any).download_file_name === "string" ? String((job as any).download_file_name) : `export-${jobId}.zip`;
    await streamSupabasePrivateObjectToResponse({ objectPath, res, fileName, fallbackContentType: "application/zip" });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.batch_export.download", entityType: "document_batch_job", entityId: undefined, detail: `jobId=${jobId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  } catch (err) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      res.status(cfgErr.statusCode).json({ error: cfgErr.error, code: "STORAGE_NOT_CONFIGURED" });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, jobId }, "[documents] batch_download_failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

async function canBypassApplicability(r: DbConn, firmId: number, roleId: number | null | undefined): Promise<boolean> {
  if (!roleId) return false;
  const rows = await queryRows(r, sql`SELECT name FROM roles WHERE id = ${roleId} AND firm_id = ${firmId} LIMIT 1`);
  const name = rows[0]?.name ? String(rows[0].name).toLowerCase() : "";
  return name.includes("partner") || name.includes("admin");
}

router.post("/cases/:caseId/documents/filename-preview", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const templateId = typeof body.templateId === "number" ? body.templateId : null;
  const platformDocumentId = typeof body.platformDocumentId === "number" ? body.platformDocumentId : null;
  const documentName = typeof body.documentName === "string" ? body.documentName.trim() : "";
  const originalFileName = typeof body.originalFileName === "string" ? body.originalFileName.trim() : null;
  const fallbackExt = typeof body.fallbackExt === "string" ? body.fallbackExt.trim() : "docx";

  if (!templateId && !platformDocumentId && !documentName) {
    res.status(422).json({ error: "templateId/platformDocumentId or documentName is required" });
    return;
  }
  if (templateId && platformDocumentId) {
    res.status(422).json({ error: "Provide only one of templateId or platformDocumentId" });
    return;
  }

  const context = await buildCaseContext(r, caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  let rule: string | null = null;
  let templateName = "";
  if (templateId) {
    const tplRows = await queryRows(r, sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
    const tpl = tplRows[0];
    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    templateName = String((tpl as any).name ?? "");
    rule = typeof (tpl as any).file_naming_rule === "string" ? String((tpl as any).file_naming_rule) : null;
  } else if (platformDocumentId) {
    const rows = await queryRows(r, sql`SELECT * FROM platform_documents WHERE id = ${platformDocumentId}`);
    const doc = rows[0];
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    templateName = String((doc as any).name ?? "");
    rule = typeof (doc as any).file_naming_rule === "string" ? String((doc as any).file_naming_rule) : null;
  }

  const sequence = await nextCaseDocumentSequence(r, req.firmId!, caseId);
  const preview = resolveDocumentFileName({
    ctx: buildNamingContext({
      caseId,
      firmId: req.firmId!,
      context,
      documentName: documentName || templateName || "Document",
      templateName,
      sequence,
    }),
    rule,
    originalFileNameOrExt: originalFileName,
    fallbackExt,
  });

  res.json(preview);
});

router.get("/clauses", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;

  const q = typeof (req.query as any).q === "string" ? String((req.query as any).q).trim() : "";
  const scope = typeof (req.query as any).scope === "string" ? String((req.query as any).scope).trim() : "all";
  const category = typeof (req.query as any).category === "string" ? String((req.query as any).category).trim() : "";
  const status = typeof (req.query as any).status === "string" ? String((req.query as any).status).trim() : "";
  const tag = typeof (req.query as any).tag === "string" ? String((req.query as any).tag).trim() : "";
  const language = typeof (req.query as any).language === "string" ? String((req.query as any).language).trim() : "";
  const includeBody = truthy((req.query as any).includeBody);
  const caseIdParam = typeof (req.query as any).caseId === "string" ? parseInt(String((req.query as any).caseId), 10) : NaN;
  const caseId = Number.isFinite(caseIdParam) ? caseIdParam : null;
  const caseContext = caseId ? await buildCaseContext(r, caseId, req.firmId!) : null;

  const parts: Array<{ scope: "firm" | "platform"; rows: Record<string, unknown>[] }> = [];

  if (scope === "all" || scope === "firm") {
    const where: any[] = [sql`firm_id = ${req.firmId!}`];
    if (status) where.push(sql`status = ${status}`);
    if (category) where.push(sql`category = ${category}`);
    if (language) where.push(sql`language = ${language}`);
    if (tag) where.push(sql`tags @> ARRAY[${tag}]::text[]`);
    if (q) where.push(sql`(clause_code ILIKE ${"%" + q + "%"} OR title ILIKE ${"%" + q + "%"} OR body ILIKE ${"%" + q + "%"} OR COALESCE(notes,'') ILIKE ${"%" + q + "%"})`);
    const cols = includeBody ? sql`*` : sql`id, firm_id, source_platform_clause_id, clause_code, title, category, language, notes, tags, status, is_system, sort_order, applicability, created_by, updated_by, created_at, updated_at`;
    const rows = await queryRows(r, sql`SELECT ${cols} FROM firm_clauses WHERE ${sql.join(where, sql` AND `)} ORDER BY sort_order ASC, clause_code ASC`);
    parts.push({ scope: "firm", rows });
  }

  if (scope === "all" || scope === "platform") {
    const where: any[] = [sql`1=1`];
    if (status) where.push(sql`status = ${status}`);
    if (category) where.push(sql`category = ${category}`);
    if (language) where.push(sql`language = ${language}`);
    if (tag) where.push(sql`tags @> ARRAY[${tag}]::text[]`);
    if (q) where.push(sql`(clause_code ILIKE ${"%" + q + "%"} OR title ILIKE ${"%" + q + "%"} OR body ILIKE ${"%" + q + "%"} OR COALESCE(notes,'') ILIKE ${"%" + q + "%"})`);
    const cols = includeBody ? sql`*` : sql`id, clause_code, title, category, language, notes, tags, status, is_system, sort_order, applicability, created_by, updated_by, created_at, updated_at`;
    const rows = await queryRows(r, sql`SELECT ${cols} FROM platform_clauses WHERE ${sql.join(where, sql` AND `)} ORDER BY sort_order ASC, clause_code ASC`);
    parts.push({ scope: "platform", rows });
  }

  const out = parts.flatMap((p) => p.rows.map((row) => {
    const app = row.applicability && typeof row.applicability === "object" ? (row.applicability as Record<string, unknown>) : null;
    const applicable = caseContext ? isClauseApplicable(app, caseContext as any) : true;
    return {
      ...row,
      scope: p.scope,
      applicable,
    };
  }));

  res.json(out);
});

router.get("/clauses/:scope/:id/preview", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const scope = one((req.params as any).scope) === "platform" ? "platform" : "firm";
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const row = scope === "platform"
    ? await getPlatformClauseById(r, id)
    : await getFirmClauseById(r, req.firmId!, id);
  if (!row) {
    res.status(404).json({ error: "Clause not found" });
    return;
  }
  const body = typeof (row as any).body === "string" ? String((row as any).body) : "";
  const scan = await findUnknownVariablesInClause(r, body);
  res.json({ variables: scan.variables, unknownVariables: scan.unknown });
});

router.post("/clauses", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const clauseCode = normalizeClauseCode(typeof body.clauseCode === "string" ? body.clauseCode : title);
  const category = typeof body.category === "string" ? body.category.trim() : "General";
  const language = typeof body.language === "string" ? body.language.trim() : "en";
  const clauseBody = typeof body.body === "string" ? body.body : "";
  const notes = typeof body.notes === "string" ? body.notes : null;
  const tags = Array.isArray(body.tags) ? body.tags.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map((x) => x.trim()) : [];
  const status = typeof body.status === "string" ? body.status : "draft";
  const sortOrder = typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder) ? Math.floor(body.sortOrder) : 0;
  const applicability = body.applicability && typeof body.applicability === "object" ? (body.applicability as Record<string, unknown>) : null;

  if (!title || !clauseBody) {
    res.status(400).json({ error: "Missing title or body" });
    return;
  }

  const rows = await queryRows(r, sql`
    INSERT INTO firm_clauses (
      firm_id, source_platform_clause_id, clause_code, title, category, language,
      body, notes, tags, status, is_system, sort_order, applicability,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${req.firmId!}, NULL, ${clauseCode}, ${title}, ${category}, ${language},
      ${clauseBody}, ${notes as any}, ${tags as any}, ${status}, false, ${sortOrder}, ${applicability as any},
      ${req.userId ?? null}, ${req.userId ?? null}, now(), now()
    )
    RETURNING *
  `);
  const created = rows[0];
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "clauses.firm.create", entityType: "firm_clause", entityId: typeof (created as any)?.id === "number" ? Number((created as any).id) : undefined, detail: `clauseCode=${clauseCode}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(created);
});

router.put("/clauses/:id", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const patch: any[] = [];
  const title = typeof body.title === "string" ? body.title.trim() : null;
  const clauseCode = typeof body.clauseCode === "string" ? normalizeClauseCode(body.clauseCode) : null;
  const category = typeof body.category === "string" ? body.category.trim() : null;
  const language = typeof body.language === "string" ? body.language.trim() : null;
  const clauseBody = typeof body.body === "string" ? body.body : null;
  const notes = Object.prototype.hasOwnProperty.call(body, "notes") ? (typeof body.notes === "string" ? body.notes : null) : undefined;
  const tags = Object.prototype.hasOwnProperty.call(body, "tags") ? (Array.isArray(body.tags) ? body.tags.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map((x) => x.trim()) : []) : undefined;
  const status = typeof body.status === "string" ? body.status : null;
  const sortOrder = typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder) ? Math.floor(body.sortOrder) : null;
  const applicability = Object.prototype.hasOwnProperty.call(body, "applicability") ? (body.applicability && typeof body.applicability === "object" ? (body.applicability as Record<string, unknown>) : null) : undefined;

  if (title !== null) patch.push(sql`title = ${title}`);
  if (clauseCode !== null) patch.push(sql`clause_code = ${clauseCode}`);
  if (category !== null) patch.push(sql`category = ${category}`);
  if (language !== null) patch.push(sql`language = ${language}`);
  if (clauseBody !== null) patch.push(sql`body = ${clauseBody}`);
  if (notes !== undefined) patch.push(sql`notes = ${notes as any}`);
  if (tags !== undefined) patch.push(sql`tags = ${tags as any}`);
  if (status !== null) patch.push(sql`status = ${status}`);
  if (sortOrder !== null) patch.push(sql`sort_order = ${sortOrder}`);
  if (applicability !== undefined) patch.push(sql`applicability = ${applicability as any}`);
  patch.push(sql`updated_by = ${req.userId ?? null}`);
  patch.push(sql`updated_at = now()`);

  if (patch.length === 0) { res.status(400).json({ error: "No changes" }); return; }

  const rows = await queryRows(r, sql`
    UPDATE firm_clauses
    SET ${sql.join(patch, sql`, `)}
    WHERE firm_id = ${req.firmId!} AND id = ${id}
    RETURNING *
  `);
  if (!rows[0]) { res.status(404).json({ error: "Clause not found" }); return; }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "clauses.firm.update", entityType: "firm_clause", entityId: id, detail: `clauseId=${id}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(rows[0]);
});

router.post("/clauses/platform/:id/copy", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const idStr = one((req.params as any).id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const src = await getPlatformClauseById(r, id);
  if (!src) { res.status(404).json({ error: "Platform clause not found" }); return; }
  const clauseCode = normalizeClauseCode(String((src as any).clause_code ?? ""));
  const title = String((src as any).title ?? "");
  const category = String((src as any).category ?? "General");
  const language = String((src as any).language ?? "en");
  const clauseBody = String((src as any).body ?? "");
  const notes = (src as any).notes ? String((src as any).notes) : null;
  const tags = Array.isArray((src as any).tags) ? (src as any).tags : [];
  const applicability = (src as any).applicability ?? null;

  const rows = await queryRows(r, sql`
    INSERT INTO firm_clauses (
      firm_id, source_platform_clause_id, clause_code, title, category, language,
      body, notes, tags, status, is_system, sort_order, applicability,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${req.firmId!}, ${id}, ${clauseCode}, ${title}, ${category}, ${language},
      ${clauseBody}, ${notes as any}, ${tags as any}, 'draft', false, ${Number((src as any).sort_order ?? 0)}, ${applicability as any},
      ${req.userId ?? null}, ${req.userId ?? null}, now(), now()
    )
    ON CONFLICT (firm_id, clause_code)
    DO UPDATE SET
      title = EXCLUDED.title,
      category = EXCLUDED.category,
      language = EXCLUDED.language,
      body = EXCLUDED.body,
      notes = EXCLUDED.notes,
      tags = EXCLUDED.tags,
      applicability = EXCLUDED.applicability,
      source_platform_clause_id = EXCLUDED.source_platform_clause_id,
      updated_by = ${req.userId ?? null},
      updated_at = now()
    RETURNING *
  `);
  const created = rows[0];
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "clauses.platform.copy_to_firm", entityType: "platform_clause", entityId: id, detail: `firmClauseCode=${clauseCode}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(created);
});

router.post("/cases/:caseId/documents/preview", requireAuth, requireFirmUser, requirePermission("documents", "generate"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const templateId = typeof body.templateId === "number" ? body.templateId : null;
  const platformDocumentId = typeof body.platformDocumentId === "number" ? body.platformDocumentId : null;
  const overrides = (body.overrides && typeof body.overrides === "object") ? (body.overrides as Record<string, unknown>) : null;
  const clauseRefsRaw = Array.isArray(body.clauses) ? body.clauses : [];
  const clauseRefs: SelectedClauseRef[] = clauseRefsRaw
    .map((x) => (x && typeof x === "object") ? (x as Record<string, unknown>) : null)
    .filter((x): x is Record<string, unknown> => Boolean(x))
    .map((x) => ({
      scope: x.scope === "platform" ? ("platform" as const) : ("firm" as const),
      id: typeof x.id === "number" ? x.id : NaN,
      includeTitle: typeof x.includeTitle === "boolean" ? x.includeTitle : false,
    }))
    .filter((x) => Number.isFinite(x.id));
  const bypassReq = Boolean(body.bypassApplicability ?? false);
  const bypass = bypassReq ? await canBypassApplicability(r, req.firmId!, req.roleId) : false;

  if (!templateId && !platformDocumentId) {
    res.status(422).json({ error: "templateId or platformDocumentId is required", code: "TEMPLATE_ID_REQUIRED" });
    return;
  }
  if (templateId && platformDocumentId) {
    res.status(422).json({ error: "Provide only one of templateId or platformDocumentId", code: "TEMPLATE_ID_CONFLICT" });
    return;
  }

  const context = await buildCaseContext(r, caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  try {
    if (templateId) {
      const tplRows = await queryRows(r, sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`);
      const tpl = tplRows[0];
      if (!tpl) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      const vRows = await queryRows(r, sql`
        SELECT * FROM document_template_versions
        WHERE firm_id = ${req.firmId!} AND template_id = ${templateId} AND status = 'published'
        ORDER BY published_at DESC NULLS LAST, version_no DESC
        LIMIT 1
      `);
      const v = vRows[0];
      const obj = typeof (v as any)?.source_object_path === "string" ? String((v as any).source_object_path) : String((tpl as any).object_path ?? "");
      const filename = typeof (v as any)?.filename === "string" ? String((v as any).filename) : String((tpl as any).file_name ?? "");
      if (!obj) {
        res.status(404).json({ error: "Template file missing", code: "TEMPLATE_FILE_MISSING" });
        return;
      }
      const ext = fileExtensionFromName(filename);
      const extra = await getFirmTemplateApplicabilityRules(r, req.firmId!, templateId);
      const appV2 = evaluateTemplateApplicabilityV2({
        legacyTemplate: {
          isActive: extra?.isActive ?? Boolean((tpl as any).is_active ?? true),
          isTemplateCapable: extra?.isTemplateCapable ?? Boolean((tpl as any).is_template_capable ?? true),
          appliesToPurchaseMode: extra?.purchaseMode ?? ((tpl as any).applies_to_purchase_mode ? String((tpl as any).applies_to_purchase_mode) : null),
          appliesToTitleType: extra?.titleType ?? ((tpl as any).applies_to_title_type ? String((tpl as any).applies_to_title_type) : null),
          appliesToCaseType: (tpl as any).applies_to_case_type ? String((tpl as any).applies_to_case_type) : null,
          projectType: extra?.projectType ?? null,
          titleSubType: extra?.titleSubType ?? null,
          developmentCondition: extra?.developmentCondition ?? null,
          unitCategory: extra?.unitCategory ?? null,
        },
        legacyInput: {
          purchaseMode: (context as any).purchase_mode ?? null,
          titleType: (context as any).title_type ?? null,
          caseType: (context as any).case_type ?? null,
          projectType: (context as any).project_type ?? null,
          developmentCondition: (context as any).project_development_condition ?? null,
          unitCategory: (context as any).unit_category ?? null,
          titleSubType: (context as any).title_sub_type ?? null,
        },
        context: buildApplicabilityContext(context),
        applicabilityMode: (tpl as any).applicability_mode,
        applicabilityRules: (tpl as any).applicability_rules,
      });
      const applicabilityResult = {
        applicable: appV2.applicabilityStatus !== "not_applicable",
        reasons: appV2.applicabilityReasons,
        status: appV2.applicabilityStatus,
        matchedRulesCount: appV2.matchedRulesCount,
        failedRulesCount: appV2.failedRulesCount,
        manuallyOverridable: appV2.manuallyOverridable,
      };

      let placeholders: string[] = [];
      let renderMode: "docx" | "pdf" | "print" = "docx";
      let placeholderWarnings: PlaceholderWarning[] = [];
      let renderable = true;

      if (ext === "docx") {
        let bytes = await downloadPrivateObjectBytes(obj);
        placeholders = placeholdersFromVariablesSnapshot((v as any)?.variables_snapshot);
        if (placeholders.length === 0) placeholders = detectDocxVariables(bytes);
        const preview = await runDocumentPreview(r, {
          firmId: req.firmId!,
          caseContext: context,
          templateRef: { kind: "firm", templateId },
          placeholders,
          overrides,
        });
        placeholderWarnings = preview.placeholderWarnings;
        let input: Record<string, unknown> = preview.usedMode === "bindings" ? preview.resolvedVariables : (context as any);
        let clausePreviewText = "";
        let clauseWarnings: unknown[] = [];
        let duplicateClauseWarnings: unknown[] = [];
        let insertionModeUsed: string | null = null;
        let insertionTarget: string | null = null;
        let insertionError: string | null = null;
        let hasClausesPlaceholder: boolean | null = null;
        let detectedClauseCodePlaceholders: string[] = [];
        let clauseOrder: unknown[] = [];
        let selectedClausesResolved: unknown[] = [];
        if (clauseRefs.length > 0) {
          const ins = await buildClauseInsertion({ r, firmId: req.firmId!, selected: clauseRefs, resolvedVariables: input });
          clausePreviewText = ins.clausesText;
          clauseWarnings = ins.warnings;
          duplicateClauseWarnings = ins.duplicateClauseWarnings;
          clauseOrder = ins.clauseOrder;
          selectedClausesResolved = ins.selectedClausesResolved.map((c) => ({
            scope: c.scope,
            id: c.id,
            clauseCode: c.clauseCode,
            title: c.title,
            includeTitle: c.includeTitle,
            body: c.body,
          }));
          const selectedCodes = ins.selectedClausesResolved.map((c) => c.clauseCode).filter(Boolean);
          const detection = detectClausePlaceholders(bytes, selectedCodes);
          hasClausesPlaceholder = detection.hasClausesPlaceholder;
          detectedClauseCodePlaceholders = detection.foundClauseCodes;
          const mode = normalizeClauseInsertionMode((tpl as any).clause_insertion_mode);
          const decision = decideClauseInsertion({ mode, hasClausesPlaceholder: detection.hasClausesPlaceholder, foundClauseCodes: detection.foundClauseCodes, selectedClauseCodes: selectedCodes });
          insertionModeUsed = decision.insertionModeUsed;
          insertionTarget = decision.insertionTarget;
          insertionError = decision.insertionError;
          const applied = applyClauseInsertionToDocx({
            docxBytes: bytes,
            data: input,
            clausesText: ins.clausesText,
            perClauseValues: ins.perClauseValues,
            insertionMode: mode,
            selectedClauseCodes: selectedCodes,
          });
          bytes = applied.docxBytes;
          input = applied.data;
        }
        const caseDocs = await queryRows(r, sql`
          SELECT checklist_key, file_name, document_type, object_path
          FROM case_documents
          WHERE firm_id = ${req.firmId!} AND case_id = ${caseId}
        `);
        const wfDocs = (await tableExists(r, "public.case_workflow_documents"))
          ? await queryRows(r, sql`
            SELECT milestone_key, object_path, file_name
            FROM case_workflow_documents
            WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND deleted_at IS NULL
          `)
          : [];
        const workflowMap: Record<string, { hasFile: boolean }> = {};
        for (const d of wfDocs) {
          const k = normalizeWorkflowDocumentKeyFromDb(String(d.milestone_key ?? ""));
          if (!k) continue;
          workflowMap[k] = { hasFile: Boolean(d.object_path && d.file_name) };
        }
        const confirmPrefix = `tpl:firm:${templateId}:confirm:`;
        const confirmationRows = (await tableExists(r, "public.case_document_checklist_items"))
          ? await queryRows(r, sql`
            SELECT checklist_key, status, completed_at, completed_by, received_at, received_by
            FROM case_document_checklist_items
            WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND checklist_key LIKE ${`${confirmPrefix}%`}
          `)
          : [];
        const manualConfirmations: Record<string, { checkedBy?: number | null; checkedAt?: string | null; passed: boolean }> = {};
        for (const row of confirmationRows) {
          const k = typeof row.checklist_key === "string" ? String(row.checklist_key) : "";
          const itemId = k.startsWith(confirmPrefix) ? k.slice(confirmPrefix.length) : "";
          if (!itemId) continue;
          manualConfirmations[itemId] = {
            passed: Boolean(row.completed_at || row.received_at || row.status === "completed" || row.status === "received"),
            checkedBy: (row.completed_by ?? row.received_by) as number | null | undefined,
            checkedAt: (row.completed_at ?? row.received_at) ? String(row.completed_at ?? row.received_at) : null,
          };
        }
        const checklistResult = evaluateTemplateChecklist({
          checklistMode: (tpl as any).checklist_mode,
          checklistItems: (tpl as any).checklist_items,
          caseContext: context as Record<string, unknown>,
          resolvedVariables: input,
          uploadedDocuments: [
            ...caseDocs.map((d) => ({
              fileName: d.file_name ? String(d.file_name) : null,
              documentType: d.document_type ? String(d.document_type) : null,
              checklistKey: d.checklist_key ? String(d.checklist_key) : null,
              source: "case_document",
              hasFile: Boolean(d.object_path && d.file_name),
            })),
            ...wfDocs.map((d) => ({
              fileName: d.file_name ? String(d.file_name) : null,
              documentType: d.milestone_key ? String(d.milestone_key) : null,
              checklistKey: d.milestone_key ? `workflow:${String(d.milestone_key)}` : null,
              source: "workflow_document",
              hasFile: Boolean(d.object_path && d.file_name),
            })),
          ],
          milestones: buildChecklistMilestones({ workflowDocs: workflowMap, context }),
          manualConfirmations,
        });
        try {
          const zip = new PizZip(bytes);
          const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
          doc.render(input);
        } catch {
          renderable = false;
        }
        const resp = {
          resolvedVariables: preview.resolvedVariables,
          missingRequiredVariables: preview.missingRequiredVariables,
          unusedBindings: preview.unusedBindings,
          placeholderWarnings,
          selectedClausesResolved: clauseRefs.length ? selectedClausesResolved : [],
          insertionModeUsed,
          insertionTarget,
          duplicateClauseWarnings: clauseRefs.length ? duplicateClauseWarnings : [],
          clauseOrder: clauseRefs.length ? clauseOrder : [],
          clauseSnapshotPreview: clauseRefs.length ? selectedClausesResolved : [],
          checklistResult,
          clauseInsertion: clauseRefs.length ? { selected: clauseRefs, previewText: clausePreviewText, warnings: clauseWarnings, insertionModeUsed, insertionTarget, insertionError, hasClausesPlaceholder, detectedClauseCodePlaceholders, duplicateClauseWarnings, clauseOrder, selectedClausesResolved } : null,
          applicabilityResult,
          renderMode,
          previewSummary: {
            renderable,
            placeholdersCount: placeholders.length,
            usedMode: preview.usedMode,
            missingRequiredCount: preview.missingRequiredVariables.length,
          },
        };
        await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: renderable ? "documents.preview" : "documents.preview.failed", entityType: "document_template", entityId: templateId, detail: `caseId=${caseId} mode=${preview.usedMode} applicable=${applicabilityResult.applicable} bypass=${bypass} clauses=${clauseRefs.length} target=${insertionTarget ?? ""}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
        res.json(resp);
        return;
      }

      renderMode = ext === "pdf" ? "pdf" : "docx";
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.preview", entityType: "document_template", entityId: templateId, detail: `caseId=${caseId} ext=${ext} applicable=${applicabilityResult.applicable} bypass=${bypass}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      res.json({
        resolvedVariables: {},
        missingRequiredVariables: [],
        unusedBindings: [],
        placeholderWarnings: [],
        applicabilityResult,
        renderMode,
        previewSummary: { renderable: false, placeholdersCount: 0, usedMode: "legacy", missingRequiredCount: 0 },
      });
      return;
    }

    const docRows = await queryRows(r, sql`SELECT * FROM platform_documents WHERE id = ${platformDocumentId!} AND (firm_id IS NULL OR firm_id = ${req.firmId!})`);
    const doc = docRows[0];
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const fileName = typeof (doc as any).file_name === "string" ? String((doc as any).file_name) : "";
    const ext = fileExtensionFromName(fileName);
    const obj = typeof (doc as any).object_path === "string" ? String((doc as any).object_path) : "";
    if (!obj) {
      res.status(404).json({ error: "Master file missing", code: "MASTER_FILE_MISSING" });
      return;
    }
    const extra = await getPlatformDocumentApplicabilityRules(r, req.firmId!, platformDocumentId!);
    const appV2 = evaluateTemplateApplicabilityV2({
      legacyTemplate: {
        isActive: extra?.isActive ?? Boolean((doc as any).is_active ?? true),
        isTemplateCapable: extra?.isTemplateCapable ?? Boolean((doc as any).is_template_capable ?? true),
        appliesToPurchaseMode: extra?.purchaseMode ?? ((doc as any).applies_to_purchase_mode ? String((doc as any).applies_to_purchase_mode) : null),
        appliesToTitleType: extra?.titleType ?? ((doc as any).applies_to_title_type ? String((doc as any).applies_to_title_type) : null),
        appliesToCaseType: (doc as any).applies_to_case_type ? String((doc as any).applies_to_case_type) : null,
        projectType: extra?.projectType ?? null,
        titleSubType: extra?.titleSubType ?? null,
        developmentCondition: extra?.developmentCondition ?? null,
        unitCategory: extra?.unitCategory ?? null,
      },
      legacyInput: {
        purchaseMode: (context as any).purchase_mode ?? null,
        titleType: (context as any).title_type ?? null,
        caseType: (context as any).case_type ?? null,
        projectType: (context as any).project_type ?? null,
        developmentCondition: (context as any).project_development_condition ?? null,
        unitCategory: (context as any).unit_category ?? null,
        titleSubType: (context as any).title_sub_type ?? null,
      },
      context: buildApplicabilityContext(context),
      applicabilityMode: (doc as any).applicability_mode,
      applicabilityRules: (doc as any).applicability_rules,
    });
    const applicabilityResult = {
      applicable: appV2.applicabilityStatus !== "not_applicable",
      reasons: appV2.applicabilityReasons,
      status: appV2.applicabilityStatus,
      matchedRulesCount: appV2.matchedRulesCount,
      failedRulesCount: appV2.failedRulesCount,
      manuallyOverridable: appV2.manuallyOverridable,
    };

    let bytes = await downloadPrivateObjectBytes(obj);
    const placeholders =
      ext === "docx" ? detectDocxVariables(bytes)
      : ext === "pdf" ? extractPdfMappingPlaceholders((doc as any).pdf_mappings)
      : [];
    const preview = await runDocumentPreview(r, {
      firmId: req.firmId!,
      caseContext: context,
      templateRef: { kind: "platform", documentId: platformDocumentId! },
      placeholders,
      overrides,
    });
    let clausePreviewText = "";
    let clauseWarnings: unknown[] = [];
    let duplicateClauseWarnings: unknown[] = [];
    let insertionModeUsed: string | null = null;
    let insertionTarget: string | null = null;
    let insertionError: string | null = null;
    let hasClausesPlaceholder: boolean | null = null;
    let detectedClauseCodePlaceholders: string[] = [];
    let clauseOrder: unknown[] = [];
    let selectedClausesResolved: unknown[] = [];
    const renderMode: "docx" | "pdf" | "print" =
      ext === "pdf" ? "pdf"
      : ext === "docx" ? "docx"
      : "docx";
    let renderable = ext === "docx";
    if (ext === "docx") {
      let input: Record<string, unknown> = preview.usedMode === "bindings" ? preview.resolvedVariables : (context as any);
      if (clauseRefs.length > 0) {
        const ins = await buildClauseInsertion({ r, firmId: req.firmId!, selected: clauseRefs, resolvedVariables: input });
        clausePreviewText = ins.clausesText;
        clauseWarnings = ins.warnings;
        duplicateClauseWarnings = ins.duplicateClauseWarnings;
        clauseOrder = ins.clauseOrder;
        selectedClausesResolved = ins.selectedClausesResolved.map((c) => ({
          scope: c.scope,
          id: c.id,
          clauseCode: c.clauseCode,
          title: c.title,
          includeTitle: c.includeTitle,
          body: c.body,
        }));
        const selectedCodes = ins.selectedClausesResolved.map((c) => c.clauseCode).filter(Boolean);
        const detection = detectClausePlaceholders(bytes, selectedCodes);
        hasClausesPlaceholder = detection.hasClausesPlaceholder;
        detectedClauseCodePlaceholders = detection.foundClauseCodes;
        const mode = normalizeClauseInsertionMode((doc as any).clause_insertion_mode);
        const decision = decideClauseInsertion({ mode, hasClausesPlaceholder: detection.hasClausesPlaceholder, foundClauseCodes: detection.foundClauseCodes, selectedClauseCodes: selectedCodes });
        insertionModeUsed = decision.insertionModeUsed;
        insertionTarget = decision.insertionTarget;
        insertionError = decision.insertionError;
        const applied = applyClauseInsertionToDocx({
          docxBytes: bytes,
          data: input,
          clausesText: ins.clausesText,
          perClauseValues: ins.perClauseValues,
          insertionMode: mode,
          selectedClauseCodes: selectedCodes,
        });
        bytes = applied.docxBytes;
        input = applied.data;
      }
      try {
        const zip = new PizZip(bytes);
        const d = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
        d.render(input);
      } catch {
        renderable = false;
      }
    }
    const caseDocs = await queryRows(r, sql`
      SELECT checklist_key, file_name, document_type, object_path
      FROM case_documents
      WHERE firm_id = ${req.firmId!} AND case_id = ${caseId}
    `);
    const wfDocs = (await tableExists(r, "public.case_workflow_documents"))
      ? await queryRows(r, sql`
        SELECT milestone_key, object_path, file_name
        FROM case_workflow_documents
        WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND deleted_at IS NULL
      `)
      : [];
    const workflowMap: Record<string, { hasFile: boolean }> = {};
    for (const d of wfDocs) {
      const k = normalizeWorkflowDocumentKeyFromDb(String(d.milestone_key ?? ""));
      if (!k) continue;
      workflowMap[k] = { hasFile: Boolean(d.object_path && d.file_name) };
    }
    const confirmPrefix = `tpl:master:${platformDocumentId}:confirm:`;
    const confirmationRows = (await tableExists(r, "public.case_document_checklist_items"))
      ? await queryRows(r, sql`
        SELECT checklist_key, status, completed_at, completed_by, received_at, received_by
        FROM case_document_checklist_items
        WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND checklist_key LIKE ${`${confirmPrefix}%`}
      `)
      : [];
    const manualConfirmations: Record<string, { checkedBy?: number | null; checkedAt?: string | null; passed: boolean }> = {};
    for (const row of confirmationRows) {
      const k = typeof row.checklist_key === "string" ? String(row.checklist_key) : "";
      const itemId = k.startsWith(confirmPrefix) ? k.slice(confirmPrefix.length) : "";
      if (!itemId) continue;
      manualConfirmations[itemId] = {
        passed: Boolean(row.completed_at || row.received_at || row.status === "completed" || row.status === "received"),
        checkedBy: (row.completed_by ?? row.received_by) as number | null | undefined,
        checkedAt: (row.completed_at ?? row.received_at) ? String(row.completed_at ?? row.received_at) : null,
      };
    }
    const checklistResult = evaluateTemplateChecklist({
      checklistMode: (doc as any).checklist_mode,
      checklistItems: (doc as any).checklist_items,
      caseContext: context as Record<string, unknown>,
      resolvedVariables: preview.usedMode === "bindings" ? preview.resolvedVariables : (context as Record<string, unknown>),
      uploadedDocuments: [
        ...caseDocs.map((d) => ({
          fileName: d.file_name ? String(d.file_name) : null,
          documentType: d.document_type ? String(d.document_type) : null,
          checklistKey: d.checklist_key ? String(d.checklist_key) : null,
          source: "case_document",
          hasFile: Boolean(d.object_path && d.file_name),
        })),
        ...wfDocs.map((d) => ({
          fileName: d.file_name ? String(d.file_name) : null,
          documentType: d.milestone_key ? String(d.milestone_key) : null,
          checklistKey: d.milestone_key ? `workflow:${String(d.milestone_key)}` : null,
          source: "workflow_document",
          hasFile: Boolean(d.object_path && d.file_name),
        })),
      ],
      milestones: buildChecklistMilestones({ workflowDocs: workflowMap, context }),
      manualConfirmations,
    });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: renderable ? "documents.preview" : "documents.preview.failed", entityType: "platform_document", entityId: platformDocumentId!, detail: `caseId=${caseId} mode=${preview.usedMode} applicable=${applicabilityResult.applicable} bypass=${bypass} clauses=${clauseRefs.length} target=${insertionTarget ?? ""}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.json({
      resolvedVariables: preview.resolvedVariables,
      missingRequiredVariables: preview.missingRequiredVariables,
      unusedBindings: preview.unusedBindings,
      placeholderWarnings: preview.placeholderWarnings,
      selectedClausesResolved: clauseRefs.length ? selectedClausesResolved : [],
      insertionModeUsed,
      insertionTarget,
      duplicateClauseWarnings: clauseRefs.length ? duplicateClauseWarnings : [],
      clauseOrder: clauseRefs.length ? clauseOrder : [],
      clauseSnapshotPreview: clauseRefs.length ? selectedClausesResolved : [],
      checklistResult,
      clauseInsertion: clauseRefs.length ? { selected: clauseRefs, previewText: clausePreviewText, warnings: clauseWarnings, insertionModeUsed, insertionTarget, insertionError, hasClausesPlaceholder, detectedClauseCodePlaceholders, duplicateClauseWarnings, clauseOrder, selectedClausesResolved } : null,
      applicabilityResult,
      renderMode,
      previewSummary: {
        renderable,
        placeholdersCount: placeholders.length,
        usedMode: preview.usedMode,
        missingRequiredCount: preview.missingRequiredVariables.length,
      },
    });
  } catch (err: unknown) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.preview.failed", entityType: "case", entityId: caseId, detail: `code=STORAGE_NOT_CONFIGURED`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      res.status(cfgErr.statusCode).json({ error: cfgErr.error, code: "STORAGE_NOT_CONFIGURED" });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.preview.failed", entityType: "case", entityId: caseId, detail: `code=FILE_NOT_FOUND`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      res.status(404).json({ error: "Template file not found", code: "FILE_NOT_FOUND" });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId }, "[documents] preview_failed");
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.preview.failed", entityType: "case", entityId: caseId, detail: `code=INTERNAL_ERROR`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(503).json({ error: "Preview failed", code: "TEMPLATE_PREVIEW_FAILED" });
  }
});

router.post("/cases/:caseId/documents/generate", requireAuth, requireFirmUser, requirePermission("documents", "generate"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const { templateId, documentName, letterheadId, bypassApplicability, clauses } = req.body as { templateId: number; documentName?: string; letterheadId?: number | null; bypassApplicability?: boolean; clauses?: SelectedClauseRef[] };
  const tid = typeof templateId === "number" ? templateId : NaN;
  if (Number.isNaN(tid)) {
    res.status(422).json({ error: "templateId is required", code: "TEMPLATE_ID_REQUIRED" });
    return;
  }

  const runId = await createGenerationRun(r, {
    firm_id: req.firmId!,
    case_id: caseId,
    template_source: "firm",
    template_id: tid,
    template_version_id: null,
    platform_document_id: null,
    document_name: documentName ?? "Generated document",
    render_mode: "docx",
    status: "running",
    rendered_variables_snapshot: null,
    checklist_snapshot: null,
    readiness_snapshot: null,
    triggered_by: req.userId!,
    error_code: null,
    error_message: null,
  });

  try {
    const bypass = Boolean(bypassApplicability) ? await canBypassApplicability(r, req.firmId!, req.roleId) : false;
    const out = await generateFirmDocument({
      r,
      firmId: req.firmId!,
      actorId: req.userId!,
      actorType: req.userType,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      caseId,
      templateId: tid,
      documentName,
      letterheadId,
      runId,
      bypassApplicability: bypass,
      clauses,
    });
    await finishGenerationRunSuccess(r, req.firmId!, runId, out.caseDocumentId, out.renderedVars, out.checklistSnapshot, out.readinessSnapshot);
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.succeeded", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${tid}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(out.caseDocument);
  } catch (err: unknown) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      await finishGenerationRunFailed(r, req.firmId!, runId, "STORAGE_NOT_CONFIGURED", cfgErr.error);
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${tid} code=STORAGE_NOT_CONFIGURED`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      res.status(cfgErr.statusCode).json({ error: cfgErr.error, code: "STORAGE_NOT_CONFIGURED" });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      await finishGenerationRunFailed(r, req.firmId!, runId, "TEMPLATE_FILE_NOT_FOUND", "Template file not found");
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${tid} code=TEMPLATE_FILE_NOT_FOUND`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      res.status(404).json({ error: "Template file not found", code: "TEMPLATE_FILE_NOT_FOUND" });
      return;
    }
    const e = err instanceof DocumentGenerationError ? err : new DocumentGenerationError(500, "INTERNAL_ERROR", "Internal Server Error");
    await finishGenerationRunFailed(r, req.firmId!, runId, e.code, e.message);
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${tid} code=${e.code}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(e.statusCode).json({ error: e.message, code: e.code, ...(e.payload ? e.payload : {}) });
  }
});

router.post("/cases/:caseId/documents/generate-from-master", requireAuth, requireFirmUser, requirePermission("documents", "generate"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const { masterDocId, documentName, letterheadId, bypassApplicability, clauses } = req.body as { masterDocId: number; documentName?: string; letterheadId?: number | null; bypassApplicability?: boolean; clauses?: SelectedClauseRef[] };
  const mid = typeof masterDocId === "number" ? masterDocId : NaN;
  if (Number.isNaN(mid)) {
    res.status(422).json({ error: "masterDocId is required", code: "MASTER_DOC_ID_REQUIRED" });
    return;
  }

  const runId = await createGenerationRun(r, {
    firm_id: req.firmId!,
    case_id: caseId,
    template_source: "master",
    template_id: null,
    template_version_id: null,
    platform_document_id: mid,
    document_name: documentName ?? "Generated document",
    render_mode: "docx",
    status: "running",
    rendered_variables_snapshot: null,
    checklist_snapshot: null,
    readiness_snapshot: null,
    triggered_by: req.userId!,
    error_code: null,
    error_message: null,
  });

  try {
    const bypass = Boolean(bypassApplicability) ? await canBypassApplicability(r, req.firmId!, req.roleId) : false;
    const out = await generateMasterDocument({
      r,
      firmId: req.firmId!,
      actorId: req.userId!,
      actorType: req.userType,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      caseId,
      masterDocId: mid,
      documentName,
      letterheadId,
      runId,
      bypassApplicability: bypass,
      clauses,
    });
    await finishGenerationRunSuccess(r, req.firmId!, runId, out.caseDocumentId, out.renderedVars, out.checklistSnapshot, out.readinessSnapshot);
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.succeeded", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=master templateId=${mid}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(out.caseDocument);
  } catch (err: unknown) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      await finishGenerationRunFailed(r, req.firmId!, runId, "STORAGE_NOT_CONFIGURED", cfgErr.error);
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=master templateId=${mid} code=STORAGE_NOT_CONFIGURED`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      res.status(cfgErr.statusCode).json({ error: cfgErr.error, code: "STORAGE_NOT_CONFIGURED" });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      await finishGenerationRunFailed(r, req.firmId!, runId, "MASTER_FILE_NOT_FOUND", "Master file not found");
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=master templateId=${mid} code=MASTER_FILE_NOT_FOUND`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      res.status(404).json({ error: "Master file not found", code: "MASTER_FILE_NOT_FOUND" });
      return;
    }
    const e = err instanceof DocumentGenerationError ? err : new DocumentGenerationError(500, "INTERNAL_ERROR", "Internal Server Error");
    await finishGenerationRunFailed(r, req.firmId!, runId, e.code, e.message);
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=master templateId=${mid} code=${e.code}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(e.statusCode).json({ error: e.message, code: e.code, ...(e.payload ? e.payload : {}) });
  }
});

router.get("/printable-config", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;

  const printKeys = Object.keys(PRINT_ACTIONS) as Array<keyof typeof PRINT_ACTIONS>;
  const docTypes = Array.from(new Set(printKeys.map((k) => PRINT_ACTIONS[k].documentType)));
  if (docTypes.length === 0) {
    res.json([]);
    return;
  }

  const rows = await queryRows(
    r,
    sql`SELECT id, name, document_type, kind, is_template_capable, file_name, created_at
        FROM document_templates
        WHERE firm_id = ${req.firmId!}
          AND document_type IN (${sql.join(docTypes.map((t) => sql`${t}`), sql`, `)})
        ORDER BY created_at DESC`
  );

  const latestByType = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const dt = typeof row.document_type === "string" ? String(row.document_type) : "";
    if (!dt) continue;
    if (latestByType.has(dt)) continue;
    latestByType.set(dt, row);
  }

  const result = printKeys.map((k) => {
    const cfg = PRINT_ACTIONS[k];
    const tpl = latestByType.get(cfg.documentType) ?? null;
    if (!tpl) {
      return {
        printKey: k,
        documentType: cfg.documentType,
        label: cfg.label,
        status: "not_configured",
        hint: "Template not configured. Upload a DOCX template under Documents → Firm Documents (Template-like).",
      };
    }
    const kind = typeof tpl.kind === "string" ? String(tpl.kind) : "";
    const cap = Boolean(tpl.is_template_capable);
    if (kind !== "template") {
      return {
        printKey: k,
        documentType: cfg.documentType,
        label: cfg.label,
        status: "template_not_template_kind",
        hint: "Configured record is not marked as Template-like. Edit it in Documents → Firm Documents.",
        template: { id: tpl.id, name: tpl.name, kind: tpl.kind, isTemplateCapable: tpl.is_template_capable, fileName: tpl.file_name },
      };
    }
    if (!cap) {
      return {
        printKey: k,
        documentType: cfg.documentType,
        label: cfg.label,
        status: "template_not_capable",
        hint: "Template is not template-capable (must be .docx). Re-upload or edit as DOCX template.",
        template: { id: tpl.id, name: tpl.name, kind: tpl.kind, isTemplateCapable: tpl.is_template_capable, fileName: tpl.file_name },
      };
    }
    return {
      printKey: k,
      documentType: cfg.documentType,
      label: cfg.label,
      status: "configured",
      template: { id: tpl.id, name: tpl.name, kind: tpl.kind, isTemplateCapable: tpl.is_template_capable, fileName: tpl.file_name },
    };
  });

  res.json(result);
});

router.post("/cases/:caseId/documents/print", requireAuth, requireFirmUser, requirePermission("documents", "generate"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const printKey = typeof body.printKey === "string" ? body.printKey : "";
  const cfg = (PRINT_ACTIONS as Record<string, { documentType: string; label: string }>)[printKey];
  if (!cfg) {
    res.status(400).json({ error: "Invalid printKey", code: "INVALID_PRINT_KEY" });
    return;
  }

  const documentName = typeof body.documentName === "string" ? body.documentName.trim() : "";
  const letterheadId = typeof body.letterheadId === "number" ? body.letterheadId : null;

  const templateRows = await queryRows(
    r,
    sql`SELECT * FROM document_templates
        WHERE firm_id = ${req.firmId!}
          AND kind = 'template'
          AND is_template_capable = true
          AND document_type = ${cfg.documentType}
        ORDER BY created_at DESC
        LIMIT 1`
  );
  const template = templateRows[0];
  if (!template) {
    res.status(404).json({ error: "No firm template configured for this print action", code: "TEMPLATE_NOT_CONFIGURED", documentType: cfg.documentType });
    return;
  }

  const context = await buildCaseContext(r, caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const templateId = typeof (template as any).id === "number" ? Number((template as any).id) : NaN;
  const runId = await createGenerationRun(r, {
    firm_id: req.firmId!,
    case_id: caseId,
    template_source: "firm",
    template_id: Number.isNaN(templateId) ? null : templateId,
    template_version_id: null,
    platform_document_id: null,
    document_name: documentName || cfg.label,
    render_mode: "print",
    status: "running",
    rendered_variables_snapshot: null,
    checklist_snapshot: null,
    readiness_snapshot: null,
    triggered_by: req.userId!,
    error_code: null,
    error_message: null,
  });

  try {
    const templateVersionId = Number.isNaN(templateId) ? null : await ensureFirmTemplatePublishedVersionId(r, req.firmId!, templateId, req.userId!);
    if (templateVersionId) {
      await queryRows(r, sql`UPDATE document_generation_runs SET template_version_id = ${templateVersionId} WHERE id = ${runId} AND firm_id = ${req.firmId!}`);
    }
    const vRows = templateVersionId
      ? await queryRows(r, sql`SELECT * FROM document_template_versions WHERE id = ${templateVersionId} AND firm_id = ${req.firmId!}`)
      : [];
    const v = vRows[0];
    const templateObjectPath = typeof (v as any)?.source_object_path === "string"
      ? String((v as any).source_object_path)
      : (typeof (template as any).object_path === "string" ? String((template as any).object_path) : "");
    if (!templateObjectPath) {
      res.status(404).json({ error: "Template file missing" });
      await finishGenerationRunFailed(r, req.firmId!, runId, "TEMPLATE_FILE_MISSING", "Template file missing");
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${templateId} code=TEMPLATE_FILE_MISSING`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      return;
    }
    const fileContents = await downloadPrivateObjectBytes(templateObjectPath);

    const zip = new PizZip(fileContents);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    try {
      doc.render(context);
    } catch (err) {
      logger.warn({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, templateId: (template as any).id, printKey }, "[documents] template_render_failed");
      res.status(422).json({ error: "Template render failed", code: "TEMPLATE_RENDER_FAILED" });
      await finishGenerationRunFailed(r, req.firmId!, runId, "TEMPLATE_RENDER_FAILED", "Template render failed");
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${templateId} code=TEMPLATE_RENDER_FAILED`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      return;
    }
    let buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;

    const templateDocType = template && typeof template === "object" && "document_type" in template ? String((template as any).document_type) : "other";
    const isLetterLike = isLetterheadApplicableDocumentType(templateDocType);
    let usedLetterheadId: number | null = null;
    if (isLetterLike) {
      const lhIdNum = letterheadId;
      let lh: Record<string, unknown> | undefined;
      if (lhIdNum !== null) {
        const byId = await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE id = ${lhIdNum} AND firm_id = ${req.firmId!}`);
        const candidate = byId[0];
        if (!candidate) {
          res.status(404).json({ error: "Letterhead not found", code: "LETTERHEAD_NOT_FOUND" });
          return;
        }
        if (String((candidate as any).status ?? "active") !== "active") {
          res.status(409).json({ error: "Selected letterhead is inactive", code: "LETTERHEAD_INACTIVE" });
          return;
        }
        lh = candidate;
      } else {
        const defaults = await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE firm_id = ${req.firmId!} AND status = 'active' ORDER BY is_default DESC, created_at DESC LIMIT 1`);
        lh = defaults[0];
        if (!lh) {
          res.status(422).json({ error: "No active firm letterhead configured", code: "NO_LETTERHEAD" });
          return;
        }
      }
      usedLetterheadId = typeof (lh as any).id === "number" ? Number((lh as any).id) : null;
      const firstBytes = await downloadPrivateObjectBytes(String((lh as any).first_page_object_path));
      const contBytes = await downloadPrivateObjectBytes(String((lh as any).continuation_header_object_path));
      const footerPath = (lh as any).footer_object_path ? String((lh as any).footer_object_path) : null;
      const footerBytes = footerPath ? await downloadPrivateObjectBytes(footerPath) : null;
      const footerMode = (lh as any).footer_mode === "last_page_only" ? "last_page_only" : "every_page";
      buffer = await applyLetterheadToDocxBuffer({
        baseDocx: buffer,
        firstPageTemplateDocx: firstBytes,
        continuationHeaderTemplateDocx: contBytes,
        footerTemplateDocx: footerBytes,
        footerMode,
      });
    }

    const normalizedPath = newGeneratedDocObjectPath(req.firmId!, caseId, "docx");
    await supabaseStorage.uploadPrivateObject({
      objectPath: normalizedPath,
      fileBytes: buffer,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const nameToUse = documentName || `${cfg.label} - ${context.reference_no}`;
    const fileName = `${nameToUse.replace(/[^a-zA-Z0-9 \-_]/g, "_")}.docx`;

    const docRows = await queryRows(r, sql`
      INSERT INTO case_documents (case_id, firm_id, template_id, name, document_type, status, object_path, file_name, generated_by)
      VALUES (${caseId}, ${req.firmId!}, ${(template as any).id as number}, ${nameToUse}, ${cfg.documentType}, 'generated', ${normalizedPath}, ${fileName}, ${req.userId!})
      RETURNING *`
    );

    const created = docRows[0];
    const createdId = created && typeof created === "object" && "id" in created && typeof (created as { id?: unknown }).id === "number"
      ? (created as { id: number }).id
      : undefined;
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.print", entityType: "case_document", entityId: createdId, detail: `caseId=${caseId} printKey=${printKey} templateId=${(template as any).id} name=${nameToUse} letterhead=${isLetterLike ? (usedLetterheadId ?? "default") : "n/a"}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    await finishGenerationRunSuccess(r, req.firmId!, runId, createdId ?? null, context, null, null);
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.succeeded", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${templateId} renderMode=print`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(docRows[0]);
  } catch (err: unknown) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, printKey }, "[documents] supabase_storage_not_configured");
      res.status(cfgErr.statusCode).json({ error: cfgErr.error });
      await finishGenerationRunFailed(r, req.firmId!, runId, "STORAGE_NOT_CONFIGURED", cfgErr.error);
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${templateId} code=STORAGE_NOT_CONFIGURED`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Template file not found" });
      await finishGenerationRunFailed(r, req.firmId!, runId, "TEMPLATE_FILE_NOT_FOUND", "Template file not found");
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${templateId} code=TEMPLATE_FILE_NOT_FOUND`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      return;
    }
    if (isDocxTemplateRenderError(err)) {
      res.status(422).json({ error: "Template render failed", code: "TEMPLATE_RENDER_FAILED" });
      await finishGenerationRunFailed(r, req.firmId!, runId, "TEMPLATE_RENDER_FAILED", "Template render failed");
      await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${templateId} code=TEMPLATE_RENDER_FAILED`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, printKey }, "[documents] print_failed");
    res.status(500).json({ error: "Internal Server Error" });
    await finishGenerationRunFailed(r, req.firmId!, runId, "INTERNAL_ERROR", "Internal Server Error");
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.generation.failed", entityType: "document_generation_run", entityId: runId, detail: `caseId=${caseId} templateSource=firm templateId=${templateId} code=INTERNAL_ERROR`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  }
});

router.get("/document-variables-legacy", requireAuth, async (_req: AuthRequest, res): Promise<void> => {
  const variables = [
    { group: "General", vars: [
      { key: "reference_no", label: "Case Reference No" },
      { key: "date", label: "Today's Date (long format)" },
      { key: "date_short", label: "Today's Date (DD/MM/YYYY)" },
      { key: "case_type", label: "Case Type" },
      { key: "parcel_no", label: "Parcel No" },
      { key: "spa_price", label: "SPA Price (formatted RM)" },
      { key: "spa_price_raw", label: "SPA Price (number only)" },
      { key: "purchase_mode", label: "Purchase Mode (cash/loan)" },
      { key: "title_type", label: "Title Type" },
      { key: "status", label: "Case Status" },
      { key: "spa_status", label: "SPA Status (workflow-derived)" },
      { key: "loan_status", label: "Loan Status (workflow-derived)" },
    ]},
    { group: "SPA Details", vars: [
      { key: "spa_purchaser1_name", label: "SPA Purchaser 1 Name" },
      { key: "spa_purchaser1_ic", label: "SPA Purchaser 1 IC" },
      { key: "spa_purchaser2_name", label: "SPA Purchaser 2 Name" },
      { key: "spa_purchaser2_ic", label: "SPA Purchaser 2 IC" },
      { key: "spa_address_line1", label: "Address Line 1" },
      { key: "spa_address_line2", label: "Address Line 2" },
      { key: "spa_address_line3", label: "Address Line 3" },
      { key: "spa_address_line4", label: "Address Line 4" },
      { key: "spa_address_line5", label: "Address Line 5" },
      { key: "spa_mailing_address", label: "Mailing Address" },
      { key: "spa_contact_number", label: "Contact Number" },
      { key: "spa_email", label: "Email Address" },
    ]},
    { group: "Property", vars: [
      { key: "property_parcel_no", label: "Parcel No" },
      { key: "property_floor_no", label: "Floor No" },
      { key: "property_building_no", label: "Building No" },
      { key: "property_car_park_no", label: "Car Park No" },
      { key: "property_type", label: "Property Type" },
      { key: "property_area_sqm", label: "Area (sqm)" },
      { key: "property_purchase_price", label: "Purchase Price (RM)" },
      { key: "property_purchase_price_raw", label: "Purchase Price (number)" },
      { key: "property_progress_payment", label: "Progress Payment" },
      { key: "property_dev_discount", label: "Developer Discount (RM)" },
      { key: "property_bumi_discount", label: "Bumi Discount (RM)" },
      { key: "property_approved_price", label: "Approved Price (RM)" },
    ]},
    { group: "Loan / Financing", vars: [
      { key: "borrower1_name", label: "Borrower 1 Name" },
      { key: "borrower1_ic", label: "Borrower 1 IC" },
      { key: "borrower2_name", label: "Borrower 2 Name" },
      { key: "borrower2_ic", label: "Borrower 2 IC" },
      { key: "end_financier", label: "End Financier (Bank)" },
      { key: "bank_ref", label: "Bank Reference" },
      { key: "bank_branch", label: "Bank Branch" },
      { key: "financing_sum", label: "Financing Sum (RM)" },
      { key: "other_charges", label: "Other Charges (RM)" },
      { key: "total_loan", label: "Total Loan (RM)" },
    ]},
    { group: "Company", vars: [
      { key: "director1_name", label: "Director 1 Name" },
      { key: "director1_ic", label: "Director 1 IC" },
      { key: "director2_name", label: "Director 2 Name" },
      { key: "director2_ic", label: "Director 2 IC" },
    ]},
    { group: "Purchaser (Main)", vars: [
      { key: "purchaser_name", label: "Name" },
      { key: "purchaser_ic", label: "IC No" },
      { key: "purchaser_nationality", label: "Nationality" },
      { key: "purchaser_address", label: "Address" },
      { key: "purchaser_phone", label: "Phone" },
      { key: "purchaser_email", label: "Email" },
    ]},
    { group: "Project", vars: [
      { key: "project_name", label: "Project Name" },
      { key: "project_phase", label: "Phase" },
      { key: "project_type", label: "Project Type" },
      { key: "project_title_type", label: "Title Type" },
      { key: "project_title_subtype", label: "Title Subtype" },
      { key: "project_master_title_no", label: "Master Title Number" },
      { key: "project_master_title_size", label: "Master Title Land Size" },
      { key: "project_mukim", label: "Mukim" },
      { key: "project_daerah", label: "Daerah" },
      { key: "project_negeri", label: "Negeri" },
      { key: "project_land_use", label: "Land Use" },
      { key: "project_development_condition", label: "Development Condition" },
      { key: "project_developer_name", label: "Developer Name (on Project)" },
      { key: "unit_category", label: "Unit Category" },
    ]},
    { group: "Project Property Types (Loop)", vars: [
      { key: "project_property_types", label: "Property Types List", type: "loop" },
      { key: "building_type", label: "Building Type (inside loop)", type: "loopField" },
      { key: "index", label: "Index (inside loop)", type: "loopField" },
    ]},
    { group: "Developer", vars: [
      { key: "developer_name", label: "Developer Name" },
      { key: "developer_reg_no", label: "Registration No" },
      { key: "developer_address", label: "Registered Address" },
      { key: "developer_business_address", label: "Business Address" },
      { key: "developer_contact", label: "Contact Person" },
      { key: "developer_phone", label: "Phone" },
      { key: "developer_email", label: "Email" },
    ]},
    { group: "Lawyer & Clerk", vars: [
      { key: "lawyer_name", label: "Lawyer Name" },
      { key: "lawyer_email", label: "Lawyer Email" },
      { key: "clerk_name", label: "Clerk Name" },
    ]},
    { group: "Firm", vars: [
      { key: "firm_name", label: "Firm Name" },
      { key: "firm_address", label: "Firm Address" },
      { key: "firm_st_number", label: "ST Number" },
      { key: "firm_tin_number", label: "TIN Number" },
      { key: "office_bank_name", label: "Office Bank Name" },
      { key: "office_bank_account_no", label: "Office Bank Account No" },
      { key: "client_bank_name", label: "Client Bank Name" },
      { key: "client_bank_account_no", label: "Client Bank Account No" },
    ]},
    { group: "Loops (use with {#name}...{/name})", vars: [
      { key: "purchasers", label: "All Purchasers", type: "loop", fields: "index, name, ic, nationality, address, phone, email, role" },
      { key: "bank_accounts", label: "All Bank Accounts", type: "loop", fields: "index, bank_name, account_no, account_type" },
      { key: "developer_contacts", label: "Developer Contacts", type: "loop", fields: "index, department, phone, ext, email" },
    ]},
    { group: "Case Key Dates (Structured; falls back to workflow)", vars: [
      { key: "spa_signed_date_raw", label: "SPA Signed Date (raw)" },
      { key: "spa_signed_date", label: "SPA Signed Date (DD/MM/YYYY)" },
      { key: "spa_signed_date_long", label: "SPA Signed Date (long format)" },

      { key: "spa_forward_to_developer_execution_on_raw", label: "SPA Forward to Developer Execution On (raw)" },
      { key: "spa_forward_to_developer_execution_on", label: "SPA Forward to Developer Execution On (DD/MM/YYYY)" },
      { key: "spa_forward_to_developer_execution_on_long", label: "SPA Forward to Developer Execution On (long format)" },

      { key: "spa_date_raw", label: "SPA Date (raw)" },
      { key: "spa_date", label: "SPA Date (DD/MM/YYYY)" },
      { key: "spa_date_long", label: "SPA Date (long format)" },

      { key: "spa_stamped_date_raw", label: "SPA Stamped Date (raw)" },
      { key: "spa_stamped_date", label: "SPA Stamped Date (DD/MM/YYYY)" },
      { key: "spa_stamped_date_long", label: "SPA Stamped Date (long format)" },

      { key: "stamped_spa_send_to_developer_on_raw", label: "Stamped SPA Send to Developer On (raw)" },
      { key: "stamped_spa_send_to_developer_on", label: "Stamped SPA Send to Developer On (DD/MM/YYYY)" },
      { key: "stamped_spa_send_to_developer_on_long", label: "Stamped SPA Send to Developer On (long format)" },

      { key: "stamped_spa_received_from_developer_on_raw", label: "Stamped SPA Received from Developer On (raw)" },
      { key: "stamped_spa_received_from_developer_on", label: "Stamped SPA Received from Developer On (DD/MM/YYYY)" },
      { key: "stamped_spa_received_from_developer_on_long", label: "Stamped SPA Received from Developer On (long format)" },

      { key: "letter_of_offer_date_raw", label: "Letter of Offer Date (raw)" },
      { key: "letter_of_offer_date", label: "Letter of Offer Date (DD/MM/YYYY)" },
      { key: "letter_of_offer_date_long", label: "Letter of Offer Date (long format)" },

      { key: "letter_of_offer_stamped_date_raw", label: "Letter of Offer Stamped Date (raw)" },
      { key: "letter_of_offer_stamped_date", label: "Letter of Offer Stamped Date (DD/MM/YYYY)" },
      { key: "letter_of_offer_stamped_date_long", label: "Letter of Offer Stamped Date (long format)" },

      { key: "loan_docs_pending_date_raw", label: "Loan Docs Pending Signing Date (raw)" },
      { key: "loan_docs_pending_date", label: "Loan Docs Pending Signing Date (DD/MM/YYYY)" },
      { key: "loan_docs_pending_date_long", label: "Loan Docs Pending Signing Date (long format)" },

      { key: "loan_docs_signed_date_raw", label: "Loan Docs Signed Date (raw)" },
      { key: "loan_docs_signed_date", label: "Loan Docs Signed Date (DD/MM/YYYY)" },
      { key: "loan_docs_signed_date_long", label: "Loan Docs Signed Date (long format)" },

      { key: "acting_letter_issued_date_raw", label: "Acting Letter Issued Date (raw)" },
      { key: "acting_letter_issued_date", label: "Acting Letter Issued Date (DD/MM/YYYY)" },
      { key: "acting_letter_issued_date_long", label: "Acting Letter Issued Date (long format)" },

      { key: "developer_confirmation_received_on_raw", label: "Developer Confirmation Received On (raw)" },
      { key: "developer_confirmation_received_on", label: "Developer Confirmation Received On (DD/MM/YYYY)" },
      { key: "developer_confirmation_received_on_long", label: "Developer Confirmation Received On (long format)" },

      { key: "developer_confirmation_date_raw", label: "Developer Confirmation Date (raw)" },
      { key: "developer_confirmation_date", label: "Developer Confirmation Date (DD/MM/YYYY)" },
      { key: "developer_confirmation_date_long", label: "Developer Confirmation Date (long format)" },

      { key: "loan_sent_bank_execution_date_raw", label: "Loan Sent for Bank Execution Date (raw)" },
      { key: "loan_sent_bank_execution_date", label: "Loan Sent for Bank Execution Date (DD/MM/YYYY)" },
      { key: "loan_sent_bank_execution_date_long", label: "Loan Sent for Bank Execution Date (long format)" },

      { key: "loan_bank_executed_date_raw", label: "Loan Bank Executed Date (raw)" },
      { key: "loan_bank_executed_date", label: "Loan Bank Executed Date (DD/MM/YYYY)" },
      { key: "loan_bank_executed_date_long", label: "Loan Bank Executed Date (long format)" },

      { key: "bank_lu_received_date_raw", label: "Bank LU Received Date (raw)" },
      { key: "bank_lu_received_date", label: "Bank LU Received Date (DD/MM/YYYY)" },
      { key: "bank_lu_received_date_long", label: "Bank LU Received Date (long format)" },

      { key: "bank_lu_forward_to_developer_on_raw", label: "Bank LU Forward to Developer On (raw)" },
      { key: "bank_lu_forward_to_developer_on", label: "Bank LU Forward to Developer On (DD/MM/YYYY)" },
      { key: "bank_lu_forward_to_developer_on_long", label: "Bank LU Forward to Developer On (long format)" },

      { key: "developer_lu_received_on_raw", label: "Developer LU Received On (raw)" },
      { key: "developer_lu_received_on", label: "Developer LU Received On (DD/MM/YYYY)" },
      { key: "developer_lu_received_on_long", label: "Developer LU Received On (long format)" },

      { key: "developer_lu_dated_raw", label: "Developer LU Dated (raw)" },
      { key: "developer_lu_dated", label: "Developer LU Dated (DD/MM/YYYY)" },
      { key: "developer_lu_dated_long", label: "Developer LU Dated (long format)" },

      { key: "letter_disclaimer_received_on_raw", label: "Letter Disclaimer Received On (raw)" },
      { key: "letter_disclaimer_received_on", label: "Letter Disclaimer Received On (DD/MM/YYYY)" },
      { key: "letter_disclaimer_received_on_long", label: "Letter Disclaimer Received On (long format)" },

      { key: "letter_disclaimer_dated_raw", label: "Letter Disclaimer Dated (raw)" },
      { key: "letter_disclaimer_dated", label: "Letter Disclaimer Dated (DD/MM/YYYY)" },
      { key: "letter_disclaimer_dated_long", label: "Letter Disclaimer Dated (long format)" },

      { key: "letter_disclaimer_reference_nos", label: "Letter Disclaimer Reference Nos" },

      { key: "redemption_sum_raw", label: "Redemption Sum (raw)" },
      { key: "redemption_sum", label: "Redemption Sum (formatted RM)" },

      { key: "loan_agreement_dated_raw", label: "Loan Agreement Dated (raw)" },
      { key: "loan_agreement_dated", label: "Loan Agreement Dated (DD/MM/YYYY)" },
      { key: "loan_agreement_dated_long", label: "Loan Agreement Dated (long format)" },

      { key: "loan_agreement_submitted_stamping_date_raw", label: "Loan Agreement Submitted for Stamping Date (raw)" },
      { key: "loan_agreement_submitted_stamping_date", label: "Loan Agreement Submitted for Stamping Date (DD/MM/YYYY)" },
      { key: "loan_agreement_submitted_stamping_date_long", label: "Loan Agreement Submitted for Stamping Date (long format)" },

      { key: "loan_agreement_stamped_date_raw", label: "Loan Agreement Stamped Date (raw)" },
      { key: "loan_agreement_stamped_date", label: "Loan Agreement Stamped Date (DD/MM/YYYY)" },
      { key: "loan_agreement_stamped_date_long", label: "Loan Agreement Stamped Date (long format)" },

      { key: "register_poa_on_raw", label: "Register POA On (raw)" },
      { key: "register_poa_on", label: "Register POA On (DD/MM/YYYY)" },
      { key: "register_poa_on_long", label: "Register POA On (long format)" },

      { key: "registered_poa_registration_number", label: "Registered POA Registration Number" },

      { key: "noa_served_on_raw", label: "NOA Served On (raw)" },
      { key: "noa_served_on", label: "NOA Served On (DD/MM/YYYY)" },
      { key: "noa_served_on_long", label: "NOA Served On (long format)" },

      { key: "advice_to_bank_date_raw", label: "Advice to Bank Date (raw)" },
      { key: "advice_to_bank_date", label: "Advice to Bank Date (DD/MM/YYYY)" },
      { key: "advice_to_bank_date_long", label: "Advice to Bank Date (long format)" },

      { key: "bank_1st_release_on_raw", label: "Bank 1st Release On (raw)" },
      { key: "bank_1st_release_on", label: "Bank 1st Release On (DD/MM/YYYY)" },
      { key: "bank_1st_release_on_long", label: "Bank 1st Release On (long format)" },

      { key: "first_release_amount_rm_raw", label: "First Release Amount (raw)" },
      { key: "first_release_amount_rm", label: "First Release Amount (formatted RM)" },

      { key: "mot_received_date_raw", label: "MOT Received Date (raw)" },
      { key: "mot_received_date", label: "MOT Received Date (DD/MM/YYYY)" },
      { key: "mot_received_date_long", label: "MOT Received Date (long format)" },

      { key: "mot_signed_date_raw", label: "MOT Signed Date (raw)" },
      { key: "mot_signed_date", label: "MOT Signed Date (DD/MM/YYYY)" },
      { key: "mot_signed_date_long", label: "MOT Signed Date (long format)" },

      { key: "mot_stamped_date_raw", label: "MOT Stamped Date (raw)" },
      { key: "mot_stamped_date", label: "MOT Stamped Date (DD/MM/YYYY)" },
      { key: "mot_stamped_date_long", label: "MOT Stamped Date (long format)" },

      { key: "mot_registered_date_raw", label: "MOT Registered Date (raw)" },
      { key: "mot_registered_date", label: "MOT Registered Date (DD/MM/YYYY)" },
      { key: "mot_registered_date_long", label: "MOT Registered Date (long format)" },

      { key: "progressive_payment_date_raw", label: "Progressive Payment Date (raw)" },
      { key: "progressive_payment_date", label: "Progressive Payment Date (DD/MM/YYYY)" },
      { key: "progressive_payment_date_long", label: "Progressive Payment Date (long format)" },

      { key: "full_settlement_date_raw", label: "Full Settlement Date (raw)" },
      { key: "full_settlement_date", label: "Full Settlement Date (DD/MM/YYYY)" },
      { key: "full_settlement_date_long", label: "Full Settlement Date (long format)" },

      { key: "completion_date_raw", label: "Completion Date (raw)" },
      { key: "completion_date", label: "Completion Date (DD/MM/YYYY)" },
      { key: "completion_date_long", label: "Completion Date (long format)" },
    ]},
  ];
  res.json(variables);
});

router.post("/cases/:caseId/documents/upload", requireAuth, requireFirmUser, requirePermission("documents", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const { name, documentType, objectPath, fileName, fileSize } = req.body as {
    name: string;
    documentType?: string;
    objectPath: string;
    fileName: string;
    fileSize?: number;
  };

  if (!name || !objectPath || !fileName) {
    res.status(400).json({ error: "name, objectPath, and fileName are required" });
    return;
  }

  const caseGuard = await queryRows(r, sql`SELECT 1 FROM cases WHERE id = ${caseId} AND firm_id = ${req.firmId!}`);
  if (!caseGuard[0]) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const context = await buildCaseContext(r, caseId, req.firmId!);
  const sequence = await nextCaseDocumentSequence(r, req.firmId!, caseId);
  const smartName = resolveSmartFilename({
    ctx: {
      caseId,
      firmId: req.firmId!,
      caseReferenceNo: String((context as any)?.reference_no ?? ""),
      parcelNo: String((context as any)?.parcel_no ?? ""),
      clientName: String((context as any)?.spa_purchaser1_name ?? (context as any)?.borrower1_name ?? ""),
      projectName: String((context as any)?.project_name ?? ""),
      developerName: String((context as any)?.developer_name ?? ""),
      documentName: name,
      templateName: "",
      status: String((context as any)?.case_status ?? (context as any)?.status ?? ""),
      titleType: String((context as any)?.title_type ?? ""),
      loanBank: String((context as any)?.loan_end_financier ?? ""),
      sequence,
    },
    rule: null,
    originalFileNameOrExt: fileName,
    fallbackExt: "pdf",
  }).fileName;

  const rows = await queryRows(r, sql`
    INSERT INTO case_documents (case_id, firm_id, name, document_type, status, object_path, file_name, file_size, is_uploaded, generated_by)
    VALUES (${caseId}, ${req.firmId!}, ${name}, ${documentType ?? "other"}, 'uploaded', ${objectPath}, ${smartName}, ${fileSize ?? null}, true, ${req.userId!})
    RETURNING *`
  );

  const created = rows[0];
  const createdId = created && typeof created === "object" && "id" in created && typeof (created as { id?: unknown }).id === "number"
    ? (created as { id: number }).id
    : undefined;
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.upload", entityType: "case_document", entityId: createdId, detail: `caseId=${caseId} name=${name} fileName=${smartName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(rows[0]);
});

router.get("/cases/:caseId/documents/:docId/download", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const docIdStr = one((req.params as any).docId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (Number.isNaN(caseId) || Number.isNaN(docId)) {
    res.status(400).json({ error: "Invalid document ID" });
    return;
  }

  const rows = await queryRows(
    r,
    sql`SELECT * FROM case_documents WHERE id = ${docId} AND case_id = ${caseId} AND firm_id = ${req.firmId!}`
  );

  if (!rows[0]) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const doc = rows[0];

  try {
    const objectPath = typeof (doc as any).object_path === "string" ? String((doc as any).object_path) : "";
    const fileName = typeof (doc as any).file_name === "string" ? String((doc as any).file_name) : `case-document-${docId}`;
    if (!objectPath) {
      res.status(404).json({ error: "File missing" });
      return;
    }
    const fallbackContentType =
      typeof (doc as any).mime_type === "string"
        ? String((doc as any).mime_type)
        : "application/octet-stream";
    await streamSupabasePrivateObjectToResponse({ objectPath, res, fileName, fallbackContentType });
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.download", entityType: "case_document", entityId: docId, detail: `caseId=${caseId} fileName=${fileName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  } catch (err) {
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) {
      logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, docId }, "[documents] supabase_storage_not_configured");
      res.status(cfgErr.statusCode).json({ error: cfgErr.error });
      return;
    }
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId, caseId, docId }, "[documents] case_document_download_failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

async function fetchCaseDocumentBytes(objectPath: string): Promise<Buffer> {
  const resp = await supabaseStorage.fetchPrivateObjectResponse(objectPath);
  if (!resp.ok) throw new Error(`storage_download_failed:${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

router.post("/cases/:caseId/documents/:docId/extraction/run", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseId = Number.parseInt(one((req.params as any).caseId) ?? "", 10);
  const docId = Number.parseInt(one((req.params as any).docId) ?? "", 10);
  if (!Number.isFinite(caseId) || !Number.isFinite(docId)) { res.status(400).json({ error: "Invalid caseId/docId" }); return; }

  const [doc] = await queryRows(r, sql`SELECT * FROM case_documents WHERE id = ${docId} AND case_id = ${caseId} AND firm_id = ${req.firmId!} LIMIT 1`);
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  const objectPath = typeof (doc as any).object_path === "string" ? String((doc as any).object_path) : "";
  const fileName = typeof (doc as any).file_name === "string" ? String((doc as any).file_name) : `case-document-${docId}`;
  const mimeType = typeof (doc as any).mime_type === "string" ? String((doc as any).mime_type) : null;
  if (!objectPath) { res.status(422).json({ error: "Document has no file" }); return; }

  const jobRows = await queryRows(r, sql`
    INSERT INTO document_extraction_jobs (firm_id, case_id, case_document_id, status, created_by)
    VALUES (${req.firmId!}, ${caseId}, ${docId}, 'running', ${req.userId!})
    RETURNING *
  `);
  const job = jobRows[0] as any;
  const jobId = typeof job?.id === "number" ? job.id : null;
  try {
    const bytes = await fetchCaseDocumentBytes(objectPath);
    const cls = classifyDocumentForExtraction({ fileName, mimeType, hintDocumentType: typeof (doc as any).document_type === "string" ? String((doc as any).document_type) : null });
    const raw = await extractDocumentText({ bytes, fileName });
    const guessed = cls.documentTypeGuess === "unknown" ? guessDocumentTypeFromText(raw.extractedRawText) : cls.documentTypeGuess;
    const suggestions = mapExtractedTextToSuggestions({ raw, documentTypeGuess: guessed });

    await queryRows(r, sql`
      UPDATE document_extraction_jobs
      SET status = 'completed', extraction_method = ${raw.extractionMethod}, document_type_guess = ${guessed}, completed_at = now()
      WHERE id = ${jobId}
    `);
    await queryRows(r, sql`
      INSERT INTO document_extraction_results (job_id, raw_text, structured_result_json, warnings, confidence_summary)
      VALUES (${jobId}, ${raw.extractedRawText.slice(0, 500000)}, ${JSON.stringify({ perPageText: raw.perPageText, pageCount: raw.pageCount })}, ${JSON.stringify(raw.warnings)}, ${JSON.stringify({ suggestionCount: suggestions.length })})
    `);
    for (const s of suggestions) {
      await queryRows(r, sql`
        INSERT INTO document_extraction_suggestions (job_id, field_key, suggested_value, confidence, source_page, source_snippet, document_type_guess, target_entity_type)
        VALUES (${jobId}, ${s.fieldKey}, ${s.suggestedValue}, ${s.confidence as any}, ${s.sourcePage as any}, ${s.sourceSnippet}, ${s.documentTypeGuess}, ${s.targetEntityType})
      `);
    }
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.extraction.run", entityType: "case_document", entityId: docId, detail: `caseId=${caseId} method=${raw.extractionMethod} guess=${guessed} suggestions=${suggestions.length}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });

    const suggestionRows = await queryRows(r, sql`SELECT * FROM document_extraction_suggestions WHERE job_id = ${jobId} ORDER BY confidence DESC NULLS LAST, id ASC`);
    const [resultRow] = await queryRows(r, sql`SELECT * FROM document_extraction_results WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 1`);
    res.json({ job: jobRows[0], result: resultRow, suggestions: suggestionRows });
  } catch (err) {
    await queryRows(r, sql`UPDATE document_extraction_jobs SET status = 'failed', error_message = ${err instanceof Error ? err.message : "unknown"}, completed_at = now() WHERE id = ${jobId}`);
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.extraction.failed", entityType: "case_document", entityId: docId, detail: `caseId=${caseId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(500).json({ error: "Extraction failed" });
  }
});

router.get("/cases/:caseId/documents/:docId/extraction/latest", requireAuth, requireFirmUser, requirePermission("documents", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseId = Number.parseInt(one((req.params as any).caseId) ?? "", 10);
  const docId = Number.parseInt(one((req.params as any).docId) ?? "", 10);
  if (!Number.isFinite(caseId) || !Number.isFinite(docId)) { res.status(400).json({ error: "Invalid caseId/docId" }); return; }
  const jobs = await queryRows(r, sql`
    SELECT *
    FROM document_extraction_jobs
    WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND case_document_id = ${docId}
    ORDER BY id DESC
    LIMIT 1
  `);
  if (!jobs[0]) { res.json({ job: null, result: null, suggestions: [] }); return; }
  const jobId = (jobs[0] as any).id;
  const [result] = await queryRows(r, sql`SELECT * FROM document_extraction_results WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 1`);
  const suggestions = await queryRows(r, sql`SELECT * FROM document_extraction_suggestions WHERE job_id = ${jobId} ORDER BY confidence DESC NULLS LAST, id ASC`);
  res.json({ job: jobs[0], result, suggestions });
});

router.post("/extractions/jobs/:jobId/suggestions/:suggestionId/reject", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const jobId = Number.parseInt(one((req.params as any).jobId) ?? "", 10);
  const suggestionId = Number.parseInt(one((req.params as any).suggestionId) ?? "", 10);
  if (!Number.isFinite(jobId) || !Number.isFinite(suggestionId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await queryRows(r, sql`
    UPDATE document_extraction_suggestions s
    SET rejected_by = ${req.userId!}, rejected_at = now()
    FROM document_extraction_jobs j
    WHERE s.id = ${suggestionId} AND s.job_id = j.id AND j.id = ${jobId} AND j.firm_id = ${req.firmId!}
    RETURNING s.*, j.case_id, j.case_document_id
  `);
  if (!rows[0]) { res.status(404).json({ error: "Suggestion not found" }); return; }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.extraction.suggestion.reject", entityType: "case_document", entityId: Number((rows[0] as any).case_document_id), detail: `caseId=${Number((rows[0] as any).case_id)} suggestionId=${suggestionId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ ok: true, suggestion: rows[0] });
});

router.post("/extractions/jobs/:jobId/suggestions/:suggestionId/accept", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const jobId = Number.parseInt(one((req.params as any).jobId) ?? "", 10);
  const suggestionId = Number.parseInt(one((req.params as any).suggestionId) ?? "", 10);
  if (!Number.isFinite(jobId) || !Number.isFinite(suggestionId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const overrideExisting = Boolean((req.body as any)?.overrideExisting ?? false);
  const rows = await queryRows(r, sql`
    SELECT s.*, j.case_id, j.case_document_id
    FROM document_extraction_suggestions s
    JOIN document_extraction_jobs j ON j.id = s.job_id
    WHERE s.id = ${suggestionId} AND s.job_id = ${jobId} AND j.firm_id = ${req.firmId!}
    LIMIT 1
  `);
  if (!rows[0]) { res.status(404).json({ error: "Suggestion not found" }); return; }
  const s = rows[0] as any;
  const outcome = await applyExtractionSuggestion({
    r,
    firmId: req.firmId!,
    caseId: Number(s.case_id),
    actorId: req.userId!,
    suggestion: { fieldKey: String(s.field_key), suggestedValue: s.suggested_value ? String(s.suggested_value) : null, targetEntityType: s.target_entity_type ? String(s.target_entity_type) : null },
    overrideExisting,
  });
  await queryRows(r, sql`
    UPDATE document_extraction_suggestions
    SET accepted_by = ${req.userId!}, accepted_at = now()
    WHERE id = ${suggestionId} AND job_id = ${jobId}
  `);
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "documents.extraction.suggestion.accept",
    entityType: "case_document",
    entityId: Number(s.case_document_id),
    detail: `caseId=${Number(s.case_id)} suggestionId=${suggestionId} field=${String(s.field_key)} applied=${outcome.applied ? "1" : "0"} override=${overrideExisting ? "1" : "0"} old=${String(outcome.oldValue ?? "")} new=${String(outcome.newValue ?? "")}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json({ ok: true, outcome });
});

router.post("/extractions/jobs/:jobId/apply", requireAuth, requireFirmUser, requirePermission("documents", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const jobId = Number.parseInt(one((req.params as any).jobId) ?? "", 10);
  if (!Number.isFinite(jobId)) { res.status(400).json({ error: "Invalid jobId" }); return; }
  const suggestionIds = Array.isArray((req.body as any)?.suggestionIds) ? (req.body as any).suggestionIds : [];
  const overrideExisting = Boolean((req.body as any)?.overrideExisting ?? false);
  const ids = suggestionIds.filter((x: any) => typeof x === "number" && Number.isFinite(x));
  if (ids.length === 0) { res.status(400).json({ error: "No suggestionIds" }); return; }
  const rows = await queryRows(r, sql`
    SELECT s.*, j.case_id, j.case_document_id
    FROM document_extraction_suggestions s
    JOIN document_extraction_jobs j ON j.id = s.job_id
    WHERE s.job_id = ${jobId} AND s.id = ANY(${ids as any}) AND j.firm_id = ${req.firmId!}
  `);
  if (rows.length === 0) { res.status(404).json({ error: "No suggestions found" }); return; }
  const outcomes: any[] = [];
  for (const row of rows) {
    const s = row as any;
    const outcome = await applyExtractionSuggestion({
      r,
      firmId: req.firmId!,
      caseId: Number(s.case_id),
      actorId: req.userId!,
      suggestion: { fieldKey: String(s.field_key), suggestedValue: s.suggested_value ? String(s.suggested_value) : null, targetEntityType: s.target_entity_type ? String(s.target_entity_type) : null },
      overrideExisting,
    });
    await queryRows(r, sql`UPDATE document_extraction_suggestions SET accepted_by = ${req.userId!}, accepted_at = now() WHERE id = ${Number(s.id)} AND job_id = ${jobId}`);
    outcomes.push({ suggestionId: Number(s.id), fieldKey: String(s.field_key), ...outcome });
  }
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.extraction.apply", entityType: "document_extraction_job", entityId: jobId, detail: `applied=${outcomes.filter((o) => o.applied).length}/${outcomes.length} override=${overrideExisting ? "1" : "0"}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ ok: true, outcomes });
});

router.delete("/cases/:caseId/documents/:docId", requireAuth, requireFirmUser, requirePermission("documents", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const docIdStr = one((req.params as any).docId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (Number.isNaN(caseId) || Number.isNaN(docId)) {
    res.status(400).json({ error: "Invalid document ID" });
    return;
  }

  const rows = await queryRows(
    r,
    sql`DELETE FROM case_documents WHERE id = ${docId} AND case_id = ${caseId} AND firm_id = ${req.firmId!} RETURNING *`
  );

  if (!rows[0]) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const deleted = rows[0];
  const deletedName = deleted && typeof deleted === "object" && "name" in deleted ? String((deleted as { name?: unknown }).name) : undefined;
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.delete", entityType: "case_document", entityId: docId, detail: deletedName ? `caseId=${caseId} name=${deletedName}` : `caseId=${caseId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });

  if (await tableExists(r, "public.case_document_checklist_items")) {
    const linked = await queryRows(r, sql`
      SELECT checklist_key
      FROM case_document_checklist_items
      WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND case_document_id = ${docId}
    `);
    for (const row of linked) {
      const checklistKey = typeof row.checklist_key === "string" ? String(row.checklist_key) : String(row.checklist_key ?? "");
      if (!checklistKey) continue;
      await queryRows(r, sql`
        UPDATE case_document_checklist_items
        SET
          case_document_id = NULL,
          status = 'pending',
          completed_at = NULL,
          completed_by = NULL,
          updated_at = now()
        WHERE firm_id = ${req.firmId!} AND case_id = ${caseId} AND checklist_key = ${checklistKey}
      `);
      await writeAuditLog({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: req.userType,
        action: "checklist.upload_removed",
        entityType: "case",
        entityId: caseId,
        detail: `checklistKey=${checklistKey} caseDocumentId=${docId}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }
  }

  res.sendStatus(204);
});

export default router;
