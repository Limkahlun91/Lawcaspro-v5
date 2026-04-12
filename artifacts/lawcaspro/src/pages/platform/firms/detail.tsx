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
    onError: (e) => toastError(toast, e, "Reset failed"),
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
  const [activeTab, setActiveTab] = useState<"settings" | "users">("settings");

  const { data: firm, isLoading } = useGetFirm(firmId, {
    query: { enabled: !!firmId, queryKey: getGetFirmQueryKey(firmId) }
  });
  const updateFirmMutation = useUpdateFirm();
  const [status, setStatus] = useState<string>("");
  const [plan, setPlan] = useState<string>("");

  const usersQuery = useQuery<FirmUser[]>({
    queryKey: ["platform-firm-users", firmId],
    queryFn: () => apiFetchJson(`/platform/firms/${firmId}/users`),
    enabled: !!firmId && activeTab === "users",
    retry: false,
  });
  const { data: users = [], isLoading: loadingUsers } = usersQuery;

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

  if (isLoading) return <div className="p-8 text-slate-500">Loading firm details...</div>;
  if (!firm) return <div className="p-8 text-slate-500">Firm not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/platform/firms")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{firm.name}</h1>
          <p className="text-slate-500 mt-1">Workspace: {firm.slug}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Users</CardTitle>
            <Users className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{firm.userCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Cases</CardTitle>
            <Briefcase className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{firm.caseCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Created</CardTitle>
            <Building2 className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold">{new Date(firm.createdAt).toLocaleDateString()}</div>
          </CardContent>
        </Card>
      </div>

      <div className="border-b border-slate-200">
        <div className="flex gap-0">
          {(["settings", "users"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-amber-500 text-amber-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab === "settings" ? "Settings" : `Users (${firm.userCount})`}
            </button>
          ))}
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
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
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
    </div>
  );
}
