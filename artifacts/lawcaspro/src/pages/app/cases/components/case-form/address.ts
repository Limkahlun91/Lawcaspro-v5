import type { AddressLines } from "./types";

export function joinAddressLines(lines: AddressLines): string {
  return [lines.line1, lines.line2, lines.line3, lines.line4, lines.line5]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

export function emptyAddressLines(): AddressLines {
  return { line1: "", line2: "", line3: "", line4: "", line5: "" };
}

