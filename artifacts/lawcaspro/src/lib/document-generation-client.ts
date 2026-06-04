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
  templateSource?: "firm" | "master" | string;
  templateId?: number;
  platformDocumentId?: number;
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
  runningCount?: number;
  totalCount: number;
  progress?: { total: number; success: number; failed: number; pending: number; running: number };
  nextAction?: "run_next" | "finalize" | "download" | "stop";
  downloadUrl?: string | null;
  downloadObjectPath?: string | null;
  downloadFileName?: string | null;
  errorSummary?: string | null;
  items: NormalizedGenerationJobItem[];
};

export type CreateGenerationJobPayload = {
  caseIds: number[];
  templateIds?: number[];
  templates?: Array<{ source: "firm" | "master"; id: number }>;
  config: {
    action: "download" | "print";
    outputFormat?: "pdf" | "docx";
    includeDiagnostics?: boolean;
    copies?: number | string;
    duplexSettings?: unknown;
  };
  blind?: boolean;
  force?: boolean;
};

const GENERATION_TIMEOUT_MS = 180000;
const CREATE_JOB_TIMEOUT_MS = 60000;

export async function createGenerationJob(payload: CreateGenerationJobPayload): Promise<{ jobId?: string; statusUrl?: string; downloadUrl?: string; status?: string; fallback?: boolean; message?: string }> {
  const qs = new URLSearchParams();
  if (payload.blind) qs.set("blind", "true");
  if (payload.force) qs.set("force", "true");
  const res = await apiFetchJson<unknown>(`/documents/automation/generate-job?${qs.toString()}`, {
    method: "POST",
    timeoutMs: CREATE_JOB_TIMEOUT_MS,
    body: JSON.stringify({ caseIds: payload.caseIds, templateIds: payload.templateIds, templates: payload.templates, config: payload.config }),
  });
  const r = asRecord(res) ?? {};
  const jobId = asString(r.jobId ?? r.job_id) ?? undefined;
  const downloadUrl = asString(r.downloadUrl ?? r.download_url) ?? undefined;
  const status = asString(r.status) ?? undefined;
  const fallback = typeof r.fallback === "boolean" ? r.fallback : undefined;
  const message = asString(r.message) ?? undefined;
  if (!jobId && !downloadUrl) throw new Error("jobId/downloadUrl is missing");
  return {
    ...(jobId ? { jobId } : {}),
    statusUrl: asString(r.statusUrl ?? r.status_url) ?? undefined,
    downloadUrl,
    status,
    fallback,
    message,
  };
}

export async function validateGenerationJob(payload: Omit<CreateGenerationJobPayload, "config"> & { config: CreateGenerationJobPayload["config"] }): Promise<unknown> {
  const qs = new URLSearchParams();
  qs.set("validate", "true");
  if (payload.blind) qs.set("blind", "true");
  if (payload.force) qs.set("force", "true");
  return await apiFetchJson<unknown>(`/documents/automation/generate-job?${qs.toString()}`, {
    method: "POST",
    timeoutMs: CREATE_JOB_TIMEOUT_MS,
    body: JSON.stringify({ caseIds: payload.caseIds, templateIds: payload.templateIds, templates: payload.templates, config: payload.config }),
  });
}

export async function getGenerationJob(
  jobId: string,
  opts?: { signal?: AbortSignal },
): Promise<NormalizedGenerationJob> {
  const raw = await apiFetchJson<unknown>(`/documents/jobs/${jobId}`, {
    timeoutMs: GENERATION_TIMEOUT_MS,
    signal: opts?.signal,
  });
  return normalizeGenerationJob(raw);
}

export async function runNextGenerationJob(
  jobId: string,
  opts?: { signal?: AbortSignal },
): Promise<NormalizedGenerationJob> {
  const raw = await apiFetchJson<unknown>(`/documents/jobs/${jobId}/run-next`, {
    method: "POST",
    timeoutMs: GENERATION_TIMEOUT_MS,
    signal: opts?.signal,
  });
  return normalizeGenerationJob(raw);
}

export async function finalizeGenerationJob(
  jobId: string,
  opts?: { signal?: AbortSignal },
): Promise<NormalizedGenerationJob> {
  const raw = await apiFetchJson<unknown>(`/documents/jobs/${jobId}/finalize`, {
    method: "POST",
    timeoutMs: GENERATION_TIMEOUT_MS,
    signal: opts?.signal,
  });
  return normalizeGenerationJob(raw);
}

export async function getGenerationJobStatus(
  jobId: string,
  opts?: { signal?: AbortSignal },
): Promise<NormalizedGenerationJob> {
  try {
    return await getGenerationJob(jobId, opts);
  } catch {
    const raw = await apiFetchJson<unknown>(`/documents/status/${jobId}`, {
      timeoutMs: GENERATION_TIMEOUT_MS,
      signal: opts?.signal,
    });
    return normalizeGenerationJob(raw);
  }
}

export async function downloadGenerationJob(
  jobId: string,
  opts?: { signal?: AbortSignal },
): Promise<Response> {
  return await apiRequest(`/documents/jobs/${jobId}/download`, {
    timeoutMs: 180000,
    signal: opts?.signal,
  });
}

export function normalizeGenerationJobItem(raw: unknown): NormalizedGenerationJobItem {
  const r = asRecord(raw) ?? {};
  const diagnostic = asRecord(r.diagnostic) ?? undefined;
  return {
    id: asNumber(r.id) ?? undefined,
    jobId: asString(r.jobId ?? r.job_id) ?? undefined,
    caseId: asNumber(r.caseId ?? r.case_id) ?? undefined,
    templateSource: asString((r as any).templateSource ?? (r as any).template_source) ?? undefined,
    templateId: asNumber(r.templateId ?? r.template_id) ?? undefined,
    platformDocumentId: asNumber((r as any).platformDocumentId ?? (r as any).platform_document_id) ?? undefined,
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

  const progressRaw = asRecord((root as any).progress) ?? null;
  const progress = progressRaw
    ? {
        total: toInt(progressRaw.total),
        success: toInt(progressRaw.success),
        failed: toInt(progressRaw.failed),
        pending: toInt(progressRaw.pending),
        running: toInt(progressRaw.running),
      }
    : undefined;

  const nextActionRaw = asString((root as any).nextAction ?? (root as any).next_action);
  const nextAction =
    nextActionRaw === "download" ||
    nextActionRaw === "run_next" ||
    nextActionRaw === "finalize" ||
    nextActionRaw === "stop"
      ? (nextActionRaw as "run_next" | "finalize" | "download" | "stop")
      : undefined;

  const downloadUrl =
    asString((root as any).downloadUrl ?? (root as any).download_url ?? (jobRaw as any).downloadUrl) ?? null;

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

  const successCount = progress ? progress.success : toInt(jobRaw.successCount ?? jobRaw.success_count);
  const failedCount = progress ? progress.failed : toInt(jobRaw.failedCount ?? jobRaw.failed_count);
  const pendingCount = progress ? progress.pending : toInt(jobRaw.pendingCount ?? jobRaw.pending_count);
  const totalCount = progress ? progress.total : toInt(jobRaw.totalCount ?? jobRaw.total_count);
  const runningCount = progress ? progress.running : undefined;

  return {
    jobId,
    status,
    action: (asString(jobRaw.action) ?? "download") as DocumentGenerationJobAction,
    successCount,
    failedCount,
    pendingCount,
    totalCount,
    runningCount,
    progress,
    nextAction,
    downloadUrl,
    downloadObjectPath,
    downloadFileName,
    errorSummary,
    items,
  };
}
