import { createRoot } from "react-dom/client";
import "./index.css";

const root = document.getElementById("root");

function renderBootstrapFailure(errorId: string) {
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

const _bootstrapErrorListener = (ev: ErrorEvent) => {
  const id = "WIN-" + Date.now().toString(36);
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

const _bootstrapRejectionListener = (ev: PromiseRejectionEvent) => {
  const id = "REJ-" + Date.now().toString(36);
  try {
    const reason = ev.reason;
    console.error("[LAWCASE_UNHANDLED_REJECTION]", {
      errorId: id,
      message: reason instanceof Error ? reason.message.slice(0, 200) : String(reason || "").slice(0, 200),
    });
  } catch {
    /* noop */
  }
  if (root && root.innerHTML.length === 0) {
    renderBootstrapFailure(id);
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("error", _bootstrapErrorListener);
  window.addEventListener("unhandledrejection", _bootstrapRejectionListener);
}

import("./App")
  .then(({ default: App }) => {
    if (!root) {
      throw new Error("ROOT_ELEMENT_MISSING");
    }
    createRoot(root).render(<App />);
  })
  .catch((err) => {
    const id = "BOOT-" + Date.now().toString(36);
    try {
      console.error("[LAWCASE_BOOT_ERROR]", {
        errorId: id,
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
    } catch {
      /* noop */
    }
    renderBootstrapFailure(id);
  });
