import { describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createServer } from "node:http";
import { renderDocxTemplate } from "../services/document-generation/docx-template-renderer";
import { convertDocxToPdf } from "../services/document-generation/docx-to-pdf";
import { joinNamesWithAmpersand, formatLegalDate } from "../lib/documentVariables";

function makeDocxTemplateWithHeaderFooter(args: {
  bodyXml: string;
  headerXml: string;
  footerXml: string;
  includeHeaderFooterRefs?: boolean;
}): Buffer {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`,
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word")?.file("document.xml", args.bodyXml);
  zip.folder("word")?.file("header1.xml", args.headerXml);
  zip.folder("word")?.file("footer1.xml", args.footerXml);
  zip.folder("word")?.folder("_rels")?.file(
    "document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`,
  );
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

describe("DOCX template pipeline (unit)", () => {
  it("renders tokens in body/table/header/footer, formats parties inline, and replaces empty with —", () => {
    const bodyXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>{{case_reference}} / {{purchasers_inline}} / {{letter_of_offer_date}} / {{property_full_description}}</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>{{purchaser_name}}</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>{{purchaser_ic}}</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>{{#purchasers}}{{name}} {{/purchasers}}</w:t></w:r></w:p>
    <w:p><w:r><w:t>{{#custom_loop}}X{{/custom_loop}}</w:t></w:r></w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId1"/>
      <w:footerReference w:type="default" r:id="rId2"/>
    </w:sectPr>
  </w:body>
</w:document>`;
    const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p><w:r><w:t>{{firm_name}}</w:t></w:r></w:p>
</w:hdr>`;
    const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p><w:r><w:t>{{date_today}}</w:t></w:r></w:p>
</w:ftr>`;
    const templateBytes = makeDocxTemplateWithHeaderFooter({ bodyXml, headerXml, footerXml });

    const purchasers = ["LIMKL", "LIMKL 1", "LIMKL 2", "LIMKL 3"];
    const today = formatLegalDate("2026-12-05");
    const { docxBytes, warnings } = renderDocxTemplate({
      templateBytes,
      placeholders: [
        "case_reference",
        "purchasers_inline",
        "letter_of_offer_date",
        "property_full_description",
        "purchaser_name",
        "purchaser_ic",
        "#purchasers",
        "/purchasers",
        "#custom_loop",
        "/custom_loop",
        "firm_name",
        "date_today",
      ],
      data: {
        case_reference: "CON-001",
        purchasers_inline: joinNamesWithAmpersand(purchasers),
        letter_of_offer_date: today,
        property_full_description: null,
        purchaser_name: "LIMKL",
        purchaser_ic: "",
        purchasers: purchasers.map((name) => ({ name })),
        firm_name: "Tan & Associates",
        date_today: today,
      },
    });

    expect(warnings.some((w) => w.code === "UNSUPPORTED_LOOP" && w.key === "custom_loop")).toBe(true);

    const zip = new PizZip(docxBytes);
    const documentXml = zip.file("word/document.xml")?.asText() ?? "";
    const headerXmlOut = zip.file("word/header1.xml")?.asText() ?? "";
    const footerXmlOut = zip.file("word/footer1.xml")?.asText() ?? "";

    expect(documentXml).toContain("CON-001");
    expect(documentXml).toContain("05.12.2026");
    expect(documentXml).toContain("LIMKL, LIMKL 1, LIMKL 2 & LIMKL 3");
    expect(documentXml).toContain("—");
    expect(headerXmlOut).toContain("Tan &amp; Associates");
    expect(footerXmlOut).toContain("05.12.2026");

    expect(documentXml).not.toContain("undefined");
    expect(documentXml).not.toContain("null");
    expect(documentXml).not.toContain("[MISSING");
    expect(documentXml).not.toContain("{{");
  });

  it("http_service engine converts via POST and returns a valid non-empty PDF", async () => {
    const token = "test-token";
    const pdfBytes = Buffer.from(await (async () => {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (let i = 0; i < 5; i++) {
        const page = pdf.addPage([595.28, 841.89]);
        page.drawText(`Hello ${"X".repeat(800)}`, { x: 40, y: 800, size: 10, font });
      }
      return await pdf.save();
    })());
    expect(pdfBytes.length).toBeGreaterThan(2500);

    const server = createServer((req, res) => {
      if (req.url !== "/convert" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const auth = String(req.headers.authorization ?? "");
      if (auth !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (body.length === 0) {
          res.statusCode = 400;
          res.end("empty");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/pdf");
        res.end(pdfBytes);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    process.env.DOCX_TO_PDF_ENGINE = "http_service";
    process.env.DOCX_PDF_SERVICE_URL = `http://127.0.0.1:${port}/convert`;
    process.env.DOCX_PDF_SERVICE_TOKEN = token;
    process.env.DOCX_TO_PDF_TIMEOUT_MS = "5000";

    try {
      const out = await convertDocxToPdf(Buffer.from("dummy-docx-bytes"));
      expect(out.length).toBeGreaterThan(2500);
      const parsed = await PDFDocument.load(out);
      expect(parsed.getPageCount()).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

