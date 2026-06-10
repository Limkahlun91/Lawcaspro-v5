import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import app from "../app";

type WorkspaceDb = typeof import("@workspace/db");
type DrizzleOps = typeof import("drizzle-orm");

const skipDb = process.env.VITEST_SKIP_DB === "1" || !process.env.DATABASE_URL;
const suite = skipDb ? describe.skip : describe;

let db: WorkspaceDb["db"];
let firmsTable: WorkspaceDb["firmsTable"];
let communicationMessagesTable: WorkspaceDb["communicationMessagesTable"];
let communicationEmailRemarksTable: WorkspaceDb["communicationEmailRemarksTable"];
let communicationMessageReadsTable: WorkspaceDb["communicationMessageReadsTable"];
let communicationTaskAssigneesTable: WorkspaceDb["communicationTaskAssigneesTable"];
let communicationAuditLogsTable: WorkspaceDb["communicationAuditLogsTable"];

let and: DrizzleOps["and"];
let eq: DrizzleOps["eq"];
let inArray: DrizzleOps["inArray"];
let ne: DrizzleOps["ne"];
let or: DrizzleOps["or"];

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PASSWORD = "lawyer123";

let partnerToken: string;
let partnerFirmId: number;
let otherFirmId: number;
let caseIds: number[] = [];
let userIds: number[] = [];
let hasInboxTables = false;

const TEST_SUBJECT = "TEST-EMAIL-INBOX-SIMPLE";

if (!skipDb) {
  beforeAll(async () => {
    const [dbMod, ops] = await Promise.all([import("@workspace/db"), import("drizzle-orm")]);
    db = dbMod.db;
    firmsTable = dbMod.firmsTable;
    communicationMessagesTable = dbMod.communicationMessagesTable;
    communicationEmailRemarksTable = dbMod.communicationEmailRemarksTable;
    communicationMessageReadsTable = dbMod.communicationMessageReadsTable;
    communicationTaskAssigneesTable = dbMod.communicationTaskAssigneesTable;
    communicationAuditLogsTable = dbMod.communicationAuditLogsTable;

    and = ops.and;
    eq = ops.eq;
    inArray = ops.inArray;
    ne = ops.ne;
    or = ops.or;

    const remarksResult = await db.execute<{ reg: string | null }>(sql`SELECT to_regclass('public.communication_email_remarks') AS reg`);
    const readsResult = await db.execute<{ reg: string | null }>(sql`SELECT to_regclass('public.communication_message_reads') AS reg`);
    const remarksReg = remarksResult.rows[0]?.reg ?? null;
    const readsReg = readsResult.rows[0]?.reg ?? null;
    hasInboxTables = Boolean(remarksReg && readsReg);

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: PARTNER_EMAIL, password: PARTNER_PASSWORD });
    partnerToken = loginRes.body.data.token;
    partnerFirmId = loginRes.body.data.firmId;

    const [otherFirm] = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(ne(firmsTable.id, partnerFirmId))
      .limit(1);
    otherFirmId = otherFirm?.id ?? partnerFirmId + 99999;

    const casesRes = await request(app)
      .get("/api/cases?limit=5")
      .set("Authorization", `Bearer ${partnerToken}`);
    caseIds = (casesRes.body.data ?? []).map((c: any) => c.id).filter((x: any) => typeof x === "number").slice(0, 2);

    const usersRes = await request(app)
      .get("/api/users?limit=20")
      .set("Authorization", `Bearer ${partnerToken}`);
    userIds = (usersRes.body.data ?? []).map((u: any) => u.id).filter((x: any) => typeof x === "number").slice(0, 4);
  });

  afterAll(async () => {
    const testMessages = await db
      .select({ id: communicationMessagesTable.id, firmId: communicationMessagesTable.firmId })
      .from(communicationMessagesTable)
      .where(or(
        and(eq(communicationMessagesTable.firmId, partnerFirmId), eq(communicationMessagesTable.subject, TEST_SUBJECT)),
        and(eq(communicationMessagesTable.firmId, otherFirmId), eq(communicationMessagesTable.subject, TEST_SUBJECT)),
      ));

    const messageIds = testMessages.map((m) => m.id);
    if (!messageIds.length) return;

    if (hasInboxTables) {
      await db.delete(communicationEmailRemarksTable).where(and(eq(communicationEmailRemarksTable.firmId, partnerFirmId), inArray(communicationEmailRemarksTable.messageId, messageIds)));
      await db.delete(communicationMessageReadsTable).where(and(eq(communicationMessageReadsTable.firmId, partnerFirmId), inArray(communicationMessageReadsTable.messageId, messageIds)));
    }

    await db.delete(communicationTaskAssigneesTable).where(and(eq(communicationTaskAssigneesTable.firmId, partnerFirmId), inArray(communicationTaskAssigneesTable.messageId, messageIds)));
    await db.delete(communicationAuditLogsTable).where(and(eq(communicationAuditLogsTable.firmId, partnerFirmId), inArray(communicationAuditLogsTable.messageId, messageIds)));
    await db.delete(communicationMessagesTable).where(and(eq(communicationMessagesTable.firmId, partnerFirmId), inArray(communicationMessagesTable.id, messageIds)));
    await db.delete(communicationMessagesTable).where(and(eq(communicationMessagesTable.firmId, otherFirmId), inArray(communicationMessagesTable.id, messageIds)));
  });
}

suite("Email Inbox — Remarks / Reads / Assignees / Archive / Link Case", () => {
  it("supports remarks CRUD (soft delete)", async () => {
    if (!hasInboxTables) return;

    const msgRes = await request(app)
      .post("/api/communication/messages/manual-email")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        fromName: "Ops",
        fromEmail: "ops@bank.test",
        to: ["shared@firm.test"],
        cc: [],
        subject: TEST_SUBJECT,
        bodyText: "Remark test",
      });
    expect(msgRes.status).toBe(201);
    const messageId = msgRes.body.id as number;

    const createRes = await request(app)
      .post(`/api/communication/messages/${messageId}/remarks`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ body: "First remark" });
    expect(createRes.status).toBe(201);
    const remarkId = createRes.body.id as number;

    const list1 = await request(app)
      .get(`/api/communication/messages/${messageId}/remarks`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(list1.status).toBe(200);
    expect(list1.body.length).toBe(1);
    expect(list1.body[0].id).toBe(remarkId);

    const patchRes = await request(app)
      .patch(`/api/communication/remarks/${remarkId}`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ body: "Edited remark" });
    expect(patchRes.status).toBe(200);

    const delRes = await request(app)
      .delete(`/api/communication/remarks/${remarkId}`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const list2 = await request(app)
      .get(`/api/communication/messages/${messageId}/remarks`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(list2.status).toBe(200);
    expect(list2.body.length).toBe(0);
  });

  it("tracks opened/read, supports mark read/unread, and unread filter works", async () => {
    if (!hasInboxTables) return;

    const msgRes = await request(app)
      .post("/api/communication/messages/manual-email")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        fromName: "Ops",
        fromEmail: "ops@bank.test",
        to: ["shared@firm.test"],
        cc: [],
        subject: TEST_SUBJECT,
        bodyText: "Read tracking test",
      });
    expect(msgRes.status).toBe(201);
    const messageId = msgRes.body.id as number;

    const open1 = await request(app)
      .post(`/api/communication/messages/${messageId}/read`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(open1.status).toBe(200);
    expect(open1.body.openedCount).toBe(1);

    const open2 = await request(app)
      .post(`/api/communication/messages/${messageId}/read`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(open2.status).toBe(200);
    expect(open2.body.openedCount).toBe(2);

    const readsRes = await request(app)
      .get(`/api/communication/messages/${messageId}/reads`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(readsRes.status).toBe(200);
    expect(readsRes.body.length).toBeGreaterThanOrEqual(1);

    const unread1 = await request(app)
      .get("/api/communication/messages?unread=true&limit=50")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(unread1.status).toBe(200);
    expect(unread1.body.some((row: any) => row.message?.id === messageId)).toBe(false);

    const markUnread = await request(app)
      .patch(`/api/communication/messages/${messageId}/read-status`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ isRead: false });
    expect(markUnread.status).toBe(200);
    expect(markUnread.body.ok).toBe(true);

    const unread2 = await request(app)
      .get("/api/communication/messages?unread=true&limit=50")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(unread2.status).toBe(200);
    expect(unread2.body.some((row: any) => row.message?.id === messageId)).toBe(true);

    const markRead = await request(app)
      .patch(`/api/communication/messages/${messageId}/read-status`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ isRead: true });
    expect(markRead.status).toBe(200);
    expect(markRead.body.ok).toBe(true);

    const unread3 = await request(app)
      .get("/api/communication/messages?unread=true&limit=50")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(unread3.status).toBe(200);
    expect(unread3.body.some((row: any) => row.message?.id === messageId)).toBe(false);
  });

  it("supports assignees multi-update and assigned/unassigned filters", async () => {
    if (!userIds.length) return;

    const msgRes = await request(app)
      .post("/api/communication/messages/manual-email")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        fromName: "Ops",
        fromEmail: "ops@bank.test",
        to: ["shared@firm.test"],
        cc: [],
        subject: TEST_SUBJECT,
        bodyText: "Assignees test",
      });
    expect(msgRes.status).toBe(201);
    const messageId = msgRes.body.id as number;

    const unassigned1 = await request(app)
      .get("/api/communication/messages?assignedTo=unassigned&limit=50")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(unassigned1.status).toBe(200);
    expect(unassigned1.body.some((row: any) => row.message?.id === messageId)).toBe(true);

    const patchRes = await request(app)
      .patch(`/api/communication/messages/${messageId}/assignees`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ userIds: userIds.slice(0, 2) });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.ok).toBe(true);

    const getRes = await request(app)
      .get(`/api/communication/messages/${messageId}/assignees`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.userIds)).toBe(true);
    expect(getRes.body.userIds.length).toBeGreaterThanOrEqual(1);

    const unassigned2 = await request(app)
      .get("/api/communication/messages?assignedTo=unassigned&limit=50")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(unassigned2.status).toBe(200);
    expect(unassigned2.body.some((row: any) => row.message?.id === messageId)).toBe(false);
  });

  it("supports link/unlink case and archive/unarchive filters", async () => {
    if (!caseIds.length) return;

    const msgRes = await request(app)
      .post("/api/communication/messages/manual-email")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        fromName: "Ops",
        fromEmail: "ops@bank.test",
        to: ["shared@firm.test"],
        cc: [],
        subject: TEST_SUBJECT,
        bodyText: "Link + Archive test",
      });
    expect(msgRes.status).toBe(201);
    const messageId = msgRes.body.id as number;

    const linkRes = await request(app)
      .patch(`/api/communication/messages/${messageId}/link-case`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ caseId: caseIds[0] });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.linkedCaseId).toBe(caseIds[0]);

    const unlinkRes = await request(app)
      .delete(`/api/communication/messages/${messageId}/link-case`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(unlinkRes.status).toBe(200);
    expect(unlinkRes.body.linkedCaseId).toBe(null);

    const archiveRes = await request(app)
      .patch(`/api/communication/messages/${messageId}/archive`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ archived: true });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.internalStatus).toBe("archived");

    const archivedList = await request(app)
      .get("/api/communication/messages?status=archived&limit=50")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(archivedList.status).toBe(200);
    expect(archivedList.body.some((row: any) => row.message?.id === messageId)).toBe(true);

    const unarchiveRes = await request(app)
      .patch(`/api/communication/messages/${messageId}/archive`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ archived: false });
    expect(unarchiveRes.status).toBe(200);
    expect(unarchiveRes.body.internalStatus).not.toBe("archived");
  });

  it("case lookup endpoint responds", async () => {
    const res = await request(app)
      .get("/api/communication/case-lookup?q=a&limit=5")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
