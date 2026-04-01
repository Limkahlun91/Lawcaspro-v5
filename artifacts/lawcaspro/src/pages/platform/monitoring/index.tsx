import { Card, CardContent } from "@/components/ui/card";
import { Activity } from "lucide-react";

export default function PlatformMonitoring() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Platform Monitoring</h1>
        <p className="text-slate-500 mt-1">System health and resource usage</p>
      </div>

      <Card className="border-dashed bg-slate-50">
        <CardContent className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mb-4">
            <Activity className="w-8 h-8 text-slate-400" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Coming in Phase 3</h2>
          <p className="text-slate-500 max-w-md">
            Real-time monitoring of database health, API latency, and tenant resource consumption.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
