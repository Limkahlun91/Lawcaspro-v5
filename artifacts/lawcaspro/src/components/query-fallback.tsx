import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage, getFriendlyErrorTitle } from "@/lib/error-message";
import { CloudOff } from "lucide-react";

export function QueryFallback({
  title,
  error,
  onRetry,
  isRetrying,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
}) {
  const t = title ?? getFriendlyErrorTitle(error);
  const d = error ? getErrorMessage(error) : "Unable to load data";

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CloudOff />
        </EmptyMedia>
        <EmptyTitle>{t}</EmptyTitle>
        <EmptyDescription>{d}</EmptyDescription>
      </EmptyHeader>
      {onRetry && (
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

