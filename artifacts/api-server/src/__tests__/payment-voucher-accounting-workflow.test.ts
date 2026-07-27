import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../app";
import {
  caseLedgersTable,
  casesTable,
  db,
  ledgerEntriesTable,
  paymentVoucherActionsTable,
  paymentVouchersTable,
  userNotificationsTable,
} from "@workspace/db";

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PASSWORD = "lawyer123";
const CLERK_EMAIL = "clerk@tan-associates.my";
const CLERK_PASSWORD = "clerk123";

function pick<T>(body: any, ...paths: string[]): T | undefined {
  for (const path of paths) {
    const parts = path.split(".");
    let cursor: any = body;
    for (const part of parts) {
      cursor = cursor?.[part];
    }
    if (cursor !== undefined) return cursor as T;
  }
  return undefined;
}

async function login(email: string, password: string): Promise<{ token: string; id: number; firmId: number }> {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  const token = pick<string>(res.body, "token", "data.token");
  const id = pick<number>(res.body, "id", "data.id");
  const firmId = pick<number>(res.body, "firmId", "data.firmId");
  expect(typeof token).toBe("string");
  expect(typeof id).toBe("number");
  expect(typeof firmId).toBe("number");
  return { token: token!, id: id!, firmId: firmId! };
}

async function getReauthToken(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/reauth-token")
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  const reAuthToken = pick<string>(res.body, "reAuthToken", "data.reAuthToken");
  expect(typeof reAuthToken).toBe("string");
  return reAuthToken!;
}

describe("payment voucher accounting workflow", () => {
  let partnerToken = "";
  let partnerUserId = 0;
  let firmId = 0;
  let clerkToken = "";
  let clerkUserId = 0;
  let caseId = 0;
  let voucherId = 0;
  let actionId = 0;
  let clerkUnreadBaseline = 0;

  beforeAll(async () => {
    const partner = await login(PARTNER_EMAIL, PARTNER_PASSWORD);
    partnerToken = partner.token;
    partnerUserId = partner.id;
    firmId = partner.firmId;

    const clerk = await login(CLERK_EMAIL, CLERK_PASSWORD);
    clerkToken = clerk.token;
    clerkUserId = clerk.id;

    const [createdCase] = await db.insert(casesTable).values({
      firmId,
      referenceNo: `PV-AUTO-${Date.now()}`,
      createdBy: partnerUserId,
    } as any).returning({ id: casesTable.id });
    caseId = Number(createdCase.id);

    const unreadRes = await request(app)
      .get("/api/user-notifications/unread-count")
      .set("Authorization", `Bearer ${clerkToken}`);
    expect(unreadRes.status).toBe(200);
    clerkUnreadBaseline = Number(pick<number>(unreadRes.body, "count", "data.count") ?? 0);
  });

  afterAll(async () => {
    if (actionId) {
      await db.delete(userNotificationsTable).where(and(
        eq(userNotificationsTable.firmId, firmId),
        eq(userNotificationsTable.sourceType, "payment_voucher_action"),
        eq(userNotificationsTable.sourceId, actionId),
      ));
      await db.delete(paymentVoucherActionsTable).where(eq(paymentVoucherActionsTable.id, actionId));
    }
    if (voucherId) {
      await db.delete(userNotificationsTable).where(and(
        eq(userNotificationsTable.firmId, firmId),
        eq(userNotificationsTable.sourceType, "payment_voucher"),
        eq(userNotificationsTable.sourceId, voucherId),
      ));
      await db.delete(caseLedgersTable).where(and(
        eq(caseLedgersTable.firmId, firmId),
        eq(caseLedgersTable.sourceId, voucherId),
        inArray(caseLedgersTable.sourceType, ["payment_voucher", "payment_voucher_advance"]),
      ));
      await db.delete(ledgerEntriesTable).where(and(
        eq(ledgerEntriesTable.firmId, firmId),
        eq(ledgerEntriesTable.sourceType, "payment_voucher"),
        eq(ledgerEntriesTable.sourceId, voucherId),
      ));
      await db.delete(paymentVouchersTable).where(eq(paymentVouchersTable.id, voucherId));
    }
    if (caseId) {
      await db.delete(casesTable).where(eq(casesTable.id, caseId));
    }
    if (partnerToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${partnerToken}`);
    }
    if (clerkToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${clerkToken}`);
    }
  });

  it("blocks clerk from accounting module and accounting settings routes", async () => {
    const listRes = await request(app)
      .get("/api/payment-vouchers")
      .set("Authorization", `Bearer ${clerkToken}`);
    expect(listRes.status).toBe(403);

    const settingsRes = await request(app)
      .get("/api/accounting/settings")
      .set("Authorization", `Bearer ${clerkToken}`);
    expect(settingsRes.status).toBe(403);
  });

  it("creates, approves, receives and pays a case-linked voucher with clerk action", async () => {
    const createRes = await request(app)
      .post("/api/payment-vouchers")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseId,
        voucherType: "external_payment",
        payeeName: "Workflow Test Payee",
        amount: 250,
        purpose: "Workflow test",
      });

    expect(createRes.status).toBe(201);
    voucherId = Number(pick<number>(createRes.body, "id", "data.id"));
    expect(voucherId).toBeGreaterThan(0);
    expect(String(pick<string>(createRes.body, "status", "data.status"))).toBe("pending_account");
    expect(String(pick<string>(createRes.body, "approvalStatus", "data.approvalStatus"))).toBe("pending_approval");

    const approveToken = await getReauthToken(partnerToken);
    const approveRes = await request(app)
      .post(`/api/payment-vouchers/${voucherId}/transition`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", approveToken)
      .send({ action: "approve", decision: "approved" });
    expect(approveRes.status).toBe(200);
    expect(String(pick<string>(approveRes.body, "approvalStatus", "data.approvalStatus"))).toBe("approved");

    const receiveToken = await getReauthToken(partnerToken);
    const receiveRes = await request(app)
      .post(`/api/payment-vouchers/${voucherId}/transition`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", receiveToken)
      .send({ action: "received_by_accounts", assignedAccountUserId: partnerUserId, isUrgent: false });
    expect(receiveRes.status).toBe(200);
    expect(pick<string>(receiveRes.body, "receivedAt", "data.receivedAt")).toBeTruthy();
    expect(pick<string>(receiveRes.body, "paymentDueAt", "data.paymentDueAt")).toBeTruthy();

    const duplicateReceiveToken = await getReauthToken(partnerToken);
    const duplicateReceiveRes = await request(app)
      .post(`/api/payment-vouchers/${voucherId}/transition`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", duplicateReceiveToken)
      .send({ action: "received_by_accounts", assignedAccountUserId: partnerUserId, isUrgent: false });
    expect(duplicateReceiveRes.status).toBe(409);
    expect(String(duplicateReceiveRes.body.code)).toBe("ALREADY_RECEIVED");

    const markPaidToken = await getReauthToken(partnerToken);
    const markPaidRes = await request(app)
      .post(`/api/payment-vouchers/${voucherId}/transition`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", markPaidToken)
      .send({
        action: "mark_paid",
        accountType: "office",
        paymentMethod: "bank_transfer",
        bankChequeRefNo: "WF-001",
        paidAmount: 250,
        proofDocumentPath: "/objects/tests/workflow-proof.pdf",
        nextActionType: "Collect Physical File",
        assignedClerkUserId: clerkUserId,
      });
    expect(markPaidRes.status).toBe(200);
    expect(String(pick<string>(markPaidRes.body, "status", "data.status"))).toBe("paid_pending_collection");

    const [action] = await db
      .select({ id: paymentVoucherActionsTable.id })
      .from(paymentVoucherActionsTable)
      .where(and(
        eq(paymentVoucherActionsTable.firmId, firmId),
        eq(paymentVoucherActionsTable.paymentVoucherId, voucherId),
      ))
      .limit(1);
    actionId = Number(action?.id ?? 0);
    expect(actionId).toBeGreaterThan(0);

    const duplicateMarkPaidToken = await getReauthToken(partnerToken);
    const duplicateMarkPaidRes = await request(app)
      .post(`/api/payment-vouchers/${voucherId}/transition`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", duplicateMarkPaidToken)
      .send({
        action: "mark_paid",
        accountType: "office",
        paymentMethod: "bank_transfer",
        bankChequeRefNo: "WF-001",
        paidAmount: 250,
        proofDocumentPath: "/objects/tests/workflow-proof.pdf",
        nextActionType: "Collect Physical File",
        assignedClerkUserId: clerkUserId,
      });
    expect(duplicateMarkPaidRes.status).toBe(400);

    const [ledgerCountRow] = await db
      .select({ c: sql<number>`count(*)` })
      .from(ledgerEntriesTable)
      .where(and(
        eq(ledgerEntriesTable.firmId, firmId),
        eq(ledgerEntriesTable.sourceType, "payment_voucher"),
        eq(ledgerEntriesTable.sourceId, voucherId),
      ));
    expect(Number(ledgerCountRow?.c ?? 0)).toBe(1);
  });

  it("surfaces clerk action in my work and marks notification unread count", async () => {
    const myWorkRes = await request(app)
      .get("/api/payment-voucher-actions/my-work")
      .set("Authorization", `Bearer ${clerkToken}`);
    expect(myWorkRes.status).toBe(200);
    const rows = Array.isArray(myWorkRes.body) ? myWorkRes.body : (Array.isArray(myWorkRes.body?.data) ? myWorkRes.body.data : []);
    expect(rows.some((row: any) => Number(row.id) === actionId)).toBe(true);

    const unreadRes = await request(app)
      .get("/api/user-notifications/unread-count")
      .set("Authorization", `Bearer ${clerkToken}`);
    expect(unreadRes.status).toBe(200);
    const count = Number(pick<number>(unreadRes.body, "count", "data.count") ?? 0);
    expect(count).toBeGreaterThanOrEqual(clerkUnreadBaseline + 1);
  });

  it("requires acknowledge before completion and completes voucher after clerk finishes action", async () => {
    const completeBeforeAckRes = await request(app)
      .post(`/api/payment-voucher-actions/${actionId}/complete`)
      .set("Authorization", `Bearer ${clerkToken}`)
      .send({ actionTaken: "Should fail before ack" });
    expect(completeBeforeAckRes.status).toBe(409);
    expect(String(completeBeforeAckRes.body.code)).toBe("ACKNOWLEDGEMENT_REQUIRED");

    const acknowledgeRes = await request(app)
      .post(`/api/payment-voucher-actions/${actionId}/acknowledge`)
      .set("Authorization", `Bearer ${clerkToken}`);
    expect(acknowledgeRes.status).toBe(200);
    expect(String(pick<string>(acknowledgeRes.body, "status", "data.status"))).toBe("acknowledged");

    const completeRes = await request(app)
      .post(`/api/payment-voucher-actions/${actionId}/complete`)
      .set("Authorization", `Bearer ${clerkToken}`)
      .send({
        actionTaken: "Collected file from accounts",
        completionNotes: "Next step completed",
      });
    expect(completeRes.status).toBe(200);
    expect(String(pick<string>(completeRes.body, "updatedAction.status", "data.updatedAction.status"))).toBe("completed");
    expect(String(pick<string>(completeRes.body, "updatedVoucher.status", "data.updatedVoucher.status"))).toBe("completed");

    const unreadRes = await request(app)
      .get("/api/user-notifications/unread-count")
      .set("Authorization", `Bearer ${clerkToken}`);
    expect(unreadRes.status).toBe(200);
    const count = Number(pick<number>(unreadRes.body, "count", "data.count") ?? 0);
    expect(count).toBe(clerkUnreadBaseline);
  });
});
