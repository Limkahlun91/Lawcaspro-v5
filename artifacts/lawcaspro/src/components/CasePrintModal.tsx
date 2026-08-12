import { useEffect, useMemo, useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { downloadBlob } from "@/lib/download";
import { getGenerationJobDownloadManifest, getGenerationJobStatus, runNextGenerationJob } from "@/lib/document-generation-client";
import { printWordBlob } from "@/lib/documents/BrowserPrinter";
import {
  AlertCircle,
  CheckSquare,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  File,
  FileImage,
  FileText,
  Loader2,
  Printer as PrinterIcon,
  Square,
  X as XIcon,
  Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getApiFailureCodeFromError } from "@/lib/api-failure";

type PrintCapability = "printable_pdf" | "printable_image" | "printable_docx" | "unsupported";

type PrimaryItem = {
  id: string;
  source: "primary";
  printKey: string;
  label: string;
  status: "configured" | "missing_template" | "not_applicable";
  documentType: string;
  defaultSelected: boolean;
};

type SupportingCaseItem = {
  id: string;
  supportingDocId: number;
  source: "supporting_case";
  scope: "case";
  caseId: number;
  documentType: string;
  documentName: string;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  fileName: string;
  versionLabel: string | null;
  versionNo: number;
  status: string;
  uploadDate: string | null;
  uploadedBy: number | null;
  remarks: string | null;
  printCapability: PrintCapability;
  defaultSelected: boolean;
};

type SupportingProjectItem = {
  id: string;
  supportingDocId: number;
  source: "supporting_project";
  scope: "project";
  projectId: number | null;
  developerId: number | null;
  phase: string | null;
  documentType: string;
  documentName: string;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  fileName: string;
  versionLabel: string | null;
  versionNo: number;
  status: string;
  uploadDate: string | null;
  uploadedBy: number | null;
  remarks: string | null;
  printCapability: PrintCapability;
  defaultSelected: boolean;
};

type UploadedItem = {
  id: string;
  source: "case_uploaded";
  caseDocumentId: number;
  documentType: string;
  documentName: string;
  mimeType: string | null;
  fileSize: number | null;
  fileName: string;
  uploadDate: string | null;
  status: string;
  printCapability: PrintCapability;
  defaultSelected: boolean;
};

type PrintMetaResponse = {
  ok: boolean;
  caseId: number;
  caseContext: {
    referenceNo: string;
    projectId: number | null;
    developerId: number | null;
    projectName: string | null;
    developerName: string | null;
  };
  sections: {
    primary: { title: string; items: PrimaryItem[] };
    caseSupporting: { title: string; items: SupportingCaseItem[] };
    projectSupporting: { title: string; projectId: number | null; developerId: number | null; items: SupportingProjectItem[] };
    legacyUploaded?: { title: string; items: UploadedItem[] };
  };
};

type PrepareSelectionItem =
  | { kind: "primary_printkey"; printKey: string }
  | { kind: "supporting_case"; supportingDocId: number }
  | { kind: "supporting_project"; supportingDocId: number }
  | { kind: "case_uploaded"; caseDocumentId: number };

type PrepareResponse = {
  ok: boolean;
  mode: "preview" | "print";
  caseId: number;
  manifestItems: Array<{
    itemId: string;
    kind: "primary_printkey" | "supporting_case" | "supporting_project" | "case_uploaded";
    printKey?: string;
    supportingDocId?: number;
    caseDocumentId?: number;
    mode?: "async_job";
    jobId?: string | null;
    label?: string;
    documentName?: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number | null;
    signedUrl?: string;
    printCapability?: PrintCapability;
    unsupportedMessage?: string | null;
    ready: boolean;
  }>;
  errors?: Array<{ itemId: string; error: string; code: string }>;
  primaryJobIds: string[];
  summary: {
    readyCount: number;
    pendingJobCount: number;
    errorCount: number;
    totalItems: number;
  };
};

type CasePrintModalProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  caseId: number | string;
  initialPrintKey?: string | null;
};

function formatBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(v: string | null | undefined): string {
  if (!v) return "-";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(v).slice(0, 10);
  }
}

function capabilityBadge(c: PrintCapability): { label: string; tone: string } {
  switch (c) {
    case "printable_pdf":
      return { label: "PDF", tone: "bg-blue-50 text-blue-700 border-blue-200" };
    case "printable_image":
      return { label: "Image", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "printable_docx":
      return { label: "Word", tone: "bg-indigo-50 text-indigo-700 border-indigo-200" };
    default:
      return { label: "Unsupported", tone: "bg-slate-100 text-slate-600 border-slate-200" };
  }
}

type SectionKey = "primary" | "caseSupporting" | "projectSupporting" | "legacyUploaded";

export function CasePrintModal({ open, onOpenChange, caseId, initialPrintKey }: CasePrintModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    primary: false,
    caseSupporting: false,
    projectSupporting: false,
    legacyUploaded: false,
  });
  const [previewManifest, setPreviewManifest] = useState<PrepareResponse | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const metaQuery = useQuery<PrintMetaResponse>({
    queryKey: ["case-print-meta", String(caseId)],
    queryFn: async () => {
      const resp = await apiFetchJson<PrintMetaResponse>(`/cases/${String(caseId)}/print-documents`, { timeoutMs: 15000 });
      if (!resp?.ok) throw new Error("Failed to load print documents");
      return resp as PrintMetaResponse;
    },
    enabled: open && Boolean(caseId),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    if (!metaQuery.data) return;
    setSelected((prev) => {
      if (prev.size > 0) return prev;
      const s = new Set<string>();
      const sections = metaQuery.data.sections;
      for (const it of sections.primary.items) {
        if (initialPrintKey && it.printKey === initialPrintKey) s.add(it.id);
        else if (it.defaultSelected && !initialPrintKey) s.add(it.id);
      }
      for (const it of sections.caseSupporting.items) if (it.defaultSelected) s.add(it.id);
      for (const it of sections.projectSupporting.items) if (it.defaultSelected) s.add(it.id);
      for (const it of sections.legacyUploaded?.items ?? []) if (it.defaultSelected) s.add(it.id);
      return s;
    });
  }, [open, metaQuery.data, initialPrintKey]);

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setPreviewManifest(null);
      setPreviewOpen(false);
    }
  }, [open]);

  const selection: {
    primary: PrimaryItem[];
    caseSupporting: SupportingCaseItem[];
    projectSupporting: SupportingProjectItem[];
    legacyUploaded: UploadedItem[];
  } = {
    primary: metaQuery.data?.sections.primary.items ?? [],
    caseSupporting: metaQuery.data?.sections.caseSupporting.items ?? [],
    projectSupporting: metaQuery.data?.sections.projectSupporting.items ?? [],
    legacyUploaded: metaQuery.data?.sections.legacyUploaded?.items ?? [],
  };

  const allSectionIds = (key: SectionKey): string[] => {
    if (key === "primary") return selection.primary.map((i) => i.id);
    if (key === "caseSupporting") return selection.caseSupporting.map((i) => i.id);
    if (key === "projectSupporting") return selection.projectSupporting.map((i) => i.id);
    return selection.legacyUploaded.map((i) => i.id);
  };

  const toggleSectionAll = (key: SectionKey) => {
    const ids = allSectionIds(key);
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((i) => next.has(i));
      if (allIn) ids.forEach((i) => next.delete(i));
      else ids.forEach((i) => next.add(i));
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearAll = () => setSelected(new Set());

  const buildSelectionPayload = (): PrepareSelectionItem[] => {
    const out: PrepareSelectionItem[] = [];
    const sel = selected;
    for (const it of selection.primary) {
      if (sel.has(it.id)) out.push({ kind: "primary_printkey", printKey: it.printKey });
    }
    for (const it of selection.caseSupporting) {
      if (sel.has(it.id)) out.push({ kind: "supporting_case", supportingDocId: it.supportingDocId });
    }
    for (const it of selection.projectSupporting) {
      if (sel.has(it.id)) out.push({ kind: "supporting_project", supportingDocId: it.supportingDocId });
    }
    for (const it of selection.legacyUploaded) {
      if (sel.has(it.id)) out.push({ kind: "case_uploaded", caseDocumentId: it.caseDocumentId });
    }
    return out;
  };

  const runPrimaryJobsIfNeeded = async (prepared: PrepareResponse): Promise<PrepareResponse> => {
    if (prepared.primaryJobIds.length === 0) return prepared;
    const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
    const getProgress = (snap: any) => {
      const p = snap?.progress;
      if (p && typeof p === "object") {
        return { total: Number(p.total ?? 0), success: Number(p.success ?? 0), failed: Number(p.failed ?? 0), pending: Number(p.pending ?? 0), running: Number(p.running ?? 0) };
      }
      return {
        total: Number(snap?.totalCount ?? 0), success: Number(snap?.successCount ?? 0), failed: Number(snap?.failedCount ?? 0), pending: Number(snap?.pendingCount ?? 0), running: Number(snap?.runningCount ?? 0) };
    };
    const isComplete = (snap: any) => {
      const p = getProgress(snap);
      return p.total > 0 && p.pending === 0 && p.running === 0 && p.success + p.failed === p.total;
    };
    const resolvedUrlsByJob: Record<string, { signedUrl: string; fileName: string } | null> = {};
    for (const jobId of prepared.primaryJobIds) {
      let snap: any = await getGenerationJobStatus(jobId);
      for (let attempt = 1; attempt <= 16 && !isComplete(snap); attempt++) {
        try {
          snap = await runNextGenerationJob(jobId);
        } catch (err) {
          const code = getApiFailureCodeFromError(err) ?? "";
          const status = err && typeof err === "object" && "status" in err ? Number((err as any).status) : null;
          if (code === "RUN_NEXT_IN_FLIGHT" || status === 409) {
            await wait(code === "RUN_NEXT_IN_FLIGHT" ? 2500 : 1200);
            snap = await getGenerationJobStatus(jobId);
            continue;
          }
          throw err;
        }
        await wait(250);
        snap = await getGenerationJobStatus(jobId);
      }
      const finalSnap = await getGenerationJobStatus(jobId);
      const p = getProgress(finalSnap);
      if (p.failed > 0 || p.success === 0) continue;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const manifest = await getGenerationJobDownloadManifest(jobId);
          const files = Array.isArray((manifest as any)?.files) ? (manifest as any).files : [];
          const first = Array.isArray(files) ? files.find((f: any) => String(f?.status ?? "") === "success" && typeof f?.signedUrl === "string") : null;
          if (first?.signedUrl) {
            resolvedUrlsByJob[jobId] = { signedUrl: String(first.signedUrl), fileName: typeof first.fileName === "string" ? first.fileName : `primary-${jobId}.pdf` };
            break;
          }
        } catch (err) {
          const code = getApiFailureCodeFromError(err) ?? "";
          if (code === "JOB_NOT_READY_FOR_DOWNLOAD") {
            await wait(800);
            continue;
          }
          throw err;
        }
      }
    }
    const mergedItems = prepared.manifestItems.map((item) => {
      if (item.kind === "primary_printkey" && item.mode === "async_job" && item.jobId && resolvedUrlsByJob[item.jobId]) {
        const resolved = resolvedUrlsByJob[item.jobId]!;
        return { ...item, ready: true, signedUrl: resolved.signedUrl, fileName: resolved.fileName, mimeType: item.mimeType ?? "application/pdf", printCapability: "printable_pdf" as PrintCapability };
      }
      return item;
    });
    return { ...prepared, manifestItems: mergedItems };
  };

  const prepareMutation = useMutation<PrepareResponse, unknown, { mode: "preview" | "print" }>({
    mutationFn: async ({ mode }) => {
      const selectionPayload = buildSelectionPayload();
      if (selectionPayload.length === 0) throw new Error("No documents selected");
      const resp = await apiFetchJson<PrepareResponse>(`/cases/${String(caseId)}/print/prepare`, {
        method: "POST",
        timeoutMs: 60000,
        body: JSON.stringify({ mode, selection: selectionPayload }),
      });
      if (!resp || !(resp as any).ok) throw new Error((resp as any)?.error || "Print prepare failed");
      const resolved = await runPrimaryJobsIfNeeded(resp as PrepareResponse);
      return resolved;
    },
    onSuccess: (data, vars) => {
      setPreviewManifest(data);
      setPreviewOpen(true);
      queryClient.invalidateQueries({ queryKey: ["case-documents", String(caseId)] });
      if (vars.mode === "print") {
        // Kick off browser print via PrintPreview pane auto-print mode — still show manifest first
      }
      toast({ title: vars.mode === "preview" ? "Preview ready" : "Print manifest ready", description: `${data.summary.readyCount} of ${data.summary.totalItems} items ready, ${data.summary.errorCount} errors` });
    },
    onError: (err) => toastError(toast, err, "Failed to prepare print bundle"),
  });

  const totalSelected = selected.size;

  const SectionHeader = ({ k, title, count, items, description }: { k: SectionKey; title: string; count: number; items: { id: string }[]; description?: string }) => {
    const ids = items.map((i) => i.id);
    const allIn = ids.length > 0 && ids.every((i) => selected.has(i));
    const someIn = ids.some((i) => selected.has(i));
    const isCollapsed = collapsed[k];
    return (
      <div className="flex items-center justify-between gap-2 pt-2">
        <button
          type="button"
          className="flex items-center gap-2 font-semibold text-slate-800 text-sm w-full text-left"
          onClick={() => setCollapsed((p) => ({ ...p, [k]: !p[k] }))}
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
          <span>{title}</span>
          <Badge variant="secondary" className="text-[10px]">{count}</Badge>
          {description ? <span className="text-xs text-slate-500 font-normal ml-1">{description}</span> : null}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={(e) => { e.stopPropagation(); toggleSectionAll(k); }}
            disabled={ids.length === 0}
          >
            {allIn ? (
              <><CheckSquare className="w-3.5 h-3.5 mr-1" />Clear</>
            ) : someIn ? (
              <><CheckSquare className="w-3.5 h-3.5 mr-1 opacity-60" />Select All</>
            ) : (
              <><Square className="w-3.5 h-3.5 mr-1" />Select All</>
            )}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[88vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-slate-900 text-white flex items-center justify-center">
                <PrinterIcon className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <DialogTitle>Print Documents</DialogTitle>
                <DialogDescription>
                  {metaQuery.data?.caseContext.referenceNo
                    ? <>Case Reference: <span className="font-medium text-slate-700">{metaQuery.data.caseContext.referenceNo}</span>
                      {metaQuery.data.caseContext.projectName ? <> · Project: {metaQuery.data.caseContext.projectName}</> : null}
                    </>
                    : "Select the documents to include in the print bundle."}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            {metaQuery.isLoading || metaQuery.fetchStatus === "fetching" ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
              <div className="text-sm text-slate-500">Loading documents...</div>
            </div>
          ) : metaQuery.error ? (
            (() => {
              const errCode = metaQuery.error ? getApiFailureCodeFromError(metaQuery.error) ?? "" : "";
              const isFeatureDisabled = errCode === "FEATURE_DISABLED";
              return (
                <div className="flex flex-col items-center justify-center py-12 gap-2 w-full">
                  <AlertCircle className={`w-8 h-8 ${isFeatureDisabled ? "text-rose-500" : "text-red-500"}`} />
                  {isFeatureDisabled && (
                    <Badge variant="destructive" className="text-xs gap-1 px-3 py-1 border border-rose-300 bg-rose-50 text-rose-700">
                      <AlertCircle className="w-3 h-3" />
                      FEATURE_DISABLED — Print feature is turned off
                    </Badge>
                  )}
                  <div className="text-sm text-slate-700 font-medium">
                    {isFeatureDisabled ? "Print feature is currently disabled for your workspace." : "Failed to load print documents."}
                  </div>
                  {isFeatureDisabled ? (
                    <div className="text-xs text-slate-500 max-w-lg text-center">
                      Contact your firm Partner or Lawcaspro administrator to enable document print/download.
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500 max-w-lg text-center">{metaQuery.error ? String(metaQuery.error) : null}</div>
                  )}
                </div>
              );
            })()
          ) : (
            <>
              <section>
                <SectionHeader k="primary" title="A. Status / Primary Documents" count={selection.primary.length} items={selection.primary} description="Generated by Lawcaspro Document Engine" />
                {!collapsed.primary ? (
                  <ul className="mt-2 divide-y divide-slate-100 border border-slate-100 rounded-md">
                    {selection.primary.length === 0 ? (
                      <li className="px-4 py-4 text-xs text-slate-500 text-center">No status documents configured</li>
                    ) : selection.primary.map((it) => {
                      const checked = selected.has(it.id);
                      const disabled = it.status !== "configured";
                      return (
                        <li key={it.id} className={cn("flex items-center gap-3 px-3 py-2.5", disabled ? "opacity-60" : "")}>
                          <Checkbox id={`sel-${it.id}`} checked={checked} disabled={disabled} onCheckedChange={(c) => c === true || c === false ? toggleOne(it.id) : undefined} />
                          <label htmlFor={`sel-${it.id}`} className="flex-1 grid grid-cols-[1fr_auto] items-center gap-3 cursor-pointer min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <FileText className="w-4 h-4 text-indigo-500 shrink-0" />
                              <span className="text-sm font-medium text-slate-800 truncate">{it.label}</span>
                              {it.status !== "configured" ? (
                                <Badge variant="outline" className="text-[10px] shrink-0">
                                  {it.status === "not_applicable" ? "Not applicable" : "Missing template"}
                                </Badge>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-500 shrink-0">{it.documentType}</div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>

              <section>
                <SectionHeader k="caseSupporting" title="B. Case Supporting Documents" count={selection.caseSupporting.length} items={selection.caseSupporting} description="Uploaded directly on this Case" />
                {!collapsed.caseSupporting ? (
                  <ul className="mt-2 divide-y divide-slate-100 border border-slate-100 rounded-md">
                    {selection.caseSupporting.length === 0 ? (
                      <li className="px-4 py-4 text-xs text-slate-500 text-center">No case supporting documents uploaded</li>
                    ) : selection.caseSupporting.map((it) => {
                      const checked = selected.has(it.id);
                      const cap = capabilityBadge(it.printCapability);
                      return (
                        <li key={it.id} className="flex items-start gap-3 px-3 py-2.5">
                          <Checkbox id={`sel-${it.id}`} checked={checked} onCheckedChange={(c) => (c === true || c === false) ? toggleOne(it.id) : undefined} />
                          <label htmlFor={`sel-${it.id}`} className="flex-1 grid grid-cols-[1fr_auto] items-start gap-3 cursor-pointer min-w-0">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                {it.printCapability === "printable_image" ? <FileImage className="w-4 h-4 text-emerald-500 shrink-0" /> : <File className="w-4 h-4 text-slate-500 shrink-0" />}
                                <span className="text-sm font-medium text-slate-800 truncate">{it.documentName}</span>
                                <Badge variant="outline" className={cn("text-[10px] border", cap.tone)}>{cap.label}</Badge>
                                {it.versionLabel ? <Badge variant="secondary" className="text-[10px]">v{it.versionLabel}</Badge> : null}
                                {it.status === "superseded" ? <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 bg-amber-50">Superseded</Badge> : null}
                              </div>
                              <div className="mt-0.5 text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                                <span>Type: {it.documentType}</span>
                                <span>Uploaded: {formatDate(it.uploadDate)}</span>
                                <span>Size: {formatBytes(it.fileSize)}</span>
                              </div>
                              {it.printCapability === "unsupported" ? (
                                <div className="mt-1 text-[11px] text-amber-700 flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" /> Preview/print not supported for this file type
                                </div>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-500 text-right shrink-0">
                              {it.originalFilename ? <div className="max-w-[180px] truncate" title={it.originalFilename}>{it.originalFilename}</div> : null}
                              <div>v{it.versionNo}</div>
                            </div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>

              <section>
                <SectionHeader k="projectSupporting" title="C. Project Supporting Documents" count={selection.projectSupporting.length} items={selection.projectSupporting} description="Inherited from Developer / Project / Phase" />
                {!collapsed.projectSupporting ? (
                  <ul className="mt-2 divide-y divide-slate-100 border border-slate-100 rounded-md">
                    {selection.projectSupporting.length === 0 ? (
                      <li className="px-4 py-4 text-xs text-slate-500 text-center">No project-level supporting documents linked to this Case</li>
                    ) : selection.projectSupporting.map((it) => {
                      const checked = selected.has(it.id);
                      const cap = capabilityBadge(it.printCapability);
                      return (
                        <li key={it.id} className="flex items-start gap-3 px-3 py-2.5">
                          <Checkbox id={`sel-${it.id}`} checked={checked} onCheckedChange={(c) => (c === true || c === false) ? toggleOne(it.id) : undefined} />
                          <label htmlFor={`sel-${it.id}`} className="flex-1 grid grid-cols-[1fr_auto] items-start gap-3 cursor-pointer min-w-0">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                {it.printCapability === "printable_image" ? <FileImage className="w-4 h-4 text-emerald-500 shrink-0" /> : <File className="w-4 h-4 text-slate-500 shrink-0" />}
                                <span className="text-sm font-medium text-slate-800 truncate">{it.documentName}</span>
                                <Badge variant="outline" className={cn("text-[10px] border", cap.tone)}>{cap.label}</Badge>
                                {it.phase ? <Badge variant="secondary" className="text-[10px]">Phase {it.phase}</Badge> : null}
                                {it.versionLabel ? <Badge variant="secondary" className="text-[10px]">v{it.versionLabel}</Badge> : null}
                                {it.status === "superseded" ? <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 bg-amber-50">Superseded</Badge> : null}
                              </div>
                              <div className="mt-0.5 text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                                <span>Type: {it.documentType}</span>
                                <span>Uploaded: {formatDate(it.uploadDate)}</span>
                                <span>Size: {formatBytes(it.fileSize)}</span>
                              </div>
                              {it.printCapability === "unsupported" ? (
                                <div className="mt-1 text-[11px] text-amber-700 flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" /> Preview/print not supported for this file type
                                </div>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-500 text-right shrink-0">
                              {it.originalFilename ? <div className="max-w-[180px] truncate" title={it.originalFilename}>{it.originalFilename}</div> : null}
                              <div>v{it.versionNo}</div>
                            </div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>

              {selection.legacyUploaded.length > 0 ? (
                <section>
                  <SectionHeader k="legacyUploaded" title="Uploaded Case Documents (Legacy)" count={selection.legacyUploaded.length} items={selection.legacyUploaded} />
                  {!collapsed.legacyUploaded ? (
                    <ul className="mt-2 divide-y divide-slate-100 border border-slate-100 rounded-md">
                      {selection.legacyUploaded.map((it) => {
                        const checked = selected.has(it.id);
                        return (
                          <li key={it.id} className="flex items-start gap-3 px-3 py-2.5 opacity-80">
                            <Checkbox id={`sel-${it.id}`} checked={checked} onCheckedChange={(c) => (c === true || c === false) ? toggleOne(it.id) : undefined} />
                            <label htmlFor={`sel-${it.id}`} className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                              <File className="w-4 h-4 text-slate-400 shrink-0" />
                              <span className="text-sm font-medium text-slate-700 truncate">{it.documentName || it.fileName}</span>
                            </div>
                            <div className="mt-0.5 text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>Type: {it.documentType}</span>
                              <span>Uploaded: {formatDate(it.uploadDate)}</span>
                              <span>Size: {formatBytes(it.fileSize)}</span>
                            </div>
                          </label>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </section>
              ) : null}
            </>
          )}
          </div>

          <DialogFooter className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[11px]">{totalSelected} selected</Badge>
              {totalSelected > 0 ? (
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearAll}>Clear selection</Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={prepareMutation.isPending}>Cancel</Button>
              <Button type="button" variant="outline" onClick={() => prepareMutation.mutate({ mode: "preview" })} disabled={totalSelected === 0 || prepareMutation.isPending} className="gap-1.5">
                {prepareMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                Preview
              </Button>
              <Button type="button" onClick={() => prepareMutation.mutate({ mode: "print" })} disabled={totalSelected === 0 || prepareMutation.isPending} className="bg-slate-900 hover:bg-slate-800 gap-1.5">
                {prepareMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PrinterIcon className="w-4 h-4" />}
                Print
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PrintPreviewPane
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        manifest={previewManifest}
      />
    </>
  );
}

type PrintPreviewPaneProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  manifest: PrepareResponse | null;
};

function PrintPreviewPane({ open, onOpenChange, manifest }: PrintPreviewPaneProps) {
  const busyRef = useRef<HTMLDivElement | null>(null);
  const [activeErrors, setActiveErrors] = useState<Set<string>>(new Set());
  const [activeSuccess, setActiveSuccess] = useState<Set<string>>(new Set());
  void activeErrors;
  void activeSuccess;

  const items = manifest?.manifestItems ?? [];
  const errors = manifest?.errors ?? [];
  const errorIds = useMemo(() => new Map(errors.map((e) => [e.itemId, e])), [errors]);

  const downloadAll = async () => {
    const ready = items.filter((i) => i.ready && typeof i.signedUrl === "string");
    for (const it of ready) {
      if (!it.signedUrl) continue;
      window.open(it.signedUrl, "_blank", "noopener,noreferrer");
    }
  };

  const printAll = async () => {
    const ready = items.filter((i) => i.ready && typeof i.signedUrl === "string");
    const wins: Window[] = [];
    const errs: string[] = [];
    for (const it of ready) {
      const url = it.signedUrl!;
      const cap = it.printCapability ?? "unsupported";
      try {
        if (cap === "printable_pdf") {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          const w = window.open(URL.createObjectURL(blob), "_blank", "noopener,noreferrer");
          if (w) wins.push(w);
        } else if (cap === "printable_image") {
          const html = `<!doctype html><html><head><title>${encodeURIComponent(it.documentName ?? it.fileName ?? "Print")}</title><style>@page { size: A4; margin: 10mm; } body { margin: 0; display:flex; align-items:center; justify-content:center; } img { max-width: 100%; max-height: 100vh; object-fit: contain; }</style></head><body><img src="${url}" onload="window.print()" /></body></html>`;
          const w = window.open("", "_blank", "noopener,noreferrer");
          if (w) { wins.push(w); w.document.write(html); w.document.close(); }
        } else if (cap === "printable_docx") {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          await printWordBlob(blob, { title: it.documentName ?? it.fileName ?? "Print" });
        } else {
          errs.push(it.itemId);
        }
      } catch (err) {
        errs.push(it.itemId);
      }
    }
    setTimeout(() => { for (const w of wins) try { w.focus(); } catch {} }, 250);
    if (errs.length > 0) {
      setActiveErrors(new Set(errs));
    }
    if (ready.length - errs.length > 0) setActiveSuccess(new Set(ready.map((r) => r.itemId)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-slate-100 flex items-center justify-between flex-row gap-3">
          <div className="flex-1">
            <DialogTitle className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-slate-500" /> Print Preview Manifest
            </DialogTitle>
            <DialogDescription>
              {manifest ? (
                <>
                  {manifest.summary.readyCount} ready · {manifest.summary.pendingJobCount} async · {manifest.summary.errorCount} errors · Total {manifest.summary.totalItems} items
                </>
              ) : null}
            </DialogDescription>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100"
            onClick={() => onOpenChange(false)}
            aria-label="Close preview"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2" ref={busyRef}>
          {!manifest ? (
            <div className="py-16 flex flex-col items-center justify-center text-slate-500 text-sm">
              <Loader2 className="w-6 h-6 animate-spin mb-2" /> Loading manifest...
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-100 rounded-md overflow-hidden">
              {items.length === 0 && errors.length === 0 ? (
                <li className="px-4 py-8 text-center text-sm text-slate-500">No items</li>
              ) : null}
              {items.map((it) => {
                const cap = it.printCapability ?? "unsupported";
                const cb = capabilityBadge(cap);
                const isError = errorIds.has(it.itemId);
                const err = errorIds.get(it.itemId);
                return (
                  <li key={it.itemId} className="flex items-start gap-3 px-3 py-2.5">
                    <div className={cn(
                      "mt-0.5 w-5 h-5 rounded-sm border flex items-center justify-center shrink-0",
                      !it.ready && !isError ? "border-slate-200 bg-slate-50" :
                        isError ? "border-red-300 bg-red-50" : "border-emerald-300 bg-emerald-50"
                    )}>
                      {!it.ready && !isError ? <Loader2 className="w-3 h-3 text-slate-500 animate-spin" /> :
                        isError ? <AlertCircle className="w-3 h-3 text-red-500" /> : <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-800 truncate">
                          {it.documentName || it.label || it.fileName || it.itemId}
                        </span>
                        <Badge variant="outline" className={cn("text-[10px] border", cb.tone)}>{cb.label}</Badge>
                        {it.fileSize != null ? <span className="text-[11px] text-slate-500">{formatBytes(it.fileSize)}</span> : null}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>Kind: {it.kind}</span>
                        {it.printKey ? <span>printKey: {it.printKey}</span> : null}
                        {it.fileName ? <span>File: {it.fileName}</span> : null}
                      </div>
                      {isError ? (
                        <div className="mt-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                          {err?.code ? <>[{err.code}] </> : null}{err?.error || "Error"}
                        </div>
                      ) : it.unsupportedMessage ? (
                        <div className="mt-1 text-[11px] text-amber-700 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" /> {it.unsupportedMessage}
                        </div>
                      ) : !it.ready ? (
                        <div className="mt-1 text-[11px] text-slate-500">Generating…</div>
                      ) : null}
                    </div>
                    <div className="shrink-0">
                      {it.ready && it.signedUrl ? (
                        <a
                          href={it.signedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                          onClick={(e) => { e.stopPropagation(); }}
                        >Open</a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {errors.map((err) => (
                <li key={`err-${err.itemId}`} className="flex items-start gap-3 px-3 py-2.5 bg-red-50/60">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-red-800 font-medium">{err.itemId}</div>
                    <div className="text-xs text-red-700">[{err.code}] {err.error}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-2">
          <div className="text-xs text-slate-500">
            One window/tab will be opened per printable document. Unsupported items are skipped.
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button type="button" variant="outline" onClick={downloadAll} disabled={!manifest}>Download all</Button>
            <Button type="button" className="bg-slate-900 hover:bg-slate-800" onClick={printAll} disabled={!manifest}>Print</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
