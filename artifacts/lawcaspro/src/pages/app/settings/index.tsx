import { useState, useEffect, useMemo, useRef } from "react";
import {
  getListRolesQueryKey,
  getListUsersQueryKey,
  useDeleteUser,
  useListDevelopers,
  getListDevelopersQueryKey,
  useListProjects,
  getListProjectsQueryKey,
  useListRoles,
  useListUsers,
  useUpdateRole,
  useUpdateUser,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Plus, Search, Save, Trash2, Building2, ShieldCheck, ShieldOff, Monitor, LogOut, Pencil, X, ArrowUpRight } from "lucide-react";
import { Link, useSearch } from "wouter";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { ME_QUERY_KEY } from "@/lib/query-keys";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { QueryFallback } from "@/components/query-fallback";
import DocumentTemplates from "@/pages/app/settings/DocumentTemplates";
import FirmSubscriptionFeaturesTab from "@/pages/app/settings/FirmSubscriptionFeaturesTab";
import UnifiedLogsPage from "@/pages/app/settings/logs";
import { EmailSettingsPanel } from "@/components/communication/email-settings-panel";
import { isEmailSettingsEnabled } from "@/lib/feature-flags";
import { useReAuth } from "@/components/re-auth-dialog";
import { validateUploadFile } from "@/lib/upload-validation";
import { useFeature } from "@/lib/feature-guards";

const apiFetch = apiFetchJson;

const TABS = ["Firm Info", "File Reference", "Users & Access", "Security", "Document Templates", "Subscription & Billing", "Integrations", "Logs"] as const;
type Tab = typeof TABS[number] | "Email";

const TAB_KEYS: Record<string, Tab> = {
  firm: "Firm Info",
  fileRef: "File Reference",
  users: "Users & Access",
  roles: "Users & Access",
  "users-access": "Users & Access",
  security: "Security",
  documents: "Document Templates",
  subscription: "Subscription & Billing",
  logs: "Logs",
  email: "Email",
  integrations: "Integrations",
};

const PERMISSION_CATALOG: Array<{ module: string; actions: string[] }> = [
  { module: "dashboard", actions: ["read"] },
  { module: "case_monitor", actions: ["view"] },
  { module: "file_custody", actions: ["view", "release", "receive", "archive"] },
  { module: "cases", actions: ["read", "create", "update", "delete", "assign_any"] },
  { module: "projects", actions: ["read", "create", "update", "delete"] },
  { module: "developers", actions: ["read", "create", "update", "delete"] },
  { module: "documents", actions: ["read", "create", "update", "delete", "generate", "export"] },
  { module: "communications", actions: ["read", "create", "update", "delete"] },
  { module: "accounting", actions: ["read", "write", "create", "edit", "review", "approve", "mark_received", "mark_paid", "cancel", "reopen", "export", "view_audit", "manage_settings", "override_sla"] },
  { module: "reports", actions: ["read", "export"] },
  { module: "audit", actions: ["read"] },
  { module: "settings", actions: ["read", "update"] },
  { module: "users", actions: ["read", "create", "update", "delete"] },
  { module: "roles", actions: ["read", "create", "update", "delete"] },
  { module: "developer_portal", actions: ["read", "export", "message"] },
  { module: "hr", actions: ["read", "manage"] },
  { module: "hr_enabled", actions: ["view"] },
  { module: "hr_dashboard", actions: ["read", "export"] },
  { module: "hr_settings", actions: ["view", "manage_organisation", "manage_approval_flow", "manage_feature_flags"] },
  { module: "hr_employee", actions: ["list", "view", "create", "edit", "status_change", "terminate", "reactivate", "view_salary", "edit_salary", "view_bank", "edit_bank"] },
  { module: "hr_identity_records", actions: ["view", "edit"] },
  { module: "hr_medical_records", actions: ["view", "edit"] },
  { module: "hr_disciplinary", actions: ["view", "create", "close"] },
  { module: "hr_attendance", actions: ["clock", "view_own", "view_all", "manage", "adjust", "approve_exception", "create", "read", "update"] },
  { module: "hr_leave_balance", actions: ["view_all", "adjust"] },
  { module: "hr_leave", actions: ["apply", "view_own", "cancel_own", "view_all", "approve", "approve_final", "manage_balance", "create", "read", "update"] },
  { module: "hr_claim", actions: ["submit", "view_own", "cancel_own", "view_all", "approve", "approve_final", "send_to_payroll", "send_to_accounting", "mark_paid", "create", "read", "update"] },
  { module: "hr_payroll", actions: ["view", "calculate", "submit", "approve", "lock", "request_payment", "reverse", "adjust", "supplementary_create", "manage_settings", "read", "create", "update"] },
  { module: "hr_assets", actions: ["view", "manage", "assign", "receive_return"] },
  { module: "hr_recruitment", actions: ["view", "manage", "hire"] },
  { module: "hr_performance", actions: ["view", "view_all", "manage"] },
  { module: "hr_training", actions: ["view", "manage"] },
  { module: "hr_documents", actions: ["view", "upload", "manage", "view_confidential", "view_sensitive"] },
  { module: "hr_onboarding", actions: ["manage"] },
  { module: "hr_offboarding", actions: ["initiate", "manage", "final_approve"] },
  { module: "hr_approval", actions: ["delegate", "reassign", "override"] },
  { module: "hr_reports", actions: ["view_headcount", "view_turnover", "view_leave_summary", "view_payroll_summary", "view_cost_analysis"] },
  { module: "hr_notifications", actions: ["view_overdue"] },
  { module: "hr_self_service", actions: ["read", "create", "view_profile", "edit_profile"] },
  { module: "hr_payslip", actions: ["view_own"] },
  { module: "hr_document", actions: ["view_own"] },
  { module: "hr_notification", actions: ["view_own"] },
];

type AuthSession = {
  id: number;
  createdAt: string;
  expiresAt?: string | null;
  lastSeenAt?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  isCurrent?: boolean;
};

type AuthSessionsResponse = { data: AuthSession[] };

type TotpFlagUser = { totpEnabled?: boolean };

type FirmBankAccount = {
  id: number;
  bankName: string;
  accountNo: string;
  accountType: string;
};

type FirmSettings = {
  logoUrl?: string | null;
  name?: string | null;
  address?: string | null;
  stNumber?: string | null;
  tinNumber?: string | null;
  registrationNo?: string | null;
  sstNo?: string | null;
  phone?: string | null;
  email?: string | null;
  showMasterDocuments?: boolean;
  bankAccounts?: FirmBankAccount[];
};

function SecurityTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { wrapWithReAuth } = useReAuth();

  const [totpStep, setTotpStep] = useState<"idle" | "setup" | "confirm" | "disable">("idle");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const sessionsQuery = useQuery<AuthSessionsResponse>({
    queryKey: ["auth-sessions"],
    queryFn: ({ signal }) => apiFetch<AuthSessionsResponse>("/auth/sessions", { signal }),
    retry: false,
  });
  const { data: sessionsData, isLoading: loadingSessions } = sessionsQuery;

  type TotpSetupResponse = { qrCodeDataUrl: string; secret: string };
  const setupMutation = useMutation({
    mutationFn: () => apiFetch("/auth/totp/setup", { method: "POST" }),
    onSuccess: (data: TotpSetupResponse) => {
      setQrCodeUrl(data.qrCodeDataUrl ?? "");
      setManualSecret(data.secret ?? "");
      setTotpStep("confirm");
    },
    onError: (e) => toastError(toast, e, "Setup failed"),
  });

  const confirmMutation = useMutation({
    mutationFn: () => apiFetch("/auth/totp/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: confirmCode }),
    }),
    onSuccess: () => {
      setTotpStep("idle");
      setConfirmCode("");
      queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      toast({ title: "Two-factor authentication enabled" });
      window.location.reload();
    },
    onError: (e) => toastError(toast, e, "Invalid code"),
  });

  const disableMutation = useMutation({
    mutationFn: () => wrapWithReAuth(
      (headers) => apiFetch("/auth/totp/disable", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ code: disableCode }),
      }),
      "Disabling 2FA is a sensitive action. Continue?"
    ),
    onSuccess: () => {
      setTotpStep("idle");
      setDisableCode("");
      toast({ title: "Two-factor authentication disabled" });
      window.location.reload();
    },
    onError: (e) => toastError(toast, e, "Invalid code"),
  });

  const revokeSessionMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth-sessions"] });
      toast({ title: "Session revoked" });
    },
    onError: (e) => toastError(toast, e, "Action failed"),
  });

  const totpEnabled =
    user && typeof (user as TotpFlagUser).totpEnabled === "boolean"
      ? Boolean((user as TotpFlagUser).totpEnabled)
      : false;

  const canReviewSupportRequests = hasPermission(user, "roles", "manage");
  const supportRequestsQuery = useQuery<{ items: any[] }>({
    queryKey: ["support-session-requests"],
    queryFn: ({ signal }) => apiFetch<{ items: any[] }>("/support-sessions/requests", { signal }),
    enabled: canReviewSupportRequests,
    retry: false,
  });

  const approveSupportMutation = useMutation({
    mutationFn: (id: number) => wrapWithReAuth(
      (headers) => apiFetch(`/support-sessions/${id}/approve`, { method: "POST", headers, body: JSON.stringify({ note: "" }) }),
      "Approve founder support session request?"
    ),
    onSuccess: () => {
      supportRequestsQuery.refetch();
      toast({ title: "Approved" });
    },
    onError: (e) => toastError(toast, e, "Approve failed"),
  });

  const rejectSupportMutation = useMutation({
    mutationFn: (id: number) => wrapWithReAuth(
      (headers) => apiFetch(`/support-sessions/${id}/reject`, { method: "POST", headers, body: JSON.stringify({ note: "" }) }),
      "Reject founder support session request?"
    ),
    onSuccess: () => {
      supportRequestsQuery.refetch();
      toast({ title: "Rejected" });
    },
    onError: (e) => toastError(toast, e, "Reject failed"),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" />
            Two-Factor Authentication (2FA)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {totpEnabled ? (
            <>
              <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg border border-green-200">
                <ShieldCheck className="w-5 h-5 text-green-600 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-800">Two-factor authentication is enabled</p>
                  <p className="text-xs text-green-600 mt-0.5">Your account is protected with an authenticator app.</p>
                </div>
              </div>

              {totpStep === "disable" ? (
                <div className="space-y-3 pt-2">
                  <p className="text-sm text-slate-600">Enter the 6-digit code from your authenticator app to disable 2FA.</p>
                  <div className="flex gap-3">
                    <Input
                      placeholder="000000"
                      value={disableCode}
                      onChange={e => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      className="w-40 font-mono text-center text-lg tracking-widest"
                      maxLength={6}
                    />
                    <Button
                      onClick={() => disableMutation.mutate()}
                      disabled={disableCode.length !== 6 || disableMutation.isPending}
                      variant="destructive"
                    >
                      {disableMutation.isPending ? "Disabling..." : "Disable 2FA"}
                    </Button>
                    <Button variant="ghost" onClick={() => { setTotpStep("idle"); setDisableCode(""); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => setTotpStep("disable")}
                >
                  <ShieldOff className="w-4 h-4 mr-2" />
                  Disable 2FA
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                <ShieldOff className="w-5 h-5 text-amber-600 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800">Two-factor authentication is not enabled</p>
                  <p className="text-xs text-amber-600 mt-0.5">Add an extra layer of security to your account.</p>
                </div>
              </div>

              {totpStep === "idle" && (
                <Button
                  className="bg-amber-500 hover:bg-amber-600 text-white"
                  onClick={() => { setTotpStep("setup"); setupMutation.mutate(); }}
                  disabled={setupMutation.isPending}
                >
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  {setupMutation.isPending ? "Generating..." : "Enable 2FA"}
                </Button>
              )}

              {totpStep === "confirm" && qrCodeUrl && (
                <div className="space-y-4 pt-2">
                  <div>
                    <p className="text-sm font-medium text-slate-700 mb-1">Step 1 — Scan this QR code with your authenticator app</p>
                    <p className="text-xs text-slate-500 mb-3">Use Google Authenticator, Authy, or any TOTP-compatible app.</p>
                    <div className="inline-block border border-slate-200 rounded-lg p-3 bg-white">
                      <img src={qrCodeUrl} alt="TOTP QR Code" className="w-48 h-48" />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Or enter this key manually:</p>
                    <code className="text-xs bg-slate-100 px-3 py-1.5 rounded font-mono break-all block">
                      {manualSecret}
                    </code>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-slate-700">Step 2 — Enter the 6-digit code to confirm</p>
                    <div className="flex gap-3">
                      <Input
                        placeholder="000000"
                        value={confirmCode}
                        onChange={e => setConfirmCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        className="w-40 font-mono text-center text-lg tracking-widest"
                        maxLength={6}
                      />
                      <Button
                        onClick={() => confirmMutation.mutate()}
                        disabled={confirmCode.length !== 6 || confirmMutation.isPending}
                        className="bg-amber-500 hover:bg-amber-600 text-white"
                      >
                        {confirmMutation.isPending ? "Verifying..." : "Confirm & Enable"}
                      </Button>
                      <Button variant="ghost" onClick={() => { setTotpStep("idle"); setQrCodeUrl(""); setManualSecret(""); setConfirmCode(""); }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Monitor className="w-4 h-4" />
            Active Sessions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sessionsQuery.isError ? (
            <QueryFallback title="Sessions unavailable" error={sessionsQuery.error} onRetry={() => sessionsQuery.refetch()} isRetrying={sessionsQuery.isFetching} />
          ) : loadingSessions ? (
            <div className="text-slate-500 text-sm">Loading sessions...</div>
          ) : sessionsData?.data?.length === 0 ? (
            <div className="text-slate-500 text-sm">No active sessions found.</div>
          ) : (
            <div className="space-y-2">
              {sessionsData?.data?.map((session: AuthSession) => (
                <div key={session.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {session.userAgent || "Unknown browser"}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {session.ipAddress ? `IP: ${session.ipAddress}` : "IP unknown"}
                      {" · "}
                      Started {new Date(session.createdAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
                      {" · "}
                      {session.expiresAt
                        ? `Expires ${new Date(session.expiresAt).toLocaleDateString("en-MY", { day: "numeric", month: "short" })}`
                        : "Expires —"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeSessionMutation.mutate(session.id)}
                    disabled={revokeSessionMutation.isPending}
                    className="text-red-500 hover:text-red-700 hover:bg-red-50 ml-3 shrink-0"
                  >
                    <LogOut className="w-4 h-4 mr-1" />
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {canReviewSupportRequests && (
        <Card className="border-amber-200">
          <CardHeader>
            <CardTitle className="text-base">Founder Support Requests</CardTitle>
          </CardHeader>
          <CardContent>
            {supportRequestsQuery.isError ? (
              <QueryFallback title="Support requests unavailable" error={supportRequestsQuery.error} onRetry={() => supportRequestsQuery.refetch()} isRetrying={supportRequestsQuery.isFetching} />
            ) : supportRequestsQuery.isLoading ? (
              <div className="text-slate-500 text-sm">Loading support requests...</div>
            ) : (supportRequestsQuery.data?.items?.length ?? 0) === 0 ? (
              <div className="text-slate-500 text-sm">No pending support requests.</div>
            ) : (
              <div className="space-y-2">
                {(supportRequestsQuery.data?.items ?? []).map((s: any) => (
                  <div key={String(s.id)} className="flex items-start justify-between gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900">
                        Support session #{String(s.id)}
                      </div>
                      <div className="text-xs text-slate-600 mt-0.5">
                        Requested: {s.started_at ? new Date(String(s.started_at)).toLocaleString() : "—"}
                        {s.expires_at ? ` · expires ${new Date(String(s.expires_at)).toLocaleString()}` : ""}
                      </div>
                      <div className="text-xs text-slate-700 mt-1 whitespace-pre-wrap break-words">
                        {String(s.reason ?? "")}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => approveSupportMutation.mutate(Number(s.id))}
                        disabled={approveSupportMutation.isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => rejectSupportMutation.mutate(Number(s.id))}
                        disabled={rejectSupportMutation.isPending}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FirmInfoTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canUpdate = hasPermission(user, "settings", "update");
  const firmId = user?.firmId;

  const firmSettingsQuery = useQuery<FirmSettings>({
    queryKey: ["firm-settings"],
    queryFn: async ({ signal }) => {
      const res = await apiFetchJson<any>("/firm-settings", { signal, timeoutMs: 8000 });
      return res && typeof res === "object" && "data" in res ? (res as any).data : res;
    },
    retry: false,
  });
  const settings = firmSettingsQuery.data;
  const isLoading = firmSettingsQuery.isLoading;

  const [name, setName] = useState("");
  const [selectedLogoFile, setSelectedLogoFile] = useState<File | null>(null);
  const [selectedLogoPreviewUrl, setSelectedLogoPreviewUrl] = useState<string | null>(null);
  const [savedLogoObjectPath, setSavedLogoObjectPath] = useState<string | null>(null);
  const [savedLogoPreviewUrl, setSavedLogoPreviewUrl] = useState<string | null>(null);
  const [savedLogoUpdatedAt, setSavedLogoUpdatedAt] = useState<number | null>(null);
  const [address, setAddress] = useState("");
  const [stNumber, setStNumber] = useState("");
  const [tinNumber, setTinNumber] = useState("");
  const [registrationNo, setRegistrationNo] = useState("");
  const [sstNo, setSstNo] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [showMasterDocuments, setShowMasterDocuments] = useState(true);
  const [newBankName, setNewBankName] = useState("");
  const [newAccountNo, setNewAccountNo] = useState("");
  const [newAccountType, setNewAccountType] = useState("office");
  const [editingBankId, setEditingBankId] = useState<number | null>(null);
  const [editBankName, setEditBankName] = useState("");
  const [editAccountNo, setEditAccountNo] = useState("");
  const [editAccountType, setEditAccountType] = useState("office");

  useEffect(() => {
    if (settings) {
      setName(settings.name ?? "");
      setAddress(settings.address ?? "");
      setStNumber(settings.stNumber ?? "");
      setTinNumber(settings.tinNumber ?? "");
      setRegistrationNo(settings.registrationNo ?? "");
      setSstNo(settings.sstNo ?? "");
      setPhone(settings.phone ?? "");
      setEmail(settings.email ?? "");
      setSavedLogoObjectPath(settings.logoUrl ?? "");
      setShowMasterDocuments(settings.showMasterDocuments !== false);
    }
  }, [settings]);

  useEffect(() => {
    if (!selectedLogoFile) {
      setSelectedLogoPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedLogoFile);
    setSelectedLogoPreviewUrl(url);
    return () => {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };
  }, [selectedLogoFile]);

  const savedLogoBlobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      const prev = savedLogoBlobUrlRef.current;
      if (prev) URL.revokeObjectURL(prev);
      savedLogoBlobUrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!savedLogoObjectPath) {
      setSavedLogoPreviewUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const qs = savedLogoUpdatedAt ? `?v=${String(savedLogoUpdatedAt)}` : "";
        const blob = await apiFetchBlob(`/firm-settings/logo${qs}`);
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        const prev = savedLogoBlobUrlRef.current;
        savedLogoBlobUrlRef.current = url;
        setSavedLogoPreviewUrl(url);
        if (prev && prev !== url) setTimeout(() => URL.revokeObjectURL(prev), 0);
      } catch {
        if (!cancelled) setSavedLogoPreviewUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [savedLogoObjectPath, savedLogoUpdatedAt]);

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiFetch("/firm-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      toast({ title: "Firm information updated" });
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const addBankMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiFetch("/firm-settings/bank-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: (created: FirmBankAccount) => {
      queryClient.setQueryData<FirmSettings>(["firm-settings"], (prev) => {
        if (!prev) return prev;
        const existing = Array.isArray(prev.bankAccounts) ? prev.bankAccounts : [];
        return { ...prev, bankAccounts: [...existing, created] };
      });
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      setNewBankName("");
      setNewAccountNo("");
      setNewAccountType("office");
      toast({ title: "Bank account added" });
    },
    onError: (e) => toastError(toast, e, "Failed to add bank account"),
  });

  const deleteBankMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/firm-settings/bank-accounts/${id}`, { method: "DELETE" }),
    onSuccess: (_: unknown, id: number) => {
      queryClient.setQueryData<FirmSettings>(["firm-settings"], (prev) => {
        if (!prev) return prev;
        const existing = Array.isArray(prev.bankAccounts) ? prev.bankAccounts : [];
        return { ...prev, bankAccounts: existing.filter((a) => a?.id !== id) };
      });
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      toast({ title: "Bank account removed" });
    },
    onError: (e) => toastError(toast, e, "Failed to remove bank account"),
  });

  const updateBankMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => apiFetch(`/firm-settings/bank-accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: (updated: FirmBankAccount) => {
      queryClient.setQueryData<FirmSettings>(["firm-settings"], (prev) => {
        if (!prev) return prev;
        const existing = Array.isArray(prev.bankAccounts) ? prev.bankAccounts : [];
        return { ...prev, bankAccounts: existing.map((a) => (a?.id === updated?.id ? { ...a, ...updated } : a)) };
      });
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      setEditingBankId(null);
      toast({ title: "Bank account updated" });
    },
    onError: (err) => toastError(toast, err, "Failed to update bank account"),
  });

  const handleSaveInfo = () => {
    if (!canUpdate) {
      toast({ title: "You don't have permission to update firm settings", variant: "destructive" });
      return;
    }
    updateMutation.mutate({ name, address, stNumber, tinNumber, registrationNo, sstNo, phone, email, showMasterDocuments });
  };

  const uploadLogoMutation = useMutation({
    mutationFn: async () => {
      if (!firmId) throw new Error("Missing firm context");
      if (!selectedLogoFile) throw new Error("No file selected");
      const v = validateUploadFile(selectedLogoFile, { maxBytes: 2 * 1024 * 1024, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] });
      if (!v.ok) throw new Error(v.message);

      const safeName = selectedLogoFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectPath = `/objects/templates/firms/${firmId}/branding/${crypto.randomUUID()}-${safeName}`;
      const formData = new FormData();
      formData.append("file", selectedLogoFile);
      const result = await apiFetchJson<{ objectPath: string }>(`/storage/upload?objectPath=${encodeURIComponent(objectPath)}`, { method: "POST", body: formData });
      const raw = await apiFetchJson<any>("/firm-settings", { method: "PATCH", body: JSON.stringify({ logoUrl: result.objectPath }) });
      const updated = raw && typeof raw === "object" && "data" in raw ? (raw as any).data : raw;
      const actual = typeof (updated as any)?.logoUrl === "string" ? String((updated as any).logoUrl) : "";
      if (actual !== result.objectPath) {
        throw new Error(`Logo saved path mismatch: expected ${result.objectPath} actual ${actual || "(empty)"}`);
      }
      return { objectPath: result.objectPath, updated };
    },
    onSuccess: ({ objectPath, updated }: { objectPath: string; updated: FirmSettings }) => {
      queryClient.setQueryData<FirmSettings>(["firm-settings"], updated);
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      setSavedLogoObjectPath(objectPath);
      setSavedLogoUpdatedAt(Date.now());
      setSelectedLogoFile(null);
      setSelectedLogoPreviewUrl(null);
      toast({ title: "Logo uploaded" });
    },
    onError: (e) => toastError(toast, e, "Upload failed"),
  });

  const handleAddBank = () => {
    if (!canUpdate) {
      toast({ title: "You don't have permission to update bank accounts", variant: "destructive" });
      return;
    }
    if (!newBankName.trim() || !newAccountNo.trim()) {
      toast({ title: "Bank name and account number are required", variant: "destructive" });
      return;
    }
    addBankMutation.mutate({ bankName: newBankName, accountNo: newAccountNo, accountType: newAccountType });
  };

  if (firmSettingsQuery.isError) {
    return (
      <QueryFallback
        title="Unable to load firm settings"
        error={firmSettingsQuery.error}
        onRetry={() => firmSettingsQuery.refetch()}
        isRetrying={firmSettingsQuery.isFetching}
      />
    );
  }

  if (isLoading) return <div className="py-12 text-center text-slate-500">Loading...</div>;

  const logoPreviewSrc = selectedLogoPreviewUrl ?? savedLogoPreviewUrl ?? null;
  const isUploadingLogo = uploadLogoMutation.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            Letterhead & Logo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-4 flex-wrap">
            <div className="w-[220px] h-[120px] border rounded-md bg-white flex items-center justify-center overflow-hidden">
              {logoPreviewSrc ? (
                <img src={logoPreviewSrc} alt="Firm logo" className="max-w-full max-h-full object-contain" />
              ) : (
                <div className="text-xs text-slate-400">No logo</div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-slate-500">Upload Logo (PNG/JPG/WebP)</Label>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!canUpdate || isUploadingLogo}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setSelectedLogoFile(f);
                }}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => uploadLogoMutation.mutate()}
                  disabled={!canUpdate || !selectedLogoFile || isUploadingLogo}
                >
                  {isUploadingLogo ? "Uploading..." : "Upload & Save"}
                </Button>
                {savedLogoObjectPath ? (
                  <Button
                    variant="outline"
                    onClick={() => { navigator.clipboard.writeText(savedLogoObjectPath); toast({ title: "Copied logo path" }); }}
                    disabled={isUploadingLogo}
                  >
                    Copy Path
                  </Button>
                ) : null}
              </div>
              {savedLogoObjectPath ? <div className="text-xs text-slate-500 break-all">Saved: {savedLogoObjectPath}</div> : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            Documents
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900">Show Master Documents</div>
              <div className="text-xs text-slate-600">Controls whether firm users can see platform master templates.</div>
            </div>
            <Switch checked={showMasterDocuments} onCheckedChange={setShowMasterDocuments} disabled={!canUpdate || updateMutation.isPending} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            General Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-slate-500">Firm Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} disabled={!canUpdate} />
            </div>
            <div>
              <Label className="text-xs text-slate-500">ST Number (Service Tax)</Label>
              <Input value={stNumber} onChange={e => setStNumber(e.target.value)} disabled={!canUpdate} placeholder="e.g. W10-1234-56789012" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">TIN Number (Tax Identification)</Label>
              <Input value={tinNumber} onChange={e => setTinNumber(e.target.value)} disabled={!canUpdate} placeholder="e.g. C1234567890" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Registration No. (SSM)</Label>
              <Input value={registrationNo} onChange={e => setRegistrationNo(e.target.value)} disabled={!canUpdate} placeholder="e.g. 202001234567" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">SST No.</Label>
              <Input value={sstNo} onChange={e => setSstNo(e.target.value)} disabled={!canUpdate} placeholder="e.g. W10-1234-56789012" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Phone</Label>
              <Input value={phone} onChange={e => setPhone(e.target.value)} disabled={!canUpdate} placeholder="e.g. +60 3-1234 5678" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Email</Label>
              <Input value={email} onChange={e => setEmail(e.target.value)} disabled={!canUpdate} placeholder="e.g. accounts@firm.com" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs text-slate-500">Address</Label>
              <textarea
                value={address}
                onChange={e => setAddress(e.target.value)}
                className="w-full h-20 border rounded-md px-3 py-2 text-sm resize-none"
                placeholder="Firm address"
                disabled={!canUpdate}
              />
            </div>
          </div>
          <div className="flex justify-end mt-4">
            <Button onClick={handleSaveInfo} disabled={!canUpdate || updateMutation.isPending} className="bg-amber-500 hover:bg-amber-600 text-white">
              <Save className="w-4 h-4 mr-2" />
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bank Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {(settings?.bankAccounts ?? []).length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm mb-4 min-w-[720px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-2 font-medium text-slate-600">Bank Name</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-600">Account No.</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-600">Type</th>
                    <th className="w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {(settings?.bankAccounts ?? []).map((acc: FirmBankAccount) => (
                    <tr key={acc.id} className="border-b border-slate-100">
                      {editingBankId === acc.id ? (
                        <>
                          <td className="px-4 py-2">
                            <Input value={editBankName} onChange={(e) => setEditBankName(e.target.value)} disabled={!canUpdate} />
                          </td>
                          <td className="px-4 py-2">
                            <Input value={editAccountNo} onChange={(e) => setEditAccountNo(e.target.value)} disabled={!canUpdate} />
                          </td>
                          <td className="px-4 py-2">
                            <select
                              value={editAccountType}
                              onChange={(e) => setEditAccountType(e.target.value)}
                              disabled={!canUpdate}
                              className="w-full h-9 border rounded-md px-3 text-sm bg-white"
                            >
                              <option value="office">Office</option>
                              <option value="client">Client</option>
                            </select>
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!canUpdate || updateBankMutation.isPending}
                                onClick={() => {
                                  if (!editBankName.trim() || !editAccountNo.trim()) {
                                    toast({ title: "Bank name and account number are required", variant: "destructive" });
                                    return;
                                  }
                                  updateBankMutation.mutate({
                                    id: acc.id,
                                    data: { bankName: editBankName, accountNo: editAccountNo, accountType: editAccountType },
                                  });
                                }}
                                className="h-7 w-7 p-0"
                              >
                                <Save className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!canUpdate || updateBankMutation.isPending}
                                onClick={() => setEditingBankId(null)}
                                className="h-7 w-7 p-0"
                              >
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 font-medium">{acc.bankName}</td>
                          <td className="px-4 py-3 text-slate-600">{acc.accountNo}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${
                              acc.accountType === "client" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"
                            }`}>
                              {acc.accountType}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!canUpdate}
                                onClick={() => {
                                  setEditingBankId(acc.id);
                                  setEditBankName(acc.bankName || "");
                                  setEditAccountNo(acc.accountNo || "");
                                  setEditAccountType(acc.accountType || "office");
                                }}
                                className="h-7 w-7 p-0"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!canUpdate || deleteBankMutation.isPending}
                                onClick={() => deleteBankMutation.mutate(acc.id)}
                                className="text-red-500 h-7 w-7 p-0"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Label className="text-xs text-slate-500">Bank Name</Label>
              <Input value={newBankName} onChange={e => setNewBankName(e.target.value)} disabled={!canUpdate} placeholder="e.g. Maybank" />
            </div>
            <div className="flex-1">
              <Label className="text-xs text-slate-500">Account No.</Label>
              <Input value={newAccountNo} onChange={e => setNewAccountNo(e.target.value)} disabled={!canUpdate} placeholder="e.g. 1234567890" />
            </div>
            <div className="w-32">
              <Label className="text-xs text-slate-500">Type</Label>
              <select
                value={newAccountType}
                onChange={e => setNewAccountType(e.target.value)}
                disabled={!canUpdate}
                className="w-full h-9 border rounded-md px-3 text-sm bg-white"
              >
                <option value="office">Office</option>
                <option value="client">Client</option>
              </select>
            </div>
            <Button onClick={handleAddBank} disabled={!canUpdate || addBankMutation.isPending} variant="outline" className="shrink-0">
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FileReferenceSettingsTab({ canRead, canUpdate }: { canRead: boolean; canUpdate: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const listProjectsParamsFr = { page: 1 as const, limit: 200 as const };
  const projectsQuery = useListProjects(listProjectsParamsFr, {
    query: { enabled: canRead, staleTime: 5 * 60 * 1000, queryKey: getListProjectsQueryKey(listProjectsParamsFr) },
  });
  const listDevelopersParamsFr = { page: 1 as const, limit: 200 as const };
  const developersQuery = useListDevelopers(listDevelopersParamsFr, {
    query: { enabled: canRead, staleTime: 5 * 60 * 1000, queryKey: getListDevelopersQueryKey(listDevelopersParamsFr) },
  });
  const projects = Array.isArray((projectsQuery.data as any)?.data) ? ((projectsQuery.data as any).data as any[]) : [];
  const developers = Array.isArray((developersQuery.data as any)?.data) ? ((developersQuery.data as any).data as any[]) : [];

  const toUiCaseType = useMemo(() => {
    return (caseTypeRaw: string): string => {
      const ct = String(caseTypeRaw ?? "").trim();
      const m = /^project_(\d+)$/i.exec(ct);
      if (m) return `project:${m[1]}`;
      return ct;
    };
  }, []);

  const toApiCaseType = useMemo(() => {
    return (caseTypeRaw: string): string => {
      const ct = String(caseTypeRaw ?? "").trim().toLowerCase();
      const m = /^project:(\d+)$/i.exec(ct);
      if (m) return `project_${m[1]}`;
      return ct;
    };
  }, []);

  const deriveShortCode = useMemo(() => {
    return (nameRaw: unknown, options?: { maxLen?: number; mode?: "initials" | "token" }) => {
      const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
      if (!name) return "NA";
      const maxLen = Math.max(2, Math.min(12, options?.maxLen ?? 6));
      const mode = options?.mode ?? "initials";
      if (mode === "token") {
        const token = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, maxLen);
        return token || "NA";
      }
      const parts = name.toUpperCase().replace(/[^A-Z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
      const letters = parts.map((p) => p.slice(0, 1)).join("").slice(0, maxLen);
      if (letters.length >= 2) return letters;
      return parts.join("").slice(0, maxLen) || "NA";
    };
  }, []);

  const renderPreview = useMemo(() => {
    return (patternRaw: string, args: { developerCode: string; projectCode: string; caseTypeCode: string; lawyerInitials: string; clerkInitials: string; seq: number; now?: Date }) => {
      const now = args.now ?? new Date();
      const yyyy = String(now.getFullYear()).padStart(4, "0");
      const yy = yyyy.slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const base0 = String(patternRaw || "").trim() || "{YY}/{SEQ:4}";
      const base = /\{SEQ:\d+\}/i.test(base0) ? base0 : `${base0}/{SEQ:4}`;
      const withVars = base
        .replaceAll("{YYYY}", yyyy)
        .replaceAll("{YY}", yy)
        .replaceAll("{MM}", mm)
        .replaceAll("{DEVELOPER_CODE}", args.developerCode)
        .replaceAll("{PROJECT_CODE}", args.projectCode)
        .replaceAll("{CASE_TYPE_CODE}", args.caseTypeCode)
        .replaceAll("{LAWYER_INITIALS}", args.lawyerInitials)
        .replaceAll("{CLERK_INITIALS}", args.clerkInitials);
      return withVars
        .replace(/\{SEQ:(\d+)\}/g, (_m, w: string) => String(Math.max(0, Math.trunc(args.seq))).padStart(Math.max(1, Math.min(12, Number(w))), "0"))
        .replace(/[\r\n\t]/g, " ")
        .replace(/\s+/g, "")
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .slice(0, 80);
    };
  }, []);

  const settingsQuery = useQuery<{ items: Array<{ id: number; caseType: string; formatPattern: string; startingSequence: number; currentSequence: number }> }>({
    queryKey: ["firm-file-ref-settings"],
    queryFn: () => apiFetchJson("/firm-file-ref-settings"),
    retry: false,
    enabled: canRead,
  });

  const rowKeyCounter = useRef(0);
  const makeRowKey = (): string => `tmp-${Date.now()}-${rowKeyCounter.current++}`;

  const [rows, setRows] = useState<Array<{ id?: number; rowKey: string; caseType: string; formatPattern: string; startingSequence: number; currentSequence: number }>>([]);

  useEffect(() => {
    if (!settingsQuery.data) return;
    const next = (settingsQuery.data.items ?? []).map((x) => ({
      id: Number(x.id),
      caseType: toUiCaseType(String(x.caseType || "")),
      formatPattern: String(x.formatPattern || ""),
      startingSequence: Number(x.startingSequence ?? 1000),
      currentSequence: Number(x.currentSequence ?? 0),
    }));
    setRows((prev) => {
      const byId = new Map<number, { rowKey: string }>();
      const byCaseType = new Map<string, { rowKey: string }>();
      for (const r of prev) {
        if (typeof r.id === "number" && Number.isFinite(r.id)) byId.set(r.id, r);
        if (r.caseType) byCaseType.set(r.caseType, r);
      }
      return next.map((row) => {
        const existing = (typeof row.id === "number" ? byId.get(row.id) : undefined) ?? (row.caseType ? byCaseType.get(row.caseType) : undefined);
        return { ...row, rowKey: existing?.rowKey ?? (typeof row.id === "number" ? `id-${row.id}` : makeRowKey()) };
      });
    });
  }, [settingsQuery.data]);

  const baseTemplates = useMemo(() => ([
    {
      caseType: "developer_sales",
      formatPattern: "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
      startingSequence: 1000,
      currentSequence: 1000,
    },
    {
      caseType: "subsale",
      formatPattern: "CON/SS/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
      startingSequence: 1000,
      currentSequence: 1000,
    },
    {
      caseType: "perfection",
      formatPattern: "CON/PFT/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
      startingSequence: 1000,
      currentSequence: 1000,
    },
  ]), []);

  const upsertMutation = useMutation({
    mutationFn: (row: { caseType: string; formatPattern: string; startingSequence?: number; currentSequence?: number }) =>
      apiFetchJson("/firm-file-ref-settings", {
        method: "PUT",
        body: JSON.stringify(row),
      }),
    onSuccess: async (data: any) => {
      await queryClient.invalidateQueries({ queryKey: ["firm-file-ref-settings"] });
      toast({ title: "Saved" });
      if (typeof data?.sequenceWarning === "string" && data.sequenceWarning.trim()) {
        toast({ title: data.sequenceWarning, variant: "destructive" });
      }
    },
    onError: (e: any) => toastError(toast, e, "Failed to save"),
  });

  const deleteMutation = useMutation({
    mutationFn: (caseType: string) => apiFetchJson(`/firm-file-ref-settings/${encodeURIComponent(caseType)}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["firm-file-ref-settings"] });
      toast({ title: "Deleted" });
    },
    onError: (e: any) => toastError(toast, e, "Failed to delete"),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">File Reference Templates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-slate-600">
            Supported variables: {"{YYYY}"} {"{YY}"} {"{MM}"} {"{SEQ:3}"} {"{SEQ:4}"} {"{DEVELOPER_CODE}"} {"{PROJECT_CODE}"} {"{CASE_TYPE_CODE}"} {"{LAWYER_INITIALS}"} {"{CLERK_INITIALS}"}
          </div>

          {canUpdate ? (
            <div className="flex flex-wrap gap-2">
              {baseTemplates.map((t) => (
                <Button
                  key={t.caseType}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const existing = rows.some((r) => r.caseType.trim().toLowerCase() === t.caseType);
                    if (existing) return;
                    setRows((prev) => [...prev, {
                      rowKey: makeRowKey(),
                      caseType: t.caseType,
                      formatPattern: t.formatPattern,
                      startingSequence: t.startingSequence,
                      currentSequence: t.currentSequence,
                    }]);
                  }}
                >
                  Add {t.caseType}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const pid = projects[0]?.id ? Number(projects[0].id) : null;
                  const key = pid ? `project:${pid}` : "project:1";
                  setRows((prev) => [...prev, {
                    rowKey: makeRowKey(),
                    caseType: key,
                    formatPattern: "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
                    startingSequence: 1000,
                    currentSequence: 1000,
                  }]);
                }}
                disabled={projects.length === 0}
              >
                Add Project Rule
              </Button>
          </div>
          ) : null}

          {!canRead ? (
            <div className="text-sm text-slate-500 py-6 text-center">You do not have permission to view File Reference settings.</div>
          ) : null}

          {settingsQuery.isError ? (
            <QueryFallback title="Unable to load settings" error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} isRetrying={settingsQuery.isFetching} />
          ) : settingsQuery.isLoading ? (
            <div className="text-slate-500 py-6 text-center">Loading...</div>
          ) : canRead && rows.length === 0 ? (
            <div className="py-8 text-center text-slate-600">
              <div className="font-medium">No rules yet</div>
              <div className="text-sm text-slate-500">Add a default rule or a project-specific rule to start.</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-2 font-semibold min-w-[160px]">Rule Name</th>
                    <th className="px-4 py-2 font-semibold min-w-[220px]">Applies To</th>
                    <th className="px-4 py-2 font-semibold min-w-[120px]">Developer Code</th>
                    <th className="px-4 py-2 font-semibold min-w-[120px]">Project Code</th>
                    <th className="px-4 py-2 font-semibold min-w-[220px]">Format Pattern</th>
                    <th className="px-4 py-2 font-semibold min-w-[140px]">Starting Number</th>
                    <th className="px-4 py-2 font-semibold min-w-[140px]">Next Number</th>
                    <th className="px-4 py-2 font-semibold min-w-[260px]">Preview</th>
                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row, idx) => (
                    <tr key={row.rowKey} className="hover:bg-slate-50/50">
                      <td className="px-4 py-2">
                        <Input
                          value={row.caseType}
                          onChange={(e) => {
                            const next = [...rows];
                            next[idx] = { ...row, caseType: e.target.value };
                            setRows(next);
                          }}
                          disabled={!canUpdate}
                          placeholder="e.g. subsale or project:123"
                        />
                      </td>
                      <td className="px-4 py-2 text-slate-700">
                        {(() => {
                          const ct = String(row.caseType ?? "").trim().toLowerCase();
                          if (ct.startsWith("project:") || ct.startsWith("project_")) {
                            const pid = Number(ct.replace(/^project[:_]/, ""));
                            const proj = projects.find((p: any) => Number(p.id) === pid);
                            const dev = proj?.developerId ? developers.find((d: any) => Number(d.id) === Number(proj.developerId)) : null;
                            const projectName = String(proj?.name ?? "").trim();
                            const developerName = String(dev?.name ?? "").trim();
                            const developerCode = deriveShortCode(developerName, { maxLen: 5, mode: "initials" });
                            const extra = (proj as any)?.extraFields;
                            const rawCode = extra && typeof extra === "object" ? (extra as any).projectRefCode : null;
                            const projectCode = rawCode ? deriveShortCode(String(rawCode), { maxLen: 12, mode: "token" }) : deriveShortCode(projectName, { maxLen: 12, mode: "token" });
                            return `Specific Project · ${developerCode}-${projectCode}`;
                          }
                          if (ct === "developer_sales") return "Developer Sales (Default)";
                          if (ct === "subsale") return "Subsale (Default)";
                          if (ct === "perfection") return "Perfection (Default)";
                          return `Case Type · ${ct || "—"}`;
                        })()}
                      </td>
                      <td className="px-4 py-2 text-slate-700 tabular-nums">
                        {(() => {
                          const ct = String(row.caseType ?? "").trim().toLowerCase();
                          if (ct.startsWith("project:") || ct.startsWith("project_")) {
                            const pid = Number(ct.replace(/^project[:_]/, ""));
                            const proj = projects.find((p: any) => Number(p.id) === pid);
                            const dev = proj?.developerId ? developers.find((d: any) => Number(d.id) === Number(proj.developerId)) : null;
                            return deriveShortCode(String(dev?.name ?? ""), { maxLen: 5, mode: "initials" });
                          }
                          return ct === "developer_sales" ? "AUTO" : "â€”";
                        })()}
                      </td>
                      <td className="px-4 py-2 text-slate-700 tabular-nums">
                        {(() => {
                          const ct = String(row.caseType ?? "").trim().toLowerCase();
                          if (ct.startsWith("project:") || ct.startsWith("project_")) {
                            const pid = Number(ct.replace(/^project[:_]/, ""));
                            const proj = projects.find((p: any) => Number(p.id) === pid);
                            const extra = (proj as any)?.extraFields;
                            const rawCode = extra && typeof extra === "object" ? (extra as any).projectRefCode : null;
                            return rawCode
                              ? deriveShortCode(String(rawCode), { maxLen: 12, mode: "token" })
                              : deriveShortCode(String(proj?.name ?? ""), { maxLen: 12, mode: "token" });
                          }
                          return ct === "developer_sales" ? "AUTO" : "â€”";
                        })()}
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          value={row.formatPattern}
                          onChange={(e) => {
                            const next = [...rows];
                            next[idx] = { ...row, formatPattern: e.target.value };
                            setRows(next);
                          }}
                          disabled={!canUpdate}
                          placeholder="e.g. CON/SS/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          type="number"
                          min={1}
                          value={row.startingSequence}
                          onChange={(e) => {
                            const next = [...rows];
                            next[idx] = { ...row, startingSequence: Number(e.target.value || 0) };
                            setRows(next);
                          }}
                          disabled={!canUpdate}
                          placeholder="1000"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Input
                          type="number"
                          min={1}
                          value={row.currentSequence}
                          onChange={(e) => {
                            const next = [...rows];
                            next[idx] = { ...row, currentSequence: Number(e.target.value || 0) };
                            setRows(next);
                          }}
                          disabled={!canUpdate}
                          placeholder="1000"
                        />
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">
                        {(() => {
                          const ct = String(row.caseType ?? "").trim().toLowerCase();
                          const now = new Date();
                          const lawyer = "FYS";
                          const clerk = "GHY";
                          let developerCode = "MS";
                          let projectCode = "LEGASI";
                          if (ct.startsWith("project:") || ct.startsWith("project_")) {
                            const pid = Number(ct.replace(/^project[:_]/, ""));
                            const proj = projects.find((p: any) => Number(p.id) === pid);
                            const dev = proj?.developerId ? developers.find((d: any) => Number(d.id) === Number(proj.developerId)) : null;
                            const projectName = String(proj?.name ?? "").trim();
                            const developerName = String(dev?.name ?? "").trim();
                            developerCode = deriveShortCode(developerName, { maxLen: 5, mode: "initials" });
                            const extra = (proj as any)?.extraFields;
                            const rawCode = extra && typeof extra === "object" ? (extra as any).projectRefCode : null;
                            projectCode = rawCode ? deriveShortCode(String(rawCode), { maxLen: 12, mode: "token" }) : deriveShortCode(projectName, { maxLen: 12, mode: "token" });
                          }
                          const caseTypeCode = ct.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "CASE";
                          return renderPreview(row.formatPattern, {
                            developerCode,
                            projectCode,
                            caseTypeCode,
                            lawyerInitials: lawyer,
                            clerkInitials: clerk,
                            seq: Math.max(1, Number(row.currentSequence || row.startingSequence || 1000)),
                            now,
                          });
                        })()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const caseTypeUi = row.caseType.trim();
                              const formatPattern = row.formatPattern.trim();
                              if (!caseTypeUi) {
                                toast({ title: "caseType is required", variant: "destructive" });
                                return;
                              }
                              const caseType = toApiCaseType(caseTypeUi);
                              if (!formatPattern) {
                                toast({ title: "formatPattern is required", variant: "destructive" });
                                return;
                              }
                              const startingSequence = Number(row.startingSequence || 0);
                              const currentSequence = Number(row.currentSequence || 0);
                              if (!Number.isFinite(startingSequence) || startingSequence < 1) {
                                toast({ title: "Starting Number must be 1 or higher", variant: "destructive" });
                                return;
                              }
                              if (!Number.isFinite(currentSequence) || currentSequence < 1) {
                                toast({ title: "Next Number must be 1 or higher", variant: "destructive" });
                                return;
                              }
                              upsertMutation.mutate({ caseType, formatPattern, startingSequence, currentSequence });
                            }}
                            disabled={!canUpdate || upsertMutation.isPending}
                          >
                            Save
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-red-600 hover:text-red-700"
                            onClick={() => {
                              const caseTypeUi = row.caseType.trim();
                              if (!caseTypeUi) return;
                              deleteMutation.mutate(toApiCaseType(caseTypeUi));
                            }}
                            disabled={!canUpdate || deleteMutation.isPending || !row.caseType.trim()}
                          >
                            <Trash2 className="w-4 h-4 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                        No patterns configured yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={() => setRows((prev) => [...prev, {
                rowKey: makeRowKey(),
                caseType: "",
                formatPattern: "",
                startingSequence: 1000,
                currentSequence: 1000,
              }])}
              disabled={!canUpdate}
            >
              <Plus className="w-4 h-4 mr-1" />
              Add Rule
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Settings(props?: { defaultTab?: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canManageUsers = hasPermission(user, "users", "create") || hasPermission(user, "users", "update") || hasPermission(user, "users", "delete");
  const canManageRoles = hasPermission(user, "roles", "create") || hasPermission(user, "roles", "update") || hasPermission(user, "roles", "delete");

  function isPartnerRoleName(name: string | null | undefined): boolean {
    const normalized = String(name ?? "").trim().toLowerCase();
    return (
      normalized === "partner" ||
      normalized === "managing partner" ||
      normalized === "senior partner"
    );
  }

  const isPartnerActor = isPartnerRoleName(String((user as any)?.roleName ?? ""));
  const canManageAccess = isPartnerActor;

  const canUpdateSettings = hasPermission(user, "settings", "update");
  const canReadSettings = hasPermission(user, "settings", "read") || canUpdateSettings;
  const canAccessDocuments = hasPermission(user, "documents", "read") || hasPermission(user, "documents", "create") || hasPermission(user, "documents", "update") || hasPermission(user, "documents", "delete");
  const canViewAuditLogs = user?.userType === "founder" || hasPermission(user, "audit", "read");
  const canAccessEmailSettings = isEmailSettingsEnabled() && (hasPermission(user, "communications", "read") || hasPermission(user, "communications", "create") || hasPermission(user, "communications", "update") || hasPermission(user, "communications", "delete"));
  const canAccessIntegrations = canUpdateSettings || String((user as any)?.roleName ?? "").toLowerCase().includes("partner");

  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const viewFromUrl = params.get("view");
  const visibleTabsBase: Tab[] = [
    "Firm Info",
    ...(canReadSettings ? (["File Reference"] as Tab[]) : []),
    ...(canManageAccess ? (["Users & Access"] as Tab[]) : []),
    "Security",
    "Document Templates",
    "Subscription & Billing",
    ...(canAccessIntegrations ? (["Integrations" as Tab]) : []),
    ...(canViewAuditLogs ? (["Logs"] as Tab[]) : []),
    ...(canAccessEmailSettings ? (["Email" as Tab]) : []),
  ];
  const visibleTabs = visibleTabsBase as readonly Tab[];
  const enabledTabs = visibleTabs.filter((t) => (t === "Document Templates" ? canAccessDocuments : true));
  const resolvedTabFromUrl = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : (props?.defaultTab && TAB_KEYS[props.defaultTab] ? TAB_KEYS[props.defaultTab] : null);
  const initialTab = (resolvedTabFromUrl && enabledTabs.includes(resolvedTabFromUrl)) ? resolvedTabFromUrl : "Firm Info";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const initialRoleTemplatesFromUrl = tabFromUrl === "roles" || viewFromUrl === "role-templates";
  const [roleTemplatesOpen, setRoleTemplatesOpen] = useState<boolean>(initialRoleTemplatesFromUrl);

  useEffect(() => {
    if (resolvedTabFromUrl && enabledTabs.includes(resolvedTabFromUrl)) {
      setActiveTab(resolvedTabFromUrl);
      if (tabFromUrl === "roles" || viewFromUrl === "role-templates") {
        setRoleTemplatesOpen(true);
      } else if (viewFromUrl !== null) {
        setRoleTemplatesOpen(false);
      }
      return;
    }
    if (!enabledTabs.includes(activeTab)) {
      setActiveTab("Firm Info");
    }
  }, [resolvedTabFromUrl, enabledTabs, activeTab, tabFromUrl, viewFromUrl]);
  const [userSearch, setUserSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");

  const userParams = {
    page: 1,
    limit: 50,
    search: userSearch || undefined,
    roleId: roleFilter !== "all" ? Number(roleFilter) : undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
  };
  const usersQueryKey = getListUsersQueryKey(userParams);

  const { data: usersRes, isLoading: loadingUsers } = useListUsers(
    userParams,
    {
      query: {
        queryKey: usersQueryKey,
        enabled: canManageAccess,
        staleTime: 5 * 60 * 1000,
      },
    }
  );

  const rolesQuery = useListRoles({
    query: { queryKey: getListRolesQueryKey(), enabled: canManageAccess },
  });
  const rolesRes = rolesQuery.data;
  const loadingRoles = rolesQuery.isLoading;
  const updateUserMutation = useUpdateUser();
  const updateRoleMutation = useUpdateRole();
  const deleteUserMutation = useDeleteUser();

  const [editUserOpen, setEditUserOpen] = useState(false);
  const [editUser, setEditUser] = useState<any | null>(null);
  const [editName, setEditName] = useState("");
  const [editInitials, setEditInitials] = useState("");
  const [editInitialsTouched, setEditInitialsTouched] = useState(false);
  const [editRoleId, setEditRoleId] = useState("");
  const [editDeveloperId, setEditDeveloperId] = useState("");
  const [originalEditRoleId, setOriginalEditRoleId] = useState<string>("");

  const [accessProfileLoading, setAccessProfileLoading] = useState(false);
  const [accessProfile, setAccessProfile] = useState<{
    modules: Array<{
      featureKey: string;
      label: string;
      state: "full" | "limited" | "off";
      children: Array<{ featureKey: string; label: string; enabled: boolean }>;
      allKeys?: Record<string, boolean>;
    }>;
    user?: any;
    overrideSummary?: {
      hasOverrides: boolean;
      overrideCount: number;
      explicitKeys?: string[];
    };
    preview?: boolean;
    roleName?: string | null;
  } | null>(null);
  const [featureToggles, setFeatureToggles] = useState<Record<string, boolean>>({});
  const [originalOverrideKeys, setOriginalOverrideKeys] = useState<Set<string>>(new Set());
  const [dirtyFeatureKeys, setDirtyFeatureKeys] = useState<Set<string>>(new Set());
  const [resetFeatureKeys, setResetFeatureKeys] = useState<Set<string>>(new Set());
  const [advancedAccessView, setAdvancedAccessView] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);

  useEffect(() => {
    if (!editUserOpen || !editUser?.id) {
      setAccessProfile(null);
      setAccessProfileLoading(false);
      setFeatureToggles({});
      setOriginalOverrideKeys(new Set());
      setDirtyFeatureKeys(new Set());
      setResetFeatureKeys(new Set());
      setOriginalEditRoleId("");
      return;
    }
    const currentRoleId = editRoleId ? editRoleId : (editUser?.roleId ? String(editUser.roleId) : "");
    if (originalEditRoleId === "") {
      setOriginalEditRoleId(String(editUser?.roleId ?? ""));
    }
    const targetRoleName = String(
      (currentRoleId && rolesRes)
        ? ((rolesRes ?? []).find((r: any) => String(r.id) === String(currentRoleId))?.name ?? editUser?.roleName)
        : editUser?.roleName ?? ""
    );
    if (isPartnerRoleName(targetRoleName)) {
      setAccessProfile({ modules: [], overrideSummary: { hasOverrides: false, overrideCount: 0, explicitKeys: [] }, roleName: targetRoleName });
      setFeatureToggles({});
      setOriginalOverrideKeys(new Set());
      setDirtyFeatureKeys(new Set());
      setResetFeatureKeys(new Set());
      return;
    }
    let cancelled = false;
    setAccessProfileLoading(true);
    (async () => {
      try {
        const params: Record<string, string> = {};
        const rid = editRoleId ? Number(editRoleId) : null;
        if (rid && originalEditRoleId && String(rid) !== originalEditRoleId) {
          params.previewRoleId = String(rid);
        }
        const qs = new URLSearchParams(params).toString();
        const url = `/users/${encodeURIComponent(editUser.id)}/access-profile${qs ? "?" + qs : ""}`;
        const res = await apiFetchJson<any>(url);
        if (cancelled) return;
        const data = res?.data ?? res;
        setAccessProfile(data);
        const toggles: Record<string, boolean> = {};
        for (const mod of data?.modules ?? []) {
          for (const ch of mod.children ?? []) {
            toggles[ch.featureKey] = !!ch.enabled;
          }
        }
        setFeatureToggles(toggles);
        const originalKeys = new Set<string>(data?.overrideSummary?.explicitKeys ?? []);
        setOriginalOverrideKeys(originalKeys);
        setDirtyFeatureKeys(new Set());
        setResetFeatureKeys(new Set());
      } catch (e: any) {
        if (cancelled) return;
        toast({ title: "Failed to load access profile", description: e?.error || e?.message || "Please try again.", variant: "destructive" });
        setAccessProfile({ modules: [], overrideSummary: { hasOverrides: false, overrideCount: 0, explicitKeys: [] } });
      } finally {
        if (!cancelled) setAccessProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editUserOpen, editUser?.id, editRoleId, rolesRes, originalEditRoleId]);

  const listDevelopersParamsSu = { page: 1 as const, limit: 200 as const };
  const developersQuery = useListDevelopers(listDevelopersParamsSu, {
    query: {
      enabled: canManageUsers && editUserOpen,
      staleTime: 5 * 60 * 1000,
      queryKey: getListDevelopersQueryKey(listDevelopersParamsSu),
    },
  });
  const developers = developersQuery.data?.data ?? [];

  const [deleteUserOpen, setDeleteUserOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);

  const [editRoleOpen, setEditRoleOpen] = useState(false);
  const [editRole, setEditRole] = useState<any | null>(null);
  const [editRolePermissionSet, setEditRolePermissionSet] = useState<Set<string>>(new Set());

  const bootstrapRolesMutation = useMutation({
    mutationFn: () => apiFetchJson("/roles/bootstrap", { method: "POST" }),
    onSuccess: async () => {
      await rolesQuery.refetch();
      toast({ title: "Standard roles backfilled" });
    },
    onError: (e: any) => toastError(toast, e, "Failed to backfill roles"),
  });

  const deriveInitials = useMemo(() => {
    return (name: string) => {
      const base = String(name || "").trim();
      if (!base) return "";
      return base
        .split(/\s+/g)
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("")
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 5);
    };
  }, []);

  useEffect(() => {
    if (!editUserOpen) return;
    if (editInitialsTouched) return;
    if (editInitials.trim()) return;
    setEditInitials(deriveInitials(editName));
  }, [editUserOpen, editName, editInitials, editInitialsTouched, deriveInitials]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-slate-500 mt-1">Firm preferences and configuration</p>
      </div>

      <div className="flex flex-wrap border-b border-gray-200">
        {visibleTabs.map(tab => (
          <button
            key={tab}
            onClick={() => {
              if (tab === "Document Templates" && !canAccessDocuments) {
                toast({ title: "No access", description: "You do not have permission to manage documents/templates." });
                return;
              }
              setActiveTab(tab);
            }}
            disabled={tab === "Document Templates" && !canAccessDocuments}
            className={cn(
              "px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
              tab === "Document Templates" && !canAccessDocuments && "opacity-50 cursor-not-allowed",
              activeTab === tab
                ? "border-amber-500 text-amber-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Firm Info" && <FirmInfoTab />}
      {activeTab === "File Reference" && (
        <FileReferenceSettingsTab canRead={canReadSettings} canUpdate={canUpdateSettings} />
      )}
      {activeTab === "Document Templates" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Document Templates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm text-slate-600">
                Document Templates are DOCX templates used for generating case documents. Firm Documents are your firm-level library (templates + reference files). Master Templates are system-provided templates.
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/app/documents">
                  <Button variant="outline">Open Firm Documents</Button>
                </Link>
                <Link href="/app/documents?tab=master">
                  <Button variant="outline">Open Master Templates</Button>
                </Link>
              </div>
              {!canAccessDocuments && (
                <div className="text-sm text-slate-500">
                  You do not have permission to view document templates.
                </div>
              )}
            </CardContent>
          </Card>

          {canAccessDocuments ? <DocumentTemplates /> : null}
        </div>
      )}

      {canManageAccess && activeTab === "Users & Access" && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-900">Users & Access</h2>
              <p className="mt-1 text-sm text-slate-500">Manage staff roles and what each user can access.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => setRoleTemplatesOpen((v) => !v)}
                className={roleTemplatesOpen ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100" : ""}
              >
                {roleTemplatesOpen ? "Hide Role Templates" : "Role Templates"}
              </Button>
              <Link href="/app/users/new">
                <Button className="bg-amber-500 hover:bg-amber-600 text-white">
                  <Plus className="w-4 h-4 mr-2" />
                  Add User
                </Button>
              </Link>
            </div>
          </div>

          {roleTemplatesOpen && (
            <div className="space-y-3 border border-slate-200 rounded-lg p-4 bg-slate-50/40">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-slate-800">Role Templates</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Role defaults determine a user's starting access when they are assigned that role.
                  </div>
                </div>
              </div>
              {rolesQuery.isError ? (
                <QueryFallback title="Unable to load roles" error={rolesQuery.error} onRetry={() => rolesQuery.refetch()} isRetrying={rolesQuery.isFetching} />
              ) : loadingRoles ? (
                <div className="p-6 text-center text-sm text-slate-500">Loading roles...</div>
              ) : (rolesRes ?? []).length === 0 ? (
                <div className="p-6 text-center text-sm">
                  <div className="font-medium text-slate-700">No roles found</div>
                  <div className="text-slate-500 mt-1">Standard roles were not bootstrapped. Bootstrap them now to continue.</div>
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      onClick={() => bootstrapRolesMutation.mutate()}
                      disabled={bootstrapRolesMutation.isPending}
                    >
                      {bootstrapRolesMutation.isPending ? "Backfilling..." : "Backfill Standard Roles"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {(rolesRes ?? []).map((role: any) => {
                    const roleName = role.name ? String(role.name) : "";
                    const defaultAccess = isPartnerRoleName(roleName)
                      ? "Full"
                      : (role.isSystemRole ? "Limited" : "Role Default");
                    return (
                      <Card key={role.id} className="overflow-hidden">
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-900 truncate">{role.name}</div>
                              <div className="text-xs text-slate-500 mt-0.5">
                                Users: <span className="font-medium text-slate-700">{Number(role.userCount ?? 0)}</span>
                              </div>
                            </div>
                            {role.isSystemRole && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-slate-100 text-slate-600 shrink-0">
                                System
                              </span>
                            )}
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-2">
                            <div className="text-xs text-slate-500">
                              Default Access:
                              <span className={cn(
                                "ml-1 font-medium",
                                defaultAccess === "Full"
                                  ? "text-emerald-700"
                                  : defaultAccess === "Limited"
                                  ? "text-amber-700"
                                  : "text-slate-700"
                              )}>
                                {defaultAccess}
                              </span>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setEditRole(role);
                                const allowed = new Set<string>(
                                  (Array.isArray(role.permissions) ? role.permissions : [])
                                    .filter((p: any) => p && p.allowed)
                                    .map((p: any) => `${String(p.module)}:${String(p.action)}`)
                                );
                                setEditRolePermissionSet(allowed);
                                setEditRoleOpen(true);
                              }}
                            >
                              Edit Defaults
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search name or email..."
                className="pl-9"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
              />
            </div>
            <select
              className="h-10 border border-slate-200 rounded-md px-3 text-sm bg-white"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              disabled={loadingRoles}
            >
              <option value="all">All Roles ▾</option>
              {(rolesRes ?? []).map((r: any) => (
                <option key={r.id} value={String(r.id)}>{r.name}</option>
              ))}
            </select>
            <select
              className="h-10 border border-slate-200 rounded-md px-3 text-sm bg-white"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="active">Active ▾</option>
              <option value="all">All Status</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <Card>
            <CardContent className="p-0">
              {loadingUsers ? (
                <div className="p-8 text-center text-slate-500">Loading users...</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-semibold">User</th>
                        <th className="px-6 py-3 font-semibold">Role</th>
                        <th className="px-6 py-3 font-semibold">Access</th>
                        <th className="px-6 py-3 font-semibold">Status</th>
                        <th className="px-6 py-3 font-semibold">Last Login</th>
                        <th className="px-6 py-3 font-semibold text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(usersRes?.data ?? [])
                        .map((user: any) => {
                          const roleName = user.roleName ? String(user.roleName) : "";
                          const overrideCount = Number(user.accessOverrideCount ?? 0) > 0
                            ? Number(user.accessOverrideCount)
                            : (user.hasAccessOverrides ? 1 : 0);
                          let accessLabel = "Role Default";
                          let accessBadgeClass = "bg-slate-100 text-slate-700";
                          if (isPartnerRoleName(roleName)) {
                            accessLabel = "Full Access";
                            accessBadgeClass = "bg-emerald-100 text-emerald-700";
                          } else if (String(user.status ?? "active") !== "active") {
                            accessLabel = "No Access";
                            accessBadgeClass = "bg-slate-100 text-slate-500";
                          } else if (overrideCount > 0) {
                            accessLabel = "Custom Access";
                            accessBadgeClass = "bg-amber-100 text-amber-700";
                          }
                          return (
                            <tr key={user.id} className="hover:bg-slate-50/50">
                              <td className="px-6 py-4">
                                <div className="font-medium text-slate-900">{user.name}</div>
                                <div className="text-slate-500 text-xs mt-0.5">
                                  {user.email}
                                  {user.initials ? <span className="ml-2 text-slate-600">({String(user.initials).toUpperCase()})</span> : null}
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-800">
                                  {roleName || "No Role"}
                                </span>
                              </td>
                              <td className="px-6 py-4">
                                <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium", accessBadgeClass)}>
                                  {accessLabel}
                                </span>
                              </td>
                              <td className="px-6 py-4">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  user.status === "active"
                                    ? "bg-green-100 text-green-800"
                                    : "bg-slate-100 text-slate-800"
                                }`}>
                                  {String(user.status ?? "active")}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-slate-600">
                                {user.lastLoginAt
                                  ? new Date(user.lastLoginAt).toLocaleDateString()
                                  : "Never"}
                              </td>
                              <td className="px-6 py-4 text-right">
                                <div className="inline-flex gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      setEditUser(user);
                                      setEditName(user.name || "");
                                      setEditInitials(String(user.initials ?? ""));
                                      setEditInitialsTouched(false);
                                      setEditRoleId(user.roleId ? String(user.roleId) : "");
                                      setEditDeveloperId(user.developerId ? String(user.developerId) : "");
                                      setEditUserOpen(true);
                                    }}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      const nextStatus = user.status === "active" ? "inactive" : "active";
                                      updateUserMutation.mutate(
                                        { userId: user.id, data: { status: nextStatus } },
                                        {
                                          onSuccess: () => {
                                            queryClient.invalidateQueries({ queryKey: usersQueryKey });
                                            toast({ title: `User ${nextStatus === "active" ? "activated" : "deactivated"}` });
                                          },
                                          onError: (e: any) => {
                                            toast({ title: "Failed to update status", description: e?.error || "Please try again.", variant: "destructive" });
                                          },
                                        }
                                      );
                                    }}
                                    disabled={updateUserMutation.isPending}
                                  >
                                    {user.status === "active" ? "Deactivate" : "Activate"}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-red-600 hover:text-red-700"
                                    onClick={() => {
                                      setDeleteTarget(user);
                                      setDeleteUserOpen(true);
                                    }}
                                    disabled={deleteUserMutation.isPending}
                                  >
                                    <Trash2 className="w-4 h-4 mr-1" />
                                    Delete
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      {((usersRes?.data ?? []).length) === 0 && (
                        <tr>
                          <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                            No users found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Sheet open={editUserOpen} onOpenChange={(open) => {
            setEditUserOpen(open);
            if (!open) {
              setEditUser(null);
              setEditName("");
              setEditInitials("");
              setEditInitialsTouched(false);
              setEditRoleId("");
              setEditDeveloperId("");
            }
          }}>
            <SheetContent side="right" className="w-full sm:w-[720px] max-w-full h-full overflow-y-auto flex flex-col">
              <SheetHeader>
                <SheetTitle>Edit User</SheetTitle>
              </SheetHeader>
              <div className="flex-1 space-y-5 mt-4">
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-slate-800 border-b border-slate-200 pb-2">Basic Information</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Name</Label>
                      <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input value={editUser?.email ?? ""} disabled className="bg-slate-50 text-slate-600" />
                    </div>
                    <div className="space-y-2">
                      <Label>Initials</Label>
                      <Input
                        value={editInitials}
                        onChange={(e) => {
                          setEditInitialsTouched(true);
                          setEditInitials(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5));
                        }}
                        placeholder="e.g. LKL"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <select
                        value={editUser?.status ?? "active"}
                        onChange={(e) => {
                          if (!editUser) return;
                          setEditUser({ ...editUser, status: e.target.value });
                        }}
                        className="w-full h-10 border border-slate-200 rounded-md px-3 text-sm bg-white"
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-semibold text-slate-800 border-b border-slate-200 pb-2">Role</div>
                  <div className="space-y-2">
                    <Label>Assigned Role</Label>
                    <select
                      value={editRoleId}
                      onChange={(e) => setEditRoleId(e.target.value)}
                      className="w-full h-10 border border-slate-200 rounded-md px-3 text-sm bg-white"
                      disabled={loadingRoles}
                    >
                      <option value="">(Keep current)</option>
                      {(rolesRes ?? []).map((r: any) => (
                        <option key={r.id} value={String(r.id)}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                  {(() => {
                    const roleId = editRoleId ? Number(editRoleId) : editUser?.roleId;
                    const roleName = (roleId && rolesRes)
                      ? ((rolesRes ?? []).find((r: any) => r.id === roleId)?.name ?? editUser?.roleName)
                      : editUser?.roleName;
                    if (roleName !== "Developer_User") return null;
                    return (
                      <div className="space-y-2">
                        <Label>Developer Association</Label>
                        <select
                          value={editDeveloperId}
                          onChange={(e) => setEditDeveloperId(e.target.value)}
                          className="w-full h-10 border border-slate-200 rounded-md px-3 text-sm bg-white"
                          disabled={developersQuery.isLoading}
                        >
                          <option value="">Select developer</option>
                          {(developers ?? []).map((d: any) => (
                            <option key={d.id} value={String(d.id)}>{d.name}</option>
                          ))}
                        </select>
                        {developersQuery.isError ? (
                          <div className="text-xs text-red-600">Failed to load developers</div>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                    <div className="text-sm font-semibold text-slate-800">Access</div>
                    <button
                      type="button"
                      onClick={() => setAdvancedAccessView((v) => !v)}
                      className="text-xs text-slate-500 hover:text-slate-700 underline-offset-2 hover:underline"
                    >
                      {advancedAccessView ? "Hide advanced" : "Show advanced"}
                    </button>
                  </div>

                  {(() => {
                    const resolvedRoleName = (() => {
                      const rid = editRoleId ? Number(editRoleId) : editUser?.roleId;
                      if (rid && rolesRes) {
                        const r = (rolesRes ?? []).find((x: any) => x.id === rid);
                        if (r?.name) return r.name;
                      }
                      return editUser?.roleName;
                    })();
                    const roleObj = (rolesRes ?? []).find((r: any) => String(r.name ?? "") === String(resolvedRoleName ?? ""));
                    const roleChanged = !!(
                      originalEditRoleId &&
                      editRoleId &&
                      String(originalEditRoleId) !== String(editRoleId)
                    );
                    const explicitOverrideCount = (() => {
                      const afterReset = new Set(originalOverrideKeys);
                      for (const k of resetFeatureKeys) afterReset.delete(k);
                      for (const k of dirtyFeatureKeys) afterReset.add(k);
                      return afterReset.size;
                    })();
                    const hasOverrides = explicitOverrideCount > 0;
                    return (
                      <div className="space-y-3">
                        {roleChanged && (
                          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                            <div className="font-medium">Role changed to {roleObj?.name ?? resolvedRoleName ?? "new role"}.</div>
                            <div className="text-xs text-blue-700 mt-0.5">
                              Access will use {roleObj?.name ?? resolvedRoleName ?? "role"} defaults unless you customize it below.
                            </div>
                          </div>
                        )}
                        <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-xs text-slate-600">
                            {hasOverrides ? (
                              <span><span className="font-medium text-amber-800">Custom access</span> — {explicitOverrideCount} per-user override{explicitOverrideCount === 1 ? "" : "s"} saved separately from the role.</span>
                            ) : (
                              <span>Based on <span className="font-medium text-slate-800">{roleObj?.name ?? resolvedRoleName ?? "Role"}</span> role defaults.</span>
                            )}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              if (!accessProfile?.modules?.length) return;
                              const allExplicitKeys = new Set(originalOverrideKeys);
                              for (const k of dirtyFeatureKeys) allExplicitKeys.add(k);
                              const nextReset = new Set(allExplicitKeys);
                              setResetFeatureKeys(nextReset);
                              const nextDirty = new Set(dirtyFeatureKeys);
                              for (const k of nextReset) nextDirty.delete(k);
                              setDirtyFeatureKeys(nextDirty);
                            }}
                            disabled={accessProfileLoading || accessSaving}
                          >
                            Reset to Role Defaults
                          </Button>
                        </div>
                        {isPartnerRoleName(resolvedRoleName) ? (
                          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                            <div className="font-medium">Partner has full operational access</div>
                            <div className="text-xs text-emerald-700 mt-0.5">
                              Subject to firm feature availability. No per-feature override is needed.
                            </div>
                          </div>
                        ) : accessProfileLoading ? (
                          <div className="py-6 text-center text-sm text-slate-500">Loading access profile…</div>
                        ) : !accessProfile?.modules?.length ? (
                          <div className="py-6 text-center text-sm text-slate-500">No configurable access modules for this user.</div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {accessProfile.modules.map((mod) => {
                              const total = mod.children.length || 1;
                              const onCount = mod.children.filter((c) => !!featureToggles[c.featureKey]).length;
                              let state: "full" | "limited" | "off" = "off";
                              if (mod.state !== "off") {
                                if (onCount === 0) state = "off";
                                else if (onCount === total) state = "full";
                                else state = "limited";
                              } else {
                                state = "off";
                              }
                              const applyAllOn = () => {
                                if (mod.state === "off") return;
                                const nx: Record<string, boolean> = { ...featureToggles };
                                const nd = new Set(dirtyFeatureKeys);
                                const nr = new Set(resetFeatureKeys);
                                for (const ch of mod.children) {
                                  if (nx[ch.featureKey] !== true) nd.add(ch.featureKey);
                                  nx[ch.featureKey] = true;
                                  nr.delete(ch.featureKey);
                                }
                                setFeatureToggles(nx);
                                setDirtyFeatureKeys(nd);
                                setResetFeatureKeys(nr);
                              };
                              const applyAllOff = () => {
                                if (mod.state === "off") return;
                                const nx: Record<string, boolean> = { ...featureToggles };
                                const nd = new Set(dirtyFeatureKeys);
                                const nr = new Set(resetFeatureKeys);
                                for (const ch of mod.children) {
                                  if (nx[ch.featureKey] !== false) nd.add(ch.featureKey);
                                  nx[ch.featureKey] = false;
                                  nr.delete(ch.featureKey);
                                }
                                setFeatureToggles(nx);
                                setDirtyFeatureKeys(nd);
                                setResetFeatureKeys(nr);
                              };
                              return (
                                <Card
                                  key={mod.featureKey}
                                  className={cn("overflow-hidden", mod.state === "off" && "opacity-60")}
                                >
                                  <CardHeader className="py-2.5 px-3 bg-slate-50/70 border-b border-slate-200/70 flex flex-row items-center justify-between space-y-0">
                                    <div className="flex items-center gap-2">
                                      <CardTitle className="text-sm font-medium text-slate-800">{mod.label}</CardTitle>
                                      {advancedAccessView && (
                                        <code className="text-[10px] text-slate-400 font-mono">{mod.featureKey}</code>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {mod.state !== "off" && (
                                        <div className="flex gap-1 text-[10px]">
                                          <button type="button" onClick={applyAllOn} className="px-1.5 py-0.5 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50">Full</button>
                                          <button type="button" onClick={applyAllOff} className="px-1.5 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50">Off</button>
                                        </div>
                                      )}
                                      <span className={cn(
                                        "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium",
                                        state === "full"
                                          ? "bg-emerald-100 text-emerald-700"
                                          : state === "limited"
                                          ? "bg-amber-100 text-amber-700"
                                          : "bg-slate-100 text-slate-600"
                                      )}>
                                        {state === "full" ? "Full" : state === "limited" ? "Limited" : "Off"}
                                      </span>
                                    </div>
                                  </CardHeader>
                                  {(state === "limited" || state === "off" || mod.state === "off") && (
                                    <CardContent className="p-2.5 space-y-1">
                                      {mod.children.length === 0 ? (
                                        <div className="text-xs text-slate-500 px-1 py-1">No child features.</div>
                                      ) : (
                                        mod.children.map((ch) => {
                                          const disabled = mod.state === "off";
                                          const checked = disabled ? false : !!featureToggles[ch.featureKey];
                                          return (
                                            <label
                                              key={ch.featureKey}
                                              className={cn(
                                                "flex items-start gap-2 px-1.5 py-1 rounded hover:bg-slate-50/60 cursor-pointer select-none",
                                                disabled && "cursor-not-allowed opacity-60"
                                              )}
                                            >
                                              <Checkbox
                                                className="mt-0.5"
                                                checked={checked}
                                                disabled={disabled || accessSaving}
                                                onCheckedChange={(v) => {
                                                  const next = typeof v === "boolean" ? v : !!v;
                                                  setFeatureToggles((prev) => ({ ...prev, [ch.featureKey]: next }));
                                                  setDirtyFeatureKeys((prev) => {
                                                    const nx = new Set(prev);
                                                    nx.add(ch.featureKey);
                                                    return nx;
                                                  });
                                                  setResetFeatureKeys((prev) => {
                                                    const nx = new Set(prev);
                                                    nx.delete(ch.featureKey);
                                                    return nx;
                                                  });
                                                }}
                                              />
                                              <div className="flex-1 min-w-0">
                                                <div className="text-xs text-slate-800 leading-5">{ch.label}</div>
                                                {advancedAccessView && (
                                                  <div className="text-[10px] text-slate-400 font-mono truncate">{ch.featureKey}</div>
                                                )}
                                              </div>
                                            </label>
                                          );
                                        })
                                      )}
                                    </CardContent>
                                  )}
                                  {state === "full" && (
                                    <CardContent className="px-3 py-2">
                                      <div className="text-[11px] text-emerald-700">All child features enabled.</div>
                                    </CardContent>
                                  )}
                                  {state === "off" && mod.state !== "off" && (
                                    <CardContent className="px-3 py-2">
                                      <div className="text-[11px] text-slate-500">All child features disabled.</div>
                                    </CardContent>
                                  )}
                                  {mod.state === "off" && (
                                    <CardContent className="px-3 py-2">
                                      <div className="text-[11px] text-slate-500">Module disabled at firm level. Contact Founder to enable.</div>
                                    </CardContent>
                                  )}
                                </Card>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              <SheetFooter className="mt-4 pt-4 border-t border-slate-200">
                <Button
                  variant="outline"
                  onClick={() => setEditUserOpen(false)}
                  disabled={updateUserMutation.isPending || accessSaving}
                >
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    if (!editUser?.id) return;
                    const name = editName.trim();
                    if (!name) {
                      toast({ title: "Name is required", variant: "destructive" });
                      return;
                    }
                    if (editInitials.trim() && editInitials.trim().length < 2) {
                      toast({ title: "Initials must be 2–5 characters", variant: "destructive" });
                      return;
                    }
                    let developerId: number | null = null;
                    const targetRoleName = (() => {
                      const rid = editRoleId ? Number(editRoleId) : editUser?.roleId;
                      if (rid && rolesRes) {
                        const r = (rolesRes ?? []).find((x: any) => x.id === rid);
                        if (r?.name) return r.name;
                      }
                      return editUser?.roleName;
                    })();
                    if (editRoleId) {
                      const rid = Number(editRoleId);
                      const rname = (rolesRes ?? []).find((r: any) => r.id === rid)?.name;
                      if (rname === "Developer_User") {
                        const did = Number(editDeveloperId);
                        if (!Number.isInteger(did) || did <= 0) {
                          toast({ title: "Assigned Developer is required", variant: "destructive" });
                          return;
                        }
                        developerId = did;
                      }
                    }

                    setAccessSaving(true);
                    try {
                      const dirtyEntries = [...dirtyFeatureKeys]
                        .filter((key) => !resetFeatureKeys.has(key))
                        .map((key) => [key, !!featureToggles[key]] as [string, boolean]);
                      const features = Object.fromEntries(dirtyEntries);
                      const body: Record<string, any> = {
                        name,
                        initials: editInitials.trim() ? editInitials.trim() : null,
                        status: String(editUser?.status ?? "active"),
                        features,
                      };
                      if (editRoleId) {
                        body.roleId = Number(editRoleId);
                        if (targetRoleName === "Developer_User") body.developerId = developerId;
                        else body.developerId = null;
                      }
                      if (resetFeatureKeys.size) {
                        body.resetFeatureKeys = Array.from(resetFeatureKeys);
                      }
                      const resp = await apiFetchJson<any>(
                        `/users/${encodeURIComponent(editUser.id)}/access-profile`,
                        {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(body),
                        },
                      );
                      if (resp?.error && !resp?.ok) throw new Error(resp.error);
                      await queryClient.invalidateQueries({ queryKey: usersQueryKey });
                      queryClient.invalidateQueries({ queryKey: ["firm", "user", "effective-features", ME_QUERY_KEY] });
                      queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
                      toast({ title: "User saved" });
                      setEditUserOpen(false);
                    } catch (e: any) {
                      toast({
                        title: "Failed to save user",
                        description: e?.error || e?.message || "Please try again.",
                        variant: "destructive",
                      });
                    } finally {
                      setAccessSaving(false);
                    }
                  }}
                  disabled={updateUserMutation.isPending || accessSaving || accessProfileLoading}
                >
                  {accessSaving ? "Saving…" : "Save User"}
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>

          <Dialog open={deleteUserOpen} onOpenChange={(open) => {
            setDeleteUserOpen(open);
            if (!open) setDeleteTarget(null);
          }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete User</DialogTitle>
              </DialogHeader>
              <div className="text-sm text-slate-600">
                This will permanently remove <span className="font-medium text-slate-900">{deleteTarget?.email}</span>.
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteUserOpen(false)} disabled={deleteUserMutation.isPending}>
                  Cancel
                </Button>
                <Button
                  className="bg-red-600 hover:bg-red-700"
                  onClick={() => {
                    if (!deleteTarget?.id) return;
                    deleteUserMutation.mutate(
                      { userId: deleteTarget.id },
                      {
                        onSuccess: () => {
                          queryClient.invalidateQueries({ queryKey: usersQueryKey });
                          toast({ title: "User deleted" });
                          setDeleteUserOpen(false);
                        },
                        onError: (e: any) => {
                          toast({ title: "Failed to delete user", description: e?.error || "Please try again.", variant: "destructive" });
                        },
                      }
                    );
                  }}
                  disabled={deleteUserMutation.isPending}
                >
                  Delete
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={editRoleOpen}
            onOpenChange={(open) => {
              setEditRoleOpen(open);
              if (!open) {
                setEditRole(null);
                setEditRolePermissionSet(new Set());
              }
            }}
          >
            <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Edit Role Defaults — {editRole?.name ?? ""}</DialogTitle>
              </DialogHeader>
              {isPartnerRoleName(editRole?.name) ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <div className="font-medium">Partner roles have full operational access by default.</div>
                  <div className="text-xs text-emerald-700 mt-0.5">
                    Defaults are determined by the system. Use Advanced Permissions to customize at the fine-grained level.
                  </div>
                </div>
              ) : null}
              <div className="rounded-md border border-slate-200 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Default Access Modules</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Users assigned this role receive these defaults unless they receive per-user overrides.
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAdvancedAccessView((v) => !v)}
                  >
                    {advancedAccessView ? "Hide Advanced Permissions" : "Show Advanced Permissions"}
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {(() => {
                    const moduleSummaries: Array<{ key: string; label: string; keys: string[] }> = [];
                    const seen = new Set<string>();
                    for (const group of PERMISSION_CATALOG) {
                      const key = group.module;
                      const labelHm: Record<string, string> = {
                        dashboard: "Dashboard", case_monitor: "Case Monitor", file_custody: "File Custody",
                        cases: "Cases", projects: "Projects", developers: "Developers",
                        documents: "Documents", communications: "Communication", accounting: "Accounting",
                        reports: "Reports", audit: "Audit & Logs", settings: "Settings",
                        users: "Users", roles: "Roles & Permissions", developer_portal: "Developer Portal",
                      };
                      const keysForMod: string[] = [];
                      for (const action of group.actions) {
                        const k = `${key}:${action}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        keysForMod.push(k);
                      }
                      if (keysForMod.length) {
                        moduleSummaries.push({
                          key,
                          label: labelHm[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
                          keys: keysForMod,
                        });
                      }
                    }
                    return moduleSummaries.map((mod) => {
                      const total = mod.keys.length;
                      const onCount = mod.keys.filter((k) => editRolePermissionSet.has(k)).length;
                      const state: "full" | "limited" | "off" = onCount === 0 ? "off" : onCount === total ? "full" : "limited";
                      const setAll = () => {
                        const nx = new Set(editRolePermissionSet);
                        for (const k of mod.keys) nx.add(k);
                        setEditRolePermissionSet(nx);
                      };
                      const setNone = () => {
                        const nx = new Set(editRolePermissionSet);
                        for (const k of mod.keys) nx.delete(k);
                        setEditRolePermissionSet(nx);
                      };
                      return (
                        <Card key={mod.key} className="overflow-hidden">
                          <CardHeader className="py-2.5 px-3 bg-slate-50/70 border-b border-slate-200/70 flex flex-row items-center justify-between space-y-0">
                            <div className="text-sm font-medium text-slate-800">{mod.label}</div>
                            <div className="flex items-center gap-2">
                              <span className={cn(
                                "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium",
                                state === "full" ? "bg-emerald-100 text-emerald-700"
                                  : state === "limited" ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-600"
                              )}>
                                {state === "full" ? "Full" : state === "limited" ? "Limited" : "Off"}
                              </span>
                              <div className="flex gap-1 text-[10px]">
                                <button type="button" onClick={setAll} className="px-1.5 py-0.5 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50">All</button>
                                <button type="button" onClick={setNone} className="px-1.5 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50">None</button>
                              </div>
                            </div>
                          </CardHeader>
                          {state === "limited" && advancedAccessView && (
                            <CardContent className="p-2.5 space-y-1">
                              {mod.keys.map((k) => {
                                const action = k.split(":").slice(1).join(":");
                                const checked = editRolePermissionSet.has(k);
                                return (
                                  <label key={k} className="flex items-start gap-2 px-1.5 py-1 rounded hover:bg-slate-50/60 cursor-pointer select-none">
                                    <Checkbox
                                      className="mt-0.5"
                                      checked={checked}
                                      onCheckedChange={(v) => {
                                        const nx = new Set(editRolePermissionSet);
                                        if (v) nx.add(k); else nx.delete(k);
                                        setEditRolePermissionSet(nx);
                                      }}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="text-xs text-slate-800 leading-5 capitalize">{action.replace(/_/g, " ")}</div>
                                      <div className="text-[10px] text-slate-400 font-mono truncate">{k}</div>
                                    </div>
                                  </label>
                                );
                              })}
                            </CardContent>
                          )}
                          {state === "full" && (
                            <CardContent className="px-3 py-2">
                              <div className="text-[11px] text-emerald-700">All {total} default permissions granted.</div>
                            </CardContent>
                          )}
                          {state === "off" && (
                            <CardContent className="px-3 py-2">
                              <div className="text-[11px] text-slate-500">No default permissions for this module.</div>
                            </CardContent>
                          )}
                          {state === "limited" && !advancedAccessView && (
                            <CardContent className="px-3 py-2">
                              <div className="text-[11px] text-amber-700">{onCount} of {total} default permissions enabled. Open Advanced Permissions to toggle individual keys.</div>
                            </CardContent>
                          )}
                        </Card>
                      );
                    });
                  })()}
                </div>
                {!advancedAccessView && (
                  <div className="text-xs text-slate-500 text-center pt-1">
                    Raw permission keys are hidden by default. Click "Show Advanced Permissions" to view and edit them.
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setEditRoleOpen(false)}
                  disabled={updateRoleMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    const roleId = Number(editRole?.id);
                    if (!Number.isInteger(roleId) || roleId <= 0) return;
                    const permissions = Array.from(editRolePermissionSet).map((k) => {
                      const [module, ...rest] = k.split(":");
                      return { module: String(module), action: rest.join(":"), allowed: true };
                    });
                    updateRoleMutation.mutate(
                      { roleId, data: { permissions } },
                      {
                        onSuccess: async () => {
                          await queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
                          queryClient.invalidateQueries({ queryKey: ["firm", "user", "effective-features"] });
                          toast({ title: "Role defaults updated" });
                          setEditRoleOpen(false);
                        },
                        onError: (e: any) => toastError(toast, e, "Failed to update role"),
                      }
                    );
                  }}
                  disabled={updateRoleMutation.isPending || !editRole}
                >
                  {updateRoleMutation.isPending ? "Saving..." : "Save Role Defaults"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
      {activeTab === "Security" && <SecurityTab />}

      {activeTab === "Subscription & Billing" && <FirmSubscriptionFeaturesTab firmId={user?.firmId ? Number(user.firmId) : 0} />}


      {canViewAuditLogs && activeTab === "Logs" && <UnifiedLogsPage />}

      {canAccessEmailSettings && activeTab === "Email" && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Email Settings</h2>
            <p className="mt-1 text-sm text-slate-500">
              Mailbox connection, provider setup, folder sync, import status, and sync logs are managed here instead of the daily inbox view.
            </p>
          </div>
          <EmailSettingsPanel />
        </div>
      )}

      {canAccessIntegrations && activeTab === "Integrations" && (
        <IntegrationsTab />
      )}

    </div>
  );
}

function IntegrationsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiFetch = apiFetchJson;
  const himsModule = useFeature("module.hims");
  const canConfigureHimsCredentials = useFeature("hims.credentials");
  const canConfigureHimsMapping = useFeature("hims.project_mapping");
  const canConfigureHimsStatusCheck = useFeature("hims.status_check");
  const [himsBaseUrl, setHimsBaseUrl] = useState("");
  const [himsApiKeyId, setHimsApiKeyId] = useState("");
  const [himsApiKeyMasked, setHimsApiKeyMasked] = useState("••••••••••••");
  const [himsStatusCheckEnabled, setHimsStatusCheckEnabled] = useState(true);
  const [himsStatusCheckIntervalMinutes, setHimsStatusCheckIntervalMinutes] = useState(30);
  const [savingHims, setSavingHims] = useState(false);
  const [projectMappings, setProjectMappings] = useState<Array<{ id: number; projectId: number; projectName: string; himsProjectCode: string; himsPhaseCode: string }>>([
    { id: 1, projectId: 0, projectName: "(not mapped)", himsProjectCode: "", himsPhaseCode: "" },
  ]);

  useQuery({
    queryKey: ["hims-settings-integration-settings"],
    queryFn: async ({ signal }) => {
      try {
        const res = await apiFetch<{ baseUrl?: string; apiKeyId?: string; statusCheckEnabled?: boolean; statusCheckIntervalMinutes?: number; projectMappings?: any[] }>("/hims/settings", { signal });
        if (res?.baseUrl) setHimsBaseUrl(String(res.baseUrl));
        if (res?.apiKeyId) setHimsApiKeyId(String(res.apiKeyId));
        if (typeof (res as any)?.statusCheckEnabled === "boolean") setHimsStatusCheckEnabled(Boolean((res as any).statusCheckEnabled));
        if (Number.isFinite(Number((res as any)?.statusCheckIntervalMinutes))) setHimsStatusCheckIntervalMinutes(Math.max(5, Number((res as any).statusCheckIntervalMinutes)));
        if (Array.isArray((res as any)?.projectMappings)) {
          setProjectMappings((res as any).projectMappings.map((m: any, i: number) => ({
            id: Number(m?.id ?? i + 1),
            projectId: Number(m?.projectId ?? 0),
            projectName: String(m?.projectName ?? ""),
            himsProjectCode: String(m?.himsProjectCode ?? ""),
            himsPhaseCode: String(m?.himsPhaseCode ?? ""),
          })));
        }
        return res;
      } catch (_e: any) {
        setHimsApiKeyMasked("••••••••••••");
        return null;
      }
    },
    enabled: himsModule.enabled && canConfigureHimsCredentials.enabled,
    retry: false,
    staleTime: 60_000,
  });

  const saveHimsSettings = useMutation({
    mutationFn: async () => {
      setSavingHims(true);
      await apiFetch("/hims/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: himsBaseUrl,
          apiKeyId: himsApiKeyId,
          statusCheckEnabled: himsStatusCheckEnabled,
          statusCheckIntervalMinutes: himsStatusCheckIntervalMinutes,
          projectMappings,
        }),
      });
    },
    onSuccess: () => {
      toast({ title: "HIMS / eSPA settings saved" });
      queryClient.invalidateQueries({ queryKey: ["hims-settings-integration-settings"] });
    },
    onError: (e) => toastError(toast, e, "Failed to save HIMS settings"),
    onSettled: () => setSavingHims(false),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Integrations</h2>
        <p className="mt-1 text-sm text-slate-500">
          Configure external platform integrations. Credentials never leave this page unmasked.
        </p>
      </div>

      <div className="space-y-6">
        {himsModule.enabled ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4" />
              HIMS / eSPA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
          {!canConfigureHimsCredentials.enabled ? (
            <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-4">
              You do not have permission to configure HIMS credentials. Contact a firm partner or admin.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-sm text-slate-700 bg-blue-50/60 border border-blue-200/70 rounded-lg p-4">
                <div className="font-medium text-slate-900 mb-1">HIMS / eSPA Credentials</div>
                <div className="text-xs text-slate-600 mb-2">
                  Credential and connection management has moved to the HIMS / eSPA workspace to avoid duplicate configuration paths.
                </div>
                <Link href="/app/hims" className="text-xs font-medium text-blue-700 hover:text-blue-900 underline-offset-2 hover:underline inline-flex items-center gap-1">
                  Open HIMS / eSPA workspace <ArrowUpRight className="w-3 h-3" />
                </Link>
                <div className="mt-2 text-[11px] text-slate-500">
                  Project/phase mappings and status-check settings below continue to be configured here.
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-slate-200 pt-6 space-y-4">
            <h3 className="text-sm font-medium">Status-Check Settings</h3>
            {!canConfigureHimsStatusCheck.enabled ? (
              <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-4">
                Status check configuration is not enabled.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex items-center justify-between p-3 rounded-lg border border-slate-200 bg-white">
                  <div>
                    <div className="text-sm font-medium">Enable periodic HIMS status checks</div>
                    <div className="text-xs text-slate-500">Runs automated tracker polling on the configured interval.</div>
                  </div>
                  <Switch checked={himsStatusCheckEnabled} onCheckedChange={(c) => setHimsStatusCheckEnabled(Boolean(c))} />
                </div>
                <div>
                  <Label className="text-xs text-slate-500">Check interval (minutes, minimum 5)</Label>
                  <Input
                    type="number"
                    min={5}
                    step={5}
                    value={himsStatusCheckIntervalMinutes}
                    onChange={(e) => setHimsStatusCheckIntervalMinutes(Math.max(5, Number(e.target.value) || 30))}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 pt-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Project / Phase Mappings</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProjectMappings((curr) => [
                  ...curr,
                  { id: (curr[curr.length - 1]?.id ?? curr.length) + 1, projectId: 0, projectName: "(not mapped)", himsProjectCode: "", himsPhaseCode: "" },
                ])}
              >
                <Plus className="w-4 h-4 mr-1" /> Add Mapping
              </Button>
            </div>
            {!canConfigureHimsMapping.enabled ? (
              <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-4">
                Project mapping configuration is not enabled.
              </div>
            ) : (
              <div className="space-y-3">
                {projectMappings.map((m, idx) => (
                  <div key={m.id} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end p-3 rounded-lg border border-slate-200 bg-white">
                    <div className="md:col-span-5">
                      <Label className="text-xs text-slate-500">Project</Label>
                      <Input placeholder="Project" value={m.projectName} onChange={(e) => setProjectMappings(curr => curr.map((x, i) => i === idx ? { ...x, projectName: e.target.value } : x))} />
                    </div>
                    <div className="md:col-span-3">
                      <Label className="text-xs text-slate-500">HIMS Project Code</Label>
                      <Input placeholder="e.g. PRJ-001" value={m.himsProjectCode} onChange={(e) => setProjectMappings(curr => curr.map((x, i) => i === idx ? { ...x, himsProjectCode: e.target.value } : x))} />
                    </div>
                    <div className="md:col-span-3">
                      <Label className="text-xs text-slate-500">HIMS Phase Code</Label>
                      <Input placeholder="e.g. PHASE-2A" value={m.himsPhaseCode} onChange={(e) => setProjectMappings(curr => curr.map((x, i) => i === idx ? { ...x, himsPhaseCode: e.target.value } : x))} />
                    </div>
                    <div className="md:col-span-1 flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setProjectMappings(curr => curr.filter((_x, i) => i !== idx))}>
                        <Trash2 className="w-4 h-4 text-rose-500" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {canConfigureHimsMapping.enabled && (
            <div className="flex justify-end">
              <Button onClick={() => saveHimsSettings.mutate()} disabled={savingHims}>
                <Save className="w-4 h-4 mr-2" />
                {savingHims ? "Saving..." : "Save HIMS Mapping Settings"}
              </Button>
            </div>
          )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4" />
              HIMS / eSPA
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-4">
              HIMS / eSPA integration is not enabled for this firm. Contact platform support to enable HIMS entitlements.
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}
