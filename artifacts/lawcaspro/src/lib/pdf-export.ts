export type PdfExportOptions = {
  element: HTMLElement;
  filename: string;
  marginMm?: number;
};

export async function exportElementToPdf({ element, filename, marginMm = 12 }: PdfExportOptions): Promise<void> {
  void marginMm;

  const body = document.body;
  const prevBodyClass = body.className;
  const prevTitle = document.title;
  const prevId = element.id;
  const printableId = "report-printable-area";
  const baseTitle = (filename || prevTitle).replace(/\.pdf$/i, "");

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    body.className = prevBodyClass;
    document.title = prevTitle;
    if (!prevId) element.removeAttribute("id");
    else element.id = prevId;
  };

  return await new Promise<void>((resolve) => {
    const onAfterPrint = () => {
      cleanup();
      resolve();
    };
    window.addEventListener("afterprint", onAfterPrint, { once: true });

    body.classList.add("print-report");
    document.title = baseTitle;
    element.id = printableId;

    requestAnimationFrame(() => {
      try {
        window.print();
      } finally {
        window.setTimeout(() => {
          if (!done) onAfterPrint();
        }, 15_000);
      }
    });
  });
}
