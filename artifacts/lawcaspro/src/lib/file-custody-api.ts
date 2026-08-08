import { apiFetchJson } from "@/lib/api-client";

export const FILE_CUSTODY_QUERY_KEYS = {
  all: ["file-custody"] as const,
  list: (params: Record<string, unknown>) => ["file-custody", "list", params] as const,
  detail: (id: number) => ["file-custody", "detail", id] as const,
  partners: ["file-custody", "partners"] as const,
  summary: ["file-custody", "summary"] as const,
};

export type FileCustodyStatus =
  | "in_office"
  | "out_on_loan"
  | "out_with_counsel"
  | "out_with_client"
  | "out_external"
  | "return_pending"
  | "returned"
  | "archived"
  | "lost";

export type FileCustodyCategory =
  | "court_document"
  | "spa"
  | "loan_agreement"
  | "land_title"
  | "caveat"
  | "identity_document"
  | "invoice"
  | "payment_voucher"
  | "quotation"
  | "firm_letter"
  | "correspondence"
  | "bundle"
  | "file_will"
  | "other";

export type MovementKind =
  | "release"
  | "acknowledge"
  | "return_request"
  | "return"
  | "receive_return"
  | "overdue_auto_flag"
  | "archived"
  | "reinstated";

export type FileCustodyItem = {
  id: number;
  firmId?: number;
  caseId?: number | null;
  projectId?: number | null;
  matterLabel: string;
  fileReferenceNo: string;
  fileTitle: string;
  fileDescription?: string | null;
  physicalOrDigital: "physical" | "digital" | "hybrid";
  category: FileCustodyCategory;
  storageLocation?: string | null;
  tags?: string | null;
  currentHolderUserId?: number | null;
  currentHolderName?: string | null;
  currentHolderContact?: string | null;
  currentHolderFirmExternal?: string | null;
  holderName?: string | null;
  acknowledgedAt?: string | null;
  acknowledgeDueAt?: string | null;
  expectedReturnAt?: string | null;
  lastMovementId?: number | null;
  lifecycleStatus: FileCustodyStatus;
  isArchived: boolean;
  archivedAt?: string | null;
  archivedByUserId?: number | null;
  meta?: Record<string, unknown> | null;
  createdByUserId?: number | null;
  createdAt: string;
  updatedAt: string;
  version?: number;
  isReturnOverdue?: boolean;
  isAcknowledgementOverdue?: boolean;
  returnHoursLeft?: number | null;
  overdueSeverity?: "normal" | "high" | "urgent" | "critical";
};

export type FileCustodyMovement = {
  id: number;
  movementKind: MovementKind;
  fromHolderUserId?: number | null;
  fromHolderName?: string | null;
  fromHolderContact?: string | null;
  fromHolderFirmExternal?: string | null;
  toHolderUserId?: number | null;
  toHolderName?: string | null;
  toHolderContact?: string | null;
  toHolderFirmExternal?: string | null;
  expectedReturnAt?: string | null;
  acknowledgeDueAt?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedByUserId?: number | null;
  acknowledgedNote?: string | null;
  returnedAt?: string | null;
  returnedByUserId?: number | null;
  returnedCondition?: "good" | "damaged" | "partial" | "missing_pages" | null;
  returnedNote?: string | null;
  severity?: "info" | "normal" | "high" | "urgent" | "critical" | null;
  movementNote?: string | null;
  escalatedAt?: string | null;
  escalatedToPartner?: boolean | null;
  createdByUserId?: number | null;
  createdAt: string;
  meta?: Record<string, unknown> | null;
};

export type FileCustodyListResponse = {
  total: number;
  offset: number;
  limit: number;
  items: FileCustodyItem[];
};

export type FileCustodyDetailResponse = {
  item: FileCustodyItem;
  movements: FileCustodyMovement[];
};

export type FileCustodySummaryResponse = {
  total: number;
  out: number;
  overdueReturn: number;
  unacknowledgedOverdue: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
};

export type ListFileCustodyParams = {
  lifecycle_status?: FileCustodyStatus;
  only_out?: boolean;
  only_overdue?: boolean;
  only_unacknowledged?: boolean;
  category?: FileCustodyCategory;
  current_holder_user_id?: number;
  case_id?: number;
  q?: string;
  offset?: number;
  limit?: number;
};

export type ReleaseCustodyPayload = {
  custodyItemId: number;
  toHolderUserId?: number;
  toHolderName?: string;
  toHolderContact?: string;
  toHolderFirmExternal?: string;
  expectedReturnAt?: string;
  acknowledgeDueAt?: string;
  severity?: "info" | "normal" | "high" | "urgent" | "critical";
  movementNote?: string;
};

export type AcknowledgeCustodyPayload = {
  movementId: number;
  acknowledgedNote?: string;
  condition?: "good" | "damaged" | "partial" | "missing_pages";
};

export type RequestReturnCustodyPayload = {
  custodyItemId: number;
  note?: string;
  requestedReturnByUserId?: number;
  requestedReturnAt?: string;
};

export type ReturnCustodyPayload = {
  movementId: number;
  returnedNote?: string;
  returnedCondition?: "good" | "damaged" | "partial" | "missing_pages";
};

export type ReceiveReturnCustodyPayload = {
  movementId: number;
  returnedNote?: string;
  returnedCondition?: "good" | "damaged" | "partial" | "missing_pages";
};

export type EscalateCustodyPayload = {
  movementId: number;
  targetPartnerUserId?: string;
  note?: string;
};

export type CreateFileCustodyPayload = {
  caseId?: number;
  projectId?: number;
  matterLabel?: string;
  fileReferenceNo: string;
  fileTitle: string;
  fileDescription?: string;
  physicalOrDigital?: "physical" | "digital" | "hybrid";
  category?: FileCustodyCategory;
  storageLocation?: string;
  tags?: string;
  expectedReturnAt?: string;
  acknowledgeDueAt?: string;
  currentHolderUserId?: number;
  currentHolderName?: string;
  currentHolderContact?: string;
  currentHolderFirmExternal?: string;
  meta?: Record<string, unknown>;
};

export type PatchFileCustodyPayload = {
  matterLabel?: string;
  fileTitle?: string;
  fileDescription?: string;
  physicalOrDigital?: "physical" | "digital" | "hybrid";
  category?: FileCustodyCategory;
  storageLocation?: string;
  tags?: string;
  lifecycleStatus?: FileCustodyStatus;
  isArchived?: boolean;
  archivedByUserId?: number;
  meta?: Record<string, unknown>;
};

export type PartnerUser = {
  id: number;
  name: string;
  email: string;
  roleName: string;
};

export type FirmUser = {
  id: number;
  name: string;
  email: string;
  roleName?: string;
};

export function isVersionConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string; data?: { error?: string } };
  if (e.status === 409) {
    const dataErr = String(e.data?.error ?? "");
    if (
      dataErr === "version_conflict" ||
      dataErr === "stale_state" ||
      dataErr === "STALE_STATE"
    ) {
      return true;
    }
    if (e.code === "version_conflict" || e.code === "stale_state") return true;
  }
  return false;
}

function buildQs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "boolean") sp.set(k, v ? "1" : "0");
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export async function listFileCustodyItems(
  params: ListFileCustodyParams = {},
): Promise<FileCustodyListResponse> {
  return await apiFetchJson<FileCustodyListResponse>(
    `/api/file-custody/items${buildQs(params as Record<string, unknown>)}`,
  );
}

export async function getFileCustodyItem(id: number): Promise<FileCustodyDetailResponse> {
  return await apiFetchJson<FileCustodyDetailResponse>(`/api/file-custody/items/${id}`);
}

export async function createFileCustodyItem(
  payload: CreateFileCustodyPayload,
): Promise<{ ok: boolean; id: number; lifecycleStatus: FileCustodyStatus }> {
  return await apiFetchJson<{ ok: boolean; id: number; lifecycleStatus: FileCustodyStatus }>(
    `/api/file-custody/items`,
    { method: "POST", body: payload as unknown as BodyInit },
  );
}

export async function patchFileCustodyItem(
  id: number,
  payload: PatchFileCustodyPayload,
): Promise<{ ok: boolean; id: number; version?: number }> {
  return await apiFetchJson<{ ok: boolean; id: number; version?: number }>(
    `/api/file-custody/items/${id}`,
    { method: "PATCH", body: payload as unknown as BodyInit },
  );
}

export async function releaseCustody(
  payload: ReleaseCustodyPayload,
): Promise<{ ok: boolean; movementId: number; custodyItemId: number }> {
  return await apiFetchJson<{ ok: boolean; movementId: number; custodyItemId: number }>(
    `/api/file-custody/movements/release`,
    { method: "POST", body: payload as unknown as BodyInit },
  );
}

export async function acknowledgeCustody(
  payload: AcknowledgeCustodyPayload,
): Promise<{
  ok: boolean;
  movementId: number;
  acknowledgeMovementId: number;
  acknowledgedAt: string;
  version?: number;
}> {
  return await apiFetchJson<{
    ok: boolean;
    movementId: number;
    acknowledgeMovementId: number;
    acknowledgedAt: string;
    version?: number;
  }>(`/api/file-custody/movements/acknowledge`, { method: "POST", body: payload as unknown as BodyInit });
}

export async function requestReturnCustody(
  payload: RequestReturnCustodyPayload,
): Promise<{
  ok: boolean;
  returnRequestMovementId: number;
  custodyItemId: number;
  returnBy: string;
  version?: number;
}> {
  return await apiFetchJson<{
    ok: boolean;
    returnRequestMovementId: number;
    custodyItemId: number;
    returnBy: string;
    version?: number;
  }>(`/api/file-custody/movements/return_request`, { method: "POST", body: payload as unknown as BodyInit });
}

export async function returnCustody(
  payload: ReturnCustodyPayload,
): Promise<{
  ok: boolean;
  movementId: number;
  custodyItemId: number;
  returnMovementId: number;
  returnedAt: string;
}> {
  return await apiFetchJson<{
    ok: boolean;
    movementId: number;
    custodyItemId: number;
    returnMovementId: number;
    returnedAt: string;
  }>(`/api/file-custody/movements/return`, { method: "POST", body: payload as unknown as BodyInit });
}

export async function receiveReturnCustody(
  payload: ReceiveReturnCustodyPayload,
): Promise<{
  ok: boolean;
  movementId: number;
  receiveReturnMovementId: number;
  custodyItemId: number;
  returnedAt: string;
}> {
  return await apiFetchJson<{
    ok: boolean;
    movementId: number;
    receiveReturnMovementId: number;
    custodyItemId: number;
    returnedAt: string;
  }>(`/api/file-custody/movements/receive_return`, { method: "POST", body: payload as unknown as BodyInit });
}

export async function escalateCustody(
  payload: EscalateCustodyPayload,
): Promise<{
  ok: boolean;
  movementId: number;
  escalateMovementId: number;
  allPartners: boolean;
  targetPartnerUserId: number | null;
  escalatedAt: string;
}> {
  return await apiFetchJson<{
    ok: boolean;
    movementId: number;
    escalateMovementId: number;
    allPartners: boolean;
    targetPartnerUserId: number | null;
    escalatedAt: string;
  }>(`/api/file-custody/movements/${payload.movementId}/escalate`, {
    method: "POST",
    body: { targetPartnerUserId: payload.targetPartnerUserId, note: payload.note } as unknown as BodyInit,
  });
}

export async function listFileCustodyPartners(): Promise<{ partners: PartnerUser[] }> {
  return await apiFetchJson<{ partners: PartnerUser[] }>(`/api/file-custody/partners`);
}

export async function getFileCustodySummary(): Promise<FileCustodySummaryResponse> {
  return await apiFetchJson<FileCustodySummaryResponse>(`/api/file-custody/items/summary`);
}

export async function listFirmUsers(): Promise<{ users: FirmUser[] }> {
  return await apiFetchJson<{ users: FirmUser[] }>(`/api/users?status=active&limit=200`);
}
