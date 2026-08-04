import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseMultiSelect, type SelectedCase } from "./case-multi-select";

(globalThis as any).React = React;
(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const apiFetchJsonMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
  };
});

function renderWithQueryClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function Wrapper(props: { mode?: "multi" | "single" }) {
  const [value, setValue] = useState<SelectedCase[]>([]);
  return (
    <CaseMultiSelect
      value={value}
      onChange={setValue}
      placeholder="Search cases..."
      minSearchLength={1}
      debounceMs={0}
      limit={20}
      mode={props.mode}
    />
  );
}

describe("CaseMultiSelect", () => {
  beforeEach(() => {
    apiFetchJsonMock.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("does not treat typed text as a selection", async () => {
    apiFetchJsonMock.mockResolvedValueOnce({
      data: [{ id: 1, referenceNo: "LEGASI-001", shortLabel: "LEGASI-001 • Client A", projectName: null, status: "open" }],
    });

    renderWithQueryClient(<Wrapper />);

    fireEvent.click(screen.getByRole("button", { name: /search cases/i }));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "leg" } });

    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Remove")).toBeNull();
  });

  it("adds a chip only after selecting a dropdown result", async () => {
    apiFetchJsonMock.mockResolvedValueOnce({
      data: [
        { id: 1, referenceNo: "LEGASI-001", shortLabel: "LEGASI-001 • Client A", projectName: null, status: "open" },
        { id: 2, referenceNo: "LEGASI-002", shortLabel: "LEGASI-002 • Client B", projectName: null, status: "open" },
      ],
    });

    renderWithQueryClient(<Wrapper />);

    fireEvent.click(screen.getByRole("button", { name: /search cases/i }));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "leg" } });

    expect(await screen.findByText("LEGASI-001 • Client A")).toBeInTheDocument();
    fireEvent.click(screen.getByText("LEGASI-001 • Client A"));

    expect(screen.getByRole("button", { name: /legasi-001/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Remove").length).toBe(1);

    fireEvent.click(screen.getByText("LEGASI-002 • Client B"));
    expect(screen.getByRole("button", { name: /selected 2 cases/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Remove").length).toBe(2);
  });

  it("removes a selected chip", async () => {
    apiFetchJsonMock.mockResolvedValueOnce({
      data: [{ id: 1, referenceNo: "LEGASI-001", shortLabel: "LEGASI-001 • Client A", projectName: null, status: "open" }],
    });

    renderWithQueryClient(<Wrapper />);

    fireEvent.click(screen.getByRole("button", { name: /search cases/i }));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "leg" } });
    fireEvent.click(await screen.findByText("LEGASI-001 • Client A"));

    fireEvent.click(screen.getByLabelText("Remove"));
    await waitFor(() => expect(screen.queryByLabelText("Remove")).toBeNull());
  });

  it("in single mode, keeps exactly one selection", async () => {
    apiFetchJsonMock.mockResolvedValueOnce({
      data: [
        { id: 1, referenceNo: "LEGASI-001", shortLabel: "LEGASI-001 • Client A", projectName: null, status: "open" },
        { id: 2, referenceNo: "LEGASI-002", shortLabel: "LEGASI-002 • Client B", projectName: null, status: "open" },
      ],
    });

    renderWithQueryClient(<Wrapper mode="single" />);

    fireEvent.click(screen.getByRole("button", { name: /search cases/i }));
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "leg" } });
    fireEvent.click(await screen.findByText("LEGASI-001 • Client A"));

    fireEvent.click(screen.getByRole("button", { name: /legasi-001/i }));
    const input2 = await screen.findByRole("combobox");
    fireEvent.change(input2, { target: { value: "leg" } });
    fireEvent.click(await screen.findByText("LEGASI-002 • Client B"));

    expect(screen.getByRole("button", { name: /legasi-002/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Remove").length).toBe(1);
    expect(screen.queryByRole("button", { name: /legasi-001/i })).toBeNull();
  });
});
