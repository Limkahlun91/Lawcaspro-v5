import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Users, UserCheck, CalendarClock, FileText, Shield } from "lucide-react";

type HrDashboardStats = {
  headcount?: number;
  activeToday?: number;
  pendingLeaves?: number;
  pendingClaims?: number;
};

function HrDashboardInner() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const statsQuery = useQuery({
    queryKey: ["hr-me-dashboard"],
    queryFn: async () => {
      try {
        const res = await apiFetchJson("/hr/me/dashboard");
        return unwrapApiData<HrDashboardStats>(res);
      } catch {
        try {
          const res2 = await apiFetchJson("/hr/dashboard/stats");
          return unwrapApiData<HrDashboardStats>(res2);
        } catch {
          return { headcount: 0, activeToday: 0, pendingLeaves: 0, pendingClaims: 0 };
        }
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const stats = statsQuery.data ?? { headcount: 0, activeToday: 0, pendingLeaves: 0, pendingClaims: 0 };

  const cards = [
    {
      label: "Headcount",
      value: stats.headcount ?? 0,
      icon: Users,
      color: "bg-blue-50 text-blue-600",
      href: "/app/hr/employees",
    },
    {
      label: "Active Today",
      value: stats.activeToday ?? 0,
      icon: UserCheck,
      color: "bg-green-50 text-green-600",
      href: "/app/hr/attendance",
    },
    {
      label: "Pending Leaves",
      value: stats.pendingLeaves ?? 0,
      icon: CalendarClock,
      color: "bg-amber-50 text-amber-600",
      href: "/app/hr/leave",
    },
    {
      label: "Pending Claims",
      value: stats.pendingClaims ?? 0,
      icon: FileText,
      color: "bg-rose-50 text-rose-600",
      href: "/app/hr/claims",
    },
  ];

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">HR Dashboard</h1>
        <p className="text-slate-500 mt-1">Human Resources overview</p>
      </div>

      {statsQuery.isError ? (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Dashboard data temporarily unavailable.
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((c) => (
          <Card
            key={c.label}
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => setLocation(c.href)}
          >
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${c.color}`}>
                  <c.icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-500">{c.label}</div>
                  <div className="text-2xl font-bold text-slate-900 leading-tight">{c.value ?? "—"}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-4 h-4 text-slate-500" />
              <h3 className="font-semibold text-slate-900 text-sm">Quick Actions</h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => setLocation("/app/hr/employees")}>Employees</Button>
              <Button variant="outline" size="sm" onClick={() => setLocation("/app/hr/attendance")}>Attendance</Button>
              <Button variant="outline" size="sm" onClick={() => setLocation("/app/hr/payroll")}>Payroll</Button>
              <Button variant="outline" size="sm" onClick={() => setLocation("/app/hr/recruitment")}>Recruitment</Button>
              <Button variant="outline" size="sm" onClick={() => setLocation("/app/hr/assets")}>Assets</Button>
              <Button variant="outline" size="sm" onClick={() => setLocation("/app/hr/offboarding")}>Offboarding</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function HRDashboardPage() {
  return (
    <PermissionGuard module="hr" action="read" mode="silent">
      <HrDashboardInner />
    </PermissionGuard>
  );
}
