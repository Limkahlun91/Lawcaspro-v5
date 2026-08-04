import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import app from "../app";
import { db, firmsTable, casesTable } from "@workspace/db";

const skipDb = process.env.VITEST_SKIP_DB === "1" || !process.env.DATABASE_URL;
const suite = skipDb ? describe.skip : describe;

let partnerToken = "";
let partnerFirmId = 0;
let otherFirmId = 0;
let otherFirmCaseId = 0;

if (!skipDb) {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "partner@tan-associates.my", password: "lawyer123" });
    partnerToken = loginRes.body.data.token;
    partnerFirmId = Number(loginRes.body.data.firmId);

    const [firmRow] = await db
      .select({ subscriptionPlanId: firmsTable.subscriptionPlanId })
      .from(firmsTable)
      .where(eq(firmsTable.id, partnerFirmId))
      .limit(1);

    const now = Date.now();
    const [createdOtherFirm] = await db
      .insert(firmsTable)
      .values({
        name: `PV Other Firm ${now}`,
        slug: `pv-other-firm-${now}`,
        subscriptionPlanId: Number(firmRow?.subscriptionPlanId ?? 1),
      })
      .returning({ id: firmsTable.id });
    otherFirmId = Number(createdOtherFirm.id);

    const [createdOtherCase] = await db
      .insert(casesTable)
      .values({
        firmId: otherFirmId,
        referenceNo: `PV-OTHER-${now}`,
        createdBy: null,
      })
      .returning({ id: casesTable.id });
    otherFirmCaseId = Number(createdOtherCase.id);
  });

  afterAll(async () => {
    if (otherFirmCaseId) {
      await db.delete(casesTable).where(eq(casesTable.id, otherFirmCaseId));
    }
    if (otherFirmId) {
      await db.delete(firmsTable).where(eq(firmsTable.id, otherFirmId));
    }
    if (partnerToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${partnerToken}`);
    }
  });
}

suite("Payment voucher case attachment tenant isolation", () => {
  it("rejects attaching a caseId from another firm (server-side integrity check)", async () => {
    const createRes = await request(app)
      .post("/api/payment-vouchers")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseId: otherFirmCaseId,
        voucherType: "external_payment",
        payeeName: "Cross-firm Payee",
        amount: 10,
        purpose: "Cross-firm case should be rejected",
      });

    expect([400, 404]).toContain(createRes.status);
    expect(String(createRes.body?.error ?? "")).toMatch(/case/i);
  });

  it("does not return other firm's cases in /accounting/cases/search", async () => {
    const q = "PV-OTHER-";
    const res = await request(app)
      .get(`/api/accounting/cases/search?query=${encodeURIComponent(q)}&limit=20`)
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body?.data) ? res.body.data : [];
    expect(rows.some((r: any) => Number(r?.id ?? r?.case_id) === otherFirmCaseId)).toBe(false);
  });
});

