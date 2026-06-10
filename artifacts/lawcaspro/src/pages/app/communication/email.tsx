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

type InboxView = "shared_inbox" | "unassigned" | "my_tasks" | "batch_emails" | "drafts_pending_approval" | "overdue" | "closed";

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
    fromAddress: string | null;
    fromName: string | null;
    subject: string | null;
    internalStatus: string;
    isBatch: boolean;
    assignedToUserId: number | null;
    linkedCaseId: number | null;
    receivedAt: string | null;
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

function normalizeMessageDetail(value: unknown): MessageDetail | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    ...(record as unknown as MessageDetail),
    toAddresses: asStringArray(record.toAddresses),
    ccAddresses: asStringArray(record.ccAddresses),
    bccAddresses: asStringArray(record.bccAddresses),
  };
}

function splitCommaList(v: string): string[] {
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

function StatusBadge({ value }: { value: string }) {
  const v = String(value ?? "");
  return <Badge variant="outline">{v}</Badge>;
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
      if (view === "batch_emails") params.set("isBatch", "true");
      if (view === "closed") params.set("status", "closed,fully_replied");
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
    assignedToUserId: "",
    caseRef: "",
    isBatchEmail: true,
  });

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
        assignedToUserId: manualForm.assignedToUserId && manualForm.assignedToUserId !== "unassigned" ? parseInt(manualForm.assignedToUserId, 10) : undefined,
        caseRef: manualForm.caseRef || undefined,
        isBatchEmail: manualForm.isBatchEmail,
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
        assignedToUserId: "",
        caseRef: "",
        isBatchEmail: true,
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

  const assignMessageMutation = useMutation({
    mutationFn: (args: { messageId: number; assignedToUserId: number | null }) =>
      apiFetchJson(`/communication/messages/${args.messageId}/assign`, { method: "PATCH", body: { assignedToUserId: args.assignedToUserId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communication", "messages"] });
      qc.invalidateQueries({ queryKey: ["communication", "message"] });
    },
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

  const taskAssignMutation = useMutation({
    mutationFn: (args: { taskId: number; assignedToUserId: number | null }) => apiFetchJson(`/communication/tasks/${args.taskId}/assign`, { method: "PATCH", body: { assignedToUserId: args.assignedToUserId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] }),
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
    onSuccess: (draft) => {
      qc.invalidateQueries({ queryKey: ["communication", "drafts"] });
      qc.invalidateQueries({ queryKey: ["communication", "message", selectedMessageId, "tasks"] });
      if (draft?.id) {
        setSelectedDraftId(draft.id);
        setView("drafts_pending_approval");
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "drafts"] }),
    onError: (e) => toastError(toast, e),
  });

  const markSentMutation = useMutation({
    mutationFn: (draftId: number) => apiFetchJson(`/communication/drafts/${draftId}/mark-sent`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "drafts"] }),
    onError: (e) => toastError(toast, e),
  });

  const cancelDraftMutation = useMutation({
    mutationFn: (draftId: number) => apiFetchJson(`/communication/drafts/${draftId}/cancel`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communication", "drafts"] }),
    onError: (e) => toastError(toast, e),
  });

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

  const messages = asArray<MessageRow>(messagesQuery.data);
  const tasksMine = asArray<Task>(tasksMineQuery.data);
  const draftsPending = asArray<Draft>(draftsPendingQuery.data);
  const overdue = asArray<any>(overdueQuery.data);

  const selectedMessage = selectedMessageQuery.data ?? null;
  const selectedTasks = asArray<Task>(selectedTasksQuery.data);
  const messageAudit = asArray<any>(selectedMessageAuditQuery.data);

  const selectedDraft = selectedDraftQuery.data ?? null;
  const draftAudit = asArray<any>(selectedDraftAuditQuery.data);

  const selectedUserOptions = useMemo(() => {
    return users.map((u) => ({ id: u.id, label: u.name || `User ${u.id}` }));
  }, [users]);

  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({ caseRef: "", partyName: "", bankRef: "", propertyRef: "", assignedToUserId: "", requiredAction: "" });

  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [draftForm, setDraftForm] = useState({ to: "", cc: "", subject: "" });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Email Control Center</div>
        <Button onClick={() => setShowManualEmail(true)}>Manual Email</Button>
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Inbox</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {([
              ["shared_inbox", "Shared Inbox"],
              ["unassigned", "Unassigned"],
              ["my_tasks", "My Tasks"],
              ["batch_emails", "Batch Emails"],
              ["drafts_pending_approval", "Drafts Pending Approval"],
              ["overdue", "Overdue"],
              ["closed", "Closed"],
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
          </CardContent>
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">List</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {view === "my_tasks" ? (
              <QuerySection
                isLoading={tasksMineQuery.isLoading}
                isError={tasksMineQuery.isError}
                error={tasksMineQuery.error}
                isFetching={tasksMineQuery.isFetching}
                onRetry={() => tasksMineQuery.refetch()}
                isEmpty={tasksMine.length === 0}
                emptyTitle="No tasks assigned yet"
                emptyDescription="Assigned communication tasks will appear here."
              >
                {tasksMine.map((t) => (
                  <button key={t.id} className="w-full text-left rounded border p-2 hover:bg-slate-50" onClick={() => {
                    setSelectedMessageId(t.parentMessageId);
                    setSelectedDraftId(null);
                    viewMessageMutation.mutate(t.parentMessageId);
                  }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{t.caseRef || `Task #${t.id}`}</div>
                      <StatusBadge value={t.taskStatus} />
                    </div>
                    <div className="text-xs text-slate-500">{t.partyName || ""}</div>
                  </button>
                ))}
              </QuerySection>
            ) : view === "drafts_pending_approval" ? (
              <QuerySection
                isLoading={draftsPendingQuery.isLoading}
                isError={draftsPendingQuery.isError}
                error={draftsPendingQuery.error}
                isFetching={draftsPendingQuery.isFetching}
                onRetry={() => draftsPendingQuery.refetch()}
                isEmpty={draftsPending.length === 0}
                emptyTitle="No drafts pending approval"
                emptyDescription="Submitted communication drafts will appear here."
              >
                {draftsPending.map((d) => (
                  <button key={d.id} className="w-full text-left rounded border p-2 hover:bg-slate-50" onClick={() => {
                    setSelectedDraftId(d.id);
                    setSelectedMessageId(null);
                  }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{d.subject || `Draft #${d.id}`}</div>
                      <StatusBadge value={d.status} />
                    </div>
                    <div className="text-xs text-slate-500">Type: {d.draftType}</div>
                  </button>
                ))}
              </QuerySection>
            ) : view === "overdue" ? (
              <QuerySection
                isLoading={overdueQuery.isLoading}
                isError={overdueQuery.isError}
                error={overdueQuery.error}
                isFetching={overdueQuery.isFetching}
                onRetry={() => overdueQuery.refetch()}
                isEmpty={overdue.length === 0}
                emptyTitle="No overdue items"
                emptyDescription="Overdue messages, tasks, and drafts will appear here."
              >
                {overdue.map((o: any) => (
                  <div key={`${o.kind}-${o.entity_id}`} className="rounded border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{String(o.subject ?? "")}</div>
                      <Badge variant="destructive">{String(o.kind)}</Badge>
                    </div>
                    <div className="text-xs text-slate-500">{String(o.event_at ?? "")}</div>
                  </div>
                ))}
              </QuerySection>
            ) : (
              <QuerySection
                isLoading={messagesQuery.isLoading}
                isError={messagesQuery.isError}
                error={messagesQuery.error}
                isFetching={messagesQuery.isFetching}
                onRetry={() => messagesQuery.refetch()}
                isEmpty={messages.length === 0}
                emptyTitle="No messages yet"
                emptyDescription="Create a manual email to start."
              >
                {messages.map((row) => (
                  <button key={row.message.id} className="w-full text-left rounded border p-2 hover:bg-slate-50" onClick={() => {
                    setSelectedMessageId(row.message.id);
                    setSelectedDraftId(null);
                    setSelectedTaskIds([]);
                    viewMessageMutation.mutate(row.message.id);
                  }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">{row.message.subject || "(no subject)"}</div>
                      <div className="flex items-center gap-2">
                        {row.message.isBatch ? <Badge variant="secondary">Batch</Badge> : null}
                        <StatusBadge value={row.message.internalStatus} />
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 truncate">{row.message.fromAddress || ""}</div>
                    {row.message.isBatch ? (
                      <div className="text-xs text-slate-500 mt-1">
                        {row.tasksReady}/{row.tasksTotal} ready • {row.tasksReplied}/{row.tasksTotal} replied • {row.tasksUnassigned} pending
                      </div>
                    ) : null}
                  </button>
                ))}
              </QuerySection>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Detail</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedDraftId ? (
              <QuerySection
                isLoading={selectedDraftQuery.isLoading}
                isError={selectedDraftQuery.isError}
                error={selectedDraftQuery.error}
                isFetching={selectedDraftQuery.isFetching}
                onRetry={() => selectedDraftQuery.refetch()}
                isEmpty={!selectedDraft}
                emptyTitle="Draft unavailable"
                emptyDescription="Select another draft or refresh the list."
              >
                {selectedDraft ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">{selectedDraft.draft.subject || `Draft #${selectedDraft.draft.id}`}</div>
                      <StatusBadge value={selectedDraft.draft.status} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>To</Label>
                        <Input value={draftEditForm.to} onChange={(e) => setDraftEditForm((prev) => ({ ...prev, to: e.target.value }))} />
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>CC</Label>
                        <Input value={draftEditForm.cc} onChange={(e) => setDraftEditForm((prev) => ({ ...prev, cc: e.target.value }))} />
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>Subject</Label>
                        <Input value={draftEditForm.subject} onChange={(e) => setDraftEditForm((prev) => ({ ...prev, subject: e.target.value }))} />
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>Body</Label>
                        <Textarea value={draftEditForm.bodyText} onChange={(e) => setDraftEditForm((prev) => ({ ...prev, bodyText: e.target.value }))} rows={8} />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => patchDraftMutation.mutate()} disabled={patchDraftMutation.isPending}>Save Draft</Button>
                      <Button variant="outline" onClick={() => submitDraftMutation.mutate(selectedDraft.draft.id)} disabled={submitDraftMutation.isPending}>Submit Approval</Button>
                      <Button variant="outline" onClick={() => approveDraftMutation.mutate(selectedDraft.draft.id)} disabled={approveDraftMutation.isPending}>Approve</Button>
                      <Button onClick={() => markSentMutation.mutate(selectedDraft.draft.id)} disabled={markSentMutation.isPending}>Mark Sent</Button>
                      <Button variant="destructive" onClick={() => cancelDraftMutation.mutate(selectedDraft.draft.id)} disabled={cancelDraftMutation.isPending}>Cancel</Button>
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium">Included Tasks</div>
                      <div className="space-y-2">
                        {selectedDraft.tasks.map((t) => (
                          <div key={t.id} className="rounded border p-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-sm font-medium">{t.caseRef || `Task #${t.id}`}</div>
                              <StatusBadge value={t.taskStatus} />
                            </div>
                            <div className="text-xs text-slate-500 whitespace-pre-wrap">{t.replyNote || ""}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium">Audit</div>
                      <QuerySection
                        isLoading={selectedDraftAuditQuery.isLoading}
                        isError={selectedDraftAuditQuery.isError}
                        error={selectedDraftAuditQuery.error}
                        isFetching={selectedDraftAuditQuery.isFetching}
                        onRetry={() => selectedDraftAuditQuery.refetch()}
                        isEmpty={draftAudit.length === 0}
                        emptyTitle="No draft audit entries yet"
                        emptyDescription="Approval and send actions will appear here."
                        loadingText="Loading audit..."
                      >
                        <div className="space-y-1">
                          {(draftAudit ?? []).map((a: any) => (
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
                        {selectedMessage.isBatch ? <Badge variant="secondary">Batch</Badge> : null}
                        <StatusBadge value={selectedMessage.internalStatus} />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>From</Label>
                        <Input value={`${selectedMessage.fromName || ""} <${selectedMessage.fromAddress || ""}>`.trim()} readOnly />
                      </div>
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>Received / Sent</Label>
                        <Input value={selectedMessage.receivedAt || selectedMessage.sentAt || selectedMessage.createdAt || ""} readOnly />
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
                        <Label>Assigned Owner</Label>
                        <Select
                          value={selectedMessage.assignedToUserId ? String(selectedMessage.assignedToUserId) : "unassigned"}
                          onValueChange={(v) => assignMessageMutation.mutate({ messageId: selectedMessage.id, assignedToUserId: v === "unassigned" ? null : parseInt(v, 10) })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select owner" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="unassigned">Unassigned</SelectItem>
                            {selectedUserOptions.map((u) => (
                              <SelectItem key={u.id} value={String(u.id)}>{u.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>Linked Case (Ref or Parcel No)</Label>
                        <div className="flex gap-2">
                          <Input
                            placeholder="e.g. REF123 / TEST-REGRESSION-001"
                            defaultValue={selectedMessage.linkedCaseId ? `Case #${selectedMessage.linkedCaseId}` : ""}
                            onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const v = (e.target as any).value;
                              if (v) linkMessageCaseMutation.mutate({ messageId: selectedMessage.id, caseRef: String(v) });
                            }
                            }}
                          />
                          <Button variant="outline" onClick={() => closeMessageMutation.mutate(selectedMessage.id)} disabled={closeMessageMutation.isPending}>Close</Button>
                        </div>
                      </div>
                      <div className="md:col-span-12 space-y-1.5">
                        <Label>Body</Label>
                        <Textarea value={selectedMessage.bodyText || ""} readOnly rows={6} />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">{selectedMessage.isBatch ? "Child Case Tasks" : "Email Tasks"}</div>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" onClick={() => setTaskDialogOpen(true)} disabled={createTaskMutation.isPending}>Add Task</Button>
                          <Button onClick={() => setDraftDialogOpen(true)} disabled={!selectedTaskIds.length}>Create Draft</Button>
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
                                  <Label className="text-xs">Assign</Label>
                                  <Select
                                    value={t.assignedToUserId ? String(t.assignedToUserId) : "unassigned"}
                                    onValueChange={(v) => taskAssignMutation.mutate({ taskId: t.id, assignedToUserId: v === "unassigned" ? null : parseInt(v, 10) })}
                                  >
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="unassigned">Unassigned</SelectItem>
                                      {selectedUserOptions.map((u) => (
                                        <SelectItem key={u.id} value={String(u.id)}>{u.label}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
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
              <div className="text-sm text-slate-500">Select a message or draft.</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showManualEmail} onOpenChange={setShowManualEmail}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Manual Incoming Email</DialogTitle>
          </DialogHeader>
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
            <div className="md:col-span-6 space-y-1.5">
              <Label>Responsible Owner</Label>
              <Select value={manualForm.assignedToUserId} onValueChange={(v) => setManualForm((p) => ({ ...p, assignedToUserId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {selectedUserOptions.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Related Case (Ref or Parcel No)</Label>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowManualEmail(false)}>Cancel</Button>
            <Button onClick={() => manualEmailMutation.mutate()} disabled={manualEmailMutation.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add Case Task</DialogTitle>
          </DialogHeader>
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
              <Label>Assign To</Label>
              <Select value={taskForm.assignedToUserId} onValueChange={(v) => setTaskForm((p) => ({ ...p, assignedToUserId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {selectedUserOptions.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-12 space-y-1.5">
              <Label>Required Action</Label>
              <Input value={taskForm.requiredAction} onChange={(e) => setTaskForm((p) => ({ ...p, requiredAction: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
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
                  assignedToUserId: taskForm.assignedToUserId && taskForm.assignedToUserId !== "unassigned" ? parseInt(taskForm.assignedToUserId, 10) : undefined,
                  requiredAction: taskForm.requiredAction || undefined,
                },
              });
              setTaskDialogOpen(false);
              setTaskForm({ caseRef: "", partyName: "", bankRef: "", propertyRef: "", assignedToUserId: "", requiredAction: "" });
            }} disabled={createTaskMutation.isPending}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={draftDialogOpen} onOpenChange={setDraftDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Draft</DialogTitle>
          </DialogHeader>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraftDialogOpen(false)}>Cancel</Button>
            <Button variant="outline" onClick={() => {
              if (!selectedMessageId) return;
              createDraftMutation.mutate({ type: "partial", parentMessageId: selectedMessageId, taskIds: selectedTaskIds, to: draftForm.to, cc: draftForm.cc, subject: draftForm.subject });
              setDraftDialogOpen(false);
            }} disabled={createDraftMutation.isPending}>
              Partial Draft
            </Button>
            <Button onClick={() => {
              if (!selectedMessageId) return;
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
