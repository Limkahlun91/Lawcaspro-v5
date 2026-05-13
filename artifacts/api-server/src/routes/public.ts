import express, { type RequestHandler, type Router as ExpressRouter } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import {
  caseMessagesTable,
  casesTable,
  caseKeyDatesTable,
  casePurchasersTable,
  caseWorkflowStepsTable,
  clientsTable,
  db,
  firmsTable,
  projectsTable,
  usersTable,
} from "@workspace/db";
import { buildWorkflowSteps } from "../lib/workflow.js";
import { WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD } from "../lib/keyDatesWorkflow.js";
import { writeAuditLog } from "../lib/auth.js";

const router: ExpressRouter = express.Router();

function maskName(name: string): string {
  const s = name.trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s
    .split(" ")
    .map((part) => {
      const p = part.trim();
      if (!p) return "";
      if (p.length <= 2) return `${p[0]}*`;
      return `${p[0]}${"*".repeat(Math.min(3, p.length - 1))}`;
    })
    .filter(Boolean)
    .join(" ");
}

const TokenParams = z.object({ token: z.string().uuid() });
const PublicCreateMessageBody = z.object({
  messageText: z.string().trim().min(1).max(2000),
  attachments: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
});

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(typeof v === "string" ? v : "");
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function findCaseByToken(token: string): Promise<{ id: number; firmId: number } | null> {
  const [c] = await db
    .select({ id: casesTable.id, firmId: casesTable.firmId })
    .from(casesTable)
    .where(eq(casesTable.trackingToken, token))
    .limit(1);
  if (!c) return null;
  return { id: c.id, firmId: c.firmId };
}

router.get("/public/track/:token", (async (req, res) => {
  const parsed = TokenParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  const token = parsed.data.token;
  const [c] = await db
    .select({
      id: casesTable.id,
      firmId: casesTable.firmId,
      projectId: casesTable.projectId,
      parcelNo: casesTable.parcelNo,
      purchaseMode: casesTable.purchaseMode,
      titleType: casesTable.titleType,
    })
    .from(casesTable)
    .where(eq(casesTable.trackingToken, token))
    .limit(1);

  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [firm] = await db
    .select({ name: firmsTable.name })
    .from(firmsTable)
    .where(eq(firmsTable.id, c.firmId))
    .limit(1);

  const [proj] = await db
    .select({ name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, c.projectId))
    .limit(1);

  const [purchaser] = await db
    .select({ name: clientsTable.name })
    .from(casePurchasersTable)
    .innerJoin(clientsTable, eq(casePurchasersTable.clientId, clientsTable.id))
    .where(eq(casePurchasersTable.caseId, c.id))
    .orderBy(desc(casePurchasersTable.orderNo))
    .limit(1);

  const maskedPurchaserName = purchaser?.name ? maskName(String(purchaser.name)) : "";

  const steps = await db
    .select({
      stepKey: caseWorkflowStepsTable.stepKey,
      stepName: caseWorkflowStepsTable.stepName,
      stepOrder: caseWorkflowStepsTable.stepOrder,
      pathType: caseWorkflowStepsTable.pathType,
      status: caseWorkflowStepsTable.status,
      completedAt: caseWorkflowStepsTable.completedAt,
    })
    .from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, c.id))
    .orderBy(caseWorkflowStepsTable.stepOrder);

  const lastCompletedByPath = new Map<string, string>();
  for (const s of steps) {
    if (String(s.status) !== "completed") continue;
    lastCompletedByPath.set(String(s.pathType), String(s.stepName));
  }

  const [kd] = await db
    .select()
    .from(caseKeyDatesTable)
    .where(and(eq(caseKeyDatesTable.caseId, c.id), eq(caseKeyDatesTable.firmId, c.firmId)))
    .limit(1);

  const keyDates: Record<string, string | null> = {
    spa_signed_date: kd?.spaSignedDate ? String(kd.spaSignedDate) : null,
    spa_stamped_date: kd?.spaStampedDate ? String(kd.spaStampedDate) : null,
    letter_of_offer_stamped_date: kd?.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
    loan_docs_signed_date: kd?.loanDocsSignedDate ? String(kd.loanDocsSignedDate) : null,
    acting_letter_issued_date: kd?.actingLetterIssuedDate ? String(kd.actingLetterIssuedDate) : null,
    advice_to_bank_date: kd?.adviceToBankDate ? String(kd.adviceToBankDate) : null,
    loan_sent_bank_execution_date: kd?.loanSentBankExecutionDate ? String(kd.loanSentBankExecutionDate) : null,
    loan_bank_executed_date: kd?.loanBankExecutedDate ? String(kd.loanBankExecutedDate) : null,
    bank_lu_received_date: kd?.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
    noa_served_on: kd?.noaServedOn ? String(kd.noaServedOn) : null,
    register_poa_on: kd?.registerPoaOn ? String(kd.registerPoaOn) : null,
    letter_disclaimer_dated: kd?.letterDisclaimerDated ? String(kd.letterDisclaimerDated) : null,
  };

  const stepRowByKey = new Map(steps.map((s) => [String(s.stepKey), s]));
  const defs = buildWorkflowSteps(String(c.purchaseMode), String(c.titleType));

  const timeline = defs
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((d) => {
      const row = stepRowByKey.get(String(d.stepKey));
      const status = row?.status ? String(row.status) : "pending";
      const completedAt = row?.completedAt instanceof Date ? row.completedAt.toISOString().slice(0, 10) : null;
      const keyDateField = WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD[String(d.stepKey)];
      const keyDateYmd = keyDateField ? (keyDates[String(keyDateField)] ?? null) : null;
      const dateYmd = keyDateYmd ?? completedAt;
      return {
        stepKey: d.stepKey,
        stepName: d.stepName,
        stepOrder: d.stepOrder,
        pathType: d.pathType,
        status,
        dateYmd,
      };
    });

  const spaStatus = lastCompletedByPath.get("common") ?? "Pending";
  const loanStatus = String(c.purchaseMode).toLowerCase() === "loan"
    ? (lastCompletedByPath.get("loan") ?? "Pending")
    : null;

  res.set("Cache-Control", "no-store");
  res.json({
    firmName: firm?.name ?? "",
    projectName: proj?.name ?? "",
    property: c.parcelNo ? String(c.parcelNo) : null,
    purchaserName: maskedPurchaserName,
    spaStatus,
    loanStatus,
    timeline,
  });
}) as RequestHandler);

router.get("/public/track/:token/messages", (async (req, res) => {
  const parsed = TokenParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  const c = await findCaseByToken(parsed.data.token);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const rows = await db
    .select({
      id: caseMessagesTable.id,
      senderType: caseMessagesTable.senderType,
      senderId: caseMessagesTable.senderId,
      senderName: usersTable.name,
      messageText: caseMessagesTable.messageText,
      attachments: caseMessagesTable.attachments,
      createdAt: caseMessagesTable.createdAt,
    })
    .from(caseMessagesTable)
    .leftJoin(usersTable, eq(caseMessagesTable.senderId, usersTable.id))
    .where(and(
      eq(caseMessagesTable.firmId, c.firmId),
      eq(caseMessagesTable.caseId, c.id),
      inArray(caseMessagesTable.senderType, ["client", "staff"]),
    ))
    .orderBy(asc(caseMessagesTable.createdAt))
    .limit(200);

  res.set("Cache-Control", "no-store");
  res.json({
    data: rows.map((r) => ({
      id: String(r.id),
      senderType: String(r.senderType) === "staff" ? "staff" : "client",
      senderName: String(r.senderType) === "staff" ? (r.senderName ? String(r.senderName) : "Staff") : "Client",
      messageText: String(r.messageText ?? ""),
      attachments: r.attachments ?? [],
      createdAt: toIsoString(r.createdAt),
    })),
  });
}) as RequestHandler);

router.post("/public/track/:token/messages", (async (req, res) => {
  const parsed = TokenParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }
  const bodyParsed = PublicCreateMessageBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const c = await findCaseByToken(parsed.data.token);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [created] = await db
    .insert(caseMessagesTable)
    .values({
      firmId: c.firmId,
      caseId: c.id,
      senderType: "client",
      senderId: null,
      messageText: bodyParsed.data.messageText,
      attachments: bodyParsed.data.attachments ?? [],
    })
    .returning({
      id: caseMessagesTable.id,
      createdAt: caseMessagesTable.createdAt,
    });

  await writeAuditLog({
    firmId: c.firmId,
    actorId: null,
    actorType: "client",
    action: "client_portal.message.create",
    entityType: "case",
    entityId: c.id,
    detail: "client_message",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.set("Cache-Control", "no-store");
  res.status(201).json({
    id: String(created?.id ?? ""),
    createdAt: toIsoString(created?.createdAt),
  });
}) as RequestHandler);

export default router;
