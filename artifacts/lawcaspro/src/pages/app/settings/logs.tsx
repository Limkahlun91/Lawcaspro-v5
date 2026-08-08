import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import {
  ChevronDown, ChevronRight, ScrollText, Search, FileText, ShieldCheck, Cog, Coins, Briefcase, Users,
} from "lucide-react";

const LOG_CATEGORIES = [
  { key: "all", label: "All", icon: ScrollText },
  { key: "system", label: "System", icon: Cog },
  { key: "documents", label: "Documents", icon: FileText },
  { key: "accounting", label: "Accounting", icon: Coins },
  { key: "cases", label: "Cases", icon: Briefcase },
  { key: "hr", label: "HR", icon: Users },
  { key: "security", label: "Security", icon: ShieldCheck },
] as const;

type LogCategory = typeof LOG_CATEGORIES[number]["key"];

const HUMAN_ACTION: Record<string, string> = {
  case_created: "Case created",
  case_updated: "Case updated",
  case_key_dates_updated: "Case key dates updated",
  case_assigned: "Case assigned",
  workflow_step_completed: "Workflow step completed",
  workflow_dates_synchronized: "Workflow dates synchronized",
  document_generated: "Generated document",
  document_uploaded: "Document uploaded",
  document_generation_started: "Document generation started",
  document_generation_succeeded: "Document generation succeeded",
  document_generation_failed: "Document generation failed",
  document_generation_partial: "Document generation partially completed",
  document_zip_created: "Document ZIP package created",
  document_zip_download_succeeded: "Downloaded document package",
  document_zip_download_failed: "Document package download failed",
  document_system_print_prepared: "System print prepared",
  document_system_print_failed: "System print failed",
  note_added: "Note added",
  login: "Signed in",
  logout: "Signed out",
  auth_login_success: "Signed in",
  auth_login_failed: "Sign-in failed",
  auth_session_refreshed: "Session refreshed",
  permission_updated: "Permission updated",
  role_created: "Role created",
  role_updated: "Role updated",
  user_invited: "User invited",
  user_added: "User added",
  user_updated: "User updated",
  user_disabled: "User disabled",
  user_enabled: "User re-enabled",
  invoice_created: "Invoice created",
  invoice_updated: "Invoice updated",
  payment_voucher_created: "Payment voucher created",
  payment_voucher_submitted: "Payment voucher submitted",
  payment_voucher_approved: "Payment voucher approved",
  payment_voucher_rejected: "Payment voucher rejected",
  receipt_created: "Receipt recorded",
  trust_receipt_created: "Trust receipt recorded",
  bank_reconciliation_completed: "Bank reconciliation completed",
  setting_updated: "Firm setting updated",
  template_saved: "Template saved",
  template_activated: "Template activated",
  clause_saved: "Clause saved",
  email_sent: "Email sent",
  email_opened: "Email opened",
};

const ACTION_CATEGORY: Record<string, LogCategory> = {
  login: "security",
  logout: "security",
  auth_login_success: "security",
  auth_login_failed: "security",
  auth_session_refreshed: "security",
  permission_updated: "security",
  role_created: "security",
  role_updated: "security",
  user_invited: "hr",
  user_added: "hr",
  user_updated: "hr",
  user_disabled: "hr",
  user_enabled: "hr",
  document_generated: "documents",
  document_uploaded: "documents",
  document_generation_started: "documents",
  document_generation_succeeded: "documents",
  document_generation_failed: "documents",
  document_generation_partial: "documents",
  document_zip_created: "documents",
  document_zip_download_succeeded: "documents",
  document_zip_download_failed: "documents",
  document_system_print_prepared: "documents",
  document_system_print_failed: "documents",
  template_saved: "documents",
  template_activated: "documents",
  clause_saved: "documents",
  email_sent: "system",
  email_opened: "system",
  invoice_created: "accounting",
  invoice_updated: "accounting",
  payment_voucher_created: "accounting",
  payment_voucher_submitted: "accounting",
  payment_voucher_approved: "accounting",
  payment_voucher_rejected: "accounting",
  receipt_created: "accounting",
  trust_receipt_created: "accounting",
  bank_reconciliation_completed: "accounting",
  case_created: "cases",
  case_updated: "cases",
  case_key_dates_updated: "cases",
  case_assigned: "cases",
  workflow_step_completed: "cases",
  workflow_dates_synchronized: "cases",
  note_added: "cases",
  setting_updated: "system",
};

const CATEGORY_COLOR: Record<LogCategory, string> = {
  all: "bg-slate-100 text-slate-700",
  system: "bg-indigo-50 text-indigo-700",
  documents: "bg-purple-50 text-purple-700",
  accounting: "bg-emerald-50 text-emerald-700",
  cases: "bg-amber-50 text-amber-700",
  hr: "bg-sky-50 text-sky-700",
  security: "bg-rose-50 text-rose-700",
};

type AuditRow = Record<string, unknown>;
type DocGenRow = {
  id: number; userId: number; userName: string | null; actionType: string;
  caseId: number | null; caseIds: unknown; fileNames: unknown;
  generatedFiles: unknown; printCopies: number | null;
  jobId?: string | null; errorCode?: string | null; errorMessage?: string | null;
  requestId?: string | null; ipAddress?: string | null; userAgent?: string | null;
  createdAt: string;
};

type NormalizedLog = {
  dedupeKey: string;
  eventId?: string | null;
  correlationId?: string | null;
  requestId?: string | null;
  timestamp: number;
  category: LogCategory;
  rawAction: string;
  title: string;
  actorLabel: string;
  actorSub?: string | null;
  entityLabel?: string | null;
  caseReference?: string | null;
  templateName?: string | null;
  fileName?: string | null;
  statusLabel?: string | null;
  statusKind?: "success" | "failed" | "partial" | "info";
  children?: NormalizedLog[];
  technical?: {
    rawAction?: string;
    actionCode?: string;
    entityType?: string | null;
    entityId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    correlationId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    detail?: unknown;
    stack?: unknown;
  };
};

function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === "number" ? x : (typeof x === "string" ? Number(x) : NaN);
    if (Number.isFinite(n)) out.push(Math.trunc(n));
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [];
}

function inferCategory(action: string, entityType?: string | null): LogCategory {
  if (ACTION_CATEGORY[action]) return ACTION_CATEGORY[action];
  if (entityType && ACTION_CATEGORY[`${entityType}_updated`]) return ACTION_CATEGORY[`${entityType}_updated`];
  if (action.startsWith("auth_") || action.startsWith("login") || action.startsWith("logout") || action.includes("permission") || action.includes("role")) return "security";
  if (action.includes("document") || action.includes("template") || action.includes("clause") || action.includes("print") || action.includes("download")) return "documents";
  if (action.includes("invoice") || action.includes("payment") || action.includes("receipt") || action.includes("voucher") || action.includes("reconciliation") || action.includes("billing")) return "accounting";
  if (action.includes("case") || action.includes("workflow") || action.includes("note") || action.includes("task")) return "cases";
  if (action.includes("user_") || action.includes("invite") || action.includes("employee")) return "hr";
  if (action.includes("setting_") || action.includes("email_")) return "system";
  return "system";
}

function statusKindFor(rawAction: string, detail?: Record<string, unknown> | null): NormalizedLog["statusKind"] {
  const a = rawAction.toLowerCase();
  if (a.includes("_failed") || a.includes("reject") || a.includes("disabled")) return "failed";
  if (a.includes("_partial") || a.includes("partially")) return "partial";
  if (a.includes("_succeeded") || a.includes("created") || a.includes("completed") || a.includes("approved") || a.includes("prepared") || a.includes("enabled") || a.includes("uploaded") || a.includes("saved") || a.includes("activated")) return "success";
  if (detail && typeof detail.status === "string") {
    if (detail.status === "failed") return "failed";
    if (detail.status === "success" || detail.status === "completed") return "success";
  }
  return "info";
}

function parseDetail(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === "string") {
    if (!v.trim()) return {};
    try { return JSON.parse(v); } catch { return { raw: v }; }
  }
  if (typeof v === "object") return v as Record<string, unknown>;
  return { value: v };
}

function labelForUser(name: unknown, fallbackEmail?: unknown): string {
  if (typeof name === "string" && name.trim()) return name.trim();
  if (typeof fallbackEmail === "string" && fallbackEmail.trim()) return fallbackEmail.trim();
  return "System";
}

function normalizeDocGenAction(raw: string): string {
  // map old legacy values first
  if (raw === "download" || raw === "download_zip") return "document_zip_download_succeeded";
  if (raw === "print" || raw === "system_print") return "document_system_print_prepared";
  if (raw.startsWith("DOCUMENT_")) {
    return raw.replace(/^DOCUMENT_/, "document_").toLowerCase().replace(/_([a-z])/g, (_, m) => m.toUpperCase());
  }
  return raw;
}

function formatDateShort(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-MY");
}
function formatTimeShort(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" });
}

export default function UnifiedLogsPage() {
  const { user } = useAuth();
  const canViewTechnical = useMemo(() => {
    if (!user) return false;
    if (user.userType === "founder") return true;
    const roleName = typeof (user as any).roleName === "string" ? String((user as any).roleName).toLowerCase() : "";
    if (roleName.includes("partner") || roleName.includes("admin")) return true;
    return hasPermission(user, "audit", "read");
  }, [user]);

  const [category, setCategory] = useState<LogCategory>("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const paramsAudit = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "200");
    return p.toString();
  }, []);

  const paramsDoc = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "200");
    return p.toString();
  }, []);

  const queries = useQueries({
    queries: [
      {
        queryKey: ["unified-logs", "audit", paramsAudit],
        queryFn: () => apiFetchJson<{ data: AuditRow[]; total: number }>(`/audit-logs?${paramsAudit}`),
        retry: false,
      },
      {
        queryKey: ["unified-logs", "doc-gen", paramsDoc],
        queryFn: () => apiFetchJson<{ items: DocGenRow[]; total: number }>(`/document-generation-logs?${paramsDoc}`),
        retry: false,
      },
    ],
  });
  const [auditQ, docQ] = queries;
  const loading = auditQ.isLoading || docQ.isLoading;
  const anyError = auditQ.isError || docQ.isError;

  const { logs, totalUnfiltered, uniqueActions, uniqueUsers, uniqueStatuses } = useMemo(() => {
    const normalized: NormalizedLog[] = [];

    const auditRows = auditQ.data?.data ?? [];
    for (const row of auditRows) {
      const id = row.id != null ? String(row.id) : "";
      const rawAction = typeof row.action === "string" ? row.action : "";
      const createdAt = typeof row.created_at === "string" ? row.created_at : (typeof row.createdAt === "string" ? row.createdAt : "");
      const ts = createdAt ? new Date(createdAt).getTime() : Date.now();
      const entityType = typeof row.entity_type === "string" ? row.entity_type : null;
      const entityId = row.entity_id != null ? String(row.entity_id) : null;
      const actorName = typeof row.actor_name === "string" ? row.actor_name : null;
      const actorEmail = typeof row.actor_email === "string" ? row.actor_email : null;
      const ip = typeof row.ip_address === "string" ? row.ip_address : null;
      const ua = typeof row.user_agent === "string" ? row.user_agent : null;
      const requestId = typeof row.request_id === "string" ? row.request_id : (typeof (row as any).requestId === "string" ? (row as any).requestId : null);
      const detail = parseDetail(row.detail);
      const cat = inferCategory(rawAction, entityType);
      const caseRef = typeof detail.referenceNo === "string" && detail.referenceNo.trim() ? detail.referenceNo.trim() : (entityType === "case" && entityId ? `Case #${entityId}` : null);
      const eventId = typeof (row as any).event_id === "string" ? (row as any).event_id : null;
      const correlationId = typeof (row as any).correlation_id === "string" ? (row as any).correlation_id : (typeof detail.jobId === "string" ? detail.jobId : null);
      const dedupeKey = eventId || [correlationId || requestId || `aid-${id}`, rawAction, entityType || "", entityId || "", actorName || actorEmail || ""].join("::");
      const status = statusKindFor(rawAction, detail);
      normalized.push({
        dedupeKey,
        eventId,
        correlationId,
        requestId,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
        category: cat,
        rawAction,
        title: HUMAN_ACTION[rawAction] ?? (rawAction || "Activity"),
        actorLabel: labelForUser(actorName, actorEmail),
        actorSub: actorName && actorEmail && actorEmail.trim() ? actorEmail.trim() : null,
        entityLabel: entityType ? (entityId ? `${entityType} #${entityId}` : entityType) : null,
        caseReference: caseRef,
        templateName: typeof detail.templateName === "string" ? detail.templateName : null,
        fileName: typeof detail.fileName === "string" ? detail.fileName : (Array.isArray(detail.fileNames) ? (detail.fileNames as string[])[0] : undefined),
        statusKind: status,
        statusLabel: status === "success" ? "Success" : status === "failed" ? "Failed" : status === "partial" ? "Partial" : undefined,
        technical: {
          rawAction,
          actionCode: rawAction,
          entityType,
          entityId,
          ipAddress: ip,
          userAgent: ua,
          requestId,
          correlationId,
          errorCode: typeof detail.errorCode === "string" ? detail.errorCode : null,
          errorMessage: typeof detail.errorMessage === "string" ? detail.errorMessage : null,
          detail: Object.keys(detail).length ? detail : undefined,
        },
      });
    }

    const docRows = docQ.data?.items ?? [];
    for (const row of docRows) {
      const raw = normalizeDocGenAction(row.actionType || "");
      const ts = new Date(row.createdAt).getTime();
      const actor = row.userName?.trim() ? row.userName.trim() : `User #${row.userId}`;
      const ids = asNumberArray(row.caseIds);
      const files = asStringArray(row.fileNames);
      const cat = inferCategory(raw, "document");
      const dedupeKey = [row.jobId || row.requestId || `dg-${row.id}`, raw, row.jobId || "", ids.join(","), files.slice(0, 3).join("|")].join("::");
      const status = statusKindFor(raw);
      normalized.push({
        dedupeKey,
        eventId: null,
        correlationId: row.jobId || null,
        requestId: row.requestId || null,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
        category: cat,
        rawAction: raw,
        title: HUMAN_ACTION[raw] ?? (row.actionType || "Document activity"),
        actorLabel: actor,
        actorSub: null,
        caseReference: ids.length ? `${ids.length} case(s)` : (row.caseId ? `Case #${row.caseId}` : null),
        fileName: files[0] || null,
        statusKind: status,
        statusLabel: status === "success" ? "Success" : status === "failed" ? "Failed" : status === "partial" ? "Partial" : undefined,
        technical: {
          rawAction: raw,
          actionCode: row.actionType,
          entityType: "document",
          entityId: null,
          ipAddress: row.ipAddress || null,
          userAgent: row.userAgent || null,
          requestId: row.requestId || null,
          correlationId: row.jobId || null,
          errorCode: row.errorCode || null,
          errorMessage: row.errorMessage || null,
          detail: {
            caseIds: ids,
            fileNames: files,
            printCopies: typeof row.printCopies === "number" ? row.printCopies : undefined,
            generatedFiles: row.generatedFiles,
          },
        },
      });
    }

    // dedupe by dedupeKey
    const seen = new Set<string>();
    const deduped: NormalizedLog[] = [];
    for (const l of normalized) {
      if (seen.has(l.dedupeKey)) continue;
      seen.add(l.dedupeKey);
      deduped.push(l);
    }
    deduped.sort((a, b) => b.timestamp - a.timestamp);

    // job-level grouping for documents (correlation job_id) -> summary row
    const docEvents = deduped.filter((l) => l.category === "documents" && l.correlationId);
    const byJob = new Map<string, NormalizedLog[]>();
    for (const e of docEvents) {
      if (!e.correlationId) continue;
      const arr = byJob.get(e.correlationId) ?? [];
      arr.push(e);
      byJob.set(e.correlationId, arr);
    }
    const summaries = new Map<string, NormalizedLog>();
    for (const [jobId, events] of byJob.entries()) {
      if (events.length < 2) continue;
      const first = events[0];
      const successCount = events.filter((e) => e.statusKind === "success").length;
      const failedCount = events.filter((e) => e.statusKind === "failed").length;
      const overall: NormalizedLog["statusKind"] =
        failedCount === 0 ? "success" : successCount === 0 ? "failed" : "partial";
      const title = overall === "success"
        ? "Generated document package — all succeeded"
        : overall === "partial"
        ? `Generated document package — ${successCount} succeeded, ${failedCount} failed`
        : "Generated document package — all failed";
      const summary: NormalizedLog = {
        dedupeKey: `job-summary::${jobId}`,
        correlationId: jobId,
        requestId: first.requestId,
        timestamp: Math.max(...events.map((e) => e.timestamp)),
        category: "documents",
        rawAction: "document_generation_summary",
        title,
        actorLabel: events.find((e) => e.actorLabel !== "System")?.actorLabel ?? "System",
        statusKind: overall,
        statusLabel: overall === "success" ? "Success" : overall === "partial" ? "Partial" : "Failed",
        children: events,
      };
      summaries.set(jobId, summary);
    }
    // if summarizing a job, drop its non-summary leaf rows in favor of the collapsed summary
    const jobIdsSummarized = new Set(summaries.keys());
    const finalRows: NormalizedLog[] = [];
    for (const l of deduped) {
      if (l.category === "documents" && l.correlationId && jobIdsSummarized.has(l.correlationId)) continue;
      finalRows.push(l);
    }
    for (const s of summaries.values()) finalRows.push(s);
    finalRows.sort((a, b) => b.timestamp - a.timestamp);

    const uniqueActionsSet = new Set<string>();
    const uniqueUsersSet = new Set<string>();
    const uniqueStatusesSet = new Set<string>();
    for (const l of finalRows) {
      if (l.rawAction) uniqueActionsSet.add(l.rawAction);
      if (l.actorLabel) uniqueUsersSet.add(l.actorLabel);
      if (l.statusKind) uniqueStatusesSet.add(l.statusKind);
    }
    return {
      logs: finalRows,
      totalUnfiltered: finalRows.length,
      uniqueActions: Array.from(uniqueActionsSet).sort(),
      uniqueUsers: Array.from(uniqueUsersSet).sort(),
      uniqueStatuses: Array.from(uniqueStatusesSet).sort(),
    };
  }, [auditQ.data, docQ.data]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (category !== "all" && l.category !== category) return false;
      if (actionFilter !== "all" && l.rawAction !== actionFilter) return false;
      if (userFilter !== "all" && l.actorLabel !== userFilter) return false;
      if (statusFilter !== "all" && l.statusKind !== statusFilter) return false;
      if (!s) return true;
      const hay = [
        l.actorLabel, l.actorSub ?? "", l.title, l.caseReference ?? "", l.templateName ?? "", l.fileName ?? "",
        l.rawAction, l.statusLabel ?? "", l.correlationId ?? "", l.requestId ?? "",
      ].join(" ").toLowerCase();
      return hay.includes(s);
    });
  }, [logs, category, actionFilter, userFilter, statusFilter, search]);

  const anyRetry = () => {
    auditQ.refetch();
    docQ.refetch();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Logs</h1>
        <p className="text-slate-500 mt-1">Unified system, documents, cases, accounting, HR, and security activity for this workspace</p>
      </div>

      <Tabs
        value={category}
        onValueChange={(v) => setCategory(v as LogCategory)}
        className="space-y-4"
      >
        <TabsList className="grid grid-cols-4 md:grid-cols-7 gap-1 w-full md:w-auto md:inline-flex h-auto p-1 bg-slate-100">
          {LOG_CATEGORIES.map((c) => {
            const Icon = c.icon;
            return (
              <TabsTrigger key={c.key} value={c.key} className="flex items-center gap-1.5 px-3 py-2 data-[state=active]:bg-white">
                <Icon className="w-3.5 h-3.5" />
                <span className="text-xs md:text-sm font-medium">{c.label}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search user, case ref, file, action..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={actionFilter} onValueChange={setActionFilter} disabled={uniqueActions.length === 0}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              {uniqueActions.map((a) => (
                <SelectItem key={a} value={a}>{HUMAN_ACTION[a] ?? a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={userFilter} onValueChange={setUserFilter} disabled={uniqueUsers.length === 0}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="User" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Users</SelectItem>
              {uniqueUsers.map((u) => (
                <SelectItem key={u} value={u}>{u}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter} disabled={uniqueStatuses.length === 0}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-slate-500 shrink-0">
            {filtered.length} of {totalUnfiltered} events
          </span>
        </div>

        {LOG_CATEGORIES.map((c) => (
          <TabsContent key={c.key} value={c.key} className="mt-0 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ScrollText className="w-4 h-4 text-slate-400" />
                  Activity Log
                </CardTitle>
              </CardHeader>
              <CardContent>
                {anyError && !loading ? (
                  <QueryFallback
                    title="Logs unavailable"
                    error={auditQ.error ?? docQ.error ?? null}
                    onRetry={anyRetry}
                    isRetrying={auditQ.isFetching || docQ.isFetching}
                  />
                ) : loading ? (
                  <div className="text-slate-500 py-10 text-center">Loading logs...</div>
                ) : filtered.length === 0 ? (
                  <div className="text-center py-14 text-slate-500">
                    <ScrollText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                    <p className="font-medium text-slate-600 mb-1">No events match the current filters</p>
                    <p className="text-sm">Actions like case updates, document generation, sign-ins, and approvals will appear here.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {filtered.map((l) => (
                      <LogRowComponent
                        key={l.dedupeKey}
                        log={l}
                        canViewTechnical={canViewTechnical}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function LogRowComponent({ log, canViewTechnical }: { log: NormalizedLog; canViewTechnical: boolean }) {
  const [open, setOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  const hasChildren = Array.isArray(log.children) && log.children.length > 0;
  const StatusBadge = log.statusKind ? (
    log.statusKind === "success"
      ? <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-100">Success</Badge>
      : log.statusKind === "failed"
      ? <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-100">Failed</Badge>
      : log.statusKind === "partial"
      ? <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-100">Partial</Badge>
      : <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-100">Info</Badge>
  ) : null;

  return (
    <div className="py-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 pt-2">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="text-slate-400 hover:text-slate-600 w-5 h-5 flex items-center justify-center -ml-1"
              aria-label={open ? "Collapse" : "Expand"}
            >
              {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-slate-300 mx-1.5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${CATEGORY_COLOR[log.category]}`}>
              {LOG_CATEGORIES.find((c) => c.key === log.category)?.label ?? log.category}
            </span>
            <span className="text-sm font-medium text-slate-900">{log.title}</span>
            {StatusBadge}
            {log.caseReference && (
              <span className="text-xs font-mono font-medium text-amber-600">{log.caseReference}</span>
            )}
            {log.templateName && (
              <span className="text-xs text-slate-500">Template: <span className="font-medium text-slate-700">{log.templateName}</span></span>
            )}
            {log.fileName && (
              <span className="text-xs text-slate-500 truncate max-w-[320px]">File: <span className="font-medium text-slate-700">{log.fileName}</span></span>
            )}
            {log.entityLabel && !log.caseReference && (
              <span className="text-xs text-slate-500">{log.entityLabel}</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-slate-500">
            <span className="font-medium text-slate-700">{log.actorLabel}</span>
            {log.correlationId && (
              <span className="font-mono text-[11px] text-slate-400">#{log.correlationId.slice(0, 8)}</span>
            )}
            {canViewTechnical && log.technical && (log.technical.errorCode || log.technical.ipAddress || log.technical.detail || log.technical.stack || log.technical.requestId) ? (
              <button
                type="button"
                onClick={() => setTechOpen((o) => !o)}
                className="text-[11px] underline-offset-2 hover:underline text-slate-500 hover:text-slate-700"
              >
                {techOpen ? "Hide" : "View"} Technical Details
              </button>
            ) : null}
          </div>
          {canViewTechnical && techOpen && log.technical ? (
            <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/80 p-3 text-[11px] text-slate-600 space-y-1.5 break-words">
              {log.technical.actionCode && <div><span className="font-semibold text-slate-700">Action code: </span><span className="font-mono">{log.technical.actionCode}</span></div>}
              {log.technical.entityType && <div><span className="font-semibold text-slate-700">Entity: </span>{log.technical.entityType}{log.technical.entityId ? ` #${log.technical.entityId}` : ""}</div>}
              {log.technical.requestId && <div><span className="font-semibold text-slate-700">Request ID: </span><span className="font-mono">{log.technical.requestId}</span></div>}
              {log.technical.correlationId && <div><span className="font-semibold text-slate-700">Correlation ID: </span><span className="font-mono">{log.technical.correlationId}</span></div>}
              {log.technical.ipAddress && <div><span className="font-semibold text-slate-700">IP: </span><span className="font-mono">{log.technical.ipAddress}</span></div>}
              {log.technical.errorCode && <div><span className="font-semibold text-rose-700">Error code: </span><span className="font-mono">{log.technical.errorCode}</span></div>}
              {log.technical.errorMessage && <div><span className="font-semibold text-rose-700">Error: </span>{log.technical.errorMessage}</div>}
              {log.technical.userAgent && <div className="truncate max-w-full"><span className="font-semibold text-slate-700">User agent: </span><span className="font-mono">{log.technical.userAgent}</span></div>}
              {log.technical.detail != null && (
                <details>
                  <summary className="cursor-pointer font-semibold text-slate-700">Event detail</summary>
                  <pre className="mt-1 p-2 rounded border border-slate-200 bg-white overflow-auto max-h-64 text-[11px] leading-5 font-mono text-slate-600">
                    {JSON.stringify(log.technical.detail, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ) : null}
        </div>
        <div className="text-right text-xs text-slate-400 shrink-0">
          <div>{formatDateShort(log.timestamp)}</div>
          <div>{formatTimeShort(log.timestamp)}</div>
        </div>
      </div>
      {hasChildren && open ? (
        <div className="mt-2 ml-6 pl-3 border-l-2 border-slate-200 space-y-1">
          {log.children!.map((ch) => (
            <LogRowComponent key={ch.dedupeKey} log={ch} canViewTechnical={canViewTechnical} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
