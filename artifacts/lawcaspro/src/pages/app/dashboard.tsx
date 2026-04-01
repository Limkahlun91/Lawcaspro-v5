import { useGetDashboardStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Briefcase, Building2, HardHat, Users } from "lucide-react";

export default function AppDashboard() {
  const { data: stats, isLoading } = useGetDashboardStats();

  if (isLoading) {
    return <div>Loading dashboard stats...</div>;
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h1>
        <p className="text-slate-500 mt-1">Overview of your firm's operations</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Cases</CardTitle>
            <Briefcase className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCases}</div>
            <p className="text-xs text-slate-500 mt-1">{stats.activeCases} active, {stats.completedCases} completed</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Clients</CardTitle>
            <Users className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalClients}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Projects</CardTitle>
            <Building2 className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalProjects}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Developers</CardTitle>
            <HardHat className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalDevelopers}</div>
          </CardContent>
        </Card>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Case Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Cash Cases</span>
                <span className="font-medium">{stats.cashCases}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Loan Cases</span>
                <span className="font-medium">{stats.loanCases}</span>
              </div>
            </div>
            <div className="mt-6 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Master Title</span>
                <span className="font-medium">{stats.masterTitleCases}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Individual Title</span>
                <span className="font-medium">{stats.individualTitleCases}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Strata Title</span>
                <span className="font-medium">{stats.strataTitleCases}</span>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle>Recent Cases</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {stats.recentCases?.map(c => (
                <div key={c.id} className="flex items-center justify-between border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                  <div>
                    <div className="font-medium text-amber-600">{c.referenceNo}</div>
                    <div className="text-sm text-slate-500">{c.projectName}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-medium uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-1 rounded inline-block">
                      {c.status.replace(/_/g, ' ')}
                    </div>
                  </div>
                </div>
              ))}
              {!stats.recentCases?.length && (
                <div className="text-sm text-slate-500 italic">No recent cases</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
