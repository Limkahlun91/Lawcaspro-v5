function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseNumericString(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) return 0;

  const negative = trimmed.startsWith("-") || (trimmed.startsWith("(") && trimmed.endsWith(")"));
  const match = trimmed.match(/\d+(?:,\d{3})*(?:\.\d+)?/);
  if (!match) return 0;

  const normalized = match[0].replace(/,/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;

  return negative ? -roundMoney(parsed) : roundMoney(parsed);
}

function chunkWords(n: number): string {
  const ones = [
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
  ] as const;
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"] as const;

  if (n < 20) return ones[n] ?? "";
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r ? `${tens[t]} ${ones[r]}` : `${tens[t]}`;
  }

  const h = Math.floor(n / 100);
  const r = n % 100;
  return r ? `${ones[h]} Hundred ${chunkWords(r)}` : `${ones[h]} Hundred`;
}

function integerToWords(n: number): string {
  if (!Number.isFinite(n)) return "Zero";
  if (n === 0) return "Zero";

  const units = [
    { value: 1_000_000_000_000, label: "Trillion" },
    { value: 1_000_000_000, label: "Billion" },
    { value: 1_000_000, label: "Million" },
    { value: 1_000, label: "Thousand" },
  ];

  let remaining = Math.floor(n);
  const parts: string[] = [];
  for (const unit of units) {
    if (remaining >= unit.value) {
      const quotient = Math.floor(remaining / unit.value);
      remaining %= unit.value;
      parts.push(`${integerToWords(quotient)} ${unit.label}`);
    }
  }

  if (remaining > 0) parts.push(chunkWords(remaining));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function toMoneyNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundMoney(value) : 0;
  }

  if (typeof value === "string") {
    return parseNumericString(value.replace(/\bRM\b/gi, "").replace(/\s+/g, " "));
  }

  if (value === null || value === undefined) return 0;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundMoney(parsed) : 0;
}

export function formatRMAmount(value: unknown): string {
  const amount = toMoneyNumber(value);
  const absolute = Math.abs(amount);
  const formatted = new Intl.NumberFormat("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(absolute);

  return `${amount < 0 ? "-" : ""}RM${formatted}`;
}

export function amountToEnglishWords(value: unknown): string {
  const amount = toMoneyNumber(value);
  const absolute = Math.abs(amount);
  const rounded = Math.round(absolute * 100);
  const ringgit = Math.floor(rounded / 100);
  const sen = rounded % 100;
  const prefix = amount < 0 ? "Negative " : "";

  if (sen === 0) {
    return `${prefix}Ringgit Malaysia ${integerToWords(ringgit)}`;
  }
  return `${prefix}Ringgit Malaysia ${integerToWords(ringgit)} and Sen ${integerToWords(sen)}`;
}
