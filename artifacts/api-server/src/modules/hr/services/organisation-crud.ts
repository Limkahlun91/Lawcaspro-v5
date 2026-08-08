import { db, hrDepartmentsTable, hrPositionsTable, hrBranchesTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { checkOptimisticLock, nextVersion } from "../permissions/hr-authorization.js";

export interface CrudResult<T> {
  item: T;
  version: number;
}

export async function listDepartments(firmId: number, includeInactive = false) {
  if (!firmId) throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required");
  const q = db.select().from(hrDepartmentsTable).where(eq(hrDepartmentsTable.firmId, firmId));
  const rows = await q;
  return includeInactive ? rows : rows.filter((r) => Boolean(r.isActive));
}

export async function createDepartment(firmId: number, input: {
  departmentCode: string; departmentName: string; branchId?: number; description?: string; headEmployeeId?: number;
}, actorUserId: number) {
  if (!input.departmentCode || !input.departmentName) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "department code + name required");
  }
  const rows = await db
    .insert(hrDepartmentsTable)
    .values({
      firmId,
      departmentCode: input.departmentCode,
      departmentName: input.departmentName,
      branchId: input.branchId ?? null,
      description: input.description ?? null,
      headEmployeeId: input.headEmployeeId ?? null,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    })
    .returning();
  return rows[0];
}

export async function editDepartment(firmId: number, id: number, patch: Partial<{
  departmentName: string; branchId: number | null; description: string | null; headEmployeeId: number | null; isActive: boolean;
}>, actorUserId: number, expectedVersion: number) {
  const current = (
    await db.select().from(hrDepartmentsTable).where(
      and(eq(hrDepartmentsTable.firmId, firmId), eq(hrDepartmentsTable.id, id)),
    ).limit(1)
  )[0];
  if (!current) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "department not found");
  checkOptimisticLock(current, expectedVersion, `Department #${id}`);
  const newVersion = nextVersion(current.version);
  const updated = await db
    .update(hrDepartmentsTable)
    .set({ ...patch, updatedByUserId: actorUserId, version: newVersion })
    .where(and(eq(hrDepartmentsTable.firmId, firmId), eq(hrDepartmentsTable.id, id)))
    .returning();
  return updated[0];
}

export async function softDeleteDepartment(firmId: number, id: number, actorUserId: number, expectedVersion: number) {
  return editDepartment(firmId, id, { isActive: false }, actorUserId, expectedVersion);
}

export async function listPositions(firmId: number, includeInactive = false) {
  if (!firmId) throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required");
  const rows = await db.select().from(hrPositionsTable).where(eq(hrPositionsTable.firmId, firmId));
  return includeInactive ? rows : rows.filter((r) => Boolean(r.isActive));
}

export async function createPosition(firmId: number, input: {
  positionCode: string; positionName: string; departmentId?: number | null; description?: string | null; positionLevel?: string | null; payGrade?: string | null; reportsToPositionId?: number | null;
}, actorUserId: number) {
  if (!input.positionCode || !input.positionName) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "position code + name required");
  }
  const rows = await db
    .insert(hrPositionsTable)
    .values({
      firmId,
      positionCode: input.positionCode,
      positionName: input.positionName,
      departmentId: input.departmentId ?? null,
      description: input.description ?? null,
      positionLevel: input.positionLevel ?? null,
      payGrade: input.payGrade ?? null,
      reportsToPositionId: input.reportsToPositionId ?? null,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    })
    .returning();
  return rows[0];
}

export async function editPosition(firmId: number, id: number, patch: any, actorUserId: number, expectedVersion: number) {
  const current = (await db.select().from(hrPositionsTable).where(
    and(eq(hrPositionsTable.firmId, firmId), eq(hrPositionsTable.id, id)),
  ).limit(1))[0];
  if (!current) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "position not found");
  checkOptimisticLock(current, expectedVersion, `Position #${id}`);
  const updated = await db
    .update(hrPositionsTable)
    .set({ ...patch, updatedByUserId: actorUserId, version: nextVersion(current.version) })
    .where(and(eq(hrPositionsTable.firmId, firmId), eq(hrPositionsTable.id, id)))
    .returning();
  return updated[0];
}

export async function softDeletePosition(firmId: number, id: number, actorUserId: number, expectedVersion: number) {
  return editPosition(firmId, id, { isActive: false }, actorUserId, expectedVersion);
}

export const hrOrganisationCrudService = {
  listDepartments, createDepartment, editDepartment, softDeleteDepartment,
  listPositions, createPosition, editPosition, softDeletePosition,
};
export default hrOrganisationCrudService;
