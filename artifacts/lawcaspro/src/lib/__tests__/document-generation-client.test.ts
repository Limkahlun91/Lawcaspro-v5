import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetchJson: vi.fn(),
  apiRequest: vi.fn(),
}));

import { normalizeGenerationJob } from "@/lib/document-generation-client";

describe("normalizeGenerationJob", () => {
  it("handles snake_case job/items", () => {
    const raw = {
      job: {
        id: "11111111-1111-1111-1111-111111111111",
        status: "failed",
        action: "download",
        success_count: 0,
        failed_count: 1,
        pending_count: 0,
        total_count: 1,
        download_object_path: null,
        download_file_name: "out.zip",
        error_summary: "No output generated",
      },
      items: [
        {
          id: 1,
          job_id: "11111111-1111-1111-1111-111111111111",
          case_id: 10,
          template_id: 20,
          status: "failed",
          error_code: "TEMPLATE_OBJECT_PATH_MISSING",
          error_message: "Template object path is missing",
          diagnostic: { missingRequiredVariables: ["spa_purchaser1_name"] },
        },
      ],
    };
    const out = normalizeGenerationJob(raw);
    expect(out.jobId).toBe("11111111-1111-1111-1111-111111111111");
    expect(out.failedCount).toBe(1);
    expect(out.downloadFileName).toBe("out.zip");
    expect(out.items[0]?.templateId).toBe(20);
    expect(out.items[0]?.errorCode).toBe("TEMPLATE_OBJECT_PATH_MISSING");
  });

  it("handles camelCase job/items", () => {
    const raw = {
      job: {
        jobId: "22222222-2222-2222-2222-222222222222",
        status: "completed",
        action: "download",
        successCount: 1,
        failedCount: 0,
        pendingCount: 0,
        totalCount: 1,
        downloadObjectPath: "/objects/x.zip",
        downloadFileName: "x.zip",
      },
      items: [
        { id: 2, jobId: "22222222-2222-2222-2222-222222222222", caseId: 10, templateId: 21, status: "success", objectPath: "/objects/a.pdf" },
      ],
    };
    const out = normalizeGenerationJob(raw);
    expect(out.jobId).toBe("22222222-2222-2222-2222-222222222222");
    expect(out.downloadObjectPath).toBe("/objects/x.zip");
    expect(out.items[0]?.objectPath).toBe("/objects/a.pdf");
  });

  it("preserves TEMPLATE_FILE_MISSING and template_name", () => {
    const raw = {
      job: {
        id: "33333333-3333-3333-3333-333333333333",
        status: "failed",
        action: "download",
        success_count: 0,
        failed_count: 1,
        pending_count: 0,
        total_count: 1,
        error_summary: "Generation failed",
      },
      items: [
        {
          id: 3,
          job_id: "33333333-3333-3333-3333-333333333333",
          case_id: 11,
          template_id: 22,
          template_name: "Acting Letter",
          status: "failed",
          error_code: "TEMPLATE_FILE_MISSING",
          error_message: "Template file missing",
        },
      ],
    };
    const out = normalizeGenerationJob(raw);
    expect(out.items[0]?.errorCode).toBe("TEMPLATE_FILE_MISSING");
    expect(out.items[0]?.templateName).toBe("Acting Letter");
  });
});
