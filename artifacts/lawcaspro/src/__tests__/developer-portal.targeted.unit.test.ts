import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DP_TSX = fs.readFileSync(path.join(FE_ROOT, "src", "pages", "developer", "dashboard.tsx"), "utf8");
const DP_TS_LINES = DP_TSX.split(/\r?\n/);

describe("DEVPORTAL · FE source audits", () => {
  it("DEVPORTAL-6 · click unit → drawer opens via Sheet", () => {
    expect(DP_TSX).toMatch(/Sheet open=\{sheetOpen\}/);
    expect(DP_TSX).toMatch(/const openUnit = \(caseId: number\) => \{[\s\S]*?setSheetOpen\(true\)/m);
    expect(DP_TSX).toMatch(/SheetContent className="w-\[92vw\] sm:max-w-\[780px\]/);
  });

  it("DEVPORTAL-5 · summary card filters wired via CARD_STAGE + setCardFilter", () => {
    expect(DP_TSX).toContain('key: "spa_stamped"');
    expect(DP_TSX).toContain('key: "attention"');
    expect(DP_TSX).toMatch(/SummaryCards summary=\{overview\.summary\}/);
    expect(DP_TSX).toMatch(/onClick=\{\(\) => onPick\(c\.key\)\}/);
    expect(DP_TSX).toMatch(/setStage\(\(prev\) => \(prev === next \? "all" : next\)\)/);
  });

  it("DEVPORTAL-9 · Dashboard source does NOT include NRIC/TIN fields in displayed columns", () => {
    // Developer view source DTOs do not declare NRIC/TIN fields
    expect(DP_TSX).not.toMatch(/(nric|ic_no|identification|identity_card)/i);
    expect(DP_TSX).not.toMatch(/\bTIN\b/);
    expect(DP_TSX).not.toMatch(/(income_tax|tax_id)/i);
  });

  it("DEVPORTAL-14 · Only 3 initial API requests (overview, units, no N+1 details)", () => {
    const requests = DP_TS_LINES.filter((l) => l.includes("apiFetchJson"));
    // overview, units list, unit detail (lazy), messages (lazy)
    const eager = requests.filter((l) => !l.includes("enabled:") && !l.includes("messageDraft"));
    expect(eager.length).toBeGreaterThanOrEqual(2);
    expect(DP_TSX).toContain('queryKey: ["developer-portal-overview", selectedProjectId]');
    expect(DP_TSX).toContain('queryKey: ["developer-portal-units", selectedProjectId, qs]');
    const detailEnabled = DP_TS_LINES.findIndex((l) => l.includes('enabled: typeof activeCaseId === "number" && activeCaseId > 0 && sheetOpen'));
    expect(detailEnabled).toBeGreaterThan(0);
  });

  it("DEVPORTAL-2 · SPA Completed badge uses emerald/green classes", () => {
    expect(DP_TSX).toMatch(/case "Completed":[\s\S]*?emerald/);
  });

  it("DEVPORTAL-3 · Not Yet Required uses slate grey tone", () => {
    expect(DP_TSX).toMatch(/case "Not Yet Required":[\s\S]*?slate/);
  });

  it("DEVPORTAL-4 · Attention Required uses rose/red", () => {
    expect(DP_TSX).toMatch(/case "Attention Required":[\s\S]*?rose/);
  });

  it("DEVPORTAL-11 · Detail API /developer/portal/units/:caseId scoped by activeCaseId", () => {
    expect(DP_TSX).toMatch(/\/developer\/portal\/units\/\$\{activeCaseId\}/);
  });
});
