export type JobErrorItemLite = {
  status?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export function isHeartbeatStale(lastHeartbeatAt: unknown, thresholdMs: number, nowMs: number = Date.now()): boolean {
  if (!lastHeartbeatAt) return false;
  const t =
    lastHeartbeatAt instanceof Date
      ? lastHeartbeatAt.getTime()
      : typeof lastHeartbeatAt === "string"
        ? Date.parse(lastHeartbeatAt)
        : NaN;
  if (!Number.isFinite(t)) return false;
  return nowMs - t > thresholdMs;
}

export function aggregateGenerationJobFailureSummary(args: {
  successCount: number;
  failedItems: JobErrorItemLite[];
}): { errorSummary: string; errorCode: string } {
  const failed = args.failedItems
    .filter((it) => String(it.status ?? "") === "failed")
    .map((it) => {
      const code = String(it.errorCode ?? "").trim();
      const msg = String(it.errorMessage ?? "").trim();
      if (code && msg) return `${code}: ${msg}`;
      return msg || code;
    })
    .filter(Boolean);

  if (args.successCount === 0 && failed.length === 0) {
    return {
      errorCode: "NO_OUTPUT_GENERATED",
      errorSummary: "No output generated: all job items ended without object_path. Check item diagnostics.",
    };
  }

  if (failed.length === 0) {
    return { errorCode: "GENERATION_FAILED", errorSummary: "Generation failed" };
  }

  const summary = `${failed.slice(0, 3).join(" | ")}${failed.length > 3 ? ` (+${failed.length - 3} more)` : ""}`;
  return { errorCode: "GENERATION_FAILED", errorSummary: summary };
}

