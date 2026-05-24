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
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "Zero";
  if (n < 0) return `Minus ${integerToWords(Math.abs(n))}`;

  const units = [
    { value: 1_000_000_000_000, label: "Trillion" },
    { value: 1_000_000_000, label: "Billion" },
    { value: 1_000_000, label: "Million" },
    { value: 1_000, label: "Thousand" },
  ];

  let remaining = Math.floor(n);
  const parts: string[] = [];
  for (const u of units) {
    if (remaining >= u.value) {
      const q = Math.floor(remaining / u.value);
      remaining = remaining % u.value;
      parts.push(`${integerToWords(q)} ${u.label}`);
    }
  }
  if (remaining > 0) parts.push(chunkWords(remaining));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function toRinggitMalaysiaWords(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const rounded = Math.round(amount * 100);
  const ringgit = Math.floor(rounded / 100);
  const sen = rounded % 100;

  const ringgitWords = integerToWords(ringgit);
  const senWords = sen ? integerToWords(sen) : "Zero";
  return `Ringgit Malaysia ${ringgitWords} And ${senWords} Sen Only`;
}

