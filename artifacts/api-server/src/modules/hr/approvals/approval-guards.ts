import { db, usersTable, rolesTable, hrApprovalDelegationsTable } from "@workspace/db";
import { and, eq, sql, isNull } from "drizzle-orm";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";

export interface ApprovalDefinitionInput {
  firmId: number;
  processCode?: string;
  defaultFinalApproverUserId: number | null;
  [key: string]: unknown;
}

export async function verifyFinalApproverIsActivePartner(
  firmId: number,
  targetUserId: number | null | undefined,
): Promise<void> {
  if (!firmId || !Number.isFinite(firmId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required for approval guard");
  }
  if (targetUserId === null || targetUserId === undefined) {
    return;
  }
  if (!Number.isFinite(targetUserId)) {
    throw createHRError(
      HR_ERROR_CODES.HR_INVALID_FINAL_APPROVER_PARTNER as any,
      "default_final_approver_user_id must be a valid user id",
    );
  }
  const rows = await db
    .select({ roleId: rolesTable.id })
    .from(usersTable)
    .innerJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
    .where(
      and(
        eq(rolesTable.firmId, firmId),
        eq(usersTable.id, targetUserId),
        eq(rolesTable.name, "Partner"),
      ),
    )
    .limit(1);
  if (!rows || rows.length === 0) {
    throw createHRError(
      HR_ERROR_CODES.HR_INVALID_FINAL_APPROVER_PARTNER as any,
      `User #${targetUserId} is not an active Partner (role=Partner at firm #${firmId}). Cannot set as final approver.`,
      { details: { firmId, targetUserId } },
    );
  }
}

export interface DelegationCreateInput {
  firmId: number;
  delegatorUserId: number;
  delegateUserId: number;
  validFrom: string | Date;
  validTo?: string | Date | null;
}

export async function assertNoCycles(
  firmId: number,
  delegatorUserId: number,
  delegateUserId: number,
): Promise<void> {
  if (!firmId || !Number.isFinite(firmId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required for delegation guard");
  }
  if (!delegatorUserId || !delegateUserId) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "delegator and delegate user ids required");
  }
  if (String(delegatorUserId) === String(delegateUserId)) {
    throw createHRError(
      HR_ERROR_CODES.HR_DELEGATION_CYCLE_DETECTED as any,
      "Self-delegation forbidden: delegator and delegate must be different users.",
      { details: { firmId, delegatorUserId, delegateUserId } },
    );
  }
  const today = new Date();
  const active = await db
    .select({
      delegator: hrApprovalDelegationsTable.delegatorUserId,
      delegate: hrApprovalDelegationsTable.delegateUserId,
    })
    .from(hrApprovalDelegationsTable)
    .where(
      and(
        eq(hrApprovalDelegationsTable.firmId, firmId),
        eq(hrApprovalDelegationsTable.delegationStatus, "active"),
      ),
    );
  const reverseExists = active.some(
    (row) =>
      String(row.delegator) === String(delegateUserId) &&
      String(row.delegate) === String(delegatorUserId),
  );
  if (reverseExists) {
    throw createHRError(
      HR_ERROR_CODES.HR_DELEGATION_CYCLE_DETECTED as any,
      "2-cycle delegation forbidden: reverse delegation already active.",
      { details: { firmId, delegatorUserId, delegateUserId } },
    );
  }
  const graph: Map<string, string[]> = new Map();
  for (const row of active) {
    const from = String(row.delegator);
    const to = String(row.delegate);
    const arr = graph.get(from) ?? [];
    arr.push(to);
    graph.set(from, arr);
  }
  const pending = graph.get(String(delegatorUserId)) ?? [];
  const incomingEdges = [...pending];
  graph.set(String(delegatorUserId), [...pending, String(delegateUserId)]);
  const visited = new Set<string>();
  const queue: string[] = [String(delegateUserId)];
  visited.add(String(delegateUserId));
  while (queue.length > 0) {
    const head = queue.shift() as string;
    if (head === String(delegatorUserId)) {
      throw createHRError(
        HR_ERROR_CODES.HR_DELEGATION_CYCLE_DETECTED as any,
        `N-cycle delegation detected via BFS over active rows at firm #${firmId}. Adding delegator→delegate would close a chain back to the delegator.`,
        { details: { firmId, delegatorUserId, delegateUserId } },
      );
    }
    const next = graph.get(head) ?? [];
    for (const n of next) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  logger.info({ firmId, delegatorUserId, delegateUserId }, "[delegation] cycle check passed");
  void incomingEdges;
}

export const hrApprovalGuardService = {
  verifyFinalApproverIsActivePartner,
  assertNoCycles,
};

export default hrApprovalGuardService;
