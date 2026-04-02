import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { FileText, Upload, Trash2, Download, Plus, File, Search, Building2 } from "lucide-react";
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

const CATEGORIES = ["general", "template", "guide", "announcement", "form", "policy", "other"];

interface PlatformDoc {
  id: number;
  name: string;
  description: string | null;
  category: string;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  objectPath: string;
  firmId: number | null;
  uploadedBy: number;
  createdAt: string;
}

function fileTypeLabel(mime: string) {
  return ALLOWED_TYPES[mime] ?? mime.split("/").pop()?.toUpperCase() ?? "FILE";
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function PlatformDocuments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [form, setForm] = useState({ name: "", description: "", category: "general" });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const { data: docs = [], isLoading } = useQuery<PlatformDoc[]>({
    queryKey: ["platform-documents"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/platform/documents`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load documents");
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: number) => {
      const res = await fetch(`${API_BASE}/platform/documents/${docId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-documents"] });
      toast({ title: "Document deleted" });
    },
    onError: () => toast({ title: "Error", description: "Could not delete document", variant: "destructive" }),
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_TYPES[file.type]) {
      toast({ title: "Unsupported file type", description: "Please upload a PDF, Word, Excel, or image file.", variant: "destructive" });
      return;
    }
    setSelectedFile(file);
    if (!form.name) setForm((f) => ({ ...f, name: file.name.replace(/\.[^.]+$/, "") }));
  };

  const handleUpload = async () => {
    if (!selectedFile || !form.name) return;
    setUploading(true);
    try {
      const urlRes = await fetch(`${API_BASE}/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: selectedFile.type }),
        credentials: "include",
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { uploadURL, objectPath } = await urlRes.json();

      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        body: selectedFile,
        headers: { "Content-Type": selectedFile.type },
      });
      if (!uploadRes.ok) throw new Error("File upload failed");

      const saveRes = await fetch(`${API_BASE}/platform/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description || null,
          category: form.category,
          fileName: selectedFile.name,
          fileType: selectedFile.type,
          fileSize: selectedFile.size,
          objectPath,
          firmId: null,
        }),
        credentials: "include",
      });
      if (!saveRes.ok) throw new Error("Failed to save document");

      queryClient.invalidateQueries({ queryKey: ["platform-documents"] });
      toast({ title: "Document uploaded", description: `${form.name} has been added.` });
      setShowUpload(false);
      setForm({ name: "", description: "", category: "general" });
      setSelectedFile(null);
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (doc: PlatformDoc) => {
    try {
      const pathPart = doc.objectPath.replace(/^\/objects\//, "");
      const res = await fetch(`${API_BASE}/storage/objects/${pathPart}`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    }
  };

  const filtered = docs.filter((d) => {
    const matchSearch = !search || d.name.toLowerCase().includes(search.toLowerCase()) || d.fileName.toLowerCase().includes(search.toLowerCase());
    const matchCat = categoryFilter === "all" || d.category === categoryFilter;
    return matchSearch && matchCat;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">System Documents</h1>
          <p className="text-slate-500 mt-1">Upload and manage documents shared with all firms</p>
        </div>
        <Button onClick={() => setShowUpload(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Upload Document
        </Button>
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search documents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-slate-500 text-sm py-8 text-center">Loading documents...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">No documents found</p>
          <p className="text-slate-400 text-sm mt-1">Upload a document to share with firms</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((doc) => (
            <Card key={doc.id} className="group hover:shadow-md transition-shadow">
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
                      <Badge variant="outline" className="text-xs">{fileTypeLabel(doc.fileType)}</Badge>
                      <Badge variant="secondary" className="text-xs capitalize">{doc.category}</Badge>
                      {doc.firmId && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Building2 className="w-2.5 h-2.5" />
                          Firm only
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-400">{formatBytes(doc.fileSize)}</span>
                      <span className="text-xs text-slate-300">·</span>
                      <span className="text-xs text-slate-400">{new Date(doc.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                  <Button variant="outline" size="sm" className="flex-1 text-xs gap-1.5" onClick={() => handleDownload(doc)}>
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs text-red-500 hover:text-red-600 hover:border-red-200"
                    onClick={() => deleteMutation.mutate(doc.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showUpload} onOpenChange={setShowUpload}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload System Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                selectedFile ? "border-amber-400 bg-amber-50" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.txt"
                onChange={handleFileSelect}
              />
              {selectedFile ? (
                <div>
                  <File className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                  <p className="font-medium text-sm text-slate-900">{selectedFile.name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{formatBytes(selectedFile.size)}</p>
                </div>
              ) : (
                <div>
                  <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                  <p className="text-sm font-medium text-slate-700">Click to select file</p>
                  <p className="text-xs text-slate-400 mt-1">PDF, Word, Excel, Image (max 50MB)</p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Document Name</Label>
              <Input
                placeholder="e.g. Fee Schedule 2025"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Textarea
                placeholder="Brief description of this document..."
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUpload(false)}>Cancel</Button>
            <Button onClick={handleUpload} disabled={!selectedFile || !form.name || uploading}>
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
