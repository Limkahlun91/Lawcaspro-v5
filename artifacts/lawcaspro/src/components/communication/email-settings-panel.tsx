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

type EmailSetupStatus = {
  encryptionConfigured: boolean;
  encryptionMissing: string[];
  microsoft: {
    configured: boolean;
    missing: string[];
  };
  gmail: {
    configured: boolean;
    missing: string[];
    available: boolean;
    message: string;
  };
  yahoo: {
    available: boolean;
    missing: string[];
    message: string;
  };
  otherImap: {
    available: boolean;
    missing: string[];
    message: string;
  };
};

type EmailImportRange = "7d" | "30d" | "90d" | "all" | "custom";
type ConnectProvider = "microsoft_graph" | "gmail" | "yahoo_imap" | "imap";
type WizardStep = "email" | "method";

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

function providerLabel(provider: string): string {
  if (provider === "microsoft_graph") return "Microsoft 365 / Outlook / Hotmail";
  if (provider === "imap") return "Other IMAP";
  if (provider === "gmail") return "Gmail";
  if (provider === "yahoo_imap") return "Yahoo Mail";
  return provider;
}

function humanizeMailboxStatus(account: Pick<EmailAccount, "status" | "lastError">, isBusy = false): string {
  if (isBusy) return "Syncing";
  if (account.status === "active") return "Connected";
  if (account.status === "setup_required") return "Setup required";
  if (account.status === "disconnected") return "Disconnected";
  if (account.status === "error") return account.lastError ? "Last sync failed" : "Connection error";
  return account.status;
}

function getProviderPreset(provider: ConnectProvider) {
  if (provider === "yahoo_imap") {
    return {
      host: "imap.mail.yahoo.com",
      port: "993",
      useTls: true,
      usernameMode: "email" as const,
      hostLocked: true,
      portLocked: true,
      useTlsLocked: true,
    };
  }
  return {
    host: "",
    port: "993",
    useTls: true,
    usernameMode: "custom" as const,
    hostLocked: false,
    portLocked: false,
    useTlsLocked: false,
  };
}

function createInitialImapForm() {
  return {
    emailAddress: "",
    displayName: "",
    host: "",
    port: "993",
    username: "",
    password: "",
    useTls: true,
  };
}

function detectProviderFromEmail(email: string): ConnectProvider {
  const normalized = String(email ?? "").trim().toLowerCase();
  const [, domain = ""] = normalized.split("@");
  if (["outlook.com", "hotmail.com", "live.com"].includes(domain)) return "microsoft_graph";
  if (["gmail.com", "googlemail.com"].includes(domain)) return "gmail";
  if (domain === "yahoo.com" || domain === "yahoo.com.my" || domain === "yahoo.co.uk") return "yahoo_imap";
  return "imap";
}

function recommendedMethodLabel(provider: ConnectProvider): string {
  if (provider === "microsoft_graph") return "Microsoft secure login";
  if (provider === "gmail") return "Google secure login";
  if (provider === "yahoo_imap") return "Yahoo App Password + IMAP";
  return "Manual IMAP";
}

function providerSecurityCopy(provider: ConnectProvider): string {
  if (provider === "microsoft_graph") {
    return "Lawcaspro will redirect you to Microsoft. Your Microsoft password is never entered or stored in Lawcaspro.";
  }
  if (provider === "gmail") {
    return "Lawcaspro will redirect you to Google. Your Gmail password is never entered or stored in Lawcaspro.";
  }
  if (provider === "yahoo_imap") {
    return "Yahoo requires an App Password for third-party mailbox import. Do not use your normal Yahoo password.";
  }
  return "Some providers require an App Password instead of the normal mailbox password.";
}

function formatMissingList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function buildDisabledReason(provider: ConnectProvider, missing: string[]): string | null {
  if (!missing.length) return null;
  if (provider === "microsoft_graph") {
    return `Connect Microsoft / Outlook is disabled because ${formatMissingList(missing)} ${missing.length === 1 ? "is" : "are"} missing.`;
  }
  if (provider === "gmail") {
    return `Connect Gmail is disabled because ${formatMissingList(missing)} ${missing.length === 1 ? "is" : "are"} missing.`;
  }
  if (provider === "yahoo_imap") {
    return `Connect Yahoo Mail is disabled because ${formatMissingList(missing)} ${missing.length === 1 ? "is" : "are"} missing. Yahoo app passwords cannot be saved until credential storage is configured.`;
  }
  return `Connect Other IMAP is disabled because ${formatMissingList(missing)} ${missing.length === 1 ? "is" : "are"} missing. Provider passwords or app passwords cannot be saved until credential storage is configured.`;
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
  const [wizardStep, setWizardStep] = useState<WizardStep>("email");
  const [wizardEmail, setWizardEmail] = useState("");
  const [showMethodOverride, setShowMethodOverride] = useState(false);
  const [connectProvider, setConnectProvider] = useState<ConnectProvider>("microsoft_graph");
  const [importRange, setImportRange] = useState<EmailImportRange>("30d");
  const [importMaxEmails, setImportMaxEmails] = useState<100 | 500 | 1000>(500);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [expandedGuide, setExpandedGuide] = useState<Partial<Record<ConnectProvider, boolean>>>({});
  const [imapForm, setImapForm] = useState(createInitialImapForm());

  const emailAccountsQuery = useQuery<EmailAccount[]>({
    queryKey: ["communication", "email", "accounts"],
    queryFn: () => apiFetchJson("/communication/email/accounts").then((r) => asArray<EmailAccount>(r)),
    retry: false,
  });
  const emailAccounts = asArray<EmailAccount>(emailAccountsQuery.data);

  const setupStatusQuery = useQuery<EmailSetupStatus>({
    queryKey: ["communication", "email", "setup-status"],
    queryFn: () => apiFetchJson("/communication/email/setup-status") as Promise<EmailSetupStatus>,
    retry: false,
  });
  const setupStatus = setupStatusQuery.data;

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

  const startMicrosoftConnectMutation = useMutation({
    mutationFn: () => apiFetchJson<{ url: string }>(`/communication/email/microsoft/connect?returnTo=${encodeURIComponent(window.location.href)}`),
    onSuccess: (result) => {
      if (result?.url) window.location.assign(result.url);
    },
    onError: (e) => toastError(toast, e),
  });

  const startGoogleConnectMutation = useMutation({
    mutationFn: () => apiFetchJson<{ url: string }>(`/communication/email/google/connect?returnTo=${encodeURIComponent(window.location.href)}`),
    onSuccess: (result) => {
      if (result?.url) window.location.assign(result.url);
    },
    onError: (e) => toastError(toast, e),
  });

  const testImapMutation = useMutation({
    mutationFn: () => apiFetchJson("/communication/email/imap/test", {
      method: "POST",
      body: {
        provider: connectProvider === "yahoo_imap" ? "yahoo_imap" : "imap",
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
        provider: connectProvider === "yahoo_imap" ? "yahoo_imap" : "imap",
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
      apiFetchJson<{ ok: boolean; importedCount: number; skippedDuplicateCount: number; failedCount: number; status: string }>(`/communication/email/accounts/${accountId}/import-now`, {
        method: "POST",
        body: {
          range: importRange,
          maxEmails: importMaxEmails,
          from: importRange === "custom" && customFrom ? new Date(customFrom).toISOString() : null,
          to: importRange === "custom" && customTo ? new Date(customTo).toISOString() : null,
        },
      }),
    onSuccess: (result, accountId) => {
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", accountId, "sync-logs"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", accountId, "folders"] });
      toast({
        title: "Import completed",
        description: `Imported ${result.importedCount}, skipped ${result.skippedDuplicateCount} duplicates, failed ${result.failedCount}.`,
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
    if (connectProvider !== "imap" && connectProvider !== "yahoo_imap") return;
    const preset = getProviderPreset(connectProvider);
    setImapForm((prev) => ({
      ...prev,
      host: preset.host || prev.host,
      port: preset.port,
      useTls: preset.useTls,
      username: preset.usernameMode === "email" ? prev.emailAddress : prev.username,
    }));
  }, [connectProvider]);

  useEffect(() => {
    if (connectProvider !== "yahoo_imap") return;
    setImapForm((prev) => ({ ...prev, username: prev.emailAddress }));
  }, [connectProvider, imapForm.emailAddress]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const providerStatus = params.get("providerStatus");
    if (!providerStatus) return;
    const provider = params.get("provider");
    const providerError = params.get("providerError");
    const accountIdRaw = params.get("accountId");
    if (providerStatus === "connected") {
      toast({
        title:
          provider === "microsoft_graph"
            ? "Microsoft 365 mailbox connected"
            : provider === "gmail"
              ? "Gmail mailbox connected"
              : "Mailbox connected",
      });
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
    qc.invalidateQueries({ queryKey: ["communication", "email", "setup-status"] });
    qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
    qc.invalidateQueries({ queryKey: ["communication", "messages"] });
    if (selectedAccountId != null) {
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", selectedAccountId, "folders"] });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts", selectedAccountId, "sync-logs"] });
    }
  };

  const selectedAccountSyncEnabledFolders = selectedAccountFolders.filter((folder) => folder.syncEnabled);
  const microsoftMissing = [
    ...(setupStatus?.microsoft.missing ?? []),
    ...(setupStatus?.encryptionConfigured === false ? ["EMAIL_TOKEN_ENCRYPTION_KEY"] : []),
  ];
  const gmailMissing = [
    ...(setupStatus?.gmail.missing ?? []),
    ...(setupStatus?.encryptionConfigured === false ? ["EMAIL_TOKEN_ENCRYPTION_KEY"] : []),
  ];
  const selectedAccountLastLog = selectedAccountLogs[0] ?? null;
  const canImportSelectedAccount = Boolean(
    selectedAccount &&
    selectedAccount.status !== "setup_required" &&
    selectedAccount.status !== "disconnected"
  );
  const encryptionDisabledReason = !setupStatus?.encryptionConfigured
    ? "Credential storage is disabled because EMAIL_TOKEN_ENCRYPTION_KEY is missing. Tokens and app passwords cannot be saved until this is configured."
    : null;
  const providerCards = [
    {
      key: "microsoft_graph" as const,
      title: "Microsoft 365 / Outlook / Hotmail",
      description: "Use Microsoft secure login for Outlook.com, Hotmail.com, Live.com, and Microsoft 365 work or school mailboxes.",
      method: "Microsoft secure login",
      passwordRequired: "No",
      adminSetup: "Microsoft OAuth env",
      nextStep: "Connect Microsoft / Outlook",
      shortHelp: "Do not enter your normal Microsoft password in Lawcaspro.",
      missing: microsoftMissing,
      connectedAccounts: emailAccounts.filter((account) => account.provider === "microsoft_graph"),
      actionLabel: "Connect Microsoft / Outlook",
      action: () => {
        setConnectProvider("microsoft_graph");
        setConnectDialogOpen(true);
      },
      actionDisabled: false,
      status: microsoftMissing.length ? "Setup required" : "Ready",
      disabledReason: buildDisabledReason("microsoft_graph", microsoftMissing),
    },
    {
      key: "gmail" as const,
      title: "Gmail",
      description: "Use Google secure login for Gmail. Lawcaspro should not ask for your normal Gmail password.",
      method: "Google secure login",
      passwordRequired: "No",
      adminSetup: "Google OAuth env",
      nextStep: "Connect Gmail",
      shortHelp: "Do not enter your normal Gmail password. Use Google OAuth login.",
      missing: gmailMissing,
      connectedAccounts: emailAccounts.filter((account) => account.provider === "gmail"),
      actionLabel: "Connect Gmail",
      action: () => {
        setConnectProvider("gmail");
        setConnectDialogOpen(true);
      },
      actionDisabled: false,
      status: gmailMissing.length ? "Setup required" : "Ready",
      disabledReason: buildDisabledReason("gmail", gmailMissing),
    },
    {
      key: "yahoo_imap" as const,
      title: "Yahoo Mail",
      description: "Yahoo uses IMAP with Yahoo App Password. Host and port are auto-filled and locked.",
      method: "Yahoo App Password + IMAP",
      passwordRequired: "Yahoo App Password only",
      adminSetup: "EMAIL_TOKEN_ENCRYPTION_KEY",
      nextStep: "Enter Yahoo email + App Password",
      shortHelp: "Do not use your normal Yahoo password.",
      missing: setupStatus?.yahoo.missing ?? [],
      connectedAccounts: emailAccounts.filter((account) => account.provider === "yahoo_imap"),
      actionLabel: "Connect Yahoo Mail",
      action: () => {
        setConnectProvider("yahoo_imap");
        setConnectDialogOpen(true);
      },
      actionDisabled: false,
      status: setupStatus?.yahoo.available ? "Ready" : "Setup required",
      disabledReason: buildDisabledReason("yahoo_imap", setupStatus?.yahoo.missing ?? []),
    },
    {
      key: "imap" as const,
      title: "Other IMAP",
      description: "Use this for custom domain mailboxes. Host and port stay editable.",
      method: "Manual IMAP",
      passwordRequired: "Provider password or App Password",
      adminSetup: "EMAIL_TOKEN_ENCRYPTION_KEY",
      nextStep: "Enter host / port / username / password",
      shortHelp: "Some providers require an App Password instead of a normal password.",
      missing: setupStatus?.otherImap.missing ?? [],
      connectedAccounts: emailAccounts.filter((account) => account.provider === "imap"),
      actionLabel: "Connect Other IMAP",
      action: () => {
        setConnectProvider("imap");
        setConnectDialogOpen(true);
      },
      actionDisabled: false,
      status: setupStatus?.otherImap.available ? "Ready" : "Setup required",
      disabledReason: buildDisabledReason("imap", setupStatus?.otherImap.missing ?? []),
    },
  ];
  const activeImapPreset = getProviderPreset(connectProvider);
  const isPresetImapProvider = connectProvider === "imap" || connectProvider === "yahoo_imap";
  const toggleGuide = (provider: ConnectProvider) => {
    setExpandedGuide((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };
  const wizardEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wizardEmail.trim());
  const openConnectWizard = () => {
    setConnectDialogOpen(true);
    setWizardStep("email");
    setWizardEmail("");
    setShowMethodOverride(false);
    setConnectProvider("microsoft_graph");
    setImapForm(createInitialImapForm());
  };
  const applyWizardProvider = (provider: ConnectProvider, email: string) => {
    const preset = getProviderPreset(provider);
    setConnectProvider(provider);
    setImapForm((prev) => ({
      ...prev,
      emailAddress: email,
      host: preset.host || (provider === "imap" ? prev.host : ""),
      port: preset.port,
      username: provider === "yahoo_imap" ? email : prev.username,
      useTls: preset.useTls,
    }));
  };
  const continueWithDetectedProvider = () => {
    const email = wizardEmail.trim();
    const detected = detectProviderFromEmail(email);
    applyWizardProvider(detected, email);
    setShowMethodOverride(false);
    setWizardStep("method");
  };
  const selectedProviderMissing =
    connectProvider === "microsoft_graph"
      ? microsoftMissing
      : connectProvider === "gmail"
        ? gmailMissing
        : connectProvider === "yahoo_imap"
          ? (setupStatus?.yahoo.missing ?? [])
          : (setupStatus?.otherImap.missing ?? []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">Email Settings</div>
          <div className="text-sm text-slate-500">
            Enter your mailbox email address. Lawcaspro will recommend the safest connection method. Outlook and Gmail use secure login. Yahoo and some custom mailboxes may require an app password.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={refreshAll}>
            Refresh
          </Button>
          <Button onClick={openConnectWizard}>Connect Mailbox</Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Section 1 — Provider Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-600">
          {setupStatusQuery.isLoading ? <div>Loading setup status...</div> : null}
          {setupStatusQuery.isError ? (
            <QueryFallback title="Unable to load setup status" error={setupStatusQuery.error} onRetry={() => setupStatusQuery.refetch()} isRetrying={setupStatusQuery.isFetching} />
          ) : null}
          {!setupStatusQuery.isLoading && !setupStatusQuery.isError ? (
            <>
              {!setupStatus?.encryptionConfigured ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  {encryptionDisabledReason}
                </div>
              ) : null}
              <div className="rounded-lg border bg-slate-50 p-4">
                <div className="text-sm font-medium text-slate-900">Add account by email address</div>
                <div className="mt-1 text-sm text-slate-600">
                  Enter the mailbox email address first. Lawcaspro will recommend Microsoft secure login, Google secure login, Yahoo App Password, or manual IMAP.
                </div>
                <div className="mt-3">
                  <Button onClick={openConnectWizard}>Add Email Account</Button>
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {providerCards.map((card) => {
                  const latestConnected = card.connectedAccounts[0] ?? null;
                  const isExpanded = Boolean(expandedGuide[card.key]);
                  return (
                    <div key={card.key} className="rounded-lg border p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{card.title}</div>
                          <div className="mt-1 text-xs text-slate-500">{card.description}</div>
                        </div>
                        <Badge variant={latestConnected ? "secondary" : "outline"}>
                          {latestConnected ? humanizeMailboxStatus(latestConnected) : card.status}
                        </Badge>
                      </div>
                      <div className="mt-3 space-y-2 text-sm text-slate-600">
                        <div>Connection: {card.method}</div>
                        <div>Password: {card.passwordRequired}</div>
                        <div>Setup: {card.missing.length ? "Admin configuration required" : "Ready"}</div>
                        <div>Next: {card.nextStep}</div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Button variant="outline" onClick={openConnectWizard}>
                          Add account
                        </Button>
                        <button
                          type="button"
                          className="text-sm text-slate-600 underline underline-offset-4"
                          onClick={() => toggleGuide(card.key)}
                        >
                          {isExpanded ? "Hide connection guide" : "View connection guide"}
                        </button>
                      </div>
                      {card.missing.length ? (
                        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
                          <div>Setup incomplete. Ask admin to configure {card.key === "microsoft_graph" ? "Microsoft OAuth." : card.key === "gmail" ? "Google OAuth." : "credential storage."}</div>
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs underline underline-offset-4">Show technical details</summary>
                            <ul className="mt-2 list-disc pl-5 text-xs">
                              {card.missing.map((item) => <li key={item}>{item}</li>)}
                            </ul>
                          </details>
                        </div>
                      ) : null}
                      {card.disabledReason ? (
                        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                          {card.disabledReason}
                        </div>
                      ) : null}
                      {isExpanded ? (
                        <div className="mt-3 rounded-lg border bg-slate-50 p-3 text-xs text-slate-600">
                          {card.key === "microsoft_graph" ? (
                            <>
                              <div className="font-medium text-slate-900">Use Microsoft secure login</div>
                              <div className="mt-1">Supported: Outlook.com, Hotmail.com, Live.com, Microsoft 365 work or school mailbox.</div>
                              <ol className="mt-2 list-decimal pl-5">
                                <li>Click Connect Microsoft / Outlook</li>
                                <li>Sign in with your Microsoft account</li>
                                <li>Allow read-only mailbox access</li>
                                <li>Return to Lawcaspro</li>
                                <li>Click Sync Folders</li>
                                <li>Select folders</li>
                                <li>Import Emails</li>
                              </ol>
                            </>
                          ) : null}
                          {card.key === "gmail" ? (
                            <>
                              <div className="font-medium text-slate-900">Use Google secure login</div>
                              <div className="mt-1">Do not enter your normal Gmail password. Use Google OAuth login.</div>
                              <ol className="mt-2 list-decimal pl-5">
                                <li>Click Connect Gmail</li>
                                <li>Sign in with Google</li>
                                <li>Allow Gmail read-only access</li>
                                <li>Return to Lawcaspro</li>
                                <li>Click Sync Folders or Labels</li>
                                <li>Select labels</li>
                                <li>Import Emails</li>
                              </ol>
                            </>
                          ) : null}
                          {card.key === "yahoo_imap" ? (
                            <>
                              <div className="font-medium text-slate-900">Use Yahoo App Password</div>
                              <div className="mt-1">Do not use your normal Yahoo password.</div>
                              <ol className="mt-2 list-decimal pl-5">
                                <li>Login to Yahoo Mail in browser</li>
                                <li>Go to Account Security</li>
                                <li>Generate App Password</li>
                                <li>Paste it into Lawcaspro</li>
                                <li>Test Connection</li>
                                <li>Save Yahoo Mailbox</li>
                              </ol>
                            </>
                          ) : null}
                          {card.key === "imap" ? (
                            <>
                              <div className="font-medium text-slate-900">Use this for custom domain / hosting / cPanel mailboxes</div>
                              <div className="mt-1">Some providers require an App Password instead of the normal password.</div>
                              <ol className="mt-2 list-decimal pl-5">
                                <li>Get IMAP settings from your email provider</li>
                                <li>Enter host, port, username, and password</li>
                                <li>Test Connection</li>
                                <li>Save Mailbox</li>
                              </ol>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="rounded-lg border bg-slate-50 p-4 text-sm">
                <div className="font-medium text-slate-900">What happens after connection?</div>
                <div className="mt-2 text-slate-600">
                  1. Click Sync Folders
                  <br />
                  2. Select folders or labels to sync
                  <br />
                  3. Choose import range
                  <br />
                  4. Click Import Emails
                  <br />
                  5. Imported emails will appear in Email Inbox
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Section 2 — Connected Mailboxes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <QuerySection
            isLoading={emailAccountsQuery.isLoading}
            isError={emailAccountsQuery.isError}
            error={emailAccountsQuery.error}
            isFetching={emailAccountsQuery.isFetching}
            onRetry={() => emailAccountsQuery.refetch()}
            isEmpty={emailAccounts.length === 0}
            emptyTitle="No mailbox accounts"
            emptyDescription="Connect Microsoft, Gmail, Yahoo Mail, or Other IMAP to start importing email."
          >
            {emailAccounts.map((account) => {
              const selected = selectedAccountId === account.id;
              const busy = syncFoldersMutation.isPending || importEmailMutation.isPending;
              return (
                <button
                  key={account.id}
                  className={[
                    "w-full rounded-lg border p-4 text-left transition-colors",
                    selected ? "border-slate-400 bg-slate-50" : "hover:bg-slate-50",
                  ].join(" ")}
                  onClick={() => setSelectedAccountId(account.id)}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-medium">{account.displayName || account.emailAddress}</div>
                      <div className="text-sm text-slate-600">{providerLabel(account.provider)}</div>
                      <div className="text-sm text-slate-600">{account.emailAddress}</div>
                      <div className="text-xs text-slate-500">Last sync: {formatDateTime(account.lastSyncAt) || "Never"}</div>
                    </div>
                    <Badge variant={account.status === "active" ? "secondary" : "outline"}>
                      {humanizeMailboxStatus(account, selected && busy)}
                    </Badge>
                  </div>
                </button>
              );
            })}
          </QuerySection>
        </CardContent>
      </Card>

      {selectedAccount ? (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Selected Mailbox</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-slate-50 p-4">
                <div className="space-y-1">
                  <div className="text-base font-semibold">{selectedAccount.displayName || selectedAccount.emailAddress}</div>
                  <div className="text-sm text-slate-600">{providerLabel(selectedAccount.provider)} · {selectedAccount.emailAddress}</div>
                  <div className="text-sm text-slate-600">Status: {humanizeMailboxStatus(selectedAccount, syncFoldersMutation.isPending || importEmailMutation.isPending)}</div>
                  <div className="text-sm text-slate-600">Last sync: {formatDateTime(selectedAccount.lastSyncAt) || "Never"}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => syncFoldersMutation.mutate(selectedAccount.id)} disabled={syncFoldersMutation.isPending}>
                    Sync Folders
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => importEmailMutation.mutate(selectedAccount.id)} disabled={!canImportSelectedAccount || importEmailMutation.isPending}>
                    Import Emails
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => disconnectEmailAccountMutation.mutate(selectedAccount.id)} disabled={disconnectEmailAccountMutation.isPending}>
                    Disconnect
                  </Button>
                </div>
              </div>
              {selectedAccount.lastError ? (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  Connection error: {selectedAccount.lastError}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Section 3 — Folder Sync</CardTitle>
            </CardHeader>
            <CardContent>
              <QuerySection
                isLoading={selectedAccountFoldersQuery.isLoading}
                isError={selectedAccountFoldersQuery.isError}
                error={selectedAccountFoldersQuery.error}
                isFetching={selectedAccountFoldersQuery.isFetching}
                onRetry={() => selectedAccountFoldersQuery.refetch()}
                isEmpty={selectedAccountFolders.length === 0}
                emptyTitle="No folders loaded"
                emptyDescription="Run Sync Folders to fetch Inbox, Sent, Archive, Junk, Deleted, and custom folders."
              >
                <div className="space-y-2">
                  {selectedAccountFolders.map((folder) => (
                    <label key={folder.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{folder.displayName}</div>
                        <div className="truncate text-xs text-slate-500">
                          {folder.syncEnabled ? "Enabled" : "Disabled"} · Last synced {formatDateTime(folder.lastSyncAt) || "Never"}
                        </div>
                      </div>
                      <Checkbox checked={folder.syncEnabled} onCheckedChange={(checked) => toggleFolderSyncMutation.mutate({ folderId: folder.id, syncEnabled: Boolean(checked) })} />
                    </label>
                  ))}
                </div>
              </QuerySection>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Section 4 — Import Emails</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Import range</Label>
                  <Select value={importRange} onValueChange={(value) => setImportRange(value as EmailImportRange)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7d">Last 7 days</SelectItem>
                      <SelectItem value="30d">Last 30 days</SelectItem>
                      <SelectItem value="90d">Last 90 days</SelectItem>
                      <SelectItem value="all">All available emails</SelectItem>
                      <SelectItem value="custom">Custom date range</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Max emails per import</Label>
                  <Select value={String(importMaxEmails)} onValueChange={(value) => setImportMaxEmails(Number(value) as 100 | 500 | 1000)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="100">100</SelectItem>
                      <SelectItem value="500">500</SelectItem>
                      <SelectItem value="1000">1000</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {importRange === "custom" ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>From</Label>
                    <Input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>To</Label>
                    <Input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => importEmailMutation.mutate(selectedAccount.id)} disabled={!canImportSelectedAccount || importEmailMutation.isPending}>
                  Import Now
                </Button>
                <div className="text-xs text-slate-500">Default recommendation: Last 30 days + max 500 emails.</div>
              </div>
              <div className="rounded-lg border bg-slate-50 p-3 text-sm text-slate-600">
                <div>Sync-enabled folders: {selectedAccountSyncEnabledFolders.length ? selectedAccountSyncEnabledFolders.map((folder) => folder.displayName).join(", ") : "None"}</div>
                <div className="mt-1">Last import result: {selectedAccountLastLog ? `${selectedAccountLastLog.status} at ${formatDateTime(selectedAccountLastLog.startedAt)}` : "No import yet"}</div>
                {selectedAccountLastLog ? (
                  <div className="mt-1">
                    Imported: {selectedAccountLastLog.importedCount} · Skipped duplicates: {selectedAccountLastLog.skippedDuplicateCount} · Failed: {selectedAccountLastLog.errorMessage ? 1 : 0}
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Section 5 — Sync Logs</CardTitle>
            </CardHeader>
            <CardContent>
              <QuerySection
                isLoading={selectedAccountLogsQuery.isLoading}
                isError={selectedAccountLogsQuery.isError}
                error={selectedAccountLogsQuery.error}
                isFetching={selectedAccountLogsQuery.isFetching}
                onRetry={() => selectedAccountLogsQuery.refetch()}
                isEmpty={selectedAccountLogs.length === 0}
                emptyTitle="No sync logs yet"
                emptyDescription="Sync Folders and Import Emails results will appear here."
              >
                <div className="space-y-2">
                  {selectedAccountLogs.map((log) => (
                    <div key={log.id} className="rounded-lg border px-3 py-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium">{providerLabel(selectedAccount.provider)} · {log.status}</div>
                        <div className="text-xs text-slate-500">{formatDateTime(log.startedAt)}</div>
                      </div>
                      <div className="mt-2 text-xs text-slate-600">Imported: {log.importedCount}</div>
                      <div className="text-xs text-slate-600">Skipped duplicates: {log.skippedDuplicateCount}</div>
                      <div className="text-xs text-slate-600">Failed: {log.errorMessage ? 1 : 0}</div>
                      {log.finishedAt ? <div className="text-xs text-slate-600">Finished: {formatDateTime(log.finishedAt)}</div> : null}
                      {log.errorMessage ? <div className="mt-2 text-xs text-red-600">{log.errorMessage}</div> : null}
                    </div>
                  ))}
                </div>
              </QuerySection>
            </CardContent>
          </Card>
        </>
      ) : (
        <div className="rounded-lg border border-dashed bg-slate-50 px-4 py-12 text-center">
          <div className="text-sm font-medium text-slate-900">No mailbox selected</div>
          <div className="mt-1 text-sm text-slate-500">Choose an existing mailbox account or connect a new mailbox.</div>
          <div className="mt-4">
            <Button onClick={openConnectWizard}>Connect Mailbox</Button>
          </div>
        </div>
      )}

      <Dialog
        open={connectDialogOpen}
        onOpenChange={(open) => {
          setConnectDialogOpen(open);
          if (!open) {
            setWizardStep("email");
            setWizardEmail("");
            setShowMethodOverride(false);
            setConnectProvider("microsoft_graph");
            setImapForm(createInitialImapForm());
          }
        }}
      >
        <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{wizardStep === "email" ? "Add Email Account" : "Connect Mailbox"}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 space-y-3 overflow-y-auto pr-1">
            {wizardStep === "email" ? (
              <div className="space-y-4 rounded-lg border bg-slate-50 p-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">Add an email account</div>
                  <div className="mt-1 text-sm text-slate-600">
                    Enter your email address to connect your mailbox.
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Email address</Label>
                  <Input
                    type="email"
                    value={wizardEmail}
                    onChange={(e) => setWizardEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </div>
                <div className="text-xs text-slate-500">
                  Supported:
                  <ul className="mt-1 list-disc pl-5">
                    <li>Outlook / Hotmail / Live / Microsoft 365</li>
                    <li>Gmail</li>
                    <li>Yahoo Mail</li>
                    <li>Other IMAP mailbox</li>
                  </ul>
                </div>
                <div>
                  <Button onClick={continueWithDetectedProvider} disabled={!wizardEmailValid}>
                    Continue
                  </Button>
                </div>
              </div>
            ) : null}

            {wizardStep === "method" ? (
              <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Connected email address</div>
                  <div className="mt-1 text-slate-600">{wizardEmail}</div>
                  <button
                    type="button"
                    className="mt-2 text-xs text-slate-600 underline underline-offset-4"
                    onClick={() => setWizardStep("email")}
                  >
                    Change email address
                  </button>
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Recommended method: {recommendedMethodLabel(connectProvider)}</div>
                  <div className="mt-1 text-slate-600">{providerSecurityCopy(connectProvider)}</div>
                  {(connectProvider === "microsoft_graph" || connectProvider === "gmail") && selectedProviderMissing.length ? (
                    <div className="mt-2 text-amber-900">
                      {connectProvider === "microsoft_graph"
                        ? "Microsoft login is not configured yet. Please ask system admin to configure Microsoft OAuth settings."
                        : "Gmail login is not configured yet. Please ask system admin to configure Google OAuth settings."}
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs underline underline-offset-4">Show technical details</summary>
                        <ul className="mt-2 list-disc pl-5 text-xs">
                          {selectedProviderMissing.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </details>
                    </div>
                  ) : null}
                </div>
                <div className="text-xs text-slate-500">
                  <button
                    type="button"
                    className="underline underline-offset-4"
                    onClick={() => setShowMethodOverride((prev) => !prev)}
                  >
                    Use a different connection method
                  </button>
                  <div className="mt-1">Custom domains like abc-law.com may be Microsoft 365, Google Workspace, or custom IMAP.</div>
                </div>
                {showMethodOverride ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {([
                      ["microsoft_graph", "Microsoft secure login"],
                      ["gmail", "Google secure login"],
                      ["yahoo_imap", "Yahoo App Password"],
                      ["imap", "Other IMAP"],
                    ] as const).map(([provider, label]) => (
                      <Button
                        key={provider}
                        type="button"
                        variant={connectProvider === provider ? "default" : "outline"}
                        onClick={() => applyWizardProvider(provider, wizardEmail.trim())}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {wizardStep === "method" && connectProvider === "microsoft_graph" ? (
              <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                <div className="text-sm font-medium">Microsoft 365 / Outlook / Hotmail</div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">How this login works</div>
                  <div className="mt-1 text-slate-600">Use Microsoft secure login. You do not need to enter your email password in Lawcaspro.</div>
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Steps</div>
                  <ol className="mt-1 list-decimal pl-5">
                    <li>Click Connect Microsoft / Outlook</li>
                    <li>Sign in with your Microsoft account</li>
                    <li>Allow read-only mailbox access</li>
                    <li>Return to Lawcaspro</li>
                    <li>Click Sync Folders</li>
                    <li>Select folders</li>
                    <li>Import Emails</li>
                  </ol>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Do not enter your normal Microsoft password here. Microsoft mailboxes should use secure OAuth login.
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Setup status</div>
                  {microsoftMissing.length ? (
                    <div className="mt-1 text-amber-900">
                      Setup incomplete. Ask admin to configure Microsoft OAuth.
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs underline underline-offset-4">Show technical details</summary>
                        <ul className="mt-2 list-disc pl-5 text-xs">
                          {microsoftMissing.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </details>
                    </div>
                  ) : (
                    <div className="mt-1 text-slate-600">
                      Microsoft OAuth is configured. Tokens are encrypted before storage and never returned by the API.
                    </div>
                  )}
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Action</div>
                  <Button className="mt-2" onClick={() => startMicrosoftConnectMutation.mutate()} disabled={startMicrosoftConnectMutation.isPending || microsoftMissing.length > 0}>
                    Connect Microsoft / Outlook
                  </Button>
                  {microsoftMissing.length ? (
                    <div className="mt-2 text-xs text-amber-900">{buildDisabledReason("microsoft_graph", microsoftMissing)}</div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {wizardStep === "method" && isPresetImapProvider ? (
              <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                <div className="text-sm font-medium">{connectProvider === "yahoo_imap" ? "Yahoo Mail" : "Other IMAP"}</div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">How this login works</div>
                  <div className="mt-1 text-slate-600">
                    {connectProvider === "yahoo_imap"
                      ? "Use Yahoo App Password, not your normal Yahoo password."
                      : "Use this only if your mailbox is custom domain, hosting, or cPanel."}
                  </div>
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm text-slate-600">
                  {connectProvider === "yahoo_imap" ? (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <div><span className="font-medium text-slate-900">Host:</span> imap.mail.yahoo.com</div>
                      <div><span className="font-medium text-slate-900">Port:</span> 993</div>
                      <div><span className="font-medium text-slate-900">SSL/TLS:</span> enabled</div>
                    </div>
                  ) : (
                    <div>Most secure IMAP servers use Port 993 with SSL/TLS enabled.</div>
                  )}
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm text-slate-600">
                  <div className="font-medium text-slate-900">Steps</div>
                  {connectProvider === "yahoo_imap" ? (
                    <>
                      <ol className="mt-1 list-decimal pl-5">
                        <li>Login to Yahoo Mail in browser</li>
                        <li>Go to Account Info or Account Security</li>
                        <li>Generate App Password for third-party mail app</li>
                        <li>Copy the generated password</li>
                        <li>Paste it into Lawcaspro</li>
                        <li>Click Test Connection</li>
                        <li>Click Save Yahoo Mailbox</li>
                        <li>Click Sync Folders</li>
                        <li>Import Emails</li>
                      </ol>
                    </>
                  ) : (
                    <>
                      <ol className="mt-1 list-decimal pl-5">
                        <li>Get IMAP settings from your email provider</li>
                        <li>Enter IMAP host</li>
                        <li>Enter port</li>
                        <li>Enter username</li>
                        <li>Enter password or app password</li>
                        <li>Enable SSL/TLS if required</li>
                        <li>Test Connection</li>
                        <li>Save Mailbox</li>
                        <li>Sync Folders</li>
                        <li>Import Emails</li>
                      </ol>
                    </>
                  )}
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm text-slate-600">
                  <div className="font-medium text-slate-900">Setup status</div>
                  {connectProvider === "yahoo_imap" ? (
                    !setupStatus?.yahoo.available ? (
                      <div className="mt-1 text-amber-900">
                        Setup incomplete. Ask admin to configure credential storage.
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs underline underline-offset-4">Show technical details</summary>
                          <ul className="mt-2 list-disc pl-5 text-xs">
                            {(setupStatus?.yahoo.missing ?? []).map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </details>
                      </div>
                    ) : (
                      <div className="mt-1">Credential storage is ready for Yahoo App Password.</div>
                    )
                  ) : !setupStatus?.otherImap.available ? (
                    <div className="mt-1 text-amber-900">
                      Setup incomplete. Ask admin to configure credential storage.
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs underline underline-offset-4">Show technical details</summary>
                        <ul className="mt-2 list-disc pl-5 text-xs">
                          {(setupStatus?.otherImap.missing ?? []).map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </details>
                    </div>
                  ) : (
                    <div className="mt-1">Credential storage is ready for IMAP passwords or app passwords.</div>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1.5">
                    <Label>Email Address</Label>
                    <Input value={imapForm.emailAddress} readOnly placeholder="mailbox@firm.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Display Name</Label>
                    <Input value={imapForm.displayName} onChange={(e) => setImapForm((prev) => ({ ...prev, displayName: e.target.value }))} placeholder="e.g. Conveyancing Shared Inbox" />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>IMAP Host</Label>
                      <Input
                        value={imapForm.host}
                        onChange={(e) => setImapForm((prev) => ({ ...prev, host: e.target.value }))}
                        placeholder={connectProvider === "yahoo_imap" ? "imap.mail.yahoo.com" : "mail.example.com"}
                        readOnly={activeImapPreset.hostLocked}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Port</Label>
                      <Input
                        value={imapForm.port}
                        onChange={(e) => setImapForm((prev) => ({ ...prev, port: e.target.value }))}
                        placeholder="993"
                        readOnly={activeImapPreset.portLocked}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Username</Label>
                    <Input
                      value={connectProvider === "yahoo_imap" ? imapForm.emailAddress : imapForm.username}
                      onChange={(e) => setImapForm((prev) => ({ ...prev, username: e.target.value }))}
                      placeholder="Usually the mailbox email address"
                      readOnly={connectProvider === "yahoo_imap"}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Password / App Password</Label>
                    <Input
                      type="password"
                      value={imapForm.password}
                      onChange={(e) => setImapForm((prev) => ({ ...prev, password: e.target.value }))}
                      placeholder={connectProvider === "yahoo_imap" ? "Yahoo App Password" : "Stored encrypted only"}
                    />
                    <div className="text-xs text-slate-500">
                      {connectProvider === "yahoo_imap"
                        ? "Paste Yahoo App Password here. Do not paste your normal Yahoo login password."
                        : "Use your provider password or App Password. Some providers require an App Password instead of the normal login password."}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={imapForm.useTls}
                      onCheckedChange={(checked) => setImapForm((prev) => ({ ...prev, useTls: Boolean(checked) }))}
                      disabled={activeImapPreset.useTlsLocked}
                    />
                    <span>Use SSL/TLS</span>
                  </label>
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Action</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => testImapMutation.mutate()}
                    disabled={testImapMutation.isPending || (connectProvider === "yahoo_imap" ? !setupStatus?.yahoo.available : !setupStatus?.otherImap.available)}
                  >
                    Test Connection
                  </Button>
                  <Button
                    onClick={() => connectImapMutation.mutate()}
                    disabled={connectImapMutation.isPending || (connectProvider === "yahoo_imap" ? !setupStatus?.yahoo.available : !setupStatus?.otherImap.available)}
                  >
                    {connectProvider === "yahoo_imap" ? "Save Yahoo Mailbox" : "Save IMAP Mailbox"}
                  </Button>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    {connectProvider === "yahoo_imap"
                      ? "Yahoo Mail uses imap.mail.yahoo.com, port 993, and SSL/TLS enabled."
                      : "IMAP credentials are encrypted before storage. If EMAIL_TOKEN_ENCRYPTION_KEY is missing, save and test stay disabled."}
                  </div>
                  {connectProvider === "yahoo_imap" && !setupStatus?.yahoo.available ? (
                    <div className="mt-2 text-xs text-amber-900">{buildDisabledReason("yahoo_imap", setupStatus?.yahoo.missing ?? [])}</div>
                  ) : null}
                  {connectProvider === "imap" && !setupStatus?.otherImap.available ? (
                    <div className="mt-2 text-xs text-amber-900">{buildDisabledReason("imap", setupStatus?.otherImap.missing ?? [])}</div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {wizardStep === "method" && connectProvider === "gmail" ? (
              <div className="space-y-3 rounded-lg border bg-slate-50 p-3">
                <div className="text-sm font-medium">Gmail</div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">How this login works</div>
                  <div className="mt-1 text-slate-600">Use Google secure login. Lawcaspro should not ask for your normal Gmail password.</div>
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm text-slate-600">
                  <div className="font-medium text-slate-900">Steps</div>
                  <ol className="mt-1 list-decimal pl-5">
                    <li>Click Connect Gmail</li>
                    <li>Sign in with Google</li>
                    <li>Allow Gmail read-only access</li>
                    <li>Return to Lawcaspro</li>
                    <li>Click Sync Folders or Labels</li>
                    <li>Select labels</li>
                    <li>Import Emails</li>
                  </ol>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Do not enter your normal Gmail password. Use Google OAuth login.
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Setup status</div>
                  {gmailMissing.length ? (
                    <div className="mt-1 text-amber-900">
                      Setup incomplete. Ask admin to configure Google OAuth.
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs underline underline-offset-4">Show technical details</summary>
                        <ul className="mt-2 list-disc pl-5 text-xs">
                          {gmailMissing.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </details>
                    </div>
                  ) : (
                    <div className="mt-1 text-slate-600">
                      Google OAuth is configured. Tokens are encrypted before storage and never returned by the API.
                    </div>
                  )}
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm">
                  <div className="font-medium text-slate-900">Action</div>
                  <Button className="mt-2" onClick={() => startGoogleConnectMutation.mutate()} disabled={startGoogleConnectMutation.isPending || gmailMissing.length > 0}>
                    Connect Gmail
                  </Button>
                  {gmailMissing.length ? (
                    <div className="mt-2 text-xs text-amber-900">{buildDisabledReason("gmail", gmailMissing)}</div>
                  ) : null}
                </div>
                <div className="rounded-lg border bg-white p-3 text-sm text-slate-600">
                  <div className="font-medium text-slate-900">Fallback option: Gmail App Password</div>
                  <div className="mt-1">
                    Only use this if Google OAuth is not available. Your Google account may require 2-Step Verification before you can generate an App Password.
                  </div>
                </div>
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
