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
  "account_transfer",
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
]);
export type PaymentVoucherDeductFromAccount = z.infer<typeof PaymentVoucherDeductFromAccount>;

export const PaymentVoucherItem = z.object({
  description: z.string().trim().min(1),
  itemType: z.enum(["disbursement", "professional_fee", "trust_amount"]).default("disbursement"),
  amount: z.number().finite().positive(),
});
export type PaymentVoucherItem = z.infer<typeof PaymentVoucherItem>;

export const CreatePaymentVoucherBody = z.object({
  caseId: z.number().int().positive().nullable().optional(),
  voucherType: PaymentVoucherType.optional().default("external_payment"),
  targetCaseId: z.number().int().positive().nullable().optional(),
  targetAccountId: z.number().int().positive().nullable().optional(),
  payeeName: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  amount: z.number().finite().positive(),
  fundStatus: PaymentVoucherFundStatus,
  items: z.array(PaymentVoucherItem).min(1),
  notes: z.string().trim().max(5000).nullable().optional(),

  payeeBank: z.string().trim().max(255).nullable().optional(),
  payeeAccountNo: z.string().trim().max(255).nullable().optional(),
  paymentMethod: PaymentVoucherPaymentMethod.optional(),
  bankAccountId: z.number().int().positive().nullable().optional(),
  accountType: z.enum(["office", "client", "trust"]).optional(),
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
    action: z.literal("mark_paid"),
    accountType: PaymentVoucherDeductFromAccount,
    paymentMethod: PaymentVoucherPaymentMethod,
    bankChequeRefNo: z.string().trim().min(1).max(255),
  }),
  z.object({ action: z.literal("acknowledge_file_return") }),
]);
export type PaymentVoucherTransitionBody = z.infer<typeof PaymentVoucherTransitionBody>;

