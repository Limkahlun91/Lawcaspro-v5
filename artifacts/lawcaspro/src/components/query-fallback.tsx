import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage, getDiscriminatedErrorTitle, getDiscriminatedErrorDetail, shouldShowRetryForError } from "@/lib/error-message";
import { CloudOff } from "lucide-react";

export function QueryFallback({
  title,
  error,
  onRetry,
  isRetrying,
  children,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
  children?: ReactNode;
}) {
  if (children) {
    return <>{children}</>;
  }
  const resourceLabel = title ?? "data";
  const t = error
    ? (title ? title : getDiscriminatedErrorTitle(error, resourceLabel))
    : title ?? "Unable to load";
  const d = error
    ? getDiscriminatedErrorDetail(error, resourceLabel)
    : "Unable to load data";
  const showRetry = error ? shouldShowRetryForError(error) : Boolean(onRetry);

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CloudOff />
        </EmptyMedia>
        <EmptyTitle>{t}</EmptyTitle>
        <EmptyDescription>{d}</EmptyDescription>
      </EmptyHeader>
      {showRetry && onRetry && (
        <EmptyContent>
          <Button onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? (
              <>
                <Spinner className="mr-2" />
                Retrying
              </>
            ) : (
              "Retry"
            )}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

