import { amountToEnglishWords, toMoneyNumber } from "@/lib/money";

const MONEY_AMOUNT_PATTERN = /(?:RM\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/gi;

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseMoneyAmountsFromText(input: string): number[] {
  if (!input || typeof input !== "string") return [];

  const normalized = input
    .replace(/\bRinggit Malaysia\b/gi, " ")
    .replace(/\bRM\b/gi, " RM ")
    .replace(/\s+/g, " ")
    .trim();

  const matches = normalized.match(MONEY_AMOUNT_PATTERN);
  if (!matches) return [];

  return matches
    .map((raw) => {
      const cleaned = raw
        .replace(/RM/gi, "")
        .replace(/,/g, "")
        .trim();

      const value = Number(cleaned);
      return Number.isFinite(value) ? roundMoney(value) : null;
    })
    .filter((value): value is number => value !== null && value > 0);
}

export type LoanAmountsCalculationParams = {
  financingSum: string | number | null | undefined;
  others: string | null | undefined;
};

export type LoanAmountsCalculationResult = {
  financingSum: number;
  detectedAmounts: number[];
  othersTotal: number;
  totalLoan: number;
  totalLoanWords: string;
};

export function calculateLoanAmounts(params: LoanAmountsCalculationParams): LoanAmountsCalculationResult {
  const financingSum = toMoneyNumber(params.financingSum);
  const detectedAmounts = parseMoneyAmountsFromText(params.others ?? "");
  const othersTotal = roundMoney(detectedAmounts.reduce((sum, amount) => sum + amount, 0));
  const totalLoan = roundMoney(financingSum + othersTotal);

  return {
    financingSum,
    detectedAmounts,
    othersTotal,
    totalLoan,
    totalLoanWords: amountToEnglishWords(totalLoan),
  };
}
