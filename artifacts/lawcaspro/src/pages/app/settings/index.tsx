import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings as SettingsIcon } from "lucide-react";

export default function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-slate-500 mt-1">Firm preferences and configuration</p>
      </div>

      <Card className="border-dashed bg-slate-50">
        <CardContent className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mb-4">
            <SettingsIcon className="w-8 h-8 text-slate-400" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Firm Settings</h2>
          <p className="text-slate-500 max-w-md">
            Configuration options for letterheads, billing details, and workflow customizations will be available here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
