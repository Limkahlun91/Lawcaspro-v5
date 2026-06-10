import { type ReactNode, useEffect, useMemo, useState } from "react";
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

  const [view, setView] = useState<InboxView>("shared_inbox");
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [linkCaseRef, setLinkCaseRef] = useState("");
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

  const messagesQuery = useQuery<MessageRow[]>({
    queryKey: ["communication", "messages", view],
    queryFn: () => {
      if (view === "drafts_pending_approval") return [];
      if (view === "my_tasks") return [];
      if (view === "overdue") return [];
      const params = new URLSearchParams();
      if (view === "unassigned") params.set("assignedTo", "unassigned");
      if (view === "assigned_to_me") params.set("assignedTo", "me");
      if (view === "batch_emails") params.set("isBatch", "true");
      if (view === "closed") params.set("status", "closed,fully_replied");
      if (view === "archived") params.set("status", "closed");
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

  const viewMessageMutation = useMutation({
    mutationFn: (messageId: number) => apiFetchJson(`/communication/messages/${messageId}/view`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "audit", "message"] }),
    onError: (e) => toastError(toast, e),
  });

  const linkMessageCaseMutation = useMutation({
    mutationFn: (args: { messageId: number; caseRef: string }) =>
      apiFetchJson(`/communication/messages/${args.messageId}/link-case`, { method: "PATCH", body: { caseRef: args.caseRef } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "message"] }),
    onError: (e) => toastError(toast, e),
  });

  const closeMessageMutation = useMutation({
    mutationFn: (messageId: number) => apiFetchJson(`/communication/messages/${messageId}/close`, { method: "PATCH", body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message"] });
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

  const filteredMessages = useMemo(() => {
    const q = String(search ?? "").trim().toLowerCase();
    const base = messages.filter((row) => {
      if (view === "linked_to_case") return row.message.linkedCaseId != null;
      if (view === "no_case") return row.message.linkedCaseId == null;
      return true;
    });
    if (!q) return base;
    return base.filter((row) => {
      const from = String(row.message.fromAddress ?? "").toLowerCase();
      const subject = String(row.message.subject ?? "").toLowerCase();
      return from.includes(q) || subject.includes(q);
    });
  }, [messages, search, view]);

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
      return;
    }
    setLinkCaseRef("");
  }, [selectedMessage]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Email Inbox</div>
        <Button onClick={() => setShowManualEmail(true)}>Manual Add Email</Button>
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 lg:min-h-[calc(100vh-180px)]">
        <Card className="lg:col-span-3 flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Mailboxes & Filters</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto space-y-3">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">Connected mailboxes</div>
              {mailboxes.length === 0 ? (
                <div className="text-xs text-slate-500">No mailboxes found.</div>
              ) : (
                <div className="space-y-1">
                  {mailboxes.map((m) => (
                    <div key={m.id} className="rounded border px-2 py-1 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate">{m.displayName || m.address || `Mailbox ${m.id}`}</div>
                        {m.isActive ? <Badge variant="secondary">Active</Badge> : null}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">{m.provider}</div>
                    </div>
                  ))}
                </div>
              )}

              <Button variant="outline" className="w-full justify-start opacity-60" disabled>
                Connect Microsoft 365
              </Button>
              <div className="text-[11px] text-slate-500">Coming soon / setup required</div>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">Filters</div>
              {([
                ["shared_inbox", "All Emails"],
                ["unread", "Unread (coming soon)"],
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
                  disabled={k === "unread"}
                  onClick={() => {
                    if (k === "unread") return;
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

        <Card className="lg:col-span-4 flex flex-col">
          <CardHeader className="pb-2 space-y-2">
            <CardTitle className="text-sm">Email List</CardTitle>
            <Input placeholder="Search sender or subject..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto space-y-2">
            {view === "unread" ? (
              <Empty className="border border-dashed border-slate-200 bg-slate-50/50 py-10">
                <EmptyHeader>
                  <EmptyTitle>Unread filter coming soon</EmptyTitle>
                  <EmptyDescription>Unread tracking will be available after inbox schema upgrade.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <QuerySection
                isLoading={messagesQuery.isLoading}
                isError={messagesQuery.isError}
                error={messagesQuery.error}
                isFetching={messagesQuery.isFetching}
                onRetry={() => messagesQuery.refetch()}
                isEmpty={filteredMessages.length === 0}
                emptyTitle="No emails yet"
                emptyDescription="Use Manual Add Email to start."
              >
                {filteredMessages.map((row) => (
                  <button
                    key={row.message.id}
                    className={[
                      "w-full text-left rounded border p-2 transition-colors",
                      selectedMessageId === row.message.id ? "border-slate-400 bg-slate-50" : "hover:bg-slate-50",
                    ].join(" ")}
                    onClick={() => {
                      setSelectedMessageId(row.message.id);
                      setSelectedDraftId(null);
                      setSelectedTaskIds([]);
                      viewMessageMutation.mutate(row.message.id);
                    }}
                  >
                    {(() => {
                      const unread = row.message.providerIsRead === false || String(row.message.internalStatus ?? "").trim().toLowerCase() === "new";
                      const from = `${row.message.fromName || ""}${row.message.fromName ? " " : ""}<${row.message.fromAddress || ""}>`.trim();
                      const preview = previewText(row.message.bodyText);
                      const ts = formatDateTime(row.message.receivedAt || row.message.lastActivityAt || row.message.createdAt);
                      const assignedLabel = row.message.assignedToUserId
                        ? (selectedUserOptions.find((u) => u.id === row.message.assignedToUserId)?.label ?? `User ${row.message.assignedToUserId}`)
                        : "";

                      return (
                        <div className="space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className={unread ? "text-sm font-semibold truncate" : "text-sm font-medium truncate"}>{row.message.subject || "(no subject)"}</div>
                              <div className="text-xs text-slate-500 truncate">{from}</div>
                            </div>
                            <div className="shrink-0 text-[11px] text-slate-500">{ts}</div>
                          </div>
                          {preview ? <div className="text-xs text-slate-600">{preview}</div> : null}
                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            {unread ? <span className="inline-block h-2 w-2 rounded-full bg-blue-500" /> : null}
                            {assignedLabel ? <Badge variant="secondary">{assignedLabel}</Badge> : <Badge variant="outline">Unassigned</Badge>}
                            {row.message.linkedCaseId ? <Badge variant="secondary">Case</Badge> : null}
                            <StatusBadge value={row.message.internalStatus} />
                          </div>
                        </div>
                      );
                    })()}
                  </button>
                ))}
              </QuerySection>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-5 flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Email Detail</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto space-y-4">
            {selectedDraftId ? (
              <Empty className="border border-dashed border-slate-200 bg-slate-50/50 py-10">
                <EmptyHeader>
                  <EmptyTitle>Advanced workflow hidden</EmptyTitle>
                  <EmptyDescription>Draft/approval workflow is not shown in Email Inbox MVP.</EmptyDescription>
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
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">{selectedMessage.subject || `(Message #${selectedMessage.id})`}</div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toast({ title: "Opened by tracking will be available after inbox schema upgrade" })}
                        >
                          Mark Read
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toast({ title: "Opened by tracking will be available after inbox schema upgrade" })}
                        >
                          Mark Unread
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => closeMessageMutation.mutate(selectedMessage.id)} disabled={closeMessageMutation.isPending}>
                          Archive
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>From</Label>
                        <Input value={`${selectedMessage.fromName || ""} <${selectedMessage.fromAddress || ""}>`.trim()} readOnly />
                      </div>
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>Received / Sent</Label>
                        <Input value={formatDateTime(selectedMessage.receivedAt || selectedMessage.sentAt || selectedMessage.createdAt || "")} readOnly />
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>To</Label>
                        <Input value={(selectedMessage.toAddresses ?? []).join(", ")} readOnly />
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>CC</Label>
                        <Input value={(selectedMessage.ccAddresses ?? []).join(", ")} readOnly />
                      </div>
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>Assigned Users</Label>
                        <div className="rounded border p-2 text-sm">
                          {(() => {
                            const ids = getAssignedUserIdsFromMessage(selectedMessage);
                            if (ids.length === 0) return <div className="text-slate-500">Unassigned</div>;
                            return (
                              <div className="flex flex-wrap gap-2">
                                {ids.map((id) => (
                                  <Badge key={id} variant="secondary">
                                    {selectedUserOptions.find((u) => u.id === id)?.label ?? `User ${id}`}
                                  </Badge>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>Linked Case</Label>
                        <div className="space-y-2">
                          <div className="text-xs text-slate-500">{selectedMessage.linkedCaseId ? `Currently linked: Case #${selectedMessage.linkedCaseId}` : "Currently not linked to any case."}</div>
                          <div className="flex gap-2">
                          <Input placeholder="e.g. REF123 / TEST-REGRESSION-001" value={linkCaseRef} onChange={(e) => setLinkCaseRef(e.target.value)} />
                          <Button
                            variant="outline"
                            onClick={() => {
                              const v = String(linkCaseRef ?? "").trim();
                              if (!v) return;
                              linkMessageCaseMutation.mutate({ messageId: selectedMessage.id, caseRef: v });
                            }}
                            disabled={linkMessageCaseMutation.isPending}
                          >
                            Link
                          </Button>
                          </div>
                        </div>
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>Body</Label>
                        <div className="rounded border p-2 text-sm whitespace-pre-wrap">{selectedMessage.bodyText || ""}</div>
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>Remarks</Label>
                        <div className="rounded border p-2 text-sm text-slate-500">Remarks will be available after inbox schema upgrade</div>
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>Opened By</Label>
                        <div className="rounded border p-2 text-sm text-slate-500">Opened by tracking will be available after inbox schema upgrade</div>
                      </div>
                    </div>

                    {showWorkflowUi ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{selectedMessage.isBatch ? "Child Case Tasks" : "Email Tasks"}</div>
                          <div className="flex items-center gap-2">
                            <Button variant="outline" onClick={() => setTaskDialogOpen(true)} disabled={createTaskMutation.isPending}>Add Task</Button>
                            <Button onClick={() => setDraftDialogOpen(true)} disabled={false}>Create Draft</Button>
                          </div>
                        </div>
                        <QuerySection
                          isLoading={selectedTasksQuery.isLoading}
                          isError={selectedTasksQuery.isError}
                          error={selectedTasksQuery.error}
                          isFetching={selectedTasksQuery.isFetching}
                          onRetry={() => selectedTasksQuery.refetch()}
                          isEmpty={selectedTasks.length === 0}
                          emptyTitle="No child case tasks yet"
                          emptyDescription={selectedMessage.isBatch ? "Add a case task to split this batch email." : "Add a task to process this email and prepare a reply draft."}
                          loadingText="Loading child tasks..."
                        >
                          <div className="space-y-2">
                            {selectedTasks.map((t) => (
                              <div key={t.id} className="rounded border p-2 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <Checkbox
                                      checked={selectedTaskIds.includes(t.id)}
                                      onCheckedChange={(c) => {
                                        setSelectedTaskIds((prev) => c ? Array.from(new Set([...prev, t.id])) : prev.filter((x) => x !== t.id));
                                      }}
                                    />
                                    <div className="text-sm font-medium">{t.caseRef || `Task #${t.id}`}</div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <StatusBadge value={t.taskStatus} />
                                    <Button variant="outline" size="sm" onClick={() => taskAcknowledgeMutation.mutate(t.id)} disabled={taskAcknowledgeMutation.isPending}>Acknowledge</Button>
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                                  <div className="md:col-span-4 space-y-1.5">
                                    <Label className="text-xs">Responsible Team</Label>
                                    <div className="rounded border p-2 text-xs space-y-1">
                                      <div>
                                        <span className="text-slate-500">Lawyer:</span>{" "}
                                        {(() => {
                                          const id = t.team?.lawyerInChargeUserId ?? null;
                                          if (!id) return "-";
                                          return selectedUserOptions.find((u) => u.id === id)?.label ?? `User ${id}`;
                                        })()}
                                      </div>
                                      <div>
                                        <span className="text-slate-500">Handlers:</span>{" "}
                                        {(() => {
                                          const ids = t.team?.handlerUserIds ?? [];
                                          if (!ids.length) return "-";
                                          return ids.map((id) => selectedUserOptions.find((u) => u.id === id)?.label ?? `User ${id}`).join(", ");
                                        })()}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="md:col-span-4 space-y-1.5">
                                    <Label className="text-xs">Status</Label>
                                    <Select value={t.taskStatus} onValueChange={(v) => taskStatusMutation.mutate({ taskId: t.id, taskStatus: v })}>
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {[
                                          "pending_owner_review",
                                          "seen_by_owner",
                                          "in_progress",
                                          "waiting_client",
                                          "waiting_developer",
                                          "waiting_bank",
                                          "waiting_lawyer_review",
                                          "ready_to_reply",
                                          "included_in_draft",
                                          "replied",
                                          "closed",
                                        ].map((s) => (
                                          <SelectItem key={s} value={s}>{s}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="md:col-span-4 space-y-1.5">
                                    <Label className="text-xs">Link Case</Label>
                                    <Input placeholder="case ref" onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        const v = (e.target as any).value;
                                        if (v) taskLinkCaseMutation.mutate({ taskId: t.id, caseRef: String(v) });
                                      }
                                    }} />
                                  </div>
                                </div>

                                <div className="space-y-1.5">
                                  <Label className="text-xs">Reply Note</Label>
                                  <Textarea
                                    defaultValue={t.replyNote || ""}
                                    rows={3}
                                    onBlur={(e) => taskReplyNoteMutation.mutate({ taskId: t.id, replyNote: e.target.value })}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        </QuerySection>
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <div className="text-sm font-medium">Audit</div>
                      <QuerySection
                        isLoading={selectedMessageAuditQuery.isLoading}
                        isError={selectedMessageAuditQuery.isError}
                        error={selectedMessageAuditQuery.error}
                        isFetching={selectedMessageAuditQuery.isFetching}
                        onRetry={() => selectedMessageAuditQuery.refetch()}
                        isEmpty={messageAudit.length === 0}
                        emptyTitle="No message audit entries yet"
                        emptyDescription="View, assignment, and workflow changes will appear here."
                        loadingText="Loading audit..."
                      >
                        <div className="space-y-1">
                          {(messageAudit ?? []).map((a: any) => (
                            <div key={a.id} className="text-xs text-slate-600">
                              {String(a.createdAt ?? "")} • {String(a.action ?? "")} • actor {String(a.actorUserId ?? "")}
                            </div>
                          ))}
                        </div>
                      </QuerySection>
                    </div>
                  </div>
                ) : null}
              </QuerySection>
            ) : (
              <div className="text-sm text-slate-500">Select a message.</div>
            )}
          </CardContent>
        </Card>
      </div>

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
