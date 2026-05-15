import express, { type Router as ExpressRouter } from "express";
import { and, asc, count, countDistinct, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  caseAssignmentsTable,
  caseBillingEntriesTable,
  caseCommunicationsTable,
  caseWorkflowStepsTable,
  casesTable,
  db,
  permissionsTable,
  rolesTable,
  usersTable,
  sql,
  type RlsDb,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbConn = typeof db | RlsDb;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

async function hasRolePermission(
  r: DbConn,
  firmId: number,
  roleId: number | null | undefined,
  module: string,
  action: string,
): Promise<boolean> {
  if (!roleId) return false;
  const [role] = await r
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)))
    .limit(1);
  if (!role) return false;
  const [perm] = await r
    .select({ allowed: permissionsTable.allowed })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, roleId),
      eq(permissionsTable.module, module),
      eq(permissionsTable.action, action),
    ))
    .limit(1);
  return Boolean(perm?.allowed);
}

async function getRoleName(r: DbConn, firmId: number, roleId: number | null | undefined): Promise<string> {
  if (!roleId) return "";
  const [row] = await r
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)))
    .limit(1);
  return typeof row?.name === "string" ? row.name : "";
}

async function canBypassCaseAssignment(r: DbConn, firmId: number, roleId: number | null | undefined): Promise<boolean> {
  const canAssignAny = await hasRolePermission(r, firmId, roleId, "cases", "assign_any");
  if (canAssignAny) return true;
  const roleName = await getRoleName(r, firmId, roleId);
  const rn = roleName.toLowerCase();
  return rn.includes("partner") || rn.includes("manager");
}

router.get("/reports/overview", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const r = rdb(req);
    const elevated = await canBypassCaseAssignment(r, firmId, req.roleId);
    const canSeeAccounting = await hasRolePermission(r, firmId, req.roleId, "accounting", "read");

    const monthExpr = sql<string>`TO_CHAR(${casesTable.createdAt}, 'YYYY-MM')`;
    const completedStepsExpr = sql<number>`SUM(CASE WHEN ${caseWorkflowStepsTable.status} = 'completed' THEN 1 ELSE 0 END)`;

    const assignedCaseIds = elevated
      ? undefined
      : (await r
          .select({ caseId: caseAssignmentsTable.caseId })
          .from(caseAssignmentsTable)
          .where(and(
            eq(caseAssignmentsTable.userId, userId),
            isNull(caseAssignmentsTable.unassignedAt),
          ))
          .groupBy(caseAssignmentsTable.caseId))
          .map((row) => row.caseId);

    const casesWhere = elevated
      ? eq(casesTable.firmId, firmId)
      : assignedCaseIds && assignedCaseIds.length > 0
        ? and(eq(casesTable.firmId, firmId), inArray(casesTable.id, assignedCaseIds))
        : and(eq(casesTable.firmId, firmId), eq(casesTable.id, -1));

    const billingCaseWhere = assignedCaseIds
      ? assignedCaseIds.length > 0
        ? inArray(caseBillingEntriesTable.caseId, assignedCaseIds)
        : eq(caseBillingEntriesTable.caseId, -1)
      : undefined;

    const commsCaseWhere = assignedCaseIds
      ? assignedCaseIds.length > 0
        ? inArray(caseCommunicationsTable.caseId, assignedCaseIds)
        : eq(caseCommunicationsTable.caseId, -1)
      : undefined;

    const casesByStatus = await (async () => {
      const countExpr = count();
      return await r
        .select({ status: casesTable.status, count: countExpr })
        .from(casesTable)
        .where(casesWhere)
        .groupBy(casesTable.status)
        .orderBy(desc(countExpr));
    })();

    const casesByType = await (async () => {
      const countExpr = count();
      return await r
        .select({ purchase_mode: casesTable.purchaseMode, title_type: casesTable.titleType, count: countExpr })
        .from(casesTable)
        .where(casesWhere)
        .groupBy(casesTable.purchaseMode, casesTable.titleType)
        .orderBy(desc(countExpr));
    })();

    const casesByMonth = await (async () => {
      const countExpr = count();
      return await r
        .select({ month: monthExpr, count: countExpr })
        .from(casesTable)
        .where(casesWhere)
        .groupBy(monthExpr)
        .orderBy(asc(monthExpr))
        .limit(12);
    })();

    const workflowCompletion = await (async () => {
      const base = r
        .select({
          case_id: casesTable.id,
          reference_no: casesTable.referenceNo,
          total_steps: count(),
          completed_steps: completedStepsExpr,
        })
        .from(casesTable)
        .innerJoin(caseWorkflowStepsTable, eq(caseWorkflowStepsTable.caseId, casesTable.id))
        .where(casesWhere)
        .groupBy(casesTable.id, casesTable.referenceNo);
      const rows = await base;
      const sorted = rows
        .map((row) => ({
          ...row,
          total_steps: Number(row.total_steps ?? 0),
          completed_steps: Number(row.completed_steps ?? 0),
        }))
        .sort((a, b) => {
          const ar = a.total_steps > 0 ? a.completed_steps / a.total_steps : 0;
          const br = b.total_steps > 0 ? b.completed_steps / b.total_steps : 0;
          return ar - br;
        })
        .slice(0, 10);
      return sorted;
    })();

    const lawyerWorkload = await (async () => {
      if (!elevated) {
        const [me] = await r
          .select({ name: usersTable.name, user_id: usersTable.id })
          .from(usersTable)
          .where(and(eq(usersTable.id, userId), eq(usersTable.firmId, firmId)))
          .limit(1);
        return me ? [{ ...me, case_count: assignedCaseIds?.length ?? 0 }] : [];
      }
      const caseCountExpr = countDistinct(caseAssignmentsTable.caseId);
      return await r
        .select({
          name: usersTable.name,
          user_id: usersTable.id,
          case_count: caseCountExpr,
        })
        .from(caseAssignmentsTable)
        .innerJoin(usersTable, eq(caseAssignmentsTable.userId, usersTable.id))
        .where(and(
          isNull(caseAssignmentsTable.unassignedAt),
          eq(usersTable.firmId, firmId),
        ))
        .groupBy(usersTable.id, usersTable.name)
        .orderBy(desc(caseCountExpr));
    })();

    const billingTotals = await (async () => {
      if (!canSeeAccounting) {
        return { total_billed: 0, total_paid: 0, total_outstanding: 0, billed_cases: 0 };
      }
      const totalBilledExpr = sql<number>`SUM(${caseBillingEntriesTable.amount} * ${caseBillingEntriesTable.quantity})`;
      const totalPaidExpr = sql<number>`SUM(CASE WHEN ${caseBillingEntriesTable.isPaid} THEN ${caseBillingEntriesTable.amount} * ${caseBillingEntriesTable.quantity} ELSE 0 END)`;
      const totalOutstandingExpr = sql<number>`SUM(CASE WHEN NOT ${caseBillingEntriesTable.isPaid} THEN ${caseBillingEntriesTable.amount} * ${caseBillingEntriesTable.quantity} ELSE 0 END)`;
      const base = r
        .select({
          total_billed: totalBilledExpr,
          total_paid: totalPaidExpr,
          total_outstanding: totalOutstandingExpr,
          billed_cases: countDistinct(caseBillingEntriesTable.caseId),
        })
        .from(caseBillingEntriesTable)
        .where(and(
          eq(caseBillingEntriesTable.firmId, firmId),
          ...(billingCaseWhere ? [billingCaseWhere] : []),
        ));
      const [row] = await base;
      return {
        total_billed: Number(row?.total_billed ?? 0),
        total_paid: Number(row?.total_paid ?? 0),
        total_outstanding: Number(row?.total_outstanding ?? 0),
        billed_cases: Number(row?.billed_cases ?? 0),
      };
    })();

    const communicationStats = await (async () => {
      const countExpr = count();
      const base = r
        .select({
          type: caseCommunicationsTable.type,
          direction: caseCommunicationsTable.direction,
          count: countExpr,
        })
        .from(caseCommunicationsTable)
        .where(and(
          eq(caseCommunicationsTable.firmId, firmId),
          ...(commsCaseWhere ? [commsCaseWhere] : []),
        ))
        .groupBy(caseCommunicationsTable.type, caseCommunicationsTable.direction)
        .orderBy(desc(countExpr));
      return await base;
    })();

    res.json({
      casesByStatus,
      casesByType,
      casesByMonth,
      workflowCompletion,
      lawyerWorkload,
      billingTotals,
      communicationStats,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
