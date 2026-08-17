import { randomUUID } from "node:crypto";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";

export interface HrAssetRecord {
  id: string;
  firmId: number;
  assetCode: string;
  assetName: string;
  category: string;
  serialNumber?: string | null;
  assignedToEmployeeId?: number | null;
  assignedAt?: string | null;
  returnedAt?: string | null;
  condition: string;
  location?: string | null;
  purchaseDate?: string | null;
  purchaseCost?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUserId?: number | null;
  updatedByUserId?: number | null;
  version: number;
}

const IN_MEMORY_STORE: Map<string, HrAssetRecord[]> = new Map();

function ensureFirmStore(firmId: number): HrAssetRecord[] {
  const key = String(firmId);
  if (!IN_MEMORY_STORE.has(key)) IN_MEMORY_STORE.set(key, []);
  return IN_MEMORY_STORE.get(key) as HrAssetRecord[];
}

export const MIGRATION_TODO_NOTE = Object.freeze({
  marker: "TODO_next_migration_0147_hr_assets_table",
  nextMigrationPlan: "0147_create_hr_assets_table.sql",
  note:
    "F40 HR ASSETS: HR-specific entity; NOT reusing file_custody per Decision §Boundaries. DB migration hr_assets table is NOT present today. " +
    "This service runs against an in-memory store (per-firm, per-process — NOT suitable for production multi-instance). " +
    "Next migration #0147 reserved to CREATE TABLE hr_assets + RLS + RBAC. Do NOT invent DB write in this service layer.",
});

export function listHrAssets(firmId: number): HrAssetRecord[] {
  if (!firmId) throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required");
  return ensureFirmStore(firmId).filter((a) => a.isActive);
}

export function createHrAsset(
  firmId: number,
  input: { assetCode: string; assetName: string; category: string; serialNumber?: string; condition?: string; location?: string; purchaseDate?: string; purchaseCost?: string },
  actorUserId: number,
): HrAssetRecord {
  if (!input.assetCode || !input.assetName || !input.category) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "asset code + name + category required");
  }
  const store = ensureFirmStore(firmId);
  if (store.some((a) => a.assetCode === input.assetCode)) {
    throw createHRError(HR_ERROR_CODES.HR_IDEMPOTENCY_CONFLICT, `HR asset code ${input.assetCode} already exists at firm ${firmId}`);
  }
  const now = new Date().toISOString();
  const rec: HrAssetRecord = {
    id: `${firmId}-${input.assetCode}-${randomUUID().slice(0, 8)}`,
    firmId,
    assetCode: input.assetCode,
    assetName: input.assetName,
    category: input.category,
    serialNumber: input.serialNumber ?? null,
    assignedToEmployeeId: null,
    assignedAt: null,
    returnedAt: null,
    condition: input.condition ?? "new",
    location: input.location ?? null,
    purchaseDate: input.purchaseDate ?? null,
    purchaseCost: input.purchaseCost ?? null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdByUserId: actorUserId,
    updatedByUserId: actorUserId,
    version: 1,
  };
  store.push(rec);
  return rec;
}

export function editHrAsset(firmId: number, id: string, patch: Partial<HrAssetRecord>, actorUserId: number, expectedVersion: number): HrAssetRecord {
  const store = ensureFirmStore(firmId);
  const idx = store.findIndex((a) => a.id === id);
  if (idx < 0) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `HR asset ${id} not found at firm ${firmId}`);
  const current = store[idx];
  if (current.version !== expectedVersion) {
    throw createHRError(HR_ERROR_CODES.HR_RECORD_CONFLICT, "HR asset version mismatch");
  }
  const updated: HrAssetRecord = { ...current, ...patch, updatedAt: new Date().toISOString(), updatedByUserId: actorUserId, version: current.version + 1 };
  store[idx] = updated;
  return updated;
}

export function assignHrAsset(firmId: number, id: string, employeeId: number, actorUserId: number, expectedVersion: number): HrAssetRecord {
  const store = ensureFirmStore(firmId);
  const idx = store.findIndex((a) => a.id === id);
  if (idx < 0) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `HR asset ${id} not found at firm ${firmId}`);
  const current = store[idx];
  if (current.version !== expectedVersion) throw createHRError(HR_ERROR_CODES.HR_RECORD_CONFLICT, "HR asset version mismatch");
  if (current.assignedToEmployeeId) {
    throw createHRError(HR_ERROR_CODES.HR_ASSET_NOT_RETURNED, "HR asset already assigned; return it first");
  }
  const updated: HrAssetRecord = {
    ...current,
    assignedToEmployeeId: employeeId,
    assignedAt: new Date().toISOString(),
    returnedAt: null,
    updatedAt: new Date().toISOString(),
    updatedByUserId: actorUserId,
    version: current.version + 1,
  };
  store[idx] = updated;
  return updated;
}

export function returnHrAsset(firmId: number, id: string, condition: string, actorUserId: number, expectedVersion: number): HrAssetRecord {
  const store = ensureFirmStore(firmId);
  const idx = store.findIndex((a) => a.id === id);
  if (idx < 0) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `HR asset ${id} not found at firm ${firmId}`);
  const current = store[idx];
  if (current.version !== expectedVersion) throw createHRError(HR_ERROR_CODES.HR_RECORD_CONFLICT, "HR asset version mismatch");
  const updated: HrAssetRecord = {
    ...current,
    assignedToEmployeeId: null,
    assignedAt: null,
    returnedAt: new Date().toISOString(),
    condition,
    updatedAt: new Date().toISOString(),
    updatedByUserId: actorUserId,
    version: current.version + 1,
  };
  store[idx] = updated;
  return updated;
}

export function softDeleteHrAsset(firmId: number, id: string, actorUserId: number, expectedVersion: number): HrAssetRecord {
  return editHrAsset(firmId, id, { isActive: false } as any, actorUserId, expectedVersion);
}

export const hrAssetsScaffoldService = {
  listHrAssets,
  createHrAsset,
  editHrAsset,
  assignHrAsset,
  returnHrAsset,
  softDeleteHrAsset,
  MIGRATION_TODO_NOTE,
};

export default hrAssetsScaffoldService;
