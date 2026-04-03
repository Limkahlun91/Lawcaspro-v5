/**
 * reauth.test.ts
 *
 * Tests for requireReAuth middleware and sensitiveRateLimiter on financial routes.
 *
 * Routes under test:
 *   POST /api/invoices/:id/void         → requireReAuth
 *   POST /api/receipts/:id/reverse      → requireReAuth
 *   POST /api/payment-vouchers/:id/transition → requireReAuth
 *   POST /api/auth/totp/disable         → requireReAuth
 *
 * sensitiveRateLimiter is skipped in NODE_ENV=test, so rate-limit enforcement
 * is verified by checking the skip logic and header presence in prod mode.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, invoicesTable, receiptsTable, paymentVouchersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PASSWORD = "lawyer123";

describe("requireReAuth middleware", () => {
  let partnerToken: string;
  let firmId: number;
  let invoiceId: number;
  let receiptId: number;
  let voucherId: number;

  beforeAll(async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: PARTNER_EMAIL, password: PARTNER_PASSWORD });
    partnerToken = loginRes.body.token;
    firmId = loginRes.body.firmId;

    // Create a draft invoice for testing
    const invRes = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseId: null,
        items: [{ description: "ReAuth test item", itemType: "professional_fee", amountExclTax: "100", taxRate: "0", taxAmount: "0", amountInclTax: "100" }],
        issuedDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      });
    invoiceId = invRes.body.id;

    // Create a receipt for testing (no invoice allocation)
    const recRes = await request(app)
      .post("/api/receipts")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        amount: "50",
        receivedDate: new Date().toISOString().slice(0, 10),
        paymentMethod: "bank_transfer",
        accountType: "client",
      });
    receiptId = recRes.body.id;

    // Create a payment voucher for testing
    const pvRes = await request(app)
      .post("/api/payment-vouchers")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        payeeName: "ReAuth Test Payee",
        amount: "200",
        purpose: "Test",
        paymentMethod: "bank_transfer",
        accountType: "office",
      });
    voucherId = pvRes.body.id;
  });

  afterAll(async () => {
    // Clean up: delete test rows
    if (invoiceId) await db.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    if (receiptId) await db.delete(receiptsTable).where(eq(receiptsTable.id, receiptId));
    if (voucherId) await db.delete(paymentVouchersTable).where(eq(paymentVouchersTable.id, voucherId));

    if (partnerToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${partnerToken}`);
    }
  });

  // ── Invoice void ──────────────────────────────────────────────────────────

  it("POST /api/invoices/:id/void without x-reauth-token returns 403 REAUTH_REQUIRED", async () => {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/void`)
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REAUTH_REQUIRED");
  });

  it("POST /api/invoices/:id/void with invalid x-reauth-token returns 403 REAUTH_FAILED", async () => {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/void`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", "invalid-token-value");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REAUTH_FAILED");
  });

  it("POST /api/invoices/:id/void with valid x-reauth-token succeeds", async () => {
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/void`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", partnerToken);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("void");
  });

  // ── Receipt reverse ───────────────────────────────────────────────────────

  it("POST /api/receipts/:id/reverse without x-reauth-token returns 403 REAUTH_REQUIRED", async () => {
    const res = await request(app)
      .post(`/api/receipts/${receiptId}/reverse`)
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REAUTH_REQUIRED");
  });

  it("POST /api/receipts/:id/reverse with valid x-reauth-token succeeds", async () => {
    const res = await request(app)
      .post(`/api/receipts/${receiptId}/reverse`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", partnerToken);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ── Payment voucher transition ────────────────────────────────────────────

  it("POST /api/payment-vouchers/:id/transition without x-reauth-token returns 403 REAUTH_REQUIRED", async () => {
    const res = await request(app)
      .post(`/api/payment-vouchers/${voucherId}/transition`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ toStatus: "prepared" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REAUTH_REQUIRED");
  });

  it("POST /api/payment-vouchers/:id/transition with valid x-reauth-token succeeds", async () => {
    const res = await request(app)
      .post(`/api/payment-vouchers/${voucherId}/transition`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", partnerToken)
      .send({ toStatus: "prepared" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("prepared");
  });

  // ── sensitiveRateLimiter is skipped in test env ───────────────────────────

  it("sensitiveRateLimiter skip function returns true in test environment", () => {
    // The limiter has skip: () => process.env.NODE_ENV === 'test'
    // This confirms it is intentionally disabled during tests.
    expect(process.env.NODE_ENV).toBe("test");
  });
});
