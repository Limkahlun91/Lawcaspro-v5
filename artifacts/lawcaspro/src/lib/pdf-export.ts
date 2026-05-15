import html2pdf from "html2pdf.js";

type Html2PdfInstance = {
  set: (opt: Record<string, unknown>) => Html2PdfInstance;
  from: (el: HTMLElement) => Html2PdfInstance;
  save: () => Promise<void>;
};

type Html2PdfFactory = () => Html2PdfInstance;

export type PdfExportOptions = {
  element: HTMLElement;
  filename: string;
  marginMm?: number;
};

export async function exportElementToPdf({ element, filename, marginMm = 12 }: PdfExportOptions): Promise<void> {
  const root = document.documentElement;
  root.classList.add("pdf-export");
  try {
    const factory = html2pdf as unknown as Html2PdfFactory;
    await factory()
      .set({
        margin: marginMm,
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
        },
        jsPDF: {
          unit: "mm",
          format: "a4",
          orientation: "portrait",
        },
      })
      .from(element)
      .save();
  } finally {
    root.classList.remove("pdf-export");
  }
}
