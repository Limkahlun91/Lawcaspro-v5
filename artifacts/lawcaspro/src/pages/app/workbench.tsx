import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetchJson } from "@/lib/api-client";
import { useListProjects } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";
import { MilestonesTable } from "@/components/milestones-table";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";

type WorkbenchCard = { key: string; label: string; count: number; query: Record<string, string> };
type WorkbenchResponse = {
  staffUser: { id: number; name: string };
  staffOptions: Array<{ id: number; name: string; roleName: string | null }>;
  myWork: { cards: WorkbenchCard[]; recent: Array<{ id: number; referenceNo: string; projectName: string; updatedAt: string; query: Record<string, string> }> };
  missingDates: { cards: WorkbenchCard[] };
  overdue: { cards: WorkbenchCard[] };
};

type MilestoneCard = {
  key: string;
  label: string;
  count: number;
  pendingCount?: number;
  doneCount?: number;
  filter: { milestone?: string; milestonePresence?: string; purchaseMode?: string; titleType?: string };
};
type MilestoneSection = { key: string; label: string; total: number; cards: MilestoneCard[] };
type PaymentVoucherAction = {
  id: number;
  paymentVoucherId: number;
  caseId: number | null;
  actionType: string;
  customAction: string | null;
  status: string;
  priority: string;
  assignedAt: string;
  acknowledgeDueAt: string | null;
  acknowledgedAt: string | null;
  completionDueAt: string | null;
  completedAt: string | null;
  voucherNo: string;
  payeeName: string;
  nextActionRemarks: string | null;
  referenceNo: string | null;
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
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sp = useMemo(() => new URLSearchParams(location.split("?")[1] ?? ""), [location]);

  const tab = sp.get("tab") === "missing" || sp.get("tab") === "overdue" ? sp.get("tab")! : "my-work";
  const userId = sp.get("userId") ?? "me";
  const projectId = sp.get("projectId") ?? "all";
  const purchaseMode = sp.get("purchaseMode") ?? "all";
  const assignedLawyerId = sp.get("assignedLawyerId") ?? "all";
  const assignedClerkId = sp.get("assignedClerkId") ?? "all";
  const [completeActionId, setCompleteActionId] = useState<number | null>(null);
  const [completeForm, setCompleteForm] = useState({
    actionTaken: "",
    completionNotes: "",
    completionAttachmentPath: "",
    updatedMilestone: "",
  });

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(sp.toString());
    if (v === "all" || v === "me" || v === "") next.delete(k);
    else next.set(k, v);
    setLocation(`/app/workbench?${next.toString()}`);
  };

  const { data: _filterOptions } = useQuery({
    queryKey: ["cases", "filter-options"],
    queryFn: ({ signal }) => apiFetchJson("/cases/filter-options", { signal }),
    retry: false,
  });
  const filterOptions = _filterOptions as any;
  const lawyers: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.lawyers) ? filterOptions.assignees.lawyers : [];
  const clerks: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.clerks) ? filterOptions.assignees.clerks : [];

  const { data: projectsRes } = useListProjects({ page: 1, limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
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
    queryFn: ({ signal }) => apiFetchJson(`/cases/workbench${workbenchQuery ? `?${workbenchQuery}` : ""}`, { signal }),
    retry: 1,
    retryDelay: 400,
  });

  const milestonesTargetUserId = (() => {
    if (!data?.staffUser?.id) return null;
    if (userId === "me") return data.staffUser.id;
    const n = Number.parseInt(userId, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const milestonesQuery = useQuery({
    queryKey: ["cases", "milestones-summary", milestonesTargetUserId],
    queryFn: ({ signal }) =>
      apiFetchJson(`/cases/milestones-summary?assignedToUserId=${encodeURIComponent(String(milestonesTargetUserId))}`, { signal, timeoutMs: 30000 }) as Promise<Record<string, unknown>>,
    retry: 1,
    enabled: tab === "my-work" && milestonesTargetUserId != null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const paymentVoucherActionsQuery = useQuery<PaymentVoucherAction[]>({
    queryKey: ["payment-voucher-actions", "my-work", milestonesTargetUserId],
    queryFn: ({ signal }) =>
      apiFetchJson(`/payment-voucher-actions/my-work${milestonesTargetUserId ? `?userId=${encodeURIComponent(String(milestonesTargetUserId))}` : ""}`, { signal }),
    retry: false,
    enabled: tab === "my-work" && milestonesTargetUserId != null,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (id: number) => apiFetchJson(`/payment-voucher-actions/${id}/acknowledge`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["payment-voucher-actions", "my-work"] });
      toast({ title: "Action acknowledged" });
    },
    onError: (err) => toastError(toast, err, "Failed to acknowledge action"),
  });

  const completeMutation = useMutation({
    mutationFn: (payload: { id: number; body: Record<string, unknown> }) =>
      apiFetchJson(`/payment-voucher-actions/${payload.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.body),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["payment-voucher-actions", "my-work"] });
      setCompleteActionId(null);
      setCompleteForm({
        actionTaken: "",
        completionNotes: "",
        completionAttachmentPath: "",
        updatedMilestone: "",
      });
      toast({ title: "Action completed" });
    },
    onError: (err) => toastError(toast, err, "Failed to complete action"),
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

          <div className="mt-4">
            {milestonesQuery.isError ? (
              <QueryFallback title="Milestones unavailable" error={milestonesQuery.error} onRetry={() => milestonesQuery.refetch()} isRetrying={milestonesQuery.isFetching} />
            ) : (
              (() => {
                const payload = milestonesQuery.data as Record<string, unknown> | undefined;
                const milestoneSections: MilestoneSection[] = Array.isArray(payload?.milestoneSections)
                  ? (payload?.milestoneSections as unknown as MilestoneSection[])
                  : [];
                const milestoneCards: MilestoneCard[] = Array.isArray(payload?.milestoneCards)
                  ? (payload?.milestoneCards as unknown as MilestoneCard[])
                  : [];
                const staffLabel = (() => {
                  if (!data?.staffUser?.name) return "My Milestones";
                  if (userId === "me") return "My Milestones";
                  const match = data.staffOptions.find((u) => String(u.id) === userId);
                  return match?.name ? `${match.name}'s Milestones` : "Milestones";
                })();
                return (
                  <MilestonesTable
                    title={staffLabel}
                    milestoneSections={milestoneSections}
                    milestoneCards={milestoneCards}
                    onNavigate={(href) => setLocation(href)}
                  />
                );
              })()
            )}
          </div>

          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle>Payment Voucher Actions</CardTitle>
            </CardHeader>
            <CardContent>
              {paymentVoucherActionsQuery.isError ? (
                <QueryFallback
                  title="Payment voucher actions unavailable"
                  error={paymentVoucherActionsQuery.error}
                  onRetry={() => paymentVoucherActionsQuery.refetch()}
                  isRetrying={paymentVoucherActionsQuery.isFetching}
                />
              ) : paymentVoucherActionsQuery.isLoading ? (
                <div className="text-sm text-slate-500">Loading payment voucher actions...</div>
              ) : (paymentVoucherActionsQuery.data?.length ?? 0) === 0 ? (
                <div className="text-sm text-slate-500">No assigned payment voucher actions.</div>
              ) : (
                <div className="space-y-3">
                  {(paymentVoucherActionsQuery.data ?? []).map((action) => (
                    <div key={action.id} className="rounded-lg border border-slate-200 p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="space-y-1">
                          <div className="text-sm font-semibold text-slate-900">{action.voucherNo}</div>
                          <div className="text-xs text-slate-500">
                            {action.referenceNo ? `${action.referenceNo} · ` : ""}{action.payeeName}
                          </div>
                          <div className="text-sm text-slate-700">
                            {action.customAction || action.actionType}
                          </div>
                          {action.nextActionRemarks ? (
                            <div className="text-xs text-slate-500">{action.nextActionRemarks}</div>
                          ) : null}
                          <div className="text-xs text-slate-500">
                            Assigned: {new Date(action.assignedAt).toLocaleString("en-MY")}
                          </div>
                          <div className="text-xs text-slate-500">
                            Acknowledge Due: {action.acknowledgeDueAt ? new Date(action.acknowledgeDueAt).toLocaleString("en-MY") : "—"}
                          </div>
                          <div className="text-xs text-slate-500">
                            Completion Due: {action.completionDueAt ? new Date(action.completionDueAt).toLocaleString("en-MY") : "—"}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                            {action.status.replace(/_/g, " ")}
                          </span>
                          {action.caseId ? (
                            <Button variant="outline" size="sm" onClick={() => setLocation(`/app/cases/${action.caseId}`)}>
                              Open Case
                            </Button>
                          ) : null}
                          {action.status === "assigned" ? (
                            <Button size="sm" onClick={() => acknowledgeMutation.mutate(action.id)} disabled={acknowledgeMutation.isPending}>
                              Acknowledge
                            </Button>
                          ) : null}
                          {action.status === "acknowledged" ? (
                            <Button
                              size="sm"
                              className="bg-amber-500 hover:bg-amber-600 text-white"
                              onClick={() => setCompleteActionId(action.id)}
                              disabled={completeMutation.isPending}
                            >
                              Complete Action
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

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

      <Dialog open={completeActionId != null} onOpenChange={(open) => {
        if (!open) {
          setCompleteActionId(null);
          setCompleteForm({
            actionTaken: "",
            completionNotes: "",
            completionAttachmentPath: "",
            updatedMilestone: "",
          });
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete Payment Voucher Action</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Action Taken</label>
              <Input
                placeholder="Describe what was done"
                value={completeForm.actionTaken}
                onChange={(e) => setCompleteForm((f) => ({ ...f, actionTaken: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Remarks</label>
              <Input
                placeholder="Optional remarks"
                value={completeForm.completionNotes}
                onChange={(e) => setCompleteForm((f) => ({ ...f, completionNotes: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Attachment Path</label>
              <Input
                placeholder="/objects/... optional attachment"
                value={completeForm.completionAttachmentPath}
                onChange={(e) => setCompleteForm((f) => ({ ...f, completionAttachmentPath: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Updated Milestone</label>
              <Input
                placeholder="Optional milestone update"
                value={completeForm.updatedMilestone}
                onChange={(e) => setCompleteForm((f) => ({ ...f, updatedMilestone: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteActionId(null)}>Cancel</Button>
            <Button
              className="bg-amber-500 hover:bg-amber-600 text-white"
              onClick={() => {
                if (!completeActionId) return;
                completeMutation.mutate({
                  id: completeActionId,
                  body: {
                    actionTaken: completeForm.actionTaken,
                    completionNotes: completeForm.completionNotes || undefined,
                    completionAttachmentPath: completeForm.completionAttachmentPath || undefined,
                    updatedMilestone: completeForm.updatedMilestone || undefined,
                  },
                });
              }}
              disabled={!completeActionId || !completeForm.actionTaken.trim() || completeMutation.isPending}
            >
              Complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
