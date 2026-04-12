import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { getStoredAuthToken } from "@/lib/auth-token";
import { useListProjects } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string) {
  const token = getStoredAuthToken();
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    credentials: "include",
    timeoutMs: 15000,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

type WorkbenchCard = { key: string; label: string; count: number; query: Record<string, string> };
type WorkbenchResponse = {
  staffUser: { id: number; name: string };
  staffOptions: Array<{ id: number; name: string; roleName: string | null }>;
  myWork: { cards: WorkbenchCard[]; recent: Array<{ id: number; referenceNo: string; projectName: string; updatedAt: string; query: Record<string, string> }> };
  missingDates: { cards: WorkbenchCard[] };
  overdue: { cards: WorkbenchCard[] };
};

function buildCasesHref(query: Record<string, string>) {
  const sp = new URLSearchParams(query);
  if (!sp.has("page")) sp.set("page", "1");
  if (!sp.has("limit")) sp.set("limit", "50");
  if (!sp.has("sortBy")) sp.set("sortBy", "updatedAt");
  if (!sp.has("sortDir")) sp.set("sortDir", "desc");
  return `/app/cases?${sp.toString()}`;
}

export default function Workbench() {
  const [location, setLocation] = useLocation();
  const sp = useMemo(() => new URLSearchParams(location.split("?")[1] ?? ""), [location]);

  const tab = sp.get("tab") === "missing" || sp.get("tab") === "overdue" ? sp.get("tab")! : "my-work";
  const userId = sp.get("userId") ?? "me";
  const projectId = sp.get("projectId") ?? "all";
  const purchaseMode = sp.get("purchaseMode") ?? "all";
  const assignedLawyerId = sp.get("assignedLawyerId") ?? "all";
  const assignedClerkId = sp.get("assignedClerkId") ?? "all";

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(sp.toString());
    if (v === "all" || v === "me" || v === "") next.delete(k);
    else next.set(k, v);
    setLocation(`/app/workbench?${next.toString()}`);
  };

  const { data: filterOptions } = useQuery({
    queryKey: ["cases", "filter-options"],
    queryFn: () => apiFetch("/cases/filter-options"),
    retry: false,
  });
  const lawyers: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.lawyers) ? filterOptions.assignees.lawyers : [];
  const clerks: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.clerks) ? filterOptions.assignees.clerks : [];

  const { data: projectsRes } = useListProjects({ page: 1, limit: 200 });
  const projects = projectsRes?.data ?? [];

  const workbenchQuery = useMemo(() => {
    const q = new URLSearchParams();
    if (userId !== "me") q.set("userId", userId);
    if (projectId !== "all") q.set("projectId", projectId);
    if (purchaseMode !== "all") q.set("purchaseMode", purchaseMode);
    if (assignedLawyerId !== "all") q.set("assignedLawyerId", assignedLawyerId);
    if (assignedClerkId !== "all") q.set("assignedClerkId", assignedClerkId);
    return q.toString();
  }, [userId, projectId, purchaseMode, assignedLawyerId, assignedClerkId]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<WorkbenchResponse>({
    queryKey: ["cases", "workbench", workbenchQuery],
    queryFn: () => apiFetch(`/cases/workbench${workbenchQuery ? `?${workbenchQuery}` : ""}`),
    retry: false,
  });

  useEffect(() => {
    if (!data) return;
    if (userId === "me") return;
    const exists = data.staffOptions.some((u) => String(u.id) === userId);
    if (!exists) setParam("userId", "me");
  }, [data, userId]);

  if (isLoading) {
    return <div className="text-slate-500">Loading…</div>;
  }
  if (error || !data) {
    return (
      <div className="p-6">
        <QueryFallback title="Workbench unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
      </div>
    );
  }

  const staffOptions = data.staffOptions ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">My Work</h1>
          <p className="text-slate-500 mt-1">A focused workbench for assigned cases, missing dates, and overdue milestones.</p>
        </div>
        {staffOptions.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="text-sm text-slate-500">Staff</div>
            <Select value={userId} onValueChange={(v) => setParam("userId", v)}>
              <SelectTrigger className="w-[240px]">
                <SelectValue placeholder="Select staff" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Me</SelectItem>
                {staffOptions.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setParam("tab", v)}>
        <TabsList>
          <TabsTrigger value="my-work">My Work</TabsTrigger>
          <TabsTrigger value="missing">Missing Dates</TabsTrigger>
          <TabsTrigger value="overdue">Overdue</TabsTrigger>
        </TabsList>

        <TabsContent value="my-work">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {data.myWork.cards.map((card) => (
              <div
                key={card.key}
                className="border rounded-lg bg-white p-4 cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => setLocation(buildCasesHref(card.query))}
              >
                <div className="text-xs text-slate-500">{card.label}</div>
                <div className="text-2xl font-bold text-slate-900 leading-tight mt-1">{card.count}</div>
                <div className="text-xs text-amber-600 mt-2">View cases</div>
              </div>
            ))}
          </div>

          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle>Recently updated</CardTitle>
            </CardHeader>
            <CardContent>
              {data.myWork.recent.length === 0 ? (
                <div className="text-sm text-slate-500">No recent cases.</div>
              ) : (
                <div className="divide-y">
                  {data.myWork.recent.map((c) => (
                    <div
                      key={c.id}
                      className="py-3 flex items-start justify-between gap-2 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded"
                      onClick={() => setLocation(buildCasesHref(c.query))}
                    >
                      <div>
                        <div className="text-sm font-medium text-slate-900">{c.referenceNo}</div>
                        <div className="text-xs text-slate-500">{c.projectName}</div>
                      </div>
                      <div className="text-xs text-slate-400">{new Date(c.updatedAt).toLocaleDateString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="missing">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Filters</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Select value={assignedLawyerId} onValueChange={(v) => setParam("assignedLawyerId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Assigned Lawyer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Lawyers</SelectItem>
                  {lawyers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={assignedClerkId} onValueChange={(v) => setParam("assignedClerkId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Assigned Clerk" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clerks</SelectItem>
                  {clerks.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={projectId} onValueChange={(v) => setParam("projectId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={purchaseMode} onValueChange={(v) => setParam("purchaseMode", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Purchase Mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Modes</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="loan">Loan</SelectItem>
                </SelectContent>
              </Select>

              <div className="md:col-span-4 flex justify-end">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setParam("assignedLawyerId", "all");
                    setParam("assignedClerkId", "all");
                    setParam("projectId", "all");
                    setParam("purchaseMode", "all");
                  }}
                >
                  Reset filters
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
            {data.missingDates.cards.map((card) => (
              <div
                key={card.key}
                className="border rounded-lg bg-white p-4 cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => setLocation(buildCasesHref(card.query))}
              >
                <div className="text-xs text-slate-500">{card.label}</div>
                <div className="text-2xl font-bold text-slate-900 leading-tight mt-1">{card.count}</div>
                <div className="text-xs text-amber-600 mt-2">View cases</div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="overdue">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Filters</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Select value={assignedLawyerId} onValueChange={(v) => setParam("assignedLawyerId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Assigned Lawyer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Lawyers</SelectItem>
                  {lawyers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={assignedClerkId} onValueChange={(v) => setParam("assignedClerkId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Assigned Clerk" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clerks</SelectItem>
                  {clerks.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={projectId} onValueChange={(v) => setParam("projectId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={purchaseMode} onValueChange={(v) => setParam("purchaseMode", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Purchase Mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Modes</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="loan">Loan</SelectItem>
                </SelectContent>
              </Select>

              <div className="md:col-span-4 flex justify-end">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setParam("assignedLawyerId", "all");
                    setParam("assignedClerkId", "all");
                    setParam("projectId", "all");
                    setParam("purchaseMode", "all");
                  }}
                >
                  Reset filters
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
            {data.overdue.cards.map((card) => (
              <div
                key={card.key}
                className="border rounded-lg bg-white p-4 cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => setLocation(buildCasesHref(card.query))}
              >
                <div className="text-xs text-slate-500">{card.label}</div>
                <div className="text-2xl font-bold text-slate-900 leading-tight mt-1">{card.count}</div>
                <div className="text-xs text-amber-600 mt-2">View cases</div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
