import { describe, expect, it } from "vitest";
import {
  canDownloadNow,
  extractErrorMessage,
  formatProcessingNotice,
  getProgress,
  isJobNotReadyForDownload,
  isProgressComplete,
} from "../automation-guards";
import type { NormalizedGenerationJob } from "@/lib/document-generation-client";

function job(p: { total: number; success: number; failed: number; pending: number; running: number }): NormalizedGenerationJob {
  return {
    jobId: "11111111-1111-1111-1111-111111111111",
    status: "running" as any,
    action: "download" as any,
    successCount: p.success,
    failedCount: p.failed,
    pendingCount: p.pending,
    runningCount: p.running,
    totalCount: p.total,
    progress: p,
    items: [],
    downloadUrl: null,
    downloadManifestUrl: null,
    downloadObjectPath: null,
    downloadFileName: null,
    errorSummary: null,
  } as any;
}

describe("Doc Automation guards", () => {
  it("does not allow download when pending > 0", () => {
    const s = job({ total: 15, success: 11, failed: 0, pending: 4, running: 0 });
    expect(isProgressComplete(s)).toBe(false);
    expect(canDownloadNow(s)).toBe(false);
  });

  it("allows download only when complete and success > 0", () => {
    const s = job({ total: 15, success: 15, failed: 0, pending: 0, running: 0 });
    expect(isProgressComplete(s)).toBe(true);
    expect(canDownloadNow(s)).toBe(true);
  });

  it("formats processing notice for 11/15 pending 4", () => {
    const s = job({ total: 15, success: 11, failed: 0, pending: 4, running: 0 });
    expect(formatProcessingNotice(s)).toBe(
      "Generation is still processing. Completed 11/15. Pending 4. Please wait.",
    );
  });

  it("extracts readable error message (no [object Object])", () => {
    expect(extractErrorMessage({ error: { message: "Job is not ready" } })).toBe("Job is not ready");
    expect(extractErrorMessage(new Error("Network timeout"))).toBe("Network timeout");
    const msg = extractErrorMessage({ error: { code: "X", details: { a: 1 } } });
    expect(msg).toContain("\"code\"");
    expect(msg).not.toBe("[object Object]");
  });

  it("detects JOB_NOT_READY_FOR_DOWNLOAD from 409 payload", () => {
    const err = {
      status: 409,
      data: { ok: false, error: { code: "JOB_NOT_READY_FOR_DOWNLOAD", message: "not ready" } },
    };
    expect(isJobNotReadyForDownload(err)).toBe(true);
  });

  it("getProgress uses progress field when available", () => {
    const s = job({ total: 2, success: 1, failed: 0, pending: 1, running: 0 });
    expect(getProgress(s)).toEqual({ total: 2, success: 1, failed: 0, pending: 1, running: 0 });
  });
});

