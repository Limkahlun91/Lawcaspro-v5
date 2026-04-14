import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  FileText, Upload, Trash2, Download, Plus,
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
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";

function docTypeLabel(dt: string): string {
  return (DOCUMENT_TYPE_LABELS as Record<string, string>)[dt] ?? dt;
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
  template_source?: string | null;
  template_snapshot_name?: string | null;
  generated_by_name: string | null;
  created_at: string;
}

type ApplicabilityStatus = "applicable" | "not_applicable";
type ReadinessStatus = "ready" | "missing_data" | "missing_file" | "incomplete";

type ChecklistItem = {
  source: "firm" | "master";
  templateId: number;
  name: string;
  documentType: string;
  documentGroup: string;
  sortOrder: number;
  fileName: string | null;
  fileType: string | null;
  pdfMappings: unknown;
  applicability: { status: ApplicabilityStatus; reasons: string[] };
  readiness: { status: ReadinessStatus; missing: Array<{ code: string; message: string }> };
  latestDocument: { id: number } | null;
};

type ChecklistSection = { section: string; items: ChecklistItem[] };
type ChecklistResponse = {
  case: { caseId: number; referenceNo: string | null; purchaseMode: string | null; titleType: string | null; caseType: string | null; projectName: string | null };
  sections: ChecklistSection[];
};

interface FirmLetterhead {
  id: number;
  name: string;
  is_default: boolean;
  status: string;
  footer_mode: "every_page" | "last_page_only";
}

export default function CaseDocumentsTab({ caseId }: { caseId: number }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);

  const [viewTab, setViewTab] = useState<"list" | "checklist" | "history">("list");
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [showAllTemplates, setShowAllTemplates] = useState(false);
  const [templateSourceFilter, setTemplateSourceFilter] = useState<"all" | "firm" | "master">("all");
  const [selectedLetterheadId, setSelectedLetterheadId] = useState<string>("");
  const [documentName, setDocumentName] = useState("");
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadType, setUploadType] = useState("other");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchGenerateResult, setBatchGenerateResult] = useState<null | { jobId: string; items: Array<Record<string, unknown>> }>(null);
  const [selectedChecklistKeys, setSelectedChecklistKeys] = useState<Set<string>>(new Set());

  const [selectedDocIds, setSelectedDocIds] = useState<Set<number>>(new Set());
  const [isBatchExporting, setIsBatchExporting] = useState(false);
  const [downloadingDocId, setDownloadingDocId] = useState<number | null>(null);


  const canGenerate = hasPermission(user, "documents", "generate");
  const canExport = hasPermission(user, "documents", "export");
  const canDelete = hasPermission(user, "documents", "delete");
  const canCreate = hasPermission(user, "documents", "create");

  const documentsQuery = useQuery<CaseDocument[]>({
    queryKey: ["case-documents", caseId],
    queryFn: () => apiFetchJson(`/cases/${caseId}/documents`),
    retry: false,
  });
  const documents = documentsQuery.data ?? [];

  const checklistQuery = useQuery<ChecklistResponse>({
    queryKey: ["case-documents-checklist", caseId, showAllTemplates],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/documents/checklist${showAllTemplates ? "?includeAll=1" : ""}`, { signal }),
    enabled: viewTab === "checklist" || generateDialogOpen,
    retry: false,
  });

  interface DocumentInstance {
    id: number;
    template_source: string;
    template_id: number | null;
    template_version_id: number | null;
    platform_document_id: number | null;
    case_document_id: number | null;
    document_name: string;
    render_mode: string;
    status: string;
    triggered_at: string;
    finished_at: string | null;
    error_code: string | null;
    error_message: string | null;
    triggered_by_name: string | null;
    template_name: string | null;
    platform_document_name: string | null;
  }

  const instancesQuery = useQuery<DocumentInstance[]>({
    queryKey: ["case-documents-instances", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/document-instances`, { signal }),
    enabled: viewTab === "history",
    retry: false,
  });

  const { data: letterheads = [] } = useQuery<FirmLetterhead[]>({
    queryKey: ["firm-letterheads"],
    queryFn: () => apiFetchJson("/firm-letterheads"),
    retry: false,
  });

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

  function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  }

  async function handleGenerate(item: ChecklistItem) {
    const isLetterLike = item.source === "firm"
      ? isFirmDocumentTypeLetterLike(item.documentType)
      : isMasterDocumentLetterLike({ name: item.name, category: item.documentType, fileName: item.fileName ?? undefined });

    if (isLetterLike && activeLetterheads.length === 0) {
      toast({ title: "Missing firm letterhead", description: "Please configure a Firm Letter Head before generating this document.", variant: "destructive" });
      return;
    }
    const letterheadIdToSend = isLetterLike
      ? (selectedLetterheadId ? Number(selectedLetterheadId) : defaultLetterhead?.id)
      : undefined;

    setIsGenerating(true);
    try {
      let created: CaseDocument;
      if (item.source === "firm") {
        created = await apiFetchJson(`/cases/${caseId}/documents/generate`, {
          method: "POST",
          body: JSON.stringify({ templateId: Number(item.templateId), documentName: documentName || undefined, letterheadId: letterheadIdToSend }),
        });
      } else {
        created = await apiFetchJson(`/cases/${caseId}/documents/generate-from-master`, {
          method: "POST",
          body: JSON.stringify({ masterDocId: Number(item.templateId), documentName: documentName || undefined, letterheadId: letterheadIdToSend }),
        });
      }
      await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({
        title: "Document generated successfully",
        description: created?.name ? String(created.name) : undefined,
        action: (
          <ToastAction altText="Download" onClick={() => handleDownload(created)}>
            Download
          </ToastAction>
        ),
      });
      setViewTab("list");
      closeGenerateDialog();
    } catch (err: unknown) {
      const errRec = asRecord(err);
      const data = asRecord(errRec?.data);
      const code = typeof data?.code === "string" ? String(data.code) : "";
      const missingRaw = Array.isArray(data?.missing) ? data?.missing : null;
      const reasonsRaw = Array.isArray(data?.reasons) ? data?.reasons : null;
      if (code === "TEMPLATE_NOT_READY" && missingRaw) {
        const missingMsgs = missingRaw
          .map((m) => asRecord(m)?.message)
          .filter((m): m is string => typeof m === "string" && Boolean(m.trim()));
        toast({ title: "Template not ready", description: missingMsgs.join(", "), variant: "destructive" });
      } else if (code === "TEMPLATE_NOT_APPLICABLE") {
        const reasons = reasonsRaw?.filter((x): x is string => typeof x === "string" && Boolean(x.trim()));
        toast({ title: "Template not applicable", description: reasons?.length ? reasons.join(", ") : undefined, variant: "destructive" });
      } else {
        toastError(toast, err, "Generation failed");
      }
    } finally {
      setIsGenerating(false);
    }
  }

  function itemKey(it: { source: string; templateId: number }): string {
    return `${it.source}:${it.templateId}`;
  }

  function toggleChecklistSelection(it: ChecklistItem) {
    const key = itemKey(it);
    setSelectedChecklistKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleDocSelection(docId: number) {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  async function handleBatchGenerate() {
    const keys = selectedChecklistKeys;
    if (!canGenerate || keys.size === 0) return;
    const allItems = (checklistQuery.data?.sections ?? []).flatMap((s) => s.items ?? []);
    const selected = allItems.filter((it) => keys.has(itemKey(it)));
    if (selected.length === 0) return;

    const letterheadIdToSend = selectedLetterheadId ? Number(selectedLetterheadId) : defaultLetterhead?.id ?? null;
    setIsBatchGenerating(true);
    setBatchGenerateResult(null);
    try {
      const result = await apiFetchJson<{ jobId: string; items: Array<Record<string, unknown>> }>(`/cases/${caseId}/documents/batch-generate`, {
        method: "POST",
        body: JSON.stringify({
          items: selected.map((it) => ({ source: it.source, templateId: it.templateId })),
          letterheadId: letterheadIdToSend,
        }),
      });
      setBatchGenerateResult(result);
      setSelectedChecklistKeys(new Set());
      await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      await qc.invalidateQueries({ queryKey: ["case-documents-instances", caseId] });
      toast({ title: "Batch generate completed", description: `Job ${result.jobId}` });
      setViewTab("list");
    } catch (err) {
      toastError(toast, err, "Batch generate failed");
    } finally {
      setIsBatchGenerating(false);
    }
  }

  async function handleBatchExport() {
    const ids = Array.from(selectedDocIds);
    if (!canExport || ids.length === 0) return;
    setIsBatchExporting(true);
    try {
      const result = await apiFetchJson<{ jobId: string; downloadPath?: string }>(`/cases/${caseId}/documents/batch-export`, {
        method: "POST",
        body: JSON.stringify({ documentIds: ids }),
      });
      const downloadPath = result.downloadPath ?? `/document-batch-jobs/${result.jobId}/download`;
      const blob = await apiFetchBlob(downloadPath);
      downloadBlob(blob, `case-${caseId}-documents.zip`);
      setSelectedDocIds(new Set());
      toast({ title: "Export ready", description: `Job ${result.jobId}` });
    } catch (err) {
      toastError(toast, err, "Batch export failed");
    } finally {
      setIsBatchExporting(false);
    }
  }

  function closeGenerateDialog() {
    setGenerateDialogOpen(false);
    setDocumentName("");
    setSelectedLetterheadId("");
    setShowAllTemplates(false);
    setTemplateSourceFilter("all");
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
              disabled={!canCreate}
            >
              <Upload className="w-3.5 h-3.5" />
              Upload
            </Button>
            <Button
              size="sm"
              className="bg-amber-500 hover:bg-amber-600 gap-1.5"
              onClick={() => setGenerateDialogOpen(true)}
              disabled={!canGenerate}
            >
              <Plus className="w-3.5 h-3.5" />
              Generate from Template
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={viewTab} onValueChange={(v) => setViewTab(v === "checklist" ? "checklist" : v === "history" ? "history" : "list")}>
            <TabsList className="mb-4">
              <TabsTrigger value="list">List</TabsTrigger>
              <TabsTrigger value="checklist">Checklist</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>

            <TabsContent value="list">
              {documents.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                  <p className="font-medium text-slate-600 mb-1">No documents yet</p>
                  <p className="text-sm">Upload documents or generate them from templates.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm text-slate-600">
                      Selected: <span className="font-medium text-slate-900">{selectedDocIds.size}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleBatchExport}
                      disabled={!canExport || selectedDocIds.size === 0 || isBatchExporting}
                      className="gap-1.5"
                    >
                      <Download className="w-4 h-4" />
                      {isBatchExporting ? "Exporting..." : "Batch Export (ZIP)"}
                    </Button>
                  </div>
                  {documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-center gap-3 p-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
                    >
                      <Checkbox
                        checked={selectedDocIds.has(doc.id)}
                        onCheckedChange={() => toggleDocSelection(doc.id)}
                        disabled={!canExport}
                      />
                      <FileText className="w-5 h-5 text-amber-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-900 truncate" title={doc.name}>{doc.name}</div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                            {docTypeLabel(doc.document_type)}
                          </span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium capitalize">
                            {doc.status}
                          </span>
                          {doc.template_source && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium capitalize">
                              {String(doc.template_source)}
                            </span>
                          )}
                          {doc.template_name && (
                            <span className="text-xs text-slate-500">from: {doc.template_name}</span>
                          )}
                          {doc.template_snapshot_name && !doc.template_name && (
                            <span className="text-xs text-slate-500">from: {doc.template_snapshot_name}</span>
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
                        disabled={!canDelete}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="checklist">
              {checklistQuery.isLoading ? (
                <div className="p-4 text-slate-500">Loading checklist...</div>
              ) : checklistQuery.isError ? (
                <QueryFallback title="Checklist unavailable" error={checklistQuery.error} onRetry={() => checklistQuery.refetch()} isRetrying={checklistQuery.isFetching} />
              ) : (
                <div className="space-y-6">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm text-slate-600">
                      Selected: <span className="font-medium text-slate-900">{selectedChecklistKeys.size}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedChecklistKeys(new Set())}
                        disabled={selectedChecklistKeys.size === 0}
                      >
                        Clear
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleBatchGenerate}
                        disabled={!canGenerate || selectedChecklistKeys.size === 0 || isBatchGenerating}
                        className="gap-1.5"
                      >
                        <Plus className="w-4 h-4" />
                        {isBatchGenerating ? "Generating..." : "Batch Generate"}
                      </Button>
                    </div>
                  </div>
                  {activeLetterheads.length > 0 && (
                    <div className="space-y-1.5">
                      <Label>Letterhead (for letter-like templates)</Label>
                      <Select value={selectedLetterheadId} onValueChange={setSelectedLetterheadId}>
                        <SelectTrigger>
                          <SelectValue placeholder={defaultLetterhead ? `Default: ${defaultLetterhead.name}` : "Select letterhead..."} />
                        </SelectTrigger>
                        <SelectContent>
                          {activeLetterheads.map((l) => (
                            <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {batchGenerateResult && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="text-sm font-medium text-slate-900">Last batch job: {batchGenerateResult.jobId}</div>
                      <div className="mt-2 space-y-1">
                        {batchGenerateResult.items.filter((x) => x.status === "failed").length === 0 ? (
                          <div className="text-sm text-emerald-700">All items succeeded.</div>
                        ) : (
                          batchGenerateResult.items.filter((x) => x.status === "failed").map((x, idx) => (
                            <div key={idx} className="text-sm text-slate-700 break-words">
                              {String(x.source ?? "")} #{String(x.templateId ?? "")}: {String(x.errorCode ?? "")} {String(x.errorMessage ?? "")}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                  {(checklistQuery.data?.sections ?? []).map((sec) => (
                    <div key={sec.section} className="space-y-2">
                      <div className="text-sm font-semibold text-slate-900">{sec.section}</div>
                      <div className="space-y-2">
                        {(sec.items ?? []).map((it) => {
                          const applicable = it.applicability?.status === "applicable";
                          const ready = it.readiness?.status === "ready";
                          const latestId = it.latestDocument?.id;
                          const latestDoc = latestId ? documents.find((d) => d.id === latestId) : null;
                          const reason = !applicable
                            ? (it.applicability?.reasons ?? []).join(", ")
                            : !ready
                              ? (it.readiness?.missing ?? []).map((m) => m.message).filter(Boolean).slice(0, 3).join(", ")
                              : "";
                          return (
                            <div key={`${it.source}-${it.templateId}`} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 min-w-0">
                              <div className="pt-1">
                                <Checkbox
                                  checked={selectedChecklistKeys.has(itemKey(it))}
                                  onCheckedChange={() => toggleChecklistSelection(it)}
                                  disabled={!canGenerate}
                                />
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium text-slate-900 truncate" title={it.name}>{it.name}</div>
                                <div className="mt-1 flex items-center gap-2 flex-wrap">
                                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", it.source === "firm" ? "bg-slate-100 text-slate-700" : "bg-purple-50 text-purple-700")}>
                                    {it.source}
                                  </span>
                                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", applicable ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
                                    {applicable ? "Applicable" : "Not applicable"}
                                  </span>
                                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800")}>
                                    {ready ? "Ready" : (it.readiness?.status || "Incomplete")}
                                  </span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                                    {it.documentGroup}
                                  </span>
                                </div>
                                {reason && <div className="mt-1 text-xs text-slate-600 break-words">{reason}</div>}
                              </div>
                              <div className="shrink-0 flex items-center gap-2">
                                {latestDoc ? (
                                  <Button size="sm" variant="outline" onClick={() => handleDownload(latestDoc)} disabled={downloadingDocId === latestDoc.id}>
                                    Download
                                  </Button>
                                ) : (
                                  <Button size="sm" onClick={() => handleGenerate(it)} disabled={!canGenerate || !applicable || !ready || isGenerating}>
                                    Generate
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="history">
              {instancesQuery.isLoading ? (
                <div className="p-4 text-slate-500">Loading history...</div>
              ) : instancesQuery.isError ? (
                <QueryFallback title="History unavailable" error={instancesQuery.error} onRetry={() => instancesQuery.refetch()} isRetrying={instancesQuery.isFetching} />
              ) : (instancesQuery.data ?? []).length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                  <p className="font-medium text-slate-600 mb-1">No generation history yet</p>
                  <p className="text-sm">Generate documents to see runs here (including failures).</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {(instancesQuery.data ?? []).map((run) => {
                    const doc = run.case_document_id ? documents.find((d) => d.id === run.case_document_id) : null;
                    const title = run.template_source === "master"
                      ? (run.platform_document_name || `Master #${run.platform_document_id ?? ""}`)
                      : (run.template_name || `Template #${run.template_id ?? ""}`);
                    return (
                      <div key={run.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 min-w-0">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate" title={run.document_name}>{run.document_name}</div>
                          <div className="mt-1 text-xs text-slate-600 truncate" title={title}>{title}</div>
                          <div className="mt-1 flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium capitalize">{run.template_source}</span>
                            <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium capitalize", run.status === "success" ? "bg-emerald-50 text-emerald-700" : run.status === "failed" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800")}>
                              {run.status}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                              {run.render_mode}
                            </span>
                            <span className="text-xs text-slate-400">
                              {new Date(run.triggered_at).toLocaleString("en-MY")}
                            </span>
                            {run.triggered_by_name && (
                              <span className="text-xs text-slate-500">by {run.triggered_by_name}</span>
                            )}
                          </div>
                          {run.status === "failed" && (run.error_code || run.error_message) && (
                            <div className="mt-1 text-sm text-rose-700 break-words">
                              {run.error_code ? `${run.error_code}: ` : ""}{run.error_message ?? ""}
                            </div>
                          )}
                        </div>
                        <div className="shrink-0">
                          {doc ? (
                            <Button size="sm" variant="outline" onClick={() => handleDownload(doc)} disabled={downloadingDocId === doc.id}>
                              Download
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Dialog open={generateDialogOpen} onOpenChange={(v) => { if (!v) closeGenerateDialog(); else setGenerateDialogOpen(true); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate Document from Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button size="sm" variant={showAllTemplates ? "outline" : "default"} onClick={() => setShowAllTemplates(false)}>
                  Applicable
                </Button>
                <Button size="sm" variant={showAllTemplates ? "default" : "outline"} onClick={() => setShowAllTemplates(true)}>
                  All templates
                </Button>
              </div>
              <Select
                value={templateSourceFilter}
                onValueChange={(v) => setTemplateSourceFilter(v === "firm" ? "firm" : v === "master" ? "master" : "all")}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="firm">Firm</SelectItem>
                  <SelectItem value="master">Master</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Document name (optional)</Label>
              <Input value={documentName} onChange={(e) => setDocumentName(e.target.value)} placeholder="Leave empty to use template name" />
            </div>

            {activeLetterheads.length > 0 && (
              <div className="space-y-1.5">
                <Label>Letterhead (for letter-like templates)</Label>
                <Select value={selectedLetterheadId} onValueChange={setSelectedLetterheadId}>
                  <SelectTrigger>
                    <SelectValue placeholder={defaultLetterhead ? `Default: ${defaultLetterhead.name}` : "Select letterhead..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {activeLetterheads.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="border rounded-lg p-3 max-h-[340px] overflow-y-auto">
              {checklistQuery.isLoading ? (
                <div className="text-sm text-slate-500 py-6 text-center">Loading templates…</div>
              ) : checklistQuery.isError ? (
                <QueryFallback title="Templates unavailable" error={checklistQuery.error} onRetry={() => checklistQuery.refetch()} isRetrying={checklistQuery.isFetching} />
              ) : (
                <div className="space-y-4">
                  {(checklistQuery.data?.sections ?? []).map((sec) => {
                    const filtered = (sec.items ?? []).filter((it) => {
                      if (!showAllTemplates && it.applicability?.status !== "applicable") return false;
                      if (templateSourceFilter !== "all" && it.source !== templateSourceFilter) return false;
                      return true;
                    });
                    if (filtered.length === 0) return null;
                    return (
                      <div key={sec.section} className="space-y-2">
                        <div className="text-xs font-semibold text-slate-700">{sec.section}</div>
                        <div className="space-y-2">
                          {filtered.map((it) => {
                            const applicable = it.applicability?.status === "applicable";
                            const ready = it.readiness?.status === "ready";
                            const reason = !applicable
                              ? (it.applicability?.reasons ?? []).join(", ")
                              : !ready
                                ? (it.readiness?.missing ?? []).map((m) => m.message).filter(Boolean).slice(0, 3).join(", ")
                                : "";
                            return (
                              <div key={`${it.source}-${it.templateId}`} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-white p-2">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-slate-900 truncate" title={it.name}>{it.name}</div>
                                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", it.source === "firm" ? "bg-slate-100 text-slate-700" : "bg-purple-50 text-purple-700")}>
                                      {it.source}
                                    </span>
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", applicable ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
                                      {applicable ? "Applicable" : "Not applicable"}
                                    </span>
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800")}>
                                      {ready ? "Ready" : (it.readiness?.status || "Incomplete")}
                                    </span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                                      {it.documentGroup}
                                    </span>
                                  </div>
                                  {reason && <div className="mt-1 text-xs text-slate-600 break-words">{reason}</div>}
                                </div>
                                <div className="shrink-0">
                                  <Button size="sm" onClick={() => handleGenerate(it)} disabled={!applicable || !ready || isGenerating}>
                                    Generate
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={closeGenerateDialog} disabled={isGenerating}>Close</Button>
            </div>
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
