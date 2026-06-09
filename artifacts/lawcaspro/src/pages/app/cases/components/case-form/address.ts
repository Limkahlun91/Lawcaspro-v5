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

export function normalizeAddressText(v: string): string {
  const raw = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  return raw.replace(/[A-Za-z]+/g, (match, offset) => {
    const prev = raw[offset - 1] ?? "";
    const next = raw[offset + match.length] ?? "";
    const lower = match.toLowerCase();
    if (/\d/.test(prev) && (lower === "st" || lower === "nd" || lower === "rd" || lower === "th") && (!next || /[^A-Za-z]/.test(next))) {
      return lower;
    }
    if (/\d/.test(prev) && match.length === 1) return match.toUpperCase();
    return match[0].toUpperCase() + match.slice(1).toLowerCase();
  });
}

export function splitAddressToLines(address: string): AddressLines {
  const parts = String(address ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    line1: parts[0] ?? "",
    line2: parts[1] ?? "",
    line3: parts[2] ?? "",
    line4: parts[3] ?? "",
    line5: parts[4] ?? "",
  };
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

