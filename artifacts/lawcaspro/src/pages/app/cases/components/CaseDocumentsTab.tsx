import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import {
  FileText, Upload, Trash2, Download, Plus, Folder, FolderOpen, ChevronRight,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isFirmDocumentTypeLetterLike, isMasterDocumentLetterLike } from "@/lib/documents/letterLike";
import { DOCUMENT_TYPE_LABELS } from "@workspace/documents-registry";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { downloadBlob } from "@/lib/download";
import { toastError } from "@/lib/toast-error";

function docTypeLabel(dt: string): string {
  return (DOCUMENT_TYPE_LABELS as Record<string, string>)[dt] ?? dt;
}

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

interface SystemFolder {
  id: number;
  name: string;
  parentId: number | null;
  sortOrder: number;
}

interface MasterDoc {
  id: number;
  name: string;
  category: string;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  objectPath: string;
  folderId: number | null;
  pdfMappings: unknown | null;
}

interface FirmLetterhead {
  id: number;
  name: string;
  is_default: boolean;
  status: string;
  footer_mode: "every_page" | "last_page_only";
}

function MasterFolderTree({
  folders,
  selectedId,
  onSelect,
}: {
  folders: SystemFolder[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  function FolderItem({ folder, depth = 0 }: { folder: SystemFolder; depth?: number }) {
    const children = folders.filter(f => f.parentId === folder.id).sort((a, b) => a.sortOrder - b.sortOrder);
    const isSelected = selectedId === folder.id;
    const [expanded, setExpanded] = useState(true);

    return (
      <div>
        <div
          className={cn(
            "flex items-center gap-1.5 py-1.5 px-2 rounded cursor-pointer text-xs transition-colors",
            isSelected ? "bg-amber-50 text-amber-700 font-medium" : "hover:bg-slate-50 text-slate-600"
          )}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          onClick={() => onSelect(folder.id)}
        >
          {children.length > 0 ? (
            <button onClick={e => { e.stopPropagation(); setExpanded(!expanded); }} className="p-0.5">
              <ChevronRight className={cn("w-3 h-3 transition-transform", expanded && "rotate-90")} />
            </button>
          ) : <span className="w-4" />}
          {isSelected ? <FolderOpen className="w-3.5 h-3.5 shrink-0" /> : <Folder className="w-3.5 h-3.5 shrink-0" />}
          <span className="truncate">{folder.name}</span>
        </div>
        {expanded && children.map(c => <FolderItem key={c.id} folder={c} depth={depth + 1} />)}
      </div>
    );
  }

  const roots = folders.filter(f => f.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          "flex items-center gap-1.5 py-1.5 px-2 rounded cursor-pointer text-xs transition-colors",
          selectedId === null ? "bg-amber-50 text-amber-700 font-medium" : "hover:bg-slate-50 text-slate-600"
        )}
        onClick={() => onSelect(null)}
      >
        <FolderOpen className="w-3.5 h-3.5" />
        <span>All Templates</span>
      </div>
      {roots.map(f => <FolderItem key={f.id} folder={f} />)}
    </div>
  );
}

export default function CaseDocumentsTab({ caseId }: { caseId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);

  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [generateTab, setGenerateTab] = useState<string>("firm");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedMasterDocId, setSelectedMasterDocId] = useState<number | null>(null);
  const [selectedMasterFolderId, setSelectedMasterFolderId] = useState<number | null>(null);
  const [selectedLetterheadId, setSelectedLetterheadId] = useState<string>("");
  const [documentName, setDocumentName] = useState("");
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadType, setUploadType] = useState("other");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [downloadingDocId, setDownloadingDocId] = useState<number | null>(null);

  const documentsQuery = useQuery<CaseDocument[]>({
    queryKey: ["case-documents", caseId],
    queryFn: () => apiFetchJson(`/cases/${caseId}/documents`),
    retry: false,
  });
  const documents = documentsQuery.data ?? [];

  const { data: templates = [] } = useQuery<DocumentTemplate[]>({
    queryKey: ["document-templates"],
    queryFn: () => apiFetchJson("/document-templates?templateCapable=true"),
    retry: false,
  });

  const { data: letterheads = [] } = useQuery<FirmLetterhead[]>({
    queryKey: ["firm-letterheads"],
    queryFn: () => apiFetchJson("/firm-letterheads"),
    retry: false,
  });

  const masterFoldersQuery = useQuery<SystemFolder[]>({
    queryKey: ["hub-folders"],
    queryFn: () => apiFetchJson("/hub/folders"),
    retry: false,
  });
  const masterFolders = masterFoldersQuery.data ?? [];

  const masterDocsQuery = useQuery<MasterDoc[]>({
    queryKey: ["hub-documents", selectedMasterFolderId],
    queryFn: async () => {
      const url = selectedMasterFolderId !== null
        ? `/hub/documents?folderId=${selectedMasterFolderId}`
        : "/hub/documents";
      return await apiFetchJson(url);
    },
    enabled: generateDialogOpen && generateTab === "master",
    retry: false,
  });
  const masterDocs = masterDocsQuery.data ?? [];

  const templateMasterDocs = masterDocs.filter(d => {
    const fn = d.fileName.toLowerCase();
    if (fn.endsWith(".docx") || fn.endsWith(".doc")) return true;
    if (fn.endsWith(".pdf") && d.pdfMappings) return true;
    return false;
  });

  const selectedTemplate = selectedTemplateId ? templates.find(t => t.id === Number(selectedTemplateId)) : undefined;
  const selectedMasterDoc = selectedMasterDocId !== null ? templateMasterDocs.find(d => d.id === selectedMasterDocId) : undefined;
  const showLetterhead = generateTab === "firm"
    ? isFirmDocumentTypeLetterLike(selectedTemplate?.document_type)
    : isMasterDocumentLetterLike(selectedMasterDoc);
  const activeLetterheads = letterheads.filter(l => l.status === "active");
  const defaultLetterhead = activeLetterheads.find(l => l.is_default) ?? activeLetterheads[0];

  const deleteMutation = useMutation({
    mutationFn: (docId: number) => apiFetchJson(`/cases/${caseId}/documents/${docId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Document deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  async function handleGenerate() {
    if (showLetterhead && activeLetterheads.length === 0) {
      toast({ title: "Missing firm letterhead", description: "Please configure a Firm Letter Head before generating this document.", variant: "destructive" });
      return;
    }
    const letterheadIdToSend = showLetterhead
      ? (selectedLetterheadId ? Number(selectedLetterheadId) : defaultLetterhead?.id)
      : undefined;

    if (generateTab === "firm") {
      if (!selectedTemplateId) return;
      setIsGenerating(true);
      try {
        await apiFetchJson(`/cases/${caseId}/documents/generate`, {
          method: "POST",
          body: JSON.stringify({ templateId: Number(selectedTemplateId), documentName: documentName || undefined, letterheadId: letterheadIdToSend }),
        });
        await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
        toast({ title: "Document generated successfully" });
        closeGenerateDialog();
      } catch (err) {
        toastError(toast, err, "Generation failed");
      } finally {
        setIsGenerating(false);
      }
    } else {
      if (!selectedMasterDocId) return;
      setIsGenerating(true);
      try {
        await apiFetchJson(`/cases/${caseId}/documents/generate-from-master`, {
          method: "POST",
          body: JSON.stringify({ masterDocId: selectedMasterDocId, documentName: documentName || undefined, letterheadId: letterheadIdToSend }),
        });
        await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
        toast({ title: "Document generated from master template" });
        closeGenerateDialog();
      } catch (err) {
        toastError(toast, err, "Generation failed");
      } finally {
        setIsGenerating(false);
      }
    }
  }

  function closeGenerateDialog() {
    setGenerateDialogOpen(false);
    setSelectedTemplateId("");
    setSelectedMasterDocId(null);
    setDocumentName("");
    setSelectedLetterheadId("");
  }

  async function handleUpload() {
    if (!selectedFile || !uploadName) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const { objectPath } = await apiFetchJson<{ objectPath: string }>("/storage/upload", { method: "POST", body: formData });

      await apiFetchJson(`/cases/${caseId}/documents/upload`, {
        method: "POST",
        body: JSON.stringify({
          name: uploadName,
          documentType: uploadType,
          objectPath,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
        }),
      });

      await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Document uploaded successfully" });
      setUploadDialogOpen(false);
      setUploadName("");
      setUploadType("other");
      setSelectedFile(null);
    } catch (err) {
      toastError(toast, err, "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDownload(doc: CaseDocument) {
    if (downloadingDocId === doc.id) return;
    setDownloadingDocId(doc.id);
    try {
      const blob = await apiFetchBlob(`/cases/${caseId}/documents/${doc.id}/download`);
      downloadBlob(blob, doc.file_name || "download");
    } catch (err) {
      toastError(toast, err, "Download failed");
    } finally {
      setDownloadingDocId(null);
    }
  }

  function formatFileSize(bytes: number | null) {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (documentsQuery.isLoading) return <div className="p-4 text-slate-500">Loading documents...</div>;
  if (documentsQuery.isError) {
    return (
      <div className="p-4">
        <QueryFallback title="Documents unavailable" error={documentsQuery.error} onRetry={() => documentsQuery.refetch()} isRetrying={documentsQuery.isFetching} />
      </div>
    );
  }

  const canGenerate = generateTab === "firm" ? !!selectedTemplateId : !!selectedMasterDocId;

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
            >
              <Plus className="w-3.5 h-3.5" />
              Generate from Template
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="font-medium text-slate-600 mb-1">No documents yet</p>
              <p className="text-sm">Upload documents or generate them from templates.</p>
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
                        {docTypeLabel(doc.document_type)}
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
                    disabled={downloadingDocId === doc.id}
                  >
                    <Download className={cn("w-4 h-4", downloadingDocId === doc.id && "animate-bounce")} />
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
        </CardContent>
      </Card>

      <Dialog open={generateDialogOpen} onOpenChange={(v) => { if (!v) closeGenerateDialog(); else setGenerateDialogOpen(true); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate Document from Template</DialogTitle>
          </DialogHeader>
          <Tabs value={generateTab} onValueChange={setGenerateTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="firm">Firm Templates</TabsTrigger>
              <TabsTrigger value="master">Master Templates</TabsTrigger>
            </TabsList>

            <TabsContent value="firm" className="space-y-4">
              <div className="space-y-1.5">
                <Label>Template</Label>
                {templates.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4">No firm templates uploaded yet. Go to Settings &gt; Documents to upload DOCX templates.</p>
                ) : (
                  <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a template..." />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.name}
                          {t.document_type && t.document_type !== "other" && (
                            <span className="ml-2 text-slate-400 text-xs">({docTypeLabel(t.document_type)})</span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </TabsContent>

            <TabsContent value="master" className="space-y-4">
              <p className="text-xs text-slate-500">Select a template from the system folder tree. Word documents (.docx) use {"{{variable}}"} placeholders. PDF templates use mapped text boxes.</p>
              <div className="flex gap-4 min-h-[200px]">
                <div className="w-48 shrink-0 border rounded-lg p-2 overflow-y-auto max-h-[300px]">
                  <MasterFolderTree
                    folders={masterFolders}
                    selectedId={selectedMasterFolderId}
                    onSelect={setSelectedMasterFolderId}
                  />
                </div>
                <div className="flex-1 border rounded-lg p-3 overflow-y-auto max-h-[300px]">
                  {templateMasterDocs.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-8">No templates in this folder</p>
                  ) : (
                    <div className="space-y-1">
                      {templateMasterDocs.map(doc => (
                        <div
                          key={doc.id}
                          className={cn(
                            "flex items-center gap-2 p-2 rounded cursor-pointer text-sm transition-colors",
                            selectedMasterDocId === doc.id
                              ? "bg-amber-50 border border-amber-200"
                              : "hover:bg-slate-50 border border-transparent"
                          )}
                          onClick={() => setSelectedMasterDocId(doc.id)}
                        >
                          <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-slate-700 truncate">{doc.name}</p>
                            <p className="text-xs text-slate-400">{doc.fileName}</p>
                          </div>
                          <Badge variant="outline" className="text-xs shrink-0">
                            {doc.fileName.split(".").pop()?.toUpperCase()}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {showLetterhead && (
            <div className="space-y-1.5">
              <Label>Firm Letter Head</Label>
              {activeLetterheads.length === 0 ? (
                <div className="text-xs text-slate-500">No firm letterhead configured</div>
              ) : (
                <Select value={selectedLetterheadId} onValueChange={setSelectedLetterheadId}>
                  <SelectTrigger>
                    <SelectValue placeholder={defaultLetterhead ? `Use default (${defaultLetterhead.name})` : "Use default"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use default</SelectItem>
                    {activeLetterheads.map(lh => (
                      <SelectItem key={lh.id} value={String(lh.id)}>{lh.name}{lh.is_default ? " (default)" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Document Name <span className="text-slate-400 text-xs">(optional)</span></Label>
            <Input
              placeholder="Leave blank to use template name + reference"
              value={documentName}
              onChange={(e) => setDocumentName(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={closeGenerateDialog}>Cancel</Button>
            <Button
              className="bg-amber-500 hover:bg-amber-600"
              onClick={handleGenerate}
              disabled={!canGenerate || isGenerating}
            >
              {isGenerating ? "Generating..." : "Generate"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
