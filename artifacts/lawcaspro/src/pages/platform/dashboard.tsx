import { useGetPlatformStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Users, Briefcase } from "lucide-react";

export default function PlatformDashboard() {
  const { data: stats, isLoading } = useGetPlatformStats();

  if (isLoading) {
    return <div>Loading platform stats...</div>;
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Platform Overview</h1>
        <p className="text-slate-500 mt-1">Monitor all firms across the network</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Firms</CardTitle>
            <Building2 className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalFirms}</div>
            <p className="text-xs text-slate-500 mt-1">{stats.activeFirms} active</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Users</CardTitle>
            <Users className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalUsers}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Cases</CardTitle>
            <Briefcase className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCases}</div>
          </CardContent>
        </Card>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>Platform Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="p-3 bg-slate-50 rounded-lg">
              <div className="text-slate-500 text-xs">Active Firms</div>
              <div className="font-bold text-lg text-slate-900">{stats.activeFirms ?? 0}</div>
            </div>
            <div className="p-3 bg-slate-50 rounded-lg">
              <div className="text-slate-500 text-xs">Documents Generated</div>
              <div className="font-bold text-lg text-slate-900">{stats.totalDocuments ?? 0}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
