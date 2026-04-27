import { ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type StateAction = {
  label: string;
  onClick: () => void;
  variant?: ButtonProps["variant"];
  disabled?: boolean;
};

export function PlatformLoadingState({
  title = "Loading...",
  description,
  className,
}: {
  title?: string;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("border border-slate-200 bg-white", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Spinner />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

export function PlatformEmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  primaryAction?: StateAction;
  secondaryAction?: StateAction;
  className?: string;
}) {
  return (
    <Empty className={cn("border border-slate-200 bg-white", className)}>
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {primaryAction || secondaryAction ? (
        <EmptyContent>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            {primaryAction ? (
              <Button onClick={primaryAction.onClick} disabled={primaryAction.disabled} variant={primaryAction.variant}>
                {primaryAction.label}
              </Button>
            ) : null}
            {secondaryAction ? (
              <Button onClick={secondaryAction.onClick} disabled={secondaryAction.disabled} variant={secondaryAction.variant ?? "outline"}>
                {secondaryAction.label}
              </Button>
            ) : null}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

