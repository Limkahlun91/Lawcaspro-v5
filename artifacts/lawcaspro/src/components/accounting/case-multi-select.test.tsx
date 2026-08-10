import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderView(ui: React.ReactElement) {
  return render(ui);
}

function Wrapper(props: { mode?: "multi" | "single" }) {
  const [value, setValue] = useState<SelectedCase[]>([]);
  return (
    <CaseMultiSelect
      value={value}
      onChange={setValue}
      placeholder="Search cases..."
      minSearchLength={2}
      debounceMs={250}
      limit={20}
      mode={props.mode}
    />
  );
}

async function openSelect() {
  fireEvent.click(screen.getByRole("button", { name: /search cases/i }));
  await new Promise<void>((r) => setTimeout(r, 0));
  return await screen.findByPlaceholderText(/search cases/i);
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
      items: [
        { id: 1, referenceNo: "LEGASI-001", purchaserNames: ["Client A"], purchaserLabel: "Client A", projectName: "Project 1", status: "open" },
      ],
    });

    renderView(<Wrapper />);

    const input = await openSelect();
    fireEvent.change(input, { target: { value: "le" } });

    await new Promise<void>((r) => setTimeout(r, 260));
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Remove")).toBeNull();
  });

  it("adds a chip only after selecting a dropdown result", async () => {
    apiFetchJsonMock.mockResolvedValueOnce({
      items: [
        { id: 1, referenceNo: "LEGASI-001", purchaserNames: ["Client A"], purchaserLabel: "Client A", projectName: "Project 1", status: "open" },
        { id: 2, referenceNo: "LEGASI-002", purchaserNames: ["Client B"], purchaserLabel: "Client B", projectName: "Project 2", status: "open" },
      ],
    });

    renderView(<Wrapper />);

    const input = await openSelect();
    fireEvent.change(input, { target: { value: "le" } });
    await new Promise<void>((r) => setTimeout(r, 260));

    expect(await screen.findByText("LEGASI-001")).toBeInTheDocument();
    expect(screen.getByText("Client A")).toBeInTheDocument();
    expect(screen.getByText("Project 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("LEGASI-001"));

    expect(screen.getByRole("button", { name: /legasi-001 • client a/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Remove").length).toBe(1);

    fireEvent.click(screen.getByText("LEGASI-002"));
    expect(screen.getByRole("button", { name: /selected 2 cases/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Remove").length).toBe(2);
  });

  it("removes a selected chip", async () => {
    apiFetchJsonMock.mockResolvedValueOnce({
      items: [
        { id: 1, referenceNo: "LEGASI-001", purchaserNames: ["Client A"], purchaserLabel: "Client A", projectName: "Project 1", status: "open" },
      ],
    });

    renderView(<Wrapper />);

    const input = await openSelect();
    fireEvent.change(input, { target: { value: "le" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    fireEvent.click(await screen.findByText("LEGASI-001"));

    fireEvent.click(screen.getByLabelText("Remove"));
    await waitFor(() => expect(screen.queryByLabelText("Remove")).toBeNull());
  });

  it("in single mode, keeps exactly one selection", async () => {
    apiFetchJsonMock.mockResolvedValueOnce({
      items: [
        { id: 1, referenceNo: "LEGASI-001", purchaserNames: ["Client A"], purchaserLabel: "Client A", projectName: "Project 1", status: "open" },
        { id: 2, referenceNo: "LEGASI-002", purchaserNames: ["Client B"], purchaserLabel: "Client B", projectName: "Project 2", status: "open" },
      ],
    });

    renderView(<Wrapper mode="single" />);

    const input = await openSelect();
    fireEvent.change(input, { target: { value: "le" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    fireEvent.click(await screen.findByText("LEGASI-001"));

    fireEvent.click(screen.getByRole("button", { name: /legasi-001 • client a/i }));
    await new Promise<void>((r) => setTimeout(r, 0));
    const input2 = await screen.findByPlaceholderText(/search cases/i);
    fireEvent.change(input2, { target: { value: "le" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    fireEvent.click(await screen.findByText("LEGASI-002"));

    expect(screen.getByRole("button", { name: /legasi-002 • client b/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Remove").length).toBe(1);
    expect(screen.queryByRole("button", { name: /legasi-001 • client a/i })).toBeNull();
  });

  it("does not show error for an aborted request", async () => {
    const aborted: Array<{ signal: AbortSignal }> = [];
    apiFetchJsonMock.mockImplementationOnce(async (_url: string, opts: any) => {
      const signal = opts?.signal as AbortSignal | undefined;
      if (signal) aborted.push({ signal });
      await new Promise<void>((resolve, reject) => {
        if (!signal) return resolve();
        if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
      return { items: [] };
    });
    apiFetchJsonMock.mockResolvedValueOnce({
      items: [
        { id: 1, referenceNo: "CON-001", purchaserNames: ["Buyer A"], purchaserLabel: "Buyer A", projectName: "Project X", status: "open" },
      ],
    });

    renderView(<Wrapper />);
    const input = await openSelect();

    fireEvent.change(input, { target: { value: "co" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "con" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(2));

    expect(await screen.findByText("CON-001")).toBeInTheDocument();
    expect(screen.queryByText("Search failed. Please retry.")).toBeNull();
    expect(aborted[0]?.signal.aborted).toBe(true);
  });

  it("prevents an older failed request from overwriting a newer successful response", async () => {
    let failLaterReject: ((e: any) => void) | null = null;
    apiFetchJsonMock.mockImplementationOnce(async () => {
      await new Promise<void>((_r, reject) => { failLaterReject = reject; });
      return { items: [] };
    });
    apiFetchJsonMock.mockResolvedValueOnce({
      items: [
        { id: 1, referenceNo: "CON-001", purchaserNames: ["Buyer A"], purchaserLabel: "Buyer A", projectName: "Project X", status: "open" },
      ],
    });

    renderView(<Wrapper />);
    const input = await openSelect();

    fireEvent.change(input, { target: { value: "co" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "con" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("CON-001")).toBeInTheDocument();

    (failLaterReject as unknown as (e: unknown) => void)(new Error("network"));
    await waitFor(() => expect(screen.queryByText("Search failed. Please retry.")).toBeNull());
    expect(screen.getByText("CON-001")).toBeInTheDocument();
  });

  it("does not send duplicate requests for the same normalized query", async () => {
    apiFetchJsonMock.mockResolvedValue({
      items: [{ id: 1, referenceNo: "CON-001", purchaserNames: ["Buyer A"], purchaserLabel: "Buyer A", projectName: "Project X", status: "open" }],
    });

    renderView(<Wrapper />);
    const input = await openSelect();

    fireEvent.change(input, { target: { value: " CON " } });
    await new Promise<void>((r) => setTimeout(r, 260));
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "con" } });
    await new Promise<void>((r) => setTimeout(r, 260));
    await waitFor(() => expect(apiFetchJsonMock).toHaveBeenCalledTimes(1));
  });
});
