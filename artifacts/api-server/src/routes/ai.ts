import express, { type Response, type Router as ExpressRouter } from "express";
import multer from "multer";
import * as pdfParse from "pdf-parse";
import OpenAI from "openai";
import { z } from "zod/v4";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { ApiError, sendError, sendOk } from "../lib/api-response.js";
import { logger } from "../lib/logger.js";

const router: ExpressRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    const looksPdf = file.mimetype === "application/pdf" || name.endsWith(".pdf");
    if (!looksPdf) {
      const err = new Error("UNSUPPORTED_FILE_TYPE");
      (err as any).code = "UNSUPPORTED_FILE_TYPE";
      cb(err);
      return;
    }
    cb(null, true);
  },
});

type IntakePurchaser = { name: string; ic: string };
type ExtractedIntake = {
  purchasers?: IntakePurchaser[];
  purchaserName?: string;
  purchaserIc?: string;
  projectName?: string;
  propertyAddress?: string;
  parcelNo?: string;
  price?: string;
  loanBank?: string;
  loanAmount?: string;
};

function extractJsonObject(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) return null;
  return text.slice(first, last + 1);
}

function toCleanString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function normalizeExtracted(raw: unknown): ExtractedIntake {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const purchasersRaw = Array.isArray(obj.purchasers) ? (obj.purchasers as unknown[]) : [];
  const purchasers = purchasersRaw
    .map((p) => {
      const r = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
      return { name: toCleanString(r.name) ?? "", ic: toCleanString(r.ic) ?? "" };
    })
    .filter((p) => p.name || p.ic);

  const purchaserName = toCleanString(obj.purchaserName);
  const purchaserIc = toCleanString(obj.purchaserIc);

  const out: ExtractedIntake = {
    ...(purchasers.length ? { purchasers } : {}),
    ...(purchaserName ? { purchaserName } : {}),
    ...(purchaserIc ? { purchaserIc } : {}),
    ...(toCleanString(obj.projectName) ? { projectName: toCleanString(obj.projectName) } : {}),
    ...(toCleanString(obj.propertyAddress) ? { propertyAddress: toCleanString(obj.propertyAddress) } : {}),
    ...(toCleanString(obj.parcelNo) ? { parcelNo: toCleanString(obj.parcelNo) } : {}),
    ...(toCleanString(obj.price) ? { price: toCleanString(obj.price) } : {}),
    ...(toCleanString(obj.loanBank) ? { loanBank: toCleanString(obj.loanBank) } : {}),
    ...(toCleanString(obj.loanAmount) ? { loanAmount: toCleanString(obj.loanAmount) } : {}),
  };

  if (!out.purchasers?.length && (purchaserName || purchaserIc)) {
    out.purchasers = [{ name: purchaserName ?? "", ic: purchaserIc ?? "" }].filter((p) => p.name || p.ic);
  }

  return out;
}

function regexFallback(text: string): ExtractedIntake {
  const src = text.replace(/\r/g, "");
  const singleLine = (v: string): string => v.replace(/\s+/g, " ").trim();

  const projectName =
    toCleanString(/\bProject\s*Name\s*[:\-]\s*([^\n]+)/i.exec(src)?.[1]) ??
    toCleanString(/\bProject\s*[:\-]\s*([^\n]+)/i.exec(src)?.[1]);
  const parcelNo =
    toCleanString(/\b(Unit|Parcel|Property)\s*(No\.?|Number)?\s*[:\-]\s*([^\n]+)/i.exec(src)?.[3]) ??
    toCleanString(/\bUnit\s*No\.?\s*[:\-]\s*([^\n]+)/i.exec(src)?.[1]);

  const addressBlock = /\b(Address|Property\s*Address)\s*[:\-]\s*([\s\S]{0,300})/i.exec(src)?.[2];
  const propertyAddress = addressBlock ? singleLine(addressBlock.split("\n").slice(0, 3).join(" ")) : undefined;

  const nameMatches = Array.from(src.matchAll(/\bName\s*[:\-]\s*([^\n]+)/gi)).map((m) => singleLine(m[1] ?? ""));
  const icMatches = Array.from(src.matchAll(/\b(NRIC|IC\s*No\.?)\s*[:\-]\s*([A-Z0-9-]+)/gi)).map((m) => singleLine(m[2] ?? ""));

  const purchasers: IntakePurchaser[] = [];
  const max = Math.max(nameMatches.length, icMatches.length, 1);
  for (let i = 0; i < Math.min(max, 6); i++) {
    const name = nameMatches[i] ?? "";
    const ic = icMatches[i] ?? "";
    if (!name && !ic) continue;
    purchasers.push({ name, ic });
  }

  const price = toCleanString(/\bPrice\s*[:\-]?\s*RM?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i.exec(src)?.[1]?.replace(/,/g, ""));
  const loanAmount = toCleanString(/\bLoan\s*Amount\s*[:\-]?\s*RM?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i.exec(src)?.[1]?.replace(/,/g, ""));
  const loanBank =
    toCleanString(/\bLoan\s*Bank\s*[:\-]\s*([^\n]+)/i.exec(src)?.[1]) ??
    toCleanString(/\bBank\s*Name\s*[:\-]\s*([^\n]+)/i.exec(src)?.[1]) ??
    toCleanString(/\bBank\s*[:\-]\s*([^\n]+)/i.exec(src)?.[1]);

  return {
    ...(purchasers.length ? { purchasers } : {}),
    ...(purchasers[0]?.name ? { purchaserName: purchasers[0].name } : {}),
    ...(purchasers[0]?.ic ? { purchaserIc: purchasers[0].ic } : {}),
    ...(projectName ? { projectName } : {}),
    ...(propertyAddress ? { propertyAddress } : {}),
    ...(parcelNo ? { parcelNo } : {}),
    ...(price ? { price } : {}),
    ...(loanBank ? { loanBank } : {}),
    ...(loanAmount ? { loanAmount } : {}),
  };
}

const AiExtractBody = z.object({
  file: z.any().optional(),
});

router.post(
  "/ai/extract",
  requireAuth,
  requireFirmUser,
  requirePermission("cases", "create"),
  upload.single("file"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const warnings: Array<{ code: string; message: string }> = [];
    try {
      const file = (req as any).file as { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined;
      if (!file?.buffer) {
        throw new ApiError({ status: 400, code: "MISSING_FILE", message: "Missing PDF file", retryable: false });
      }
      AiExtractBody.parse({ file: file.buffer });

      let rawText = "";
      try {
        const parser = new pdfParse.PDFParse({ data: file.buffer });
        const parsed = await parser.getText();
        rawText = String(parsed?.text ?? "").trim();
        await parser.destroy().catch(() => undefined);
      } catch {
        throw new ApiError({ status: 400, code: "PDF_TEXT_EXTRACTION_FAILED", message: "Unable to extract text from PDF", retryable: false });
      }

      if (rawText.length < 20) {
        throw new ApiError({ status: 400, code: "PDF_TEXT_TOO_SHORT", message: "PDF text is too short for extraction", retryable: false });
      }

      const openaiKey = process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY) : "";
      const geminiKey = process.env.GEMINI_API_KEY ? String(process.env.GEMINI_API_KEY) : "";

      let extracted: ExtractedIntake | null = null;

      if (openaiKey) {
        try {
          const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini");
          const client = new OpenAI({ apiKey: openaiKey });
          const system = [
            "你是一個馬來西亞房產 conveyancing 的 intake assistant。",
            "請從文本中提取欄位，並只輸出一個 JSON object（不要 markdown / 不要解釋）。",
            "欄位：purchasers (array of {name, ic}), projectName, propertyAddress, parcelNo, price, loanBank, loanAmount。",
            "未知就省略該欄位或輸出空字串。",
          ].join("\n");
          const user = [
            "只輸出 JSON object。",
            "",
            "PDF Text:",
            rawText.slice(0, 120_000),
          ].join("\n");
          const completion = await client.chat.completions.create({
            model,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          });
          const aiText = String(completion.choices?.[0]?.message?.content ?? "").trim();
          const jsonText = extractJsonObject(aiText) ?? aiText;
          extracted = normalizeExtracted(JSON.parse(jsonText));
        } catch (err) {
          logger.error({ err, firmId: req.firmId, userId: req.userId }, "[ai.extract] openai failed");
          warnings.push({ code: "AI_OPENAI_FAILED", message: "OpenAI extraction failed. Falling back to basic extraction." });
        }
      } else if (geminiKey) {
        try {
          const model = String(process.env.GEMINI_MODEL || "gemini-1.5-flash");
          const prompt = [
            "Return ONLY a JSON object. No markdown. No extra text.",
            "Fields: purchasers (array of {name, ic}), projectName, propertyAddress, parcelNo, price, loanBank, loanAmount.",
            "",
            rawText.slice(0, 120_000),
          ].join("\n");
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0 },
              }),
            },
          );
          const body = await resp.json().catch(() => null);
          const txt = String((body as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
          const jsonText = extractJsonObject(txt) ?? txt;
          extracted = normalizeExtracted(JSON.parse(jsonText));
        } catch (err) {
          logger.error({ err, firmId: req.firmId, userId: req.userId }, "[ai.extract] gemini failed");
          warnings.push({ code: "AI_GEMINI_FAILED", message: "Gemini extraction failed. Falling back to basic extraction." });
        }
      } else {
        warnings.push({ code: "AI_FALLBACK_REGEX", message: "No AI key configured. Using basic extraction." });
      }

      if (!extracted) {
        extracted = regexFallback(rawText);
        if (!warnings.some((w) => w.code === "AI_FALLBACK_REGEX")) {
          warnings.push({ code: "AI_FALLBACK_REGEX", message: "Using basic extraction." });
        }
      }

      try {
        await writeAuditLog({
          firmId: req.firmId,
          actorId: req.userId,
          actorType: req.userType,
          action: "ai.extract.intake",
          entityType: "ai_extract",
          detail: `filename=${String(file.originalname || "pdf")}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
      } catch (err) {
        logger.error({ err, firmId: req.firmId, userId: req.userId }, "[ai.extract] audit failed");
        warnings.push({ code: "AUDIT_LOG_FAILED", message: "Audit logging is temporarily unavailable." });
      }

      sendOk(res as any, extracted, { warnings: warnings.length ? warnings : undefined });
    } catch (err) {
      sendError(res as any, err, { status: 500, code: "AI_EXTRACT_FAILED", message: "AI extraction failed" });
    }
  },
);

export default router;
