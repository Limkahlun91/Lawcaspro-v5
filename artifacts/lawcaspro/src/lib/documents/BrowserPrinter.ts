import { renderAsync } from "docx-preview";

export type BrowserPrinterOptions = {
  title?: string;
  pageMarginMm?: number;
  timeoutMs?: number;
};

function buildSrcDoc(opts: Required<Pick<BrowserPrinterOptions, "pageMarginMm">>): string {
  const margin = Math.max(0, Number.isFinite(opts.pageMarginMm) ? opts.pageMarginMm : 12);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; background: #fff; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      #docx-root { padding: 0; }
      @page { size: A4; margin: ${margin}mm; }
      @media print {
        html, body { background: #fff; }
      }
    </style>
  </head>
  <body>
    <div id="docx-root"></div>
  </body>
</html>`;
}

function waitForIframeLoad(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const onLoad = () => resolve();
    const onError = () => reject(new Error("Failed to load print frame"));
    iframe.addEventListener("load", onLoad, { once: true });
    iframe.addEventListener("error", onError, { once: true });
  });
}

function safeCleanup(iframe: HTMLIFrameElement): void {
  try { iframe.remove(); } catch {}
}

export async function printWordBlob(wordBlob: Blob, options?: BrowserPrinterOptions): Promise<void> {
  const pageMarginMm = typeof options?.pageMarginMm === "number" ? options.pageMarginMm : 12;
  const timeoutMs = typeof options?.timeoutMs === "number" ? options.timeoutMs : 120_000;
  const title = typeof options?.title === "string" ? options.title.trim() : "";

  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.visibility = "hidden";
  iframe.srcdoc = buildSrcDoc({ pageMarginMm });
  document.body.appendChild(iframe);

  try {
    await waitForIframeLoad(iframe);
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc) throw new Error("Print frame is unavailable");
    if (title) doc.title = title;

    const root = doc.getElementById("docx-root");
    if (!root) throw new Error("Print container missing");

    const ab = await wordBlob.arrayBuffer();
    await renderAsync(ab, root, doc.head);

    const done = new Promise<void>((resolve) => {
      const onAfterPrint = () => resolve();
      try { win.addEventListener("afterprint", onAfterPrint, { once: true }); } catch { resolve(); }
      setTimeout(resolve, Math.max(1000, timeoutMs));
    });

    try { win.focus(); } catch {}
    try { win.print(); } catch {}
    await done;
  } finally {
    safeCleanup(iframe);
  }
}

