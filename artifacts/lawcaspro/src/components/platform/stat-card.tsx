import { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function StatCard({
  title,
  value,
  icon,
  subtext,
  valueClassName,
}: {
  title: string;
  value: ReactNode;
  icon?: ReactNode;
  subtext?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-xs font-medium text-slate-500 min-w-0 pr-2 break-words leading-snug">{title}</CardTitle>
        {icon ? <div className="text-slate-400 shrink-0">{icon}</div> : null}
      </CardHeader>
      <CardContent className="space-y-1 min-w-0">
        <div className={["text-2xl font-bold text-slate-900 leading-tight min-w-0 break-words", valueClassName].filter(Boolean).join(" ")}>{value}</div>
        {subtext ? <div className="text-xs text-slate-500">{subtext}</div> : null}
      </CardContent>
    </Card>
  );
}
