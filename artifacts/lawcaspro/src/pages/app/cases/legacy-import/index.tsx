import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Upload,
  FileSpreadsheet,
  Download,
  Plus,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Search,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiFetchBlob, apiFetchJson, apiRequest } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { getListProjectsQueryKey, getListDevelopersQueryKey } from "@workspace/api-client-react";
import type {
  UploadResponse,
  MappingResponse,
  PreviewRow,
  BatchStatusResponse,
  DryRunResponse,
  ImportResponse,
  RecentImport,
  ExcelColumnMapping,
  FixedValues,
  PreviewRowsResponse,
  FieldCatalogEntry,
  FieldMappingGroup,
  ReviewOverride,
} from "@workspace/db";
import {
  mapLegacyRowStatus,
  CASE_TYPE_LABELS,
  type CaseTypeApiValue,
  type UiRowStatus,
} from "@workspace/db";

type WizardStep = 1 | 2 | 3 | 4;

type LocalMappingRow = {
  target: string;
  label: string;
  group: FieldMappingGroup;
  required: boolean;
  arrayIndex?: number;
  dataType: FieldCatalogEntry["dataType"];
  mappedExcelHeader: string | null;
};

const GROUPS_ORDER: FieldMappingGroup[] = [
  "Core Case",
  "Purchaser",
  "Borrower",
  "Property",
  "Financing",
  "Existing Dates / Milestones",
  "Other",
];

const DEFAULT_EXPANDED_GROUPS: FieldMappingGroup[] = [
  "Core Case",
  "Purchaser",
  "Borrower",
  "Property",
  "Financing",
];

const OPTIONAL_GROUP_HINT: Record<FieldMappingGroup, string> = {
  "Core Case": "",
  Purchaser: "",
  Borrower: "",
  Property: "",
  Financing: "",
  "Existing Dates / Milestones": "Dates and milestones",
  Other: "Additional optional fields",
};

const CHUNK_SIZE = 20;
const PAGE_SIZE = 50;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function keyForCatalog(c: FieldCatalogEntry): string {
  return c.arrayIndex !== undefined ? `${c.target}#${c.arrayIndex}` : c.target;
}

function isNameField(c: FieldCatalogEntry): boolean {
  const t = c.target.toLowerCase();
  return (
    (t.includes("purchaser") || t.includes("borrower")) &&
    (t.includes("name") || t.endsWith(".name"))
  );
}

function isIcField(c: FieldCatalogEntry): boolean {
  const t = c.target.toLowerCase();
  return (
    (t.includes("purchaser") || t.includes("borrower")) &&
    (t.includes("ic") || t.includes("nric") || t.endsWith(".ic") || t.endsWith(".nric"))
  );
}

function buildInitialMappings(
  catalog: FieldCatalogEntry[],
  columns: ExcelColumnMapping[]
): LocalMappingRow[] {
  const byKey = new Map<string, ExcelColumnMapping>();
  for (const col of columns) {
    const k = col.arrayIndex !== undefined ? `${col.target}#${col.arrayIndex}` : col.target;
    byKey.set(k, col);
  }

  return catalog.map((c) => {
    const k = keyForCatalog(c);
    const m = byKey.get(k);
    return {
      target: c.target,
      label: c.label,
      group: c.group,
      required: !c.optional,
      arrayIndex: c.arrayIndex,
      dataType: c.dataType,
      mappedExcelHeader: m?.excelHeader ?? null,
    };
  });
}

function mappingRowsToColumns(rows: LocalMappingRow[]): ExcelColumnMapping[] {
  const out: ExcelColumnMapping[] = [];
  for (const r of rows) {
    if (r.mappedExcelHeader && r.mappedExcelHeader !== "__ignore__" && r.mappedExcelHeader !== "__snapshot__") {
      const c: ExcelColumnMapping = {
        excelHeader: r.mappedExcelHeader,
        target: r.target,
      };
      if (r.arrayIndex !== undefined) c.arrayIndex = r.arrayIndex;
      out.push(c);
    }
  }
  return out;
}

function sortCatalogForCoreSection(arr: FieldCatalogEntry[]): FieldCatalogEntry[] {
  const names = arr.filter(isNameField);
  const ics = arr.filter(isIcField);
  const rest = arr.filter((x) => !isNameField(x) && !isIcField(x));
  return [...names, ...ics, ...rest];
}

export default function LegacyCaseImportPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<WizardStep>(1);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadData, setUploadData] = useState<UploadResponse | null>(null);
  const [mappingResponse, setMappingResponse] = useState<MappingResponse | null>(null);
  const [mappings, setMappings] = useState<LocalMappingRow[]>([]);
  const [optionalExpanded, setOptionalExpanded] = useState(false);
  const [saveMappingChecked, setSaveMappingChecked] = useState(false);

  const [caseType, setCaseType] = useState<"developer_sales">("developer_sales");
  const [projectId, setProjectId] = useState<number | "">("");
  const [developerId, setDeveloperId] = useState<number | "">("");
  const [preserveRef, setPreserveRef] = useState(true);

  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewTab, setPreviewTab] = useState<"all" | UiRowStatus>("all");
  const [previewSearch, setPreviewSearch] = useState("");
  const [previewPage, setPreviewPage] = useState(1);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [selectedRowId, setSelectedRowId] = useState<string | number | null>(null);
  const [reviewOverrides, setReviewOverrides] = useState<Record<string, ReviewOverride>>({});

  const [showProgressDialog, setShowProgressDialog] = useState(false);
  const [completedRows, setCompletedRows] = useState(0);
  const [selectedRowsForImport, setSelectedRowsForImport] = useState<(string | number)[]>([]);
  const [importResult, setImportResult] = useState<BatchStatusResponse | null>(null);

  const selectedRow = useMemo(
    () => previewRows.find((r) => r.id === selectedRowId) ?? null,
    [previewRows, selectedRowId]
  );

  useEffect(() => {
    if (step !== 3 || !uploadData) return;
    let cancelled = false;
    (async () => {
      try {
        const payload = await fetchRowsForPage(uploadData.batchId, previewPage, previewTab);
        if (cancelled) return;
        setPreviewRows(payload.rows ?? []);
        setPreviewTotal(payload.total ?? (payload.rows?.length ?? 0));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, uploadData, previewPage, previewTab, fetchRowsForPage]);

  const projectsQuery = useQuery({
    queryKey: getListProjectsQueryKey({ page: 1, limit: 200 }),
    queryFn: ({ signal }) =>
      apiFetchJson("/projects?page=1&limit=200", { signal }) as Promise<{ data?: unknown[] }>,
    enabled: step >= 2,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const projects: Array<{ id: number; name: string }> = Array.isArray(
    (projectsQuery.data as any)?.data
  )
    ? ((projectsQuery.data as any).data as Array<{ id: number; name: string }>)
    : [];

  const developersQuery = useQuery({
    queryKey: getListDevelopersQueryKey({ limit: 100 }),
    queryFn: ({ signal }) =>
      apiFetchJson("/developers?limit=100", { signal }) as Promise<{ data?: unknown[] }>,
    enabled: step >= 2,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const developers: Array<{ id: number; name: string }> = Array.isArray(
    (developersQuery.data as any)?.data
  )
    ? ((developersQuery.data as any).data as Array<{ id: number; name: string }>)
    : [];

  const recentImportsQuery = useQuery({
    queryKey: ["legacy-imports", "recent"],
    queryFn: async () => {
      const r = await apiFetchJson("/legacy-case-imports/recent");
      const arr = (r as any)?.data ?? r;
      if (!Array.isArray(arr)) throw new Error("Unexpected response shape from /legacy-case-imports/recent");
      return arr as RecentImport[];
    },
    enabled: step === 4,
    staleTime: 30_000,
    retry: false,
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiRequest("/legacy-case-imports/upload", {
        method: "POST",
        body: fd,
        timeoutMs: 120000,
      });
      const body = await res.json();
      const upload = (body?.data ?? body) as UploadResponse;
      const mapRes = await apiFetchJson(
        `/legacy-case-imports/${encodeURIComponent(String(upload.batchId))}/mapping`
      );
      const mapping = (mapRes as any)?.data ?? (mapRes as any);
      return { upload, mapping: mapping as MappingResponse };
    },
    onSuccess: ({ upload, mapping }) => {
      setUploadData(upload);
      setMappingResponse(mapping);
      const rows = buildInitialMappings(mapping.catalog, mapping.columns);
      setMappings(rows);
      if (mapping.fixedValues) {
        if (mapping.fixedValues.caseType) setCaseType(mapping.fixedValues.caseType);
        if (mapping.fixedValues.projectId != null) setProjectId(Number(mapping.fixedValues.projectId));
        if (mapping.fixedValues.developerId != null) setDeveloperId(Number(mapping.fixedValues.developerId));
        if (typeof mapping.fixedValues.preserveRef === "boolean")
          setPreserveRef(mapping.fixedValues.preserveRef);
      }
    },
    onError: (err) => {
      toastError(toast, err, "Upload failed");
    },
  });

  const patchMappingMutation = useMutation({
    mutationFn: async () => {
      if (!uploadData || !mappingResponse) throw new Error("No batch");
      const columns = mappingRowsToColumns(mappings);
      const fixed: FixedValues = {};
      if (caseType) fixed.caseType = caseType;
      if (projectId !== "") fixed.projectId = Number(projectId) ?? null;
      if (developerId !== "") fixed.developerId = Number(developerId) ?? null;
      fixed.preserveRef = preserveRef;
      if (mappingResponse.fixedValues?.solMapping) fixed.solMapping = mappingResponse.fixedValues.solMapping;
      const res = await apiRequest(
        `/legacy-case-imports/${encodeURIComponent(String(uploadData.batchId))}/mapping`,
        {
          method: "PATCH",
          body: { columns, fixedValues: fixed } as unknown as RequestInit["body"],
          timeoutMs: 60000,
        }
      );
      const body = await res.json();
      return (body?.data ?? body) as MappingResponse;
    },
  });

  const saveMappingMutation = useMutation({
    mutationFn: async (batchId: string | number) => {
      const res = await apiRequest(
        `/legacy-case-imports/${encodeURIComponent(String(batchId))}/save-mapping-template`,
        {
          method: "POST",
          body: { name: "M LEGASI Master Data", isDefault: true } as unknown as RequestInit["body"],
          timeoutMs: 30000,
        }
      );
      return res.json();
    },
    onError: (err) => {
      toastError(toast, err, "Failed to save mapping template");
    },
  });

  const fetchRowsForPage = useCallback(
    async (batchId: string | number, page: number, tab: "all" | UiRowStatus) => {
      const statusParam =
        tab === "all"
          ? ""
          : tab === "ready"
          ? "status=READY&"
          : tab === "warning"
          ? "status=WARNING&"
          : tab === "review"
          ? "status=REVIEW_REQUIRED&"
          : tab === "duplicate"
          ? "status=HARD_DUPLICATE&"
          : tab === "invalid"
          ? "status=INVALID&"
          : tab === "imported"
          ? "status=imported&"
          : tab === "failed"
          ? "status=failed&"
          : "";
      const url = `/legacy-case-imports/${encodeURIComponent(String(batchId))}/rows?${statusParam}limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`;
      const rowsRes = await apiFetchJson(url);
      const rowsPayload = ((rowsRes as any)?.data ?? (rowsRes as any)) as PreviewRowsResponse;
      return rowsPayload;
    },
    []
  );

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      if (!uploadData) throw new Error("No batch");
      const res = await apiRequest(
        `/legacy-case-imports/${encodeURIComponent(String(uploadData.batchId))}/dry-run`,
        { method: "POST", timeoutMs: 60000 }
      );
      const body = await res.json();
      const dryRun = (body?.data ?? body) as DryRunResponse;
      const rowsPayload = await fetchRowsForPage(uploadData.batchId, 1, previewTab);
      return { dryRun, rowsPayload };
    },
    onSuccess: ({ rowsPayload }) => {
      setPreviewRows(rowsPayload.rows ?? []);
      setPreviewTotal(rowsPayload.total ?? (rowsPayload.rows?.length ?? 0));
      setPreviewPage(1);
      setStep(3);
    },
    onError: (err) => {
      toastError(toast, err, "Failed to generate preview");
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      await patchMappingMutation.mutateAsync();
      if (saveMappingChecked && uploadData) {
        try {
          await saveMappingMutation.mutateAsync(uploadData.batchId);
        } catch {
        }
      }
      return dryRunMutation.mutateAsync();
    },
    onError: (err) => {
      toastError(toast, err, "Failed to generate preview");
    },
  });

  const importChunkMutation = useMutation({
    mutationFn: async (args: {
      batchId: string | number;
      chunk: (string | number)[];
      overrides: Record<string, ReviewOverride>;
    }) => {
      const res = await apiRequest(
        `/legacy-case-imports/${encodeURIComponent(String(args.batchId))}/import`,
        {
          method: "POST",
          body: {
            rowIds: args.chunk,
            includeWarnings: true,
            reviewOverrides: args.overrides,
          } as unknown as RequestInit["body"],
          timeoutMs: 120000,
        }
      );
      const body = await res.json();
      return (body?.data ?? body) as ImportResponse;
    },
  });

  const reconcileMutation = useMutation({
    mutationFn: async (batchId: string | number) => {
      const res = await apiFetchJson(
        `/legacy-case-imports/${encodeURIComponent(String(batchId))}`
      );
      return ((res as any)?.data ?? (res as any)) as BatchStatusResponse;
    },
  });

  const startImportSequentially = useCallback(
    async (rowIds: (string | number)[]) => {
      if (!uploadData) return;
      const chunks = chunkArray(rowIds, CHUNK_SIZE);
      setSelectedRowsForImport(rowIds);
      setCompletedRows(0);
      setShowProgressDialog(true);
      let failed = false;
      for (const chunk of chunks) {
        const filteredOverrides: Record<string, ReviewOverride> = {};
        for (const id of chunk) {
          const k = String(id);
          if (reviewOverrides[k]) filteredOverrides[k] = reviewOverrides[k];
        }
        try {
          await importChunkMutation.mutateAsync({
            batchId: uploadData.batchId,
            chunk,
            overrides: filteredOverrides,
          });
        } catch {
          failed = true;
          break;
        } finally {
          setCompletedRows((n) => n + chunk.length);
        }
      }
      try {
        const final = await reconcileMutation.mutateAsync(uploadData.batchId);
        setImportResult(final);
        setShowProgressDialog(false);
        if (final.status === "completed" || final.status === "partial_failed" || final.status === "failed") {
          setStep(4);
        }
      } catch (err) {
        toastError(toast, err, "Failed to reconcile import status");
        setShowProgressDialog(false);
        if (!failed) setStep(4);
      }
    },
    [uploadData, reviewOverrides, importChunkMutation, reconcileMutation, toast]
  );

  const handleFile = (file: File) => {
    uploadMutation.mutate(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const previewCounts = useMemo(() => {
    const counts: Record<UiRowStatus, number> = {
      ready: 0,
      warning: 0,
      review: 0,
      duplicate: 0,
      invalid: 0,
      imported: 0,
      failed: 0,
      pending: 0,
    };
    for (const r of previewRows) counts[mapLegacyRowStatus(r.rowStatus)]++;
    return counts;
  }, [previewRows]);

  const filteredRows = useMemo(() => {
    let rows = previewRows;
    if (previewSearch.trim()) {
      const q = previewSearch.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          String(r.sourceReference ?? "").toLowerCase().includes(q) ||
          String(r.purchaserSummary ?? "").toLowerCase().includes(q) ||
          String(r.borrowerSummary ?? "").toLowerCase().includes(q) ||
          String(r.propertySummary ?? "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [previewRows, previewSearch]);

  const totalPages = Math.max(1, Math.ceil(previewTotal / PAGE_SIZE));

  const approvedReviewRowIds = new Set(
    Object.entries(reviewOverrides)
      .filter(([, o]) => o?.duplicateAction === "import_anyway")
      .map(([id]) => id)
  );

  const importableCount =
    (dryRunMutation.data?.dryRun.summary.ready ?? 0) +
    (dryRunMutation.data?.dryRun.summary.warnings ?? 0) +
    approvedReviewRowIds.size;

  const handleStartImport = async () => {
    if (!uploadData) return;
    try {
      const planRaw = await apiFetchJson(
        `/legacy-case-imports/${encodeURIComponent(String(uploadData.batchId))}/import-plan`
      );
      const plan = ((planRaw as any)?.data ?? (planRaw as any)) as {
        importableRowIds: (string | number)[];
        reviewRowIds: (string | number)[];
      };
      let ids: (string | number)[] = [...plan.importableRowIds];
      const skipped = new Set(
        Object.entries(reviewOverrides)
          .filter(([, o]) => o?.duplicateAction === "skip")
          .map(([id]) => id)
      );
      for (const [idStr, override] of Object.entries(reviewOverrides)) {
        if (override?.duplicateAction === "import_anyway") {
          if (!ids.includes(Number(idStr)) && !ids.includes(idStr)) {
            ids.push(Number(idStr));
          }
        }
      }
      ids = ids.filter((id) => !skipped.has(String(id)));
      if (ids.length === 0) return;
      void startImportSequentially(ids);
    } catch (err) {
      toastError(toast, err, "Failed to prepare import plan");
    }
  };

  const handleSkipRow = () => {
    if (!selectedRow) return;
    setReviewOverrides((prev) => ({
      ...prev,
      [String(selectedRow.id)]: { duplicateAction: "skip" },
    }));
    setSelectedRowId(null);
  };

  const handleImportAnyway = () => {
    if (!selectedRow) return;
    setReviewOverrides((prev) => ({
      ...prev,
      [String(selectedRow.id)]: { duplicateAction: "import_anyway" },
    }));
    setSelectedRowId(null);
  };

  const updateMappingRow = (key: string, excelHeader: string | null) => {
    setMappings((prev) =>
      prev.map((m) => {
        const k = m.arrayIndex !== undefined ? `${m.target}#${m.arrayIndex}` : m.target;
        return k === key ? { ...m, mappedExcelHeader: excelHeader } : m;
      })
    );
  };

  const groupedMappings = useMemo(() => {
    const out: Record<FieldMappingGroup, LocalMappingRow[]> = {
      "Core Case": [],
      Purchaser: [],
      Borrower: [],
      Property: [],
      Financing: [],
      "Existing Dates / Milestones": [],
      Other: [],
    };
    for (const m of mappings) {
      if (!out[m.group]) out[m.group] = [];
      out[m.group].push(m);
    }
    for (const g of Object.keys(out) as FieldMappingGroup[]) {
      out[g].sort((a, b) => {
        const aName = a.label.toLowerCase().includes("name") || a.target.toLowerCase().includes(".name");
        const bName = b.label.toLowerCase().includes("name") || b.target.toLowerCase().includes(".name");
        if (aName !== bName) return aName ? -1 : 1;
        const aIc = a.label.toLowerCase().includes("ic") || a.target.toLowerCase().includes(".ic");
        const bIc = b.label.toLowerCase().includes("ic") || b.target.toLowerCase().includes(".ic");
        if (aIc !== bIc) return aIc ? -1 : 1;
        return 0;
      });
    }
    return out;
  }, [mappings]);

  const possibleHeaders = useMemo(() => {
    const fromContract = Array.isArray((mappingResponse as any)?.sourceHeaders)
      ? ((mappingResponse as any).sourceHeaders as string[])
      : null;
    const fromColumns = (mappingResponse?.columns ?? []).map((c: ExcelColumnMapping) => c.excelHeader);
    const list = fromContract && fromContract.length > 0 ? fromContract : fromColumns;
    return Array.from(new Set(list));
  }, [mappingResponse]);

  const downloadErrorReport = async () => {
    if (!importResult) return;
    try {
      const blob = await apiFetchBlob(
        `/legacy-case-imports/${encodeURIComponent(String(importResult.batchId))}/error-report`,
        { timeoutMs: 60000 }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `legacy-import-errors-${String(importResult.batchId)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toastError(toast, err, "Failed to download error report");
    }
  };

  const retryFailedMutation = useMutation({
    mutationFn: async () => {
      if (!importResult) throw new Error("No result");
      const res = await apiRequest(
        `/legacy-case-imports/${encodeURIComponent(String(importResult.batchId))}/retry-failed`,
        { method: "POST", timeoutMs: 30000 }
      );
      const body = await res.json();
      return ((body?.data ?? body) as any) as BatchStatusResponse;
    },
    onSuccess: (data) => {
      setImportResult(data);
      toast({
        title: "Retry queued",
        description: "Failed rows have been re-submitted for processing.",
      });
    },
    onError: (err) => {
      toastError(toast, err, "Retry failed");
    },
  });

  const progressPct =
    selectedRowsForImport.length > 0
      ? Math.min(100, Math.round((completedRows / selectedRowsForImport.length) * 100))
      : 0;

  const summary = importResult?.summary;
  const resultCreated = summary?.imported ?? 0;
  const resultSkipped = summary?.duplicates ?? 0;
  const resultReview = summary?.reviewRequired ?? 0;
  const resultFailed = summary?.failed ?? 0;
  const resultTotal = summary?.total ?? resultCreated + resultSkipped + resultReview + resultFailed;

  const selectedRowUiStatus = selectedRow ? mapLegacyRowStatus(selectedRow.rowStatus) : null;

  return (
    <div className="space-y-6 pb-24 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Legacy Case Import</h1>
          <p className="text-slate-500 mt-1">
            Step {step} of 4 · {step === 1 && "Upload file"}
            {step === 2 && "Map columns to Lawcaspro fields"}
            {step === 3 && "Review and import"}
            {step === 4 && "Import complete"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs px-3 py-1">
            <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
            XLSX / XLSM / XLS / CSV
          </Badge>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="flex items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border ${
                step === (n as WizardStep)
                  ? "bg-amber-500 border-amber-500 text-white"
                  : step > n
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                  : "bg-slate-50 border-slate-200 text-slate-400"
              }`}
            >
              {step > n ? <CheckCircle2 className="w-4 h-4" /> : n}
            </div>
            {n < 4 && (
              <div
                className={`w-16 h-0.5 ${step > n ? "bg-emerald-200" : "bg-slate-200"}`}
              />
            )}
          </div>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <CardContent className="p-8">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
                isDragOver
                  ? "border-amber-400 bg-amber-50/50"
                  : "border-slate-200 hover:border-slate-300 bg-slate-50/30"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xlsm,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <Upload
                className={`w-12 h-12 mx-auto mb-4 ${isDragOver ? "text-amber-500" : "text-slate-400"}`}
              />
              <h3 className="text-lg font-semibold text-slate-900 mb-1">
                Drop your legacy data file here
              </h3>
              <p className="text-sm text-slate-500 mb-4">
                or click to browse from your computer
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {["XLSX", "XLSM", "XLS", "CSV"].map((fmt) => (
                  <Badge key={fmt} variant="secondary" className="text-xs">
                    {fmt}
                  </Badge>
                ))}
              </div>
              {uploadMutation.isPending && (
                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Uploading and parsing file…
                </div>
              )}
            </div>

            {uploadData && mappingResponse && (
              <>
                <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-xs text-slate-500 mb-1">File</div>
                    <div
                      className="text-sm font-medium text-slate-900 truncate"
                      title={uploadData.fileName}
                    >
                      {uploadData.fileName}
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-xs text-slate-500 mb-1">Sheet</div>
                    <div className="text-sm font-medium text-slate-900">
                      {uploadData.suggestedSheet}
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-xs text-slate-500 mb-1">Total Rows</div>
                    <div className="text-sm font-medium text-slate-900">
                      {uploadData.totalRows.toLocaleString()}
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-xs text-slate-500 mb-1">Format</div>
                    <div className="text-sm font-medium text-slate-900">
                      {uploadData.detectedFormat}
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <div className="text-xs text-slate-500 mb-1">Saved Mapping</div>
                    <div className="text-sm font-medium">
                      {uploadData.savedMappingAvailable ? (
                        <Badge
                          variant="secondary"
                          className="bg-emerald-50 text-emerald-700 border-emerald-200"
                        >
                          Available
                        </Badge>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </div>
                  </div>
                </div>
                {(mappingResponse.mappingSource === "saved_template" ||
                  mappingResponse.mappingSource === "auto_detected") && (
                  <div
                    className={`mt-4 p-3 rounded-md text-sm ${
                      mappingResponse.mappingSource === "saved_template"
                        ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                        : "bg-sky-50 border border-sky-200 text-sky-800"
                    }`}
                  >
                    {mappingResponse.mappingSource === "saved_template"
                      ? "Previous mapping applied — review column mapping below."
                      : "Known format detected — review column mapping below."}
                    {mappingResponse.mappingSourceWarning && (
                      <span className="ml-2 text-amber-700">
                        Note: {mappingResponse.mappingSourceWarning}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="mt-8 flex justify-end">
              <Button
                className="bg-amber-500 hover:bg-amber-600 text-white"
                disabled={!uploadData || uploadMutation.isPending}
                onClick={() => setStep(2)}
              >
                Continue
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <Card>
            <CardContent className="p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Import Settings</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">
                    Case Type
                  </label>
                  <div className="px-3 py-2 rounded-md border border-slate-200 bg-slate-50 text-sm font-medium text-slate-900 flex items-center gap-2">
                    <Badge variant="outline" className="text-xs px-2 py-0.5 bg-emerald-50 text-emerald-700 border-emerald-200">
                      Developer Sales
                    </Badge>
                    <span className="text-xs text-slate-500">Fixed for Legacy Import V1</span>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">
                    Project <span className="text-rose-600">*</span>
                  </label>
                  <Select
                    value={projectId === "" ? "" : String(projectId)}
                    onValueChange={(v) =>
                      setProjectId(v === "" ? "" : (Number(v) as number | ""))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select Project *" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">— None —</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">
                    Developer <span className="text-rose-600">*</span>
                  </label>
                  <Select
                    value={developerId === "" ? "" : String(developerId)}
                    onValueChange={(v) =>
                      setDeveloperId(v === "" ? "" : (Number(v) as number | ""))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select Developer *" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">— None —</SelectItem>
                      {developers.map((d) => (
                        <SelectItem key={d.id} value={String(d.id)}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">
                    Our Reference Handling
                  </label>
                  <div className="flex gap-6 pt-1">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={preserveRef}
                        onCheckedChange={(v) => setPreserveRef(!!v)}
                      />
                      <span className="text-sm text-slate-700">
                        Preserve Our Ref from file (default)
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={!preserveRef}
                        onCheckedChange={(v) => setPreserveRef(!v)}
                      />
                      <span className="text-sm text-slate-700">Auto-generate new Our Ref</span>
                    </label>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {GROUPS_ORDER.filter((g) => DEFAULT_EXPANDED_GROUPS.includes(g)).map((group) => {
            const rows = groupedMappings[group] ?? [];
            if (rows.length === 0) return null;
            const requiredCount = rows.filter((r) => r.required).length;
            const requiredMapped = rows.filter((r) => r.required && r.mappedExcelHeader).length;
            return (
              <Card key={group}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">{group}</h3>
                    {group === "Core Case" && requiredCount > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {requiredMapped} / {requiredCount} required mapped
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-1">
                    {rows.map((row) => {
                      const k =
                        row.arrayIndex !== undefined
                          ? `${row.target}#${row.arrayIndex}`
                          : row.target;
                      return (
                        <div
                          key={k}
                          className="grid grid-cols-12 gap-4 items-center py-2.5 border-b border-slate-100 last:border-0"
                        >
                          <div className="col-span-5 flex items-center gap-2">
                            <span className="text-sm text-slate-900">{row.label}</span>
                            {row.required && (
                              <Badge
                                variant="destructive"
                                className="text-[10px] px-1.5 py-0 h-4"
                              >
                                Required
                              </Badge>
                            )}
                          </div>
                          <div className="col-span-5">
                            <Select
                              value={row.mappedExcelHeader ?? ""}
                              onValueChange={(v) =>
                                updateMappingRow(k, v === "" ? null : v)
                              }
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select Excel column" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__ignore__">— Ignore —</SelectItem>
                                {possibleHeaders.map((c) => (
                                  <SelectItem key={c} value={c}>
                                    {c}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="col-span-2 flex justify-end" />
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <Card>
            <CardContent className="p-6">
              {!optionalExpanded ? (
                <button
                  type="button"
                  onClick={() => setOptionalExpanded(true)}
                  className="text-sm text-amber-600 hover:text-amber-700 font-medium"
                >
                  View Optional Fields (Existing Dates / Other)
                  <ChevronRight className="w-4 h-4 inline ml-0.5" />
                </button>
              ) : (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900">Optional Fields</h3>
                    <button
                      type="button"
                      onClick={() => setOptionalExpanded(false)}
                      className="text-sm text-slate-500 hover:text-slate-700"
                    >
                      Collapse
                    </button>
                  </div>
                  {GROUPS_ORDER.filter((g) => !DEFAULT_EXPANDED_GROUPS.includes(g)).map(
                    (group) => {
                      const rows = groupedMappings[group] ?? [];
                      if (rows.length === 0) return null;
                      const hint = OPTIONAL_GROUP_HINT[group];
                      const possibleHeaders = Array.from(
                        new Set(
                          (mappingResponse?.columns ?? []).map((c) => c.excelHeader)
                        )
                      );
                      return (
                        <div key={group} className="pt-2">
                          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                            {group}
                            {hint && (
                              <span className="ml-2 normal-case text-slate-400 font-normal">
                                — {hint}
                              </span>
                            )}
                          </h4>
                          <div className="space-y-1">
                            {rows.map((row) => {
                              const k =
                                row.arrayIndex !== undefined
                                  ? `${row.target}#${row.arrayIndex}`
                                  : row.target;
                              return (
                                <div
                                  key={k}
                                  className="grid grid-cols-12 gap-4 items-center py-2 border-b border-slate-100 last:border-0"
                                >
                                  <div className="col-span-5">
                                    <span className="text-sm text-slate-700">
                                      {row.label}
                                    </span>
                                  </div>
                                  <div className="col-span-5">
                                    <Select
                                      value={row.mappedExcelHeader ?? ""}
                                      onValueChange={(v) =>
                                        updateMappingRow(k, v === "" ? null : v)
                                      }
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select mapping" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__ignore__">
                                          — Ignore —
                                        </SelectItem>
                                        <SelectItem value="__snapshot__">
                                          Legacy Snapshot Only
                                        </SelectItem>
                                        {possibleHeaders.map((c) => (
                                          <SelectItem key={c} value={c}>
                                            {c}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="col-span-2 flex justify-end" />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox
                  checked={saveMappingChecked}
                  onCheckedChange={(v) => setSaveMappingChecked(!!v)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    Save this mapping for future M LEGASI Master Data files
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Next time you upload a file with matching column headers, Lawcaspro will
                    auto-apply this mapping.
                  </div>
                </div>
              </label>
            </CardContent>
          </Card>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)}>
              <ChevronLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            <div className="flex flex-col md:flex-row items-end gap-2">
              {(!projectId || !developerId) && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
                  Please select Project and Developer.
                </div>
              )}
              <Button
                className="bg-amber-500 hover:bg-amber-600 text-white"
                onClick={() => previewMutation.mutate()}
                disabled={
                  previewMutation.isPending ||
                  !projectId ||
                  !developerId
                }
              >
                {previewMutation.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Continue Preview
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-4 rounded-lg border bg-emerald-50/60 border-emerald-100">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-medium text-emerald-700">Ready</span>
              </div>
              <div className="text-2xl font-bold text-emerald-800">{previewCounts.ready}</div>
            </div>
            <div className="p-4 rounded-lg border bg-amber-50/60 border-amber-100">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span className="text-xs font-medium text-amber-700">Warnings</span>
              </div>
              <div className="text-2xl font-bold text-amber-800">{previewCounts.warning}</div>
            </div>
            <div className="p-4 rounded-lg border bg-orange-50/60 border-orange-100">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="w-4 h-4 text-orange-600" />
                <span className="text-xs font-medium text-orange-700">Needs Review</span>
              </div>
              <div className="text-2xl font-bold text-orange-800">{previewCounts.review}</div>
            </div>
            <div className="p-4 rounded-lg border bg-slate-50 border-slate-200">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-medium text-slate-600">Duplicates</span>
              </div>
              <div className="text-2xl font-bold text-slate-800">{previewCounts.duplicate}</div>
            </div>
          </div>

          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between mb-4">
                <Tabs
                  value={previewTab}
                  onValueChange={(v) => {
                    setPreviewTab(v as any);
                    setPreviewPage(1);
                  }}
                >
                  <TabsList className="h-auto p-1 bg-slate-100">
                    <TabsTrigger
                      value="all"
                      className="text-xs px-3 py-1.5 data-[state=active]:bg-white"
                    >
                      All
                      <span className="ml-1.5 text-slate-400 text-[10px]">
                        {previewTotal || previewRows.length}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="ready"
                      className="text-xs px-3 py-1.5 data-[state=active]:bg-white"
                    >
                      Ready
                      <span className="ml-1.5 text-slate-400 text-[10px]">
                        {previewCounts.ready}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="warning"
                      className="text-xs px-3 py-1.5 data-[state=active]:bg-white"
                    >
                      Warnings
                      <span className="ml-1.5 text-slate-400 text-[10px]">
                        {previewCounts.warning}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="review"
                      className="text-xs px-3 py-1.5 data-[state=active]:bg-white"
                    >
                      Review
                      <span className="ml-1.5 text-slate-400 text-[10px]">
                        {previewCounts.review}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="duplicate"
                      className="text-xs px-3 py-1.5 data-[state=active]:bg-white"
                    >
                      Duplicates
                      <span className="ml-1.5 text-slate-400 text-[10px]">
                        {previewCounts.duplicate}
                      </span>
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search current page only…"
                    className="pl-9 w-full md:w-80"
                    value={previewSearch}
                    onChange={(e) => {
                      setPreviewSearch(e.target.value);
                    }}
                  />
                </div>
              </div>

              <ScrollArea className="h-[520px] rounded-md border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 sticky top-0 z-10">
                    <tr className="text-xs text-slate-500 border-b border-slate-200">
                      <th className="text-left px-4 py-3 font-medium w-16">Row</th>
                      <th className="text-left px-4 py-3 font-medium w-36">Our Ref</th>
                      <th className="text-left px-4 py-3 font-medium w-56">Purchaser</th>
                      <th className="text-left px-4 py-3 font-medium w-56">Borrower</th>
                      <th className="text-left px-4 py-3 font-medium">Property</th>
                      <th className="text-left px-4 py-3 font-medium w-28">Result</th>
                      <th className="text-left px-4 py-3 font-medium w-48">Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => {
                      const s = mapLegacyRowStatus(row.rowStatus);
                      return (
                        <tr
                          key={String(row.id)}
                          className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer transition-colors"
                          onClick={() => setSelectedRowId(row.id)}
                        >
                          <td className="px-4 py-3 text-slate-500 font-mono text-xs">
                            {row.sourceRowNo ?? "—"}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-900">
                            {row.sourceReference || "—"}
                          </td>
                          <td
                            className="px-4 py-3 text-slate-800 truncate"
                            title={row.purchaserSummary ?? undefined}
                          >
                            {row.purchaserSummary || "—"}
                          </td>
                          <td
                            className="px-4 py-3 text-slate-800 truncate"
                            title={row.borrowerSummary ?? undefined}
                          >
                            {row.borrowerSummary || "—"}
                          </td>
                          <td
                            className="px-4 py-3 text-slate-800 truncate"
                            title={row.propertySummary ?? undefined}
                          >
                            {row.propertySummary || "—"}
                          </td>
                          <td className="px-4 py-3">
                            {s === "ready" && (
                              <Badge
                                variant="secondary"
                                className="bg-emerald-50 text-emerald-700 border-emerald-200"
                              >
                                Ready
                              </Badge>
                            )}
                            {s === "warning" && (
                              <Badge
                                variant="secondary"
                                className="bg-amber-50 text-amber-700 border-amber-200"
                              >
                                Warning
                              </Badge>
                            )}
                            {(s === "review" || s === "invalid") && (
                              <Badge
                                variant="secondary"
                                className="bg-orange-50 text-orange-700 border-orange-200"
                              >
                                Review
                              </Badge>
                            )}
                            {s === "duplicate" && (
                              <Badge variant="outline" className="border-slate-300 text-slate-600">
                                Duplicate
                              </Badge>
                            )}
                            {s === "imported" && (
                              <Badge
                                variant="secondary"
                                className="bg-emerald-50 text-emerald-700 border-emerald-200"
                              >
                                Imported
                              </Badge>
                            )}
                            {s === "failed" && (
                              <Badge
                                variant="secondary"
                                className="bg-rose-50 text-rose-700 border-rose-200"
                              >
                                Failed
                              </Badge>
                            )}
                            {s === "pending" && (
                              <Badge variant="outline" className="border-slate-300 text-slate-600">
                                Pending
                              </Badge>
                            )}
                          </td>
                          <td
                            className="px-4 py-3 text-xs text-slate-500 truncate"
                            title={(row.warnings ?? [])
                              .concat(row.errors ?? [])
                              .map((i: { message: string }) => i.message)
                              .join("; ")}
                          >
                            {(() => {
                              const issues = (row.warnings ?? []).concat(row.errors ?? []);
                              return (
                                <>
                                  {issues[0]?.message || "—"}
                                  {issues.length > 1 && ` +${issues.length - 1}`}
                                </>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredRows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-16 text-center text-sm text-slate-400">
                          No rows match current filters
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </ScrollArea>

              <div className="flex items-center justify-between mt-4 pt-2">
                <div className="text-xs text-slate-500">
                  Showing{" "}
                  {previewRows.length === 0
                    ? 0
                    : (previewPage - 1) * PAGE_SIZE + 1}
                  –{Math.min(previewPage * PAGE_SIZE, previewTotal || previewRows.length)} of{" "}
                  {previewTotal || previewRows.length}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={previewPage <= 1}
                    onClick={() => setPreviewPage((p) => p - 1)}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-xs text-slate-600 min-w-[60px] text-center">
                    {previewPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={previewPage >= totalPages}
                    onClick={() => setPreviewPage((p) => p + 1)}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-between items-center">
            <Button variant="outline" onClick={() => setStep(2)}>
              <ChevronLeft className="w-4 h-4 mr-1" />
              Back to Mapping
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Button
                    className="bg-amber-500 hover:bg-amber-600 text-white"
                    onClick={handleStartImport}
                    disabled={importableCount === 0 || showProgressDialog}
                  >
                    {showProgressDialog && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    Import {importableCount} {importableCount === 1 ? "Case" : "Cases"}
                  </Button>
                </div>
              </TooltipTrigger>
              {importableCount === 0 && (
                <TooltipContent>No rows available for import</TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>
      )}

      {step === 4 && importResult && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-4 rounded-lg border bg-emerald-50/60 border-emerald-100">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-medium text-emerald-700">Created</span>
              </div>
              <div className="text-2xl font-bold text-emerald-800">{resultCreated}</div>
            </div>
            <div className="p-4 rounded-lg border bg-slate-50 border-slate-200">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-medium text-slate-600">Skipped (Duplicates)</span>
              </div>
              <div className="text-2xl font-bold text-slate-800">{resultSkipped}</div>
            </div>
            <div className="p-4 rounded-lg border bg-orange-50/60 border-orange-100">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="w-4 h-4 text-orange-600" />
                <span className="text-xs font-medium text-orange-700">Need Review</span>
              </div>
              <div className="text-2xl font-bold text-orange-800">{resultReview}</div>
            </div>
            <div className="p-4 rounded-lg border bg-rose-50/60 border-rose-100">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-rose-600" />
                <span className="text-xs font-medium text-rose-700">Failed</span>
              </div>
              <div className="text-2xl font-bold text-rose-800">{resultFailed}</div>
            </div>
          </div>

          <Card>
            <CardContent className="p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Import Complete</h3>
              <p className="text-sm text-slate-600 mb-6">
                {resultCreated > 0
                  ? `${resultCreated.toLocaleString()} new case${
                      resultCreated === 1 ? "" : "s"
                    } created successfully. `
                  : ""}
                {resultSkipped > 0
                  ? `${resultSkipped} duplicate${resultSkipped === 1 ? "" : "s"} skipped. `
                  : ""}
                {resultReview > 0
                  ? `${resultReview} row${resultReview === 1 ? "" : "s"} need manual review. `
                  : ""}
                {resultFailed > 0
                  ? `${resultFailed} row${
                      resultFailed === 1 ? "" : "s"
                    } failed — download the error report below and retry.`
                  : ""}
                {resultCreated === 0 && resultSkipped === 0 && resultReview === 0 && resultFailed === 0
                  ? `${resultTotal.toLocaleString()} total rows processed.`
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/app/cases">
                  <Button className="bg-amber-500 hover:bg-amber-600 text-white">
                    View Imported Cases
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </Link>
                {resultFailed > 0 && (
                  <Button variant="outline" onClick={downloadErrorReport}>
                    <Download className="w-4 h-4 mr-2" />
                    Download Error Rows
                  </Button>
                )}
                {resultFailed > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => retryFailedMutation.mutate()}
                    disabled={retryFailedMutation.isPending}
                  >
                    {retryFailedMutation.isPending && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    <Plus className="w-4 h-4 mr-2" />
                    Retry Failed Rows
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Recent Imports</h3>
              <div className="overflow-x-auto">
                {recentImportsQuery.isError && (
                  <div className="mb-3 p-3 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-800">
                    Failed to load recent imports.
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500 border-b border-slate-200">
                      <th className="text-left py-3 px-2 font-medium">File</th>
                      <th className="text-left py-3 px-2 font-medium">Date</th>
                      <th className="text-left py-3 px-2 font-medium">By</th>
                      <th className="text-right py-3 px-2 font-medium">Created</th>
                      <th className="text-right py-3 px-2 font-medium">Failed</th>
                      <th className="text-left py-3 px-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(recentImportsQuery.data ?? []).map((imp) => (
                      <tr
                        key={String(imp.batchId)}
                        className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                      >
                        <td
                          className="py-3 px-2 text-slate-900 truncate max-w-[240px]"
                          title={imp.fileName}
                        >
                          <div className="flex items-center gap-2">
                            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="truncate">{imp.fileName}</span>
                          </div>
                        </td>
                        <td className="py-3 px-2 text-slate-600 text-xs">
                          {imp.importedAt || "—"}
                        </td>
                        <td className="py-3 px-2 text-slate-600 text-xs">
                          {imp.importedBy || "—"}
                        </td>
                        <td className="py-3 px-2 text-right font-medium text-emerald-700">
                          {imp.created}
                        </td>
                        <td className="py-3 px-2 text-right font-medium text-rose-700">
                          {imp.failed || 0}
                        </td>
                        <td className="py-3 px-2">
                          <Badge
                            variant="secondary"
                            className={
                              imp.status === "completed"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : imp.status === "failed"
                                ? "bg-rose-50 text-rose-700 border-rose-200"
                                : "bg-amber-50 text-amber-700 border-amber-200"
                            }
                          >
                            {imp.status || "processing"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                    {(recentImportsQuery.data ?? []).length === 0 &&
                      !recentImportsQuery.isError &&
                      !recentImportsQuery.isFetching && (
                        <tr>
                          <td
                            colSpan={6}
                            className="py-8 text-center text-xs text-slate-400"
                          >
                            No recent imports
                          </td>
                        </tr>
                      )}
                    {recentImportsQuery.isFetching &&
                      (recentImportsQuery.data ?? []).length === 0 && (
                        <tr>
                          <td
                            colSpan={6}
                            className="py-8 text-center text-xs text-slate-400"
                          >
                            <Loader2 className="w-4 h-4 inline animate-spin mr-2" />
                            Loading recent imports…
                          </td>
                        </tr>
                      )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={!!selectedRow} onOpenChange={(o) => !o && setSelectedRowId(null)}>
        <DialogContent className="max-w-3xl">
          {selectedRow && selectedRowUiStatus && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  Row {selectedRow.sourceRowNo ?? "?"} ·{" "}
                  {selectedRow.sourceReference || "No Ref"}
                  {selectedRowUiStatus === "ready" && (
                    <Badge
                      variant="secondary"
                      className="bg-emerald-50 text-emerald-700 border-emerald-200"
                    >
                      Ready
                    </Badge>
                  )}
                  {selectedRowUiStatus === "warning" && (
                    <Badge
                      variant="secondary"
                      className="bg-amber-50 text-amber-700 border-amber-200"
                    >
                      Warning
                    </Badge>
                  )}
                  {selectedRowUiStatus === "review" && (
                    <Badge
                      variant="secondary"
                      className="bg-orange-50 text-orange-700 border-orange-200"
                    >
                      Needs Review
                    </Badge>
                  )}
                  {selectedRowUiStatus === "duplicate" && (
                    <Badge variant="outline" className="border-slate-300 text-slate-600">
                      Duplicate
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription>Review row details and decide next action</DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Our Ref</div>
                  <div className="font-mono text-slate-900">
                    {selectedRow.sourceReference || "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Purchaser</div>
                  <div className="text-slate-900">{selectedRow.purchaserSummary || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Borrower</div>
                  <div className="text-slate-900">{selectedRow.borrowerSummary || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Property Summary</div>
                  <div className="text-slate-900">{selectedRow.propertySummary || "—"}</div>
                </div>
              </div>

              {((selectedRow.warnings?.length ?? 0) + (selectedRow.errors?.length ?? 0)) > 0 && (
                <div className="p-3 rounded-md bg-amber-50 border border-amber-200">
                  <div className="text-xs font-semibold text-amber-800 mb-2 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Issues
                  </div>
                  <ul className="text-xs text-amber-900 space-y-1">
                    {(selectedRow.warnings ?? [])
                      .concat(selectedRow.errors ?? [])
                      .map((i: { message: string }, idx: number) => (
                        <li key={idx}>· {i.message}</li>
                      ))}
                  </ul>
                </div>
              )}

              {selectedRow.duplicateCaseId && (
                <div className="p-4 rounded-md border border-slate-200 bg-slate-50">
                  <div className="text-xs font-semibold text-slate-700 mb-3">
                    Possible Duplicate — Excel vs Existing Case
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="text-slate-500 mb-1">Excel Row</div>
                      <div className="p-3 rounded border border-slate-200 bg-white space-y-1">
                        <div>
                          <span className="text-slate-500">Our Ref:</span>{" "}
                          <span className="font-mono">
                            {selectedRow.sourceReference || "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">Purchaser:</span>{" "}
                          {selectedRow.purchaserSummary || "—"}
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500 mb-1">
                        Lawcaspro Case #{selectedRow.duplicateCaseId}
                      </div>
                      <div className="p-3 rounded border border-slate-200 bg-white space-y-1">
                        <div>
                          <span className="text-slate-500">Case ID:</span>{" "}
                          <span className="font-mono">{selectedRow.duplicateCaseId}</span>
                        </div>
                        {selectedRow.duplicateType && (
                          <div>
                            <span className="text-slate-500">Match type:</span>{" "}
                            {selectedRow.duplicateType}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:justify-end">
                <Button variant="outline" onClick={handleSkipRow}>
                  <XCircle className="w-4 h-4 mr-1.5" />
                  Skip
                </Button>
                {selectedRow.duplicateCaseId && (
                  <Link
                    href={`/app/cases/${encodeURIComponent(String(selectedRow.duplicateCaseId))}`}
                  >
                    <Button variant="secondary">Open Existing Case</Button>
                  </Link>
                )}
                <Button
                  className="bg-amber-500 hover:bg-amber-600 text-white"
                  onClick={handleImportAnyway}
                >
                  Import Anyway
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showProgressDialog} onOpenChange={(o) => !o && setShowProgressDialog(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Importing cases…</DialogTitle>
            <DialogDescription>
              Please keep this tab open while we import your data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs text-slate-600 mb-2">
                <span>
                  {completedRows} / {selectedRowsForImport.length} processed
                </span>
                <span>{progressPct}%</span>
              </div>
              <Progress value={progressPct} />
            </div>
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div className="p-2 rounded bg-slate-50 text-slate-700">
                <div className="font-bold text-base">{completedRows}</div>
                Sent
              </div>
              <div className="p-2 rounded bg-slate-50 text-slate-700">
                <div className="font-bold text-base">
                  {Math.max(0, selectedRowsForImport.length - completedRows)}
                </div>
                Remaining
              </div>
              <div className="p-2 rounded bg-emerald-50 text-emerald-700">
                <div className="font-bold text-base">{resultCreated}</div>
                Created
              </div>
              <div className="p-2 rounded bg-rose-50 text-rose-700">
                <div className="font-bold text-base">{resultFailed}</div>
                Failed
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
