import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";

type Thread = Record<string, unknown> & { id: number; case_id: number };

export default function CommunicationThreadDetail() {
  const { threadId } = useParams<{ threadId: string }>();
  const [, setLocation] = useLocation();
  const id = threadId ? parseInt(threadId, 10) : NaN;

  const threadQuery = useQuery<Thread>({
    queryKey: ["communication-thread", id],
    queryFn: () => apiFetchJson(`/communications/threads/${id}`),
    enabled: Number.isFinite(id),
    retry: false,
  });
  const { data: thread, isLoading: threadLoading } = threadQuery;

  const messagesQuery = useQuery<Record<string, unknown>[]>({
    queryKey: ["communication-thread-messages", id],
    queryFn: () => apiFetchJson(`/communications/threads/${id}/messages`),
    enabled: Number.isFinite(id),
    retry: false,
  });
  const { data: messages = [], isLoading: msgLoading } = messagesQuery;

  if (!Number.isFinite(id)) return <div>Invalid thread</div>;
  if (threadLoading) return <div>Loading thread...</div>;
  if (threadQuery.isError) return <div className="p-6"><QueryFallback title="Thread unavailable" error={threadQuery.error} onRetry={() => threadQuery.refetch()} isRetrying={threadQuery.isFetching} /></div>;
  if (!thread) return <div>Thread not found</div>;

  const subject = String(thread.subject ?? "Untitled thread");
  const referenceNo = String(thread.reference_no ?? "");
  const createdByName = String(thread.created_by_name ?? "");
  const lastMessageAtRaw = (thread.last_message_at ?? thread.updated_at ?? thread.created_at) as string | undefined;
  const lastAt = lastMessageAtRaw ? new Date(lastMessageAtRaw) : null;
  const unreadCount = Number(thread.unread_count ?? 0);
  const messageCount = Number(thread.message_count ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" className="gap-2 text-slate-600" onClick={() => setLocation("/app/communications")}>
          <ChevronLeft className="w-4 h-4" /> Communications
        </Button>
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => setLocation(`/app/cases/${thread.case_id}?tab=communications&threadId=${thread.id}`)}
        >
          Open in Case <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-amber-600" />
            {subject}
          </CardTitle>
          <div className="text-xs text-slate-500">
            {referenceNo ? `Case ${referenceNo}` : `Case #${thread.case_id}`} · {messageCount} msg · {unreadCount} unread
            {createdByName ? ` · Created by ${createdByName}` : ""}
            {lastAt ? ` · Last ${lastAt.toLocaleString("en-MY")}` : ""}
          </div>
        </CardHeader>
        <CardContent>
          {msgLoading ? (
            <div className="text-sm text-slate-500">Loading messages...</div>
          ) : messagesQuery.isError ? (
            <QueryFallback title="Messages unavailable" error={messagesQuery.error} onRetry={() => messagesQuery.refetch()} isRetrying={messagesQuery.isFetching} />
          ) : messages.length === 0 ? (
            <div className="text-sm text-slate-500">No messages yet.</div>
          ) : (
            <div className="space-y-3">
              {messages.map((m) => {
                const notes = String((m as any).notes ?? "");
                const by = String((m as any).logged_by_name ?? "");
                const createdAtRaw = String((m as any).created_at ?? "");
                const when = createdAtRaw ? new Date(createdAtRaw) : null;
                return (
                  <div key={String((m as any).id)} className="border border-slate-200 rounded-md p-3 bg-white">
                    <div className="text-xs text-slate-500 flex items-center justify-between gap-2">
                      <span className="truncate">{by || "—"}</span>
                      <span className="shrink-0">{when ? when.toLocaleString("en-MY") : "—"}</span>
                    </div>
                    <div className="text-sm text-slate-900 whitespace-pre-wrap mt-1">{notes}</div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
