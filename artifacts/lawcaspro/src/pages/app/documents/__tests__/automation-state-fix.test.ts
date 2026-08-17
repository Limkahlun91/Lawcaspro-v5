import { describe, expect, it } from "vitest";
import {
  getDisplayStatus,
  isProgressComplete,
  getJobTitle,
} from "../automation-guards";
import type { NormalizedGenerationJob } from "@/lib/document-generation-client";

function makeSnapshot(overrides: Partial<NormalizedGenerationJob> & {
  nextAction?: "run_next" | "finalize" | "download" | "stop" | "wait" | "continue" | "failed";
  active?: boolean;
}): NormalizedGenerationJob {
  return {
    jobId: "test-job-001",
    status: "running" as any,
    action: "download" as any,
    successCount: 0,
    failedCount: 0,
    pendingCount: 0,
    runningCount: 0,
    totalCount: 0,
    items: [],
    ...overrides,
  } as NormalizedGenerationJob;
}

describe("automation-state-fix (LINE66 §5 §7 bug fixes)", () => {
  it("getDisplayStatus status='failed' progress t=3,s=0,f=0,p=3,r=0 → returns FAILED (not GENERATING, §5 bug fix)", () => {
    const snapshot = makeSnapshot({
      status: "failed" as any,
      totalCount: 3,
      successCount: 0,
      failedCount: 0,
      pendingCount: 3,
      runningCount: 0,
      progress: { total: 3, success: 0, failed: 0, pending: 3, running: 0 },
    });
    const result = getDisplayStatus(snapshot);
    expect(result).toBe("FAILED");
    expect(result).not.toBe("GENERATING");
  });

  it("isProgressComplete status='failed' but pending=3 → returns true (terminal is complete)", () => {
    const snapshot = makeSnapshot({
      status: "failed" as any,
      totalCount: 3,
      successCount: 0,
      failedCount: 0,
      pendingCount: 3,
      runningCount: 0,
      progress: { total: 3, success: 0, failed: 0, pending: 3, running: 0 },
    });
    const result = isProgressComplete(snapshot);
    expect(result).toBe(true);
  });

  it("getDisplayStatus nextAction='stop' regardless of progress math → FAILED (§7 stale job stop signal)", () => {
    const snapshot = makeSnapshot({
      status: "generating" as any,
      totalCount: 3,
      successCount: 1,
      failedCount: 0,
      pendingCount: 2,
      runningCount: 0,
      progress: { total: 3, success: 1, failed: 0, pending: 2, running: 0 },
      nextAction: "stop",
    });
    const result = getDisplayStatus(snapshot);
    expect(result).toBe("FAILED");
  });

  it("getJobTitle FAILED status → 'Generation stopped' (not 'Generating documents…')", () => {
    const snapshot = makeSnapshot({
      status: "failed" as any,
      totalCount: 3,
      successCount: 0,
      failedCount: 0,
      pendingCount: 3,
      runningCount: 0,
      progress: { total: 3, success: 0, failed: 0, pending: 3, running: 0 },
      nextAction: "stop",
      active: false,
    });
    const title = getJobTitle(snapshot);
    expect(title).toContain("stopped");
    expect(title).not.toContain("Generating documents");
  });

  it("getDisplayStatus status='completed' progress all done 3/3 → COMPLETED (unchanged behavior)", () => {
    const snapshot = makeSnapshot({
      status: "completed" as any,
      totalCount: 3,
      successCount: 3,
      failedCount: 0,
      pendingCount: 0,
      runningCount: 0,
      progress: { total: 3, success: 3, failed: 0, pending: 0, running: 0 },
      downloadObjectPath: "/out/test-job.zip",
      downloadUrl: "/objects/download/test-job.zip",
    });
    const result = getDisplayStatus(snapshot);
    expect(result).toBe("COMPLETED");
  });
});
