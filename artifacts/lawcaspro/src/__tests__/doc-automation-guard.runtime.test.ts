import { describe, expect, it, beforeAll, vi } from "vitest";
import {
  getDisplayStatus,
  isProgressComplete,
  getJobTitle,
  canDownloadNow,
  extractErrorMessage,
} from "../pages/app/documents/automation-guards";
import type { NormalizedGenerationJob } from "../lib/document-generation-client";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
});

function makeSnapshot(
  partial: Partial<NormalizedGenerationJob> & { status?: string },
): NormalizedGenerationJob {
  const base: NormalizedGenerationJob = {
    jobId: "default_job_id",
    status: "pending",
    action: "download",
    successCount: 0,
    failedCount: 0,
    pendingCount: 0,
    runningCount: 0,
    totalCount: 0,
    items: [],
  };
  return { ...base, ...(partial as any) } as NormalizedGenerationJob;
}

describe("Document Automation Guard Runtime — §5 §7 §10", () => {
  it("STALE_FAILED: status=failed + pending>0 → FAILED (not GENERATING bug)", () => {
    const snapshot = makeSnapshot({
      jobId: "job_stale_failed_1",
      status: "failed",
      progress: {
        total: 3,
        success: 0,
        failed: 0,
        pending: 3,
        running: 0,
      },
      active: false,
      nextAction: "stop",
      totalCount: 3,
      successCount: 0,
      failedCount: 0,
      pendingCount: 3,
      runningCount: 0,
    });

    const status = getDisplayStatus(snapshot);
    expect(status).toBe("FAILED");
    expect(status).not.toBe("GENERATING");

    const complete = isProgressComplete(snapshot);
    expect(complete).toBe(true);
  });

  it("TERMINAL_COMPLETE: status=completed + progress done → COMPLETED (sanity, no regression)", () => {
    const snapshot = makeSnapshot({
      jobId: "job_complete_ok_2",
      status: "completed",
      progress: {
        total: 5,
        success: 5,
        failed: 0,
        pending: 0,
        running: 0,
      },
      active: false,
      nextAction: null as any,
      downloadObjectPath: "/gen/jobs/2/output.zip",
      totalCount: 5,
      successCount: 5,
      failedCount: 0,
      pendingCount: 0,
      runningCount: 0,
    });

    const status = getDisplayStatus(snapshot);
    expect(status).toBe("COMPLETED");

    const complete = isProgressComplete(snapshot);
    expect(complete).toBe(true);
  });

  it("NEXTACTION_STOP: status=generating, progress incomplete but nextAction=stop → FAILED (§7 stop signal overrides generating)", () => {
    const snapshot = makeSnapshot({
      jobId: "job_stop_signal_3",
      status: "generating",
      progress: {
        total: 10,
        success: 2,
        failed: 0,
        pending: 8,
        running: 0,
      },
      active: true,
      nextAction: "stop",
      totalCount: 10,
      successCount: 2,
      failedCount: 0,
      pendingCount: 8,
      runningCount: 0,
    });

    const status = getDisplayStatus(snapshot);
    expect(status).toBe("FAILED");
    expect(status).not.toBe("GENERATING");
  });

  it("TITLE_FAILED: failed status → title includes \"Generation stopped\" substring", () => {
    const snapshot = makeSnapshot({
      jobId: "job_title_failed_4",
      status: "failed",
      progress: {
        total: 3,
        success: 0,
        failed: 1,
        pending: 2,
        running: 0,
      },
      active: false,
      nextAction: "stop",
      errorSummary: "Template file missing",
      totalCount: 3,
      successCount: 0,
      failedCount: 1,
      pendingCount: 2,
      runningCount: 0,
    });

    const title = getJobTitle(snapshot);
    expect(typeof title).toBe("string");
    expect(title.length).toBeGreaterThan(0);
    expect(title).toContain("Generation stopped");
  });

  it("DOWNLOAD_COMPLETE: completed progress + success>0 → canDownloadNow true", () => {
    const snapshot = makeSnapshot({
      jobId: "job_download_ok_5",
      status: "completed",
      progress: {
        total: 4,
        success: 4,
        failed: 0,
        pending: 0,
        running: 0,
      },
      active: false,
      nextAction: null as any,
      downloadUrl: "https://cdn.example.com/gen/jobs/5/out.zip",
      totalCount: 4,
      successCount: 4,
      failedCount: 0,
      pendingCount: 0,
      runningCount: 0,
    });

    const dl = canDownloadNow(snapshot);
    expect(dl).toBe(true);

    const status = getDisplayStatus(snapshot);
    expect(status).toBe("COMPLETED");

    const complete = isProgressComplete(snapshot);
    expect(complete).toBe(true);

    const emptySuccessSnapshot = makeSnapshot({
      jobId: "job_no_success_5b",
      status: "completed",
      progress: {
        total: 2,
        success: 0,
        failed: 2,
        pending: 0,
        running: 0,
      },
      active: false,
      nextAction: null as any,
      totalCount: 2,
      successCount: 0,
      failedCount: 2,
      pendingCount: 0,
      runningCount: 0,
    });
    expect(canDownloadNow(emptySuccessSnapshot)).toBe(false);
  });
});
