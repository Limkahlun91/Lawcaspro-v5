import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Workbench from "../workbench";

(globalThis as any).React = React;

const setLocationMock = vi.fn();

vi.mock("wouter", async () => {
  const getLoc = () => `${window.location.pathname}${window.location.search}`;
  return {
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    useSearch: () => window.location.search,
    useLocation: () => [
      getLoc(),
      (next: string) => {
        setLocationMock(next);
        window.history.pushState({}, "", next);
      },
    ],
  };
});

vi.mock("@/hooks/use-toast", () => {
  return { useToast: () => ({ toast: vi.fn() }) };
});

vi.mock("@/lib/auth-context", () => {
  return {
    useAuth: () => ({
      user: { id: 1, firmId: 1, roleName: "Staff", userType: "firm_user" },
    }),
  };
});

vi.mock("@/components/milestones-table", () => {
  return { MilestonesTable: () => <div>Milestones</div> };
});

const useListProjectsMock = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const actual: any = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    useListProjects: (params: any, opts: any) => useListProjectsMock(params, opts),
  };
});

const apiFetchJsonMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
    apiRequest: vi.fn(),
    apiFetchBlob: vi.fn(),
  };
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderWithQueryClient() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <Workbench />
    </QueryClientProvider>
  );
  return { ...view, qc };
}

beforeEach(() => {
  apiFetchJsonMock.mockReset();
  useListProjectsMock.mockReset();
  setLocationMock.mockReset();
  window.history.pushState({}, "", "/app/workbench?tab=my-work");
});

describe("/app/workbench hook order regressions", () => {
  it("keeps stable hook order across loading, success, PV actions failure, and tab change", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const workbenchDef = deferred<any>();

    useListProjectsMock.mockReturnValue({ data: { data: [] } });

    apiFetchJsonMock.mockImplementation((path: string) => {
      if (path.startsWith("/cases/filter-options")) return Promise.resolve({});
      if (path.startsWith("/cases/workbench")) return workbenchDef.promise;
      if (path.startsWith("/cases/milestones-summary")) return Promise.resolve({ milestoneSections: [], milestoneCards: [] });
      if (path.startsWith("/payment-voucher-actions/my-work")) return Promise.reject(new Error("pv actions failed"));
      return Promise.resolve({});
    });

    renderWithQueryClient();

    expect(await screen.findByText("Loading…")).toBeInTheDocument();

    workbenchDef.resolve({
      staffUser: { id: 1, name: "U" },
      staffOptions: [{ id: 1, name: "U", roleName: "Staff" }],
      myWork: { cards: [], recent: [] },
      missingDates: { cards: [] },
      overdue: { cards: [] },
    });

    expect(await screen.findByRole("heading", { name: "My Work" })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Payment voucher actions unavailable")).toBeInTheDocument();
    });

    const missingTab = screen.getByRole("tab", { name: "Missing Dates" });
    fireEvent.mouseDown(missingTab);
    fireEvent.click(missingTab);
    await waitFor(() => {
      expect(setLocationMock).toHaveBeenCalled();
    });

    const errorJoined = consoleErrorSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(errorJoined).not.toMatch(/Rendered more hooks/i);
    expect(errorJoined).not.toMatch(/Minified React error #310/i);

    consoleErrorSpy.mockRestore();
  });
});
