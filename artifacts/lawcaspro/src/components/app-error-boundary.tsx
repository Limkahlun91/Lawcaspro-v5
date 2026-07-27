import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    try {
      const componentStack =
        info && typeof info === "object" && "componentStack" in (info as any) ? String((info as any).componentStack ?? "") : "";
      console.error("app.error_boundary", {
        route: typeof window !== "undefined" ? window.location.href : "unknown",
        message: error instanceof Error ? error.message : String(error ?? ""),
        stack: error instanceof Error ? error.stack : null,
        componentStack,
        ts: new Date().toISOString(),
      });
    } catch {
    }
  }

  private reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Something went wrong</EmptyTitle>
            <EmptyDescription>Try refreshing the page or retrying.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <Button onClick={() => window.location.reload()}>Refresh</Button>
              <Button variant="outline" onClick={this.reset}>Retry</Button>
            </div>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
}

