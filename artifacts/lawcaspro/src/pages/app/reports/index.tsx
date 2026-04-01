import { Card, CardContent } from "@/components/ui/card";
import { BarChart } from "lucide-react";

export default function Reports() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Reports</h1>
        <p className="text-slate-500 mt-1">Performance and operational analytics</p>
      </div>

      <Card className="border-dashed bg-slate-50">
        <CardContent className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mb-4">
            <BarChart className="w-8 h-8 text-slate-400" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Coming in Phase 6</h2>
          <p className="text-slate-500 max-w-md">
            Advanced reporting and BI dashboards for partners to track firm performance and clerk efficiency.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
