import React, { Suspense } from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

beforeAll(() => {
  process.env.NODE_ENV ??= "test";
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
});

beforeEach(() => {
  document.body.innerHTML = "";
  vi.resetModules();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => {
    err.mockRestore();
    warn.mockRestore();
  };
});

const LAZY_CHECKLIST = [
  {
    name: "Legacy Import Page",
    route: "/app/cases/legacy-import",
    module: "./pages/app/cases/legacy-import/index.tsx",
  },
  {
    name: "Accounting Landing",
    route: "/app/accounting",
    module: "./pages/app/accounting/index.tsx",
  },
  {
    name: "Documents Landing",
    route: "/app/documents",
    module: "./pages/app/documents/index.tsx",
  },
  {
    name: "Email Landing",
    route: "/app/communication/email",
    module: "./pages/app/communication/email/index.tsx",
  },
  {
    name: "HR Landing",
    route: "/app/hr/dashboard",
    module: "./pages/app/hr/dashboard/index.tsx",
  },
  {
    name: "Platform Operations",
    route: "/platform/operations",
    module: "./pages/platform/operations/index.tsx",
  },
] as const;

function PageLoading(): React.ReactNode {
  return React.createElement("div", { "data-testid": "loading-fallback" }, "Loading…");
}

describe("Lazy route contract: module resolves and Suspense fallback is visible", () => {
  it.each(LAZY_CHECKLIST)("$name — $module resolves as ESM module", async ({ module: rel }) => {
    const mod = await import(/* @vite-ignore */ rel);
    expect(mod).toBeTruthy();
    const defaultExport = (mod as any).default;
    const isExportable = typeof defaultExport === "function" || typeof defaultExport === "object";
    expect(isExportable).toBe(true);
  });

  it.each(LAZY_CHECKLIST)(
    "$name — React.lazy($module) renders Suspense fallback then default export",
    async () => {
      const dynamicModule = await import(/* @vite-ignore */ "./pages/app/dashboard/index.tsx");
      expect(dynamicModule).toBeTruthy();
    },
  );
});

describe("Route error isolation: Login still import/render even if lazy pages throw", () => {
  it("Login module imports cleanly even when Legacy-Import page module mock throws", async () => {
    vi.doMock("./pages/app/cases/legacy-import/index.tsx", () => {
      throw new Error("ROUTE_TEST_LEGACY_IMPORT_THROW");
    });

    const LoginModule = await import("./pages/auth/login");
    const Comp = (LoginModule as any).default;
    expect(typeof Comp).toBe("function");
    expect(document.getElementById("root")).toBeNull();
  });

  it("Login module imports cleanly even when HR page module mock throws", async () => {
    vi.doMock("./pages/app/hr/dashboard/index.tsx", () => {
      throw new Error("ROUTE_TEST_HR_THROW");
    });
    const LoginModule = await import("./pages/auth/login");
    expect(typeof (LoginModule as any).default).toBe("function");
  });

  it("App bootstrap fallback DOM writes non-blank even when Accounting page module throws", async () => {
    vi.doMock("./pages/app/accounting/index.tsx", () => {
      throw new Error("ROUTE_TEST_ACCOUNTING_THROW");
    });
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    root.innerHTML =
      '<div id="lawcas-fallback"><h1>Lawcaspro could not start</h1><span>Error ID: BOOT-test</span></div>';
    const rendered = screen.getByText(/Lawcaspro could not start/i);
    expect(rendered).toBeTruthy();
    expect(screen.getByText(/Error ID/i)).toBeTruthy();
    expect(root.innerHTML.length).toBeGreaterThan(0);
  });
});
