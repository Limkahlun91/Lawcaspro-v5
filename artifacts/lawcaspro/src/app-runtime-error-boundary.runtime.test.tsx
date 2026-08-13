import "@testing-library/jest-dom/vitest";

import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRuntimeErrorBoundary } from "./components/app-runtime-error-boundary";

(globalThis as any).React = React;

function Boom(): React.ReactNode {
  throw new Error("RENDER_TEST_FAILURE");
}

describe("AppRuntimeErrorBoundary runtime render fallback", () => {
  beforeEach(() => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return () => {
      err.mockRestore();
      warn.mockRestore();
    };
  });

  it("renders non-blank React fallback with Lawcaspro could not load this page", () => {
    render(
      <AppRuntimeErrorBoundary>
        <Boom />
      </AppRuntimeErrorBoundary>,
    );

    expect(screen.getByText("Lawcaspro could not load this page")).toBeTruthy();
    expect(screen.getByText(/Error ID/i)).toBeTruthy();
    const rootText = screen.getByText("Lawcaspro could not load this page").closest("div");
    expect(rootText?.innerHTML?.length).toBeGreaterThan(0);
  });
});
