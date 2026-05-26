function normalizePostcode(postcode: string): string {
  const digits = String(postcode ?? "").replace(/[^0-9]/g, "");
  return digits.length === 5 ? digits : "";
}

function parsePostcodeNumber(postcode: string): number | null {
  const p = normalizePostcode(postcode);
  if (!p) return null;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

function isInRange(n: number, from: number, to: number): boolean {
  return n >= from && n <= to;
}

export function getStateFromPostcode(postcode: string): string | null {
  const n = parsePostcodeNumber(postcode);
  if (n === null) return null;

  if (isInRange(n, 50000, 60999)) return "Kuala Lumpur";
  if (isInRange(n, 40000, 48999) || isInRange(n, 62000, 64999)) return "Selangor";
  if (isInRange(n, 80000, 86999)) return "Johor";
  if (isInRange(n, 10000, 11999) || isInRange(n, 13000, 14999)) return "Penang";
  if (isInRange(n, 30000, 36999)) return "Perak";
  if (isInRange(n, 25000, 29999) || isInRange(n, 69000, 69999)) return "Pahang";
  if (isInRange(n, 15000, 18999)) return "Kelantan";
  if (isInRange(n, 20000, 24999)) return "Terengganu";
  if (isInRange(n, 5000, 9999)) return "Kedah";
  if (isInRange(n, 1000, 2999)) return "Perlis";
  if (isInRange(n, 70000, 72999)) return "Negeri Sembilan";
  if (isInRange(n, 75000, 78999)) return "Melaka";
  if (isInRange(n, 88000, 91999)) return "Sabah";
  if (isInRange(n, 93000, 98999)) return "Sarawak";

  if (isInRange(n, 39000, 39999)) return null;
  if (isInRange(n, 73000, 73999)) return null;

  return null;
}

