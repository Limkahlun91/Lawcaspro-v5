import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FileText, Upload, Trash2, Download, Plus, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

interface DocumentTemplate {
  id: number;
  name: string;
  document_type: string;
  description: string | null;
  file_name: string;
  created_at: string;
}

interface CaseDocument {
  id: number;
  name: string;
  document_type: string;
  status: string;
  file_name: string;
  object_path: string;
  file_size: number | null;
  template_name: string | null;
  generated_by_name: string | null;
  created_at: string;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  spa: "SPA",
  loan_agreement: "Loan Agreement",
  letter_of_offer: "Letter of Offer",
  mot: "MOT",
  noa: "Notice of Assignment",
  power_of_attorney: "Power of Attorney",
  stamping_receipt: "Stamping Receipt",
  acting_letter: "Acting Letter",
  undertaking: "Undertaking",
  other: "Other",
};

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

export default function CaseDocumentsTab({ caseId }: { caseId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);
  const templateUploadRef = useRef<HTMLInputElement>(null);

  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [documentName, setDocumentName] = useState("");
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadType, setUploadType] = useState("other");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const { data: documents = [], isLoading } = useQuery<CaseDocument[]>({
    queryKey: ["case-documents", caseId],
    queryFn: () => apiFetch(`/cases/${caseId}/documents`),
  });

  const { data: templates = [] } = useQuery<DocumentTemplate[]>({
    queryKey: ["document-templates"],
    queryFn: () => apiFetch("/document-templates"),
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: number) => apiFetch(`/cases/${caseId}/documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Document deleted" });
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  async function handleGenerate() {
    if (!selectedTemplateId) return;
    setIsGenerating(true);
    try {
      await apiFetch(`/cases/${caseId}/documents/generate`, {
        method: "POST",
        body: JSON.stringify({ templateId: Number(selectedTemplateId), documentName: documentName || undefined }),
      });
      qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Document generated successfully" });
      setGenerateDialogOpen(false);
      setSelectedTemplateId("");
      setDocumentName("");
    } catch (err) {
      toast({ title: "Generation failed", description: String(err), variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleUpload() {
    if (!selectedFile || !uploadName) return;
    setIsUploading(true);
    try {
      const { uploadURL, objectPath } = await apiFetch("/storage/uploads/request-url", {
        method: "POST",
        body: JSON.stringify({ name: selectedFile.name, size: selectedFile.size, contentType: selectedFile.type }),
      });

      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": selectedFile.type },
        body: selectedFile,
      });

      if (!uploadRes.ok) throw new Error("Upload to storage failed");

      await apiFetch(`/cases/${caseId}/documents/upload`, {
        method: "POST",
        body: JSON.stringify({
          name: uploadName,
          documentType: uploadType,
          objectPath,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
        }),
      });

      qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Document uploaded successfully" });
      setUploadDialogOpen(false);
      setUploadName("");
      setUploadType("other");
      setSelectedFile(null);
    } catch (err) {
      toast({ title: "Upload failed", description: String(err), variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDownload(doc: CaseDocument) {
    try {
      const res = await fetch(`${API_BASE}/cases/${caseId}/documents/${doc.id}/download`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.file_name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: "Download failed", description: String(err), variant: "destructive" });
    }
  }

  function formatFileSize(bytes: number | null) {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle>Case Documents</CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setUploadDialogOpen(true)}
              className="gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload
            </Button>
            <Button
              size="sm"
              className="bg-amber-500 hover:bg-amber-600 gap-1.5"
              onClick={() => setGenerateDialogOpen(true)}
              disabled={templates.length === 0}
            >
              <Plus className="w-3.5 h-3.5" />
              Generate from Template
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading documents...</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="font-medium text-slate-600 mb-1">No documents yet</p>
              <p className="text-sm">Upload documents or generate them from DOCX templates.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center gap-3 p-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
                >
                  <FileText className="w-5 h-5 text-amber-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-900 truncate">{doc.name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                        {DOCUMENT_TYPE_LABELS[doc.document_type] ?? doc.document_type}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium capitalize">
                        {doc.status}
                      </span>
                      {doc.template_name && (
                        <span className="text-xs text-slate-500">from: {doc.template_name}</span>
                      )}
                      {doc.file_size && (
                        <span className="text-xs text-slate-400">{formatFileSize(doc.file_size)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-slate-400">
                    {new Date(doc.created_at).toLocaleDateString("en-MY")}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-slate-400 hover:text-slate-700"
                    onClick={() => handleDownload(doc)}
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-slate-400 hover:text-red-600"
                    onClick={() => deleteMutation.mutate(doc.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {templates.length === 0 && documents.length === 0 && (
            <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-100 text-sm text-amber-700">
              No DOCX templates uploaded yet. Go to Settings &gt; Document Templates to upload templates.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Generate Dialog */}
      <Dialog open={generateDialogOpen} onOpenChange={setGenerateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate Document from Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Template</Label>
              <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a template..." />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                      {t.document_type && t.document_type !== "other" && (
                        <span className="ml-2 text-slate-400 text-xs">({DOCUMENT_TYPE_LABELS[t.document_type] ?? t.document_type})</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Document Name <span className="text-slate-400 text-xs">(optional)</span></Label>
              <Input
                placeholder="Leave blank to use template name + reference"
                value={documentName}
                onChange={(e) => setDocumentName(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setGenerateDialogOpen(false)}>Cancel</Button>
              <Button
                className="bg-amber-500 hover:bg-amber-600"
                onClick={handleGenerate}
                disabled={!selectedTemplateId || isGenerating}
              >
                {isGenerating ? "Generating..." : "Generate"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Document Name</Label>
              <Input
                placeholder="e.g. SPA signed copy"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Document Type</Label>
              <Select value={uploadType} onValueChange={setUploadType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DOCUMENT_TYPE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>File</Label>
              <div
                className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-amber-300 transition-colors"
                onClick={() => uploadRef.current?.click()}
              >
                {selectedFile ? (
                  <div className="text-sm text-slate-700 font-medium">{selectedFile.name}</div>
                ) : (
                  <div className="text-sm text-slate-500">Click to select a file</div>
                )}
              </div>
              <input
                type="file"
                ref={uploadRef}
                className="hidden"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>Cancel</Button>
              <Button
                className="bg-amber-500 hover:bg-amber-600"
                onClick={handleUpload}
                disabled={!selectedFile || !uploadName || isUploading}
              >
                {isUploading ? "Uploading..." : "Upload"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
