import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  MessageSquare, Send, Plus, Paperclip, X, File, Building2, ArrowRight, ArrowLeft, Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
  firmName: string | null;
  attachments: Attachment[];
}

interface Firm {
  id: number;
  name: string;
  slug: string;
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
      <span className="font-medium text-slate-700 truncate max-w-32">{attachment.fileName}</span>
      <Badge variant="outline" className="text-xs shrink-0">{ext}</Badge>
      {attachment.fileSize && <span className="text-slate-400 shrink-0">{formatBytes(attachment.fileSize)}</span>}
      <Download className="w-3 h-3 text-slate-400 shrink-0" />
    </button>
  );
}

function MessageCard({ msg, onDownloadAttachment }: { msg: Message; onDownloadAttachment: (a: Attachment) => void }) {
  const isFromFirm = msg.fromFirmId !== null;
  const isRead = !!msg.readAt;

  return (
    <Card className={`transition-all ${!isRead && isFromFirm ? "border-amber-300 bg-amber-50/30" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {isFromFirm ? (
                <Badge variant="outline" className="text-xs gap-1 text-blue-600 border-blue-200">
                  <ArrowLeft className="w-3 h-3" />
                  From {msg.firmName ?? "Firm"}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs gap-1 text-green-600 border-green-200">
                  <ArrowRight className="w-3 h-3" />
                  To {msg.firmName ?? "Firm"}
                </Badge>
              )}
              {!isRead && isFromFirm && (
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
                  <AttachmentChip key={a.id} attachment={a} onDownload={() => onDownloadAttachment(a)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PlatformMessages() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [firmFilter, setFirmFilter] = useState("all");
  const [showCompose, setShowCompose] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);

  const [form, setForm] = useState({ subject: "", body: "", toFirmId: "" });

  const { data: messages = [], isLoading } = useQuery<Message[]>({
    queryKey: ["platform-messages", firmFilter],
    queryFn: async () => {
      const url = firmFilter !== "all"
        ? `${API_BASE}/platform/messages?firmId=${firmFilter}`
        : `${API_BASE}/platform/messages`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load messages");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const { data: firms = [] } = useQuery<Firm[]>({
    queryKey: ["platform-firms-list"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/platform/firms?limit=100`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load firms");
      const data = await res.json();
      return data.data ?? [];
    },
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
    if (!form.subject || !form.body || !form.toFirmId) return;
    setSending(true);
    try {
      const uploadedAttachments: Array<{ fileName: string; fileType: string; fileSize: number; objectPath: string }> = [];

      for (const file of attachments) {
        const urlRes = await fetch(`${API_BASE}/storage/uploads/request-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
          credentials: "include",
        });
        if (!urlRes.ok) throw new Error("Failed to get upload URL");
        const { uploadURL, objectPath } = await urlRes.json();
        const uploadRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
        if (!uploadRes.ok) throw new Error("File upload failed");
        uploadedAttachments.push({ fileName: file.name, fileType: file.type, fileSize: file.size, objectPath });
      }

      const res = await fetch(`${API_BASE}/platform/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: form.subject,
          body: form.body,
          toFirmId: parseInt(form.toFirmId, 10),
          attachments: uploadedAttachments,
        }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to send message");

      queryClient.invalidateQueries({ queryKey: ["platform-messages"] });
      toast({ title: "Message sent", description: `Sent to ${firms.find((f) => f.id === parseInt(form.toFirmId))?.name}` });
      setShowCompose(false);
      setForm({ subject: "", body: "", toFirmId: "" });
      setAttachments([]);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const unreadCount = messages.filter((m) => m.fromFirmId && !m.readAt).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight flex items-center gap-3">
            Communication Hub
            {unreadCount > 0 && (
              <Badge className="bg-amber-500 text-white text-xs">{unreadCount} unread</Badge>
            )}
          </h1>
          <p className="text-slate-500 mt-1">Direct messaging between Lawcaspro and law firms</p>
        </div>
        <Button onClick={() => setShowCompose(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Compose Message
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <MessageSquare className="w-4 h-4 text-slate-400 shrink-0" />
        <Select value={firmFilter} onValueChange={setFirmFilter}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Filter by firm" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All firms</SelectItem>
            {firms.map((f) => (
              <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-slate-500 text-sm py-8 text-center">Loading messages...</div>
      ) : messages.length === 0 ? (
        <div className="text-center py-16">
          <MessageSquare className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No messages yet</p>
          <p className="text-slate-400 text-sm mt-1">Compose a message to a firm to get started</p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => (
            <MessageCard key={msg.id} msg={msg} onDownloadAttachment={handleDownloadAttachment} />
          ))}
        </div>
      )}

      <Dialog open={showCompose} onOpenChange={setShowCompose}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Compose Message to Firm</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Recipient Firm</Label>
              <Select value={form.toFirmId} onValueChange={(v) => setForm((f) => ({ ...f, toFirmId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a firm..." />
                </SelectTrigger>
                <SelectContent>
                  {firms.map((f) => (
                    <SelectItem key={f.id} value={String(f.id)}>
                      <div className="flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-slate-400" />
                        {f.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
              disabled={!form.subject || !form.body || !form.toFirmId || sending}
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
