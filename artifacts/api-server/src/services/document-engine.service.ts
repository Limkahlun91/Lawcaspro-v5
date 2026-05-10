import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { db, casesTable, templatesTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";

export class DocumentEngineService {
  private static buildCaseVariables(caseData: {
    id: number;
    referenceNo: string;
    status: string;
    purchaseMode: string;
    titleType: string;
    parcelNo: string | null;
    spaPrice: unknown;
  }): Record<string, unknown> {
    const today = new Date();
    const spaPrice =
      typeof caseData.spaPrice === "number"
        ? caseData.spaPrice
        : typeof caseData.spaPrice === "string"
          ? Number(caseData.spaPrice)
          : null;

    return {
      case_id: caseData.id,
      reference_no: caseData.referenceNo,
      case_file_no: caseData.referenceNo,
      case_status: caseData.status,
      purchase_mode: caseData.purchaseMode,
      title_type: caseData.titleType,
      parcel_no: caseData.parcelNo ?? "",
      spa_price: Number.isFinite(spaPrice as number) ? spaPrice : "",
      date_today: today.toLocaleDateString("en-MY"),
      date_today_iso: today.toISOString().slice(0, 10),
    };
  }

  private static renderDocx(templateBuffer: Buffer, variables: Record<string, unknown>): Buffer {
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: "{{", end: "}}" },
      nullGetter() {
        return "";
      },
    });
    doc.render(variables);
    return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  }

  private static normalizePdfMappingConfig(raw: unknown): Array<{
    key: string;
    page: number;
    x: number;
    y: number;
    size: number;
    maxWidth?: number;
    lineHeight?: number;
    alignment?: "left" | "center" | "right";
    fontFamily?: "Helvetica" | "Times-Roman" | "Courier";
  }> {
    const out: Array<{
      key: string;
      page: number;
      x: number;
      y: number;
      size: number;
      maxWidth?: number;
      lineHeight?: number;
      alignment?: "left" | "center" | "right";
      fontFamily?: "Helvetica" | "Times-Roman" | "Courier";
    }> = [];

    const pushOne = (key: unknown, coord: any) => {
      if (typeof key !== "string" || !key.trim()) return;
      const page = typeof coord?.page === "number" && Number.isFinite(coord.page) ? Math.max(1, Math.floor(coord.page)) : 1;
      const x = typeof coord?.x === "number" && Number.isFinite(coord.x) ? coord.x : NaN;
      const y = typeof coord?.y === "number" && Number.isFinite(coord.y) ? coord.y : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const size = typeof coord?.size === "number" && Number.isFinite(coord.size) ? Math.max(1, coord.size) : 12;
      const maxWidth = typeof coord?.maxWidth === "number" && Number.isFinite(coord.maxWidth) ? Math.max(1, coord.maxWidth) : undefined;
      const lineHeight = typeof coord?.lineHeight === "number" && Number.isFinite(coord.lineHeight) ? Math.max(1, coord.lineHeight) : undefined;
      const alignment =
        coord?.alignment === "left" || coord?.alignment === "center" || coord?.alignment === "right"
          ? coord.alignment
          : undefined;
      const fontFamily =
        coord?.fontFamily === "Helvetica" || coord?.fontFamily === "Times-Roman" || coord?.fontFamily === "Courier"
          ? coord.fontFamily
          : undefined;
      out.push({ key: key.trim(), page, x, y, size, ...(maxWidth ? { maxWidth } : {}), ...(lineHeight ? { lineHeight } : {}), ...(alignment ? { alignment } : {}), ...(fontFamily ? { fontFamily } : {}) });
    };

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const rec = item as any;
        const key = typeof rec.key === "string" ? rec.key : typeof rec.variableKey === "string" ? rec.variableKey : typeof rec.variable === "string" ? rec.variable : undefined;
        pushOne(key, rec);
      }
      return out;
    }

    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        pushOne(k, v as any);
      }
    }

    return out;
  }

  private static wrapLines(text: string, font: any, fontSize: number, maxWidth: number): string[] {
    const t = text.trim();
    if (!t) return [""];
    const words = t.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const w of words) {
      const next = current ? `${current} ${w}` : w;
      const width = font.widthOfTextAtSize(next, fontSize);
      if (width <= maxWidth || !current) {
        current = next;
      } else {
        lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [t];
  }

  private static async renderPdf(templateBuffer: Buffer, variables: Record<string, unknown>, mappingConfig: unknown): Promise<Buffer> {
    const pdf = await PDFDocument.load(templateBuffer);
    const fontCache = new Map<"Helvetica" | "Times-Roman" | "Courier", any>();
    const getFont = async (family?: string) => {
      const f =
        family === "Times-Roman" || family === "Courier" || family === "Helvetica"
          ? (family as "Helvetica" | "Times-Roman" | "Courier")
          : "Helvetica";
      const cached = fontCache.get(f);
      if (cached) return cached;
      const font =
        f === "Times-Roman"
          ? await pdf.embedFont(StandardFonts.TimesRoman)
          : f === "Courier"
            ? await pdf.embedFont(StandardFonts.Courier)
            : await pdf.embedFont(StandardFonts.Helvetica);
      fontCache.set(f, font);
      return font;
    };
    const mappings = this.normalizePdfMappingConfig(mappingConfig);

    for (const m of mappings) {
      const raw = (variables as any)[m.key];
      const value = raw === null || raw === undefined ? "" : String(raw);
      const page = pdf.getPage(m.page - 1);
      if (!page) continue;
      const font = await getFont(m.fontFamily);
      const fontSize = m.size;
      const lineHeight = m.lineHeight ?? Math.ceil(fontSize * 1.2);
      const lines = m.maxWidth ? this.wrapLines(value, font, fontSize, m.maxWidth) : value.split(/\r?\n/);
      const align = m.alignment === "center" || m.alignment === "right" ? m.alignment : "left";
      for (let i = 0; i < lines.length; i++) {
        const y = m.y - i * lineHeight;
        const line = lines[i] ?? "";
        const x = (() => {
          if (!m.maxWidth) return m.x;
          const textWidth = font.widthOfTextAtSize(line, fontSize);
          if (align === "center") return Math.max(m.x, m.x + (m.maxWidth - textWidth) / 2);
          if (align === "right") return Math.max(m.x, m.x + (m.maxWidth - textWidth));
          return m.x;
        })();
        page.drawText(line, { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
    }

    const out = await pdf.save();
    return Buffer.from(out);
  }

  static async generateDocument(caseId: number, templateId: number, fileBuffer: Buffer, firmId?: number, isFounder?: boolean): Promise<{ buffer: Buffer; fileType: "docx" | "pdf" }> {
    const fid = typeof firmId === "number" && Number.isFinite(firmId) ? firmId : NaN;
    if (Number.isNaN(fid)) {
      throw new Error("firmId is required");
    }

    const [tpl] = await db
      .select({
        id: templatesTable.id,
        firmId: templatesTable.firmId,
        fileType: templatesTable.fileType,
        mappingConfig: templatesTable.mappingConfig,
        isActive: templatesTable.isActive,
      })
      .from(templatesTable)
      .where(
        isFounder
          ? eq(templatesTable.id, templateId)
          : and(eq(templatesTable.id, templateId), or(eq(templatesTable.firmId, fid), isNull(templatesTable.firmId)))
      )
      .limit(1);

    if (!tpl || tpl.isActive === false) {
      throw new Error(`Template with ID ${templateId} not found`);
    }
    const fileType = typeof tpl.fileType === "string" ? tpl.fileType.toLowerCase() : "";
    if (fileType !== "docx" && fileType !== "pdf") {
      throw new Error(`Unsupported template file_type: ${String(tpl.fileType)}`);
    }

    const [caseData] = await db
      .select({
        id: casesTable.id,
        referenceNo: casesTable.referenceNo,
        status: casesTable.status,
        purchaseMode: casesTable.purchaseMode,
        titleType: casesTable.titleType,
        parcelNo: casesTable.parcelNo,
        spaPrice: casesTable.spaPrice,
      })
      .from(casesTable)
      .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, fid)))
      .limit(1);

    if (!caseData) {
      throw new Error(`Case with ID ${caseId} not found`);
    }

    const variables = this.buildCaseVariables(caseData);
    if (fileType === "docx") {
      return { buffer: this.renderDocx(fileBuffer, variables), fileType: "docx" };
    }
    return { buffer: await this.renderPdf(fileBuffer, variables, tpl.mappingConfig), fileType: "pdf" };
  }

  static async generateDocxForCase(firmId: number, caseId: number, templateBuffer: Buffer): Promise<Buffer> {
    const [caseData] = await db
      .select({
        id: casesTable.id,
        referenceNo: casesTable.referenceNo,
        firmId: casesTable.firmId,
        status: casesTable.status,
        purchaseMode: casesTable.purchaseMode,
        titleType: casesTable.titleType,
        parcelNo: casesTable.parcelNo,
        spaPrice: casesTable.spaPrice,
      })
      .from(casesTable)
      .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)))
      .limit(1);

    if (!caseData) {
      throw new Error(`Case with ID ${caseId} not found`);
    }

    try {
      const templateVariables = this.buildCaseVariables(caseData);
      return this.renderDocx(templateBuffer, templateVariables);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
      throw new Error(`Document generation failed: ${message.slice(0, 240)}`);
    }
  }
}
