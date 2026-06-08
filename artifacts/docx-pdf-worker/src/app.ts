import express from "express";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalizeBearerToken(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const m = /^bearer\s+(.+)$/i.exec(s);
  return (m?.[1] ?? "").trim();
}

function normalizeLibreOfficeBin(): string {
  const b1 = typeof process.env.LIBREOFFICE_BIN === "string" ? process.env.LIBREOFFICE_BIN.trim() : "";
  const b2 = typeof process.env.SOFFICE_BIN === "string" ? process.env.SOFFICE_BIN.trim() : "";
  return (b1 || b2 || "soffice").trim();
}

function getTimeoutMs(): number {
  const raw = process.env.DOCX_PDF_WORKER_TIMEOUT_MS;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return 90_000;
}

function getRequiredToken(): string {
  const t = typeof process.env.DOCX_PDF_SERVICE_TOKEN === "string" ? process.env.DOCX_PDF_SERVICE_TOKEN.trim() : "";
  return t;
}

async function isLibreOfficeAvailable(): Promise<boolean> {
  const bin = normalizeLibreOfficeBin();
  try {
    if (bin.includes("/") || bin.includes("\\") || bin.includes(":")) {
      await access(bin);
    }
    await execFileAsync(bin, ["--version"], { timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function convertToPdf(bytes: Buffer, inputExt: "docx" | "doc"): Promise<Buffer> {
  const bin = normalizeLibreOfficeBin();
  const dir = await mkdtemp(path.join(os.tmpdir(), "docx-pdf-worker-"));
  try {
    const inPath = path.join(dir, `input.${inputExt}`);
    const outDir = path.join(dir, "out");
    await writeFile(inPath, bytes);
    await execFileAsync(
      bin,
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
    const out = await readFile(outPath);
    return Buffer.from(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", async (_req, res) => {
    const token = getRequiredToken();
    const tokenConfigured = Boolean(token);
    const libreoffice = await isLibreOfficeAvailable();
    const configured = tokenConfigured && libreoffice;
    res.status(200).json({
      ok: configured,
      configured,
      checks: {
        tokenConfigured,
        libreofficeAvailable: libreoffice,
      },
      engine: "local_libreoffice",
    });
  });

  app.post(
    "/convert",
    express.raw({ type: "*/*", limit: "20mb" }),
    async (req, res) => {
      const token = getRequiredToken();
      if (!token) {
        res.status(503).json({ error: "DOCX_PDF_SERVICE_TOKEN_NOT_CONFIGURED" });
        return;
      }
      const incoming = normalizeBearerToken(req.headers.authorization);
      if (!incoming || incoming !== token) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      const libreoffice = await isLibreOfficeAvailable();
      if (!libreoffice) {
        res.status(503).json({ error: "LIBREOFFICE_NOT_AVAILABLE" });
        return;
      }
      const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
      if (!bytes.length) {
        res.status(400).json({ error: "EMPTY_INPUT" });
        return;
      }
      const ct = String(req.headers["content-type"] ?? "").toLowerCase();
      const inputExt: "docx" | "doc" =
        ct.includes("application/msword") || ct.includes("application/doc") ? "doc" : "docx";
      try {
        const pdfBytes = await convertToPdf(bytes, inputExt);
        res.status(200);
        res.setHeader("Content-Type", "application/pdf");
        res.send(pdfBytes);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout =
          err && typeof err === "object" && ((err as any).killed === true || (err as any).signal === "SIGTERM");
        res.status(503).json({
          error: isTimeout ? "DOCX_TO_PDF_TIMEOUT" : "DOCX_TO_PDF_FAILED",
          message: msg,
        });
      }
    },
  );

  return app;
}
