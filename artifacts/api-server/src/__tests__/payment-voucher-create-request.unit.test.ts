import { describe, expect, it, vi } from "vitest";
import {
  ensureExactlyOneCreateRequestCompleted,
  writePaymentVoucherCreateAuditEvents,
} from "../modules/accounting/payment-voucher-create-request.js";
import { resolvePaymentVoucherApprovalStatus } from "../modules/accounting/payment-voucher-approval.js";

describe("payment voucher create request helpers", () => {
  it("throws when completion update affects zero rows", async () => {
    await expect(ensureExactlyOneCreateRequestCompleted({
      performUpdate: async () => 0,
    })).rejects.toThrow("expected 1 row, got 0");
  });

  it("does not throw when completion update affects exactly one row", async () => {
    await expect(ensureExactlyOneCreateRequestCompleted({
      performUpdate: async () => 1,
    })).resolves.toBeUndefined();
  });

  it("requests both created and submitted audit events (transactional)", async () => {
    const writeAuditLog = vi.fn(async () => {});

    await writePaymentVoucherCreateAuditEvents({
      writeAuditLog,
      db: {},
      firmId: 1,
      actorId: 2,
      actorType: "firm_user",
      paymentVoucherId: 100,
      voucherNo: "PV-2026-00100",
      initialStatus: "pending_account",
      approvalStatus: "pending_approval",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    });

    expect(writeAuditLog).toHaveBeenCalledTimes(2);
    expect(writeAuditLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "payment_voucher.created",
      entityType: "payment_voucher",
      entityId: 100,
    }), expect.objectContaining({ strict: true }));
    expect(writeAuditLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "payment_voucher.submitted",
      entityType: "payment_voucher",
      entityId: 100,
    }), expect.objectContaining({ strict: true }));
  });

  it("keeps Client Advance approval status pending_approval", () => {
    expect(resolvePaymentVoucherApprovalStatus({
      voucherType: "external_payment",
      isAdvance: true,
      fundStatus: "request_advance",
      requiresPartnerApproval: false,
    })).toBe("pending_approval");
  });
});
