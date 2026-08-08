import { addHRMoney, roundHRMoney2, type HRCalculationResult, HR_MONEY_RULE_VERSION, HR_ROUNDING_MODE_HALF_UP, HR_DB_SCALE, HR_DISPLAY_SCALE } from "../../shared/money/hr-money.js";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import Decimal from "decimal.js";
import { logger } from "../../../lib/logger.js";

export function formatHRCalculationResult(
  raw: Decimal,
  roundingRule: HRCalculationResult["roundingRule"],
  calculationSource: string,
  ruleVersion = HR_MONEY_RULE_VERSION,
): HRCalculationResult {
  const rawAmount = raw.toFixed(HR_DB_SCALE, HR_ROUNDING_MODE_HALF_UP);
  let display = new Decimal(
    raw.toFixed(roundingRule === "TRUNCATE_4DP" || roundingRule === "ROUND_HALF_UP_4DP" ? HR_DB_SCALE : HR_DISPLAY_SCALE, HR_ROUNDING_MODE_HALF_UP),
  );
  const roundedAmount = display.toFixed(HR_DISPLAY_SCALE, HR_ROUNDING_MODE_HALF_UP);
  return {
    rawAmount,
    roundedAmount,
    roundingRule,
    roundingMode: HR_ROUNDING_MODE_HALF_UP,
    ruleVersion,
    calculationSource,
  };
}

export interface PayrollPeriodLock {
  payrollRunId: number | string;
  firmId: number;
  periodKey: string;
  locked: boolean;
  lockedAt?: string;
  lockedByUserId?: number;
  lockReason?: string;
}

export interface PayrollComponent {
  code: string;
  name: string;
  type: "base" | "allowance" | "deduction";
  amount: string;
  ruleVersion?: string;
}

export function computeComponentNet(
  base: string,
  allowances: Array<{ amount: string }>,
  deductions: Array<{ amount: string }>,
  opts: { ruleVersion?: string; source?: string } = {},
) {
  const source = opts.source ?? "computeComponentNet";
  let running = new Decimal(base);
  for (const a of allowances) running = running.plus(a.amount);
  for (const d of deductions) running = running.minus(d.amount);
  return formatHRCalculationResult(running, "ROUND_HALF_UP_2DP", source, opts.ruleVersion);
}

export function enforcePayrollLockedGuard(
  lock: PayrollPeriodLock,
  action: string,
  explicitApprovedAdjustment?: { reason: string; actorUserId: number; auditRef?: string },
): void {
  if (!lock || !lock.locked) return;
  if (!explicitApprovedAdjustment) {
    throw createHRError(
      HR_ERROR_CODES.HR_PAYROLL_PERIOD_LOCKED,
      `Payroll period ${lock.periodKey} is LOCKED. Mutation (${action}) rejected. Supply explicit approved adjustment with reason + actor + auditRef to proceed.`,
      { details: { payrollRunId: lock.payrollRunId, periodKey: lock.periodKey } },
    );
  }
  if (!explicitApprovedAdjustment.reason || !String(explicitApprovedAdjustment.reason).trim()) {
    throw createHRError(
      HR_ERROR_CODES.HR_PAYROLL_PERIOD_LOCKED,
      `Payroll period ${lock.periodKey} locked; approved adjustment reason required (non-empty).`,
      { details: { payrollRunId: lock.payrollRunId } },
    );
  }
  if (!explicitApprovedAdjustment.actorUserId) {
    throw createHRError(
      HR_ERROR_CODES.HR_PAYROLL_PERIOD_LOCKED,
      `Payroll period ${lock.periodKey} locked; approved adjustment actorUserId required.`,
      { details: { payrollRunId: lock.payrollRunId } },
    );
  }
  logger.info(
    { payrollRunId: lock.payrollRunId, periodKey: lock.periodKey, action, actor: explicitApprovedAdjustment.actorUserId, reason: explicitApprovedAdjustment.reason, auditRef: explicitApprovedAdjustment.auditRef },
    "[hrPayroll] locked-period mutation allowed via explicit approved adjustment",
  );
}

export const hrPayrollService = {
  computeComponentNet,
  enforcePayrollLockedGuard,
};

export default hrPayrollService;
