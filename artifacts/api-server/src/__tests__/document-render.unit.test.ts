import { describe, expect, it } from "vitest";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { convertDocxToPdfWithFallback, renderPdfMappedTemplate, renderPdfTextBoxMappedTemplate } from "../routes/documents";

function makeMinimalDocxTemplateXml(bodyText: string): Buffer {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.folder("word")?.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>${bodyText}</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`
  );
  zip.folder("word")?.folder("_rels")?.file(
    "document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  );
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

describe("document generation render (unit)", () => {
  it("docx -> pdf (fallback) does not run when conversion engine is not configured", async () => {
    process.env.DOCX_TO_PDF_ENGINE = "disabled";
    delete process.env.GOTENBERG_URL;
    delete process.env.DOCX_CONVERTER_URL;
    delete process.env.DOCX_PDF_SERVICE_URL;
    const templateBytes = makeMinimalDocxTemplateXml("Hello {{name}}");
    const zip = new PizZip(templateBytes);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, delimiters: { start: "{{", end: "}}" } });
    doc.render({ name: "Alice" });
    const renderedDocx = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;

    await expect(convertDocxToPdfWithFallback(renderedDocx, { allowFallbackOnFailure: true })).rejects.toMatchObject({
      code: "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
    });
  });

  it("pdf legacy mapping draws values / placeholders", async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    page.drawText("Base", { x: 50, y: 800, size: 12, font });
    const baseBytes = Buffer.from(await pdfDoc.save());

    const rendered = await renderPdfMappedTemplate({
      pdfBytes: baseBytes,
      data: { name: "Alice" },
      mappingConfig: { name: { page: 1, x: 50, y: 760, size: 12 } },
      missingMode: "placeholder",
    });
    expect(rendered.length).toBeGreaterThan(baseBytes.length);
    expect(rendered.toString("latin1")).toContain("Alice");

    const renderedMissing = await renderPdfMappedTemplate({
      pdfBytes: baseBytes,
      data: {},
      mappingConfig: { name: { page: 1, x: 50, y: 740, size: 12 } },
      missingMode: "placeholder",
    });
    expect(renderedMissing.toString("latin1")).toContain("[MISSING: name]");

    const renderedEmpty = await renderPdfMappedTemplate({
      pdfBytes: baseBytes,
      data: {},
      mappingConfig: { name: { page: 1, x: 50, y: 720, size: 12 } },
      missingMode: "empty",
    });
    expect(renderedEmpty.toString("latin1")).not.toContain("[MISSING:");
  });

  it("pdf textBox mapping draws interpolated content", async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595.28, 841.89]);
    const baseBytes = Buffer.from(await pdfDoc.save());
    const rendered = await renderPdfTextBoxMappedTemplate({
      pdfBytes: baseBytes,
      data: { name: "Alice" },
      mappings: {
        pages: [
          {
            pageIndex: 0,
            textBoxes: [
              {
                id: "tb1",
                x: 50,
                y: 50,
                width: 400,
                height: 80,
                fontSize: 14,
                content: "Hello {{name}}",
                alignment: "left",
                fontFamily: "Helvetica",
              },
            ],
          },
        ],
      },
      missingMode: "placeholder",
    });
    expect(rendered.toString("latin1")).toContain("Hello");
    expect(rendered.toString("latin1")).toContain("Alice");
  });
});
