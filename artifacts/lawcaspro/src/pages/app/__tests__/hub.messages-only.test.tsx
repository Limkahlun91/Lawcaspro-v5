import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import HubPage from "@/pages/app/hub";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  }
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
});

(globalThis as any).React = React;

const {
  toastMock,
  toastErrorMock,
  apiFetchJsonMock,
  apiFetchBlobMock,
} = vi.hoisted(() => {
  return {
    toastMock: vi.fn(),
    toastErrorMock: vi.fn(),
    apiFetchJsonMock: vi.fn(),
    apiFetchBlobMock: vi.fn(),
  };
});

vi.mock("wouter", async () => {
  const actual: any = await vi.importActual("wouter");
  return {
    ...actual,
    useLocation: () => ["/app/hub", vi.fn()],
    useSearch: () => "",
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    Router: ({ children }: any) => <>{children}</>,
    Switch: ({ children }: any) => <>{children}</>,
    Route: ({ children, component: Comp }: any) => (Comp ? <Comp /> : <>{children}</>),
    Redirect: () => null,
  };
});

vi.mock("@/lib/auth-context", () => {
  return {
    AuthProvider: ({ children }: any) => <>{children}</>,
    useAuth: () => ({
      user: {
        id: 2,
        firmId: 1,
        userType: "firm_user",
        roleName: "Managing Partner",
        roleId: 1,
        permissions: [{ module: "communications", action: "read" }],
      },
      isLoading: false,
      authStatus: "authenticated",
      permissionsStatus: "ready",
      retryMe: vi.fn(),
      retryPermissions: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/use-toast", () => {
  return {
    useToast: () => ({ toast: toastMock, dismiss: vi.fn() }),
  };
});

vi.mock("@/lib/toast-error", () => {
  return {
    toastError: toastErrorMock,
  };
});

vi.mock("@/lib/upload-validation", () => ({
  validateUploadFile: (f: File) => ({ ok: true, file: f, message: "" }),
}));

vi.mock("@/lib/api-client", async () => {
  const actual: any = await vi.importActual("@/lib/api-client");
  return {
    ...actual,
    apiFetchJson: (...args: any[]) => apiFetchJsonMock(...args),
    apiFetchBlob: (...args: any[]) => apiFetchBlobMock(...args),
  };
});

vi.mock("@/lib/api-base", () => ({
  getApiOrigin: () => "http://localhost",
}));

vi.mock("@/lib/auth-token", () => ({
  getStoredAuthToken: () => "test-token",
  clearStoredAuthToken: vi.fn(),
}));

function wrapInProviders(el: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{el}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HUB — Communication Hub = Messages + Attachments only", () => {
  it("HUB-1 renders Communication Hub title", async () => {
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/hub/messages") return [];
      return {};
    });
    render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: /Communication Hub/i }).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("HUB-2 renders Send Message button", async () => {
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/hub/messages") return [];
      return {};
    });
    render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Send Message/i }).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("HUB-3 does NOT render System Documents tab/text/cards", async () => {
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/hub/messages") return [];
      return {};
    });
    const { container } = render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.queryByText(/System Documents/i)).toBeNull();
    });
    expect(screen.queryByText(/Search documents/i)).toBeNull();
    expect(screen.queryByText(/No documents available/i)).toBeNull();
    expect(container.textContent).not.toMatch(/\bdocuments\b/i);
  });

  it("HUB-4 does NOT call /hub/documents", async () => {
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/hub/messages") return [];
      return {};
    });
    render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.getAllByRole("heading", { name: /Communication Hub/i }).length).toBeGreaterThanOrEqual(1);
    });
    const calledPaths: string[] = apiFetchJsonMock.mock.calls.map(([p]) => p);
    expect(calledPaths).not.toContain("/hub/documents");
    expect(calledPaths).toContain("/hub/messages");
  });

  it("HUB-5 message attachment still visible", async () => {
    const msgs = [
      {
        id: 1,
        subject: "Re: SPA 2025",
        body: "Attached please find.",
        fromFirmId: null,
        fromUserId: 10,
        toFirmId: 1,
        parentId: null,
        readAt: null,
        createdAt: "2026-01-02T03:04:05Z",
        senderName: "Sarah Admin",
        senderEmail: "admin@lawcaspro.local",
        direction: "incoming",
        attachments: [
          {
            id: 5,
            fileName: "SPA-21085.pdf",
            fileType: "application/pdf",
            fileSize: 2048,
            objectPath: "s3://x/SPA-21085.pdf",
          },
        ],
      },
    ];
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/hub/messages") return msgs;
      return {};
    });
    render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.getByText(/SPA-21085\.pdf/i)).toBeInTheDocument();
    });
  });

  it("HUB-6 attachment download still works (calls /hub/messages/:id/attachments/:id/download)", async () => {
    const msgs = [
      {
        id: 11,
        subject: "Re: Loan docs",
        body: "Signed copy.",
        fromFirmId: null,
        fromUserId: 10,
        toFirmId: 1,
        parentId: null,
        readAt: null,
        createdAt: "2026-01-02T03:04:05Z",
        senderName: "Sarah Admin",
        senderEmail: "admin@lawcaspro.local",
        direction: "incoming",
        attachments: [
          {
            id: 22,
            fileName: "facility-letter.pdf",
            fileType: "application/pdf",
            fileSize: 4096,
            objectPath: "s3://x/f.pdf",
          },
        ],
      },
    ];
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/hub/messages") return msgs;
      if (p.startsWith("/hub/messages/") && p.endsWith("/read")) return { ok: true };
      return {};
    });
    apiFetchBlobMock.mockResolvedValue(new Blob(["hello"], { type: "application/pdf" }));
    render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.getByText(/facility-letter\.pdf/i)).toBeInTheDocument();
    });
    const btn = screen.getByText(/facility-letter\.pdf/i).closest("button");
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    await waitFor(() => {
      const blobs = apiFetchBlobMock.mock.calls.map(([p]) => p);
      expect(blobs).toContain("/hub/messages/11/attachments/22/download");
    });
  });

  it("HUB-7 send message with attachment still works", async () => {
    apiFetchJsonMock.mockImplementation(async (p: string, opts?: any) => {
      if (p === "/hub/messages" && !opts) return [];
      if (p === "/storage/upload") return { objectPath: "uploads/test.pdf" };
      if (p === "/hub/messages" && opts?.method === "POST") return { ok: true };
      return {};
    });
    render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Send Message/i }).length).toBeGreaterThanOrEqual(1);
    });
    const openBtn = screen.getAllByRole("button", { name: /Send Message/i })[0];
    fireEvent.click(openBtn);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Message subject/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText(/Message subject/i), { target: { value: "Question" } });
    fireEvent.change(screen.getByPlaceholderText(/Write your message/i), { target: { value: "Is this correct?" } });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["hi"], "attach.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput!, { target: { files: [file] } });
    const sendBtns = screen.getAllByRole("button", { name: /Send Message/i });
    const sendBtn = sendBtns.find((b) => (b as HTMLButtonElement).closest("[role='dialog']"));
    expect(sendBtn).toBeTruthy();
    fireEvent.click(sendBtn!);
    await waitFor(() => {
      const posts = apiFetchJsonMock.mock.calls.filter(([_p, o]) => o?.method === "POST");
      const msgCall = posts.find(([p]) => p === "/hub/messages");
      expect(msgCall).toBeTruthy();
      const body = JSON.parse(msgCall![1].body);
      expect(body.attachments.length).toBe(1);
      expect(body.attachments[0].fileName).toBe("attach.pdf");
      expect(body.subject).toBe("Question");
    });
  });

  it("HUB-8 unread message badge still works", async () => {
    const msgs = [
      {
        id: 1,
        subject: "unread 1",
        body: "a",
        fromFirmId: null,
        fromUserId: 10,
        toFirmId: 1,
        parentId: null,
        readAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        senderName: "Sarah",
        senderEmail: "a@b.com",
        direction: "incoming",
        attachments: [],
      },
      {
        id: 2,
        subject: "unread 2",
        body: "b",
        fromFirmId: null,
        fromUserId: 10,
        toFirmId: 1,
        parentId: null,
        readAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        senderName: "Sarah",
        senderEmail: "a@b.com",
        direction: "incoming",
        attachments: [],
      },
      {
        id: 3,
        subject: "read",
        body: "c",
        fromFirmId: null,
        fromUserId: 10,
        toFirmId: 1,
        parentId: null,
        readAt: "2026-01-02T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
        senderName: "Sarah",
        senderEmail: "a@b.com",
        direction: "incoming",
        attachments: [],
      },
    ];
    apiFetchJsonMock.mockImplementation(async (p: string) => {
      if (p === "/hub/messages") return msgs;
      return {};
    });
    render(wrapInProviders(<HubPage />));
    await waitFor(() => {
      expect(screen.getByText(/2 new/i)).toBeInTheDocument();
    });
  });
});
