import React from "react";

type Props = {
  pageSize?: "A4";
  orientation?: "portrait" | "landscape";
  marginMm?: number;
};

export function DocumentPrintStyles({ pageSize = "A4", orientation = "portrait", marginMm = 12 }: Props) {
  const margin = `${marginMm}mm`;
  return (
    <style>{`
.print-doc { background: #fff; }
.print-doc table { border-collapse: collapse; }
.print-doc th, .print-doc td { border-color: #000 !important; }

html.pdf-export, html.pdf-export body { background: #fff !important; }
html.pdf-export .pdf-hide { display: none !important; }
html.pdf-export .pdf-show { display: block !important; }
html.pdf-export .print-doc { color: #000; }

@media print {
  @page { size: ${pageSize} ${orientation}; margin: ${margin}; }
  html, body { background: #fff !important; }
  .print-doc { color: #000; }
  .print-doc table { border-collapse: collapse; }
  .print-doc th, .print-doc td { border-color: #000 !important; }
}
    `}</style>
  );
}
