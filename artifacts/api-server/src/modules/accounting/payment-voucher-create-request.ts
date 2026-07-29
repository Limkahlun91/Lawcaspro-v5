export async function writePaymentVoucherCreateAuditEvents(args: {
  writeAuditLog: (params: {
    firmId?: number | null;
    actorId?: number | null;
    actorType?: string;
    action: string;
    entityType?: string;
    entityId?: number;
    detail?: string;
    ipAddress?: string;
    userAgent?: string;
  }, options?: { db?: unknown; strict?: boolean }) => Promise<void>;
  db: unknown;
  firmId: number | null | undefined;
  actorId: number | null | undefined;
  actorType: string | undefined;
  paymentVoucherId: number;
  voucherNo: string;
  initialStatus: string;
  approvalStatus: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}) {
  await args.writeAuditLog({
    firmId: args.firmId,
    actorId: args.actorId,
    actorType: args.actorType,
    action: "payment_voucher.created",
    entityType: "payment_voucher",
    entityId: args.paymentVoucherId,
    detail: `voucherNo=${args.voucherNo} status=${args.initialStatus} approvalStatus=${args.approvalStatus}`,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  }, { db: args.db, strict: true });

  await args.writeAuditLog({
    firmId: args.firmId,
    actorId: args.actorId,
    actorType: args.actorType,
    action: "payment_voucher.submitted",
    entityType: "payment_voucher",
    entityId: args.paymentVoucherId,
    detail: `voucherNo=${args.voucherNo}`,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  }, { db: args.db, strict: true });
}

export async function ensureExactlyOneCreateRequestCompleted(args: {
  performUpdate: () => Promise<number>;
}) {
  const updated = await args.performUpdate();
  if (updated !== 1) {
    throw new Error(`Payment Voucher create request completion update expected 1 row, got ${updated}`);
  }
}

