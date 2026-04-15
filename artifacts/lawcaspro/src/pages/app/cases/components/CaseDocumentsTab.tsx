import { useEffect, useState, useRef } from "react";
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
import { Textarea } from "@/components/ui/textarea";
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

type ChecklistStatus =
  | "pending"
  | "generated"
  | "uploaded"
  | "received"
  | "completed"
  | "waived"
  | "not_applicable";

type ChecklistItem = {
  checklistKey: string;
  kind: "template" | "workflow" | "stamping" | "manual";
  source: "firm" | "master" | "workflow" | "stamping" | "manual";
  sourceType: "generated" | "uploaded" | "manual" | "external_received";
  isRequired: boolean;
  status: ChecklistStatus;
  blocked: boolean;
  updatedAt: string | null;
  notes: string | null;
  applicability: { status: ApplicabilityStatus; reasons: string[] };
  readiness: { status: ReadinessStatus; missing: Array<{ code: string; message: string }> } | null;
  templateId?: number;
  name: string;
  documentType?: string;
  documentGroup: string;
  sortOrder: number;
  fileName: string | null;
  fileType: string | null;
  pdfMappings: unknown;
  latestDocument: { id: number } | null;
  workflowMilestoneKey?: string;
  workflowDocumentId?: number | null;
  loanStampingItemId?: number | null;
  loanStampingItemKey?: string | null;
  receivedAt?: string | null;
  completedAt?: string | null;
  waivedAt?: string | null;
  waivedReason?: string | null;
};

type ChecklistSection = { section: string; items: ChecklistItem[] };
type ChecklistResponse = {
  case: { caseId: number; referenceNo: string | null; purchaseMode: string | null; titleType: string | null; caseType: string | null; projectName: string | null };
  summary: { totalApplicable: number; requiredMissing: number; completed: number; waived: number };
  sections: ChecklistSection[];
};

type DocumentPreviewResponse = {
  resolvedVariables: Record<string, unknown>;
  missingRequiredVariables: Array<{ variableKey: string; reason: string }>;
  unusedBindings: string[];
  placeholderWarnings: Array<{ placeholder: string; warning: string }>;
  applicabilityResult: { applicable: boolean; reasons: string[] };
  renderMode: string;
  previewSummary: { renderable: boolean; placeholdersCount: number; usedMode: string; missingRequiredCount: number };
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
  const canBypassApplicability = hasPermission(user, "documents", "update");

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewItem, setPreviewItem] = useState<ChecklistItem | null>(null);
  const [previewResult, setPreviewResult] = useState<DocumentPreviewResponse | null>(null);

  const [checklistFilter, setChecklistFilter] = useState<"all" | "required" | "missing" | "completed" | "waived" | "not_applicable">("all");
  const [waiveDialogOpen, setWaiveDialogOpen] = useState(false);
  const [waiveTarget, setWaiveTarget] = useState<ChecklistItem | null>(null);
  const [waiveReason, setWaiveReason] = useState("");

  const [checklistUploadOpen, setChecklistUploadOpen] = useState(false);
  const [checklistUploadTarget, setChecklistUploadTarget] = useState<ChecklistItem | null>(null);
  const [checklistUploadFile, setChecklistUploadFile] = useState<File | null>(null);

  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [manualLabel, setManualLabel] = useState("");
  const [manualRequired, setManualRequired] = useState(false);

  const [checklistHistoryOpen, setChecklistHistoryOpen] = useState(false);
  const [checklistHistoryKey, setChecklistHistoryKey] = useState<string | null>(null);

  useEffect(() => {
    if (!canBypassApplicability && showAllTemplates) setShowAllTemplates(false);
  }, [canBypassApplicability, showAllTemplates]);

  const documentsQuery = useQuery<CaseDocument[]>({
    queryKey: ["case-documents", caseId],
    queryFn: () => apiFetchJson(`/cases/${caseId}/documents`),
    retry: false,
  });
  const documents = documentsQuery.data ?? [];

  const checklistQuery = useQuery<ChecklistResponse>({
    queryKey: ["case-documents-checklist", caseId, showAllTemplates],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/documents/checklist${showAllTemplates && canBypassApplicability ? "?includeAll=1" : ""}`, { signal }),
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
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({ title: "Document deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const checklistReceivedMutation = useMutation({
    mutationFn: (item: ChecklistItem) =>
      apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(item.checklistKey)}/received`, {
        method: "POST",
        body: JSON.stringify({ label: item.name }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({ title: "Marked as received" });
    },
    onError: (err) => toastError(toast, err, "Mark received failed"),
  });

  const checklistCompletedMutation = useMutation({
    mutationFn: (item: ChecklistItem) =>
      apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(item.checklistKey)}/completed`, {
        method: "POST",
        body: JSON.stringify({ label: item.name }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({ title: "Marked as completed" });
    },
    onError: (err) => toastError(toast, err, "Mark completed failed"),
  });

  const checklistReopenMutation = useMutation({
    mutationFn: (item: ChecklistItem) =>
      apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(item.checklistKey)}/reopen`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({ title: "Reopened" });
    },
    onError: (err) => toastError(toast, err, "Reopen failed"),
  });

  const checklistWaiveMutation = useMutation({
    mutationFn: ({ item, reason }: { item: ChecklistItem; reason: string }) =>
      apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(item.checklistKey)}/waive`, {
        method: "POST",
        body: JSON.stringify({ reason, label: item.name }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({ title: "Waived" });
      setWaiveDialogOpen(false);
      setWaiveTarget(null);
      setWaiveReason("");
    },
    onError: (err) => toastError(toast, err, "Waive failed"),
  });

  const checklistManualCreateMutation = useMutation({
    mutationFn: ({ label, isRequired }: { label: string; isRequired: boolean }) =>
      apiFetchJson(`/cases/${caseId}/documents/checklist/items`, {
        method: "POST",
        body: JSON.stringify({ label, isRequired }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({ title: "Manual checklist item added" });
      setManualDialogOpen(false);
      setManualLabel("");
      setManualRequired(false);
    },
    onError: (err) => toastError(toast, err, "Create checklist item failed"),
  });

  type AuditLogRow = {
    id: number;
    action: string;
    detail: string | null;
    created_at: string;
  };

  const checklistHistoryQuery = useQuery<AuditLogRow[]>({
    queryKey: ["case-documents-checklist-history", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/documents/checklist/history`, { signal }),
    enabled: checklistHistoryOpen,
    retry: false,
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
      const bypassApplicability = Boolean(showAllTemplates && canBypassApplicability);
      if (item.source === "firm") {
        created = await apiFetchJson(`/cases/${caseId}/documents/generate`, {
          method: "POST",
          body: JSON.stringify({ templateId: Number(item.templateId), documentName: documentName || undefined, letterheadId: letterheadIdToSend, bypassApplicability }),
        });
      } else {
        created = await apiFetchJson(`/cases/${caseId}/documents/generate-from-master`, {
          method: "POST",
          body: JSON.stringify({ masterDocId: Number(item.templateId), documentName: documentName || undefined, letterheadId: letterheadIdToSend, bypassApplicability }),
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
      const missingReq = Array.isArray(data?.missingRequiredVariables) ? data?.missingRequiredVariables : null;
      if (code === "TEMPLATE_NOT_READY" && missingRaw) {
        const missingMsgs = missingRaw
          .map((m) => asRecord(m)?.message)
          .filter((m): m is string => typeof m === "string" && Boolean(m.trim()));
        toast({ title: "Template not ready", description: missingMsgs.join(", "), variant: "destructive" });
      } else if (code === "TEMPLATE_APPLICABILITY_BLOCKED") {
        const reasons = reasonsRaw?.filter((x): x is string => typeof x === "string" && Boolean(x.trim()));
        toast({ title: "Template blocked", description: reasons?.length ? reasons.join(", ") : undefined, variant: "destructive" });
      } else if (code === "TEMPLATE_BINDING_MISSING" && missingReq) {
        const missingKeys = missingReq
          .map((m) => asRecord(m)?.variableKey)
          .filter((m): m is string => typeof m === "string" && Boolean(m.trim()));
        toast({ title: "Missing required variables", description: missingKeys.join(", "), variant: "destructive" });
      } else {
        toastError(toast, err, "Generation failed");
      }
    } finally {
      setIsGenerating(false);
    }
  }

  async function handlePreview(item: ChecklistItem) {
    if (!canGenerate) return;
    if (item.kind !== "template" || typeof item.templateId !== "number" || (item.source !== "firm" && item.source !== "master")) return;
    setPreviewItem(item);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewResult(null);
    try {
      const bypassApplicability = Boolean(showAllTemplates && canBypassApplicability);
      const result = await apiFetchJson<DocumentPreviewResponse>(`/cases/${caseId}/documents/preview`, {
        method: "POST",
        body: JSON.stringify(
          item.source === "firm"
            ? { templateId: Number(item.templateId), bypassApplicability }
            : { platformDocumentId: Number(item.templateId), bypassApplicability }
        ),
      });
      setPreviewResult(result);
    } catch (err) {
      toastError(toast, err, "Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }

  function toggleChecklistSelection(it: ChecklistItem) {
    if (it.kind !== "template" || (it.source !== "firm" && it.source !== "master") || typeof it.templateId !== "number") return;
    const key = it.checklistKey;
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
    const selected = allItems
      .filter((it) => it.kind === "template" && (it.source === "firm" || it.source === "master") && typeof it.templateId === "number")
      .filter((it) => keys.has(it.checklistKey));
    if (selected.length === 0) return;

    const letterheadIdToSend = selectedLetterheadId ? Number(selectedLetterheadId) : defaultLetterhead?.id ?? null;
    setIsBatchGenerating(true);
    setBatchGenerateResult(null);
    try {
      const result = await apiFetchJson<{ jobId: string; items: Array<Record<string, unknown>> }>(`/cases/${caseId}/documents/batch-generate`, {
        method: "POST",
        body: JSON.stringify({
          items: selected.map((it) => ({ source: it.source, templateId: Number(it.templateId) })),
          letterheadId: letterheadIdToSend,
          bypassApplicability: Boolean(showAllTemplates && canBypassApplicability),
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

  async function uploadPrivateObject(file: File, objectPath?: string): Promise<string> {
    const formData = new FormData();
    formData.append("file", file);
    const path = objectPath ? `/storage/upload?objectPath=${encodeURIComponent(objectPath)}` : "/storage/upload";
    const { objectPath: storedPath } = await apiFetchJson<{ objectPath: string }>(path, { method: "POST", body: formData });
    return storedPath;
  }

  async function handleUpload() {
    if (!selectedFile || !uploadName) return;
    setIsUploading(true);
    try {
      const objectPath = await uploadPrivateObject(selectedFile);

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

  async function handleChecklistUpload() {
    if (!checklistUploadTarget || !checklistUploadFile || !user?.firmId) return;
    setIsUploading(true);
    try {
      const file = checklistUploadFile;
      const firmId = Number(user.firmId);
      const safeKey = checklistUploadTarget.checklistKey.replace(/[^a-zA-Z0-9:_-]/g, "_");
      if (checklistUploadTarget.kind === "workflow") {
        const milestoneKey = checklistUploadTarget.workflowMilestoneKey;
        if (!milestoneKey) throw new Error("Missing workflow milestoneKey");
        const objectPath = `/objects/cases/${firmId}/case-${caseId}/workflow/${milestoneKey}/${crypto.randomUUID()}-${file.name}`;
        const stored = await uploadPrivateObject(file, objectPath);
        await apiFetchJson(`/cases/${caseId}/workflow-documents`, {
          method: "POST",
          body: JSON.stringify({
            milestoneKey,
            objectPath: stored,
            fileName: file.name,
            mimeType: file.type || null,
            fileSize: file.size,
          }),
        });
        await apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(checklistUploadTarget.checklistKey)}/upload-event`, {
          method: "POST",
          body: JSON.stringify({ event: "upload", label: checklistUploadTarget.name }),
        });
      } else if (checklistUploadTarget.kind === "stamping") {
        const itemKey = checklistUploadTarget.loanStampingItemKey;
        if (!itemKey) throw new Error("Missing loan stamping itemKey");
        let itemId = checklistUploadTarget.loanStampingItemId ?? null;
        if (!itemId) {
          const ensured = await apiFetchJson<{ id: number }>(`/cases/${caseId}/loan-stamping/ensure`, {
            method: "POST",
            body: JSON.stringify({ itemKey }),
          });
          itemId = ensured.id;
        }
        const objectPath = `/objects/cases/${firmId}/case-${caseId}/loan-stamping/${itemId}/${crypto.randomUUID()}-${file.name}`;
        const stored = await uploadPrivateObject(file, objectPath);
        await apiFetchJson(`/cases/${caseId}/loan-stamping/${itemId}/file`, {
          method: "POST",
          body: JSON.stringify({
            objectPath: stored,
            fileName: file.name,
            mimeType: file.type || null,
            fileSize: file.size,
          }),
        });
        await apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(checklistUploadTarget.checklistKey)}/upload-event`, {
          method: "POST",
          body: JSON.stringify({ event: "upload", label: checklistUploadTarget.name }),
        });
      } else {
        const objectPath = `/objects/cases/${firmId}/case-${caseId}/documents/checklist/${safeKey}/${crypto.randomUUID()}-${file.name}`;
        const stored = await uploadPrivateObject(file, objectPath);
        await apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(checklistUploadTarget.checklistKey)}/upload`, {
          method: "POST",
          body: JSON.stringify({
            objectPath: stored,
            fileName: file.name,
            mimeType: file.type || null,
            fileSize: file.size,
            label: checklistUploadTarget.name,
          }),
        });
      }

      await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
      await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
      toast({ title: "Uploaded" });
      setChecklistUploadOpen(false);
      setChecklistUploadTarget(null);
      setChecklistUploadFile(null);
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
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-lg border bg-white p-3 min-w-0">
                      <div className="text-xs text-slate-500">Total applicable</div>
                      <div className="text-xl font-semibold text-slate-900">{checklistQuery.data?.summary?.totalApplicable ?? 0}</div>
                    </div>
                    <div className="rounded-lg border bg-white p-3 min-w-0">
                      <div className="text-xs text-slate-500">Required missing</div>
                      <div className="text-xl font-semibold text-rose-700">{checklistQuery.data?.summary?.requiredMissing ?? 0}</div>
                    </div>
                    <div className="rounded-lg border bg-white p-3 min-w-0">
                      <div className="text-xs text-slate-500">Completed</div>
                      <div className="text-xl font-semibold text-emerald-700">{checklistQuery.data?.summary?.completed ?? 0}</div>
                    </div>
                    <div className="rounded-lg border bg-white p-3 min-w-0">
                      <div className="text-xs text-slate-500">Waived</div>
                      <div className="text-xl font-semibold text-slate-800">{checklistQuery.data?.summary?.waived ?? 0}</div>
                    </div>
                  </div>

                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <div className="text-sm text-slate-600">
                        Selected: <span className="font-medium text-slate-900">{selectedChecklistKeys.size}</span>
                      </div>
                      <Select value={checklistFilter} onValueChange={(v) => setChecklistFilter(v as any)}>
                        <SelectTrigger className="w-[200px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="required">Required</SelectItem>
                          <SelectItem value="missing">Missing</SelectItem>
                          <SelectItem value="completed">Completed</SelectItem>
                          <SelectItem value="waived">Waived</SelectItem>
                          <SelectItem value="not_applicable">Not applicable</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => setChecklistHistoryOpen(true)} className="gap-1.5">
                        View history
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setManualDialogOpen(true)} disabled={!canBypassApplicability} className="gap-1.5">
                        <Plus className="w-4 h-4" />
                        Manual item
                      </Button>
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
                        {(sec.items ?? [])
                          .filter((it) => {
                            const applicable = it.applicability?.status === "applicable" && it.status !== "not_applicable";
                            const missing = it.isRequired && applicable && !["generated", "uploaded", "received", "completed", "waived"].includes(it.status);
                            if (checklistFilter === "all") return true;
                            if (checklistFilter === "required") return it.isRequired && applicable;
                            if (checklistFilter === "missing") return missing;
                            if (checklistFilter === "completed") return it.status === "completed";
                            if (checklistFilter === "waived") return it.status === "waived";
                            if (checklistFilter === "not_applicable") return it.status === "not_applicable";
                            return true;
                          })
                          .map((it) => {
                            const applicable = it.applicability?.status === "applicable";
                            const ready = it.readiness?.status === "ready";
                            const latestId = it.latestDocument?.id;
                            const latestDoc = latestId ? documents.find((d) => d.id === latestId) : null;
                            const missing = it.isRequired && applicable && !["generated", "uploaded", "received", "completed", "waived"].includes(it.status);
                            const reason = !applicable
                              ? (it.applicability?.reasons ?? []).join(", ")
                              : it.blocked
                                ? (it.readiness?.missing ?? []).map((m) => m.message).filter(Boolean).slice(0, 3).join(", ")
                                : "";

                            const canSelectForBatch = canGenerate && it.kind === "template" && it.source !== "workflow" && it.source !== "stamping" && it.source !== "manual";
                            const selected = selectedChecklistKeys.has(it.checklistKey);

                            const statusTone =
                              it.status === "completed" ? "bg-emerald-50 text-emerald-700"
                              : it.status === "waived" ? "bg-slate-100 text-slate-700"
                              : it.status === "received" ? "bg-blue-50 text-blue-700"
                              : it.status === "uploaded" ? "bg-blue-50 text-blue-700"
                              : it.status === "generated" ? "bg-purple-50 text-purple-700"
                              : it.status === "not_applicable" ? "bg-slate-100 text-slate-500"
                              : it.blocked ? "bg-amber-50 text-amber-800"
                              : "bg-slate-100 text-slate-700";

                            const updatedLabel = it.updatedAt ? new Date(it.updatedAt).toLocaleString("en-MY") : null;

                            const sourceLabel =
                              it.source === "firm" ? "Firm"
                              : it.source === "master" ? "Master"
                              : it.source === "workflow" ? "Workflow"
                              : it.source === "stamping" ? "Loan stamping"
                              : "Manual";

                            return (
                              <div key={it.checklistKey} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 min-w-0">
                                <div className="pt-1">
                                  <Checkbox
                                    checked={selected}
                                    onCheckedChange={() => {
                                      if (!canSelectForBatch) return;
                                      const next = new Set(selectedChecklistKeys);
                                      if (next.has(it.checklistKey)) next.delete(it.checklistKey);
                                      else next.add(it.checklistKey);
                                      setSelectedChecklistKeys(next);
                                    }}
                                    disabled={!canSelectForBatch}
                                  />
                                </div>
                                <div className="min-w-0">
                                  <div className="font-medium text-slate-900 truncate" title={it.name}>{it.name}</div>
                                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", it.source === "firm" ? "bg-slate-100 text-slate-700" : it.source === "master" ? "bg-purple-50 text-purple-700" : "bg-slate-100 text-slate-700")}>
                                      {sourceLabel}
                                    </span>
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", it.isRequired ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600")}>
                                      {it.isRequired ? "Required" : "Optional"}
                                    </span>
                                    {missing ? (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-rose-50 text-rose-700">
                                        Missing
                                      </span>
                                    ) : null}
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", applicable ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
                                      {applicable ? "Applicable" : "Not applicable"}
                                    </span>
                                    {it.readiness ? (
                                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800")}>
                                        {ready ? "Ready" : (it.readiness?.status || "Incomplete")}
                                      </span>
                                    ) : null}
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium capitalize", statusTone)}>
                                      {it.status}
                                    </span>
                                  </div>
                                  {reason ? <div className="mt-1 text-xs text-slate-600 break-words">{reason}</div> : null}
                                  {updatedLabel ? <div className="mt-1 text-xs text-slate-400">Updated: {updatedLabel}</div> : null}
                                </div>
                                <div className="shrink-0 flex flex-col items-end gap-2">
                                  <div className="flex items-center gap-2 flex-wrap justify-end">
                                    {it.kind === "template" ? (
                                      <Button size="sm" variant="outline" onClick={() => handlePreview(it)} disabled={!canGenerate || previewLoading}>
                                        Preview
                                      </Button>
                                    ) : null}
                                    {latestDoc ? (
                                      <Button size="sm" variant="outline" onClick={() => handleDownload(latestDoc)} disabled={downloadingDocId === latestDoc.id}>
                                        Download
                                      </Button>
                                    ) : it.kind === "workflow" && it.workflowDocumentId ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={async () => {
                                          try {
                                            const blob = await apiFetchBlob(`/cases/${caseId}/workflow-documents/${it.workflowDocumentId}/download`);
                                            downloadBlob(blob, it.fileName || "download");
                                          } catch (err) {
                                            toastError(toast, err, "Download failed");
                                          }
                                        }}
                                      >
                                        Download
                                      </Button>
                                    ) : it.kind === "stamping" && it.loanStampingItemId ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={async () => {
                                          try {
                                            const blob = await apiFetchBlob(`/cases/${caseId}/loan-stamping/${it.loanStampingItemId}/download`);
                                            downloadBlob(blob, it.fileName || "download");
                                          } catch (err) {
                                            toastError(toast, err, "Download failed");
                                          }
                                        }}
                                      >
                                        Download
                                      </Button>
                                    ) : it.kind === "template" ? (
                                      <Button size="sm" onClick={() => handleGenerate(it)} disabled={!canGenerate || !applicable || !ready || isGenerating}>
                                        Generate
                                      </Button>
                                    ) : null}
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap justify-end">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        setChecklistUploadTarget(it);
                                        setChecklistUploadFile(null);
                                        setChecklistUploadOpen(true);
                                      }}
                                      disabled={!canCreate}
                                    >
                                      Upload
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        setChecklistHistoryKey(it.checklistKey);
                                        setChecklistHistoryOpen(true);
                                      }}
                                    >
                                      History
                                    </Button>
                                    {it.kind === "workflow" && it.workflowDocumentId && it.fileName ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={async () => {
                                          if (!confirm("Remove this workflow document file?")) return;
                                          try {
                                            await apiFetchJson(`/cases/${caseId}/workflow-documents/${it.workflowDocumentId}`, { method: "DELETE" });
                                            await apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(it.checklistKey)}/upload-event`, {
                                              method: "POST",
                                              body: JSON.stringify({ event: "upload_removed", label: it.name }),
                                            });
                                            await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
                                            await qc.invalidateQueries({ queryKey: ["case-documents-checklist-history", caseId] });
                                            toast({ title: "File removed" });
                                          } catch (err) {
                                            toastError(toast, err, "Remove failed");
                                          }
                                        }}
                                        disabled={!canBypassApplicability}
                                      >
                                        Remove file
                                      </Button>
                                    ) : null}
                                    {it.kind === "stamping" && it.loanStampingItemId && it.fileName ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={async () => {
                                          if (!confirm("Remove this stamping file?")) return;
                                          try {
                                            await apiFetchJson(`/cases/${caseId}/loan-stamping/${it.loanStampingItemId}/file`, { method: "DELETE" });
                                            await apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(it.checklistKey)}/upload-event`, {
                                              method: "POST",
                                              body: JSON.stringify({ event: "upload_removed", label: it.name }),
                                            });
                                            await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
                                            await qc.invalidateQueries({ queryKey: ["case-documents-checklist-history", caseId] });
                                            toast({ title: "File removed" });
                                          } catch (err) {
                                            toastError(toast, err, "Remove failed");
                                          }
                                        }}
                                        disabled={!canBypassApplicability}
                                      >
                                        Remove file
                                      </Button>
                                    ) : null}
                                    <Button size="sm" variant="outline" onClick={() => checklistReceivedMutation.mutate(it)} disabled={!canBypassApplicability || it.status === "waived" || it.status === "not_applicable"}>
                                      Mark received
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => checklistCompletedMutation.mutate(it)} disabled={!canBypassApplicability || it.status === "waived" || it.status === "not_applicable"}>
                                      Mark completed
                                    </Button>
                                    {it.status === "waived" || it.status === "completed" || it.status === "received" ? (
                                      <Button size="sm" variant="outline" onClick={() => checklistReopenMutation.mutate(it)} disabled={!canBypassApplicability}>
                                        Reopen
                                      </Button>
                                    ) : (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          setWaiveTarget(it);
                                          setWaiveReason("");
                                          setWaiveDialogOpen(true);
                                        }}
                                        disabled={!canBypassApplicability || it.status === "not_applicable"}
                                      >
                                        Waive
                                      </Button>
                                    )}
                                  </div>
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

      <Dialog open={previewOpen} onOpenChange={(v) => { if (!v) { setPreviewOpen(false); setPreviewItem(null); setPreviewResult(null); } else setPreviewOpen(true); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
          </DialogHeader>
          {previewLoading ? (
            <div className="text-slate-500 py-6">Loading preview...</div>
          ) : !previewResult ? (
            <div className="text-slate-500 py-6">No preview data.</div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900">Applicability</div>
                  <span className={cn("text-xs px-2 py-1 rounded font-medium", previewResult.applicabilityResult.applicable ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")}>
                    {previewResult.applicabilityResult.applicable ? "Applicable" : "Blocked"}
                  </span>
                </div>
                {!previewResult.applicabilityResult.applicable && previewResult.applicabilityResult.reasons.length > 0 ? (
                  <div className="mt-2 text-sm text-rose-700 break-words">{previewResult.applicabilityResult.reasons.join(", ")}</div>
                ) : null}
                <div className="mt-2 text-xs text-slate-500">
                  Mode: {previewResult.previewSummary.usedMode} • Placeholders: {previewResult.previewSummary.placeholdersCount} • Renderable: {previewResult.previewSummary.renderable ? "Yes" : "No"}
                </div>
              </div>

              {previewResult.missingRequiredVariables.length > 0 ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                  <div className="text-sm font-medium text-rose-900">Missing required variables</div>
                  <div className="mt-2 text-sm text-rose-800 break-words">
                    {previewResult.missingRequiredVariables.map((m) => m.variableKey).join(", ")}
                  </div>
                </div>
              ) : null}

              {previewResult.placeholderWarnings.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <div className="text-sm font-medium text-amber-900">Warnings</div>
                  <div className="mt-2 space-y-1">
                    {previewResult.placeholderWarnings.slice(0, 10).map((w, idx) => (
                      <div key={idx} className="text-sm text-amber-800 break-words">
                        {w.placeholder}: {w.warning}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-sm font-medium text-slate-900">Resolved sample values</div>
                <div className="mt-2 space-y-1">
                  {Object.entries(previewResult.resolvedVariables).slice(0, 20).map(([k, v]) => (
                    <div key={k} className="text-xs text-slate-700 break-words">
                      <span className="font-medium text-slate-900">{k}</span>: {String(v ?? "")}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setPreviewOpen(false); setPreviewItem(null); setPreviewResult(null); }}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    if (!previewItem) return;
                    setPreviewOpen(false);
                    handleGenerate(previewItem);
                  }}
                  disabled={!previewItem || !canGenerate || !previewResult.applicabilityResult.applicable || previewResult.missingRequiredVariables.length > 0 || !previewResult.previewSummary.renderable}
                >
                  Generate
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={generateDialogOpen} onOpenChange={(v) => { if (!v) closeGenerateDialog(); else setGenerateDialogOpen(true); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate Document from Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              {canBypassApplicability ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant={showAllTemplates ? "outline" : "default"} onClick={() => setShowAllTemplates(false)}>
                    Applicable
                  </Button>
                  <Button size="sm" variant={showAllTemplates ? "default" : "outline"} onClick={() => setShowAllTemplates(true)}>
                    All templates
                  </Button>
                </div>
              ) : (
                <div className="text-sm text-slate-600">Applicable templates</div>
              )}
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
                      if (it.kind !== "template") return false;
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

      <Dialog open={checklistUploadOpen} onOpenChange={setChecklistUploadOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload for Checklist</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-sm text-slate-700">
              {checklistUploadTarget ? (
                <>
                  <div className="font-medium">{checklistUploadTarget.name}</div>
                  <div className="text-xs text-slate-500">{checklistUploadTarget.checklistKey}</div>
                </>
              ) : (
                <div className="text-slate-500">No item selected</div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>File</Label>
              <Input type="file" onChange={(e) => setChecklistUploadFile(e.target.files?.[0] ?? null)} />
              {checklistUploadFile ? <div className="text-xs text-slate-500">{checklistUploadFile.name}</div> : null}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setChecklistUploadOpen(false);
                  setChecklistUploadTarget(null);
                  setChecklistUploadFile(null);
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleChecklistUpload} disabled={!checklistUploadTarget || !checklistUploadFile || isUploading}>
                {isUploading ? "Uploading..." : "Upload"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={waiveDialogOpen} onOpenChange={setWaiveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Waive Checklist Item</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-sm text-slate-700">
              {waiveTarget ? <div className="font-medium">{waiveTarget.name}</div> : <div className="text-slate-500">No item selected</div>}
            </div>
            <div className="space-y-1.5">
              <Label>Reason (required)</Label>
              <Textarea value={waiveReason} onChange={(e) => setWaiveReason(e.target.value)} rows={3} placeholder="Explain why this item is waived..." />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setWaiveDialogOpen(false);
                  setWaiveTarget(null);
                  setWaiveReason("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (!waiveTarget) return;
                  checklistWaiveMutation.mutate({ item: waiveTarget, reason: waiveReason.trim() });
                }}
                disabled={!waiveTarget || !waiveReason.trim() || checklistWaiveMutation.isPending}
              >
                {checklistWaiveMutation.isPending ? "Saving..." : "Waive"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={manualDialogOpen} onOpenChange={setManualDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Manual Checklist Item</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input value={manualLabel} onChange={(e) => setManualLabel(e.target.value)} placeholder="e.g. Developer authorization letter" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={manualRequired} onCheckedChange={(v) => setManualRequired(Boolean(v))} />
              <span className="text-sm text-slate-700">Required</span>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setManualDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() => checklistManualCreateMutation.mutate({ label: manualLabel.trim(), isRequired: manualRequired })}
                disabled={!manualLabel.trim() || checklistManualCreateMutation.isPending}
              >
                {checklistManualCreateMutation.isPending ? "Saving..." : "Add"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={checklistHistoryOpen} onOpenChange={setChecklistHistoryOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Checklist History</DialogTitle>
          </DialogHeader>
          {checklistHistoryQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6">Loading history...</div>
          ) : checklistHistoryQuery.isError ? (
            <QueryFallback title="History unavailable" error={checklistHistoryQuery.error} onRetry={() => checklistHistoryQuery.refetch()} isRetrying={checklistHistoryQuery.isFetching} />
          ) : (
            <div className="space-y-2">
              {(checklistHistoryQuery.data ?? [])
                .filter((x) => {
                  if (!checklistHistoryKey) return true;
                  return (x.detail ?? "").includes(`checklistKey=${checklistHistoryKey}`);
                })
                .map((x) => (
                  <div key={x.id} className="rounded border bg-white p-2">
                    <div className="text-xs text-slate-500">{x.created_at ? new Date(x.created_at).toLocaleString("en-MY") : ""}</div>
                    <div className="text-sm text-slate-900 font-medium">{x.action}</div>
                    {x.detail ? <div className="text-xs text-slate-600 break-words mt-1">{x.detail}</div> : null}
                  </div>
                ))}
              {(checklistHistoryQuery.data ?? []).length === 0 ? (
                <div className="text-sm text-slate-500 py-6">No checklist events.</div>
              ) : null}
            </div>
          )}
          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={() => { setChecklistHistoryOpen(false); setChecklistHistoryKey(null); }}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
