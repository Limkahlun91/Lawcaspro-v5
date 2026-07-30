import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
 
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
 
vi.mock("@/components/re-auth-dialog", () => {
  return { useReAuth: () => ({ wrapWithReAuth: (fn: any) => fn() }) };
});
 
vi.mock("@/lib/auth-context", () => {
  return {
    useAuth: () => ({
      user: {
        id: 1,
        firmId: 1,
        firmName: "Firm",
        roleName: "Partner",
        userType: "firm_user",
      },
    }),
  };
});
 
vi.mock("@/lib/permissions", () => {
  return {
    hasPermission: (_user: unknown, module: string, action: string) => module === "accounting" && action === "read",
  };
});
 
const apiFetchJsonMock = vi.fn();
 
vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return { ...actual, apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args) };
});
 
function makeVoucher(n: number) {
  const now = new Date().toISOString();
  return {
    id: n,
    caseId: null,
    voucherType: "external_payment",
    approvalStatus: "approved",
    isAdvance: false,
    voucherNo: `PV-${n}`,
    status: "pending_account",
    fundStatus: null,
    payeeName: `Payee ${n}`,
    paymentMethod: "bank_transfer",
    accountType: "office",
    bankChequeRefNo: "",
    amount: "1.00",
    purpose: `Purpose ${n}`,
    receivedAt: null,
    paymentDueAt: null,
    deadlineOverrideReason: "",
    assignedAccountUserId: null,
    assignedClerkUserId: null,
    paidAt: null,
    proofDocumentPath: "",
    nextActionType: "Collect Physical File",
    nextActionCustom: "",
    nextActionRemarks: "",
    clerkActionExemptReason: "",
    lateCompletionReason: "",
    updatedAt: now,
    createdAt: now,
  };
}
 
function findApiCall(prefix: string) {
  return apiFetchJsonMock.mock.calls.find((c) => typeof c?.[0] === "string" && String(c[0]).startsWith(prefix));
}
 
describe("payment vouchers paging (server-driven)", () => {
  beforeEach(() => {
    apiFetchJsonMock.mockReset();
    setLocationMock.mockReset();
    window.history.pushState({}, "", "/app/accounting?tab=payment-vouchers");
 
    apiFetchJsonMock.mockImplementation((path: string) => {
      if (path.startsWith("/payment-vouchers/dashboard")) {
        return Promise.resolve({
          awaitingReceipt: 0,
          receivedAndProcessing: 0,
          waitingApproval: 0,
          dueSoon: 0,
          overdue: 0,
          paidToday: 0,
          clerkPending: 0,
          clerkOverdue: 0,
          completedMonth: 0,
        });
      }
      if (path.startsWith("/payment-vouchers?page=1&limit=50")) {
        return Promise.resolve(Array.from({ length: 50 }, (_v, i) => makeVoucher(i + 1)));
      }
      if (path.startsWith("/payment-vouchers?page=2&limit=50")) {
        return Promise.resolve(Array.from({ length: 10 }, (_v, i) => makeVoucher(101 + i)));
      }
      return Promise.resolve({ data: [] });
    });
  });
 
  it("paginates via page state, query keys, and disables Next when fewer than pageSize rows returned", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { default: Accounting } = await import("../accounting");
 
    render(
      <QueryClientProvider client={qc}>
        <Accounting />
      </QueryClientProvider>,
    );
 
    expect(await screen.findByText(/showing up to 50 vouchers \(server-paged\)/i)).toBeInTheDocument();
 
    await waitFor(() => {
      expect(qc.getQueryData(["payment-vouchers", 1])).toBeTruthy();
    });
 
    expect(findApiCall("/payment-vouchers?page=1&limit=50")).toBeTruthy();
    expect(screen.getByText("PV-1")).toBeInTheDocument();
 
    const prevBtn = screen.getByRole("button", { name: "Previous" });
    const nextBtn = screen.getByRole("button", { name: "Next" });
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).not.toBeDisabled();
 
    fireEvent.click(nextBtn);
 
    expect(await screen.findByText("Page 2")).toBeInTheDocument();
    await waitFor(() => {
      expect(findApiCall("/payment-vouchers?page=2&limit=50")).toBeTruthy();
      expect(qc.getQueryData(["payment-vouchers", 2])).toBeTruthy();
    });
 
    expect(qc.getQueryData(["payment-vouchers", 1])).toBeTruthy();
    expect(screen.queryByText("PV-1")).not.toBeInTheDocument();
    expect(screen.getByText("PV-101")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeDisabled();
 
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
 
    expect(await screen.findByText("Page 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  }, 15000);
});
