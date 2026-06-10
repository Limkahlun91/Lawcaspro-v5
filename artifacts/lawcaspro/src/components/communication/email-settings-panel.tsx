import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";

type EmailAccount = {
  id: number;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  mailboxType: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapUsername: string | null;
  useTls: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type EmailFolder = {
  id: number;
  accountId: number;
  providerFolderId: string;
  displayName: string;
  folderType: string;
  syncEnabled: boolean;
  lastSyncAt: string | null;
};

type EmailSyncLog = {
  id: number;
  accountId: number;
  folderId: number | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  importedCount: number;
  skippedDuplicateCount: number;
  errorMessage: string | null;
  createdAt: string;
};

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    if (Array.isArray(record.items)) return record.items as T[];
    if (Array.isArray(record.rows)) return record.rows as T[];
  }
  return [];
}

function formatDateTime(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function QuerySection(props: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  onRetry: () => void;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  children: React.ReactNode;
}) {
  if (props.isError) {
    return <QueryFallback title={props.emptyTitle} error={props.error} onRetry={props.onRetry} isRetrying={props.isFetching} />;
  }
  if (props.isLoading) {
    return <div className="py-8 text-center text-sm text-slate-500">Loading...</div>;
  }
  if (props.isEmpty) {
    return (
      <div className="rounded-lg border border-dashed bg-slate-50 px-4 py-8 text-center">
        <div className="text-sm font-medium text-slate-900">{props.emptyTitle}</div>
        <div className="mt-1 text-sm text-slate-500">{props.emptyDescription}</div>
      </div>
    );
  }
  return <>{props.children}</>;
}

export function EmailSettingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [connectProvider, setConnectProvider] = useState("microsoft_graph");
  const [gmailPlaceholderForm, setGmailPlaceholderForm] = useState({ emailAddress: "", displayName: "" });
  const [imapForm, setImapForm] = useState({
    emailAddress: "",
    displayName: "",
    host: "",
    port: "993",
    username: "",
    password: "",
    useTls: true,
  });

  const emailAccountsQuery = useQuery<EmailAccount[]>({
    queryKey: ["communication", "email", "accounts"],
    queryFn: () => apiFetchJson("/communication/email/accounts").then((r) => asArray<EmailAccount>(r)),
    retry: false,
  });
  const emailAccounts = asArray<EmailAccount>(emailAccountsQuery.data);

  useEffect(() => {
    if (!emailAccounts.length) {
      setSelectedAccountId(null);
      return;
    }
    setSelectedAccountId((prev) => (prev && emailAccounts.some((account) => account.id === prev) ? prev : emailAccounts[0].id));
  }, [emailAccounts]);

  const selectedAccount = emailAccounts.find((account) => account.id === selectedAccountId) ?? null;

  const selectedAccountFoldersQuery = useQuery<EmailFolder[]>({
    queryKey: ["communication", "email", "accounts", selectedAccountId, "folders"],
    queryFn: () => apiFetchJson(`/communication/email/accounts/${selectedAccountId}/folders`).then((r) => asArray<EmailFolder>(r)),
    enabled: typeof selectedAccountId === "number",
    retry: false,
  });
  const selectedAccountFolders = asArray<EmailFolder>(selectedAccountFoldersQuery.data);

  const selectedAccountLogsQuery = useQuery<EmailSyncLog[]>({
    queryKey: ["communication", "email", "accounts", selectedAccountId, "sync-logs"],
    queryFn: () => apiFetchJson(`/communication/email/accounts/${selectedAccountId}/sync-logs?limit=20`).then((r) => asArray<EmailSyncLog>(r)),
    enabled: typeof selectedAccountId === "number",
    retry: false,
  });
  const selectedAccountLogs = asArray<EmailSyncLog>(selectedAccountLogsQuery.data);

  const createEmailAccountMutation = useMutation({
    mutationFn: () => apiFetchJson("/communication/email/accounts", { method: "POST", body: { provider: "gmail", ...gmailPlaceholderForm } }),
    onSuccess: () => {
      setConnectDialogOpen(false);
      setGmailPlaceholderForm({ emailAddress: "", displayName: "" });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      toast({ title: "Gmail placeholder saved" });
    },
    onError: (e) => toastError(toast, e),
  });

  const startMicrosoftConnectMutation = useMutation({
    mutationFn: () => apiFetchJson<{ url: string }>(`/communication/email/microsoft/connect?returnTo=${encodeURIComponent(window.location.href)}`),
    onSuccess: (result) => {
      if (result?.url) window.location.assign(result.url);
    },
    onError: (e) => toastError(toast, e),
  });

  const testImapMutation = useMutation({
    mutationFn: () => apiFetchJson("/communication/email/imap/test", {
      method: "POST",
      body: {
        emailAddress: imapForm.emailAddress,
        displayName: imapForm.displayName || null,
        host: imapForm.host,
        port: parseInt(imapForm.port, 10) || 993,
        username: imapForm.username,
        password: imapForm.password,
        useTls: imapForm.useTls,
      },
    }),
    onSuccess: () => toast({ title: "IMAP connection succeeded" }),
    onError: (e) => toastError(toast, e),
  });

  const connectImapMutation = useMutation({
    mutationFn: () => apiFetchJson<{ account: EmailAccount }>(`/communication/email/imap/connect`, {
      method: "POST",
      body: {
        emailAddress: imapForm.emailAddress,
        displayName: imapForm.displayName || null,
        host: imapForm.host,
        port: parseInt(imapForm.port, 10) || 993,
        username: imapForm.username,
        password: imapForm.password,
        useTls: imapForm.useTls,
      },
    }),
    onSuccess: (result) => {
      setConnectDialogOpen(false);
      setImapForm({ emailAddress: "", displayName: "", host: "", port: "993", username: "", password: "", useTls: true });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      if (result?.account?.id) setSelectedAccountId(result.account.id);
      toast({ title: "IMAP mailbox connected" });
    },
    onError: (e) => toastError(toast, e),
  });

  const syncFoldersMutation = useMutation({
    mutationFn: (accountId: number) => apiFetchJson(`/communication/email/accounts/${accountId}/sync-folders`, { method: "POST", body: {} }),
    onSuccess: (_result, accountId) => {
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", accountId, "folders"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      toast({ title: "Mailbox folders synced" });
    },
    onError: (e) => toastError(toast, e),
  });

  const toggleFolderSyncMutation = useMutation({
    mutationFn: (args: { folderId: number; syncEnabled: boolean }) =>
      apiFetchJson(`/communication/email/folders/${args.folderId}`, { method: "PATCH", body: { syncEnabled: args.syncEnabled } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", selectedAccountId, "folders"] });
      toast({ title: "Folder sync updated" });
    },
    onError: (e) => toastError(toast, e),
  });

  const importEmailMutation = useMutation({
    mutationFn: (accountId: number) =>
      apiFetchJson<{ ok: boolean; importedCount: number; skippedDuplicateCount: number }>(`/communication/email/accounts/${accountId}/import-now`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (result, accountId) => {
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", accountId, "sync-logs"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", accountId, "folders"] });
      toast({
        title: "Import completed",
        description: `Imported ${result.importedCount} emails, skipped ${result.skippedDuplicateCount} duplicates.`,
      });
    },
    onError: (e) => toastError(toast, e),
  });

  const disconnectEmailAccountMutation = useMutation({
    mutationFn: (accountId: number) => apiFetchJson(`/communication/email/accounts/${accountId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      toast({ title: "Mailbox disconnected" });
    },
    onError: (e) => toastError(toast, e),
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const providerStatus = params.get("providerStatus");
    if (!providerStatus) return;
    const provider = params.get("provider");
    const providerError = params.get("providerError");
    const accountIdRaw = params.get("accountId");
    if (providerStatus === "connected") {
      toast({ title: provider === "microsoft_graph" ? "Microsoft 365 mailbox connected" : "Mailbox connected" });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      if (accountIdRaw) {
        const accountId = parseInt(accountIdRaw, 10);
        if (Number.isFinite(accountId)) setSelectedAccountId(accountId);
      }
    } else if (providerStatus === "error") {
      toast({
        title: "Mailbox connection failed",
        description: providerError || "Provider setup could not be completed.",
        variant: "destructive",
      });
    }
    params.delete("providerStatus");
    params.delete("provider");
    params.delete("providerError");
    params.delete("accountId");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, [qc, toast]);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
    qc.invalidateQueries({ queryKey: ["communication", "messages"] });
    if (selectedAccountId != null) {
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", selectedAccountId, "folders"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", selectedAccountId, "sync-logs"] });
    }
  };

  const selectedAccountSyncEnabledFolders = selectedAccountFolders.filter((folder) => folder.syncEnabled);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">Email Settings</div>
          <div className="text-sm text-slate-500">
            Manage Microsoft 365, IMAP, Gmail placeholder, folder sync, import runs, and mailbox connection status.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={refreshAll}>
            Refresh
          </Button>
          <Button variant="outline" onClick={() => selectedAccount && syncFoldersMutation.mutate(selectedAccount.id)} disabled={!selectedAccount || syncFoldersMutation.isPending}>
            Sync Folders
          </Button>
          <Button variant="outline" onClick={() => selectedAccount && importEmailMutation.mutate(selectedAccount.id)} disabled={!selectedAccount || importEmailMutation.isPending}>
            Import Now
          </Button>
          <Button onClick={() => setConnectDialogOpen(true)}>Connect Mailbox</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Setup Warnings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-600">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                Microsoft 365 requires <span className="font-medium">MICROSOFT_CLIENT_ID</span>, <span className="font-medium">MICROSOFT_CLIENT_SECRET</span>, and <span className="font-medium">MICROSOFT_REDIRECT_URI</span>.
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                Credential storage requires <span className="font-medium">EMAIL_TOKEN_ENCRYPTION_KEY</span>. If missing, connect/test/save will fail and no credential will be stored.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Connected Accounts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <QuerySection
                isLoading={emailAccountsQuery.isLoading}
                isError={emailAccountsQuery.isError}
                error={emailAccountsQuery.error}
                isFetching={emailAccountsQuery.isFetching}
                onRetry={() => emailAccountsQuery.refetch()}
                isEmpty={emailAccounts.length === 0}
                emptyTitle="No mailbox accounts"
                emptyDescription="Connect Microsoft 365 or IMAP to start importing email."
              >
                {emailAccounts.map((account) => (
                  <button
                    key={account.id}
                    className={[
                      "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      selectedAccountId === account.id ? "border-slate-400 bg-slate-50" : "hover:bg-slate-50",
                    ].join(" ")}
                    onClick={() => setSelectedAccountId(account.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate font-medium">{account.displayName || account.emailAddress}</div>
                      <Badge variant={account.status === "active" ? "secondary" : "outline"}>{account.status}</Badge>
                    </div>
                    <div className="truncate text-xs text-slate-500">{account.provider} · {account.emailAddress}</div>
                    <div className="mt-1 text-xs text-slate-500">Last sync: {formatDateTime(account.lastSyncAt) || "Never"}</div>
                  </button>
                ))}
              </QuerySection>
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-[420px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Mailbox Management</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedAccount ? (
              <>
                <div className="rounded-lg border bg-slate-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-base font-semibold">{selectedAccount.displayName || selectedAccount.emailAddress}</div>
                      <div className="text-sm text-slate-600">{selectedAccount.provider} · {selectedAccount.emailAddress}</div>
                      <div className="text-sm text-slate-600">Status: {selectedAccount.status}</div>
                      <div className="text-sm text-slate-600">Last sync: {formatDateTime(selectedAccount.lastSyncAt) || "Never"}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => syncFoldersMutation.mutate(selectedAccount.id)} disabled={syncFoldersMutation.isPending || selectedAccount.provider === "gmail"}>
                        Sync Folders
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => importEmailMutation.mutate(selectedAccount.id)}
                        disabled={importEmailMutation.isPending || selectedAccount.provider === "gmail" || selectedAccount.status === "setup_required" || selectedAccount.status === "disconnected"}
                      >
                        Import Now
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => disconnectEmailAccountMutation.mutate(selectedAccount.id)} disabled={disconnectEmailAccountMutation.isPending}>
                        Disconnect
                      </Button>
                    </div>
                  </div>
                  {selectedAccount.lastError ? (
                    <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      Provider setup error: {selectedAccount.lastError}
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="space-y-4">
                    <div className="rounded-lg border p-4">
                      <div className="mb-3 text-sm font-medium">Sync Folders</div>
                      <QuerySection
                        isLoading={selectedAccountFoldersQuery.isLoading}
                        isError={selectedAccountFoldersQuery.isError}
                        error={selectedAccountFoldersQuery.error}
                        isFetching={selectedAccountFoldersQuery.isFetching}
                        onRetry={() => selectedAccountFoldersQuery.refetch()}
                        isEmpty={selectedAccountFolders.length === 0}
                        emptyTitle="No folders loaded"
                        emptyDescription="Run Sync Folders to fetch provider folders."
                      >
                        <div className="space-y-2">
                          {selectedAccountFolders.map((folder) => (
                            <label key={folder.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">{folder.displayName}</div>
                                <div className="truncate text-xs text-slate-500">{folder.folderType} · Last sync {formatDateTime(folder.lastSyncAt) || "Never"}</div>
                              </div>
                              <Checkbox
                                checked={folder.syncEnabled}
                                onCheckedChange={(checked) => toggleFolderSyncMutation.mutate({ folderId: folder.id, syncEnabled: Boolean(checked) })}
                              />
                            </label>
                          ))}
                        </div>
                      </QuerySection>
                    </div>

                    <div className="rounded-lg border p-4">
                      <div className="mb-3 text-sm font-medium">Sync Logs</div>
                      <QuerySection
                        isLoading={selectedAccountLogsQuery.isLoading}
                        isError={selectedAccountLogsQuery.isError}
                        error={selectedAccountLogsQuery.error}
                        isFetching={selectedAccountLogsQuery.isFetching}
                        onRetry={() => selectedAccountLogsQuery.refetch()}
                        isEmpty={selectedAccountLogs.length === 0}
                        emptyTitle="No sync logs yet"
                        emptyDescription="Import Now and Sync Folders results will appear here."
                      >
                        <div className="space-y-2">
                          {selectedAccountLogs.map((log) => (
                            <div key={log.id} className="rounded-lg border px-3 py-3 text-sm">
                              <div className="flex items-center justify-between gap-2">
                                <div className="font-medium">Status: {log.status}</div>
                                <div className="text-xs text-slate-500">{formatDateTime(log.startedAt)}</div>
                              </div>
                              <div className="mt-2 text-xs text-slate-600">Imported: {log.importedCount}</div>
                              <div className="text-xs text-slate-600">Skipped duplicates: {log.skippedDuplicateCount}</div>
                              {log.finishedAt ? <div className="text-xs text-slate-600">Finished: {formatDateTime(log.finishedAt)}</div> : null}
                              {log.errorMessage ? <div className="mt-2 text-xs text-red-600">{log.errorMessage}</div> : null}
                            </div>
                          ))}
                        </div>
                      </QuerySection>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">Active Sync Scope</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2 text-sm text-slate-600">
                        <div>
                          Sync-enabled folders:{" "}
                          {selectedAccountSyncEnabledFolders.length
                            ? selectedAccountSyncEnabledFolders.map((folder) => folder.displayName).join(", ")
                            : "None"}
                        </div>
                        <div>Mailbox type: {selectedAccount.mailboxType || "provider"}</div>
                        <div>Token expiry: {formatDateTime(selectedAccount.tokenExpiresAt) || "N/A"}</div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm">Security</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2 text-sm text-slate-600">
                        <div>Tokens and IMAP passwords are never shown again in the UI.</div>
                        <div>Microsoft / Gmail use OAuth tokens only.</div>
                        <div>Gmail password login is not supported.</div>
                        <div>Only partner/admin users should manage mailbox credentials.</div>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-dashed bg-slate-50 px-4 py-12 text-center">
                <div className="text-sm font-medium text-slate-900">No mailbox selected</div>
                <div className="mt-1 text-sm text-slate-500">Choose an existing mailbox account or connect a new mailbox.</div>
                <div className="mt-4">
                  <Button onClick={() => setConnectDialogOpen(true)}>Connect Mailbox</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={connectDialogOpen} onOpenChange={setConnectDialogOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Connect Mailbox</DialogTitle>
          </DialogHeader>
          <div className="flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={connectProvider} onValueChange={setConnectProvider}>
                <SelectTrigger>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="microsoft_graph">Microsoft 365 / Outlook</SelectItem>
                  <SelectItem value="imap">IMAP</SelectItem>
                  <SelectItem value="gmail">Gmail (coming soon)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {connectProvider === "microsoft_graph" ? (
              <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                <div className="text-sm font-medium">Microsoft 365 / Outlook</div>
                <div className="text-xs text-slate-500">
                  Connect with Microsoft to authorize read-only mailbox import. Tokens are encrypted before storage and the UI never returns token values.
                </div>
                <div className="rounded-lg border bg-white p-3 text-xs text-slate-600 space-y-1">
                  <div>Required env: MICROSOFT_CLIENT_ID</div>
                  <div>MICROSOFT_CLIENT_SECRET</div>
                  <div>MICROSOFT_REDIRECT_URI</div>
                  <div>EMAIL_TOKEN_ENCRYPTION_KEY</div>
                </div>
                <Button onClick={() => startMicrosoftConnectMutation.mutate()} disabled={startMicrosoftConnectMutation.isPending}>
                  Connect with Microsoft
                </Button>
              </div>
            ) : null}

            {connectProvider === "imap" ? (
              <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                <div className="text-sm font-medium">IMAP Connection</div>
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1.5">
                    <Label>Email Address</Label>
                    <Input value={imapForm.emailAddress} onChange={(e) => setImapForm((prev) => ({ ...prev, emailAddress: e.target.value }))} placeholder="mailbox@firm.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Display Name</Label>
                    <Input value={imapForm.displayName} onChange={(e) => setImapForm((prev) => ({ ...prev, displayName: e.target.value }))} placeholder="e.g. Conveyancing Shared Inbox" />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>IMAP Host</Label>
                      <Input value={imapForm.host} onChange={(e) => setImapForm((prev) => ({ ...prev, host: e.target.value }))} placeholder="outlook.office365.com" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Port</Label>
                      <Input value={imapForm.port} onChange={(e) => setImapForm((prev) => ({ ...prev, port: e.target.value }))} placeholder="993" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Username</Label>
                    <Input value={imapForm.username} onChange={(e) => setImapForm((prev) => ({ ...prev, username: e.target.value }))} placeholder="Usually the mailbox email address" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Password / App Password</Label>
                    <Input type="password" value={imapForm.password} onChange={(e) => setImapForm((prev) => ({ ...prev, password: e.target.value }))} placeholder="Stored encrypted only" />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={imapForm.useTls} onCheckedChange={(checked) => setImapForm((prev) => ({ ...prev, useTls: Boolean(checked) }))} />
                    <span>Use SSL/TLS</span>
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => testImapMutation.mutate()} disabled={testImapMutation.isPending}>
                    Test Connection
                  </Button>
                  <Button onClick={() => connectImapMutation.mutate()} disabled={connectImapMutation.isPending}>
                    Save IMAP Mailbox
                  </Button>
                </div>
                <div className="text-xs text-slate-500">
                  IMAP credentials are encrypted before storage. If EMAIL_TOKEN_ENCRYPTION_KEY is missing, save/test will return a setup error.
                </div>
              </div>
            ) : null}

            {connectProvider === "gmail" ? (
              <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                <div className="text-sm font-medium">Gmail</div>
                <div className="text-xs text-slate-500">
                  Connect Gmail — coming soon. Gmail will use OAuth / Gmail API only. Password login is not supported.
                </div>
                <div className="space-y-1.5">
                  <Label>Email Address</Label>
                  <Input value={gmailPlaceholderForm.emailAddress} onChange={(e) => setGmailPlaceholderForm((prev) => ({ ...prev, emailAddress: e.target.value }))} placeholder="name@gmail.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>Display Name</Label>
                  <Input value={gmailPlaceholderForm.displayName} onChange={(e) => setGmailPlaceholderForm((prev) => ({ ...prev, displayName: e.target.value }))} placeholder="Optional label for planning" />
                </div>
                <Button onClick={() => createEmailAccountMutation.mutate()} disabled={createEmailAccountMutation.isPending}>
                  Save Gmail Placeholder
                </Button>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectDialogOpen(false)}>Cancel</Button>
            <div className="text-xs text-slate-500">Only partner/admin users should manage mailbox credentials.</div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
