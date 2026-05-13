import express, { type RequestHandler, type Router as ExpressRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  casesTable,
  caseKeyDatesTable,
  casePurchasersTable,
  caseWorkflowStepsTable,
  clientsTable,
  db,
  firmsTable,
  projectsTable,
} from "@workspace/db";
import { buildWorkflowSteps } from "../lib/workflow.js";
import { WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD } from "../lib/keyDatesWorkflow.js";

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

export default router;
