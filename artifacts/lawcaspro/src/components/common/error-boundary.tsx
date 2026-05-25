import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

type Props = {
  title?: string;
  description?: string;
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch() {
  }

  private reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="p-4">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{this.props.title ?? "Something went wrong"}</EmptyTitle>
            <EmptyDescription>{this.props.description ?? "Try refreshing the page or retrying."}</EmptyDescription>
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

