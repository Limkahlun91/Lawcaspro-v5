import PizZip from "pizzip";

export function docxHasPlaceholder(docxBytes: Buffer, placeholderKey: string): boolean {
  const zip = new PizZip(docxBytes);
  const docXml = zip.file("word/document.xml")?.asText() ?? "";
  const re = new RegExp(`\\{\\{\\s*${escapeRegExp(placeholderKey)}\\s*\\}\\}`, "g");
  return re.test(docXml);
}

export function detectClausePlaceholders(docxBytes: Buffer, clauseCodes: string[]): {
  hasClausesPlaceholder: boolean;
  foundClauseCodes: string[];
} {
  const zip = new PizZip(docxBytes);
  const docXml = zip.file("word/document.xml")?.asText() ?? "";
  const hasClausesPlaceholder = /\{\{\s*clauses\s*\}\}/g.test(docXml);
  const foundClauseCodes: string[] = [];
  for (const code of clauseCodes) {
    const key = `clause_${code}`;
    const re = new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, "g");
    if (re.test(docXml)) foundClauseCodes.push(code);
  }
  return { hasClausesPlaceholder, foundClauseCodes };
}

export function ensureDocxHasPlaceholderAtEnd(docxBytes: Buffer, placeholderKey: string): Buffer {
  const zip = new PizZip(docxBytes);
  const docFile = zip.file("word/document.xml");
  const xml = docFile?.asText() ?? "";
  const re = new RegExp(`\\{\\{\\s*${escapeRegExp(placeholderKey)}\\s*\\}\\}`, "g");
  if (re.test(xml)) return docxBytes;

  const insertion = `<w:p><w:r><w:t>{{${placeholderKey}}}</w:t></w:r></w:p>`;
  const idx = xml.lastIndexOf("</w:body>");
  const next = idx !== -1 ? `${xml.slice(0, idx)}${insertion}${xml.slice(idx)}` : xml;
  zip.file("word/document.xml", next);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
