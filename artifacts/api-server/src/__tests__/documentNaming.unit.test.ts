import { describe, it, expect } from "vitest";
import { buildGeneratedDownloadFileName } from "../lib/documentNaming";

describe("document naming", () => {
  it("builds stable, sanitized file name", () => {
    const fn = buildGeneratedDownloadFileName({
      referenceNo: "REF123",
      templateCode: "SPA",
      purchaserName: "Buyer Name/<>",
      projectName: "Project Name",
      extension: "docx",
      now: new Date("2026-04-14T10:11:12Z"),
    });
    expect(fn).toMatch(/^REF123_SPA_Buyer_Name_Project_Name_20260414_/);
    expect(fn.endsWith(".docx")).toBe(true);
  });
});

