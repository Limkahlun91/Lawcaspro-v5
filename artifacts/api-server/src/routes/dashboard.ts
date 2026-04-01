import { Router, type IRouter } from "express";
import { eq, count, desc } from "drizzle-orm";
import { db, casesTable, clientsTable, developersTable, projectsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

router.get("/dashboard", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const firmId = req.firmId!;

  const [totalCasesRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.firmId, firmId));
  const [completedCasesRes] = await db.select({ c: count() }).from(casesTable)
    .where(eq(casesTable.firmId, firmId));
  const [totalClientsRes] = await db.select({ c: count() }).from(clientsTable).where(eq(clientsTable.firmId, firmId));
  const [totalDevsRes] = await db.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, firmId));
  const [totalProjsRes] = await db.select({ c: count() }).from(projectsTable).where(eq(projectsTable.firmId, firmId));

  const allCases = await db.select().from(casesTable).where(eq(casesTable.firmId, firmId));
  const cashCases = allCases.filter(c => c.purchaseMode === "cash").length;
  const loanCases = allCases.filter(c => c.purchaseMode === "loan").length;
  const masterTitleCases = allCases.filter(c => c.titleType === "master").length;
  const individualTitleCases = allCases.filter(c => c.titleType === "individual").length;
  const strataTitleCases = allCases.filter(c => c.titleType === "strata").length;
  const completedCases = allCases.filter(c => c.status.toLowerCase().includes("complet") || c.status.toLowerCase().includes("registered") || c.status.toLowerCase().includes("stamp")).length;
  const activeCases = allCases.length - completedCases;

  const recentRows = await db.select().from(casesTable)
    .where(eq(casesTable.firmId, firmId))
    .orderBy(desc(casesTable.updatedAt))
    .limit(5);

  const recentCases = await Promise.all(
    recentRows.map(async (c) => {
      const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
      const [dev] = await db.select().from(developersTable).where(eq(developersTable.id, c.developerId));
      return {
        id: c.id,
        referenceNo: c.referenceNo,
        projectName: proj?.name ?? "Unknown",
        developerName: dev?.name ?? "Unknown",
        purchaseMode: c.purchaseMode,
        titleType: c.titleType,
        status: c.status,
        assignedLawyerName: null,
        createdAt: c.createdAt.toISOString(),
      };
    })
  );

  res.json({
    totalCases: Number(totalCasesRes?.c ?? 0),
    activeCases,
    completedCases,
    totalClients: Number(totalClientsRes?.c ?? 0),
    totalDevelopers: Number(totalDevsRes?.c ?? 0),
    totalProjects: Number(totalProjsRes?.c ?? 0),
    cashCases,
    loanCases,
    masterTitleCases,
    individualTitleCases,
    strataTitleCases,
    recentCases,
  });
});

export default router;
