import { z } from "zod";

export const PaymentVoucherStatus = z.enum([
  "pending_lawyer",
  "pending_partner",
  "pending_account",
  "paid_pending_collection",
  "completed",
]);
export type PaymentVoucherStatus = z.infer<typeof PaymentVoucherStatus>;

export const PaymentVoucherFundStatus = z.enum([
  "client_paid",
  "request_advance",
]);
export type PaymentVoucherFundStatus = z.infer<typeof PaymentVoucherFundStatus>;

export const PaymentVoucherType = z.enum([
  "external_payment",
  "file_transfer",
  "file_to_file_transfer",
  "account_transfer",
  "internal_transfer",
]);
export type PaymentVoucherType = z.infer<typeof PaymentVoucherType>;

export const PaymentVoucherApprovalStatus = z.enum([
  "approved",
  "pending_approval",
  "rejected",
]);
export type PaymentVoucherApprovalStatus = z.infer<typeof PaymentVoucherApprovalStatus>;

export const PaymentVoucherPaymentMethod = z.enum([
  "bank_transfer",
  "cheque",
  "cash",
]);
export type PaymentVoucherPaymentMethod = z.infer<typeof PaymentVoucherPaymentMethod>;

export const PaymentVoucherDeductFromAccount = z.enum([
  "office",
  "client",
  "trust",
  "balance_sheet",
]);
export type PaymentVoucherDeductFromAccount = z.infer<typeof PaymentVoucherDeductFromAccount>;

export const PaymentVoucherItem = z.object({
  description: z.string().trim().min(1),
  itemType: z.enum(["disbursement", "professional_fee", "trust_amount"]).default("disbursement"),
  amount: z.number().finite().positive(),
});
export type PaymentVoucherItem = z.infer<typeof PaymentVoucherItem>;

export const PaymentVoucherLineItem = z.object({
  purpose: z.string().trim().min(1),
  amount: z.number().finite().positive(),
});
export type PaymentVoucherLineItem = z.infer<typeof PaymentVoucherLineItem>;

export const CreatePaymentVoucherBody = z.object({
  caseId: z.number().int().positive().nullable().optional(),
  voucherType: PaymentVoucherType.optional().default("external_payment"),
  targetCaseId: z.number().int().positive().nullable().optional(),
  targetAccountId: z.number().int().positive().nullable().optional(),
  isAdvance: z.boolean().optional(),
  payeeName: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  amount: z.number().finite().positive(),
  fundStatus: PaymentVoucherFundStatus.optional().default("client_paid"),
  items: z.array(PaymentVoucherItem).min(1).optional(),
  lineItems: z.array(PaymentVoucherLineItem).min(1).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),

  payeeBank: z.string().trim().max(255).nullable().optional(),
  payeeAccountNo: z.string().trim().max(255).nullable().optional(),
  beneficiaryBank: z.string().trim().max(255).nullable().optional(),
  beneficiaryAccountNo: z.string().trim().max(255).nullable().optional(),
  paymentMethod: PaymentVoucherPaymentMethod.optional(),
  bankAccountId: z.number().int().positive().nullable().optional(),
  accountType: z.enum(["office", "client", "trust", "balance_sheet"]).optional(),
});
export type CreatePaymentVoucherBody = z.infer<typeof CreatePaymentVoucherBody>;

export const PaymentVoucherTransitionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lawyer_approve") }),
  z.object({ action: z.literal("partner_approve") }),
  z.object({
    action: z.literal("approve"),
    decision: PaymentVoucherApprovalStatus.optional().default("approved"),
  }),
  z.object({
    action: z.literal("received_by_accounts"),
    assignedAccountUserId: z.number().int().positive().optional(),
    isUrgent: z.boolean().optional().default(false),
  }),
  z.object({
    action: z.literal("reassign_account_user"),
    assignedAccountUserId: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("override_deadline"),
    paymentDueAt: z.string().datetime(),
    reason: z.string().trim().min(3).max(1000),
  }),
  z.object({
    action: z.literal("mark_paid"),
    accountType: PaymentVoucherDeductFromAccount,
    paymentMethod: PaymentVoucherPaymentMethod,
    bankChequeRefNo: z.string().trim().min(1).max(255),
    paidAmount: z.number().finite().positive().optional(),
    proofDocumentPath: z.string().trim().min(1).max(1000).optional(),
    nextActionType: z.string().trim().min(1).max(120),
    nextActionCustom: z.string().trim().min(1).max(500).optional(),
    nextActionRemarks: z.string().trim().max(2000).optional(),
    assignedClerkUserId: z.number().int().positive().optional(),
    clerkActionExemptReason: z.string().trim().min(3).max(1000).optional(),
    lateCompletionReason: z.string().trim().max(2000).optional(),
  }),
]);
export type PaymentVoucherTransitionBody = z.infer<typeof PaymentVoucherTransitionBody>;

