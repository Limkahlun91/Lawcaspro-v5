import { apiFetchJson, apiRequest } from "@/lib/api-client";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

export type DocumentGenerationJobStatus = "pending" | "running" | "completed" | "failed" | string;
export type DocumentGenerationJobAction = "download" | "print" | string;

export type NormalizedGenerationJobItem = {
  id?: number;
  jobId?: string;
  caseId?: number;
  templateId?: number;
  templateName?: string | null;
  status: string;
  objectPath?: string | null;
  fileName?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  diagnostic?: Record<string, unknown>;
};

export type NormalizedGenerationJob = {
  jobId: string;
  status: DocumentGenerationJobStatus;
  action: DocumentGenerationJobAction;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  totalCount: number;
  downloadObjectPath?: string | null;
  downloadFileName?: string | null;
  errorSummary?: string | null;
  items: NormalizedGenerationJobItem[];
};

export type CreateGenerationJobPayload = {
  caseIds: number[];
  templateIds: number[];
  config: {
    action: "download" | "print";
    copies?: number | string;
    duplexSettings?: unknown;
  };
  blind?: boolean;
  force?: boolean;
  validate?: boolean;
};

export async function createGenerationJob(payload: CreateGenerationJobPayload): Promise<{ jobId: string; statusUrl?: string; downloadUrl?: string }> {
  const qs = new URLSearchParams();
  if (payload.blind) qs.set("blind", "true");
  if (payload.force) qs.set("force", "true");
  if (payload.validate) qs.set("validate", "true");
  const res = await apiFetchJson<unknown>(`/documents/automation/generate-job?${qs.toString()}`, {
    method: "POST",
    timeoutMs: 60000,
    body: JSON.stringify({ caseIds: payload.caseIds, templateIds: payload.templateIds, config: payload.config }),
  });
  const r = asRecord(res) ?? {};
  const jobId = asString(r.jobId ?? r.job_id) ?? "";
  if (!jobId) throw new Error("jobId is missing");
  return {
    jobId,
    statusUrl: asString(r.statusUrl ?? r.status_url) ?? undefined,
    downloadUrl: asString(r.downloadUrl ?? r.download_url) ?? undefined,
  };
}

export async function getGenerationJob(jobId: string): Promise<NormalizedGenerationJob> {
  const raw = await apiFetchJson<unknown>(`/documents/jobs/${jobId}`, { timeoutMs: 15000 });
  return normalizeGenerationJob(raw);
}

export async function getGenerationJobStatus(jobId: string): Promise<NormalizedGenerationJob> {
  try {
    return await getGenerationJob(jobId);
  } catch {
    const raw = await apiFetchJson<unknown>(`/documents/status/${jobId}`, { timeoutMs: 15000 });
    return normalizeGenerationJob(raw);
  }
}

export async function downloadGenerationJob(jobId: string): Promise<Response> {
  return await apiRequest(`/documents/jobs/${jobId}/download`, { timeoutMs: 60000 });
}

export function normalizeGenerationJobItem(raw: unknown): NormalizedGenerationJobItem {
  const r = asRecord(raw) ?? {};
  const diagnostic = asRecord(r.diagnostic) ?? undefined;
  return {
    id: asNumber(r.id) ?? undefined,
    jobId: asString(r.jobId ?? r.job_id) ?? undefined,
    caseId: asNumber(r.caseId ?? r.case_id) ?? undefined,
    templateId: asNumber(r.templateId ?? r.template_id) ?? undefined,
    templateName: asString((r as any).templateName ?? (r as any).template_name) ?? null,
    status: asString(r.status) ?? "",
    objectPath: asString(r.objectPath ?? r.object_path) ?? null,
    fileName: asString(r.fileName ?? r.file_name) ?? null,
    errorCode: asString(r.errorCode ?? r.error_code) ?? null,
    errorMessage: asString(r.errorMessage ?? r.error_message) ?? null,
    diagnostic,
  };
}

export function normalizeGenerationJob(raw: unknown): NormalizedGenerationJob {
  const root = asRecord(raw) ?? {};
  const jobRaw = asRecord(root.job) ?? root;
  const itemsRaw = Array.isArray(root.items) ? root.items : Array.isArray((jobRaw as any).items) ? ((jobRaw as any).items as unknown[]) : [];

  const jobId =
    asString(jobRaw.jobId ?? jobRaw.job_id) ??
    asString(jobRaw.id) ??
    asString(root.jobId ?? root.job_id) ??
    "";
  if (!jobId) throw new Error("jobId is missing");

  const status =
    (asString(jobRaw.status) ??
      asString(root.status) ??
      asString(root.state) ??
      "pending") as DocumentGenerationJobStatus;

  const downloadObjectPath = asString(jobRaw.downloadObjectPath ?? jobRaw.download_object_path) ?? null;
  const downloadFileName =
    asString(jobRaw.downloadFileName ?? jobRaw.download_file_name) ??
    asString((root as any).fileName) ??
    asString((root as any).downloadFileName) ??
    null;

  const errorSummary =
    asString(jobRaw.errorSummary ?? jobRaw.error_summary) ??
    asString((root as any).error) ??
    null;

  const items = itemsRaw.map(normalizeGenerationJobItem);

  return {
    jobId,
    status,
    action: (asString(jobRaw.action) ?? "download") as DocumentGenerationJobAction,
    successCount: toInt(jobRaw.successCount ?? jobRaw.success_count),
    failedCount: toInt(jobRaw.failedCount ?? jobRaw.failed_count),
    pendingCount: toInt(jobRaw.pendingCount ?? jobRaw.pending_count),
    totalCount: toInt(jobRaw.totalCount ?? jobRaw.total_count),
    downloadObjectPath,
    downloadFileName,
    errorSummary,
    items,
  };
}
