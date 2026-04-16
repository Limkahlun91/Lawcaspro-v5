import PizZip from "pizzip";

export type ExtractionMethod = "text" | "ocr" | "hybrid";
export type DocumentTypeGuess = "ic_nric" | "loan_offer" | "title_search" | "spa" | "unknown";

export type ExtractionClassification = {
  fileKind: "pdf" | "docx" | "text" | "image" | "unknown";
  documentTypeGuess: DocumentTypeGuess;
  prefersOcr: boolean;
  warnings: string[];
};

export type RawExtraction = {
  extractedRawText: string;
  extractionMethod: ExtractionMethod;
  pageCount: number;
  warnings: string[];
  perPageText: string[];
  scannedPdfDetected?: boolean;
  rasterizedPagesCount?: number;
  ocrWarnings?: string[];
  perPageExtractionMethod?: Array<"text" | "ocr" | "none">;
};

export type StructuredSuggestion = {
  fieldKey: string;
  suggestedValue: string;
  confidence: number;
  sourcePage: number;
  sourceSnippet: string;
  documentTypeGuess: DocumentTypeGuess;
  targetEntityType: "client_primary_purchaser" | "case" | "case_spa" | "case_property" | "case_loan" | "case_key_dates";
};

export function classifyDocumentForExtraction(params: { fileName: string; mimeType?: string | null; hintDocumentType?: string | null }): ExtractionClassification {
  const fileName = String(params.fileName || "");
  const lower = fileName.toLowerCase();
  const mime = String(params.mimeType || "").toLowerCase();
  const warnings: string[] = [];

  let fileKind: ExtractionClassification["fileKind"] = "unknown";
  if (lower.endsWith(".pdf") || mime.includes("pdf")) fileKind = "pdf";
  else if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) fileKind = "docx";
  else if (lower.endsWith(".txt") || mime.startsWith("text/")) fileKind = "text";
  else if (/\.(png|jpg|jpeg|webp|gif)$/i.test(lower) || mime.startsWith("image/")) fileKind = "image";

  const hint = String(params.hintDocumentType || "").toLowerCase();
  let documentTypeGuess: DocumentTypeGuess = "unknown";
  if (hint.includes("ic") || hint.includes("nric") || hint.includes("passport")) documentTypeGuess = "ic_nric";
  else if (hint.includes("loan") || hint.includes("offer") || hint.includes("bank")) documentTypeGuess = "loan_offer";
  else if (hint.includes("title") || hint.includes("land") || hint.includes("hakmilik") || hint.includes("carian")) documentTypeGuess = "title_search";
  else if (hint.includes("spa") || hint.includes("sale") || hint.includes("booking")) documentTypeGuess = "spa";

  const prefersOcr = fileKind === "image";
  if (fileKind === "unknown") warnings.push("Unknown file type; extraction may be limited");

  return { fileKind, documentTypeGuess, prefersOcr, warnings };
}

export async function extractDocumentText(params: { bytes: Buffer; fileName: string }): Promise<RawExtraction> {
  const lower = String(params.fileName || "").toLowerCase();
  if (lower.endsWith(".txt")) {
    const text = params.bytes.toString("utf-8");
    return { extractedRawText: normalizeExtractedText(text), extractionMethod: "text", pageCount: 1, warnings: [], perPageText: [normalizeExtractedText(text)] };
  }
  if (lower.endsWith(".docx")) {
    const { text } = extractDocxText(params.bytes);
    return { extractedRawText: normalizeExtractedText(text), extractionMethod: "text", pageCount: 1, warnings: [], perPageText: [normalizeExtractedText(text)] };
  }
  if (lower.endsWith(".pdf")) {
    const out = await extractPdfText(params.bytes);
    return out;
  }
  if (/\.(png|jpg|jpeg|webp|gif)$/i.test(lower)) {
    const out = await ocrImage(params.bytes);
    return out;
  }
  return { extractedRawText: "", extractionMethod: "text", pageCount: 0, warnings: ["Unsupported file type for extraction"], perPageText: [] };
}

export function guessDocumentTypeFromText(rawText: string): DocumentTypeGuess {
  const t = rawText.toLowerCase();
  if (/(mykad|nric|no\.\s*k\/p|kad pengenalan|passport)/i.test(t)) return "ic_nric";
  if (/(letter of offer|loan offer|facility agreement|financing sum|end financier|maybank|cimb|rhb|public bank|hong leong)/i.test(t)) return "loan_offer";
  if (/(hakmilik|carian rasmi|mukim|bandar|pekan|no\.\s*hakmilik|geran)/i.test(t)) return "title_search";
  if (/(sale and purchase agreement|perjanjian jual beli|purchaser|vendor|developer|purchase price)/i.test(t)) return "spa";
  return "unknown";
}

export function mapExtractedTextToSuggestions(params: { raw: RawExtraction; documentTypeGuess: DocumentTypeGuess }): StructuredSuggestion[] {
  const guess = params.documentTypeGuess === "unknown" ? guessDocumentTypeFromText(params.raw.extractedRawText) : params.documentTypeGuess;
  const perPage = params.raw.perPageText.length ? params.raw.perPageText : [params.raw.extractedRawText];
  const all = perPage.join("\n\n");
  const suggestions: StructuredSuggestion[] = [];

  function push(fieldKey: string, value: string, confidence: number, page: number, snippet: string, target: StructuredSuggestion["targetEntityType"]) {
    const v = String(value || "").trim();
    if (!v) return;
    suggestions.push({
      fieldKey,
      suggestedValue: v,
      confidence: Math.max(0, Math.min(1, confidence)),
      sourcePage: page,
      sourceSnippet: snippet.trim().slice(0, 240),
      documentTypeGuess: guess,
      targetEntityType: target,
    });
  }

  const nric = findFirstMatch(all, /\b\d{6}-\d{2}-\d{4}\b/g);
  if (guess === "ic_nric") {
    if (nric) push("ic_passport_no", nric.value, 0.92, nric.page, nric.snippet, "client_primary_purchaser");
    const name = findNameNearKeywords(all, ["nama", "name"]);
    if (name) push("full_name", name, 0.72, 1, snippetAround(all, name), "client_primary_purchaser");
    const addr = findBlockAfterKeyword(all, ["alamat", "address"]);
    if (addr) push("address", addr, 0.62, 1, snippetAround(all, addr), "client_primary_purchaser");
    const dob = findFirstMatch(all, /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/g);
    if (dob) push("dob", dob.value, 0.55, dob.page, dob.snippet, "client_primary_purchaser");
  }

  if (guess === "loan_offer") {
    const bank = findBankName(all);
    if (bank) push("bank_name", bank, 0.75, 1, snippetAround(all, bank), "case_loan");
    const bankRef = findFirstMatch(all, /\b(?:ref(?:erence)?|rujukan)\s*[:#]?\s*([a-z0-9\/\-_]{5,})\b/i);
    if (bankRef) push("bank_ref_no", bankRef.groups?.[1] ?? bankRef.value, 0.7, bankRef.page, bankRef.snippet, "case_loan");
    const amt = findFirstMatch(all, /\bRM\s*[\d,]+(?:\.\d{1,2})?\b/i);
    if (amt) push("financing_amount", amt.value, 0.72, amt.page, amt.snippet, "case_loan");
    const pct = findFirstMatch(all, /\b(\d{1,3}(?:\.\d{1,2})?)\s*%\b/);
    if (pct) push("loan_percentage", pct.groups?.[1] ?? pct.value, 0.62, pct.page, pct.snippet, "case_loan");
    const date = findFirstMatch(all, /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/);
    if (date) push("lo_date", date.value, 0.55, date.page, date.snippet, "case_key_dates");
    const borrower = findNameNearKeywords(all, ["borrower", "pemohon", "customer"]);
    if (borrower) push("borrower_name", borrower, 0.55, 1, snippetAround(all, borrower), "case_loan");
  }

  if (guess === "title_search") {
    const lot = findFirstMatch(all, /\b(?:lot\s*no\.?|lot)\s*[:#]?\s*([a-z0-9\/\.\-]+)\b/i);
    if (lot) push("lot_no", lot.groups?.[1] ?? lot.value, 0.7, lot.page, lot.snippet, "case_property");
    const hak = findFirstMatch(all, /\b(?:hakmilik|no\.\s*hakmilik)\s*[:#]?\s*([a-z0-9\/\.\-]+)\b/i);
    if (hak) push("hakmilik_no", hak.groups?.[1] ?? hak.value, 0.72, hak.page, hak.snippet, "case_property");
    const mukim = findFirstMatch(all, /\bmukim\s*[:#]?\s*([a-z \-]{3,})\b/i);
    if (mukim) push("mukim", mukim.groups?.[1] ?? mukim.value, 0.6, mukim.page, mukim.snippet, "case_property");
    const bandar = findFirstMatch(all, /\b(?:bandar|pekan)\s*[:#]?\s*([a-z \-]{3,})\b/i);
    if (bandar) push("bandar_pekan", bandar.groups?.[1] ?? bandar.value, 0.55, bandar.page, bandar.snippet, "case_property");
  }

  if (guess === "spa") {
    const price = findFirstMatch(all, /\b(?:RM\s*[\d,]+(?:\.\d{1,2})?)\b/i);
    if (price) push("purchase_price", price.value, 0.55, price.page, price.snippet, "case");
    const date = findFirstMatch(all, /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/);
    if (date) push("spa_date", date.value, 0.45, date.page, date.snippet, "case_key_dates");
    const purchaser = findNameNearKeywords(all, ["purchaser", "pembeli"]);
    if (purchaser) push("purchaser_names", purchaser, 0.45, 1, snippetAround(all, purchaser), "case_spa");
    const unit = findFirstMatch(all, /\b(?:unit|unit no\.?|no\.\s*unit)\s*[:#]?\s*([a-z0-9\/\-_]+)\b/i);
    if (unit) push("unit_no", unit.groups?.[1] ?? unit.value, 0.5, unit.page, unit.snippet, "case_property");
    const parcel = findFirstMatch(all, /\b(?:parcel\s*no\.?|no\.\s*parcel|parcel)\s*[:#]?\s*([a-z0-9\/\-_]+)\b/i);
    if (parcel) push("parcel_no", parcel.groups?.[1] ?? parcel.value, 0.55, parcel.page, parcel.snippet, "case");
    const dev = findNameNearKeywords(all, ["developer", "vendor"]);
    if (dev) push("developer_name", dev, 0.35, 1, snippetAround(all, dev), "case");
    const proj = findNameNearKeywords(all, ["project"]);
    if (proj) push("project_name", proj, 0.3, 1, snippetAround(all, proj), "case");
  }

  return dedupeSuggestions(suggestions);
}

function dedupeSuggestions(list: StructuredSuggestion[]): StructuredSuggestion[] {
  const seen = new Set<string>();
  const out: StructuredSuggestion[] = [];
  for (const s of list) {
    const k = `${s.fieldKey}::${s.suggestedValue}::${s.sourcePage}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.sort((a, b) => (b.confidence - a.confidence));
}

function extractDocxText(docxBytes: Buffer): { text: string } {
  const zip = new PizZip(docxBytes);
  const docXml = zip.file("word/document.xml")?.asText() ?? "";
  const text = docXml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return { text };
}

async function extractPdfText(pdfBytes: Buffer): Promise<RawExtraction> {
  const warnings: string[] = [];
  try {
    const pdfjs: any = await import("pdfjs-dist");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBytes) });
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    const perPageText: string[] = [];
    const perPageMethod: Array<"text" | "ocr" | "none"> = [];
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const strings = (content.items as any[]).map((it) => (typeof it.str === "string" ? it.str : "")).filter(Boolean);
      const txt = normalizeExtractedText(strings.join(" "));
      perPageText.push(txt);
      perPageMethod.push(txt.length >= 20 ? "text" : "none");
    }
    const extractedRawText = normalizeExtractedText(perPageText.join("\n\n"));
    const scannedPdfDetected = isScannedPdfCandidate({ pageCount, perPageText, extractedRawText });
    if (!scannedPdfDetected) {
      return { extractedRawText, extractionMethod: "text", pageCount, warnings, perPageText, scannedPdfDetected, rasterizedPagesCount: 0, ocrWarnings: [], perPageExtractionMethod: perPageMethod };
    }

    const { imagesPng, rasterWarnings } = await rasterizePdfPagesForOcr(pdfBytes, { maxPages: Number(process.env.EXTRACTION_OCR_MAX_PAGES ?? 5) });
    const ocrWarnings: string[] = [...rasterWarnings];
    const ocrTexts: string[] = [];
    const ocrPerPageMethod: Array<"text" | "ocr" | "none"> = [];
    for (let i = 0; i < imagesPng.length; i += 1) {
      const o = await ocrImage(imagesPng[i]);
      ocrWarnings.push(...o.warnings);
      ocrTexts.push(o.perPageText[0] ?? "");
      ocrPerPageMethod.push((o.perPageText[0] ?? "").trim().length ? "ocr" : "none");
    }
    const merged = normalizeExtractedText([extractedRawText, ocrTexts.join("\n\n")].filter(Boolean).join("\n\n"));
    const method: ExtractionMethod = extractedRawText.trim().length ? "hybrid" : "ocr";
    return {
      extractedRawText: merged,
      extractionMethod: method,
      pageCount,
      warnings: [...warnings, "Scanned PDF detected; OCR fallback executed"],
      perPageText: ocrTexts.length ? ocrTexts : perPageText,
      scannedPdfDetected,
      rasterizedPagesCount: imagesPng.length,
      ocrWarnings,
      perPageExtractionMethod: ocrTexts.length ? ocrPerPageMethod : perPageMethod,
    };
  } catch (err) {
    warnings.push("PDF text extraction failed");
    warnings.push(err instanceof Error ? err.message : "unknown error");
    return { extractedRawText: "", extractionMethod: "text", pageCount: 0, warnings, perPageText: [], scannedPdfDetected: false, rasterizedPagesCount: 0, ocrWarnings: [], perPageExtractionMethod: [] };
  }
}

function isScannedPdfCandidate(params: { pageCount: number; perPageText: string[]; extractedRawText: string }): boolean {
  const total = params.extractedRawText.trim().length;
  if (params.pageCount <= 0) return false;
  const avg = total / Math.max(1, params.pageCount);
  const shortPages = params.perPageText.filter((t) => t.trim().length < 20).length;
  if (total < 80) return true;
  if (avg < 40 && shortPages / params.pageCount >= 0.6) return true;
  return false;
}

async function rasterizePdfPagesForOcr(pdfBytes: Buffer, opts: { maxPages: number }): Promise<{ imagesPng: Buffer[]; rasterWarnings: string[] }> {
  const rasterWarnings: string[] = [];
  try {
    const pdfjs: any = await import("pdfjs-dist");
    const { createCanvas } = await import("@napi-rs/canvas");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBytes) });
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    const limit = Math.max(1, Math.min(pageCount, Number.isFinite(opts.maxPages) ? opts.maxPages : 5));
    const imagesPng: Buffer[] = [];
    for (let i = 1; i <= limit; i += 1) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d") as any;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const png = canvas.toBuffer("image/png");
      imagesPng.push(png);
    }
    if (pageCount > limit) rasterWarnings.push(`OCR limited to first ${limit} pages (of ${pageCount})`);
    return { imagesPng, rasterWarnings };
  } catch (err) {
    rasterWarnings.push("PDF rasterization failed");
    rasterWarnings.push(err instanceof Error ? err.message : "unknown error");
    return { imagesPng: [], rasterWarnings };
  }
}

async function ocrImage(imageBytes: Buffer): Promise<RawExtraction> {
  const warnings: string[] = [];
  try {
    const t: any = await import("tesseract.js");
    const worker = await t.createWorker();
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    const { data } = await worker.recognize(imageBytes);
    await worker.terminate();
    const text = normalizeExtractedText(String(data?.text ?? ""));
    return { extractedRawText: text, extractionMethod: "ocr", pageCount: 1, warnings, perPageText: [text] };
  } catch (err) {
    warnings.push("OCR failed");
    warnings.push(err instanceof Error ? err.message : "unknown error");
    return { extractedRawText: "", extractionMethod: "ocr", pageCount: 1, warnings, perPageText: [""] };
  }
}

function normalizeExtractedText(s: string): string {
  return String(s || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function snippetAround(text: string, needle: string, radius = 80): string {
  const t = String(text || "");
  const n = String(needle || "");
  const idx = t.toLowerCase().indexOf(n.toLowerCase());
  if (idx < 0) return t.slice(0, 160);
  const start = Math.max(0, idx - radius);
  const end = Math.min(t.length, idx + n.length + radius);
  return t.slice(start, end);
}

function findFirstMatch(text: string, re: RegExp): { value: string; page: number; snippet: string; groups?: Record<string, string> } | null {
  const pages = text.split("\n\n");
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    const m = p.match(re);
    if (!m) continue;
    const value = Array.isArray(m) ? String(m[0]) : String(m);
    const snippet = snippetAround(p, value);
    const groups: Record<string, string> = {};
    const exec = re.exec(p);
    if (exec && exec.groups) Object.assign(groups, exec.groups);
    else if (exec && exec.length > 1) groups["1"] = String(exec[1]);
    return { value, page: i + 1, snippet, groups };
  }
  return null;
}

function findNameNearKeywords(text: string, keywords: string[]): string | null {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!keywords.some((k) => lower.includes(k))) continue;
    const parts = line.split(/[:\-]/).map((p) => p.trim()).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : "";
    if (last && last.length >= 3 && /[a-z]/i.test(last)) return last;
  }
  return null;
}

function findBlockAfterKeyword(text: string, keywords: string[]): string | null {
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i += 1) {
    const lower = String(lines[i]).toLowerCase();
    if (!keywords.some((k) => lower.includes(k))) continue;
    const buf: string[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
      const v = String(lines[j]).trim();
      if (!v) break;
      if (v.length < 2) break;
      buf.push(v);
    }
    const out = buf.join(", ").replace(/\s+/g, " ").trim();
    if (out.length >= 6) return out;
  }
  return null;
}

function findBankName(text: string): string | null {
  const t = text.toLowerCase();
  const banks = ["maybank", "cimb", "rhb", "public bank", "hong leong", "ambank", "bank islam"];
  const hit = banks.find((b) => t.includes(b));
  return hit ? hit.toUpperCase() : null;
}
