import { ReactNode } from "react";

export function PlatformPage({ children }: { children: ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}

export function PlatformPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{title}</h1>
        {description ? <div className="text-sm text-slate-600 mt-1">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}

