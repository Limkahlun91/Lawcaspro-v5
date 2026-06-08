import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import ImageModule from "docxtemplater-image-module-free";

export type DocxRenderWarning =
  | { code: "UNSUPPORTED_LOOP"; key: string }
  | { code: "INVALID_RENDER_DATA"; key: string };

export class DocxTemplateRenderError extends Error {
  code: string;
  statusCode?: number;
  payload?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    payload?: unknown,
  ) {
    super(message);
    this.name = "DocxTemplateRenderError";
    this.code = code;
    this.statusCode = statusCode;
    this.payload = payload;
    Object.setPrototypeOf(this, DocxTemplateRenderError.prototype);
  }
}

function makeDocxImageModule() {
  return new (ImageModule as any)({
    getImage: (tagValue: unknown) =>
      Buffer.isBuffer(tagValue) ? tagValue : Buffer.alloc(0),
    getSize: (img: unknown) => {
      if (!Buffer.isBuffer(img) || img.length === 0) return [0, 0];
      return [160, 60];
    },
  });
}

function normalizeScalar(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "—";
    if (s === "undefined" || s === "null") return "—";
    if (s === "[MISSING]" || s.startsWith("[MISSING:")) return "—";
    return v;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : "—";
  if (typeof v === "boolean") return v;
  return String(v);
}

function sanitizeValue(
  v: unknown,
  warnings: DocxRenderWarning[],
  keyPath: string,
): unknown {
  if (Array.isArray(v)) return v.map((x, i) => sanitizeValue(x, warnings, `${keyPath}[${i}]`));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeValue(vv, warnings, keyPath ? `${keyPath}.${k}` : k);
    }
    return out;
  }
  return normalizeScalar(v);
}

function ensureArrayKey(data: Record<string, unknown>, key: string): void {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    data[key] = [];
    return;
  }
  const v = data[key];
  if (!Array.isArray(v)) data[key] = [];
}

export function renderDocxTemplate(args: {
  templateBytes: Buffer;
  data: Record<string, unknown>;
  placeholders?: string[];
}): { docxBytes: Buffer; warnings: DocxRenderWarning[] } {
  const warnings: DocxRenderWarning[] = [];
  const placeholders = Array.isArray(args.placeholders)
    ? args.placeholders.map((x) => String(x)).filter(Boolean)
    : [];
  const loopKeys = Array.from(
    new Set(
      placeholders
        .filter((k) => k.startsWith("#") && k.length > 1)
        .map((k) => k.slice(1))
        .filter(Boolean),
    ),
  );

  const allowedLoops = new Set(["purchasers", "borrowers", "vendors"]);
  const baseData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.data ?? {})) {
    baseData[k] = sanitizeValue(v, warnings, k);
  }
  for (const k of loopKeys) {
    if (!allowedLoops.has(k)) warnings.push({ code: "UNSUPPORTED_LOOP", key: k });
    ensureArrayKey(baseData, k);
  }
  ensureArrayKey(baseData, "purchasers");
  ensureArrayKey(baseData, "borrowers");
  ensureArrayKey(baseData, "vendors");

  try {
    const zip = new PizZip(args.templateBytes);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      modules: [makeDocxImageModule()],
      delimiters: { start: "{{", end: "}}" },
      nullGetter() {
        return "—";
      },
    });
    doc.render(baseData);
    const docxBytes = doc
      .getZip()
      .generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
    return { docxBytes, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DocxTemplateRenderError(
      422,
      "TEMPLATE_RENDER_FAILED",
      "Docx template render failed",
      { cause: msg },
    );
  }
}

