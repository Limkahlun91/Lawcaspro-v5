import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { QueryFallback } from "@/components/query-fallback";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";

type InboxView =
  | "shared_inbox"
  | "unread"
  | "assigned_to_me"
  | "unassigned"
  | "linked_to_case"
  | "no_case"
  | "archived"
  | "my_tasks"
  | "batch_emails"
  | "drafts_pending_approval"
  | "overdue"
  | "closed";

type Mailbox = {
  id: number;
  channel: string;
  provider: string;
  displayName: string | null;
  address: string | null;
  mailboxType: string;
  isActive: boolean;
};

type EmailAccount = {
  id: number;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
};

type Attachment = {
  id: number;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  createdAt: string;
};

type Remark = {
  id: number;
  messageId: number;
  userId: number;
  userName: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type MessageRead = {
  id: number;
  messageId: number;
  userId: number;
  userName: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openedCount: number;
};

type CaseLookupRow = {
  id: number;
  caseRef: string | null;
  status: string;
  developerName: string | null;
};

type MessageRow = {
  message: {
    id: number;
    channel: string;
    direction: "incoming" | "outgoing";
    providerIsRead: boolean;
    fromAddress: string | null;
    fromName: string | null;
    subject: string | null;
    bodyText: string | null;
    internalStatus: string;
    isBatch: boolean;
    assignedToUserId: number | null;
    linkedCaseId: number | null;
    receivedAt: string | null;
    lastActivityAt: string | null;
    createdAt: string;
  };
  tasksTotal: number;
  tasksReady: number;
  tasksReplied: number;
  tasksUnassigned: number;
  attachmentCount: number;
  hasAttachments: boolean;
  isRead: boolean;
  assigneeCount: number;
};

type Task = {
  id: number;
  parentMessageId: number;
  caseRef: string | null;
  partyName: string | null;
  bankRef: string | null;
  propertyRef: string | null;
  taskStatus: string;
  replyNote: string | null;
  assignedToUserId: number | null;
  linkedCaseId: number | null;
  team?: {
    lawyerInChargeUserId: number | null;
    handlerUserIds: number[];
    reviewerUserId: number | null;
    watcherUserIds: number[];
  };
};

type Draft = {
  id: number;
  parentMessageId: number;
  status: string;
  draftType: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
};

type MessageDetail = {
  id: number;
  channel: string;
  direction: "incoming" | "outgoing";
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  internalStatus: string;
  isBatch: boolean;
  assignedToUserId: number | null;
  linkedCaseId: number | null;
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  team?: {
    lawyerInChargeUserId: number | null;
    handlerUserIds: number[];
    reviewerUserId: number | null;
    watcherUserIds: number[];
  };
};

type User = {
  id: number;
  name: string;
  roleName?: string;
};

type AuditEntry = {
  id?: number;
  actorUserId?: number | null;
  action?: string | null;
  createdAt?: string | null;
};

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    if (Array.isArray(record.items)) return record.items as T[];
    if (Array.isArray(record.rows)) return record.rows as T[];
    if (Array.isArray(record.tasks)) return record.tasks as T[];
  }
  return [];
}

function asStringArray(value: unknown): string[] {
  return asArray<string>(value).map((entry) => String(entry ?? "")).filter(Boolean);
}

function asNumberArray(value: unknown): number[] {
  return asArray<unknown>(value).map((entry) => (typeof entry === "number" ? entry : Number(entry))).filter((n) => Number.isFinite(n));
}

function normalizeTeam(value: unknown): { lawyerInChargeUserId: number | null; handlerUserIds: number[]; reviewerUserId: number | null; watcherUserIds: number[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const lawyerInChargeUserIdRaw = record.lawyerInChargeUserId;
  const reviewerUserIdRaw = record.reviewerUserId;
  const lawyerInChargeUserId = typeof lawyerInChargeUserIdRaw === "number" ? lawyerInChargeUserIdRaw : (lawyerInChargeUserIdRaw == null ? null : Number(lawyerInChargeUserIdRaw));
  const reviewerUserId = typeof reviewerUserIdRaw === "number" ? reviewerUserIdRaw : (reviewerUserIdRaw == null ? null : Number(reviewerUserIdRaw));
  return {
    lawyerInChargeUserId: Number.isFinite(lawyerInChargeUserId as any) ? (lawyerInChargeUserId as any) : null,
    handlerUserIds: asNumberArray(record.handlerUserIds),
    reviewerUserId: Number.isFinite(reviewerUserId as any) ? (reviewerUserId as any) : null,
    watcherUserIds: asNumberArray(record.watcherUserIds),
  };
}

function normalizeMessageDetail(value: unknown): MessageDetail | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    ...(record as unknown as MessageDetail),
    toAddresses: asStringArray(record.toAddresses),
    ccAddresses: asStringArray(record.ccAddresses),
    bccAddresses: asStringArray(record.bccAddresses),
    team: normalizeTeam(record.team),
  };
}

function splitCommaList(v: string): string[] {
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

function toggleString(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function formatDateTime(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

function previewText(value: unknown): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= 140) return s;
  return `${s.slice(0, 137)}...`;
}

function formatRelativeAction(action: unknown): string {
  const value = String(action ?? "").trim();
  if (!value) return "Updated";
  const map: Record<string, string> = {
    "communication.message.manual_email.created": "Manual email created",
    "communication.message.assignees.updated": "Assigned users updated",
    "communication.message.case_linked": "Linked to case",
    "communication.message.case_unlinked": "Unlinked case",
    "communication.message.archived": "Archived",
    "communication.message.unarchived": "Unarchived",
    "communication.message.marked_read": "Marked read",
    "communication.message.marked_unread": "Marked unread",
    "communication.remark.created": "Remark added",
    "communication.remark.updated": "Remark edited",
    "communication.remark.deleted": "Remark deleted",
    "communication.message.opened": "Opened",
    "communication.message.viewed": "Viewed",
  };
  return map[value] ?? value.replace(/^communication\./, "").replace(/\./g, " ");
}

function compactAuditEntries(entries: AuditEntry[], users: User[]) {
  const userNameById = new Map(users.map((user) => [user.id, user.name || `User ${user.id}`]));
  const items: Array<{ key: string; label: string; createdAt: string | null; count: number }> = [];

  for (const entry of entries) {
    const action = String(entry.action ?? "");
    const actorUserId = typeof entry.actorUserId === "number" ? entry.actorUserId : null;
    const actorName = actorUserId ? (userNameById.get(actorUserId) ?? `User ${actorUserId}`) : "System";
    const isOpenLike = action === "communication.message.opened" || action === "communication.message.viewed";

    if (isOpenLike) {
      const last = items[items.length - 1];
      if (last?.key === `open:${actorUserId ?? "system"}`) {
        last.count += 1;
        last.createdAt = entry.createdAt ?? last.createdAt;
        continue;
      }
      items.push({
        key: `open:${actorUserId ?? "system"}`,
        label: `Opened by ${actorName}`,
        createdAt: entry.createdAt ?? null,
        count: 1,
      });
      continue;
    }

    items.push({
      key: `${action}:${entry.id ?? items.length}`,
      label: actorUserId ? `${formatRelativeAction(action)} by ${actorName}` : formatRelativeAction(action),
      createdAt: entry.createdAt ?? null,
      count: 1,
    });
  }

  return items.map((item) => ({
    ...item,
    label: item.key.startsWith("open:") && item.count > 1 ? `${item.label} multiple times` : item.label,
  }));
}

function StatusBadge({ value }: { value: string }) {
  const raw = String(value ?? "").trim().toLowerCase();
  const v = raw === "fully_replied" || raw === "partially_replied" ? "archived" : raw;
  return <Badge variant="outline">{v || "-"}</Badge>;
}

function isLawyerLikeRole(roleName: unknown): boolean {
  const n = String(roleName ?? "").trim().toLowerCase();
  return n.includes("lawyer") || n.includes("partner") || n.includes("admin");
}

function uniqueNumberList(values: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v !== "number") continue;
    if (!Number.isFinite(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function getAssignedUserIdsFromMessage(message: { assignedToUserId: number | null; team?: MessageDetail["team"] }): number[] {
  const team = message.team;
  return uniqueNumberList([
    message.assignedToUserId ?? null,
    team?.lawyerInChargeUserId ?? null,
    ...(team?.handlerUserIds ?? []),
    team?.reviewerUserId ?? null,
    ...(team?.watcherUserIds ?? []),
  ]);
}

function QuerySection({
  isLoading,
  isError,
  error,
  isFetching,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyDescription,
  loadingText = "Loading...",
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  onRetry: () => void;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  loadingText?: string;
  children: ReactNode;
}) {
  if (isError) {
    return <QueryFallback title={emptyTitle} error={error} onRetry={onRetry} isRetrying={isFetching} />;
  }

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-slate-500">{loadingText}</div>;
  }

  if (isEmpty) {
    return (
      <Empty className="border border-dashed border-slate-200 bg-slate-50/50 py-10">
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <>{children}</>;
}

export default function EmailControlCenterPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const openedMessageIdsRef = useRef<Map<number, number>>(new Map());

  const [view, setView] = useState<InboxView>("shared_inbox");
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [linkCaseRef, setLinkCaseRef] = useState("");
  const [linkCaseError, setLinkCaseError] = useState("");
  const [assignedUserIds, setAssignedUserIds] = useState<number[]>([]);
  const [newRemarkBody, setNewRemarkBody] = useState("");
  const [editingRemarkId, setEditingRemarkId] = useState<number | null>(null);
  const [editingRemarkBody, setEditingRemarkBody] = useState("");
  const [assigneesDialogOpen, setAssigneesDialogOpen] = useState(false);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const showWorkflowUi = false;

  const usersQuery = useQuery<User[]>({
    queryKey: ["communication", "users"],
    queryFn: () => apiFetchJson("/users?limit=200").then((r) => asArray<User>((r as any)?.data ?? r)),
    retry: false,
  });
  const users = asArray<User>(usersQuery.data);

  const mailboxesQuery = useQuery<Mailbox[]>({
    queryKey: ["communication", "mailboxes"],
    queryFn: () => apiFetchJson("/communication/mailboxes?channel=email").then((r) => asArray<Mailbox>(r)),
    retry: false,
  });
  const mailboxes = asArray<Mailbox>(mailboxesQuery.data);

  const emailAccountsQuery = useQuery<EmailAccount[]>({
    queryKey: ["communication", "email", "accounts"],
    queryFn: () => apiFetchJson("/communication/email/accounts").then((r) => asArray<EmailAccount>(r)),
    retry: false,
  });
  const emailAccounts = asArray<EmailAccount>(emailAccountsQuery.data);

  const messagesQuery = useQuery<MessageRow[]>({
    queryKey: ["communication", "messages", view, search],
    queryFn: () => {
      if (view === "drafts_pending_approval") return [];
      if (view === "my_tasks") return [];
      if (view === "overdue") return [];
      const params = new URLSearchParams();
      const activeStatuses = "new,assigned,unassigned";
      if (view !== "archived" && view !== "closed") params.set("status", activeStatuses);
      if (view === "unassigned") params.set("assignedTo", "unassigned");
      if (view === "assigned_to_me") params.set("assignedTo", "me");
      if (view === "unread") params.set("unread", "true");
      if (view === "batch_emails") params.set("isBatch", "true");
      if (view === "closed") params.set("status", "closed,fully_replied");
      if (view === "archived") params.set("status", "archived");
      if (search.trim()) params.set("q", search.trim());
      return apiFetchJson(`/communication/messages?${params.toString()}`).then((r) => asArray<MessageRow>(r));
    },
    enabled: view !== "drafts_pending_approval" && view !== "my_tasks" && view !== "overdue",
    retry: false,
  });

  const tasksMineQuery = useQuery<Task[]>({
    queryKey: ["communication", "tasks", "mine"],
    queryFn: () => apiFetchJson("/communication/tasks/mine?limit=200").then((r) => asArray<Task>(r)),
    enabled: view === "my_tasks",
    retry: false,
  });

  const draftsPendingQuery = useQuery<Draft[]>({
    queryKey: ["communication", "drafts", "pending"],
    queryFn: async () => {
      const a = await apiFetchJson("/communication/drafts?status=pending_partner_approval&limit=200");
      const b = await apiFetchJson("/communication/drafts?status=pending_lawyer_approval&limit=200");
      return [...asArray<Draft>(a), ...asArray<Draft>(b)];
    },
    enabled: view === "drafts_pending_approval",
    retry: false,
  });

  const overdueQuery = useQuery<any[]>({
    queryKey: ["communication", "sla", "overdue"],
    queryFn: () => apiFetchJson("/communication/sla/overdue?limit=200").then((r) => asArray<any>(r)),
    enabled: view === "overdue",
    retry: false,
  });

  const selectedMessageQuery = useQuery({
    queryKey: ["communication", "message", selectedMessageId],
    queryFn: () => apiFetchJson(`/communication/messages/${selectedMessageId}`).then((r) => normalizeMessageDetail(r)),
    enabled: typeof selectedMessageId === "number",
    retry: false,
  }) as ReturnType<typeof useQuery<MessageDetail | null>>;

  const selectedTasksQuery = useQuery<Task[]>({
    queryKey: ["communication", "message", selectedMessageId, "tasks"],
    queryFn: () => apiFetchJson(`/communication/messages/${selectedMessageId}/tasks`).then((r) => asArray<Task>(r)),
    enabled: typeof selectedMessageId === "number",
    retry: false,
  });

  const selectedMessageAuditQuery = useQuery<any[]>({
    queryKey: ["communication", "audit", "message", selectedMessageId],
    queryFn: () => apiFetchJson(`/communication/audit/message/${selectedMessageId}`).then((r) => asArray<any>(r)),
    enabled: typeof selectedMessageId === "number",
    retry: false,
  });

  const selectedAssigneesQuery = useQuery<{ userIds: number[] }>({
    queryKey: ["communication", "message", selectedMessageId, "assignees"],
    queryFn: () => apiFetchJson(`/communication/messages/${selectedMessageId}/assignees`).then((r) => (r as any) ?? { userIds: [] }),
    enabled: typeof selectedMessageId === "number",
    retry: false,
  });

  const selectedRemarksQuery = useQuery<Remark[]>({
    queryKey: ["communication", "message", selectedMessageId, "remarks"],
    queryFn: () => apiFetchJson(`/communication/messages/${selectedMessageId}/remarks`).then((r) => asArray<Remark>(r)),
    enabled: typeof selectedMessageId === "number",
    retry: false,
  });

  const selectedReadsQuery = useQuery<MessageRead[]>({
    queryKey: ["communication", "message", selectedMessageId, "reads"],
    queryFn: () => apiFetchJson(`/communication/messages/${selectedMessageId}/reads`).then((r) => asArray<MessageRead>(r)),
    enabled: typeof selectedMessageId === "number",
    retry: false,
  });

  const selectedAttachmentsQuery = useQuery<Attachment[]>({
    queryKey: ["communication", "message", selectedMessageId, "attachments"],
    queryFn: () => apiFetchJson(`/communication/messages/${selectedMessageId}/attachments`).then((r) => asArray<Attachment>(r)),
    enabled: typeof selectedMessageId === "number",
    retry: false,
  });

  const caseLookupQuery = useQuery<CaseLookupRow[]>({
    queryKey: ["communication", "case-lookup", linkCaseRef],
    queryFn: () => apiFetchJson(`/communication/case-lookup?q=${encodeURIComponent(linkCaseRef)}`).then((r) => asArray<CaseLookupRow>(r)),
    enabled: linkCaseRef.trim().length >= 2 && typeof selectedMessageId === "number",
    retry: false,
  });

  const selectedDraftQuery = useQuery<{ draft: Draft; tasks: Task[] } | null>({
    queryKey: ["communication", "draft", selectedDraftId],
    queryFn: async () => {
      const result = await apiFetchJson(`/communication/drafts/${selectedDraftId}`);
      if (!result || typeof result !== "object") return null;
      const record = result as Record<string, unknown>;
      const draftRaw = record.draft;
      if (!draftRaw || typeof draftRaw !== "object") return null;
      const draftRecord = draftRaw as Record<string, unknown>;
      return {
        draft: {
          ...(draftRecord as unknown as Draft),
          toAddresses: asStringArray(draftRecord.toAddresses),
          ccAddresses: asStringArray(draftRecord.ccAddresses),
          bccAddresses: asStringArray(draftRecord.bccAddresses),
        },
        tasks: asArray<Task>(record.tasks),
      };
    },
    enabled: typeof selectedDraftId === "number",
    retry: false,
  });

  const selectedDraftAuditQuery = useQuery<any[]>({
    queryKey: ["communication", "audit", "draft", selectedDraftId],
    queryFn: () => apiFetchJson(`/communication/audit/draft/${selectedDraftId}`).then((r) => asArray<any>(r)),
    enabled: typeof selectedDraftId === "number",
    retry: false,
  });

  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    const next = asArray<number>((selectedAssigneesQuery.data as any)?.userIds);
    setAssignedUserIds(next.filter((n) => typeof n === "number"));
  }, [selectedAssigneesQuery.data, selectedMessageId]);

  const [showManualEmail, setShowManualEmail] = useState(false);
  const [manualForm, setManualForm] = useState({
    mailboxId: "",
    fromName: "",
    fromEmail: "",
    to: "",
    cc: "",
    subject: "",
    bodyText: "",
    receivedAt: "",
    caseRef: "",
    isBatchEmail: true,
    lawyerInChargeUserId: "",
    handlerUserIds: [] as string[],
    reviewerUserId: "",
    watcherUserIds: [] as string[],
  });

  useEffect(() => {
    if (manualForm.mailboxId) return;
    const firstActiveMailbox = mailboxes.find((mailbox) => mailbox.isActive);
    if (!firstActiveMailbox) return;
    setManualForm((prev) => (prev.mailboxId ? prev : { ...prev, mailboxId: String(firstActiveMailbox.id) }));
  }, [mailboxes, manualForm.mailboxId]);

  const manualEmailMutation = useMutation({
    mutationFn: () => apiFetchJson("/communication/messages/manual-email", {
      method: "POST",
      body: {
        mailboxId: manualForm.mailboxId ? parseInt(manualForm.mailboxId, 10) : undefined,
        fromName: manualForm.fromName,
        fromEmail: manualForm.fromEmail,
        to: splitCommaList(manualForm.to),
        cc: splitCommaList(manualForm.cc),
        subject: manualForm.subject,
        bodyText: manualForm.bodyText,
        receivedAt: manualForm.receivedAt ? new Date(manualForm.receivedAt).toISOString() : undefined,
        caseRef: manualForm.caseRef || undefined,
        isBatchEmail: manualForm.isBatchEmail,
        team: {
          lawyerInChargeUserId: manualForm.lawyerInChargeUserId ? parseInt(manualForm.lawyerInChargeUserId, 10) : null,
          handlerUserIds: manualForm.handlerUserIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n)),
          reviewerUserId: manualForm.reviewerUserId ? parseInt(manualForm.reviewerUserId, 10) : null,
          watcherUserIds: manualForm.watcherUserIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n)),
        },
      },
    }),
    onSuccess: (created) => {
      setShowManualEmail(false);
      setManualForm({
        mailboxId: "",
        fromName: "",
        fromEmail: "",
        to: "",
        cc: "",
        subject: "",
        bodyText: "",
        receivedAt: "",
        caseRef: "",
        isBatchEmail: true,
        lawyerInChargeUserId: "",
        handlerUserIds: [],
        reviewerUserId: "",
        watcherUserIds: [],
      });
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      if (created?.id) setSelectedMessageId(created.id);
      toast({ title: "Manual email created" });
    },
    onError: (e) => toastError(toast, e),
  });

  const recordMessageOpenedMutation = useMutation({
    mutationFn: (messageId: number) => apiFetchJson(`/communication/messages/${messageId}/read`, { method: "POST", body: {} }),
    onSuccess: (_r, messageId) => {
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", messageId, "reads"] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", messageId] });
    },
    onError: (e) => toastError(toast, e),
  });

  const linkMessageCaseMutation = useMutation({
    mutationFn: (args: { messageId: number; caseId?: number | null; caseRef?: string | null }) =>
      apiFetchJson(`/communication/messages/${args.messageId}/link-case`, { method: "PATCH", body: { caseId: args.caseId ?? null, caseRef: args.caseRef ?? null } }),
    onSuccess: (_r, args) => {
      setLinkCaseError("");
      setLinkCaseRef("");
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", args.messageId] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", args.messageId] });
      toast({ title: "Case linked" });
    },
    onError: (e) => {
      setLinkCaseError("Case not found. Try a case reference, purchaser, developer, or parcel search.");
      toastError(toast, e);
    },
  });

  const unlinkMessageCaseMutation = useMutation({
    mutationFn: (messageId: number) => apiFetchJson(`/communication/messages/${messageId}/link-case`, { method: "DELETE" }),
    onSuccess: (_r, messageId) => {
      setLinkCaseError("");
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", messageId] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", messageId] });
      toast({ title: "Case unlinked" });
    },
    onError: (e) => toastError(toast, e),
  });

  const archiveMessageMutation = useMutation({
    mutationFn: (args: { messageId: number; archived: boolean }) =>
      apiFetchJson(`/communication/messages/${args.messageId}/archive`, { method: "PATCH", body: { archived: args.archived } }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", args.messageId] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", args.messageId] });
      toast({ title: args.archived ? "Email archived" : "Email unarchived" });
    },
    onError: (e) => toastError(toast, e),
  });

  const readStatusMutation = useMutation({
    mutationFn: (args: { messageId: number; isRead: boolean }) =>
      apiFetchJson(`/communication/messages/${args.messageId}/read-status`, { method: "PATCH", body: { isRead: args.isRead } }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", args.messageId, "reads"] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", args.messageId] });
    },
    onError: (e) => toastError(toast, e),
  });

  const assigneesMutation = useMutation({
    mutationFn: (args: { messageId: number; userIds: number[] }) =>
      apiFetchJson(`/communication/messages/${args.messageId}/assignees`, { method: "PATCH", body: { userIds: args.userIds } }),
    onSuccess: (_r, args) => {
      setAssigneesDialogOpen(false);
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", args.messageId] });
      qc.invalidateQueries({ queryKey: ["communication", "message", args.messageId, "assignees"] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", args.messageId] });
      toast({ title: "Assigned users updated" });
    },
    onError: (e) => toastError(toast, e),
  });

  const createRemarkMutation = useMutation({
    mutationFn: (args: { messageId: number; body: string }) =>
      apiFetchJson(`/communication/messages/${args.messageId}/remarks`, { method: "POST", body: { body: args.body } }),
    onSuccess: (_r, args) => {
      setNewRemarkBody("");
      qc.invalidateQueries({ queryKey: ["communication", "message", args.messageId, "remarks"] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", args.messageId] });
    },
    onError: (e) => toastError(toast, e),
  });

  const updateRemarkMutation = useMutation({
    mutationFn: (args: { remarkId: number; body: string }) =>
      apiFetchJson(`/communication/remarks/${args.remarkId}`, { method: "PATCH", body: { body: args.body } }),
    onSuccess: () => {
      setEditingRemarkId(null);
      setEditingRemarkBody("");
      qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "remarks"] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", selectedMessageId] });
    },
    onError: (e) => toastError(toast, e),
  });

  const deleteRemarkMutation = useMutation({
    mutationFn: (remarkId: number) => apiFetchJson(`/communication/remarks/${remarkId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "remarks"] });
      qc.invalidateQueries({ queryKey: ["communication", "audit", "message", selectedMessageId] });
    },
    onError: (e) => toastError(toast, e),
  });

  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [connectForm, setConnectForm] = useState({ provider: "microsoft_graph", emailAddress: "", displayName: "" });

  const createEmailAccountMutation = useMutation({
    mutationFn: () => apiFetchJson("/communication/email/accounts", { method: "POST", body: connectForm }),
    onSuccess: () => {
      setConnectDialogOpen(false);
      setConnectForm({ provider: "microsoft_graph", emailAddress: "", displayName: "" });
      qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
      toast({ title: "Mailbox connection saved (setup required)" });
    },
    onError: (e) => toastError(toast, e),
  });

  const createTaskMutation = useMutation({
    mutationFn: (args: { messageId: number; payload: any }) => apiFetchJson(`/communication/messages/${args.messageId}/tasks`, { method: "POST", body: args.payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] });
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
    },
    onError: (e) => toastError(toast, e),
  });

  const taskAcknowledgeMutation = useMutation({
    mutationFn: (taskId: number) => apiFetchJson(`/communication/tasks/${taskId}/acknowledge`, { method: "PATCH", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] }),
    onError: (e) => toastError(toast, e),
  });

  const taskStatusMutation = useMutation({
    mutationFn: (args: { taskId: number; taskStatus: string }) => apiFetchJson(`/communication/tasks/${args.taskId}/status`, { method: "PATCH", body: { taskStatus: args.taskStatus } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] }),
    onError: (e) => toastError(toast, e),
  });

  const taskReplyNoteMutation = useMutation({
    mutationFn: (args: { taskId: number; replyNote: string }) => apiFetchJson(`/communication/tasks/${args.taskId}/reply-note`, { method: "PATCH", body: { replyNote: args.replyNote } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] }),
    onError: (e) => toastError(toast, e),
  });

  const taskLinkCaseMutation = useMutation({
    mutationFn: (args: { taskId: number; caseRef: string }) => apiFetchJson(`/communication/tasks/${args.taskId}/link-case`, { method: "PATCH", body: { caseRef: args.caseRef } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] }),
    onError: (e) => toastError(toast, e),
  });

  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);

  const createDraftMutation = useMutation({
    mutationFn: (args: { type: "consolidated" | "partial"; parentMessageId: number; taskIds: number[]; to: string; cc: string; subject: string }) =>
      apiFetchJson(`/communication/drafts/${args.type}`, {
        method: "POST",
        body: {
          parentMessageId: args.parentMessageId,
          taskIds: args.taskIds,
          to: splitCommaList(args.to),
          cc: splitCommaList(args.cc),
          bcc: [],
          subject: args.subject,
        },
      }),
    onSuccess: async (draft) => {
      qc.invalidateQueries({ queryKey: ["communication", "drafts"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] });
      if (draft?.id) {
        setSelectedDraftId(draft.id);
        setView("drafts_pending_approval");
        try {
          await apiFetchJson(`/communication/drafts/${draft.id}/submit-approval`, { method: "POST", body: {} });
          qc.invalidateQueries({ queryKey: ["communication", "drafts", "pending"] });
          qc.invalidateQueries({ queryKey: ["communication", "draft", draft.id] });
        } catch (e) {
          toastError(toast, e);
        }
      }
    },
    onError: (e) => toastError(toast, e),
  });

  const submitDraftMutation = useMutation({
    mutationFn: (draftId: number) => apiFetchJson(`/communication/drafts/${draftId}/submit-approval`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "drafts"] }),
    onError: (e) => toastError(toast, e),
  });

  const approveDraftMutation = useMutation({
    mutationFn: (draftId: number) => apiFetchJson(`/communication/drafts/${draftId}/approve`, { method: "POST", body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "drafts"] });
      qc.invalidateQueries({ queryKey: ["communication", "drafts", "pending"] });
      qc.invalidateQueries({ queryKey: ["communication", "draft", selectedDraftId] });
    },
    onError: (e) => toastError(toast, e),
  });

  const markSentMutation = useMutation({
    mutationFn: (draftId: number) => apiFetchJson(`/communication/drafts/${draftId}/mark-sent`, { method: "POST", body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "drafts"] });
      qc.invalidateQueries({ queryKey: ["communication", "drafts", "pending"] });
      qc.invalidateQueries({ queryKey: ["communication", "draft", selectedDraftId] });
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] });
    },
    onError: (e) => toastError(toast, e),
  });

  const cancelDraftMutation = useMutation({
    mutationFn: (draftId: number) => apiFetchJson(`/communication/drafts/${draftId}/cancel`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "drafts"] }),
    onError: (e) => toastError(toast, e),
  });

  const messages = asArray<MessageRow>(messagesQuery.data);
  const tasksMine = asArray<Task>(tasksMineQuery.data);
  const draftsPending = asArray<Draft>(draftsPendingQuery.data);
  const overdue = asArray<any>(overdueQuery.data);

  const selectedMessage = selectedMessageQuery.data ?? null;
  const selectedTasks = asArray<Task>(selectedTasksQuery.data);
  const messageAudit = asArray<any>(selectedMessageAuditQuery.data);

  const selectedDraft = selectedDraftQuery.data ?? null;
  const draftAudit = asArray<any>(selectedDraftAuditQuery.data);
  const selectedMessageRow = messages.find((row) => row.message.id === selectedMessageId) ?? null;
  const selectedMessageIsRead = selectedMessageRow?.isRead ?? false;
  const selectedMessageHasAttachments = selectedMessageRow?.hasAttachments ?? false;
  const selectedMessageAttachmentCount = selectedMessageRow?.attachmentCount ?? asArray<Attachment>(selectedAttachmentsQuery.data).length;
  const selectedMessageAssignedCount = selectedMessageRow?.assigneeCount ?? assignedUserIds.length;
  const compactAudit = useMemo(() => compactAuditEntries(asArray<AuditEntry>(messageAudit), users), [messageAudit, users]);
  const visibleAudit = auditExpanded ? compactAudit : compactAudit.slice(0, 5);

  const filteredMessages = useMemo(() => {
    const base = messages.filter((row) => {
      if (view === "linked_to_case") return row.message.linkedCaseId != null;
      if (view === "no_case") return row.message.linkedCaseId == null;
      return true;
    });
    return base;
  }, [messages, view]);

  const [draftEditForm, setDraftEditForm] = useState({ to: "", cc: "", subject: "", bodyText: "" });

  useEffect(() => {
    if (!selectedDraft) return;
    setDraftEditForm({
      to: asStringArray(selectedDraft.draft.toAddresses).join(", "),
      cc: asStringArray(selectedDraft.draft.ccAddresses).join(", "),
      subject: selectedDraft.draft.subject || "",
      bodyText: selectedDraft.draft.bodyText || "",
    });
  }, [selectedDraft]);

  const patchDraftMutation = useMutation({
    mutationFn: () => {
      if (!selectedDraftId) throw new Error("No draft selected");
      return apiFetchJson(`/communication/drafts/${selectedDraftId}`, {
        method: "PATCH",
        body: {
          to: splitCommaList(draftEditForm.to),
          cc: splitCommaList(draftEditForm.cc),
          subject: draftEditForm.subject,
          bodyText: draftEditForm.bodyText,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "draft", selectedDraftId] });
      qc.invalidateQueries({ queryKey: ["communication", "drafts"] });
      toast({ title: "Draft updated" });
    },
    onError: (e) => toastError(toast, e),
  });

  const selectedUserOptions = useMemo(() => {
    return users.map((u) => ({ id: u.id, label: u.name || `User ${u.id}` }));
  }, [users]);

  const lawyerUserOptions = useMemo(() => {
    return users.filter((u) => isLawyerLikeRole(u.roleName)).map((u) => ({ id: u.id, label: u.name || `User ${u.id}` }));
  }, [users]);

  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({
    caseRef: "",
    partyName: "",
    bankRef: "",
    propertyRef: "",
    requiredAction: "",
    lawyerInChargeUserId: "",
    handlerUserIds: [] as string[],
    reviewerUserId: "",
    watcherUserIds: [] as string[],
  });

  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [draftForm, setDraftForm] = useState({ to: "", cc: "", subject: "" });

  useEffect(() => {
    if (!selectedMessage) {
      setLinkCaseRef("");
      setLinkCaseError("");
      return;
    }
    setLinkCaseRef("");
    setLinkCaseError("");
  }, [selectedMessage]);

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-0 flex-col gap-3 overflow-hidden">
      <div className="shrink-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">Email Inbox</div>
            <div className="text-sm text-slate-500">Simple internal inbox for assignment, remarks, case linking, and read tracking.</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["communication", "messages"] });
                qc.invalidateQueries({ queryKey: ["communication", "mailboxes"] });
                qc.invalidateQueries({ queryKey: ["communication", "email", "accounts"] });
              }}
            >
              Refresh
            </Button>
            <Button
              variant="outline"
              onClick={() => toast({ title: "Import is not available yet. Please connect and configure a mailbox sync first." })}
            >
              Import Now
            </Button>
            <Button variant="outline" onClick={() => setConnectDialogOpen(true)}>
              Connect Mailbox
            </Button>
            <Button onClick={() => setShowManualEmail(true)}>Manual Add Email</Button>
          </div>
        </div>

        {usersQuery.isError || mailboxesQuery.isError ? (
          <Card>
            <CardContent className="pt-6 space-y-3">
              {usersQuery.isError ? (
                <QueryFallback
                  title="Unable to load user list"
                  error={usersQuery.error}
                  onRetry={() => usersQuery.refetch()}
                  isRetrying={usersQuery.isFetching}
                />
              ) : null}
              {mailboxesQuery.isError ? (
                <QueryFallback
                  title="Unable to load mailboxes"
                  error={mailboxesQuery.error}
                  onRetry={() => mailboxesQuery.refetch()}
                  isRetrying={mailboxesQuery.isFetching}
                />
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden xl:grid-cols-[280px_420px_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Mailboxes & Filters</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-600">Connected mailboxes</div>
              {mailboxes.length === 0 ? (
                <div className="text-xs text-slate-500">No mailboxes found.</div>
              ) : (
                <div className="space-y-1">
                  {mailboxes.map((m) => (
                    <div key={m.id} className="rounded-lg border px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate">{m.displayName || m.address || `Mailbox ${m.id}`}</div>
                        {m.isActive ? <Badge variant="secondary">Active</Badge> : null}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">{m.provider}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-600">Connected account placeholders</div>
              {emailAccounts.length === 0 ? (
                <div className="text-xs text-slate-500">No connected accounts.</div>
              ) : (
                <div className="space-y-1">
                  {emailAccounts.map((a) => (
                    <div key={a.id} className="rounded-lg border px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate">{a.displayName || a.emailAddress}</div>
                        <Badge variant="outline">{a.status}</Badge>
                      </div>
                      <div className="truncate text-[11px] text-slate-500">{a.provider} · {a.emailAddress}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-lg border border-dashed bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-medium">Provider setup status</div>
                <div className="mt-2 space-y-1">
                  <div>Microsoft 365 / Outlook — setup required</div>
                  <div>IMAP — setup required</div>
                  <div>Gmail — coming soon</div>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">Filters</div>
              {([
                ["shared_inbox", "All Emails"],
                ["unread", "Unread"],
                ["assigned_to_me", "Assigned to Me"],
                ["unassigned", "Unassigned"],
                ["linked_to_case", "Linked to Case"],
                ["no_case", "No Case"],
                ["archived", "Archived"],
              ] as Array<[InboxView, string]>).map(([k, label]) => (
                <Button
                  key={k}
                  variant={view === k ? "default" : "outline"}
                  className="w-full justify-start"
                  onClick={() => {
                    setView(k);
                    setSelectedMessageId(null);
                    setSelectedDraftId(null);
                    setSelectedTaskIds([]);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="space-y-2 pb-2">
            <CardTitle className="text-sm">Email List</CardTitle>
            <Input placeholder="Search sender, subject, or body..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          </CardHeader>
          <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            <QuerySection
              isLoading={messagesQuery.isLoading}
              isError={messagesQuery.isError}
              error={messagesQuery.error}
              isFetching={messagesQuery.isFetching}
              onRetry={() => messagesQuery.refetch()}
              isEmpty={filteredMessages.length === 0}
              emptyTitle="No emails found"
              emptyDescription="Try another filter, or use Manual Add Email."
            >
              {filteredMessages.map((row) => (
                <button
                  key={row.message.id}
                  className={[
                    "w-full rounded-xl border p-3 text-left transition-colors",
                    selectedMessageId === row.message.id ? "border-slate-400 bg-slate-50" : "hover:bg-slate-50",
                  ].join(" ")}
                  onClick={() => {
                    setSelectedMessageId(row.message.id);
                    setSelectedDraftId(null);
                    setSelectedTaskIds([]);
                    const lastOpenedAt = openedMessageIdsRef.current.get(row.message.id) ?? 0;
                    const nowTs = Date.now();
                    if (nowTs - lastOpenedAt > 5 * 60 * 1000) {
                      openedMessageIdsRef.current.set(row.message.id, nowTs);
                      recordMessageOpenedMutation.mutate(row.message.id);
                    }
                  }}
                >
                  {(() => {
                    const unread = row.isRead === false;
                    const from = `${row.message.fromName || ""}${row.message.fromName ? " " : ""}<${row.message.fromAddress || ""}>`.trim();
                    const preview = previewText(row.message.bodyText);
                    const ts = formatDateTime(row.message.receivedAt || row.message.lastActivityAt || row.message.createdAt);
                    const primaryAssigneeLabel = row.message.assignedToUserId
                      ? (selectedUserOptions.find((u) => u.id === row.message.assignedToUserId)?.label ?? `User ${row.message.assignedToUserId}`)
                      : "";
                    const assignedLabel = row.assigneeCount > 1
                      ? `${primaryAssigneeLabel || "Assigned"} +${row.assigneeCount - 1}`
                      : (primaryAssigneeLabel || "");

                    return (
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className={unread ? "truncate text-sm font-semibold" : "truncate text-sm font-medium"}>{row.message.subject || "(no subject)"}</div>
                            <div className="truncate text-xs text-slate-500">{from}</div>
                          </div>
                          <div className="shrink-0 text-[11px] text-slate-500">{ts}</div>
                        </div>
                        {preview ? <div className="text-xs text-slate-600">{preview}</div> : null}
                        <div className="flex flex-wrap items-center gap-2">
                          {unread ? <span className="inline-block h-2 w-2 rounded-full bg-blue-500" /> : null}
                          {assignedLabel ? <Badge variant="secondary">{assignedLabel}</Badge> : <Badge variant="outline">Unassigned</Badge>}
                          {row.message.linkedCaseId ? <Badge variant="secondary">Linked Case</Badge> : null}
                          {row.hasAttachments ? <Badge variant="outline">{row.attachmentCount} attachment{row.attachmentCount === 1 ? "" : "s"}</Badge> : null}
                        </div>
                      </div>
                    );
                  })()}
                </button>
              ))}
            </QuerySection>
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Email Detail</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto">
            {selectedDraftId ? (
              <Empty className="border border-dashed border-slate-200 bg-slate-50/50 py-10">
                <EmptyHeader>
                  <EmptyTitle>Advanced workflow hidden</EmptyTitle>
                  <EmptyDescription>Draft and approval workflow stay out of the inbox UI.</EmptyDescription>
                </EmptyHeader>
                <div className="mt-4 flex justify-center">
                  <Button variant="outline" onClick={() => setSelectedDraftId(null)}>Back to Inbox</Button>
                </div>
              </Empty>
            ) : selectedMessageId ? (
              <QuerySection
                isLoading={selectedMessageQuery.isLoading}
                isError={selectedMessageQuery.isError}
                error={selectedMessageQuery.error}
                isFetching={selectedMessageQuery.isFetching}
                onRetry={() => selectedMessageQuery.refetch()}
                isEmpty={!selectedMessage}
                emptyTitle="Message unavailable"
                emptyDescription="Select another message or refresh the list."
              >
                {selectedMessage ? (
                  <div className="space-y-4">
                    <div className="rounded-xl border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-lg font-semibold">{selectedMessage.subject || `(Message #${selectedMessage.id})`}</div>
                          <div className="mt-1 text-sm text-slate-500">
                            {selectedMessage.fromName || selectedMessage.fromAddress || "-"} · {formatDateTime(selectedMessage.receivedAt || selectedMessage.sentAt || selectedMessage.createdAt)}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant={selectedMessageIsRead ? "outline" : "secondary"}>{selectedMessageIsRead ? "Read" : "Unread"}</Badge>
                          <Badge variant="outline">{selectedMessageAssignedCount > 0 ? "Assigned" : "Unassigned"}</Badge>
                          <Badge variant="outline">{selectedMessage.linkedCaseId ? "Linked Case" : "No Case"}</Badge>
                          <Badge variant="outline">{selectedMessageHasAttachments ? `${selectedMessageAttachmentCount} attachment${selectedMessageAttachmentCount === 1 ? "" : "s"}` : "No attachments"}</Badge>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => readStatusMutation.mutate({ messageId: selectedMessage.id, isRead: !selectedMessageIsRead })}
                          disabled={readStatusMutation.isPending}
                        >
                          {selectedMessageIsRead ? "Mark Unread" : "Mark Read"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => archiveMessageMutation.mutate({ messageId: selectedMessage.id, archived: selectedMessage.internalStatus !== "archived" })}
                          disabled={archiveMessageMutation.isPending}
                        >
                          {selectedMessage.internalStatus === "archived" ? "Unarchive" : "Archive"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setAssigneesDialogOpen(true)}>
                          Edit Assigned Users
                        </Button>
                        {selectedMessage.linkedCaseId ? (
                          <Button variant="outline" size="sm" onClick={() => unlinkMessageCaseMutation.mutate(selectedMessage.id)} disabled={unlinkMessageCaseMutation.isPending}>
                            Unlink Case
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="rounded-xl border p-4 space-y-3">
                      <div className="text-sm font-medium">Body</div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label>From</Label>
                          <Input value={`${selectedMessage.fromName || ""} <${selectedMessage.fromAddress || ""}>`.trim()} readOnly />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Received / Sent</Label>
                          <Input value={formatDateTime(selectedMessage.receivedAt || selectedMessage.sentAt || selectedMessage.createdAt || "")} readOnly />
                        </div>
                        <div className="space-y-1.5 md:col-span-2">
                          <Label>To</Label>
                          <Input value={(selectedMessage.toAddresses ?? []).join(", ")} readOnly />
                        </div>
                        <div className="space-y-1.5 md:col-span-2">
                          <Label>CC</Label>
                          <Input value={(selectedMessage.ccAddresses ?? []).join(", ")} readOnly />
                        </div>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap">{selectedMessage.bodyText || ""}</div>
                      <div className="space-y-2">
                        <Label>Attachments</Label>
                        <div className="rounded-lg border p-3 space-y-2">
                          {selectedAttachmentsQuery.isFetching ? (
                            <div className="text-sm text-slate-500">Loading attachments...</div>
                          ) : asArray<Attachment>(selectedAttachmentsQuery.data).length ? (
                            asArray<Attachment>(selectedAttachmentsQuery.data).map((a) => (
                              <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
                                <div className="truncate">{a.filename}</div>
                                <div className="text-xs text-slate-500">{a.sizeBytes ? `${a.sizeBytes} bytes` : ""}</div>
                              </div>
                            ))
                          ) : (
                            <div className="text-sm text-slate-500">No attachments.</div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-2">
                      <div className="rounded-xl border p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium">Assigned Users</div>
                          <Button variant="outline" size="sm" onClick={() => setAssigneesDialogOpen(true)}>Edit</Button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {assignedUserIds.length ? assignedUserIds.map((id) => (
                            <Badge key={id} variant="secondary">
                              {selectedUserOptions.find((u) => u.id === id)?.label ?? `User ${id}`}
                            </Badge>
                          )) : <div className="text-sm text-slate-500">No assigned users.</div>}
                        </div>
                      </div>

                      <div className="rounded-xl border p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium">Linked Case</div>
                          {selectedMessage.linkedCaseId ? (
                            <Button variant="outline" size="sm" onClick={() => unlinkMessageCaseMutation.mutate(selectedMessage.id)} disabled={unlinkMessageCaseMutation.isPending}>
                              Unlink
                            </Button>
                          ) : null}
                        </div>
                        {selectedMessage.linkedCaseId ? (
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">Linked Case: Case #{selectedMessage.linkedCaseId}</div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex gap-2">
                              <Input
                                placeholder="Search case reference / purchaser / parcel"
                                value={linkCaseRef}
                                onChange={(e) => {
                                  setLinkCaseRef(e.target.value);
                                  setLinkCaseError("");
                                }}
                              />
                              <Button
                                variant="outline"
                                onClick={() => {
                                  const value = linkCaseRef.trim();
                                  if (!value) {
                                    setLinkCaseError("Enter a case reference, purchaser, or parcel keyword.");
                                    return;
                                  }
                                  if (!caseLookupQuery.isFetching && value.length >= 2 && asArray<CaseLookupRow>(caseLookupQuery.data).length === 0) {
                                    setLinkCaseError("No matching case found.");
                                    return;
                                  }
                                  linkMessageCaseMutation.mutate({ messageId: selectedMessage.id, caseRef: value });
                                }}
                                disabled={linkMessageCaseMutation.isPending}
                              >
                                Link
                              </Button>
                            </div>
                            {linkCaseError ? <div className="text-xs text-red-600">{linkCaseError}</div> : null}
                            {caseLookupQuery.isFetching ? <div className="text-xs text-slate-500">Searching cases...</div> : null}
                            {linkCaseRef.trim().length >= 2 && caseLookupQuery.data?.length ? (
                              <div className="rounded-lg border p-2 space-y-1">
                                {asArray<CaseLookupRow>(caseLookupQuery.data).map((c) => (
                                  <button
                                    key={c.id}
                                    className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-slate-50"
                                    onClick={() => linkMessageCaseMutation.mutate({ messageId: selectedMessage.id, caseId: c.id })}
                                    disabled={linkMessageCaseMutation.isPending}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="truncate">{c.caseRef || `Case #${c.id}`}</div>
                                      <div className="truncate text-xs text-slate-500">{c.developerName || ""}</div>
                                    </div>
                                    <div className="truncate text-xs text-slate-500">{c.status}</div>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border p-4 space-y-3 xl:col-span-2">
                        <div className="text-sm font-medium">Remarks</div>
                        <div className="space-y-2">
                          {selectedRemarksQuery.isFetching ? (
                            <div className="text-sm text-slate-500">Loading remarks...</div>
                          ) : asArray<Remark>(selectedRemarksQuery.data).length ? (
                            asArray<Remark>(selectedRemarksQuery.data).map((r) => (
                              <div key={r.id} className="rounded-lg border p-3 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="text-xs text-slate-500">
                                    {r.userName || `User ${r.userId}`} · {formatDateTime(r.createdAt)}
                                    {r.updatedAt && r.updatedAt !== r.createdAt ? " (edited)" : ""}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => {
                                        setEditingRemarkId(r.id);
                                        setEditingRemarkBody(r.body);
                                      }}
                                    >
                                      Edit
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => deleteRemarkMutation.mutate(r.id)} disabled={deleteRemarkMutation.isPending}>
                                      Delete
                                    </Button>
                                  </div>
                                </div>
                                {editingRemarkId === r.id ? (
                                  <div className="space-y-2">
                                    <Textarea value={editingRemarkBody} onChange={(e) => setEditingRemarkBody(e.target.value)} rows={3} />
                                    <div className="flex justify-end gap-2">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                          setEditingRemarkId(null);
                                          setEditingRemarkBody("");
                                        }}
                                      >
                                        Cancel
                                      </Button>
                                      <Button size="sm" onClick={() => updateRemarkMutation.mutate({ remarkId: r.id, body: editingRemarkBody.trim() })} disabled={updateRemarkMutation.isPending}>
                                        Save
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-sm whitespace-pre-wrap">{r.body}</div>
                                )}
                              </div>
                            ))
                          ) : (
                            <div className="text-sm text-slate-500">No remarks yet. Add the first remark.</div>
                          )}
                        </div>
                        <div className="rounded-lg bg-slate-50 p-3 space-y-2">
                          <Textarea placeholder="Add a remark..." value={newRemarkBody} onChange={(e) => setNewRemarkBody(e.target.value)} rows={3} />
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              onClick={() => {
                                const value = newRemarkBody.trim();
                                if (!value) return;
                                createRemarkMutation.mutate({ messageId: selectedMessage.id, body: value });
                              }}
                              disabled={createRemarkMutation.isPending}
                            >
                              Add Remark
                            </Button>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border p-4 space-y-3">
                        <div className="text-sm font-medium">Opened By</div>
                        {selectedReadsQuery.isFetching ? (
                          <div className="text-sm text-slate-500">Loading opened by...</div>
                        ) : asArray<MessageRead>(selectedReadsQuery.data).length ? (
                          <div className="space-y-2">
                            {asArray<MessageRead>(selectedReadsQuery.data).map((r) => (
                              <div key={r.id} className="text-sm text-slate-700">
                                <span className="font-medium">{r.userName || `User ${r.userId}`}</span>
                                {" — "}
                                opened {r.openedCount} time{r.openedCount === 1 ? "" : "s"}, last {formatDateTime(r.lastOpenedAt)}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-slate-500">No opens yet.</div>
                        )}
                      </div>

                      <div className="rounded-xl border p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium">Audit</div>
                          {compactAudit.length > 5 ? (
                            <Button variant="outline" size="sm" onClick={() => setAuditExpanded((value) => !value)}>
                              {auditExpanded ? "Show less" : "Show all"}
                            </Button>
                          ) : null}
                        </div>
                        {selectedMessageAuditQuery.isFetching ? (
                          <div className="text-sm text-slate-500">Loading audit...</div>
                        ) : visibleAudit.length ? (
                          <div className="space-y-2">
                            {visibleAudit.map((entry) => (
                              <div key={entry.key} className="text-sm text-slate-700">
                                <div>{entry.label}</div>
                                <div className="text-xs text-slate-500">{formatDateTime(entry.createdAt)}</div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-slate-500">No audit entries yet.</div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </QuerySection>
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed text-sm text-slate-500">Select a message.</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={assigneesDialogOpen} onOpenChange={setAssigneesDialogOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit Assigned Users</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
            <div className="text-sm text-slate-500">Select one or more users for this email.</div>
            <div className="rounded-lg border p-3 space-y-2">
              {selectedUserOptions.map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={assignedUserIds.includes(u.id)}
                    onCheckedChange={(checked) => {
                      setAssignedUserIds((prev) => checked ? Array.from(new Set([...prev, u.id])) : prev.filter((x) => x !== u.id));
                    }}
                  />
                  <span>{u.label}</span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setAssigneesDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                if (!selectedMessageId) return;
                assigneesMutation.mutate({ messageId: selectedMessageId, userIds: assignedUserIds });
              }}
              disabled={assigneesMutation.isPending || !selectedMessageId}
            >
              Save Assigned Users
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={connectDialogOpen} onOpenChange={setConnectDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect Mailbox</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={connectForm.provider} onValueChange={(v) => setConnectForm((p) => ({ ...p, provider: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="microsoft_graph">Microsoft 365 / Outlook (setup required)</SelectItem>
                  <SelectItem value="imap">IMAP (setup required)</SelectItem>
                  <SelectItem value="gmail">Gmail (coming soon)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Email Address</Label>
              <Input value={connectForm.emailAddress} onChange={(e) => setConnectForm((p) => ({ ...p, emailAddress: e.target.value }))} placeholder="name@firm.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Display Name</Label>
              <Input value={connectForm.displayName} onChange={(e) => setConnectForm((p) => ({ ...p, displayName: e.target.value }))} placeholder="e.g. Conveyancing Shared Inbox" />
            </div>
            <div className="text-xs text-slate-500">
              Connection setup is not enabled yet. This will create a placeholder mailbox account only. Real Microsoft 365 OAuth / IMAP sync will be enabled in the next provider integration phase.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => createEmailAccountMutation.mutate()} disabled={createEmailAccountMutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showManualEmail} onOpenChange={setShowManualEmail}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Manual Add Email</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto pr-2">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-6 space-y-1.5">
              <Label>Mailbox</Label>
              <Select value={manualForm.mailboxId} onValueChange={(v) => setManualForm((p) => ({ ...p, mailboxId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select mailbox" />
                </SelectTrigger>
                <SelectContent>
                  {mailboxes.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.displayName || m.address || `Mailbox ${m.id}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-6 flex items-center gap-2 pt-7">
              <Checkbox checked={manualForm.isBatchEmail} onCheckedChange={(c) => setManualForm((p) => ({ ...p, isBatchEmail: Boolean(c) }))} />
              <Label>Is Batch Email</Label>
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>From Name</Label>
              <Input value={manualForm.fromName} onChange={(e) => setManualForm((p) => ({ ...p, fromName: e.target.value }))} />
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>From Email</Label>
              <Input value={manualForm.fromEmail} onChange={(e) => setManualForm((p) => ({ ...p, fromEmail: e.target.value }))} />
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>To (comma separated)</Label>
              <Input value={manualForm.to} onChange={(e) => setManualForm((p) => ({ ...p, to: e.target.value }))} />
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>CC (comma separated)</Label>
              <Input value={manualForm.cc} onChange={(e) => setManualForm((p) => ({ ...p, cc: e.target.value }))} />
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>Received Date / Time</Label>
              <Input type="datetime-local" value={manualForm.receivedAt} onChange={(e) => setManualForm((p) => ({ ...p, receivedAt: e.target.value }))} />
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Assigned Users</Label>
              <div className="rounded border p-2 max-h-32 overflow-y-auto space-y-2">
                {selectedUserOptions.map((u) => (
                  <div key={u.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={manualForm.handlerUserIds.includes(String(u.id))}
                      onCheckedChange={() => setManualForm((p) => ({ ...p, handlerUserIds: toggleString(p.handlerUserIds, String(u.id)) }))}
                    />
                    <div className="text-sm">{u.label}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Link Case</Label>
              <Input value={manualForm.caseRef} onChange={(e) => setManualForm((p) => ({ ...p, caseRef: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Subject</Label>
              <Input value={manualForm.subject} onChange={(e) => setManualForm((p) => ({ ...p, subject: e.target.value }))} />
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Body</Label>
              <Textarea value={manualForm.bodyText} onChange={(e) => setManualForm((p) => ({ ...p, bodyText: e.target.value }))} rows={8} />
            </div>
          </div>
          </div>
          <DialogFooter className="shrink-0 border-t pt-3 bg-background sticky bottom-0">
            <Button variant="outline" onClick={() => setShowManualEmail(false)}>Cancel</Button>
            <Button onClick={() => manualEmailMutation.mutate()} disabled={manualEmailMutation.isPending}>Add Email</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Add Case Task</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto pr-2">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-12 space-y-1.5">
              <Label>Case Ref / Parcel No</Label>
              <Input value={taskForm.caseRef} onChange={(e) => setTaskForm((p) => ({ ...p, caseRef: e.target.value }))} />
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>Party Name</Label>
              <Input value={taskForm.partyName} onChange={(e) => setTaskForm((p) => ({ ...p, partyName: e.target.value }))} />
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>Bank Ref</Label>
              <Input value={taskForm.bankRef} onChange={(e) => setTaskForm((p) => ({ ...p, bankRef: e.target.value }))} />
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>Property Ref</Label>
              <Input value={taskForm.propertyRef} onChange={(e) => setTaskForm((p) => ({ ...p, propertyRef: e.target.value }))} />
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>Lawyer in Charge *</Label>
              <Select
                value={taskForm.lawyerInChargeUserId}
                onValueChange={(v) => setTaskForm((p) => ({ ...p, lawyerInChargeUserId: v === "unassigned" ? "" : v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Optional (recommended)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {lawyerUserOptions.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Handlers / Clerks</Label>
              <div className="rounded border p-2 max-h-32 overflow-y-auto space-y-2">
                {selectedUserOptions.map((u) => (
                  <div key={u.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={taskForm.handlerUserIds.includes(String(u.id))}
                      onCheckedChange={() => setTaskForm((p) => ({ ...p, handlerUserIds: toggleString(p.handlerUserIds, String(u.id)) }))}
                    />
                    <div className="text-sm">{u.label}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>Reviewer / Approver</Label>
              <Select value={taskForm.reviewerUserId} onValueChange={(v) => setTaskForm((p) => ({ ...p, reviewerUserId: v === "none" ? "" : v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {lawyerUserOptions.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-6 space-y-1.5">
              <Label>Watchers</Label>
              <div className="rounded border p-2 max-h-32 overflow-y-auto space-y-2">
                {selectedUserOptions.map((u) => (
                  <div key={u.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={taskForm.watcherUserIds.includes(String(u.id))}
                      onCheckedChange={() => setTaskForm((p) => ({ ...p, watcherUserIds: toggleString(p.watcherUserIds, String(u.id)) }))}
                    />
                    <div className="text-sm">{u.label}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Required Action</Label>
              <Input value={taskForm.requiredAction} onChange={(e) => setTaskForm((p) => ({ ...p, requiredAction: e.target.value }))} />
            </div>
          </div>
          </div>
          <DialogFooter className="shrink-0 border-t pt-3 bg-background sticky bottom-0">
            <Button variant="outline" onClick={() => setTaskDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => {
              if (!selectedMessageId) return;
              createTaskMutation.mutate({
                messageId: selectedMessageId,
                payload: {
                  caseRef: taskForm.caseRef || undefined,
                  partyName: taskForm.partyName || undefined,
                  bankRef: taskForm.bankRef || undefined,
                  propertyRef: taskForm.propertyRef || undefined,
                  requiredAction: taskForm.requiredAction || undefined,
                  team: {
                    lawyerInChargeUserId: taskForm.lawyerInChargeUserId ? parseInt(taskForm.lawyerInChargeUserId, 10) : null,
                    handlerUserIds: taskForm.handlerUserIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n)),
                    reviewerUserId: taskForm.reviewerUserId ? parseInt(taskForm.reviewerUserId, 10) : null,
                    watcherUserIds: taskForm.watcherUserIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n)),
                  },
                },
              });
              setTaskDialogOpen(false);
              setTaskForm({ caseRef: "", partyName: "", bankRef: "", propertyRef: "", requiredAction: "", lawyerInChargeUserId: "", handlerUserIds: [], reviewerUserId: "", watcherUserIds: [] });
            }} disabled={createTaskMutation.isPending}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={draftDialogOpen} onOpenChange={setDraftDialogOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Create Draft</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto pr-2">
            <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>To</Label>
              <Input value={draftForm.to} onChange={(e) => setDraftForm((p) => ({ ...p, to: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>CC</Label>
              <Input value={draftForm.cc} onChange={(e) => setDraftForm((p) => ({ ...p, cc: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Subject</Label>
              <Input value={draftForm.subject} onChange={(e) => setDraftForm((p) => ({ ...p, subject: e.target.value }))} />
            </div>
            <div className="text-xs text-slate-500">Selected tasks: {selectedTaskIds.join(", ")}</div>
          </div>
          </div>
          <DialogFooter className="shrink-0 border-t pt-3 bg-background sticky bottom-0">
            <Button variant="outline" onClick={() => setDraftDialogOpen(false)}>Cancel</Button>
            <Button variant="outline" onClick={() => {
              if (!selectedMessageId) return;
              if (selectedTaskIds.length === 0) {
                toast({ title: "Add at least one task", description: "Create a child task first, then select it to include in the draft.", variant: "destructive" });
                return;
              }
              createDraftMutation.mutate({ type: "partial", parentMessageId: selectedMessageId, taskIds: selectedTaskIds, to: draftForm.to, cc: draftForm.cc, subject: draftForm.subject });
              setDraftDialogOpen(false);
            }} disabled={createDraftMutation.isPending}>
              Partial Draft
            </Button>
            <Button onClick={() => {
              if (!selectedMessageId) return;
              if (selectedTaskIds.length === 0) {
                toast({ title: "Add at least one task", description: "Create a child task first, then select it to include in the draft.", variant: "destructive" });
                return;
              }
              createDraftMutation.mutate({ type: "consolidated", parentMessageId: selectedMessageId, taskIds: selectedTaskIds, to: draftForm.to, cc: draftForm.cc, subject: draftForm.subject });
              setDraftDialogOpen(false);
            }} disabled={createDraftMutation.isPending}>
              Consolidated Draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
