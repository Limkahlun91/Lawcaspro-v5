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
  const attr = "data-pdf-export-root";
  const prevAttr = element.getAttribute(attr);
  try {
    element.setAttribute(attr, "1");

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
          onclone: (doc: Document) => {
            const style = doc.createElement("style");
            style.textContent = [
              "html,body{background:#ffffff !important;color:#1E293B !important;}",
              `[${attr}="1"],[${attr}="1"] *{color:#1E293B !important;background-color:#ffffff !important;border-color:#E2E8F0 !important;box-shadow:none !important;text-shadow:none !important;}`,
              `[${attr}="1"] .bg-primary,[${attr}="1"] th{background-color:#1B365D !important;color:#FFFFFF !important;}`,
              `[${attr}="1"] .text-destructive{color:#B91C1C !important;}`,
              `[${attr}="1"] .text-primary{color:#1B365D !important;}`,
            ].join("\n");

            const rootEl = doc.querySelector(`[${attr}="1"]`) as HTMLElement | null;
            if (!rootEl) return;
            rootEl.prepend(style);

            const walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
            let node: Node | null = rootEl;
            while (node) {
              const el = node as HTMLElement;
              const raw = el.getAttribute("style");
              if (raw && raw.toLowerCase().includes("oklch")) el.removeAttribute("style");
              node = walker.nextNode();
            }
          },
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
    if (prevAttr === null) element.removeAttribute(attr);
    else element.setAttribute(attr, prevAttr);
    root.classList.remove("pdf-export");
  }
}
