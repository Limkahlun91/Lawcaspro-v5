import { PDFDocument } from "pdf-lib";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DocxToPdfEngine =
  | "disabled"
  | "http_service"
  | "local_libreoffice"
  | "gotenberg"
  | "libreoffice";

export class DocxToPdfError extends Error {
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
    this.name = "DocxToPdfError";
    this.code = code;
    this.statusCode = statusCode;
    this.payload = payload;
    Object.setPrototypeOf(this, DocxToPdfError.prototype);
  }
}

function normalizeEngine(raw: string | undefined | null): DocxToPdfEngine {
  const v = String(raw ?? "").trim().toLowerCase();
  if (
    v === "http_service" ||
    v === "local_libreoffice" ||
    v === "disabled" ||
    v === "gotenberg" ||
    v === "libreoffice"
  )
    return v;
  if (v === "http" || v === "service") return "http_service";
  if (v === "local" || v === "soffice") return "local_libreoffice";
  return "disabled";
}

function getTimeoutMs(): number {
  const raw = process.env.DOCX_TO_PDF_TIMEOUT_MS;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return 90_000;
}

function isConfigured(engine: DocxToPdfEngine): boolean {
  if (engine === "disabled") return false;
  if (engine === "http_service") {
    return typeof process.env.DOCX_PDF_SERVICE_URL === "string" &&
      process.env.DOCX_PDF_SERVICE_URL.trim().length > 0;
  }
  if (engine === "gotenberg") {
    const url =
      (typeof process.env.DOCX_CONVERTER_URL === "string"
        ? process.env.DOCX_CONVERTER_URL
        : "") ||
      (typeof process.env.GOTENBERG_URL === "string" ? process.env.GOTENBERG_URL : "");
    return typeof url === "string" && url.trim().length > 0;
  }
  if (engine === "local_libreoffice" || engine === "libreoffice") {
    const bin =
      (typeof process.env.LIBREOFFICE_BIN === "string"
        ? process.env.LIBREOFFICE_BIN
        : "") ||
      (typeof process.env.SOFFICE_BIN === "string" ? process.env.SOFFICE_BIN : "");
    return typeof bin === "string" && bin.trim().length > 0;
  }
  return false;
}

export async function getDocxToPdfHealth(): Promise<{
  ok: boolean;
  engine: DocxToPdfEngine;
  configured: boolean;
  error?: string;
}> {
  const legacyProvider = process.env.DOCX_CONVERTER_PROVIDER;
  const engine = normalizeEngine(process.env.DOCX_TO_PDF_ENGINE ?? legacyProvider);
  const configured = isConfigured(engine);
  if (!configured) {
    return {
      ok: false,
      engine,
      configured: false,
      error: "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
    };
  }
  if (engine === "local_libreoffice" || engine === "libreoffice") {
    const bin =
      (typeof process.env.LIBREOFFICE_BIN === "string"
        ? process.env.LIBREOFFICE_BIN
        : "") ||
      (typeof process.env.SOFFICE_BIN === "string" ? process.env.SOFFICE_BIN : "");
    try {
      await access(bin);
      return { ok: true, engine, configured: true };
    } catch {
      return {
        ok: false,
        engine,
        configured: false,
        error: "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
      };
    }
  }
  return { ok: true, engine, configured: true };
}

async function assertPdfLooksValid(pdfBytes: Buffer): Promise<void> {
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length < 2500) {
    throw new DocxToPdfError(
      422,
      "DOCX_TO_PDF_OUTPUT_TOO_SMALL",
      "DOCX to PDF output is too small",
      { bytes: pdfBytes?.length ?? 0 },
    );
  }
  try {
    const pdf = await PDFDocument.load(pdfBytes);
    const pages = pdf.getPageCount();
    if (!(Number.isFinite(pages) && pages > 0)) {
      throw new DocxToPdfError(
        422,
        "DOCX_TO_PDF_INVALID_PDF",
        "DOCX to PDF output is invalid",
      );
    }
  } catch (err) {
    if (err instanceof DocxToPdfError) throw err;
    throw new DocxToPdfError(
      422,
      "DOCX_TO_PDF_INVALID_PDF",
      "DOCX to PDF output is invalid",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

async function convertViaHttpService(docxBytes: Buffer): Promise<Buffer> {
  const url = String(process.env.DOCX_PDF_SERVICE_URL ?? "").trim();
  if (!url) {
    throw new DocxToPdfError(
      503,
      "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
      "Word template PDF conversion is not configured.",
    );
  }
  const token = typeof process.env.DOCX_PDF_SERVICE_TOKEN === "string"
    ? process.env.DOCX_PDF_SERVICE_TOKEN.trim()
    : "";
  const controller = new AbortController();
  const timeoutMs = getTimeoutMs();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: docxBytes,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const msg = `DOCX to PDF service returned ${resp.status}`;
      throw new DocxToPdfError(503, "DOCX_TO_PDF_UNAVAILABLE", msg);
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    if (err instanceof DocxToPdfError) throw err;
    const aborted =
      err && typeof err === "object" && (err as any).name === "AbortError";
    if (aborted) {
      throw new DocxToPdfError(
        503,
        "DOCX_TO_PDF_TIMEOUT",
        "DOCX to PDF conversion timed out",
        { timeoutMs },
      );
    }
    throw new DocxToPdfError(
      503,
      "DOCX_TO_PDF_UNAVAILABLE",
      "DOCX to PDF converter is unavailable",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    clearTimeout(t);
  }
}

async function convertViaGotenberg(docxBytes: Buffer): Promise<Buffer> {
  const base =
    (typeof process.env.DOCX_CONVERTER_URL === "string"
      ? process.env.DOCX_CONVERTER_URL
      : "") ||
    (typeof process.env.GOTENBERG_URL === "string" ? process.env.GOTENBERG_URL : "");
  const baseUrl = String(base ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new DocxToPdfError(
      503,
      "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
      "Word template PDF conversion is not configured.",
    );
  }
  const controller = new AbortController();
  const timeoutMs = getTimeoutMs();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.set("files", new Blob([new Uint8Array(docxBytes)], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }), "template.docx");
    const resp = await fetch(`${baseUrl}/forms/libreoffice/convert`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new DocxToPdfError(
        503,
        "DOCX_TO_PDF_UNAVAILABLE",
        `DOCX to PDF converter returned ${resp.status}`,
      );
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    if (err instanceof DocxToPdfError) throw err;
    const aborted =
      err && typeof err === "object" && (err as any).name === "AbortError";
    if (aborted) {
      throw new DocxToPdfError(
        503,
        "DOCX_TO_PDF_TIMEOUT",
        "DOCX to PDF conversion timed out",
        { timeoutMs },
      );
    }
    throw new DocxToPdfError(
      503,
      "DOCX_TO_PDF_UNAVAILABLE",
      "DOCX to PDF converter is unavailable",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    clearTimeout(t);
  }
}

async function convertViaLocalLibreOffice(docxBytes: Buffer): Promise<Buffer> {
  const bin =
    (typeof process.env.LIBREOFFICE_BIN === "string"
      ? process.env.LIBREOFFICE_BIN
      : "") ||
    (typeof process.env.SOFFICE_BIN === "string" ? process.env.SOFFICE_BIN : "");
  const soffice = String(bin ?? "").trim();
  if (!soffice) {
    throw new DocxToPdfError(
      503,
      "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
      "Word template PDF conversion is not configured.",
    );
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "docx2pdf-"));
  const inPath = path.join(dir, "input.docx");
  const outDir = path.join(dir, "out");
  try {
    await writeFile(inPath, docxBytes);
    await execFileAsync(
      soffice,
      [
        "--headless",
        "--nologo",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        inPath,
      ],
      { timeout: getTimeoutMs(), windowsHide: true },
    );
    const outPath = path.join(outDir, "input.pdf");
    const pdfBytes = await readFile(outPath);
    return Buffer.from(pdfBytes);
  } catch (err) {
    const isTimeout =
      err && typeof err === "object" && (err as any).killed === true;
    if (isTimeout) {
      throw new DocxToPdfError(
        503,
        "DOCX_TO_PDF_TIMEOUT",
        "DOCX to PDF conversion timed out",
        { timeoutMs: getTimeoutMs() },
      );
    }
    throw new DocxToPdfError(
      503,
      "DOCX_TO_PDF_FAILED",
      "DOCX to PDF conversion failed",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
}

export async function convertDocxToPdf(docxBytes: Buffer): Promise<Buffer> {
  const legacyProvider = process.env.DOCX_CONVERTER_PROVIDER;
  const engine = normalizeEngine(process.env.DOCX_TO_PDF_ENGINE ?? legacyProvider);
  if (!isConfigured(engine)) {
    throw new DocxToPdfError(
      503,
      "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
      "Word template PDF conversion is not configured.",
    );
  }

  const pdfBytes = await (engine === "http_service"
    ? convertViaHttpService(docxBytes)
    : engine === "gotenberg"
      ? convertViaGotenberg(docxBytes)
      : engine === "local_libreoffice" || engine === "libreoffice"
        ? convertViaLocalLibreOffice(docxBytes)
        : convertViaHttpService(docxBytes));

  await assertPdfLooksValid(pdfBytes);
  return pdfBytes;
}
