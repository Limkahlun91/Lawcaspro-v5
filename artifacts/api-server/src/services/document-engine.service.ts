import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import ImageModule from "docxtemplater-image-module-free";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { db, casesTable, firmsTable, templatesTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { SupabaseStorageService } from "../lib/objectStorage.js";

const supabaseStorage = new SupabaseStorageService();

export class DataFetchTimeoutError extends Error {
  constructor() {
    super("Data fetch timed out");
    this.name = "DataFetchTimeoutError";
    Object.setPrototypeOf(this, DataFetchTimeoutError.prototype);
  }
}

export class DocumentEngineService {
  private static withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return p;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DataFetchTimeoutError()), timeoutMs);
      p.then((v) => {
        clearTimeout(timer);
        resolve(v);
      }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
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

  private static buildFirmVariables(firmData: {
    name: string;
    logoUrl: string | null;
    address: string | null;
    stNumber: string | null;
    tinNumber: string | null;
    registrationNo: string | null;
    sstNo: string | null;
    phone: string | null;
    email: string | null;
    logoBuffer: Buffer | null;
  }): Record<string, unknown> {
    return {
      firm_name: firmData.name,
      firm_address: firmData.address ?? "",
      firm_registration_no: firmData.registrationNo ?? "",
      firm_sst_no: firmData.sstNo ?? firmData.stNumber ?? "",
      firm_st_no: firmData.stNumber ?? "",
      firm_tin_no: firmData.tinNumber ?? "",
      firm_phone: firmData.phone ?? "",
      firm_email: firmData.email ?? "",
      firm_logo: firmData.logoBuffer ?? "",
      firm_logo_url: firmData.logoUrl ?? "",
    };
  }

  private static async loadFirmLogoBuffer(logoUrl: string | null, timeoutMs: number): Promise<Buffer | null> {
    const url = typeof logoUrl === "string" ? logoUrl.trim() : "";
    if (!url) return null;
    try {
      if (url.startsWith("/objects/")) {
        supabaseStorage.assertConfigured();
        const resp = await this.withTimeout(supabaseStorage.fetchPrivateObjectResponse(url, { timeoutMs: 15_000 }), timeoutMs);
        const ab = await resp.arrayBuffer();
        return Buffer.from(ab);
      }
      if (/^https?:\/\//i.test(url)) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const resp = await fetch(url, { method: "GET", signal: controller.signal });
          if (!resp.ok) return null;
          const ab = await resp.arrayBuffer();
          return Buffer.from(ab);
        } finally {
          clearTimeout(timer);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private static renderDocx(templateBuffer: Buffer, variables: Record<string, unknown>): Buffer {
    const zip = new PizZip(templateBuffer);
    const imageModule = new (ImageModule as any)({
      getImage: (tagValue: unknown) => (Buffer.isBuffer(tagValue) ? tagValue : Buffer.alloc(0)),
      getSize: (img: unknown) => {
        if (!Buffer.isBuffer(img) || img.length === 0) return [0, 0];
        return [160, 60];
      },
    });
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      modules: [imageModule],
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
    value?: string;
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
      value?: string;
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
      const value =
        typeof coord?.value === "string"
          ? coord.value
          : typeof coord?.content === "string"
            ? coord.content
            : typeof coord?.expression === "string"
              ? coord.expression
              : undefined;
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
      out.push({
        key: key.trim(),
        ...(value !== undefined ? { value } : {}),
        page,
        x,
        y,
        size,
        ...(maxWidth ? { maxWidth } : {}),
        ...(lineHeight ? { lineHeight } : {}),
        ...(alignment ? { alignment } : {}),
        ...(fontFamily ? { fontFamily } : {}),
      });
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

  private static interpolateTemplate(template: string, variables: Record<string, unknown>): string {
    const resolvePath = (path: string): unknown => {
      if (!path) return undefined;
      if (!path.includes(".")) return (variables as any)[path];
      const parts = path.split(".").filter(Boolean);
      let cur: any = variables;
      for (const p of parts) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[p];
      }
      return cur;
    };
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
      const raw = resolvePath(String(key));
      return raw === null || raw === undefined ? "" : String(raw);
    });
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
      const value = (() => {
        if (typeof m.value === "string") return this.interpolateTemplate(m.value, variables);
        const raw = (variables as any)[m.key];
        return raw === null || raw === undefined ? "" : String(raw);
      })();
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

    const timeoutMs = 10_000;
    const tplRes = db
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
    const [tpl] = await this.withTimeout(tplRes, timeoutMs);

    if (!tpl || tpl.isActive === false) {
      throw new Error(`Template with ID ${templateId} not found`);
    }
    const fileType = typeof tpl.fileType === "string" ? tpl.fileType.toLowerCase() : "";
    if (fileType !== "docx" && fileType !== "pdf") {
      throw new Error(`Unsupported template file_type: ${String(tpl.fileType)}`);
    }

    const caseRes = db
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
    const [caseData] = await this.withTimeout(caseRes, timeoutMs);

    if (!caseData) {
      throw new Error(`Case with ID ${caseId} not found`);
    }

    const firmRes = db
      .select({
        name: firmsTable.name,
        logoUrl: firmsTable.logoUrl,
        address: firmsTable.address,
        stNumber: firmsTable.stNumber,
        tinNumber: firmsTable.tinNumber,
        registrationNo: firmsTable.registrationNo,
        sstNo: firmsTable.sstNo,
        phone: firmsTable.phone,
        email: firmsTable.email,
      })
      .from(firmsTable)
      .where(eq(firmsTable.id, fid))
      .limit(1);
    const [firmData] = await this.withTimeout(firmRes, timeoutMs);
    const logoBuffer = firmData ? await this.loadFirmLogoBuffer(firmData.logoUrl, timeoutMs) : null;

    const variables = {
      ...this.buildCaseVariables(caseData),
      ...(firmData ? this.buildFirmVariables({ ...firmData, logoBuffer }) : {}),
    };
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
      const [firmData] = await db
        .select({
          name: firmsTable.name,
          logoUrl: firmsTable.logoUrl,
          address: firmsTable.address,
          stNumber: firmsTable.stNumber,
          tinNumber: firmsTable.tinNumber,
          registrationNo: firmsTable.registrationNo,
          sstNo: firmsTable.sstNo,
          phone: firmsTable.phone,
          email: firmsTable.email,
        })
        .from(firmsTable)
        .where(eq(firmsTable.id, firmId))
        .limit(1);
      const logoBuffer = firmData ? await this.loadFirmLogoBuffer(firmData.logoUrl, 15_000) : null;

      const templateVariables = {
        ...this.buildCaseVariables(caseData),
        ...(firmData ? this.buildFirmVariables({ ...firmData, logoBuffer }) : {}),
      };
      return this.renderDocx(templateBuffer, templateVariables);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
      throw new Error(`Document generation failed: ${message.slice(0, 240)}`);
    }
  }
}
