import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, ArrowLeft, Send, Trash2, MessageCircle } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";

interface Thread {
  id: number;
  subject: string;
  created_by_name: string;
  message_count: number;
  last_message_at: string | null;
  last_message: string | null;
  unread_count: number;
  created_at: string;
}

interface Message {
  id: number;
  notes: string;
  logged_by_name: string;
  created_at: string;
}

export default function CaseCommunicationsTab({ caseId, initialThreadId }: { caseId: number; initialThreadId?: number | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveThreadId(null);
    setMessageInput("");
    setCreateOpen(false);
    setNewSubject("");
  }, [caseId]);

  const threadsQuery = useQuery<Thread[]>({
    queryKey: ["case-threads", caseId],
    queryFn: () => apiFetchJson(`/cases/${caseId}/threads`),
    retry: false,
  });
  const threads = threadsQuery.data ?? [];

  const activeThread = threads.find(t => t.id === activeThreadId);

  useEffect(() => {
    if (!initialThreadId) return;
    if (activeThreadId) return;
    if (threads.some((t) => t.id === initialThreadId)) {
      setActiveThreadId(initialThreadId);
    }
  }, [initialThreadId, threads, activeThreadId]);

  const messagesQuery = useQuery<Message[]>({
    queryKey: ["thread-messages", caseId, activeThreadId],
    queryFn: () => apiFetchJson(`/cases/${caseId}/threads/${activeThreadId}/messages`),
    enabled: !!activeThreadId,
    retry: false,
  });
  const messages = messagesQuery.data ?? [];

  useEffect(() => {
    if (activeThreadId && messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, activeThreadId]);

  useEffect(() => {
    if (activeThreadId) {
      apiFetchJson(`/cases/${caseId}/threads/${activeThreadId}/read`, { method: "POST" })
        .then(() => {
          qc.invalidateQueries({ queryKey: ["case-threads", caseId] });
          qc.invalidateQueries({ queryKey: ["unread-count"] });
        })
        .catch(() => {});
    }
  }, [activeThreadId, caseId, qc]);

  const createThread = useMutation({
    mutationFn: (subject: string) =>
      apiFetchJson<Thread>(`/cases/${caseId}/threads`, { method: "POST", body: JSON.stringify({ subject }) }),
    onSuccess: (thread: Thread) => {
      qc.invalidateQueries({ queryKey: ["case-threads", caseId] });
      setCreateOpen(false);
      setNewSubject("");
      setActiveThreadId(thread.id);
      toast({ title: "Subject created" });
    },
    onError: (err) => toastError(toast, err, "Create failed"),
  });

  const sendMessage = useMutation({
    mutationFn: (notes: string) => apiFetchJson(`/cases/${caseId}/threads/${activeThreadId}/messages`, { method: "POST", body: JSON.stringify({ notes }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thread-messages", caseId, activeThreadId] });
      qc.invalidateQueries({ queryKey: ["case-threads", caseId] });
      qc.invalidateQueries({ queryKey: ["unread-count"] });
      setMessageInput("");
    },
    onError: (err) => toastError(toast, err, "Send failed"),
  });

  const deleteThread = useMutation({
    mutationFn: (threadId: number) => apiFetchJson(`/cases/${caseId}/threads/${threadId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-threads", caseId] });
      qc.invalidateQueries({ queryKey: ["unread-count"] });
      setActiveThreadId(null);
      toast({ title: "Subject deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const handleSend = () => {
    if (!messageInput.trim()) return;
    sendMessage.mutate(messageInput);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short" });
  };

  if (activeThreadId && activeThread) {
    return (
      <div className="space-y-4">
        <Card className="h-[600px] flex flex-col">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 shrink-0">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setActiveThreadId(null)}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 truncate">{activeThread.subject}</h3>
              <p className="text-xs text-slate-500">{activeThread.message_count} messages</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-slate-400 hover:text-red-500"
              onClick={() => { if (confirm("Delete this subject and all its messages?")) deleteThread.mutate(activeThreadId); }}
              disabled={deleteThread.isPending || sendMessage.isPending}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messagesQuery.isError ? (
              <QueryFallback title="Messages unavailable" error={messagesQuery.error} onRetry={() => messagesQuery.refetch()} isRetrying={messagesQuery.isFetching} />
            ) : messagesQuery.isLoading ? (
              <div className="text-center py-8 text-slate-500">Loading...</div>
            ) : messages.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-sm">No messages yet. Start the conversation below.</div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center text-xs font-semibold text-slate-600 shrink-0 mt-0.5">
                    {(msg.logged_by_name || "?")[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">{msg.logged_by_name || "Unknown"}</span>
                      <span className="text-xs text-slate-400">{formatTime(msg.created_at)}</span>
                    </div>
                    <p className="text-sm text-slate-700 mt-0.5 whitespace-pre-wrap">{msg.notes}</p>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-4 py-3 border-t border-slate-200 shrink-0">
            <div className="flex gap-2">
              <Input
                placeholder="Type a message..."
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={handleKeyDown}
                className="flex-1"
              />
              <Button
                size="sm"
                className="bg-amber-500 hover:bg-amber-600 h-10 px-4"
                onClick={handleSend}
                disabled={!messageInput.trim() || sendMessage.isPending || deleteThread.isPending}
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">Communication Subjects</h3>
          <Button size="sm" className="bg-amber-500 hover:bg-amber-600 gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            New Subject
          </Button>
        </div>
        <CardContent className="p-0">
          {threadsQuery.isError ? (
            <div className="p-6">
              <QueryFallback title="Communications unavailable" error={threadsQuery.error} onRetry={() => threadsQuery.refetch()} isRetrying={threadsQuery.isFetching} />
            </div>
          ) : threadsQuery.isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading...</div>
          ) : threads.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <MessageCircle className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="font-medium text-slate-600 mb-1">No subjects yet</p>
              <p className="text-sm">Create a subject to start a conversation thread for this case.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {threads.map((thread) => (
                <div
                  key={thread.id}
                  className="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 cursor-pointer transition-colors"
                  onClick={() => setActiveThreadId(thread.id)}
                >
                  <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                    <MessageCircle className="w-4 h-4 text-slate-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 truncate">{thread.subject}</span>
                      {Number(thread.unread_count) > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-amber-500 rounded-full">
                          {thread.unread_count}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-slate-500 truncate max-w-xs">{thread.last_message || "No messages yet"}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-slate-400">
                      {thread.last_message_at ? formatTime(thread.last_message_at) : formatTime(thread.created_at)}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">{thread.message_count} messages</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New Communication Subject</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Input
                placeholder="e.g., SPA Stamping Discussion, Title Transfer Follow-up"
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (!newSubject.trim() || createThread.isPending) return;
                  createThread.mutate(newSubject);
                }}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button
                className="bg-amber-500 hover:bg-amber-600"
                onClick={() => createThread.mutate(newSubject)}
                disabled={!newSubject.trim() || createThread.isPending}
              >
                {createThread.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
