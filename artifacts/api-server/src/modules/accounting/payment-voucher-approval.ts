export function resolvePaymentVoucherApprovalStatus(args: {
  voucherType: string;
  isAdvance: boolean;
  fundStatus: string;
  requiresPartnerApproval: boolean;
}): "pending_approval" | "approved" {
  if (args.voucherType === "account_transfer" || args.voucherType === "internal_transfer" || args.voucherType === "file_to_file_transfer") {
    return "pending_approval";
  }
  if (args.isAdvance) return "pending_approval";
  if (args.fundStatus === "request_advance") return "pending_approval";
  if (args.requiresPartnerApproval) return "pending_approval";
  return "approved";
}

