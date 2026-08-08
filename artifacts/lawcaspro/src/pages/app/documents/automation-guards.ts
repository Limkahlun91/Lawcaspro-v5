import type { NormalizedGenerationJob } from "@/lib/document-generation-client";

function safeText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export type DocAutomationProgress = {
  total: number;
  success: number;
  failed: number;
  pending: number;
  running: number;
};

export function getProgress(
  snapshot: NormalizedGenerationJob | null,
): DocAutomationProgress {
  const p = snapshot?.progress;
  if (p) return p;
  return {
    total: snapshot?.totalCount ?? 0,
    success: snapshot?.successCount ?? 0,
    failed: snapshot?.failedCount ?? 0,
    pending: snapshot?.pendingCount ?? 0,
    running: snapshot?.runningCount ?? 0,
  };
}

export function isProgressComplete(snapshot: NormalizedGenerationJob | null): boolean {
  const p = getProgress(snapshot);
  return (
    p.total > 0 &&
    p.pending === 0 &&
    p.running === 0 &&
    p.success + p.failed === p.total
  );
}

export function canDownloadNow(snapshot: NormalizedGenerationJob | null): boolean {
  const p = getProgress(snapshot);
  return isProgressComplete(snapshot) && p.success > 0;
}

export type DocGenDisplayStatus =
  | "GENERATING"
  | "COMPLETED"
  | "PARTIALLY_COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "GENERATED_DOWNLOAD_FAILED";

export function getDisplayStatus(
  snapshot: NormalizedGenerationJob | null,
): DocGenDisplayStatus {
  const st = String(snapshot?.status ?? "").toLowerCase();
  const p = getProgress(snapshot);
  const zipReady = Boolean(
    snapshot?.downloadObjectPath || snapshot?.downloadUrl || snapshot?.downloadManifestUrl,
  );
  if (!isProgressComplete(snapshot)) return "GENERATING";
  if (st === "cancelled") return "CANCELLED";
  if (p.success === 0) return "FAILED";
  if (p.failed === 0) {
    return zipReady ? "COMPLETED" : "GENERATED_DOWNLOAD_FAILED";
  }
  return zipReady ? "PARTIALLY_COMPLETED" : "GENERATED_DOWNLOAD_FAILED";
}

export function getJobTitle(snapshot: NormalizedGenerationJob | null): string {
  const d = getDisplayStatus(snapshot);
  switch (d) {
    case "GENERATING":
      return "Generating documents…";
    case "COMPLETED":
      return "Generation completed";
    case "PARTIALLY_COMPLETED":
      return "Partially completed";
    case "FAILED":
      return "Generation failed";
    case "CANCELLED":
      return "Generation cancelled";
    case "GENERATED_DOWNLOAD_FAILED":
      return "Documents generated, package not ready";
  }
}

export function getJobSummary(snapshot: NormalizedGenerationJob | null): string {
  const p = getProgress(snapshot);
  const d = getDisplayStatus(snapshot);
  if (d === "COMPLETED") return `${p.total} documents generated`;
  if (d === "PARTIALLY_COMPLETED") return `${p.success} succeeded, ${p.failed} failed`;
  if (d === "FAILED") return `${p.failed} failed (0 succeeded)`;
  if (d === "GENERATED_DOWNLOAD_FAILED") return `${p.success} succeeded, package failed`;
  if (d === "CANCELLED") return `${p.success + p.failed} of ${p.total} before cancellation`;
  const processed = p.success + p.failed;
  return `Processed ${processed} / ${p.total}`;
}

export function formatProcessingNotice(snapshot: NormalizedGenerationJob | null): string {
  const p = getProgress(snapshot);
  const done = p.success + p.failed;
  if (p.total > 0) {
    return `Generation is still processing. Processed ${done}/${p.total}. Pending ${p.pending}. Please wait.`;
  }
  return "Generation is still processing. Please wait.";
}

export function canRetryDownload(snapshot: NormalizedGenerationJob | null): boolean {
  const d = getDisplayStatus(snapshot);
  return d === "GENERATED_DOWNLOAD_FAILED";
}

export function canRetryFailedItems(snapshot: NormalizedGenerationJob | null): boolean {
  const d = getDisplayStatus(snapshot);
  const p = getProgress(snapshot);
  return (d === "PARTIALLY_COMPLETED" || d === "FAILED") && p.failed > 0;
}

export function canDownloadSuccessfulFiles(snapshot: NormalizedGenerationJob | null): boolean {
  const d = getDisplayStatus(snapshot);
  const p = getProgress(snapshot);
  return (d === "PARTIALLY_COMPLETED" || d === "COMPLETED") && p.success > 0;
}

export function canClearJob(snapshot: NormalizedGenerationJob | null): boolean {
  const d = getDisplayStatus(snapshot);
  return d !== "GENERATING";
}

export function extractErrorMessage(err: unknown): string {
  const r = asRecord(err);
  const nested =
    (r ? (asRecord((r as any).error) ?? asRecord((r as any).data)?.error) : null) ??
    null;
  const nestedMsg = nested ? safeText((nested as any).message) : "";
  if (nestedMsg) return nestedMsg;
  if (err instanceof Error && safeText(err.message)) return err.message;
  const nestedStr = nested ? JSON.stringify(nested) : "";
  if (nestedStr && nestedStr !== "{}") return nestedStr;
  const str = r ? JSON.stringify(r) : String(err ?? "");
  if (str && str !== "{}" && str !== "[object Object]") return str;
  return "Unknown error";
}

export function isJobNotReadyForDownload(err: unknown): boolean {
  const r = asRecord(err);
  const status =
    r && typeof (r as any).status === "number" ? Number((r as any).status) : null;
  if (status !== 409) return false;
  const data = asRecord((r as any).data);
  const e = asRecord(data?.error) ?? asRecord((r as any).error);
  const code = e ? safeText((e as any).code) : "";
  return code === "JOB_NOT_READY_FOR_DOWNLOAD";
}

