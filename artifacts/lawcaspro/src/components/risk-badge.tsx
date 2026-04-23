import { Badge } from "@/components/ui/badge";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export function RiskBadge({ level }: { level: RiskLevel }) {
  const cls = (() => {
    if (level === "low") return "bg-slate-100 text-slate-700 border border-slate-200";
    if (level === "medium") return "bg-amber-50 text-amber-700 border border-amber-200";
    if (level === "high") return "bg-orange-50 text-orange-700 border border-orange-200";
    return "bg-red-50 text-red-700 border border-red-200";
  })();
  return (
    <Badge variant="outline" className={`text-xs ${cls}`}>
      {level.toUpperCase()}
    </Badge>
  );
}

