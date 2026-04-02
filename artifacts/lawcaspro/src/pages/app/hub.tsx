import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  MessageSquare, Send, Plus, Paperclip, X, File, ArrowRight, ArrowLeft, Download,
  FileText, Search,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Input as SearchInput } from "@/components/ui/input";

const API_BASE = import.meta.env.BASE_URL + "api";

const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "text/plain": "TXT",
};

interface Attachment {
  id: number;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  objectPath: string;
}

interface Message {
  id: number;
  subject: string;
  body: string;
  fromFirmId: number | null;
  fromUserId: number;
  toFirmId: number | null;
  parentId: number | null;
  readAt: string | null;
  createdAt: string;
  senderName: string;
  senderEmail: string;
  direction: "incoming" | "outgoing";
  attachments: Attachment[];
}

interface SystemDoc {
  id: number;
  name: string;
  description: string | null;
  category: string;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  objectPath: string;
  createdAt: string;
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentChip({ attachment, onDownload }: { attachment: Attachment; onDownload: () => void }) {
  const ext = ALLOWED_TYPES[attachment.fileType] ?? attachment.fileType.split("/").pop()?.toUpperCase() ?? "FILE";
  return (
    <button
      onClick={onDownload}
      className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs hover:bg-slate-100 transition-colors"
    >
      <File className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      <span className="font-medium text-slate-700 truncate max-w-28">{attachment.fileName}</span>
      <Badge variant="outline" className="text-xs shrink-0">{ext}</Badge>
      {attachment.fileSize && <span className="text-slate-400 shrink-0">{formatBytes(attachment.fileSize)}</span>}
      <Download className="w-3 h-3 text-slate-400 shrink-0" />
    </button>
  );
}

export default function HubPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<"messages" | "documents">("messages");
  const [showCompose, setShowCompose] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [docSearch, setDocSearch] = useState("");

  const [form, setForm] = useState({ subject: "", body: "" });

  const { data: messages = [], isLoading: loadingMessages } = useQuery<Message[]>({
    queryKey: ["hub-messages"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/hub/messages`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load messages");
      return res.json();
    },
    refetchInterval: 15000,
    enabled: activeTab === "messages",
  });

  const { data: docs = [], isLoading: loadingDocs } = useQuery<SystemDoc[]>({
    queryKey: ["hub-documents"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/hub/documents`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load documents");
      return res.json();
    },
    enabled: activeTab === "documents",
  });

  const markReadMutation = useMutation({
    mutationFn: async (msgId: number) => {
      await fetch(`${API_BASE}/hub/messages/${msgId}/read`, { method: "PATCH", credentials: "include" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["hub-messages"] }),
  });

  const handleDownloadAttachment = async (a: Attachment) => {
    try {
      const pathPart = a.objectPath.replace(/^\/objects\//, "");
      const res = await fetch(`${API_BASE}/storage/objects/${pathPart}`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = url;
      el.download = a.fileName;
      el.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    }
  };

  const handleDownloadDoc = async (doc: SystemDoc) => {
    try {
      const pathPart = doc.objectPath.replace(/^\/objects\//, "");
      const res = await fetch(`${API_BASE}/storage/objects/${pathPart}`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = url;
      el.download = doc.fileName;
      el.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    }
  };

  const handleAddAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const valid = files.filter((f) => ALLOWED_TYPES[f.type]);
    if (valid.length < files.length) {
      toast({ title: "Some files skipped", description: "Only PDF, Word, Excel, and image files are supported.", variant: "destructive" });
    }
    setAttachments((prev) => [...prev, ...valid]);
    e.target.value = "";
  };

  const handleSend = async () => {
    if (!form.subject || !form.body) return;
    setSending(true);
    try {
      const uploadedAttachments: Array<{ fileName: string; fileType: string; fileSize: number; objectPath: string }> = [];

      for (const file of attachments) {
        const urlRes = await fetch(`${API_BASE}/storage/uploads/request-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: file.type }),
          credentials: "include",
        });
        if (!urlRes.ok) throw new Error("Failed to get upload URL");
        const { uploadURL, objectPath } = await urlRes.json();
        const uploadRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
        if (!uploadRes.ok) throw new Error("File upload failed");
        uploadedAttachments.push({ fileName: file.name, fileType: file.type, fileSize: file.size, objectPath });
      }

      const res = await fetch(`${API_BASE}/hub/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: form.subject,
          body: form.body,
          attachments: uploadedAttachments,
        }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to send message");

      queryClient.invalidateQueries({ queryKey: ["hub-messages"] });
      toast({ title: "Message sent", description: "Your message has been sent to Lawcaspro." });
      setShowCompose(false);
      setForm({ subject: "", body: "" });
      setAttachments([]);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const unreadCount = messages.filter((m) => m.direction === "incoming" && !m.readAt).length;
  const filteredDocs = docs.filter((d) => !docSearch || d.name.toLowerCase().includes(docSearch.toLowerCase()));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight flex items-center gap-3">
          Communication Hub
          {unreadCount > 0 && (
            <Badge className="bg-amber-500 text-white text-xs">{unreadCount} new</Badge>
          )}
        </h1>
        <p className="text-slate-500 mt-1">Messages and documents from Lawcaspro</p>
      </div>

      <div className="border-b border-slate-200">
        <div className="flex gap-0">
          {(["messages", "documents"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-amber-500 text-amber-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab === "messages"
                ? `Messages${unreadCount > 0 ? ` (${unreadCount})` : ""}`
                : `System Documents (${docs.length})`}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "messages" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setShowCompose(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              Send Message
            </Button>
          </div>

          {loadingMessages ? (
            <div className="text-slate-500 text-sm py-8 text-center">Loading messages...</div>
          ) : messages.length === 0 ? (
            <div className="text-center py-16">
              <MessageSquare className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500 font-medium">No messages yet</p>
              <p className="text-slate-400 text-sm mt-1">Send a message to Lawcaspro to get started</p>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((msg) => {
                const isIncoming = msg.direction === "incoming";
                const isUnread = isIncoming && !msg.readAt;
                return (
                  <Card
                    key={msg.id}
                    className={`transition-all cursor-pointer ${isUnread ? "border-amber-300 bg-amber-50/30" : ""}`}
                    onClick={() => {
                      if (isUnread) markReadMutation.mutate(msg.id);
                    }}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            {isIncoming ? (
                              <Badge variant="outline" className="text-xs gap-1 text-blue-600 border-blue-200">
                                <ArrowLeft className="w-3 h-3" />
                                From Lawcaspro
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs gap-1 text-green-600 border-green-200">
                                <ArrowRight className="w-3 h-3" />
                                Sent to Lawcaspro
                              </Badge>
                            )}
                            {isUnread && (
                              <span className="w-2 h-2 bg-amber-500 rounded-full inline-block" />
                            )}
                          </div>
                          <p className="font-semibold text-slate-900 text-sm">{msg.subject}</p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {msg.senderName} · {new Date(msg.createdAt).toLocaleString()}
                          </p>
                          <p className="text-sm text-slate-700 mt-2 whitespace-pre-line">{msg.body}</p>
                          {msg.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-3">
                              {msg.attachments.map((a) => (
                                <AttachmentChip key={a.id} attachment={a} onDownload={() => handleDownloadAttachment(a)} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === "documents" && (
        <div className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <SearchInput
              placeholder="Search documents..."
              value={docSearch}
              onChange={(e) => setDocSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {loadingDocs ? (
            <div className="text-slate-500 text-sm py-8 text-center">Loading documents...</div>
          ) : filteredDocs.length === 0 ? (
            <div className="text-center py-16">
              <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500 font-medium">No documents available</p>
              <p className="text-slate-400 text-sm mt-1">Lawcaspro will share documents with you here</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredDocs.map((doc) => {
                const ext = ALLOWED_TYPES[doc.fileType] ?? doc.fileType.split("/").pop()?.toUpperCase() ?? "FILE";
                return (
                  <Card key={doc.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-center shrink-0">
                          <File className="w-5 h-5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm text-slate-900 truncate">{doc.name}</p>
                          {doc.description && (
                            <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{doc.description}</p>
                          )}
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            <Badge variant="outline" className="text-xs">{ext}</Badge>
                            <Badge variant="secondary" className="text-xs capitalize">{doc.category}</Badge>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            {doc.fileSize && <span className="text-xs text-slate-400">{formatBytes(doc.fileSize)}</span>}
                            <span className="text-xs text-slate-300">·</span>
                            <span className="text-xs text-slate-400">{new Date(doc.createdAt).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 pt-3 border-t border-slate-100">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full text-xs gap-1.5"
                          onClick={() => handleDownloadDoc(doc)}
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Dialog open={showCompose} onOpenChange={setShowCompose}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send Message to Lawcaspro</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Subject</Label>
              <Input
                placeholder="Message subject..."
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Message</Label>
              <Textarea
                placeholder="Write your message here..."
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={5}
              />
            </div>
            <div className="space-y-2">
              <Label>Attachments</Label>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.txt"
                  onChange={handleAddAttachment}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  Attach Files
                </Button>
                <p className="text-xs text-slate-400 mt-1">PDF, Word, Excel, Image files supported</p>
              </div>
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {attachments.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                      <File className="w-3.5 h-3.5 text-slate-400" />
                      <span className="max-w-32 truncate font-medium">{f.name}</span>
                      <button onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>
                        <X className="w-3 h-3 text-slate-400 hover:text-red-500" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCompose(false)}>Cancel</Button>
            <Button
              onClick={handleSend}
              disabled={!form.subject || !form.body || sending}
              className="gap-2"
            >
              {sending ? "Sending..." : <><Send className="w-4 h-4" />Send Message</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
