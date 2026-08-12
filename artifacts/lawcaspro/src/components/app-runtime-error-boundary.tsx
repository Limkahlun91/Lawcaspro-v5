import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";

const BUILD_SHA =
  (typeof import.meta !== "undefined" &&
    typeof (import.meta as any).env === "object" &&
    String((import.meta as any).env?.VITE_BUILD_SHA ?? "").slice(0, 8)) ||
  (typeof (import.meta as any)?.env?.COMMIT_HASH === "string"
    ? String((import.meta as any).env.COMMIT_HASH).slice(0, 8)
    : "local");

type Props = { children: ReactNode };

type State = {
  hasError: boolean;
  errorId: string;
};

function genErrorId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `err_${t}_${r}`;
}

export class AppRuntimeErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorId: "" };

  static getDerivedStateFromError(): State {
    return { hasError: true, errorId: genErrorId() };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    try {
      const route = typeof window !== "undefined" ? window.location.pathname + window.location.search : "unknown";
      const componentStack = typeof info?.componentStack === "string" ? info.componentStack : "";
      const sanitizedMessage =
        error instanceof Error
          ? String(error.message || "").slice(0, 200)
          : String(error ?? "").slice(0, 200);
      void sanitizedMessage;
      console.error("[LAWCASE_UI_RUNTIME_ERROR]", {
        route,
        errorId: this.state.errorId || genErrorId(),
        componentStack: componentStack.slice(0, 4000),
        buildSha: BUILD_SHA,
      });
    } catch {
    }
  }

  private reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  private goHome = () => {
    if (typeof window !== "undefined") {
      window.location.href = window.location.origin + (import.meta.env.BASE_URL || "/");
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const errorId = this.state.errorId || "err_unknown";

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="min-h-screen w-full flex items-center justify-center bg-slate-50 p-6"
      >
        <Card className="w-full max-w-md mx-auto border-slate-200 shadow-sm">
          <CardContent className="pt-8 pb-6 px-6">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-full bg-rose-50 flex items-center justify-center">
                <AlertTriangle className="w-7 h-7 text-rose-600" aria-hidden />
              </div>
              <div className="space-y-1.5">
                <h1 className="text-xl font-semibold text-slate-900 tracking-tight">
                  Lawcaspro could not load this page
                </h1>
                <p className="text-sm text-slate-500">
                  An unexpected error occurred. Please try again or return home.
                </p>
              </div>
              <div className="w-full rounded-md bg-slate-50 border border-slate-200 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-0.5">
                  Error ID
                </div>
                <div className="font-mono text-xs text-slate-700 break-all">{errorId}</div>
                {BUILD_SHA && BUILD_SHA !== "local" ? (
                  <div className="mt-1.5 text-[10px] uppercase tracking-wide text-slate-400">
                    Build <span className="font-mono text-slate-500 normal-case">{BUILD_SHA}</span>
                  </div>
                ) : null}
              </div>
              <div className="flex w-full gap-2 pt-1">
                <Button
                  variant="outline"
                  className="flex-1"
                  type="button"
                  onClick={this.goHome}
                >
                  Go Home
                </Button>
                <Button
                  className="flex-1 bg-slate-900 hover:bg-slate-800 text-white"
                  type="button"
                  onClick={this.reload}
                >
                  Reload
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
