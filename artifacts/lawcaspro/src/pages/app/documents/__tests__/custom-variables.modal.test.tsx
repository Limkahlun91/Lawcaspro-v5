import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CustomVariablesPage from "../custom-variables";

(globalThis as any).React = React;
(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

vi.mock("@/hooks/use-toast", () => {
  return { useToast: () => ({ toast: vi.fn() }) };
});

const apiFetchJsonMock = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
  };
});

function renderWithQueryClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CustomVariablesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchJsonMock.mockReset();
  (navigator as any).clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

  apiFetchJsonMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/documents/custom-variables?")) return [];
    if (path.startsWith("/document-variables?active=1")) {
      return [
        { id: 1, key: "purchasers_inline", label: "Purchasers Inline", category: "purchaser", isSystem: true, isActive: true, sortOrder: 0 },
        { id: 2, key: "spa_date", label: "SPA Date", category: "case", isSystem: true, isActive: true, sortOrder: 0, valueType: "date" },
        { id: 3, key: "loan_issued_date", label: "Issued Date", category: "loan", isSystem: true, isActive: true, sortOrder: 0, valueType: "date" },
      ];
    }
    if (path.startsWith("/cases?search=")) {
      return {
        data: [
          { id: 5, referenceNo: "SUB-001", clientName: "Buyer A", projectName: "Project X", property: "Parcel 1" },
        ],
      };
    }
    if (path.startsWith("/documents/variables?caseId=5")) {
      return {
        variables: [
          {
            id: 1,
            key: "purchasers_inline",
            label: "Purchasers Inline",
            category: "purchaser",
            isSystem: true,
            isActive: true,
            sortOrder: 0,
            previewValue: "LIMKL, LIMKL 1, LIMKL 2 & LIMKL 3",
          },
          {
            id: 2,
            key: "spa_date",
            label: "SPA Date",
            category: "case",
            isSystem: true,
            isActive: true,
            sortOrder: 0,
            previewValue: "05.12.2026",
          },
          {
            id: 3,
            key: "loan_issued_date",
            label: "Issued Date",
            category: "loan",
            isSystem: true,
            isActive: true,
            sortOrder: 0,
            previewValue: null,
          },
        ],
        loops: [],
      };
    }
    return {};
  });
});

describe("Custom Dictionary modal variable picker", () => {
  it("shows picker, inserts token, previews values and renders live preview", async () => {
    renderWithQueryClient();

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    const dialog = await screen.findByRole("dialog");
    const ui = within(dialog);

    expect(await ui.findByText("Variables")).toBeInTheDocument();

    fireEvent.change(ui.getByPlaceholderText("Search variables..."), { target: { value: "purchaser" } });
    expect(await ui.findByText("Purchasers Inline")).toBeInTheDocument();

    fireEvent.click(ui.getByRole("button", { name: "Insert" }));
    const textarea = ui.getByPlaceholderText("Use {{variable_tokens}} inside.") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain("{{purchasers_inline}}"));

    fireEvent.click(ui.getByRole("button", { name: "Copy Token" }));
    expect((navigator as any).clipboard.writeText).toHaveBeenCalledWith("{{purchasers_inline}}");

    const combo = ui.getAllByRole("combobox").find((el) => el.textContent?.includes("Select a case")) as HTMLElement;
    fireEvent.mouseDown(combo);
    fireEvent.click(combo);
    expect(combo).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(await screen.findByPlaceholderText("Search case…"), { target: { value: "sub" } });
    await new Promise((r) => setTimeout(r, 250));
    fireEvent.click(await screen.findByText("SUB-001"));

    expect((await ui.findAllByText("LIMKL, LIMKL 1, LIMKL 2 & LIMKL 3")).length).toBeGreaterThan(0);

    fireEvent.change(textarea, { target: { value: "Date: {{spa_date}} Missing: {{loan_issued_date}}" } });
    const previewHeading = await ui.findByText("Preview");
    expect(previewHeading.parentElement).toHaveTextContent("05.12.2026");
    expect(previewHeading.parentElement).toHaveTextContent("—");
  });
});
