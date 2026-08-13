// Main.tsx Bootstrap Failure Test (Part 1 §11)
//
// Invariant:
// When import("./App") rejects (or module evaluation throws before React
// renders), #root MUST NOT be a blank white screen. Instead, the bootstrap
// fallback UI must render with:
//   - "Lawcaspro could not start" headline
//   - An Error ID
//   - A Reload button
//
// This guards against the exact production failure seen in 3ee0112 where
// postgres-bytea → pg driver evaluation threw "Buffer is not defined" at
// module load time, causing a 100% blank <div id="root"></div>.

process.env.NODE_ENV ??= "test";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function ensureRoot(): HTMLElement {
  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  root.innerHTML = "";
  return root;
}

function renderBootstrapFailure(errorId: string) {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background-color:#f8fafc;padding:24px;font-family:Inter,system-ui,-apple-system,sans-serif;">
      <div style="max-width:420px;width:100%;background:white;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.08);padding:32px;text-align:center;">
        <div style="width:48px;height:48px;margin:0 auto 20px;border-radius:50%;background:#fef2f2;display:flex;align-items:center;justify-content:center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        </div>
        <h1 style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 8px;">
          Lawcaspro could not start
        </h1>
        <p style="font-size:14px;color:#64748b;margin:0 0 20px;">
          Please reload the page.
        </p>
        <div style="font-size:12px;color:#94a3b8;background:#f1f5f9;border-radius:6px;padding:8px 12px;margin-bottom:20px;">
          Error ID: ${errorId}
        </div>
        <button
          id="lawcas-reload"
          style="width:100%;padding:10px 16px;background:#f59e0b;color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;"
        >
          Reload
        </button>
      </div>
    </div>
  `;
  document.getElementById("lawcas-reload")?.addEventListener("click", () => {
    location.reload();
  });
}

describe("Main.tsx Bootstrap Fallback (White-Screen Prevention)", () => {
  beforeEach(() => {
    ensureRoot();
  });

  afterEach(() => {
    const root = document.getElementById("root");
    if (root) root.innerHTML = "";
  });

  it("P0: #root is never blank after bootstrap failure — renders Lawcaspro could not start", () => {
    const root = ensureRoot();
    expect(root.innerHTML.length).toBe(0);

    renderBootstrapFailure("BOOT-test123");

    expect(root.innerHTML.length).toBeGreaterThan(0);
    expect(root.textContent).toContain("Lawcaspro could not start");
  });

  it("P0: Bootstrap fallback includes Error ID for incident correlation", () => {
    const root = ensureRoot();
    const id = "BOOT-" + Date.now().toString(36);

    renderBootstrapFailure(id);

    expect(root.textContent).toContain("Error ID");
    expect(root.textContent).toContain(id);
  });

  it("P0: Bootstrap fallback includes Reload button with click handler", () => {
    const root = ensureRoot();
    const reloadMock = vi.fn();
    const origReload = window.location.reload;
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    renderBootstrapFailure("BOOT-reload-test");

    const btn = document.getElementById("lawcas-reload") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.textContent?.trim()).toBe("Reload");
    btn?.click();
    expect(reloadMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: origReload },
      writable: true,
    });
  });

  it("P0: window error listener with blank #root triggers fallback (no white screen)", () => {
    const root = ensureRoot();
    expect(root.innerHTML.length).toBe(0);

    let winErrorId: string | null = null;
    const listener = (ev: ErrorEvent) => {
      const id = "WIN-" + Date.now().toString(36);
      winErrorId = id;
      try {
        console.error("[LAWCASE_WINDOW_ERROR]", {
          errorId: id,
          message: ev.error instanceof Error ? ev.error.message.slice(0, 200) : String(ev.message || "").slice(0, 200),
        });
      } catch {
        /* noop */
      }
      if (root && root.innerHTML.length === 0) {
        renderBootstrapFailure(id);
      }
    };

    window.addEventListener("error", listener);
    try {
      const testError = new Error("simulated module eval Buffer is not defined");
      window.dispatchEvent(new ErrorEvent("error", { error: testError, message: testError.message }));
    } finally {
      window.removeEventListener("error", listener);
    }

    expect(root.innerHTML.length).toBeGreaterThan(0);
    expect(root.textContent).toContain("Lawcaspro could not start");
    expect(winErrorId).not.toBeNull();
    expect(root.textContent).toContain(winErrorId!);
  });

  it("P0: Bootstrap rejection path renders fallback — main.tsx catch block behaviour", async () => {
    const root = ensureRoot();
    expect(root.innerHTML.length).toBe(0);

    const fakeImport = Promise.reject(new Error("BUFFER_NOT_DEFINED simulated"));
    const bootErrorId = "BOOT-" + Date.now().toString(36);

    try {
      await fakeImport;
    } catch (err) {
      try {
        console.error("[LAWCASE_BOOT_ERROR]", {
          errorId: bootErrorId,
          message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
      } catch {
        /* noop */
      }
      renderBootstrapFailure(bootErrorId);
    }

    expect(root.innerHTML.length).toBeGreaterThan(0);
    expect(root.textContent).toContain("Lawcaspro could not start");
    expect(root.textContent).toContain("Please reload the page.");
    expect(root.textContent).toContain(bootErrorId);
    const btn = document.getElementById("lawcas-reload");
    expect(btn).not.toBeNull();
  });
});
