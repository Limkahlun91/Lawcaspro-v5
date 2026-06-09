import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";

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

export default function CaseCommunicationTimelineTab(props: { caseId: number }) {
  const query = useQuery<{ messages: TimelineMessage[]; tasks: TimelineTask[] }>({
    queryKey: ["case", props.caseId, "communication-timeline"],
    queryFn: () => apiFetchJson(`/cases/${props.caseId}/communication-timeline`),
    retry: false,
  });

  const data = query.data ?? { messages: [], tasks: [] };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Incoming / Outgoing Messages</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryFallback query={query}>
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
          <QueryFallback query={query}>
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

