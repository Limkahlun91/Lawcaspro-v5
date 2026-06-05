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

export function formatProcessingNotice(snapshot: NormalizedGenerationJob | null): string {
  const p = getProgress(snapshot);
  const done = p.success + p.failed;
  if (p.total > 0) {
    return `Generation is still processing. Completed ${done}/${p.total}. Pending ${p.pending}. Please wait.`;
  }
  return "Generation is still processing. Please wait.";
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

