import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { Link } from "wouter";

type TimelineMessage = {
  id: number;
  direction: "incoming" | "outgoing";
  channel: string;
  subject: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  internalStatus: string;
  isBatch: boolean;
};

type TimelineTask = {
  id: number;
  parentMessageId: number;
  caseRef: string | null;
  partyName: string | null;
  bankRef: string | null;
  taskStatus: string;
  replyNote: string | null;
};

type PaymentTimelineEvent = {
  id: string;
  paymentVoucherId: number;
  voucherNo: string;
  eventType: "voucher_created" | "account_received" | "payment_completed" | "action_assigned" | "action_acknowledged" | "action_completed";
  status: string | null;
  approvalStatus: string | null;
  payeeName: string | null;
  nextActionType: string | null;
  eventAt: string | null;
  actionId?: number;
  actionStatus?: string | null;
  acknowledgeDueAt?: string | null;
  completionDueAt?: string | null;
};

function paymentEventLabel(eventType: PaymentTimelineEvent["eventType"]): string {
  switch (eventType) {
    case "voucher_created":
      return "Payment voucher submitted";
    case "account_received":
      return "Received by accounts";
    case "payment_completed":
      return "Payment completed";
    case "action_assigned":
      return "Clerk action assigned";
    case "action_acknowledged":
      return "Clerk action acknowledged";
    case "action_completed":
      return "Clerk action completed";
    default:
      return "Payment voucher activity";
  }
}

export default function CaseCommunicationTimelineTab(props: { caseId: number }) {
  const query = useQuery<{ messages: TimelineMessage[]; tasks: TimelineTask[]; paymentEvents: PaymentTimelineEvent[] }>({
    queryKey: ["case", props.caseId, "communication-timeline"],
    queryFn: () => apiFetchJson(`/cases/${props.caseId}/communication-timeline`),
    retry: false,
  });

  const data = query.data ?? { messages: [], tasks: [], paymentEvents: [] };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Payment Voucher Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryFallback
            title={query.isError ? "Failed to load timeline" : undefined}
            error={query.error}
            onRetry={query.isError ? () => { void query.refetch(); } : undefined}
            isRetrying={query.isFetching}
          >
            <div className="space-y-2">
              {data.paymentEvents.length === 0 ? (
                <div className="text-sm text-slate-500">No payment voucher activity linked to this case.</div>
              ) : data.paymentEvents.map((event) => (
                <div key={event.id} className="rounded border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-slate-900">{paymentEventLabel(event.eventType)}</div>
                    <div className="flex items-center gap-2">
                      {event.approvalStatus ? <Badge variant="outline">{event.approvalStatus.replace(/_/g, " ")}</Badge> : null}
                      {event.actionStatus ? <Badge variant="secondary">{event.actionStatus.replace(/_/g, " ")}</Badge> : null}
                      {event.status ? <Badge variant="outline">{event.status.replace(/_/g, " ")}</Badge> : null}
                    </div>
                  </div>
                  <div className="mt-1 text-sm text-slate-700">{event.voucherNo}{event.payeeName ? ` · ${event.payeeName}` : ""}</div>
                  {event.nextActionType ? (
                    <div className="text-xs text-slate-500">Next action: {event.nextActionType}</div>
                  ) : null}
                  <div className="mt-1 text-xs text-slate-500">
                    {event.eventAt ? new Date(event.eventAt).toLocaleString("en-MY") : "—"}
                  </div>
                  {event.eventType === "action_assigned" ? (
                    <div className="mt-1 text-xs text-slate-500">
                      Acknowledge due: {event.acknowledgeDueAt ? new Date(event.acknowledgeDueAt).toLocaleString("en-MY") : "—"}
                      {" · "}
                      Completion due: {event.completionDueAt ? new Date(event.completionDueAt).toLocaleString("en-MY") : "—"}
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <Link href={`/app/accounting?tab=payment-vouchers`}>
                      <span className="text-xs font-medium text-amber-700 hover:underline cursor-pointer">Open payment vouchers</span>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </QueryFallback>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Incoming / Outgoing Messages</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryFallback
            title={query.isError ? "Failed to load timeline" : undefined}
            error={query.error}
            onRetry={query.isError ? () => { void query.refetch(); } : undefined}
            isRetrying={query.isFetching}
          >
            <div className="space-y-2">
              {data.messages.length === 0 ? (
                <div className="text-sm text-slate-500">No communication messages linked to this case.</div>
              ) : data.messages.map((m) => (
                <div key={m.id} className="rounded border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{m.subject || `(Message #${m.id})`}</div>
                    <div className="flex items-center gap-2">
                      {m.isBatch ? <Badge variant="secondary">Batch</Badge> : null}
                      <Badge variant="outline">{m.direction}</Badge>
                      <Badge variant="outline">{m.internalStatus}</Badge>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">{m.fromAddress || ""}</div>
                  <div className="text-xs text-slate-500">{m.receivedAt || m.sentAt || ""}</div>
                </div>
              ))}
            </div>
          </QueryFallback>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Case Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryFallback
            title={query.isError ? "Failed to load timeline" : undefined}
            error={query.error}
            onRetry={query.isError ? () => { void query.refetch(); } : undefined}
            isRetrying={query.isFetching}
          >
            <div className="space-y-2">
              {data.tasks.length === 0 ? (
                <div className="text-sm text-slate-500">No communication tasks linked to this case.</div>
              ) : data.tasks.map((t) => (
                <div key={t.id} className="rounded border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{t.caseRef || `Task #${t.id}`}</div>
                    <Badge variant="outline">{t.taskStatus}</Badge>
                  </div>
                  <div className="text-xs text-slate-500">Parent message: {t.parentMessageId}</div>
                  <div className="text-xs text-slate-500">{t.partyName || ""} {t.bankRef ? `• ${t.bankRef}` : ""}</div>
                  {t.replyNote ? <div className="text-xs text-slate-600 whitespace-pre-wrap mt-1">{t.replyNote}</div> : null}
                </div>
              ))}
            </div>
          </QueryFallback>
        </CardContent>
      </Card>
    </div>
  );
}
