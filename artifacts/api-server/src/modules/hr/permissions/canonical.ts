import { logger } from "../../../lib/logger.js";

export type PermissionCanonical = string;

export const LEGACY_TO_CANONICAL: ReadonlyMap<string, PermissionCanonical> = new Map([
  ["hr_salary:view", "hr.salary.view"],
  ["hr_salary:create", "hr.salary.create"],
  ["hr_salary:adjustment_approve", "hr.salary.adjustment_approve"],
  ["hr_salary:self_view_payslip", "hr.salary.self_view_payslip"],
  ["hr_bank_details:view", "hr.bank_details.view"],
  ["hr_bank_details:edit", "hr.bank_details.edit"],
  ["hr_bank_details:self_view", "hr.bank_details.self_view"],
  ["hr_bank_details:self_edit", "hr.bank_details.self_edit"],
  ["hr_identity_records:view", "hr.identity.view"],
  ["hr_identity_records:edit", "hr.identity.edit"],
  ["hr_identity_records:self_view", "hr.identity.self_view"],
  ["hr_identity_records:self_upload", "hr.identity.self_upload"],
  ["hr_medical_records:view", "hr.medical_document.view"],
  ["hr_medical_records:edit", "hr.medical_document.edit"],
  ["hr_medical_records:self_view", "hr.medical_document.self_view"],
  ["hr_medical_records:self_upload", "hr.medical_document.self_upload"],
  ["hr_disciplinary:view", "hr.disciplinary.view"],
  ["hr_disciplinary:create", "hr.disciplinary.create"],
  ["hr_disciplinary:close", "hr.disciplinary.close"],
  ["hr_leave_balance:view_all", "hr.leave_balance.view_all"],
  ["hr_leave_balance:adjust", "hr.leave_balance.adjust"],
  ["hr_leave_balance:self_view", "hr.leave_balance.self_view"],
  ["hr_settings.manage_organisation", "hr.settings.manage_organisation"],
  ["hr_settings.manage_approval_flow", "hr.settings.manage_approval_flow"],
  ["hr_settings.manage_feature_flags", "hr.settings.manage_feature_flags"],
  ["hr_settings:view", "hr.settings.view"],
  ["hr_approval:delegate", "hr.approval.delegate"],
  ["hr_approval:reassign", "hr.approval.reassign"],
  ["hr_approval:override", "hr.approval.override"],
  ["hr_payroll:run", "hr.payroll.run"],
  ["hr_payroll:approve", "hr.payroll.approve"],
  ["hr_payroll:lock", "hr.payroll.lock"],
  ["hr_payroll:reverse", "hr.payroll.reverse"],
  ["hr_payroll:adjust", "hr.payroll.adjust"],
]);

export const CANONICAL_TO_LEGACY_FOR_ROUTER_MIDDLEWARE_ONLY: ReadonlyMap<PermissionCanonical, string[]> = (() => {
  const rev = new Map<PermissionCanonical, string[]>();
  for (const [legacy, canonical] of LEGACY_TO_CANONICAL.entries()) {
    const arr = rev.get(canonical) ?? [];
    arr.push(legacy);
    rev.set(canonical, arr);
  }
  return rev;
})();

let legacyDeprecationWarningLogCount = 0;
const MAX_LEGACY_WARNINGS = 50;

export function legacyToCanonical(
  rawCode: string | undefined | null,
  opts: { emitWarning?: boolean } = {},
): PermissionCanonical {
  if (!rawCode) return "";
  const key = String(rawCode).trim();
  if (!key) return "";
  const canonicalMap = LEGACY_TO_CANONICAL as Map<string, PermissionCanonical>;
  if (canonicalMap.has(key)) {
    if (opts.emitWarning !== false && legacyDeprecationWarningLogCount < MAX_LEGACY_WARNINGS) {
      legacyDeprecationWarningLogCount++;
      logger.warn(
        { legacyCode: key, canonical: canonicalMap.get(key) },
        "[hrPermissionCanonical] DEPRECATED legacy permission form used. Migrate callers to canonical dot form. " +
          `Warning count=${legacyDeprecationWarningLogCount}/${MAX_LEGACY_WARNINGS} (further warnings suppressed).`,
      );
    }
    return canonicalMap.get(key) as PermissionCanonical;
  }
  if (key.includes(":")) {
    const converted = key.replace(/:/g, ".");
    if (opts.emitWarning !== false && legacyDeprecationWarningLogCount < MAX_LEGACY_WARNINGS) {
      legacyDeprecationWarningLogCount++;
      logger.warn(
        { legacyCode: key, converted },
        "[hrPermissionCanonical] heuristic colon→dot conversion of legacy permission form. Add entry to LEGACY_TO_CANONICAL map for determinism.",
      );
    }
    return converted;
  }
  if (key.includes("/")) {
    const converted = key.replace(/\//g, ".");
    if (opts.emitWarning !== false && legacyDeprecationWarningLogCount < MAX_LEGACY_WARNINGS) {
      legacyDeprecationWarningLogCount++;
      logger.warn(
        { legacyCode: key, converted },
        "[hrPermissionCanonical] heuristic slash→dot conversion of legacy permission form. Add entry to LEGACY_TO_CANONICAL map for determinism.",
      );
    }
    return converted;
  }
  return key;
}

export function canonicalPermission(code: string): PermissionCanonical {
  if (!code) return "";
  if (code.includes(".") && !code.includes(":") && !code.includes("/")) return code;
  return legacyToCanonical(code);
}

export const hrCanonicalPermissions = {
  LEGACY_TO_CANONICAL,
  CANONICAL_TO_LEGACY_FOR_ROUTER_MIDDLEWARE_ONLY,
  legacyToCanonical,
  canonicalPermission,
};

export default hrCanonicalPermissions;
