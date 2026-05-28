import { useEffect, useMemo, useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { FileText, Upload, Trash2, Download, Plus, ChevronUp, ChevronDown, X, Sparkles, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch as ToggleSwitch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { isFirmDocumentTypeLetterLike } from "@/lib/documents/letterLike";
import { DOCUMENT_TYPE_LABELS, normalizeDocumentType } from "@workspace/documents-registry";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson, apiRequest } from "@/lib/api-client";
import { downloadBlob, downloadFromApi } from "@/lib/download";
import { toastError } from "@/lib/toast-error";
import { printWordBlob } from "@/lib/documents/BrowserPrinter";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { getGetCaseWorkflowQueryKey, getListCasesQueryKey } from "@workspace/api-client-react";
import { validateUploadFile } from "@/lib/upload-validation";
import { TemplateFolderPicker, type TemplateFolderPickerFolder, type TemplateFolderPickerTemplate } from "@/components/documents/TemplateFolderPicker";
import { createGenerationJob, getGenerationJob, type NormalizedGenerationJob } from "@/lib/document-generation-client";
import { blocksTemplateGenerate, isTemplateFileReadinessKnown, isTemplateFileReady, templateFileReadinessLabel } from "@/lib/template-readiness";

function docTypeLabel(dt: string): string {
  return (DOCUMENT_TYPE_LABELS as Record<string, string>)[dt] ?? dt;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function todayYmdLocal(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}-${mm}-${dd}`;
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

type ApplicabilityStatus = "applicable" | "warning" | "not_applicable";
type ReadinessStatus =
  | "ready"
  | "missing_data"
  | "missing_file"
  | "missing_version"
  | "storage_unavailable"
  | "permission_error"
  | "incomplete";

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
  applicability: { status: ApplicabilityStatus; reasons: string[]; matchedRulesCount?: number; failedRulesCount?: number; manuallyOverridable?: boolean };
  readiness: { status: ReadinessStatus; missing: Array<{ code: string; message: string }> } | null;
  checklistResult?: {
    checklistStatus: "ready" | "warning" | "blocked";
    totalItems: number;
    passedItems: number;
    missingRequiredItems: number;
    warningItems: number;
    manuallyOverridable: boolean;
    items: Array<{ id: string; label: string; type: string; passed: boolean; required: boolean; message: string; source: string; checkedBy?: number | null; checkedAt?: string | null }>;
  } | null;
  dataReadiness?: { status: "ready" | "missing_data" | "unknown"; missing: string[] };
  debug?: Record<string, unknown>;
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
  const [templateSourceFilter, setTemplateSourceFilter] = useState<"all" | "firm">("all");
  const [templateApplicabilityFilter, setTemplateApplicabilityFilter] = useState<"all" | "applicable" | "warning" | "not_applicable">("all");
  const [selectedLetterheadId, setSelectedLetterheadId] = useState<string>("");
  const [documentName, setDocumentName] = useState("");
  const documentNameToSend = documentName.trim() ? documentName.trim() : undefined;
  const [extractionOpen, setExtractionOpen] = useState(false);
  const [extractionDoc, setExtractionDoc] = useState<CaseDocument | null>(null);
  const [extractionLoading, setExtractionLoading] = useState(false);
  const [extractionOverrideExisting, setExtractionOverrideExisting] = useState(false);
  const [extractionData, setExtractionData] = useState<null | { job: any; result: any; suggestions: any[] }>(null);
  const [extractionSelectedIds, setExtractionSelectedIds] = useState<Set<number>>(new Set());
  const [extractionPreview, setExtractionPreview] = useState<null | { previews: any[] }>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadPreviewFileName, setUploadPreviewFileName] = useState("");
  const [uploadType, setUploadType] = useState("other");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [oneClickGeneratingTemplateId, setOneClickGeneratingTemplateId] = useState<number | null>(null);
  const [batchGenerateResult, setBatchGenerateResult] = useState<NormalizedGenerationJob | null>(null);
  const [selectedChecklistKeys, setSelectedChecklistKeys] = useState<Set<string>>(new Set());
  const [batchLoopGenerating, setBatchLoopGenerating] = useState(false);
  const [batchLoopProgress, setBatchLoopProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });

  const [selectedDocIds, setSelectedDocIds] = useState<Set<number>>(new Set());
  const [isBatchExporting, setIsBatchExporting] = useState(false);
  const [downloadingDocId, setDownloadingDocId] = useState<number | null>(null);
  const [enterpriseDialogOpen, setEnterpriseDialogOpen] = useState(false);
  const [enterpriseSelectedTemplateIds, setEnterpriseSelectedTemplateIds] = useState<Set<number>>(() => new Set());
  const [enterpriseMode, setEnterpriseMode] = useState<"download" | "print">("download");
  const [enterpriseCopies, setEnterpriseCopies] = useState("1");
  const [enterpriseBusy, setEnterpriseBusy] = useState(false);


  const canGenerate = hasPermission(user, "documents", "generate");
  const canExport = hasPermission(user, "documents", "export");
  const canDelete = hasPermission(user, "documents", "delete");
  const canCreate = hasPermission(user, "documents", "create");
  const canBypassApplicability = hasPermission(user, "documents", "update");
  const [selectedClauses, setSelectedClauses] = useState<Array<{ scope: "firm" | "platform"; id: number; includeTitle: boolean }>>([]);
  const [clauseQuery, setClauseQuery] = useState("");
  const [clauseIncludeTitleDefault, setClauseIncludeTitleDefault] = useState(true);

  const [checklistFilter, setChecklistFilter] = useState<"all" | "required" | "missing" | "completed" | "waived" | "warning" | "not_applicable">("all");
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

  const enterpriseFoldersQuery = useQuery<TemplateFolderPickerFolder[]>({
    queryKey: ["case-documents", caseId, "enterprise", "folders"],
    queryFn: () => apiFetchJson<TemplateFolderPickerFolder[]>("/firm-document-folders"),
    enabled: enterpriseDialogOpen,
    retry: false,
  });
  const enterpriseTemplatesQuery = useQuery<TemplateFolderPickerTemplate[]>({
    queryKey: ["case-documents", caseId, "enterprise", "templates"],
    queryFn: () => apiFetchJson<TemplateFolderPickerTemplate[]>("/document-templates?templateCapable=true&kind=template"),
    enabled: enterpriseDialogOpen,
    retry: false,
  });
  const enterpriseFolders = enterpriseFoldersQuery.data ?? [];
  const enterpriseTemplates = enterpriseTemplatesQuery.data ?? [];

  const checklistQuery = useQuery<ChecklistResponse>({
    queryKey: ["case-documents-checklist", caseId, showAllTemplates],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/documents/checklist${showAllTemplates && canBypassApplicability ? "?includeAll=1" : ""}`, { signal }),
    enabled: viewTab === "checklist" || generateDialogOpen,
    retry: false,
  });
  const caseData = checklistQuery.data?.case;
  const templateNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const sec of checklistQuery.data?.sections ?? []) {
      for (const it of sec.items ?? []) {
        if (it.kind !== "template") continue;
        if (typeof it.templateId !== "number") continue;
        m.set(it.templateId, String(it.name ?? ""));
      }
    }
    return m;
  }, [checklistQuery.data]);

  const modalTemplateIds = useMemo(() => {
    if (!generateDialogOpen) return [] as number[];
    const items = (checklistQuery.data?.sections ?? []).flatMap((s) => s.items ?? []);
    const filtered = items.filter((it) => {
      if (it.kind !== "template") return false;
      if (typeof it.templateId !== "number") return false;
      if (!showAllTemplates && it.applicability?.status === "not_applicable") return false;
      if (templateSourceFilter !== "all" && it.source !== templateSourceFilter) return false;
      if (templateApplicabilityFilter !== "all" && (it.applicability?.status ?? "applicable") !== templateApplicabilityFilter) return false;
      return true;
    });
    return Array.from(new Set(filtered.map((it) => Number(it.templateId)).filter((n) => Number.isFinite(n) && n > 0)));
  }, [generateDialogOpen, checklistQuery.data, showAllTemplates, templateSourceFilter, templateApplicabilityFilter]);

  const preflightQuery = useQuery<{ caseId: number; items: any[] }>({
    queryKey: ["case-documents-preflight", caseId, modalTemplateIds.join(",")],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/documents/preflight`, {
      method: "POST",
      timeoutMs: 15000,
      signal,
      body: JSON.stringify({ templateIds: modalTemplateIds }),
    }),
    enabled: generateDialogOpen && modalTemplateIds.length > 0,
    retry: false,
  });

  const preflightByTemplateId = useMemo(() => {
    const m = new Map<number, any>();
    for (const it of Array.isArray(preflightQuery.data?.items) ? preflightQuery.data.items : []) {
      const id = typeof it?.templateId === "number" ? it.templateId : Number(it?.templateId);
      if (!Number.isFinite(id)) continue;
      m.set(id, it);
    }
    return m;
  }, [preflightQuery.data]);

  type ClauseListItem = {
    id: number;
    scope: "firm" | "platform";
    clause_code: string;
    title: string;
    category: string;
    language: string;
    status: string;
    tags: string[];
    applicable: boolean;
  };

  const clausesQuery = useQuery<ClauseListItem[]>({
    queryKey: ["clauses", caseId, clauseQuery],
    queryFn: ({ signal }) => apiFetchJson(`/clauses?scope=all&status=active&caseId=${caseId}&q=${encodeURIComponent(clauseQuery)}`, { signal }),
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

  function labelFromKey(key: string): string {
    const pretty = String(key ?? "")
      .replace(/_raw$/, "")
      .replace(/_long$/, "")
      .replace(/_rm$/, " RM")
      .replace(/_/g, " ")
      .trim();
    return pretty.length ? pretty.replace(/\b\w/g, (m) => m.toUpperCase()) : key;
  }

  async function generateAndDownloadBlind(item: ChecklistItem): Promise<void> {
    if (!canGenerate) return;
    if (item.kind !== "template" || typeof item.templateId !== "number") return;
    if (item.source !== "firm") return;
    const templateId = Number(item.templateId);
    if (!Number.isFinite(templateId) || templateId <= 0) return;

    setOneClickGeneratingTemplateId(templateId);
    let pollId: number | null = null;
    const startedAt = Date.now();
    const maxPollMs = 120_000;
    try {
      const created = await createGenerationJob({
        caseIds: [caseId],
        templateIds: [templateId],
        config: { action: "download" },
        validate: true,
      });
      const jobId = created.jobId;

      const pollOnce = async (): Promise<boolean> => {
        if (Date.now() - startedAt > maxPollMs) {
          throw new Error(`Generation still running. Please refresh later. Job ${jobId}`);
        }
        const job = await getGenerationJob(jobId);
        setBatchGenerateResult(job);
        const st = String(job.status ?? "");
        if (st === "completed" || st === "completed_with_errors" || st === "completed-with-errors") {
          await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
          await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
          const fileName = job.downloadFileName || "document.pdf";
          if (!job.downloadObjectPath) {
            throw new Error("Generation completed but no downloadable output was created. Please check failed item diagnostics.");
          }
          await downloadFromApi(`/documents/jobs/${jobId}/download`, fileName);
          toast({ title: "Download started" });
          return true;
        }
        if (st === "failed") {
          const summary = job.errorSummary || "Generation failed";
          const firstFailed = job.items.find((it) => String(it.status ?? "") === "failed") ?? null;
          const code = firstFailed?.errorCode ? String(firstFailed.errorCode) : "";
          const msg = firstFailed?.errorMessage ? String(firstFailed.errorMessage) : "";
          const detail = code && msg ? `${code}: ${msg}` : msg || code;
          throw new Error(detail ? `${summary}: ${detail}` : summary);
        }
        return false;
      };

      const done = await pollOnce();
      if (done) return;

      await new Promise<void>((resolve, reject) => {
        let inFlight = false;
        pollId = window.setInterval(() => {
          if (inFlight) return;
          inFlight = true;
          pollOnce()
            .then((ok) => {
              if (!ok) return;
              if (pollId) {
                window.clearInterval(pollId);
                pollId = null;
              }
              resolve();
            })
            .catch((e) => {
              if (pollId) {
                window.clearInterval(pollId);
                pollId = null;
              }
              reject(e);
            })
            .finally(() => {
              inFlight = false;
            });
        }, 2000);
      });
    } catch (err) {
      const failures =
        err && typeof err === "object" && "data" in (err as any) && Array.isArray((err as any).data?.failures)
          ? ((err as any).data.failures as any[])
          : null;
      if (failures && failures.length > 0) {
        const first = failures[0] ?? {};
        const code = typeof first.errorCode === "string" ? first.errorCode : typeof (err as any).code === "string" ? (err as any).code : "PRECHECK_FAILED";
        const msg = typeof first.errorMessage === "string" ? first.errorMessage : "Preflight failed";
        toast({ title: "FA", description: `${msg} (${code})`, variant: "destructive" });
      } else {
        toastError(toast, err, "Generation failed");
      }
    } finally {
      if (pollId) window.clearInterval(pollId);
      setOneClickGeneratingTemplateId(null);
    }
  }

  function toggleChecklistSelection(it: ChecklistItem) {
    if (it.kind !== "template" || it.source !== "firm" || typeof it.templateId !== "number") return;
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

  async function openBatchVariableChecklist(items: ChecklistItem[]) {
    if (!canGenerate) return;
    const templateIds = items
      .filter((it) => it.kind === "template" && it.source === "firm" && typeof it.templateId === "number")
      .map((it) => Number(it.templateId))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!templateIds.length) return;

    setBatchLoopGenerating(true);
    setBatchLoopProgress({ current: 0, total: 1 });
    let pollId: number | null = null;
    const startedAt = Date.now();
    const maxPollMs = 120_000;
    try {
      const created = await createGenerationJob({
        caseIds: [caseId],
        templateIds,
        config: { action: "download" },
        validate: true,
      });
      const jobId = created.jobId;

      const pollOnce = async (): Promise<boolean> => {
        if (Date.now() - startedAt > maxPollMs) {
          throw new Error(`Generation still running. Please refresh later. Job ${jobId}`);
        }
        const job = await getGenerationJob(jobId);
        setBatchGenerateResult(job);
        const st = String(job.status ?? "");
        if (st === "completed" || st === "completed_with_errors" || st === "completed-with-errors") {
          await qc.invalidateQueries({ queryKey: ["case-documents", caseId] });
          await qc.invalidateQueries({ queryKey: ["case-documents-checklist", caseId] });
          const fileName = job.downloadFileName || "documents.zip";
          if (!job.downloadObjectPath) {
            throw new Error("Generation completed but no downloadable output was created. Please check failed item diagnostics.");
          }
          await downloadFromApi(`/documents/jobs/${jobId}/download`, fileName);
          toast({ title: "Downloaded" });
          return true;
        }
        if (st === "failed") {
          const summary = job.errorSummary || "Generation failed";
          const firstFailed = job.items.find((it) => String(it.status ?? "") === "failed") ?? null;
          const code = firstFailed?.errorCode ? String(firstFailed.errorCode) : "";
          const msg = firstFailed?.errorMessage ? String(firstFailed.errorMessage) : "";
          const detail = code && msg ? `${code}: ${msg}` : msg || code;
          throw new Error(detail ? `${summary}: ${detail}` : summary);
        }
        return false;
      };

      const done = await pollOnce();
      if (done) return;

      await new Promise<void>((resolve, reject) => {
        let inFlight = false;
        pollId = window.setInterval(() => {
          if (inFlight) return;
          inFlight = true;
          pollOnce()
            .then((ok) => {
              if (!ok) return;
              if (pollId) {
                window.clearInterval(pollId);
                pollId = null;
              }
              resolve();
            })
            .catch((e) => {
              if (pollId) {
                window.clearInterval(pollId);
                pollId = null;
              }
              reject(e);
            })
            .finally(() => {
              inFlight = false;
            });
        }, 2000);
      });
    } catch (err) {
      const failures =
        err && typeof err === "object" && "data" in (err as any) && Array.isArray((err as any).data?.failures)
          ? ((err as any).data.failures as any[])
          : null;
      if (failures && failures.length > 0) {
        const first = failures[0] ?? {};
        const code = typeof first.errorCode === "string" ? first.errorCode : typeof (err as any).code === "string" ? (err as any).code : "PRECHECK_FAILED";
        const msg = typeof first.errorMessage === "string" ? first.errorMessage : "Preflight failed";
        toast({ title: "FA", description: `${msg} (${code})`, variant: "destructive" });
      } else {
        toastError(toast, err, "Generation failed");
      }
    } finally {
      if (pollId) window.clearInterval(pollId);
      setBatchLoopGenerating(false);
      setBatchLoopProgress({ current: 0, total: 0 });
    }
  }

  async function handleBatchGenerate() {
    const keys = selectedChecklistKeys;
    if (!canGenerate || keys.size === 0) return;
    const allItems = (checklistQuery.data?.sections ?? []).flatMap((s) => s.items ?? []);
    const selected = allItems
      .filter((it) => it.kind === "template" && it.source === "firm" && typeof it.templateId === "number")
      .filter((it) => keys.has(it.checklistKey));
    if (selected.length === 0) return;
    await openBatchVariableChecklist(selected);
  }

  async function handleBatchExport() {
    const ids = Array.from(selectedDocIds);
    if (!canExport || ids.length === 0) return;
    setIsBatchExporting(true);
    try {
      const result = await apiFetchJson<{ jobId: string; downloadPath?: string; downloadFileName?: string }>(`/cases/${caseId}/documents/batch-export`, {
        method: "POST",
        body: JSON.stringify({ documentIds: ids }),
      });
      const downloadPath = result.downloadPath ?? `/document-batch-jobs/${result.jobId}/download`;
      const blob = await apiFetchBlob(downloadPath);
      downloadBlob(blob, result.downloadFileName || `case-${caseId}-documents.zip`);
      setSelectedDocIds(new Set());
      toast({ title: "Export ready", description: `Job ${result.jobId}` });
    } catch (err) {
      toastError(toast, err, "Batch export failed");
    } finally {
      setIsBatchExporting(false);
    }
  }

  async function handleEnterpriseGenerate(): Promise<void> {
    if (!canGenerate) return;
    const templateIds = Array.from(enterpriseSelectedTemplateIds);
    if (templateIds.length === 0) return;
    setEnterpriseBusy(true);
    let pollId: any = null;
    try {
      const created = await apiFetchJson<{ jobId: string; downloadUrl?: string }>(`/cases/bulk/generate-documents-zip`, {
        method: "POST",
        timeoutMs: 15000,
        body: JSON.stringify({
          caseIds: [caseId],
          templateIds,
          actionType: enterpriseMode,
          printCopies: enterpriseMode === "print" ? Number(enterpriseCopies || 1) : undefined,
        }),
      });
      const jobId = typeof created?.jobId === "string" ? created.jobId : "";
      if (!jobId) throw new Error("Missing jobId");
      const downloadUrl = typeof created?.downloadUrl === "string" ? created.downloadUrl : `/documents/jobs/${jobId}/download`;

      const pollOnce = async (): Promise<boolean> => {
        const job = await getGenerationJob(jobId);
        setBatchGenerateResult(job);
        const status = typeof job.status === "string" ? job.status : "";
        if (status === "completed") {
          const fileName = job.downloadFileName || (enterpriseMode === "print" ? "system-print.pdf" : "document-automation.zip");
          if (!job.downloadObjectPath) {
            throw new Error("Generation completed but no downloadable output was created. Please check failed item diagnostics.");
          }

          if (enterpriseMode === "print") {
            const blob = await apiFetchBlob(downloadUrl);
            const url = URL.createObjectURL(blob);
            const iframe = document.createElement("iframe");
            iframe.style.position = "fixed";
            iframe.style.right = "0";
            iframe.style.bottom = "0";
            iframe.style.width = "0";
            iframe.style.height = "0";
            iframe.src = url;
            iframe.onload = () => {
              try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch {}
              setTimeout(() => { URL.revokeObjectURL(url); iframe.remove(); }, 60000);
            };
            document.body.appendChild(iframe);
            toast({ title: "Printable PDF ready" });
          } else {
            await downloadFromApi(downloadUrl, fileName || "document-automation.zip");
            toast({ title: "Download started" });
          }
          return true;
        }
        if (status === "failed") {
          const summary = job.errorSummary || "Generation failed";
          const firstFailed = job.items.find((it) => String(it.status ?? "") === "failed") ?? null;
          const code = firstFailed?.errorCode ? String(firstFailed.errorCode) : "";
          const msg = firstFailed?.errorMessage ? String(firstFailed.errorMessage) : "";
          const detail = code && msg ? `${code}: ${msg}` : msg || code;
          throw new Error(detail ? `${summary}: ${detail}` : summary);
        }
        return false;
      };

      const done = await pollOnce();
      if (!done) {
        await new Promise<void>((resolve, reject) => {
          pollId = window.setInterval(() => {
            pollOnce()
              .then((ok) => {
                if (!ok) return;
                if (pollId) {
                  window.clearInterval(pollId);
                  pollId = null;
                }
                resolve();
              })
              .catch((e) => {
                if (pollId) {
                  window.clearInterval(pollId);
                  pollId = null;
                }
                reject(e);
              });
          }, 2000);
        });
      }

      setEnterpriseDialogOpen(false);
      setEnterpriseSelectedTemplateIds(new Set());
    } catch (err) {
      toastError(toast, err, enterpriseMode === "print" ? "Print failed" : "Generate failed");
    } finally {
      if (pollId) {
        try { window.clearInterval(pollId); } catch {}
      }
      setEnterpriseBusy(false);
    }
  }

  function closeGenerateDialog() {
    setGenerateDialogOpen(false);
    setDocumentName("");
    setSelectedLetterheadId("");
    setShowAllTemplates(false);
    setTemplateSourceFilter("all");
    setTemplateApplicabilityFilter("all");
  }

  function ensureValidUpload(file: File): boolean {
    const v = validateUploadFile(file);
    if (!v.ok) {
      toast({ title: "Invalid file", description: v.message, variant: "destructive" });
      return false;
    }
    return true;
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
    if (!ensureValidUpload(selectedFile)) return;
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
      if (!ensureValidUpload(file)) return;
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
        const ext = file.name.includes(".") ? file.name.split(".").pop() || "pdf" : "pdf";
        const naming = await apiFetchJson<{ fileName: string }>(`/cases/${caseId}/documents/filename-preview`, {
          method: "POST",
          body: JSON.stringify(
            checklistUploadTarget.kind === "template" && checklistUploadTarget.source === "firm" && typeof checklistUploadTarget.templateId === "number"
              ? { templateId: checklistUploadTarget.templateId, documentName: checklistUploadTarget.name, originalFileName: file.name, fallbackExt: ext }
              : { documentName: checklistUploadTarget.name, originalFileName: file.name, fallbackExt: ext }
          ),
        });
        await apiFetchJson(`/cases/${caseId}/documents/checklist/items/${encodeURIComponent(checklistUploadTarget.checklistKey)}/upload`, {
          method: "POST",
          body: JSON.stringify({
            objectPath: stored,
            fileName: naming.fileName,
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

  async function openExtraction(doc: CaseDocument): Promise<void> {
    setExtractionDoc(doc);
    setExtractionOpen(true);
    setExtractionLoading(true);
    setExtractionData(null);
    setExtractionSelectedIds(new Set());
    try {
      const data = await apiFetchJson<{ job: any; result: any; suggestions: any[] }>(`/cases/${caseId}/documents/${doc.id}/extraction/latest`);
      setExtractionData(data);
    } catch (err) {
      toastError(toast, err, "Failed to load extraction");
    } finally {
      setExtractionLoading(false);
    }
  }

  async function runExtraction(): Promise<void> {
    if (!extractionDoc) return;
    setExtractionLoading(true);
    try {
      const data = await apiFetchJson<{ job: any; result: any; suggestions: any[] }>(`/cases/${caseId}/documents/${extractionDoc.id}/extraction/run`, { method: "POST" });
      setExtractionData(data);
      setExtractionSelectedIds(new Set());
    } catch (err) {
      toastError(toast, err, "Extraction failed");
    } finally {
      setExtractionLoading(false);
    }
  }

  async function applyExtractionSelected(): Promise<void> {
    const jobId = extractionData?.job?.id;
    if (!jobId) return;
    const ids = Array.from(extractionSelectedIds.values());
    if (ids.length === 0) return;
    setExtractionLoading(true);
    try {
      await apiFetchJson(`/extractions/jobs/${jobId}/apply`, { method: "POST", body: JSON.stringify({ suggestionIds: ids, overrideExisting: extractionOverrideExisting }) });
      const data = await apiFetchJson<{ job: any; result: any; suggestions: any[] }>(`/cases/${caseId}/documents/${extractionDoc!.id}/extraction/latest`);
      setExtractionData(data);
      setExtractionSelectedIds(new Set());
      toast({ title: "Applied selected suggestions" });
    } catch (err) {
      toastError(toast, err, "Apply failed");
    } finally {
      setExtractionLoading(false);
    }
  }

  async function refreshExtractionPreview(nextSelected?: Set<number>, nextOverride?: boolean): Promise<void> {
    const jobId = extractionData?.job?.id;
    if (!jobId) { setExtractionPreview(null); return; }
    const ids = Array.from((nextSelected ?? extractionSelectedIds).values());
    if (ids.length === 0) { setExtractionPreview(null); return; }
    try {
      const resp = await apiFetchJson<{ ok: boolean; previews: any[] }>(`/extractions/jobs/${jobId}/preview-apply`, { method: "POST", body: JSON.stringify({ suggestionIds: ids, overrideExisting: Boolean(nextOverride ?? extractionOverrideExisting) }) });
      setExtractionPreview({ previews: resp.previews ?? [] });
    } catch {
      setExtractionPreview(null);
    }
  }

  async function acceptSuggestion(jobId: number, suggestionId: number): Promise<void> {
    setExtractionLoading(true);
    try {
      await apiFetchJson(`/extractions/jobs/${jobId}/suggestions/${suggestionId}/accept`, { method: "POST", body: JSON.stringify({ overrideExisting: extractionOverrideExisting }) });
      const data = await apiFetchJson<{ job: any; result: any; suggestions: any[] }>(`/cases/${caseId}/documents/${extractionDoc!.id}/extraction/latest`);
      setExtractionData(data);
    } catch (err) {
      toastError(toast, err, "Accept failed");
    } finally {
      setExtractionLoading(false);
    }
  }

  async function rejectSuggestion(jobId: number, suggestionId: number): Promise<void> {
    setExtractionLoading(true);
    try {
      await apiFetchJson(`/extractions/jobs/${jobId}/suggestions/${suggestionId}/reject`, { method: "POST" });
      const data = await apiFetchJson<{ job: any; result: any; suggestions: any[] }>(`/cases/${caseId}/documents/${extractionDoc!.id}/extraction/latest`);
      setExtractionData(data);
    } catch (err) {
      toastError(toast, err, "Reject failed");
    } finally {
      setExtractionLoading(false);
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
  if ((viewTab === "checklist" || generateDialogOpen) && !checklistQuery.isLoading && !checklistQuery.isError && !caseData) {
    console.error("!!! FRONTEND_DEBUG: Case Data is null/undefined");
    return <div className="p-4">資料載入中或缺失...</div>;
  }

  return (
    <div className="space-y-6">
      {batchLoopGenerating ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-sm font-medium text-slate-900">
            正在生成 {batchLoopProgress.current}/{batchLoopProgress.total} 份文件...
          </div>
          <div className="mt-2">
            <Progress value={batchLoopProgress.total ? (batchLoopProgress.current / batchLoopProgress.total) * 100 : 5} />
          </div>
        </div>
      ) : null}
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
              variant="outline"
              onClick={() => setEnterpriseDialogOpen(true)}
              disabled={!canGenerate}
            >
              Batch Download / Print
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
                        className="h-8 w-8 text-slate-400 hover:text-slate-700"
                        onClick={() => openExtraction(doc)}
                        title="Extract data"
                      >
                        <Sparkles className="w-4 h-4" />
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
                          <SelectItem value="warning">With warnings</SelectItem>
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
                        disabled={!canGenerate || selectedChecklistKeys.size === 0 || batchLoopGenerating}
                        className="gap-1.5"
                      >
                        <Plus className="w-4 h-4" />
                        {batchLoopGenerating ? "Generating..." : "Batch Generate"}
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
                      <div className="text-sm font-medium text-slate-900">Last generation job: {batchGenerateResult.jobId}</div>
                      <div className="mt-1 text-xs text-slate-600">
                        {String(batchGenerateResult.status ?? "pending")} · {batchGenerateResult.successCount}/{batchGenerateResult.totalCount} success · {batchGenerateResult.failedCount} failed · {batchGenerateResult.pendingCount} pending
                      </div>
                      {batchGenerateResult.errorSummary && (
                        <div className="mt-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
                          {batchGenerateResult.errorSummary}
                        </div>
                      )}
                      {batchGenerateResult.status === "completed" && !batchGenerateResult.downloadObjectPath && (
                        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                          Generation completed but no downloadable output was created. Please check failed item diagnostics.
                        </div>
                      )}
                      <div className="mt-2 space-y-1">
                        {batchGenerateResult.items.filter((x) => x.status === "failed").length === 0 ? (
                          <div className="text-sm text-emerald-700">All items succeeded.</div>
                        ) : (
                          batchGenerateResult.items
                            .filter((x) => x.status === "failed")
                            .slice(0, 50)
                            .map((x, idx) => {
                              const templateId = typeof x.templateId === "number" ? x.templateId : null;
                              const name = templateId ? templateNameById.get(templateId) : null;
                              const diag = asRecord(x.diagnostic) ?? {};
                              const missing = diag["missingRequiredVariables"];
                              const missingList = Array.isArray(missing)
                                ? missing.map((m) => (typeof m === "string" ? m : null)).filter((m): m is string => Boolean(m))
                                : [];
                              return (
                                <div key={`${x.id ?? idx}`} className="text-sm text-slate-700 break-words">
                                  {templateId ? `Template #${templateId}` : "Template"}{name ? ` (${name})` : ""}: {String(x.errorCode ?? "")} {String(x.errorMessage ?? "")}
                                  {missingList.length > 0 ? ` | Missing variables: ${missingList.join(", ")}` : ""}
                                </div>
                              );
                            })
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
                            const applicable = it.applicability?.status !== "not_applicable" && it.status !== "not_applicable";
                            const missing = it.isRequired && applicable && !["generated", "uploaded", "received", "completed", "waived"].includes(it.status);
                            if (checklistFilter === "all") return true;
                            if (checklistFilter === "required") return it.isRequired && applicable;
                            if (checklistFilter === "missing") return missing;
                            if (checklistFilter === "completed") return it.status === "completed";
                            if (checklistFilter === "waived") return it.status === "waived";
                            if (checklistFilter === "warning") return it.applicability?.status === "warning";
                            if (checklistFilter === "not_applicable") return it.status === "not_applicable";
                            return true;
                          })
                          .map((it) => {
                            const applicable = it.applicability?.status !== "not_applicable";
                            const ready = it.readiness?.status === "ready";
                            const latestId = it.latestDocument?.id;
                            const latestDoc = latestId ? documents.find((d) => d.id === latestId) : null;
                            const missing = it.isRequired && applicable && !["generated", "uploaded", "received", "completed", "waived"].includes(it.status);
                            const reason = !applicable
                              ? (it.applicability?.reasons ?? []).join(", ")
                              : it.blocked
                                ? (it.readiness?.missing ?? []).map((m) => m.message).filter(Boolean).slice(0, 3).join(", ")
                                : "";

                            const canSelectForBatch = canGenerate && it.kind === "template" && it.source === "firm";
                            const selected = selectedChecklistKeys.has(it.checklistKey);

                            const generateFinalDisabledReason = (() => {
                              if (it.kind !== "template") return "Template is not generation capable";
                              if (!canGenerate) return "No permission";
                              if (it.source !== "firm") return "Unsupported template source";
                              if (!applicable) return "Not applicable to this case";
                              if (it.readiness && it.readiness.status !== "ready") {
                                if (it.readiness.status === "missing_file") return "Template file missing";
                                if (it.readiness.status === "missing_version") return "Missing published version";
                                if (it.readiness.status === "storage_unavailable") return "Storage unavailable";
                                if (it.readiness.status === "permission_error") return "Storage permission error";
                                const missingMsgs = (it.readiness.missing ?? []).map((m) => String(m.message ?? "").trim()).filter(Boolean);
                                const hasTemplateMissing = (it.readiness.missing ?? []).some((m) => String(m.code ?? "").toLowerCase().includes("template") && String(m.code ?? "").toLowerCase().includes("missing"));
                                const hasStorageMissing = (it.readiness.missing ?? []).some((m) => String(m.code ?? "").toLowerCase().includes("storage") && String(m.code ?? "").toLowerCase().includes("missing"));
                                if (hasStorageMissing) return "Storage object missing";
                                if (hasTemplateMissing) return "Template file missing";
                                if (missingMsgs.length > 0) return `Missing required variables: ${missingMsgs.slice(0, 3).join(", ")}${missingMsgs.length > 3 ? "..." : ""}`;
                                return "Missing required variables";
                              }
                              if (it.blocked) return "Missing required variables";
                              return "";
                            })();

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
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", it.source === "firm" ? "bg-slate-100 text-slate-700" : "bg-slate-100 text-slate-700")}>
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
                                      {it.applicability?.status === "warning" ? "Warning" : applicable ? "Applicable" : "Not applicable"}
                                    </span>
                                    {it.checklistResult ? (
                                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", it.checklistResult.checklistStatus === "ready" ? "bg-emerald-50 text-emerald-700" : it.checklistResult.checklistStatus === "warning" ? "bg-amber-50 text-amber-800" : "bg-rose-50 text-rose-700")}>
                                        Checklist {it.checklistResult.checklistStatus}
                                      </span>
                                    ) : null}
                                    {it.readiness ? (
                                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800")}>
                                        {ready
                                          ? "Ready"
                                          : it.readiness.status === "missing_file" ? "Missing template file"
                                            : it.readiness.status === "missing_version" ? "Missing published version"
                                              : it.readiness.status === "storage_unavailable" ? "Storage unavailable"
                                                : it.readiness.status === "permission_error" ? "Storage permission error"
                                                  : (it.readiness?.status || "Incomplete")}
                                      </span>
                                    ) : null}
                                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium capitalize", statusTone)}>
                                      {it.status}
                                    </span>
                                  </div>
                                  {reason ? <div className="mt-1 text-xs text-slate-600 break-words">{reason}</div> : null}
                                  {it.checklistResult ? <div className="mt-1 text-xs text-slate-600">{it.checklistResult.passedItems}/{it.checklistResult.totalItems} passed, missing {it.checklistResult.missingRequiredItems}{it.checklistResult.manuallyOverridable ? ", override available" : ""}</div> : null}
                                  {updatedLabel ? <div className="mt-1 text-xs text-slate-400">Updated: {updatedLabel}</div> : null}
                                </div>
                                <div className="shrink-0 flex flex-col items-end gap-2">
                                  <div className="flex items-center gap-2 flex-wrap justify-end">
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
                                      <div className="flex flex-col items-end gap-1">
                                        <Button
                                          size="sm"
                                          className="gap-2"
                                          onClick={() => generateAndDownloadBlind(it)}
                                          disabled={Boolean(generateFinalDisabledReason) || isGenerating || oneClickGeneratingTemplateId === it.templateId}
                                        >
                                          {oneClickGeneratingTemplateId === it.templateId ? (
                                            <>
                                              <Loader2 className="h-4 w-4 animate-spin" />
                                              Generating...
                                            </>
                                          ) : (
                                            "Generate Final"
                                          )}
                                        </Button>
                                        {generateFinalDisabledReason && oneClickGeneratingTemplateId !== it.templateId ? (
                                          <div className="text-[11px] text-slate-500 text-right max-w-56 break-words">{generateFinalDisabledReason}</div>
                                        ) : null}
                                      </div>
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

      <Dialog open={generateDialogOpen} onOpenChange={(v) => { if (!v) closeGenerateDialog(); else setGenerateDialogOpen(true); }}>
        <DialogContent className="w-[95vw] sm:w-[80vw] max-w-[95vw] sm:max-w-[80vw] max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Generate Document from Template</DialogTitle>
            <DialogDescription className="sr-only">Document generation options</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 h-full">
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
                onValueChange={(v) => setTemplateSourceFilter(v === "firm" ? "firm" : "all")}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="firm">Firm</SelectItem>
                </SelectContent>
              </Select>
              <Select value={templateApplicabilityFilter} onValueChange={(v) => setTemplateApplicabilityFilter(v as any)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Show all</SelectItem>
                  <SelectItem value="applicable">Applicable only</SelectItem>
                  <SelectItem value="warning">With warnings</SelectItem>
                  <SelectItem value="not_applicable">Not applicable</SelectItem>
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

            {preflightQuery.isError ? (
              <QueryFallback
                title="Preflight unavailable"
                error={preflightQuery.error}
                onRetry={() => preflightQuery.refetch()}
                isRetrying={preflightQuery.isFetching}
              />
            ) : null}

            <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-slate-200 bg-white">
              {checklistQuery.isLoading ? (
                <div className="text-sm text-slate-500 py-6 text-center">Loading templates…</div>
              ) : checklistQuery.isError ? (
                <QueryFallback title="Templates unavailable" error={checklistQuery.error} onRetry={() => checklistQuery.refetch()} isRetrying={checklistQuery.isFetching} />
              ) : (
                <div className="p-3 space-y-4">
                  {(checklistQuery.data?.sections ?? []).map((sec) => {
                    const filtered = (sec.items ?? []).filter((it) => {
                      if (it.kind !== "template") return false;
                      if (!showAllTemplates && it.applicability?.status === "not_applicable") return false;
                      if (templateSourceFilter !== "all" && it.source !== templateSourceFilter) return false;
                      if (templateApplicabilityFilter !== "all" && (it.applicability?.status ?? "applicable") !== templateApplicabilityFilter) return false;
                      return true;
                    });
                    if (filtered.length === 0) return null;
                    return (
                      <div key={sec.section} className="space-y-2">
                        <div className="text-xs font-semibold text-slate-700">{sec.section}</div>
                        <div className="rounded-md border border-slate-200 divide-y divide-slate-100 bg-white">
                          {filtered.map((it) => {
                            const overridable = Boolean(it.applicability?.status === "not_applicable" && it.applicability?.manuallyOverridable && canBypassApplicability && showAllTemplates);
                            const applicable = it.applicability?.status !== "not_applicable" || overridable;
                            const pre = typeof it.templateId === "number" ? preflightByTemplateId.get(it.templateId) : null;
                            const fileStatus = String(pre?.templateFile?.status ?? "");
                            const converterStatus = String(pre?.converter?.status ?? "");
                            const dataStatus = String(pre?.data?.status ?? "");
                            const missingVars = Array.isArray(pre?.data?.missingVariables)
                              ? pre.data.missingVariables.map((x: any) => String(x)).filter(Boolean)
                              : [];
                            const fileReady = fileStatus === "ready";
                            const dataReady = dataStatus === "ready" || dataStatus === "missing_variables" || dataStatus === "";
                            const converterReady = converterStatus === "ready" || converterStatus === "";
                            const fileLabel =
                              preflightQuery.isError ? "Error"
                                : fileStatus === "ready" ? "Ready"
                                  : fileStatus === "missing" ? "Missing template file"
                                    : fileStatus === "read_failed" ? "Storage read failed"
                                      : preflightQuery.isFetching ? "Checking..." : "Unknown";
                            const dataLabel =
                              preflightQuery.isError ? "Error"
                                : !converterReady ? "PDF_CONVERSION_UNAVAILABLE"
                                  : dataStatus === "missing_variables"
                                    ? `Missing variables (will be blank): ${missingVars.slice(0, 3).join(", ")}${missingVars.length > 3 ? "..." : ""}`
                                    : dataReady ? "Ready"
                                      : preflightQuery.isFetching ? "Checking..." : "Unknown";
                            const generateFinalDisabledReason = (() => {
                              if (it.kind !== "template") return "Template is not generation capable";
                              if (!canGenerate) return "No permission";
                              if (it.source !== "firm") return "Unsupported template source";
                              if (!applicable) return (it.applicability?.reasons ?? []).join(", ") || "Not applicable to this case";
                              if (preflightQuery.isError) return "Preflight error";
                              if (!pre) return "Checking...";
                              if (!fileReady) return "Missing template file";
                              if (!converterReady) return "PDF_CONVERSION_UNAVAILABLE";
                              return "";
                            })();
                            return (
                              <div key={`${it.source}-${it.templateId}`} className="px-3 py-2">
                                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)_auto] items-start lg:items-center gap-2 lg:gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-slate-900 truncate" title={it.name}>{it.name}</div>
                                    <div className="mt-1 text-xs text-slate-600 truncate">
                                      {(it.source === "firm" ? "Firm" : it.source)} · {it.documentGroup}
                                    </div>
                                  </div>
                                  <div className="min-w-0">
                                    <div className="text-[11px] text-slate-700 truncate" title={`Template file: ${fileLabel}`}>
                                      Template file: {fileLabel}
                                    </div>
                                    <div className="text-[11px] text-slate-700 truncate" title={`Data: ${dataLabel}`}>
                                      Data: {dataLabel}
                                    </div>
                                    <div className="text-[11px] text-slate-700 truncate">
                                      Output: PDF
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 justify-start lg:justify-end flex-wrap">
                                    <Button
                                      size="sm"
                                      onClick={() => generateAndDownloadBlind(it)}
                                      disabled={
                                        !canGenerate
                                        || isGenerating
                                        || it.source !== "firm"
                                        || oneClickGeneratingTemplateId === it.templateId
                                        || Boolean(generateFinalDisabledReason)
                                      }
                                    >
                                      {oneClickGeneratingTemplateId === it.templateId ? "Generating..." : "Generate Final"}
                                    </Button>
                                    {generateFinalDisabledReason ? (
                                      <div className="text-[11px] text-slate-500 max-w-64 break-words">{generateFinalDisabledReason}</div>
                                    ) : null}
                                  </div>
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
                accept=".docx,.doc,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/pdf,image/jpeg,image/png"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  if (!uploadName || !selectedFile) return;
                  try {
                    const resp = await apiFetchJson<{ fileName: string }>(`/cases/${caseId}/documents/filename-preview`, {
                      method: "POST",
                      body: JSON.stringify({
                        documentName: uploadName,
                        originalFileName: selectedFile.name,
                        fallbackExt: "pdf",
                      }),
                    });
                    setUploadPreviewFileName(resp.fileName);
                  } catch (e) {
                    toastError(toast, e, "Preview failed");
                  }
                }}
                disabled={!uploadName || !selectedFile}
              >
                Preview filename
              </Button>
              {uploadPreviewFileName ? (
                <div className="text-xs text-slate-600 break-words text-right min-w-0">{uploadPreviewFileName}</div>
              ) : (
                <div className="text-xs text-slate-400"> </div>
              )}
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

      <Dialog open={extractionOpen} onOpenChange={(v) => { if (!v) { setExtractionOpen(false); setExtractionDoc(null); setExtractionData(null); setExtractionSelectedIds(new Set()); } else setExtractionOpen(true); }}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Extract data (suggestion mode)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm text-slate-700 break-words">
                {extractionDoc ? `${extractionDoc.name} • ${extractionDoc.file_name || ""}` : "No document selected"}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <Checkbox checked={extractionOverrideExisting} onCheckedChange={(v) => { const nv = Boolean(v); setExtractionOverrideExisting(nv); void refreshExtractionPreview(undefined, nv); }} />
                  <span className="text-xs text-slate-600">Override existing values</span>
                </div>
                <Button size="sm" onClick={runExtraction} disabled={!extractionDoc || extractionLoading}>
                  {extractionLoading ? "Working..." : "Run extraction"}
                </Button>
              </div>
            </div>

            {extractionLoading ? (
              <div className="text-sm text-slate-500 py-6">Loading…</div>
            ) : !extractionData?.job ? (
              <div className="text-sm text-slate-500 py-6">No extraction yet. Click “Run extraction”.</div>
            ) : (
              <div className="space-y-3">
                <div className="rounded border bg-white p-3">
                  <div className="text-xs text-slate-500">Job</div>
                  <div className="text-sm text-slate-900">status={String(extractionData.job.status)} • method={String(extractionData.job.extraction_method ?? "")} • guess={String(extractionData.job.document_type_guess ?? "")}</div>
                  {Array.isArray(extractionData.result?.warnings) && extractionData.result.warnings.length ? (
                    <div className="mt-1 text-xs text-amber-700 break-words">{extractionData.result.warnings.join(" | ")}</div>
                  ) : null}
                  {extractionData.result?.structured_result_json ? (
                    <div className="mt-2 text-xs text-slate-600">
                      scannedPdfDetected={String(Boolean((extractionData.result.structured_result_json as any).scannedPdfDetected))} • rasterizedPages={String((extractionData.result.structured_result_json as any).rasterizedPagesCount ?? 0)} • perPageMethod={Array.isArray((extractionData.result.structured_result_json as any).perPageExtractionMethod) ? String(((extractionData.result.structured_result_json as any).perPageExtractionMethod as any[]).join(",")) : ""}
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900">Suggestions</div>
                  <Button size="sm" variant="outline" onClick={applyExtractionSelected} disabled={extractionSelectedIds.size === 0 || extractionLoading || !extractionData.job?.id}>
                    Apply selected ({extractionSelectedIds.size})
                  </Button>
                </div>

                {extractionPreview?.previews?.length ? (
                  <div className="rounded border bg-white p-3 text-xs text-slate-700">
                    <div className="font-medium text-slate-900">Apply summary</div>
                    <div className="mt-1">
                      willApply {extractionPreview.previews.filter((p: any) => p.applied).length} / {extractionPreview.previews.length}
                      {" • "}
                      willSkip {extractionPreview.previews.filter((p: any) => !p.applied).length}
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  {(extractionData.suggestions ?? []).map((s: any) => {
                    const sid = Number(s.id);
                    const checked = extractionSelectedIds.has(sid);
                    const accepted = Boolean(s.accepted_at);
                    const rejected = Boolean(s.rejected_at);
                    const candidates = Array.isArray(s.suggested_target_candidates) ? s.suggested_target_candidates : [];
                    const chosen = s.chosen_target_candidate && typeof s.chosen_target_candidate === "object" ? s.chosen_target_candidate : null;
                    return (
                      <div key={sid} className="rounded border bg-white p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm text-slate-900 break-words">
                              <span className="font-medium">{String(s.field_key)}</span>: {String(s.suggested_value ?? "")}
                            </div>
                            <div className="mt-0.5 text-xs text-slate-500 break-words">
                              conf={String(s.confidence ?? "")} • page={String(s.source_page ?? "")} • target={String(s.target_entity_type ?? "")}
                            </div>
                            {candidates.length ? (
                              <div className="mt-1">
                                <Select
                                  value={chosen ? JSON.stringify(chosen) : JSON.stringify(candidates[0])}
                                  onValueChange={async (v) => {
                                    try {
                                      const next = JSON.parse(v);
                                      await apiFetchJson(`/extractions/jobs/${Number(extractionData.job.id)}/suggestions/${sid}/target`, { method: "POST", body: JSON.stringify({ chosenTargetCandidate: next }) });
                                      const data = await apiFetchJson<{ job: any; result: any; suggestions: any[] }>(`/cases/${caseId}/documents/${extractionDoc!.id}/extraction/latest`);
                                      setExtractionData(data);
                                      await refreshExtractionPreview();
                                    } catch (err) {
                                      toastError(toast, err, "Target update failed");
                                    }
                                  }}
                                >
                                  <SelectTrigger className="h-8 text-xs w-full max-w-sm"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {candidates.map((c: any, idx: number) => (
                                      <SelectItem key={idx} value={JSON.stringify(c)}>{String(c.label ?? c.targetEntityType ?? "")}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : null}
                            {s.source_snippet ? <div className="mt-1 text-xs text-slate-600 break-words">{String(s.source_snippet)}</div> : null}
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => {
                                const next = new Set(extractionSelectedIds);
                                if (Boolean(v)) next.add(sid); else next.delete(sid);
                                setExtractionSelectedIds(next);
                                void refreshExtractionPreview(next);
                              }}
                            />
                            <Button size="sm" variant="outline" onClick={() => acceptSuggestion(Number(extractionData.job.id), sid)} disabled={accepted || extractionLoading}>
                              {accepted ? "Accepted" : "Accept"}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => rejectSuggestion(Number(extractionData.job.id), sid)} disabled={rejected || extractionLoading}>
                              {rejected ? "Rejected" : "Reject"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {(extractionData.suggestions ?? []).length === 0 ? <div className="text-sm text-slate-500 py-6">No suggestions.</div> : null}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button variant="outline" onClick={() => { setExtractionOpen(false); setExtractionDoc(null); setExtractionData(null); setExtractionSelectedIds(new Set()); }}>
                Close
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
              <Input type="file" accept=".docx,.doc,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/pdf,image/jpeg,image/png" onChange={(e) => setChecklistUploadFile(e.target.files?.[0] ?? null)} />
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

      <Dialog open={enterpriseDialogOpen} onOpenChange={setEnterpriseDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Batch Generate (PDF) - Download / Print</DialogTitle>
            <DialogDescription>Select template folders/files. Output is always PDF.</DialogDescription>
          </DialogHeader>

          {enterpriseFoldersQuery.isError || enterpriseTemplatesQuery.isError ? (
            <QueryFallback
              title="Templates unavailable"
              error={enterpriseFoldersQuery.error || enterpriseTemplatesQuery.error}
              onRetry={() => { enterpriseFoldersQuery.refetch(); enterpriseTemplatesQuery.refetch(); }}
              isRetrying={enterpriseFoldersQuery.isFetching || enterpriseTemplatesQuery.isFetching}
            />
          ) : (
            <div className="space-y-3">
              <TemplateFolderPicker
                folders={enterpriseFolders}
                templates={enterpriseTemplates}
                selectedTemplateIds={enterpriseSelectedTemplateIds}
                onChange={setEnterpriseSelectedTemplateIds}
              />
              <div className="flex items-center gap-2">
                <Select value={enterpriseMode} onValueChange={(v) => setEnterpriseMode(v === "print" ? "print" : "download")}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="download">Download ZIP</SelectItem>
                    <SelectItem value="print">System Print</SelectItem>
                  </SelectContent>
                </Select>
                {enterpriseMode === "print" ? (
                  <Input value={enterpriseCopies} onChange={(e) => setEnterpriseCopies(e.target.value)} inputMode="numeric" className="w-[120px]" placeholder="Copies" />
                ) : null}
                <Button
                  onClick={() => handleEnterpriseGenerate()}
                  disabled={enterpriseBusy || enterpriseSelectedTemplateIds.size === 0}
                  className="ml-auto"
                >
                  {enterpriseBusy ? "Generating..." : enterpriseMode === "print" ? "Generate & Print" : "Generate & Download"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
