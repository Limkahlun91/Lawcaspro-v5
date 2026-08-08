import { z } from "zod";

export const HREventType = {
  EMPLOYEE_CREATED: "EMPLOYEE_CREATED",
  EMPLOYEE_ACTIVATED: "EMPLOYEE_ACTIVATED",
  EMPLOYEE_UPDATED: "EMPLOYEE_UPDATED",
  EMPLOYEE_REPORTING_MANAGER_CHANGED: "EMPLOYEE_REPORTING_MANAGER_CHANGED",
  EMPLOYEE_NOTICE_STARTED: "EMPLOYEE_NOTICE_STARTED",
  EMPLOYEE_OFFBOARDING_STARTED: "EMPLOYEE_OFFBOARDING_STARTED",
  EMPLOYEE_TERMINATED: "EMPLOYEE_TERMINATED",

  LEAVE_SUBMITTED: "LEAVE_SUBMITTED",
  LEAVE_APPROVED: "LEAVE_APPROVED",
  LEAVE_REJECTED: "LEAVE_REJECTED",
  LEAVE_CANCELLED: "LEAVE_CANCELLED",

  CLAIM_SUBMITTED: "CLAIM_SUBMITTED",
  CLAIM_FINAL_APPROVED: "CLAIM_FINAL_APPROVED",
  CLAIM_APPROVED_FOR_PAYROLL: "CLAIM_APPROVED_FOR_PAYROLL",
  CLAIM_APPROVED_FOR_ACCOUNTING: "CLAIM_APPROVED_FOR_ACCOUNTING",
  CLAIM_PAYMENT_COMPLETED: "CLAIM_PAYMENT_COMPLETED",
  CLAIM_REJECTED: "CLAIM_REJECTED",

  PAYROLL_CALCULATED: "PAYROLL_CALCULATED",
  PAYROLL_SUBMITTED: "PAYROLL_SUBMITTED",
  PAYROLL_APPROVED: "PAYROLL_APPROVED",
  PAYROLL_LOCKED: "PAYROLL_LOCKED",
  PAYROLL_PAYMENT_REQUESTED: "PAYROLL_PAYMENT_REQUESTED",
  PAYROLL_PAYMENT_COMPLETED: "PAYROLL_PAYMENT_COMPLETED",
  PAYROLL_REVERSED: "PAYROLL_REVERSED",

  ASSET_ASSIGNED: "ASSET_ASSIGNED",
  ASSET_RETURNED: "ASSET_RETURNED",
  ASSET_OVERDUE: "ASSET_OVERDUE",

  HR_APPROVAL_OVERDUE: "HR_APPROVAL_OVERDUE",
  HR_DELEGATION_ACTIVATED: "HR_DELEGATION_ACTIVATED",
  HR_DELEGATION_EXPIRED: "HR_DELEGATION_EXPIRED",
} as const;

export type HREventTypeValue = (typeof HREventType)[keyof typeof HREventType];

export const HREventTypeList = Object.values(HREventType) as readonly HREventTypeValue[];

export const HRAggregateType = {
  EMPLOYEE: "EMPLOYEE",
  LEAVE_REQUEST: "LEAVE_REQUEST",
  CLAIM_REQUEST: "CLAIM_REQUEST",
  PAYROLL_RUN: "PAYROLL_RUN",
  ASSET: "ASSET",
  APPROVAL_POLICY: "APPROVAL_POLICY",
  APPROVAL_DELEGATION: "APPROVAL_DELEGATION",
} as const;

export type HRAggregateTypeValue = (typeof HRAggregateType)[keyof typeof HRAggregateType];

export const HREventSourceModule = {
  HR: "HR",
  ACCOUNTING: "ACCOUNTING",
  WORKFLOW: "WORKFLOW",
  NOTIFICATIONS: "NOTIFICATIONS",
} as const;

export type HREventSourceModuleValue = (typeof HREventSourceModule)[keyof typeof HREventSourceModule];

export const HREventSubscriber = {
  HR_NOTIFICATIONS: "HR_NOTIFICATIONS",
  HR_ACCOUNTING_INTEGRATION: "HR_ACCOUNTING_INTEGRATION",
  HR_CASE_INTEGRATION: "HR_CASE_INTEGRATION",
  HR_WORKFLOW_INTEGRATION: "HR_WORKFLOW_INTEGRATION",
  HR_PARTNER_ALERTS: "HR_PARTNER_ALERTS",
} as const;

export type HREventSubscriberValue = (typeof HREventSubscriber)[keyof typeof HREventSubscriber];

export const hrEventTypeSchema = z.enum(HREventTypeList as unknown as [HREventTypeValue, ...HREventTypeValue[]]);

export const hrBusinessEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: hrEventTypeSchema,
  firmId: z.number().int().positive(),
  aggregateType: z.enum([
    HRAggregateType.EMPLOYEE,
    HRAggregateType.LEAVE_REQUEST,
    HRAggregateType.CLAIM_REQUEST,
    HRAggregateType.PAYROLL_RUN,
    HRAggregateType.ASSET,
    HRAggregateType.APPROVAL_POLICY,
    HRAggregateType.APPROVAL_DELEGATION,
  ]),
  aggregateId: z.string().min(1).max(128),
  occurredAt: z.coerce.date(),
  actorUserId: z.number().int().positive().nullable().optional(),
  correlationId: z.string().max(128).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  version: z.number().int().min(1).default(1),
  sourceModule: z.enum([
    HREventSourceModule.HR,
    HREventSourceModule.ACCOUNTING,
    HREventSourceModule.WORKFLOW,
    HREventSourceModule.NOTIFICATIONS,
  ]).default(HREventSourceModule.HR),
  idempotencyKey: z.string().max(512),
});

export type HRBusinessEvent = z.infer<typeof hrBusinessEventSchema>;

export const hrPaginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().max(200).optional(),
  sortBy: z.string().max(64).optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type HRPaginationParams = z.infer<typeof hrPaginationParamsSchema>;

export const hrPageInfoSchema = z.object({
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
});

export type HRPageInfo = z.infer<typeof hrPageInfoSchema>;

export function emptyHRPageInfo(page = 1, perPage = 50): HRPageInfo {
  return { page, perPage, totalItems: 0, totalPages: 0, hasNext: false, hasPrev: page > 1 };
}

export const employmentStatusSchema = z.enum([
  "draft", "active", "probation", "confirmed",
  "notice_period", "pending_handover", "inactive", "terminated",
]);
export type EmploymentStatusZod = z.infer<typeof employmentStatusSchema>;

export const createEmployeeWizardStep1Schema = z.object({
  step: z.literal(1),
  employeeNo: z.string().max(64),
  fullName: z.string().min(1).max(200),
  preferredName: z.string().max(100).optional(),
  icPassportNo: z.string().max(64),
  email: z.string().email().max(200),
  mobile: z.string().max(32).optional(),
});

export const createEmployeeWizardStep2Schema = z.object({
  step: z.literal(2),
  joinDate: z.coerce.date(),
  confirmationDate: z.coerce.date().optional(),
  employmentStatus: employmentStatusSchema.default("probation"),
  departmentId: z.number().int().positive(),
  positionId: z.number().int().positive(),
  branchId: z.number().int().positive().optional(),
  reportingManagerEmployeeId: z.number().int().positive().optional(),
});

export const createEmployeeWizardStep3Schema = z.object({
  step: z.literal(3),
  basicSalary: z.string().regex(/^\d+(\.\d{1,4})?$/),
  currency: z.string().default("MYR"),
  epfNo: z.string().max(32).optional(),
  socsoNo: z.string().max(32).optional(),
  eisNo: z.string().max(32).optional(),
  incomeTaxNo: z.string().max(32).optional(),
  bankAccountNo: z.string().max(64).optional(),
  bankId: z.number().int().positive().optional(),
  salaryEffectiveFrom: z.coerce.date().optional(),
});

export const createEmployeeWizardStep4Schema = z.object({
  step: z.literal(4),
  createLogin: z.boolean().default(false),
  linkExistingUserId: z.number().int().positive().optional(),
  systemRoleName: z.enum([
    "HR Manager", "HR Admin", "Employee",
    "Partner", "Account Admin", "Account Manager",
    "Senior Lawyer", "Lawyer", "Senior Clerk", "Clerk", "Staff", "Manager", "Admin", "Viewer",
  ]).default("Employee"),
  sendInviteEmail: z.boolean().default(true),
});

export const createEmployeeWizardStep5Schema = z.object({
  step: z.literal(5),
  confirmed: z.boolean().refine((v) => v === true, { message: "Review must be confirmed before submission." }),
  clientRequestId: z.string().max(128).optional(),
  saveAsDraft: z.boolean().default(false),
});

export const createEmployeeBodySchema = z.union([
  createEmployeeWizardStep1Schema,
  createEmployeeWizardStep2Schema,
  createEmployeeWizardStep3Schema,
  createEmployeeWizardStep4Schema,
  createEmployeeWizardStep5Schema,
]);

export type CreateEmployeeWizardBody = z.infer<typeof createEmployeeBodySchema>;

export const hrOptimisticLockHeaderSchema = z.object({
  "X-HR-Record-Version": z.coerce.number().int().min(0),
});

export const hrDepartmentListQueryParamsSchema = hrPaginationParamsSchema.extend({
  branchId: z.coerce.number().int().positive().optional(),
  isActive: z.enum(["true", "false"]).optional(),
}).strict();
export type HrDepartmentListQueryParams = z.infer<typeof hrDepartmentListQueryParamsSchema>;

export const hrPositionListQueryParamsSchema = hrPaginationParamsSchema.extend({
  departmentId: z.coerce.number().int().positive().optional(),
  isActive: z.enum(["true", "false"]).optional(),
}).strict();
export type HrPositionListQueryParams = z.infer<typeof hrPositionListQueryParamsSchema>;

export const hrEmployeeListQueryParamsSchema = hrPaginationParamsSchema.extend({
  employmentStatus: employmentStatusSchema.optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  positionId: z.coerce.number().int().positive().optional(),
  branchId: z.coerce.number().int().positive().optional(),
  reportingManagerEmployeeId: z.coerce.number().int().positive().optional(),
}).strict();
export type HrEmployeeListQueryParams = z.infer<typeof hrEmployeeListQueryParamsSchema>;

export const hrEmployeeSummarySchema = z.object({
  id: z.number().int(),
  employeeNo: z.string(),
  legalFullName: z.string(),
  preferredName: z.string().nullish(),
  employmentStatus: employmentStatusSchema,
  commonEmail: z.string().nullish(),
  commonMobile: z.string().nullish(),
  joinDate: z.coerce.date().nullish(),
  departmentId: z.number().int().nullish(),
  positionId: z.number().int().nullish(),
  branchId: z.number().int().nullish(),
  reportingManagerEmployeeId: z.number().int().nullish(),
  linkedUserId: z.number().int().nullish(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  version: z.number().int(),
});
export type HrEmployeeSummary = z.infer<typeof hrEmployeeSummarySchema>;

export const hrEmployeeListResponseSchema = z.object({
  data: z.array(hrEmployeeSummarySchema),
  pageInfo: hrPageInfoSchema,
});
export type HrEmployeeListResponse = z.infer<typeof hrEmployeeListResponseSchema>;

export const HR_EMPLOYEE_STATUS_TRANSITION_NAMES = [
  "start_probation", "activate", "confirm", "start_notice",
  "terminate_without_notice", "begin_handover",
  "complete_inactive_handover", "complete_handover_terminate",
  "terminate_from_inactive", "reactivate", "reactivate_from_inactive",
] as const;
export type HrEmployeeStatusTransitionName = typeof HR_EMPLOYEE_STATUS_TRANSITION_NAMES[number];

export const hrEmployeeStatusTransitionBodySchema = z.object({
  transitionName: z.enum(HR_EMPLOYEE_STATUS_TRANSITION_NAMES),
  effectiveDate: z.coerce.date().optional(),
  note: z.string().max(1000).optional(),
  reason: z.string().max(255).optional(),
  clientRequestId: z.string().max(128).optional(),
}).strict();
export type HrEmployeeStatusTransitionBody = z.infer<typeof hrEmployeeStatusTransitionBodySchema>;

export const hrEmployeeStatusTransitionResultSchema = z.object({
  ok: z.literal(true),
  employeeId: z.number().int(),
  previousStatus: employmentStatusSchema,
  newStatus: employmentStatusSchema,
  transitionName: z.string(),
  newVersion: z.number().int(),
  eventId: z.string().uuid().optional(),
  clientRequestId: z.string().optional(),
});
export type HrEmployeeStatusTransitionResult = z.infer<typeof hrEmployeeStatusTransitionResultSchema>;

export const HR_EMPLOYEE_DETAIL_TABS = [
  "summary", "profile", "compensation", "bank", "identity",
  "leave_balance", "documents", "employment_history", "reporting",
  "disciplinary", "medical", "offboarding", "audit",
] as const;
export type HrEmployeeDetailTab = typeof HR_EMPLOYEE_DETAIL_TABS[number];
