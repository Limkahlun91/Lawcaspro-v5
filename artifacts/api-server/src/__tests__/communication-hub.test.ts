import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";

type WorkspaceDb = typeof import("@workspace/db");
type DrizzleOps = typeof import("drizzle-orm");

const skipDb = process.env.VITEST_SKIP_DB === "1" || !process.env.DATABASE_URL;
const suite = skipDb ? describe.skip : describe; // DB-gated regression tests (Email module frozen = no runtime edits; tests conditional-run only)

let db: WorkspaceDb["db"];
let firmsTable: WorkspaceDb["firmsTable"];
let communicationMessagesTable: WorkspaceDb["communicationMessagesTable"];
let communicationCaseTasksTable: WorkspaceDb["communicationCaseTasksTable"];
let communicationDraftsTable: WorkspaceDb["communicationDraftsTable"];
let communicationDraftTasksTable: WorkspaceDb["communicationDraftTasksTable"];
let communicationAuditLogsTable: WorkspaceDb["communicationAuditLogsTable"];
let communicationMailboxesTable: WorkspaceDb["communicationMailboxesTable"];

let and: DrizzleOps["and"];
let eq: DrizzleOps["eq"];
let ilike: DrizzleOps["ilike"];
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

if (!skipDb) {
  beforeAll(async () => {
    const [dbMod, ops] = await Promise.all([import("@workspace/db"), import("drizzle-orm")]);
    db = dbMod.db;
    firmsTable = dbMod.firmsTable;
    communicationMessagesTable = dbMod.communicationMessagesTable;
    communicationCaseTasksTable = dbMod.communicationCaseTasksTable;
    communicationDraftsTable = dbMod.communicationDraftsTable;
    communicationDraftTasksTable = dbMod.communicationDraftTasksTable;
    communicationAuditLogsTable = dbMod.communicationAuditLogsTable;
    communicationMailboxesTable = dbMod.communicationMailboxesTable;

    and = ops.and;
    eq = ops.eq;
    ilike = ops.ilike;
    inArray = ops.inArray;
    ne = ops.ne;
    or = ops.or;

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
    userIds = (usersRes.body.data ?? []).map((u: any) => u.id).filter((x: any) => typeof x === "number").slice(0, 3);
  });

  afterAll(async () => {
    const testSubjects = [
      "TEST-COMM-MANUAL-EMAIL",
    ];

    const testMessages = await db
      .select({ id: communicationMessagesTable.id, firmId: communicationMessagesTable.firmId })
      .from(communicationMessagesTable)
      .where(or(
        and(eq(communicationMessagesTable.firmId, partnerFirmId), inArray(communicationMessagesTable.subject, testSubjects)),
        and(eq(communicationMessagesTable.firmId, otherFirmId), inArray(communicationMessagesTable.subject, testSubjects)),
      ));

    const messageIds = testMessages.map((m) => m.id);
    if (messageIds.length) {
      const tasks = await db
        .select({ id: communicationCaseTasksTable.id })
        .from(communicationCaseTasksTable)
        .where(and(eq(communicationCaseTasksTable.firmId, partnerFirmId), inArray(communicationCaseTasksTable.parentMessageId, messageIds)));
      const taskIds = tasks.map((t) => t.id);

      const drafts = await db
        .select({ id: communicationDraftsTable.id })
        .from(communicationDraftsTable)
        .where(and(eq(communicationDraftsTable.firmId, partnerFirmId), inArray(communicationDraftsTable.parentMessageId, messageIds)));
      const draftIds = drafts.map((d) => d.id);

      if (draftIds.length) {
        await db.delete(communicationDraftTasksTable).where(and(eq(communicationDraftTasksTable.firmId, partnerFirmId), inArray(communicationDraftTasksTable.draftId, draftIds)));
        await db.delete(communicationAuditLogsTable).where(and(eq(communicationAuditLogsTable.firmId, partnerFirmId), inArray(communicationAuditLogsTable.draftId, draftIds)));
        await db.delete(communicationDraftsTable).where(and(eq(communicationDraftsTable.firmId, partnerFirmId), inArray(communicationDraftsTable.id, draftIds)));
      }

      if (taskIds.length) {
        await db.delete(communicationAuditLogsTable).where(and(eq(communicationAuditLogsTable.firmId, partnerFirmId), inArray(communicationAuditLogsTable.caseTaskId, taskIds)));
        await db.delete(communicationCaseTasksTable).where(and(eq(communicationCaseTasksTable.firmId, partnerFirmId), inArray(communicationCaseTasksTable.id, taskIds)));
      }

      await db.delete(communicationAuditLogsTable).where(and(eq(communicationAuditLogsTable.firmId, partnerFirmId), inArray(communicationAuditLogsTable.messageId, messageIds)));
      await db.delete(communicationMessagesTable).where(and(eq(communicationMessagesTable.firmId, partnerFirmId), inArray(communicationMessagesTable.id, messageIds)));
      await db.delete(communicationMessagesTable).where(and(eq(communicationMessagesTable.firmId, otherFirmId), inArray(communicationMessagesTable.id, messageIds)));
    }

    await db.delete(communicationMailboxesTable).where(and(eq(communicationMailboxesTable.firmId, partnerFirmId), ilike(communicationMailboxesTable.displayName, "%Manual%")));
  });
}

suite("Communication Hub MVP — Manual Email → Tasks → Draft → Sent", () => {
  it("manual email creation works and viewing writes audit only", async () => {
    const receivedAt = "2026-06-09T09:30:00.000Z";
    const res = await request(app)
      .post("/api/communication/messages/manual-email")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        fromName: "Bank Ops",
        fromEmail: "ops@bank.test",
        to: ["shared@firm.test"],
        cc: [],
        subject: "TEST-COMM-MANUAL-EMAIL",
        bodyText: "Maybank batch email sample",
        receivedAt,
        assignedToUserId: userIds[0] ?? null,
        caseId: caseIds[0] ?? null,
        isBatchEmail: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.channel).toBe("email");
    expect(res.body.provider).toBe("manual");
    expect(res.body.direction).toBe("incoming");
    expect(res.body.internalStatus).toBe("assigned");
    expect(res.body.assignedToUserId).toBe(userIds[0] ?? null);
    expect(res.body.linkedCaseId).toBe(caseIds[0] ?? null);
    expect(new Date(res.body.receivedAt).toISOString()).toBe(receivedAt);

    const messageId = res.body.id;

    const viewRes = await request(app)
      .post(`/api/communication/messages/${messageId}/view`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(viewRes.status).toBe(200);

    const auditRes = await request(app)
      .get(`/api/communication/audit/message/${messageId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(auditRes.status).toBe(200);
    expect(Array.isArray(auditRes.body)).toBe(true);
    expect(auditRes.body.some((a: any) => a.action === "communication.message.viewed")).toBe(true);
  });

  it("batch message can create tasks, draft, approve and mark sent; timeline shows linked records", async () => {
    const msgRes = await request(app)
      .post("/api/communication/messages/manual-email")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        fromName: "Bank Ops",
        fromEmail: "ops@bank.test",
        to: ["shared@firm.test"],
        cc: [],
        subject: "TEST-COMM-MANUAL-EMAIL",
        bodyText: "Batch email - second run",
        isBatchEmail: true,
      });
    expect(msgRes.status).toBe(201);
    const messageId = msgRes.body.id as number;

    const case1 = caseIds[0];
    const case2 = caseIds[1] ?? caseIds[0];

    const task1Res = await request(app)
      .post(`/api/communication/messages/${messageId}/tasks`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ linkedCaseId: case1, partyName: "Purchaser A", bankRef: "MBB-REF-001", assignedToUserId: userIds[0] });
    expect(task1Res.status).toBe(201);

    const task2Res = await request(app)
      .post(`/api/communication/messages/${messageId}/tasks`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ linkedCaseId: case2, partyName: "Purchaser B", bankRef: "MBB-REF-002", assignedToUserId: userIds[1] ?? userIds[0] });
    expect(task2Res.status).toBe(201);

    const tasksRes = await request(app)
      .get(`/api/communication/messages/${messageId}/tasks`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(tasksRes.status).toBe(200);
    expect(tasksRes.body.length).toBeGreaterThanOrEqual(2);

    const taskIds = tasksRes.body.map((t: any) => t.id).slice(0, 2);

    const noteRes = await request(app)
      .patch(`/api/communication/tasks/${taskIds[0]}/reply-note`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ replyNote: "Ready to reply - confirm redemption statement" });
    expect(noteRes.status).toBe(200);

    const readyRes = await request(app)
      .patch(`/api/communication/tasks/${taskIds[0]}/status`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ taskStatus: "ready_to_reply" });
    expect(readyRes.status).toBe(200);

    const draftRes = await request(app)
      .post("/api/communication/drafts/consolidated")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ parentMessageId: messageId, taskIds, to: ["ops@bank.test"], cc: [], bcc: [], subject: "Re: TEST-COMM-MANUAL-EMAIL" });
    expect(draftRes.status).toBe(201);
    const draftId = draftRes.body.id;

    const submitRes = await request(app)
      .post(`/api/communication/drafts/${draftId}/submit-approval`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(submitRes.status).toBe(200);

    const approveRes = await request(app)
      .post(`/api/communication/drafts/${draftId}/approve`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("approved");

    const sentRes = await request(app)
      .post(`/api/communication/drafts/${draftId}/mark-sent`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(sentRes.status).toBe(200);
    expect(sentRes.body.status).toBe("sent");

    const closedRes = await request(app)
      .get("/api/communication/messages?status=closed,fully_replied")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(closedRes.status).toBe(200);
    expect(Array.isArray(closedRes.body)).toBe(true);
    expect(closedRes.body.some((row: any) => row.message?.id === messageId)).toBe(true);

    const timelineRes = await request(app)
      .get(`/api/cases/${case1}/communication-timeline`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(timelineRes.status).toBe(200);
    expect(Array.isArray(timelineRes.body.messages)).toBe(true);
    expect(Array.isArray(timelineRes.body.tasks)).toBe(true);
    expect(timelineRes.body.tasks.some((t: any) => t.parentMessageId === messageId)).toBe(true);
  });

  it("firm isolation: message from other firm cannot be read", async () => {
    const [mailbox] = await db
      .insert(communicationMailboxesTable)
      .values({
        firmId: otherFirmId,
        channel: "email",
        provider: "manual",
        displayName: "Shared Inbox (Manual)",
        address: "shared-inbox@manual.local",
        mailboxType: "shared",
        isActive: true,
        syncEnabled: false,
      })
      .returning();

    const [msg] = await db
      .insert(communicationMessagesTable)
      .values({
        firmId: otherFirmId,
        mailboxId: mailbox.id,
        channel: "email",
        provider: "manual",
        direction: "incoming",
        fromAddress: "intruder@bank.test",
        fromName: "Intruder",
        toAddresses: ["shared@other.test"],
        ccAddresses: [],
        bccAddresses: [],
        subject: "TEST-COMM-MANUAL-EMAIL",
        bodyText: "Other firm message",
        internalStatus: "unassigned",
        isBatch: false,
      })
      .returning();

    const res = await request(app)
      .get(`/api/communication/messages/${msg.id}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(404);
  });
});
