import { useState, useEffect } from "react";
import { getListRolesQueryKey, getListUsersQueryKey, useDeleteUser, useListRoles, useListUsers, useUpdateUser } from "@workspace/api-client-react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Search, Save, Trash2, Building2, ShieldCheck, ShieldOff, Monitor, LogOut, Pencil, X } from "lucide-react";
import { Link, useSearch } from "wouter";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { ME_QUERY_KEY } from "@/lib/query-keys";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { QueryFallback } from "@/components/query-fallback";
import DocumentTemplates from "@/pages/app/settings/DocumentTemplates";

const apiFetch = apiFetchJson;

const TABS = ["Firm Info", "Users", "Roles & Permissions", "Security", "Document Templates"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  firm: "Firm Info",
  users: "Users",
  roles: "Roles & Permissions",
  security: "Security",
  documents: "Document Templates",
};

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
  name?: string | null;
  address?: string | null;
  stNumber?: string | null;
  tinNumber?: string | null;
  bankAccounts?: FirmBankAccount[];
};

function SecurityTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

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
    mutationFn: () => apiFetch("/auth/totp/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: disableCode }),
    }),
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
    </div>
  );
}

function FirmInfoTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canUpdate = hasPermission(user, "settings", "update");

  const { data: settings, isLoading } = useQuery<FirmSettings>({
    queryKey: ["firm-settings"],
    queryFn: ({ signal }) => apiFetch<FirmSettings>("/firm-settings", { signal }),
  });

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [stNumber, setStNumber] = useState("");
  const [tinNumber, setTinNumber] = useState("");
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
    }
  }, [settings]);

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
    updateMutation.mutate({ name, address, stNumber, tinNumber });
  };

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

  if (isLoading) return <div className="py-12 text-center text-slate-500">Loading...</div>;

  return (
    <div className="space-y-6">
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
            <table className="w-full text-sm mb-4">
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

export default function Settings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canManageUsers = hasPermission(user, "users", "create") || hasPermission(user, "users", "update") || hasPermission(user, "users", "delete");
  const canManageRoles = hasPermission(user, "roles", "create") || hasPermission(user, "roles", "update") || hasPermission(user, "roles", "delete");
  const canUpdateSettings = hasPermission(user, "settings", "update");
  const canAccessDocuments = hasPermission(user, "documents", "read") || hasPermission(user, "documents", "create") || hasPermission(user, "documents", "update") || hasPermission(user, "documents", "delete");

  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const visibleTabs = ([
    "Firm Info",
    ...(canManageUsers ? (["Users"] as const) : []),
    ...(canManageRoles ? (["Roles & Permissions"] as const) : []),
    "Security",
    "Document Templates",
  ] as const) as readonly Tab[];
  const enabledTabs = visibleTabs.filter((t) => (t === "Document Templates" ? canAccessDocuments : true));
  const resolvedTabFromUrl = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : null;
  const initialTab = (resolvedTabFromUrl && enabledTabs.includes(resolvedTabFromUrl)) ? resolvedTabFromUrl : "Firm Info";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (resolvedTabFromUrl && enabledTabs.includes(resolvedTabFromUrl)) {
      setActiveTab(resolvedTabFromUrl);
      return;
    }
    if (!enabledTabs.includes(activeTab)) {
      setActiveTab("Firm Info");
    }
  }, [resolvedTabFromUrl, enabledTabs, activeTab]);
  const [userSearch, setUserSearch] = useState("");

  const userParams = {
    page: 1,
    limit: 50,
    search: userSearch || undefined,
  };

  const { data: usersRes, isLoading: loadingUsers } = useListUsers(
    userParams,
    {
      query: {
        queryKey: getListUsersQueryKey(userParams),
        enabled: canManageUsers,
      },
    }
  );

  const { data: rolesRes, isLoading: loadingRoles } = useListRoles({
    query: { queryKey: getListRolesQueryKey(), enabled: canManageRoles },
  });
  const updateUserMutation = useUpdateUser();
  const deleteUserMutation = useDeleteUser();

  const [editUserOpen, setEditUserOpen] = useState(false);
  const [editUser, setEditUser] = useState<any | null>(null);
  const [editName, setEditName] = useState("");
  const [editRoleId, setEditRoleId] = useState("");

  const [deleteUserOpen, setDeleteUserOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);

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

      {canManageUsers && activeTab === "Users" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search users..."
                className="pl-9"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
              />
            </div>
            <Link href="/app/users/new">
              <Button className="bg-amber-500 hover:bg-amber-600 text-white">
                <Plus className="w-4 h-4 mr-2" />
                New User
              </Button>
            </Link>
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
                        <th className="px-6 py-3 font-semibold">Name</th>
                        <th className="px-6 py-3 font-semibold">Role</th>
                        <th className="px-6 py-3 font-semibold">Status</th>
                        <th className="px-6 py-3 font-semibold text-right">Last Login</th>
                        <th className="px-6 py-3 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {usersRes?.data?.map((user: any) => (
                        <tr key={user.id} className="hover:bg-slate-50/50">
                          <td className="px-6 py-4">
                            <div className="font-medium text-slate-900">{user.name}</div>
                            <div className="text-slate-500 text-xs mt-0.5">{user.email}</div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-800">
                              {user.roleName || "No Role"}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              user.status === "active"
                                ? "bg-green-100 text-green-800"
                                : "bg-slate-100 text-slate-800"
                            }`}>
                              {user.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right text-slate-600">
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
                                  setEditRoleId(user.roleId ? String(user.roleId) : "");
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
                                        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
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
                      ))}
                      {usersRes?.data?.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
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

          <Dialog open={editUserOpen} onOpenChange={(open) => {
            setEditUserOpen(open);
            if (!open) {
              setEditUser(null);
              setEditName("");
              setEditRoleId("");
            }
          }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit User</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <select
                    value={editRoleId}
                    onChange={(e) => setEditRoleId(e.target.value)}
                    className="w-full h-10 border border-slate-200 rounded-md px-3 text-sm bg-white"
                    disabled={loadingRoles}
                  >
                    <option value="">(No change)</option>
                    {(rolesRes ?? []).map((r: any) => (
                      <option key={r.id} value={String(r.id)}>{r.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setEditUserOpen(false)}
                  disabled={updateUserMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (!editUser?.id) return;
                    const name = editName.trim();
                    if (!name) {
                      toast({ title: "Name is required", variant: "destructive" });
                      return;
                    }
                    const payload: any = { name };
                    if (editRoleId) payload.roleId = Number(editRoleId);
                    updateUserMutation.mutate(
                      { userId: editUser.id, data: payload },
                      {
                        onSuccess: () => {
                          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
                          toast({ title: "User updated" });
                          setEditUserOpen(false);
                        },
                        onError: (e: any) => {
                          toast({ title: "Failed to update user", description: e?.error || "Please try again.", variant: "destructive" });
                        },
                      }
                    );
                  }}
                  disabled={updateUserMutation.isPending}
                >
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

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
                          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
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
        </div>
      )}

      {activeTab === "Security" && <SecurityTab />}

      {canManageRoles && activeTab === "Roles & Permissions" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {loadingRoles ? (
              <div className="col-span-2 p-8 text-center text-slate-500">Loading roles...</div>
            ) : (
              (rolesRes ?? []).map((role: any) => (
                <Card key={role.id}>
                  <CardContent className="p-6">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="text-lg font-bold">{role.name}</h3>
                        <p className="text-sm text-slate-500">{role.userCount} users</p>
                      </div>
                      {role.isSystemRole && (
                        <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded text-xs font-medium uppercase tracking-wider">
                          System
                        </span>
                      )}
                    </div>
                    <div className="space-y-2 mt-4">
                      <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        Permissions
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {role.permissions?.slice(0, 8).map((p: any) => (
                          <span
                            key={p.id}
                            className={`px-2 py-1 rounded text-[10px] font-medium border ${
                              p.allowed
                                ? "bg-green-50 text-green-700 border-green-200"
                                : "bg-red-50 text-red-700 border-red-200"
                            }`}
                          >
                            {p.module}:{p.action}
                          </span>
                        ))}
                        {role.permissions?.length > 8 && (
                          <span className="px-2 py-1 rounded text-[10px] font-medium border bg-slate-50 text-slate-600 border-slate-200">
                            +{role.permissions.length - 8} more
                          </span>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      )}

    </div>
  );
}
