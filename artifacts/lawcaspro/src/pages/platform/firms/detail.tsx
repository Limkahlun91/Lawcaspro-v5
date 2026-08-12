import { useParams, useLocation } from "wouter";
import { useGetFirm, useUpdateFirm, getGetFirmQueryKey, getListFirmsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Building2, Users, Briefcase, Key, Eye, EyeOff, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { unwrapApiData } from "@/lib/api-contract";
import { useAuth } from "@/lib/auth-context";
import { FirmMaintenanceTab } from "@/pages/platform/firms/maintenance-tab";
import { FirmSnapshotsTab } from "@/pages/platform/firms/snapshots-tab";
import { FirmActionHistoryTab } from "@/pages/platform/firms/history-tab";
import { FirmModulesFeaturesTab } from "@/pages/platform/firms/modules-features-tab";
import { Textarea } from "@/components/ui/textarea";
import { getSupportSessionId, setSupportSessionId } from "@/lib/support-session";
import { listItems } from "@/lib/list-items";
import { PlatformPage, PlatformPageHeader } from "@/components/platform/page";
import { StatCard } from "@/components/platform/stat-card";
import { PlatformEmptyState, PlatformLoadingState } from "@/components/platform/states";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink } from "lucide-react";

interface FirmUser {
  id: number;
  email: string;
  name: string;
  userType: string;
  roleName: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

function SupportSessionPanel({ firmId, firmName }: { firmId: number; firmName: string }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [pendingSetId, setPendingSetId] = useState<string | null>(null);
  const storedId = getSupportSessionId();

  const sessionsQuery = useQuery({
    queryKey: ["platform-support-sessions", firmId],
    queryFn: async () => {
      const res = await apiFetchJson(`/support-sessions?firmId=${firmId}`);
      const items = listItems<any>(res);
      return { items };
    },
    enabled: !!firmId,
    retry: false,
  });

  const latest = (sessionsQuery.data?.items ?? [])[0] ?? null;
  const latestId = latest?.id ? String(latest.id) : null;
  const latestStatus = latest?.status ? String(latest.status) : "";
  const latestActive =
    latestStatus === "approved"
    && !latest?.endedAt
    && (!latest?.expiresAt || new Date(String(latest.expiresAt)).getTime() > Date.now());

  const requestMutation = useMutation({
    mutationFn: async () => {
      const r = reason.trim();
      if (r.length < 10) throw new Error("Reason must be at least 10 characters");
      const res = await apiFetchJson("/support-sessions", {
        method: "POST",
        body: JSON.stringify({ targetFirmId: firmId, reason: r }),
      });
      return unwrapApiData<{ item: any }>(res);
    },
    onSuccess: async (data) => {
      const id = data?.item?.id ? String(data.item.id) : null;
      if (id) {
        setSupportSessionId(id);
        toast({ title: "Support session requested", description: "Waiting for firm Partner approval." });
      } else {
        toast({ title: "Support session requested" });
      }
      setReason("");
      await qc.invalidateQueries({ queryKey: ["platform-support-sessions", firmId] });
    },
    onError: (e) => toastError(toast, e, "Request failed"),
  });

  const endMutation = useMutation({
    mutationFn: async () => {
      if (!latestId) throw new Error("No session");
      const res = await apiFetchJson(`/support-sessions/${latestId}/end`, { method: "PATCH" });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      if (storedId && latestId && storedId === latestId) setSupportSessionId(null);
      await qc.invalidateQueries({ queryKey: ["platform-support-sessions", firmId] });
      toast({ title: "Support session ended" });
    },
    onError: (e) => toastError(toast, e, "End failed"),
  });

  const setActive = async () => {
    if (!latestId) return;
    setPendingSetId(latestId);
    try {
      setSupportSessionId(latestId);
      toast({ title: "Support session set", description: `Active session: #${latestId}` });
    } finally {
      setPendingSetId(null);
    }
  };

  return (
    <Card className="border-slate-200">
      <CardHeader>
        <CardTitle className="text-base">Support Session</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sessionsQuery.isError ? (
          <QueryFallback title="Support sessions unavailable" error={sessionsQuery.error} onRetry={() => sessionsQuery.refetch()} isRetrying={sessionsQuery.isFetching} />
        ) : (
          <div className="text-sm text-slate-600">
            {latest ? (
              <div className="space-y-1">
                <div>
                  Latest: <span className="font-mono">#{String(latest.id)}</span> · <Badge variant="outline" className="text-xs">{latestStatus}</Badge>
                  {latest?.expiresAt ? <span className="text-xs text-slate-500"> · expires {new Date(String(latest.expiresAt)).toLocaleString()}</span> : null}
                </div>
                <div className="text-xs text-slate-500">Stored session: {storedId ? <span className="font-mono">#{storedId}</span> : "—"}</div>
              </div>
            ) : (
              <div>No support sessions for {firmName}.</div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-xs text-slate-500">Reason (required, min 10 chars)</div>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe the support request and intended actions." className="min-h-[80px]" />
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={() => requestMutation.mutate()}
              disabled={requestMutation.isPending || reason.trim().length < 10}
            >
              {requestMutation.isPending ? "Requesting..." : "Request Session"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setActive()}
              disabled={!latestActive || pendingSetId === latestId}
            >
              Use Approved Session
            </Button>
            <Button
              variant="outline"
              onClick={() => endMutation.mutate()}
              disabled={!latestId || endMutation.isPending || latestStatus === "ended"}
            >
              End Session
            </Button>
          </div>
          <div className="text-xs text-slate-500">
            {user?.userType === "founder"
              ? "Founder can run maintenance / snapshots / restore without waiting for a firm-approved support session."
              : "Maintenance / snapshots / restore require an approved session. Partner approval happens inside the firm workspace settings."}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ResetPasswordRow({ user, firmId }: { user: FirmUser; firmId: number }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [show, setShow] = useState(false);

  const resetMutation = useMutation({
    mutationFn: async () => {
      await apiFetchJson(`/platform/firms/${firmId}/users/${user.id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
    },
    onSuccess: () => {
      toast({ title: "Password reset", description: `${user.name}'s password has been updated.` });
      setOpen(false);
      setNewPassword("");
    },
    onError: (e) => {
      const data = (e as any)?.data as any;
      const code = data?.ok === false ? String(data?.error?.code ?? "") : "";
      const msg = (() => {
        if (code === "USER_NOT_FOUND") return "User no longer exists in this firm.";
        if (code === "INVALID_PASSWORD_POLICY") return "Password policy validation failed.";
        if (code === "QUERY_TIMEOUT") return "Request timed out. Please retry.";
        if (code === "SESSION_EXPIRED" || (e as any)?.status === 401) return "Founder session expired. Please sign in again.";
        return null;
      })();
      if (msg) {
        toast({ title: "Reset failed", description: msg, variant: "destructive" });
        return;
      }
      toastError(toast, e, "Reset failed");
    },
  });

  return (
    <div className="border-b last:border-b-0 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-slate-900">{user.name}</span>
            <Badge variant="outline" className="text-xs">{user.roleName ?? user.userType}</Badge>
            <Badge variant={user.status === "active" ? "default" : "secondary"} className="text-xs">
              {user.status}
            </Badge>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            <span className="font-mono">ID: {user.id}</span>
            <span className="mx-2">·</span>
            <span>{user.email}</span>
          </div>
          {user.lastLoginAt && (
            <div className="text-xs text-slate-400 mt-0.5">
              Last login: {new Date(user.lastLoginAt).toLocaleString()}
            </div>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(!open)}
          className="shrink-0 text-xs gap-1"
        >
          <Key className="w-3 h-3" />
          Reset Password
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </Button>
      </div>

      {open && (
        <div className="mt-3 ml-0 p-3 bg-slate-50 rounded-lg border border-slate-200">
          <p className="text-xs text-slate-500 mb-2">Set a new password for {user.name}</p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={show ? "text" : "password"}
                placeholder="New password (min 6 chars)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="pr-9 text-sm h-9"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <Button
              size="sm"
              className="h-9 text-xs"
              disabled={newPassword.length < 6 || resetMutation.isPending}
              onClick={() => resetMutation.mutate()}
            >
              {resetMutation.isPending ? <RotateCcw className="w-3.5 h-3.5 animate-spin" /> : "Confirm"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FirmDetail() {
  const { id } = useParams<{ id: string }>();
  const firmId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"settings" | "users" | "features" | "plan" | "billing" | "planbilling" | "data" | "maintenance" | "snapshots" | "history">("settings");

  const { data: firm, isLoading } = useGetFirm(firmId, {
    query: { enabled: !!firmId, queryKey: getGetFirmQueryKey(firmId) }
  });
  const updateFirmMutation = useUpdateFirm();
  const [status, setStatus] = useState<string>("");
  const [plan, setPlan] = useState<string>("");

  const plansQuery = useQuery({
    queryKey: ["subscription-plans"],
    queryFn: async () => unwrapApiData<{ items: Array<{ id: number; name: string; isActive: boolean; priceMonthlyCents?: number; description?: string }> }>(await apiFetchJson("/subscription-plans")),
    retry: false,
  });

  const planDetailQuery = useQuery({
    queryKey: ["firm-plan-detail", firmId],
    queryFn: async () => {
      try { return unwrapApiData<{ plan: { name: string; priceMonthlyCents?: number } | null; subscription: { status: string; renewsAt?: string | null } | null; lastInvoice?: { id: number; amountCents?: number; status: string; issuedAt?: string | null } | null }>(await apiFetchJson(`/founder/firms/${firmId}/plan-summary`)); }
      catch { return { plan: null, subscription: null, lastInvoice: null }; }
    },
    enabled: !!firmId,
    retry: false,
    staleTime: 60_000,
  });

  const dataMgmtQuery = useQuery({
    queryKey: ["firm-data-mgmt", firmId],
    queryFn: async () => {
      try { return unwrapApiData<{ executionAvailable: boolean; lastExecutionAt?: string | null; previewNote?: string | null }>(await apiFetchJson(`/founder/firms/${firmId}/data-management/preview`)); }
      catch { return { executionAvailable: false, lastExecutionAt: null, previewNote: null }; }
    },
    enabled: !!firmId,
    retry: false,
    staleTime: 60_000,
  });
  const executeReset = useMutation({
    mutationFn: async () => unwrapApiData(await apiFetchJson(`/founder/firms/${firmId}/data-management/execute-reset`, { method: "POST" })),
    onSuccess: () => { toast({ title: "Reset executed" }); },
    onError: (e) => toastError(toast, e, "Reset failed"),
  });

  const usersQuery = useQuery<FirmUser[]>({
    queryKey: ["platform-firm-users", firmId],
    queryFn: async () => listItems<FirmUser>(await apiFetchJson(`/platform/firms/${firmId}/users`)),
    enabled: !!firmId && activeTab === "users",
    retry: false,
  });
  const { data: users = [], isLoading: loadingUsers } = usersQuery;

  const lastMaintenanceQuery = useQuery({
    queryKey: ["platform-firm-maint-actions", firmId],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/firms/${firmId}/maintenance/actions?limit=1`);
      return unwrapApiData<{ items: any[] }>(res);
    },
    enabled: !!firmId,
    retry: false,
  });

  const lastSnapshotQuery = useQuery({
    queryKey: ["platform-firm-snapshots", firmId, "last"],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/firms/${firmId}/snapshots?limit=1`);
      return unwrapApiData<{ items: any[] }>(res);
    },
    enabled: !!firmId,
    retry: false,
  });

  const opsSummaryQuery = useQuery({
    queryKey: ["platform-firm-ops-summary", firmId],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/firms/${firmId}/ops/summary`);
      return unwrapApiData<any>(res);
    },
    enabled: !!firmId,
    retry: false,
  });

  const lastMaintenanceAt = lastMaintenanceQuery.data?.items?.[0]?.createdAt ?? null;
  const lastSnapshotAt = lastSnapshotQuery.data?.items?.[0]?.createdAt ?? null;
  const lastRestoreAt = opsSummaryQuery.data?.latest_restore?.createdAt ?? null;
  const lastRollbackAt = opsSummaryQuery.data?.latest_rollback?.createdAt ?? null;

  useEffect(() => {
    if (firm) {
      setStatus(firm.status);
      setPlan(firm.subscriptionPlan);
    }
  }, [firm]);

  const handleUpdate = () => {
    updateFirmMutation.mutate(
      { firmId, data: { status, subscriptionPlan: plan } },
      {
        onSuccess: () => {
          toast({ title: "Firm updated successfully" });
          queryClient.invalidateQueries({ queryKey: getGetFirmQueryKey(firmId) });
          queryClient.invalidateQueries({ queryKey: getListFirmsQueryKey() });
        },
        onError: (error) => toastError(toast, error, "Update failed"),
      }
    );
  };

  if (isLoading) return <PlatformLoadingState title="Loading firm details..." />;
  if (!firm) return <PlatformEmptyState title="Firm not found" description="The requested firm does not exist or you do not have access." icon={<Building2 className="w-5 h-5" />} />;

  return (
    <PlatformPage>
      <PlatformPageHeader
        title={firm.name}
        description={`Workspace: ${firm.slug}`}
        actions={
          <Button variant="outline" onClick={() => setLocation("/platform/firms")} className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back to Firms
          </Button>
        }
      />

      <div className="grid w-full min-w-0 gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <StatCard title="Total Users" value={firm.userCount} icon={<Users className="w-4 h-4" />} />
        <StatCard title="Total Cases" value={firm.caseCount} icon={<Briefcase className="w-4 h-4" />} />
        <StatCard title="Created" value={new Date(firm.createdAt).toLocaleDateString()} icon={<Building2 className="w-4 h-4" />} valueClassName="text-sm font-semibold leading-snug" />
        <StatCard title="Last maintenance" value={lastMaintenanceAt ? new Date(lastMaintenanceAt).toLocaleString() : "—"} icon={<RotateCcw className="w-4 h-4" />} valueClassName="text-sm font-semibold leading-snug" />
        <StatCard title="Last snapshot" value={lastSnapshotAt ? new Date(lastSnapshotAt).toLocaleString() : "—"} icon={<Building2 className="w-4 h-4" />} valueClassName="text-sm font-semibold leading-snug" />
        <StatCard title="Last restore" value={lastRestoreAt ? new Date(lastRestoreAt).toLocaleString() : "—"} icon={<RotateCcw className="w-4 h-4" />} valueClassName="text-sm font-semibold leading-snug" />
        <StatCard title="Last rollback" value={lastRollbackAt ? new Date(lastRollbackAt).toLocaleString() : "—"} icon={<RotateCcw className="w-4 h-4" />} valueClassName="text-sm font-semibold leading-snug" />
        <StatCard title="Pending approvals" value={opsSummaryQuery.data?.counts?.pending_approvals ?? "—"} icon={<Key className="w-4 h-4" />} />
        <StatCard title="Running maintenance" value={opsSummaryQuery.data?.counts?.running_maintenance ?? "—"} icon={<RotateCcw className="w-4 h-4" />} />
        <StatCard title="Running restore" value={opsSummaryQuery.data?.counts?.running_restore ?? "—"} icon={<RotateCcw className="w-4 h-4" />} />
      </div>

      <SupportSessionPanel firmId={firmId} firmName={firm.name} />

      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="p-4 text-sm text-amber-900 space-y-1">
          <div className="font-medium leading-snug">Safety notice</div>
          <div className="text-amber-800 leading-snug">
            High-risk actions require typed confirmation. Destructive actions automatically create a pre-action snapshot before execution.
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-slate-200 bg-slate-50">
        <div className="overflow-x-auto md:overflow-visible">
          <div className="flex gap-1 p-1 min-w-max md:min-w-0 md:flex-wrap">
            {(["settings", "users", "features", "plan", "billing", "planbilling", "data", "maintenance", "snapshots", "history"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  activeTab === tab
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900 hover:bg-white/60"
                }`}
              >
                {tab === "settings"
                  ? "Settings"
                  : tab === "users"
                    ? `Users (${firm.userCount})`
                    : tab === "features"
                      ? "Features"
                      : tab === "plan"
                        ? "Plan"
                        : tab === "billing"
                          ? "Billing"
                          : tab === "planbilling"
                            ? "Plan & Billing"
                            : tab === "data"
                              ? "Data Management"
                              : tab === "maintenance"
                                ? "Maintenance"
                                : tab === "snapshots"
                                  ? "Backups / Restore"
                                  : "Action History"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activeTab === "settings" && (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Firm Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Subscription Plan</Label>
              <Select value={plan} onValueChange={setPlan}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(plansQuery.data?.items ?? [])
                    .filter((p) => p && p.isActive)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleUpdate}
              disabled={updateFirmMutation.isPending || (status === firm.status && plan === firm.subscriptionPlan)}
            >
              {updateFirmMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === "users" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-slate-400" />
              Firm Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            {usersQuery.isError ? (
              <QueryFallback title="Users unavailable" error={usersQuery.error} onRetry={() => usersQuery.refetch()} isRetrying={usersQuery.isFetching} />
            ) : loadingUsers ? (
              <div className="text-sm text-slate-500 py-4 text-center">Loading users...</div>
            ) : users.length === 0 ? (
              <div className="text-sm text-slate-500 py-8 text-center">No users found in this firm.</div>
            ) : (
              <div>
                {users.map((user) => (
                  <ResetPasswordRow key={user.id} user={user} firmId={firmId} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "features" && (
        <FirmModulesFeaturesTab firmId={firmId} firmName={firm.name} />
      )}

      {activeTab === "plan" && (
        <Card>
          <CardHeader><CardTitle>Plan & Subscription</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card><CardContent className="p-4">
              <div className="text-xs text-slate-500 uppercase">Plan</div>
              <div className="text-2xl font-semibold mt-1">{planDetailQuery.data?.plan?.name ?? firm.subscriptionPlan ?? "—"}</div>
              <div className="text-xs text-slate-500 mt-1">
                {(planDetailQuery.data?.plan?.priceMonthlyCents ?? null) != null
                  ? `MYR ${((planDetailQuery.data?.plan?.priceMonthlyCents ?? 0) / 100).toFixed(2)}/month`
                  : "Price information not available"}
              </div>
            </CardContent></Card>
            <Card><CardContent className="p-4">
              <div className="text-xs text-slate-500 uppercase">Subscription Status</div>
              <div className="mt-1">
                <Badge variant={planDetailQuery.data?.subscription?.status === "active" ? "default" : "secondary"}>
                  {planDetailQuery.data?.subscription?.status ?? "Unknown"}
                </Badge>
              </div>
              <div className="text-xs text-slate-500 mt-2">
                {planDetailQuery.data?.subscription?.renewsAt ? `Renews: ${new Date(planDetailQuery.data.subscription.renewsAt).toLocaleDateString()}` : "Renewal date unavailable"}
              </div>
            </CardContent></Card>
            <Card><CardContent className="p-4">
              <div className="text-xs text-slate-500 uppercase">Firm Status</div>
              <div className="mt-1"><Badge variant={firm.status === "active" ? "default" : "outline"}>{firm.status}</Badge></div>
              <div className="text-xs text-slate-500 mt-2">Since {new Date(firm.createdAt).toLocaleDateString()}</div>
            </CardContent></Card>
          </CardContent>
        </Card>
      )}

      {activeTab === "billing" && (
        <Card>
          <CardHeader><CardTitle>Billing</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Button variant="outline" className="gap-2" onClick={() => setLocation("/platform/billing")}>
                <ExternalLink className="w-4 h-4" /> Go to Founder Billing
              </Button>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase mb-2">Last Invoice</div>
              {planDetailQuery.data?.lastInvoice ? (
                <Card><CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                  <div><div className="text-xs text-slate-500">Invoice ID</div><div className="font-medium">#{planDetailQuery.data.lastInvoice.id}</div></div>
                  <div><div className="text-xs text-slate-500">Amount</div><div className="font-medium">MYR {((planDetailQuery.data.lastInvoice.amountCents ?? 0) / 100).toFixed(2)}</div></div>
                  <div><div className="text-xs text-slate-500">Status</div><Badge variant="outline">{planDetailQuery.data.lastInvoice.status}</Badge></div>
                  <div><div className="text-xs text-slate-500">Issued</div><div>{planDetailQuery.data.lastInvoice.issuedAt ? new Date(planDetailQuery.data.lastInvoice.issuedAt).toLocaleDateString() : "—"}</div></div>
                </CardContent></Card>
              ) : (
                <div className="text-sm text-slate-500">No invoice history available.</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {activeTab === "planbilling" && (
        <Card>
          <CardHeader>
            <CardTitle>Plan &amp; Billing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card className="border-slate-200">
                <CardContent className="p-4 space-y-2">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Current Plan</div>
                  <div className="text-2xl font-semibold text-slate-900">{planDetailQuery.data?.plan?.name ?? firm.subscriptionPlan ?? "—"}</div>
                  <div className="text-xs text-slate-500">
                    {(planDetailQuery.data?.plan?.priceMonthlyCents ?? null) != null
                      ? `MYR ${((planDetailQuery.data?.plan?.priceMonthlyCents ?? 0) / 100).toFixed(2)}/month`
                      : "Price information not available"}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Read-only view. Use Settings tab to change the plan.</div>
                </CardContent>
              </Card>
              <Card className="border-slate-200">
                <CardContent className="p-4 space-y-2">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Subscription Status</div>
                  <div className="mt-1">
                    <Badge variant={planDetailQuery.data?.subscription?.status === "active" ? "default" : "secondary"}>
                      {planDetailQuery.data?.subscription?.status ?? "Unknown"}
                    </Badge>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {planDetailQuery.data?.subscription?.renewsAt ? `Renews on ${new Date(planDetailQuery.data.subscription.renewsAt).toLocaleDateString()}` : "Renewal date unavailable"}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">Go to Founder Billing for management.</div>
                </CardContent>
              </Card>
              <Card className="border-slate-200">
                <CardContent className="p-4 space-y-2">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Firm Status</div>
                  <div className="mt-1"><Badge variant={firm.status === "active" ? "default" : "outline"}>{firm.status}</Badge></div>
                  <div className="text-xs text-slate-500 mt-1">Customer since {new Date(firm.createdAt).toLocaleDateString()}</div>
                  <div className="text-[11px] text-slate-400 mt-1">Slug: {firm.slug}</div>
                </CardContent>
              </Card>
            </div>

            <Card className="border-slate-200 bg-slate-50/60">
              <CardContent className="p-4 space-y-2">
                <div className="text-sm font-medium text-slate-800 flex items-center justify-between">
                  <span>Last Invoice Summary</span>
                  <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => setLocation("/platform/billing")}>
                    <ExternalLink className="w-3.5 h-3.5" /> Founder Billing
                  </Button>
                </div>
                {planDetailQuery.data?.lastInvoice ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm pt-1">
                    <div>
                      <div className="text-xs text-slate-500">Invoice</div>
                      <div className="font-medium">#{planDetailQuery.data.lastInvoice.id}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Amount</div>
                      <div className="font-medium">MYR {((planDetailQuery.data.lastInvoice.amountCents ?? 0) / 100).toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Status</div>
                      <Badge variant="outline">{planDetailQuery.data.lastInvoice.status}</Badge>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Issued</div>
                      <div>{planDetailQuery.data.lastInvoice.issuedAt ? new Date(planDetailQuery.data.lastInvoice.issuedAt).toLocaleDateString() : "—"}</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">No invoice history available yet.</div>
                )}
              </CardContent>
            </Card>

            <div className="text-xs text-slate-400">
              Note: This is a read-only consolidated view. Plan changes are done via the Settings tab; billing actions are managed on Founder Billing page.
            </div>
          </CardContent>
        </Card>
      )}

      {activeTab === "data" && (
        <Card>
          <CardHeader><CardTitle>Data Management</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Card className="border-slate-200 bg-slate-50/60"><CardContent className="p-4 space-y-2">
              <div className="text-sm font-medium text-slate-800">Reset execution preview</div>
              <div className="text-xs text-slate-500">
                {dataMgmtQuery.data?.previewNote ?? "Preview available. Reset execution is not yet enabled for this firm."}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Execution available: <span className={`font-medium ${dataMgmtQuery.data?.executionAvailable ? "text-emerald-700" : "text-rose-700"}`}>
                  {dataMgmtQuery.data?.executionAvailable ? "YES" : "NO"}
                </span>
              </div>
              {dataMgmtQuery.data?.lastExecutionAt && (
                <div className="text-xs text-slate-500">Last executed: {new Date(dataMgmtQuery.data.lastExecutionAt).toLocaleString()}</div>
              )}
            </CardContent></Card>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="inline-block">
                    <Button
                      variant="destructive"
                      disabled={!dataMgmtQuery.data?.executionAvailable || executeReset.isPending}
                      onClick={() => executeReset.mutate()}
                    >
                      {executeReset.isPending ? "Executing..." : "Execute Reset"}
                    </Button>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {dataMgmtQuery.data?.executionAvailable
                    ? "Run the reset procedure now."
                    : "Reset execution is not yet enabled. Please contact the administrator to enable reset capability."}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {!dataMgmtQuery.data?.executionAvailable && (
              <div className="text-xs text-slate-500">
                Preview available. Reset execution is not yet enabled.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <Card className="border-slate-200"><CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-800">Snapshots &amp; Backups</div>
                  <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => setActiveTab("snapshots")}>
                    View
                  </Button>
                </div>
                <div className="text-xs text-slate-500">Create and manage point-in-time snapshots before running destructive resets or maintenance.</div>
                <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                  <div>
                    <div className="text-slate-500">Last snapshot</div>
                    <div className="font-medium">{lastSnapshotAt ? new Date(lastSnapshotAt).toLocaleDateString() : "—"}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Last restore</div>
                    <div className="font-medium">{lastRestoreAt ? new Date(lastRestoreAt).toLocaleDateString() : "—"}</div>
                  </div>
                </div>
                <div className="text-[11px] text-slate-400">Tip: Always create a snapshot before maintenance actions.</div>
              </CardContent></Card>
              <Card className="border-slate-200"><CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-800">Maintenance Actions</div>
                  <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => setActiveTab("maintenance")}>
                    Open
                  </Button>
                </div>
                <div className="text-xs text-slate-500">Access record-level resets, module resets, and safe maintenance tools for this firm.</div>
                <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                  <div>
                    <div className="text-slate-500">Last maintenance</div>
                    <div className="font-medium">{lastMaintenanceAt ? new Date(lastMaintenanceAt).toLocaleDateString() : "—"}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Last rollback</div>
                    <div className="font-medium">{lastRollbackAt ? new Date(lastRollbackAt).toLocaleDateString() : "—"}</div>
                  </div>
                </div>
                <div className="text-[11px] text-slate-400">Warning: Maintenance actions are audited and may require typed confirmation.</div>
              </CardContent></Card>
            </div>

            <Card className="border-slate-200 bg-slate-50/40"><CardContent className="p-4 space-y-1">
              <div className="text-sm font-medium text-slate-800">Data Lifecycle Overview (placeholder)</div>
              <div className="text-xs text-slate-500">
                Full data lifecycle controls (retention policies, archival exports, GDPR/PDPB subject access requests, and scheduled purges) will be exposed here in a future release.
              </div>
              <div className="text-[11px] text-slate-400 pt-1">For now, use the Snapshots, Maintenance, and Action History tabs for data operations.</div>
            </CardContent></Card>
          </CardContent>
        </Card>
      )}

      {activeTab === "maintenance" && (
        <FirmMaintenanceTab firmId={firmId} firmName={firm.name} />
      )}

      {activeTab === "snapshots" && (
        <FirmSnapshotsTab firmId={firmId} firmName={firm.name} />
      )}

      {activeTab === "history" && (
        <FirmActionHistoryTab firmId={firmId} />
      )}
    </PlatformPage>
  );
}
