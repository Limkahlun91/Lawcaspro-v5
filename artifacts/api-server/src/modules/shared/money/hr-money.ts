import Decimal from "decimal.js";
import { createHRError, HR_ERROR_CODES } from "../errors/hr-error-codes.js";

export type HRDecimalInput = string | number | bigint | null | undefined;

export const HR_MONEY_RULE_VERSION = "MONEY_V1_DECIMALJS";
export const HR_DB_SCALE = 4;
export const HR_DISPLAY_SCALE = 2;

Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  minE: -9e14,
  maxE: 9e14,
  toExpNeg: -9e14,
  toExpPos: 9e14,
});

export type HRRoundingMode =
  | typeof Decimal.ROUND_HALF_UP
  | typeof Decimal.ROUND_DOWN
  | typeof Decimal.ROUND_UP
  | typeof Decimal.ROUND_FLOOR
  | typeof Decimal.ROUND_CEIL
  | typeof Decimal.ROUND_HALF_DOWN
  | typeof Decimal.ROUND_HALF_EVEN;

export const HR_ROUNDING_MODE_HALF_UP: HRRoundingMode = Decimal.ROUND_HALF_UP;
export const HR_ROUNDING_MODE_TRUNCATE: HRRoundingMode = Decimal.ROUND_DOWN;

export interface HRCalculationResult {
  rawAmount: string;
  roundedAmount: string;
  roundingRule: "ROUND_HALF_UP_2DP" | "ROUND_HALF_UP_4DP" | "TRUNCATE_4DP";
  roundingMode: HRRoundingMode;
  ruleVersion: string;
  calculationSource: string;
}

function toDecimal(v: HRDecimalInput, field = "amount"): Decimal {
  if (v === null || v === undefined || v === "") {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, `${field} is required for decimal operation`);
  }
  let str: string;
  if (typeof v === "bigint") str = v.toString();
  else if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, `Invalid ${field}: non-finite number`);
    }
    str = String(v);
  } else {
    str = String(v).replace(/,/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(str)) {
      throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, `Invalid ${field}: ${v}`);
    }
  }
  try {
    return new Decimal(str);
  } catch {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, `Invalid ${field}: ${v}`);
  }
}

function formatResult(
  raw: Decimal,
  roundingRule: HRCalculationResult["roundingRule"],
  calculationSource: string,
): HRCalculationResult {
  const rawAmount = raw.toFixed(HR_DB_SCALE, HR_ROUNDING_MODE_HALF_UP);
  let rawRoundedForDisplay: Decimal;
  let roundingMode: HRRoundingMode = HR_ROUNDING_MODE_HALF_UP;
  switch (roundingRule) {
    case "ROUND_HALF_UP_2DP":
      rawRoundedForDisplay = new Decimal(
        raw.toFixed(HR_DISPLAY_SCALE, HR_ROUNDING_MODE_HALF_UP),
      );
      roundingMode = HR_ROUNDING_MODE_HALF_UP;
      break;
    case "ROUND_HALF_UP_4DP":
      rawRoundedForDisplay = new Decimal(
        raw.toFixed(HR_DB_SCALE, HR_ROUNDING_MODE_HALF_UP),
      );
      roundingMode = HR_ROUNDING_MODE_HALF_UP;
      break;
    case "TRUNCATE_4DP":
      rawRoundedForDisplay = new Decimal(
        raw.toFixed(HR_DB_SCALE, HR_ROUNDING_MODE_TRUNCATE),
      );
      roundingMode = HR_ROUNDING_MODE_TRUNCATE;
      break;
    default:
      rawRoundedForDisplay = new Decimal(
        raw.toFixed(HR_DISPLAY_SCALE, HR_ROUNDING_MODE_HALF_UP),
      );
  }
  const roundedAmount = rawRoundedForDisplay.toFixed(
    HR_DISPLAY_SCALE,
    HR_ROUNDING_MODE_HALF_UP,
  );
  return {
    rawAmount,
    roundedAmount,
    roundingRule,
    roundingMode,
    ruleVersion: HR_MONEY_RULE_VERSION,
    calculationSource,
  };
}

export function addHRMoney(a: HRDecimalInput, b: HRDecimalInput, source = "hr_add"): HRCalculationResult {
  const x = toDecimal(a, "A");
  const y = toDecimal(b, "B");
  const raw = x.plus(y);
  return formatResult(raw, "ROUND_HALF_UP_2DP", source);
}

export function subtractHRMoney(a: HRDecimalInput, b: HRDecimalInput, source = "hr_sub"): HRCalculationResult {
  const x = toDecimal(a, "A");
  const y = toDecimal(b, "B");
  const raw = x.minus(y);
  return formatResult(raw, "ROUND_HALF_UP_2DP", source);
}

export function multiplyHRMoney(
  amount: HRDecimalInput,
  factor: HRDecimalInput,
  source = "hr_mul",
): HRCalculationResult {
  const x = toDecimal(amount, "amount");
  const y = toDecimal(factor, "factor");
  const raw = x.times(y);
  return formatResult(raw, "ROUND_HALF_UP_2DP", source);
}

export function divideHRMoney(
  amount: HRDecimalInput,
  divisor: HRDecimalInput,
  source = "hr_div",
): HRCalculationResult {
  const x = toDecimal(amount, "amount");
  const y = toDecimal(divisor, "divisor");
  if (y.isZero()) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, `Divide by zero in ${source}`);
  }
  const raw = x.dividedBy(y);
  return formatResult(raw, "ROUND_HALF_UP_2DP", source);
}

export function roundHRMoney2(v: HRDecimalInput, source = "hr_round_2"): HRCalculationResult {
  const x = toDecimal(v, "amount");
  return formatResult(x, "ROUND_HALF_UP_2DP", source);
}

export function roundHRMoney4(v: HRDecimalInput, source = "hr_round_4"): HRCalculationResult {
  const x = toDecimal(v, "amount");
  return formatResult(x, "ROUND_HALF_UP_4DP", source);
}

export function compareHRMoney(a: HRDecimalInput, b: HRDecimalInput): -1 | 0 | 1 {
  const x = toDecimal(a, "A");
  const y = toDecimal(b, "B");
  return x.comparedTo(y) as -1 | 0 | 1;
}

export function isZeroHRMoney(v: HRDecimalInput): boolean {
  const x = toDecimal(v, "amount");
  return x.isZero();
}

export function isNegativeHRMoney(v: HRDecimalInput): boolean {
  const x = toDecimal(v, "amount");
  return x.isNegative();
}

export function zeroHRMoney(source = "hr_zero_constant"): HRCalculationResult {
  return formatResult(new Decimal(0), "ROUND_HALF_UP_2DP", source);
}

export function applyStatutoryPercentage(
  base: HRDecimalInput,
  ratePercent: HRDecimalInput,
  ruleVersion: string,
  source = "hr_statutory_pct",
): HRCalculationResult & { ruleVersion: string } {
  const b = toDecimal(base, "base");
  const r = toDecimal(ratePercent, "ratePercent").dividedBy(100);
  const raw = b.times(r);
  const result = formatResult(raw, "ROUND_HALF_UP_2DP", source);
  return { ...result, ruleVersion };
}
