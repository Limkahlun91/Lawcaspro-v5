import type { AddressLines } from "./types";
import { getStateFromPostcode } from "@/utils/my-address-helper";

export function joinAddressLines(lines: AddressLines): string {
  return [lines.line1, lines.line2, lines.line3, lines.line4, lines.line5]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

export function normalizeMalaysiaPostcodeInput(v: string): string {
  return String(v ?? "").replace(/[^0-9]/g, "").slice(0, 5);
}

export function composeMalaysiaAddress(args: {
  lines: AddressLines;
  postcode: string;
  city: string;
  state: string;
}): { address: string; derivedState: string | null } {
  const lines = [args.lines.line1, args.lines.line2, args.lines.line3, args.lines.line4, args.lines.line5]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);

  const postcode = normalizeMalaysiaPostcodeInput(args.postcode);
  const derivedState = postcode.length === 5 ? getStateFromPostcode(postcode) : null;
  const state = String(args.state ?? "").trim();
  const city = String(args.city ?? "").trim();

  if (postcode.length !== 5 || !derivedState) {
    return { address: [...lines, city, state].filter(Boolean).join(", "), derivedState };
  }

  if (derivedState === "Kuala Lumpur") {
    const tail = [city, `${postcode} ${derivedState}`].filter(Boolean).join(", ");
    return { address: [...lines, tail].filter(Boolean).join(", "), derivedState };
  }

  const tail = [`${postcode}${city ? ` ${city}` : ""}`, derivedState].filter(Boolean).join(", ");
  return { address: [...lines, tail].filter(Boolean).join(", "), derivedState };
}

export function emptyAddressLines(): AddressLines {
  return { line1: "", line2: "", line3: "", line4: "", line5: "" };
}

