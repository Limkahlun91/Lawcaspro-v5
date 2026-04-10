import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, documentTemplatesTable, caseDocumentsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";
import { ObjectStorageService, ObjectNotFoundError, SupabaseStorageService } from "../lib/objectStorage";
import { Readable } from "stream";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

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

function safeJson(str: unknown): Record<string, unknown> {
  if (!str || typeof str !== "string") return {};
  try { return JSON.parse(str); } catch { return {}; }
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

  const ext = (typeof extension === "string" ? extension : "").trim().toLowerCase() || (fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "");
  const isTemplateCapable = kindVal === "template" && ext === "docx";

  const rows = await queryRows(
    r,
    sql`INSERT INTO document_templates (firm_id, name, document_type, description, object_path, file_name, created_by)
        VALUES (${req.firmId!}, ${name}, ${documentType ?? "other"}, ${description ?? null}, ${objectPath}, ${fileName}, ${req.userId!})
        RETURNING *`
  );

  const created = rows[0];
  const createdId = created && typeof created === "object" && "id" in created ? Number((created as any).id) : undefined;

  const patched = await queryRows(
    r,
    sql`UPDATE document_templates
        SET folder_id = ${folderIdNum},
            kind = ${kindVal},
            mime_type = ${mimeType ?? null},
            extension = ${ext || null},
            file_size = ${typeof fileSize === "number" ? fileSize : null},
            is_template_capable = ${isTemplateCapable},
            updated_at = now()
        WHERE id = ${createdId ?? 0} AND firm_id = ${req.firmId!}
        RETURNING *`
  );

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_document.upload", entityType: "firm_document", entityId: createdId, detail: `name=${name} kind=${kindVal} ext=${ext}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
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
  const { folderId, kind } = req.body as { folderId?: number | null; kind?: string };
  const folderIdNum = typeof folderId === "number" ? folderId : null;
  const kindVal = typeof kind === "string" ? kind : undefined;
  if (kindVal && kindVal !== "template" && kindVal !== "reference") {
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
  const rows = await queryRows(
    r,
    sql`UPDATE document_templates
        SET folder_id = ${folderIdNum},
            kind = COALESCE(${kindVal ?? null}, kind),
            is_template_capable = (
              COALESCE(${kindVal ?? null}, kind) = 'template'
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
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.firm_document.move", entityType: "firm_document", entityId: templateId, detail: `folderId=${folderIdNum ?? "null"}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(rows[0]);
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
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const description = typeof body.description === "string" ? body.description.trim() : undefined;
  const status = typeof body.status === "string" ? body.status : undefined;
  const footerMode = typeof body.footerMode === "string" ? body.footerMode : undefined;
  if (status && status !== "active" && status !== "inactive") {
    res.status(400).json({ error: "Invalid status" });
    return;
  }
  if (footerMode && footerMode !== "every_page" && footerMode !== "last_page_only") {
    res.status(400).json({ error: "Invalid footerMode" });
    return;
  }
  const rows = await queryRows(
    r,
    sql`UPDATE firm_letterheads
        SET name = COALESCE(${name ?? null}, name),
            description = CASE WHEN ${description ?? null} IS NULL THEN description ELSE ${description ?? null} END,
            status = COALESCE(${status ?? null}, status),
            footer_mode = COALESCE(${footerMode ?? null}, footer_mode),
            updated_at = now()
        WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}
        RETURNING *`
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Letterhead not found" });
    return;
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
    sql`SELECT id FROM firm_letterheads WHERE id = ${letterheadId} AND firm_id = ${req.firmId!}`
  );
  if (!exists[0]) {
    res.status(404).json({ error: "Letterhead not found" });
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
    LEFT JOIN users u ON cd.generated_by = u.id
    WHERE cd.case_id = ${caseId} AND cd.firm_id = ${req.firmId!}
    ORDER BY cd.created_at DESC`
  );
  res.json(rows);
});

router.post("/cases/:caseId/documents/generate", requireAuth, requireFirmUser, requirePermission("documents", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const { templateId, documentName, letterheadId } = req.body as { templateId: number; documentName?: string; letterheadId?: number | null };

  if (!templateId) {
    res.status(400).json({ error: "templateId is required" });
    return;
  }

  const templateRows = await queryRows(
    r,
    sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`
  );
  if (!templateRows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const template = templateRows[0];
  const templateCapable = template && typeof template === "object" && "is_template_capable" in template ? Boolean((template as any).is_template_capable) : true;
  const templateDocType = template && typeof template === "object" && "document_type" in template ? String((template as any).document_type) : "other";
  if (!templateCapable) {
    res.status(400).json({ error: "Selected document is not template-capable", code: "NOT_TEMPLATE_CAPABLE" });
    return;
  }

  const context = await buildCaseContext(r, caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  try {
    const objectFile = await storage.getObjectEntityFile(template.object_path as string);
    const [fileContents] = await objectFile.download();

    const zip = new PizZip(fileContents);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    doc.render(context);

    let buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;

    const isLetterLike = templateDocType.includes("letter") || templateDocType === "acting_letter" || templateDocType === "undertaking";
    if (isLetterLike) {
      const letterheadIdNum = typeof letterheadId === "number" ? letterheadId : null;
      const lhRows = letterheadIdNum !== null
        ? await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE id = ${letterheadIdNum} AND firm_id = ${req.firmId!} AND status = 'active'`)
        : await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE firm_id = ${req.firmId!} AND status = 'active' ORDER BY is_default DESC, created_at DESC LIMIT 1`);
      const lh = lhRows[0];
      if (!lh) {
        res.status(400).json({ error: "No firm letterhead configured", code: "NO_LETTERHEAD" });
        return;
      }
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

    const uploadURL = await storage.getObjectEntityUploadURL();

    const uploadRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      res.status(500).json({ error: "Failed to upload generated document", detail });
      return;
    }

    const normalizedPath = storage.normalizeObjectEntityPath(uploadURL.split("?")[0]);
    const docName = documentName ?? `${template.name} - ${context.reference_no}`;
    const fileName = `${docName.replace(/[^a-zA-Z0-9 \-_]/g, "_")}.docx`;

    const docRows = await queryRows(r, sql`
      INSERT INTO case_documents (case_id, firm_id, template_id, name, document_type, status, object_path, file_name, generated_by)
      VALUES (${caseId}, ${req.firmId!}, ${templateId}, ${docName}, ${template.document_type as string}, 'generated', ${normalizedPath}, ${fileName}, ${req.userId!})
      RETURNING *`
    );

    const created = docRows[0];
    const createdId = created && typeof created === "object" && "id" in created && typeof (created as { id?: unknown }).id === "number"
      ? (created as { id: number }).id
      : undefined;
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.generate", entityType: "case_document", entityId: createdId, detail: `caseId=${caseId} templateId=${templateId} name=${docName} letterhead=${isLetterLike ? (typeof letterheadId === "number" ? letterheadId : "default") : "n/a"}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(docRows[0]);
  } catch (err: unknown) {
    console.error("Document generation error:", err);
    res.status(500).json({
      error: "Failed to generate document",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post("/cases/:caseId/documents/generate-from-master", requireAuth, requireFirmUser, requirePermission("documents", "create"), async (req: AuthRequest, res): Promise<void> => {
  const r = getRlsDb(req, res);
  if (!r) return;
  const caseIdStr = one((req.params as any).caseId);
  const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
  if (Number.isNaN(caseId)) {
    res.status(400).json({ error: "Invalid case ID" });
    return;
  }
  const { masterDocId, documentName, letterheadId } = req.body as { masterDocId: number; documentName?: string; letterheadId?: number | null };

  if (!masterDocId) {
    res.status(400).json({ error: "masterDocId is required" });
    return;
  }

  const docRows2 = await queryRows(
    r,
    sql`SELECT * FROM platform_documents WHERE id = ${masterDocId} AND (firm_id IS NULL OR firm_id = ${req.firmId!})`
  );
  if (!docRows2[0]) {
    res.status(404).json({ error: "Master document not found" });
    return;
  }
  const masterDoc = docRows2[0];
  const masterFileName = masterDoc.file_name as string;
  const isDocx = masterFileName.toLowerCase().endsWith(".docx") || masterFileName.toLowerCase().endsWith(".doc");

  const context = await buildCaseContext(r, caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  try {
    const objectFile = await storage.getObjectEntityFile(masterDoc.object_path as string);
    const [fileContents] = await objectFile.download();

    let buffer: Buffer;
    let outputMime: string;
    let outputExt: string;

    const isPdf = masterFileName.toLowerCase().endsWith(".pdf");

    if (isDocx) {
      const zip = new PizZip(fileContents);
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
      doc.render(context);
      buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
      outputMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      outputExt = ".docx";
    } else if (isPdf && masterDoc.pdf_mappings) {
      const mappings = masterDoc.pdf_mappings as { pages: Array<{ pageIndex: number; textBoxes: Array<{ id: string; x: number; y: number; width: number; height: number; fontSize: number; content: string }> }> };
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
            const val = (context as Record<string, unknown>)[key];
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
    } else {
      buffer = Buffer.from(fileContents);
      outputMime = masterDoc.file_type as string;
      outputExt = "." + masterFileName.split(".").pop();
    }

    if (isDocx) {
      const lhIdNum = typeof letterheadId === "number" ? letterheadId : null;
      const masterName = String((masterDoc as any).name ?? "").toLowerCase();
      const masterCategory = String((masterDoc as any).category ?? "").toLowerCase();
      const shouldApply = lhIdNum !== null || masterName.includes("letter") || masterCategory.includes("letter") || masterFileName.toLowerCase().includes("letter");
      if (shouldApply) {
        const lhRows = lhIdNum !== null
          ? await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE id = ${lhIdNum} AND firm_id = ${req.firmId!} AND status = 'active'`)
          : await queryRows(r, sql`SELECT * FROM firm_letterheads WHERE firm_id = ${req.firmId!} AND status = 'active' ORDER BY is_default DESC, created_at DESC LIMIT 1`);
        const lh = lhRows[0];
        if (!lh) {
          res.status(400).json({ error: "No firm letterhead configured", code: "NO_LETTERHEAD" });
          return;
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

    const uploadURL = await storage.getObjectEntityUploadURL();

    const uploadRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": outputMime },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      res.status(500).json({ error: "Failed to upload generated document", detail });
      return;
    }

    const normalizedPath = storage.normalizeObjectEntityPath(uploadURL.split("?")[0]);
    const docName = documentName ?? `${masterDoc.name} - ${context.reference_no}`;
    const fileName = `${docName.replace(/[^a-zA-Z0-9 \-_]/g, "_")}${outputExt}`;

    const savedRows = await queryRows(r, sql`
      INSERT INTO case_documents (case_id, firm_id, name, document_type, status, object_path, file_name, generated_by)
      VALUES (${caseId}, ${req.firmId!}, ${docName}, ${(masterDoc.category as string) || "other"}, 'generated', ${normalizedPath}, ${fileName}, ${req.userId!})
      RETURNING *`
    );

    const created = savedRows[0];
    const createdId = created && typeof created === "object" && "id" in created && typeof (created as { id?: unknown }).id === "number"
      ? (created as { id: number }).id
      : undefined;
    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.generate_from_master", entityType: "case_document", entityId: createdId, detail: `caseId=${caseId} masterDocId=${masterDocId} name=${docName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(savedRows[0]);
  } catch (err: unknown) {
    console.error("Master document generation error:", err);
    res.status(500).json({
      error: "Failed to generate document from master template",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

router.get("/document-variables", requireAuth, async (_req: AuthRequest, res): Promise<void> => {
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

  const rows = await queryRows(r, sql`
    INSERT INTO case_documents (case_id, firm_id, name, document_type, status, object_path, file_name, file_size, is_uploaded, generated_by)
    VALUES (${caseId}, ${req.firmId!}, ${name}, ${documentType ?? "other"}, 'uploaded', ${objectPath}, ${fileName}, ${fileSize ?? null}, true, ${req.userId!})
    RETURNING *`
  );

  const created = rows[0];
  const createdId = created && typeof created === "object" && "id" in created && typeof (created as { id?: unknown }).id === "number"
    ? (created as { id: number }).id
    : undefined;
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "documents.case.upload", entityType: "case_document", entityId: createdId, detail: `caseId=${caseId} name=${name} fileName=${fileName}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
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
    const objectFile = await storage.getObjectEntityFile(doc.object_path as string);
    const storageResp = await storage.downloadObject(objectFile);
    storageResp.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.setHeader("Content-Disposition", `attachment; filename="${doc.file_name}"`);
    if (!storageResp.body) {
      res.status(500).json({ error: "Failed to stream file" });
      return;
    }
    const nodeStream = Readable.fromWeb(storageResp.body as any);
    await new Promise<void>((resolve, reject) => {
      nodeStream.on("error", reject);
      res.on("finish", resolve);
      nodeStream.pipe(res);
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
    throw err;
  }
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
  res.sendStatus(204);
});

export default router;
