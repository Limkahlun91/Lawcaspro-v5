export const EMPLOYMENT_STATUSES = [
  "draft",
  "active",
  "probation",
  "confirmed",
  "notice_period",
  "pending_handover",
  "inactive",
  "terminated",
] as const;

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export interface StatusTransition {
  from: EmploymentStatus;
  to: EmploymentStatus;
  actionName: string;
  requiredPermissionModule: string;
  requiredPermissionAction: string;
}

export const EMPLOYEE_STATUS_TRANSITIONS: StatusTransition[] = [
  { from: "draft", to: "probation", actionName: "start_probation", requiredPermissionModule: "hr_employee", requiredPermissionAction: "edit" },
  { from: "draft", to: "active", actionName: "activate", requiredPermissionModule: "hr_employee", requiredPermissionAction: "edit" },
  { from: "probation", to: "confirmed", actionName: "confirm", requiredPermissionModule: "hr_employee", requiredPermissionAction: "edit" },
  { from: "probation", to: "notice_period", actionName: "issue_notice", requiredPermissionModule: "hr_termination", requiredPermissionAction: "approve" },
  { from: "probation", to: "terminated", actionName: "terminate_without_notice", requiredPermissionModule: "hr_termination", requiredPermissionAction: "approve" },
  { from: "confirmed", to: "notice_period", actionName: "issue_notice", requiredPermissionModule: "hr_termination", requiredPermissionAction: "approve" },
  { from: "confirmed", to: "active", actionName: "mark_active", requiredPermissionModule: "hr_employee", requiredPermissionAction: "edit" },
  { from: "active", to: "notice_period", actionName: "issue_notice", requiredPermissionModule: "hr_termination", requiredPermissionAction: "approve" },
  { from: "notice_period", to: "pending_handover", actionName: "start_handover", requiredPermissionModule: "hr_offboarding", requiredPermissionAction: "manage" },
  { from: "pending_handover", to: "inactive", actionName: "complete_handover_inactive", requiredPermissionModule: "hr_offboarding", requiredPermissionAction: "manage" },
  { from: "pending_handover", to: "terminated", actionName: "terminate_handover_complete", requiredPermissionModule: "hr_termination", requiredPermissionAction: "approve" },
  { from: "inactive", to: "terminated", actionName: "finalize_termination", requiredPermissionModule: "hr_termination", requiredPermissionAction: "approve" },
  { from: "terminated", to: "active", actionName: "reactivate", requiredPermissionModule: "hr_employee", requiredPermissionAction: "terminate" },
  { from: "inactive", to: "active", actionName: "reactivate_from_inactive", requiredPermissionModule: "hr_employee", requiredPermissionAction: "reactivate" },
];

export function isValidEmployeeStatusTransition(from: EmploymentStatus, to: EmploymentStatus): boolean {
  return EMPLOYEE_STATUS_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function findEmployeeStatusTransition(
  from: EmploymentStatus,
  to: EmploymentStatus,
): StatusTransition | undefined {
  return EMPLOYEE_STATUS_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export interface ClaimStatus {
  id: "draft" | "submitted" | "manager_approved" | "hr_verified" | "final_approved" | "sent_to_payroll" | "sent_to_accounting" | "payment_processing" | "paid" | "rejected" | "cancelled";
}

export type ClaimStatusCode = ClaimStatus["id"];

export const CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS: readonly (keyof {
  status: unknown; paidAt: unknown; paidBy: unknown; payrollId: unknown; accountingRefType: unknown;
  accountingRefId: unknown;
})[] = ["status", "paidAt", "paidBy", "payrollId", "accountingRefType", "accountingRefId"] as const;
