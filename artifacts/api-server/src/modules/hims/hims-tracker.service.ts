import { ApiError } from "../../lib/api-response.js";

type HimsConnectionStatus = "active" | "inactive" | "error" | "pending";

interface HimsConnectionConfig {
  apiEndpoint?: string | null;
  authMode?: string | null;
  clientKeyRef?: string | null;
}

interface HimsConnection {
  connectionId: number;
  firmId: number;
  connectionName: string;
  status: HimsConnectionStatus;
  mode: "tracker_only";
  config: HimsConnectionConfig;
  lastHealthCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GetHimsConnectionsInput {
  firmId: number;
  statusFilter?: HimsConnectionStatus | null;
}

interface GetHimsConnectionsResult {
  mode: "tracker_only";
  connections: HimsConnection[];
}

interface CreateHimsConnectionInput {
  firmId: number;
  actorUserId: number;
  connectionName: string;
  config: HimsConnectionConfig;
}

interface CreateHimsConnectionResult {
  mode: "tracker_only";
  connection: HimsConnection;
}

interface PatchHimsConnectionInput {
  firmId: number;
  connectionId: number;
  actorUserId: number;
  connectionName?: string | null;
  status?: HimsConnectionStatus | null;
  config?: HimsConnectionConfig | null;
}

interface PatchHimsConnectionResult {
  mode: "tracker_only";
  connection: HimsConnection;
}

interface GetHimsCaseStatusInput {
  firmId: number;
  caseId: number;
  connectionId?: number | null;
}

interface HimsCaseStatusEntry {
  fieldKey: string;
  himsValue: unknown | null;
  lawcasproValue: unknown | null;
  matchStatus: "match" | "mismatch" | "missing_in_hims" | "missing_in_lawcaspro";
  lastSyncedAt: Date | null;
}

interface GetHimsCaseStatusResult {
  mode: "tracker_only";
  caseId: number;
  firmId: number;
  himsReferenceNo: string | null;
  overallStatus: "synced" | "mismatch_detected" | "not_connected" | "sync_pending";
  statusEntries: HimsCaseStatusEntry[];
  lastCheckedAt: Date | null;
}

interface CheckHimsCaseInput {
  firmId: number;
  caseId: number;
  actorUserId: number;
  connectionId?: number | null;
  forceRefresh?: boolean;
}

interface CheckHimsCaseResult {
  mode: "tracker_only";
  caseId: number;
  checkId: number;
  himsReferenceNo: string | null;
  overallStatus: "synced" | "mismatch_detected" | "not_connected" | "sync_pending";
  newMismatches: number;
  resolvedMismatches: number;
  checkedAt: Date;
}

interface GetHimsCaseComparisonsInput {
  firmId: number;
  caseId: number;
  comparisonBatchId?: string | null;
  limit?: number;
  offset?: number;
}

interface HimsCaseComparison {
  comparisonId: number;
  comparisonBatchId: string;
  fieldKey: string;
  sourceSystem: string;
  targetSystem: string;
  sourceValue: unknown | null;
  targetValue: unknown | null;
  matchStatus: "match" | "mismatch" | "missing_in_source" | "missing_in_target" | "error";
  comparedAt: Date;
}

interface GetHimsCaseComparisonsResult {
  mode: "tracker_only";
  caseId: number;
  total: number;
  comparisons: HimsCaseComparison[];
}

interface CompareHimsCaseInput {
  firmId: number;
  caseId: number;
  actorUserId: number;
  connectionId?: number | null;
  comparisonBatchId?: string | null;
  himsRecordOverride?: Record<string, unknown> | null;
}

interface CompareHimsCaseResult {
  mode: "tracker_only";
  comparisonBatchId: string;
  caseId: number;
  totalFields: number;
  matchedCount: number;
  mismatchedCount: number;
  missingInSourceCount: number;
  missingInTargetCount: number;
  comparisons: HimsCaseComparison[];
  comparedAt: Date;
}

function buildStubConnection(firmId: number, connectionId: number, name: string): HimsConnection {
  const now = new Date();
  return {
    connectionId,
    firmId,
    connectionName: name,
    status: "inactive",
    mode: "tracker_only",
    config: {},
    lastHealthCheckAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getHimsConnections(
  input: GetHimsConnectionsInput,
  opts: { tx?: unknown } = {},
): Promise<GetHimsConnectionsResult> {
  return {
    mode: "tracker_only",
    connections: [],
  };
}

export async function createHimsConnection(
  input: CreateHimsConnectionInput,
  opts: { tx?: unknown } = {},
): Promise<CreateHimsConnectionResult> {
  const anyInput = input as any;
  if (
    input.config?.authMode === "full_write" ||
    anyInput.config?.mode === "full_write" ||
    anyInput.mode === "full_write"
  ) {
    throw new ApiError({
      status: 403,
      code: "HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY",
      message: "HIMS mode is restricted to tracker_only; full_write not permitted via this endpoint.",
      retryable: false,
    });
  }
  if (input.connectionName && !String(input.connectionName).trim()) {
    throw new ApiError({
      status: 400,
      code: "HIMS_CONNECTION_NAME_REQUIRED",
      message: "connectionName is required",
      retryable: false,
    });
  }
  return {
    mode: "tracker_only",
    connection: buildStubConnection(input.firmId, 1, input.connectionName),
  };
}

export async function patchHimsConnection(
  input: PatchHimsConnectionInput,
  opts: { tx?: unknown } = {},
): Promise<PatchHimsConnectionResult> {
  return {
    mode: "tracker_only",
    connection: buildStubConnection(input.firmId, input.connectionId, input.connectionName ?? `hims-conn-${input.connectionId}`),
  };
}

export async function getHimsCaseStatus(
  input: GetHimsCaseStatusInput,
  opts: { tx?: unknown } = {},
): Promise<GetHimsCaseStatusResult> {
  return {
    mode: "tracker_only",
    caseId: input.caseId,
    firmId: input.firmId,
    himsReferenceNo: null,
    overallStatus: "not_connected",
    statusEntries: [],
    lastCheckedAt: null,
  };
}

export async function checkHimsCase(
  input: CheckHimsCaseInput,
  opts: { tx?: unknown } = {},
): Promise<CheckHimsCaseResult> {
  return {
    mode: "tracker_only",
    caseId: input.caseId,
    checkId: 1,
    himsReferenceNo: null,
    overallStatus: "not_connected",
    newMismatches: 0,
    resolvedMismatches: 0,
    checkedAt: new Date(),
  };
}

export async function getHimsCaseComparisons(
  input: GetHimsCaseComparisonsInput,
  opts: { tx?: unknown } = {},
): Promise<GetHimsCaseComparisonsResult> {
  return {
    mode: "tracker_only",
    caseId: input.caseId,
    total: 0,
    comparisons: [],
  };
}

export async function compareHimsCase(
  input: CompareHimsCaseInput,
  opts: { tx?: unknown } = {},
): Promise<CompareHimsCaseResult> {
  const batchId = input.comparisonBatchId ?? `HIMS_COMPARE:${input.caseId}:${Date.now()}`;
  return {
    mode: "tracker_only",
    comparisonBatchId: batchId,
    caseId: input.caseId,
    totalFields: 0,
    matchedCount: 0,
    mismatchedCount: 0,
    missingInSourceCount: 0,
    missingInTargetCount: 0,
    comparisons: [],
    comparedAt: new Date(),
  };
}
