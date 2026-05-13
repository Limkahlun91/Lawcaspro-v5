import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Pie, PieChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

type DashboardResponse = {
  kpis: { spaSigned: number; loanApproved: number; handover: number };
  stageDistribution: Array<{ stage: string; count: number }>;
  stagnantCases: Array<{
    id: number;
    referenceNo: string;
    unitNo: string | null;
    projectName: string;
    purchaserName: string | null;
    spaStatus: string;
    loanStatus: string | null;
    updatedAt: string;
  }>;
};

export default function DeveloperDashboardPage() {
  const query = useQuery<DashboardResponse>({
    queryKey: ["developer-dashboard"],
    queryFn: ({ signal }) => apiFetchJson("/developer/dashboard", { signal }),
    retry: false,
  });

  if (query.isLoading) {
    return <div className="text-slate-500 py-12 text-center text-sm">Loading developer dashboard...</div>;
  }

  if (query.isError) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <QueryFallback title="Developer dashboard unavailable" error={query.error} onRetry={() => query.refetch()} />
        </div>
      </div>
    );
  }

  const data = query.data;
  if (!data) {
    return <div className="text-slate-500 py-12 text-center text-sm">No dashboard data available.</div>;
  }

  const stages = Array.isArray(data.stageDistribution) ? data.stageDistribution : [];
  const stagnant = Array.isArray(data.stagnantCases) ? data.stagnantCases : [];
  const kpis = data.kpis ?? { spaSigned: 0, loanApproved: 0, handover: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Developer Dashboard</h1>
        <p className="text-slate-500 mt-1">Project portfolio overview</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "SPA Signed", value: kpis.spaSigned },
          { label: "Loan Approved", value: kpis.loanApproved },
          { label: "Handover Completed", value: kpis.handover },
        ].map((item) => (
          <Card key={item.label}>
            <CardContent className="pt-5 pb-4">
              <div className="text-xs text-slate-500">{item.label}</div>
              <div className="text-2xl font-bold text-slate-900 leading-tight">{Number(item.value ?? 0)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Stage Distribution</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ChartContainer
              className="h-64 w-full"
              config={{
                count: { label: "Cases", color: "hsl(var(--chart-1))" },
              }}
            >
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent />} />
                <Pie data={stages} dataKey="count" nameKey="stage" innerRadius={55} outerRadius={85} fill="var(--color-count)" />
              </PieChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Stage Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ChartContainer
              className="h-64 w-full"
              config={{
                count: { label: "Cases", color: "hsl(var(--chart-2))" },
              }}
            >
              <BarChart data={stages} margin={{ left: 12, right: 12 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="stage" tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Stagnant Cases (No update for 21+ days)</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b">
                  <th className="py-2 pr-3">Unit No</th>
                  <th className="py-2 pr-3">Purchaser</th>
                  <th className="py-2 pr-3">Project</th>
                  <th className="py-2 pr-3">SPA</th>
                  <th className="py-2 pr-3">Loan</th>
                  <th className="py-2 pr-3">Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {stagnant.map((c) => (
                  <tr key={c.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 text-slate-900">{c.unitNo ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-900">{c.purchaserName ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-700">{c.projectName}</td>
                    <td className="py-2 pr-3 text-slate-700">{c.spaStatus}</td>
                    <td className="py-2 pr-3 text-slate-700">{c.loanStatus ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-600">{c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
                {stagnant.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500">No stagnant cases.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

