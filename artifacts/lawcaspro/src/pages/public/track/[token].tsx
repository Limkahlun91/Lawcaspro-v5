import { useMemo, useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Dot, Home } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";

type TrackResponse = {
  firmName: string;
  projectName: string;
  property: string | null;
  purchaserName: string;
  spaStatus: string;
  loanStatus: string | null;
  timeline: Array<{
    stepKey: string;
    stepName: string;
    stepOrder: number;
    pathType: string;
    status: string;
    dateYmd: string | null;
  }>;
};

type PublicMessage = {
  id: string;
  senderType: "client" | "staff";
  senderName: string;
  messageText: string;
  attachments: unknown;
  createdAt: string;
};

function fmtDmy(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export default function TrackingTokenPage() {
  const { token } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const query = useQuery<TrackResponse>({
    queryKey: ["public-track", token],
    queryFn: ({ signal }) => apiFetchJson(`/public/track/${encodeURIComponent(String(token || ""))}`, { signal }),
    enabled: Boolean(token),
    retry: false,
  });

  const messagesQuery = useQuery<{ data: PublicMessage[] }>({
    queryKey: ["public-track-messages", token],
    queryFn: ({ signal }) => apiFetchJson(`/public/track/${encodeURIComponent(String(token || ""))}/messages`, { signal }),
    enabled: Boolean(token),
    retry: false,
  });

  const sendMutation = useMutation({
    mutationFn: async (messageText: string) => {
      return await apiFetchJson(`/public/track/${encodeURIComponent(String(token || ""))}/messages`, {
        method: "POST",
        body: JSON.stringify({ messageText }),
      });
    },
    onSuccess: async () => {
      setDraft("");
      await queryClient.invalidateQueries({ queryKey: ["public-track-messages", token] });
    },
  });

  const timeline = Array.isArray(query.data?.timeline) ? query.data!.timeline : [];
  const activeIndex = useMemo(() => {
    const idx = timeline.findIndex((s) => String(s.status) !== "completed");
    return idx >= 0 ? idx : timeline.length - 1;
  }, [timeline]);

  if (query.isLoading) {
    return (
      <div className="min-h-dvh bg-slate-50">
        <div className="mx-auto max-w-md px-4 py-8">
          <div className="text-center text-slate-500">Loading tracking portal…</div>
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="min-h-dvh bg-slate-50">
        <div className="mx-auto max-w-md px-4 py-8">
          <QueryFallback title="Tracking unavailable" error={query.error} />
        </div>
      </div>
    );
  }

  const data = query.data;
  if (!data) {
    return (
      <div className="min-h-dvh bg-slate-50">
        <div className="mx-auto max-w-md px-4 py-8">
          <Card>
            <CardContent className="py-10 text-center text-slate-600">
              Link not found.
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const messages = Array.isArray(messagesQuery.data?.data) ? messagesQuery.data!.data : [];

  return (
    <div className="min-h-dvh bg-slate-50">
      <div className="mx-auto max-w-md px-4 py-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-slate-900 text-white flex items-center justify-center text-sm font-bold">
            {(data.firmName || "Law").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate">{data.firmName || "Your Law Firm"}</div>
            <div className="text-xs text-slate-500">Your Property Transaction Journey</div>
          </div>
        </div>

        <Card>
          <CardContent className="py-4 space-y-2">
            <div className="flex items-start gap-2">
              <Home className="w-4 h-4 text-slate-500 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 break-words">{data.projectName || "Project"}</div>
                <div className="text-xs text-slate-600 break-words">{data.property || "—"}</div>
              </div>
            </div>
            <div className="text-xs text-slate-600">
              Purchaser: <span className="font-medium text-slate-800">{data.purchaserName || "—"}</span>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                SPA: {data.spaStatus}
              </span>
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                Loan: {data.loanStatus ?? "N/A"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4">
            <div className="text-sm font-semibold text-slate-900">Milestone Timeline</div>
            <div className="mt-3 space-y-3">
              {timeline.map((s, idx) => {
                const isDone = String(s.status) === "completed";
                const isActive = !isDone && idx === activeIndex;
                const icon = isDone
                  ? <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  : (isActive ? <Dot className="w-6 h-6 text-amber-600" /> : <Circle className="w-5 h-5 text-slate-300" />);

                return (
                  <div key={`${s.pathType}-${s.stepKey}`} className="flex gap-3">
                    <div className="pt-0.5">{icon}</div>
                    <div className="min-w-0 flex-1">
                      <div className={isDone ? "text-sm font-medium text-slate-900" : (isActive ? "text-sm font-semibold text-slate-900" : "text-sm text-slate-500")}>
                        {s.stepName}
                      </div>
                      {isDone && (
                        <div className="text-xs text-slate-600">{fmtDmy(s.dateYmd)}</div>
                      )}
                      {!isDone && isActive && (
                        <div className="text-xs text-amber-700">In progress</div>
                      )}
                    </div>
                  </div>
                );
              })}
              {timeline.length === 0 && (
                <div className="text-sm text-slate-600">No milestones available yet.</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4 space-y-3">
            <div className="text-sm font-semibold text-slate-900">Message Our Team</div>
            <div className="space-y-2">
              {messages.map((m) => {
                const isClient = m.senderType === "client";
                return (
                  <div key={m.id} className={`flex ${isClient ? "justify-start" : "justify-end"}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${isClient ? "bg-white text-slate-900 border border-slate-200" : "bg-slate-900 text-white"}`}>
                      <div className={`text-[11px] ${isClient ? "text-slate-500" : "text-slate-200"}`}>
                        {isClient ? "You" : (m.senderName || "Our Team")}
                      </div>
                      <div className="text-sm whitespace-pre-wrap break-words">{m.messageText}</div>
                      <div className={`mt-1 text-[10px] ${isClient ? "text-slate-400" : "text-slate-300"}`}>
                        {m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
              {messages.length === 0 && (
                <div className="text-sm text-slate-600">No messages yet. Ask us a question below.</div>
              )}
            </div>

            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type your question…"
                className="min-h-[90px]"
              />
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">{Math.min(2000, draft.length)}/2000</div>
                <Button
                  onClick={() => {
                    const t = draft.trim();
                    if (!t) return;
                    if (t.length > 2000) return;
                    sendMutation.mutate(t);
                  }}
                  disabled={sendMutation.isPending || !draft.trim()}
                >
                  Send
                </Button>
              </div>
              {sendMutation.isError && (
                <div className="text-xs text-red-600">Failed to send. Please try again.</div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="text-[11px] leading-relaxed text-slate-500">
          This tracking page only shows non-sensitive progress updates. If you have questions, please contact your law firm directly.
        </div>
      </div>
    </div>
  );
}
