import "@testing-library/jest-dom/vitest";

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

describe("Lawcaspro bootstrap fallback (runtime import)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("location", {
      ...window.location,
      reload: vi.fn(),
    });
    document.body.innerHTML = `<div id="root"></div>`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Lawcaspro could not start when App module evaluation throws before React mount", async () => {
    vi.doMock(
      "./App.tsx",
      () => {
        throw new Error("BOOT_TEST_FAILURE");
      },
    );

    await import("./main");

    await vi.waitFor(
      () => {
        const root = document.getElementById("root");
        expect(root?.textContent).toContain("Lawcaspro could not start");
        expect(root?.textContent).toContain("Error ID");
        expect(root?.innerHTML.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
  });
});
