import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Link, useLocation } from "wouter";
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
  Filter,
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

type WizardStep = 1 | 2 | 3 | 4;

type UploadResponse = {
  batchId: string;
  fileName: string;
  suggestedSheet: string;
  totalRows: number;
  detectedFormat: string;
  savedMappingAvailable: boolean;
  columns: string[];
  autoMappings: Record<string, string>;
};

type MappingRow = {
  fieldKey: string;
  fieldLabel: string;
  required: boolean;
  group: "core" | "dates" | "address" | "loan" | "other";
  mappedColumn: string | null;
  autoMapped: boolean;
  needsReview: boolean;
};

type PreviewRow = {
  rowIndex: number;
  ourRef: string;
  purchaser: string;
  property: string;
  status: "ready" | "warning" | "review" | "duplicate";
  issues: string[];
  duplicateCaseId?: number;
  rawData: Record<string, unknown>;
};

type ImportResult = {
  batchId: string;
  created: number;
  skippedDuplicates: number;
  needReview: number;
  failed: number;
  total: number;
  status: "processing" | "completed" | "failed";
};

type RecentImport = {
  batchId: string;
  fileName: string;
  importedAt: string;
  importedBy: string;
  created: number;
  failed: number;
  status: string;
};

const CORE_FIELDS = [
  { key: "ourRef", label: "Our Ref", required: true },
  { key: "purchaser1Ic", label: "Purchaser 1 IC", required: true },
  { key: "purchaser2Ic", label: "Purchaser 2 IC", required: false },
  { key: "purchaser3Ic", label: "Purchaser 3 IC", required: false },
  { key: "purchaser4Ic", label: "Purchaser 4 IC", required: false },
  { key: "parcelNo", label: "Parcel No", required: true },
  { key: "property", label: "Property", required: true },
  { key: "purchasePrice", label: "Purchase Price", required: true },
  { key: "borrower1Ic", label: "Borrower 1 IC", required: false },
  { key: "borrower2Ic", label: "Borrower 2 IC", required: false },
  { key: "borrower3Ic", label: "Borrower 3 IC", required: false },
  { key: "borrower4Ic", label: "Borrower 4 IC", required: false },
  { key: "endFinancier", label: "End Financier", required: false },
];

const OPTIONAL_DATE_FIELDS = [
  { key: "spaDate", label: "SPA Date" },
  { key: "loanOfferDate", label: "Loan Offer Date" },
  { key: "loanAcceptanceDate", label: "Loan Acceptance Date" },
  { key: "caveatLodgedDate", label: "Caveat Lodged Date" },
  { key: "completionDate", label: "Completion / MOT Date" },
];

const OPTIONAL_ADDRESS_FIELDS = [
  { key: "purchaserAddress", label: "Purchaser Address" },
  { key: "borrowerAddress", label: "Borrower Address" },
  { key: "developerAddress", label: "Developer Address" },
];

const OPTIONAL_LOAN_FIELDS = [
  { key: "loanAmount", label: "Loan Amount" },
  { key: "loanMargin", label: "Loan Margin %" },
  { key: "loanTenure", label: "Loan Tenure" },
  { key: "interestRate", label: "Interest Rate" },
];

const OPTIONAL_OTHER_FIELDS = [
  { key: "projectName", label: "Project Name" },
  { key: "developerName", label: "Developer Name" },
  { key: "caseType", label: "Case Type" },
  { key: "lawyerAssigned", label: "Lawyer Assigned" },
  { key: "clerkAssigned", label: "Clerk Assigned" },
];

const CASE_TYPES = [
  "Strata Sale (Individual Title)",
  "Strata Sale (Master Title)",
  "Subsale",
  "Commercial Sale",
  "Refinance",
  "Transfer of Equity",
];

const SYSTEM_DATE_TARGETS = [
  "SPA Date",
  "Loan Offer Date",
  "Loan Acceptance Date",
  "Caveat Lodged Date",
  "Completion / MOT Date",
  "Legacy Snapshot Only",
  "Ignore",
];

const PAGE_SIZE = 50;

export default function LegacyCaseImportPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<WizardStep>(1);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadData, setUploadData] = useState<UploadResponse | null>(null);
  const [caseType, setCaseType] = useState<string>("");
  const [refPreserveMode, setRefPreserveMode] = useState<"preserve" | "override">("preserve");
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [optionalExpanded, setOptionalExpanded] = useState(false);
  const [saveMappingChecked, setSaveMappingChecked] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewTab, setPreviewTab] = useState<"all" | "ready" | "warning" | "review" | "duplicate">("all");
  const [previewSearch, setPreviewSearch] = useState("");
  const [previewPage, setPreviewPage] = useState(1);
  const [selectedRow, setSelectedRow] = useState<PreviewRow | null>(null);
  const [showProgressDialog, setShowProgressDialog] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [progressPollInterval, setProgressPollInterval] = useState<number | null>(null);

  const recentImportsQuery = useQuery<RecentImport[]>({
    queryKey: ["legacy-imports", "recent"],
    queryFn: async () => {
      try {
        const r = await apiFetchJson<RecentImport[]>("/legacy-case-imports/recent");
        return (r as any)?.data ?? r ?? [];
      } catch {
        return [];
      }
    },
    enabled: step === 4,
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
      return (body?.data ?? body) as UploadResponse;
    },
    onSuccess: (data) => {
      setUploadData(data);
      const rows: MappingRow[] = [
        ...CORE_FIELDS.map((f) => ({
          fieldKey: f.key,
          fieldLabel: f.label,
          required: f.required,
          group: "core" as const,
          mappedColumn: data.autoMappings[f.key] ?? null,
          autoMapped: !!data.autoMappings[f.key],
          needsReview: false,
        })),
        ...OPTIONAL_DATE_FIELDS.map((f) => ({
          fieldKey: f.key,
          fieldLabel: f.label,
          required: false,
          group: "dates" as const,
          mappedColumn: data.autoMappings[f.key] ?? null,
          autoMapped: !!data.autoMappings[f.key],
          needsReview: false,
        })),
        ...OPTIONAL_ADDRESS_FIELDS.map((f) => ({
          fieldKey: f.key,
          fieldLabel: f.label,
          required: false,
          group: "address" as const,
          mappedColumn: data.autoMappings[f.key] ?? null,
          autoMapped: !!data.autoMappings[f.key],
          needsReview: false,
        })),
        ...OPTIONAL_LOAN_FIELDS.map((f) => ({
          fieldKey: f.key,
          fieldLabel: f.label,
          required: false,
          group: "loan" as const,
          mappedColumn: data.autoMappings[f.key] ?? null,
          autoMapped: !!data.autoMappings[f.key],
          needsReview: false,
        })),
        ...OPTIONAL_OTHER_FIELDS.map((f) => ({
          fieldKey: f.key,
          fieldLabel: f.label,
          required: false,
          group: "other" as const,
          mappedColumn: data.autoMappings[f.key] ?? null,
          autoMapped: !!data.autoMappings[f.key],
          needsReview: false,
        })),
      ];
      setMappings(rows);
    },
    onError: (err) => {
      toastError(toast, err, "Upload failed");
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        batchId: uploadData!.batchId,
        caseType,
        refPreserveMode,
        mappings: mappings.map((m) => ({
          fieldKey: m.fieldKey,
          column: m.mappedColumn,
        })),
        saveMapping: saveMappingChecked,
      };
      const res = await apiRequest("/legacy-case-imports/preview", {
        method: "POST",
        body: payload,
        timeoutMs: 60000,
      });
      const body = await res.json();
      return (body?.data ?? body) as { rows: PreviewRow[] };
    },
    onSuccess: (data) => {
      setPreviewRows(data.rows);
      setStep(3);
    },
    onError: (err) => {
      toastError(toast, err, "Failed to generate preview");
    },
  });

  const startImportMutation = useMutation({
    mutationFn: async (rowIndices: number[]) => {
      const payload = {
        batchId: uploadData!.batchId,
        rowIndices,
      };
      const res = await apiRequest("/legacy-case-imports/start", {
        method: "POST",
        body: payload,
        timeoutMs: 30000,
      });
      const body = await res.json();
      return (body?.data ?? body) as ImportResult;
    },
    onSuccess: (initialResult) => {
      setImportProgress(initialResult);
      setShowProgressDialog(true);
      beginProgressPolling(initialResult.batchId);
    },
    onError: (err) => {
      toastError(toast, err, "Failed to start import");
    },
  });

  const beginProgressPolling = useCallback((batchId: string) => {
    if (progressPollInterval) window.clearInterval(progressPollInterval);
    const id = window.setInterval(async () => {
      try {
        const r = await apiFetchJson<ImportResult>(`/legacy-case-imports/${batchId}`);
        const data = (r as any)?.data ?? r;
        setImportProgress(data);
        if (data.status === "completed" || data.status === "failed") {
          window.clearInterval(id);
          setProgressPollInterval(null);
          setImportResult(data);
          setShowProgressDialog(false);
          setStep(4);
        }
      } catch {
      }
    }, 1200);
    setProgressPollInterval(id);
  }, [progressPollInterval]);

  useEffect(() => {
    return () => {
      if (progressPollInterval) window.clearInterval(progressPollInterval);
    };
  }, [progressPollInterval]);

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
    const counts = { ready: 0, warning: 0, review: 0, duplicate: 0 };
    for (const r of previewRows) counts[r.status]++;
    return counts;
  }, [previewRows]);

  const filteredRows = useMemo(() => {
    let rows = previewRows;
    if (previewTab !== "all") rows = rows.filter((r) => r.status === previewTab);
    if (previewSearch.trim()) {
      const q = previewSearch.trim().toLowerCase();
      rows = rows.filter((r) =>
        r.ourRef.toLowerCase().includes(q) ||
        r.purchaser.toLowerCase().includes(q) ||
        r.property.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [previewRows, previewTab, previewSearch]);

  const pagedRows = useMemo(() => {
    const start = (previewPage - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, previewPage]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));

  const importableCount = previewCounts.ready + previewCounts.warning;

  const handleStartImport = () => {
    const indices = previewRows
      .filter((r) => r.status === "ready" || r.status === "warning")
      .map((r) => r.rowIndex);
    startImportMutation.mutate(indices);
  };

  const handleSkipRow = () => {
    if (!selectedRow) return;
    setPreviewRows((prev) =>
      prev.map((r) =>
        r.rowIndex === selectedRow.rowIndex ? { ...r, status: "review" as const } : r
      )
    );
    setSelectedRow(null);
  };

  const handleImportAnyway = () => {
    if (!selectedRow) return;
    setPreviewRows((prev) =>
      prev.map((r) =>
        r.rowIndex === selectedRow.rowIndex ? { ...r, status: "ready" as const, issues: [] } : r
      )
    );
    setSelectedRow(null);
  };

  const downloadErrorReport = async () => {
    if (!importResult) return;
    try {
      const blob = await apiFetchBlob(`/legacy-case-imports/${importResult.batchId}/error-report`, {
        timeoutMs: 60000,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `legacy-import-errors-${importResult.batchId}.xlsx`;
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
      const res = await apiRequest(`/legacy-case-imports/${importResult!.batchId}/retry-failed`, {
        method: "POST",
        timeoutMs: 30000,
      });
      const body = await res.json();
      return (body?.data ?? body) as ImportResult;
    },
    onSuccess: (data) => {
      setImportResult(data);
      toast({ title: "Retry queued", description: "Failed rows have been re-submitted for processing." });
    },
    onError: (err) => {
      toastError(toast, err, "Retry failed");
    },
  });

  const progressPct = importProgress
    ? Math.round(((importProgress.created + importProgress.skippedDuplicates + importProgress.needReview + importProgress.failed) / importProgress.total) * 100)
    : 0;

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
                step === n
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

            {uploadData && (
              <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-xs text-slate-500 mb-1">File</div>
                  <div className="text-sm font-medium text-slate-900 truncate" title={uploadData.fileName}>
                    {uploadData.fileName}
                  </div>
                </div>
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-xs text-slate-500 mb-1">Sheet</div>
                  <div className="text-sm font-medium text-slate-900">{uploadData.suggestedSheet}</div>
                </div>
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-xs text-slate-500 mb-1">Total Rows</div>
                  <div className="text-sm font-medium text-slate-900">{uploadData.totalRows.toLocaleString()}</div>
                </div>
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-xs text-slate-500 mb-1">Format</div>
                  <div className="text-sm font-medium text-slate-900">{uploadData.detectedFormat}</div>
                </div>
                <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-xs text-slate-500 mb-1">Saved Mapping</div>
                  <div className="text-sm font-medium">
                    {uploadData.savedMappingAvailable ? (
                      <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">Available</Badge>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </div>
                </div>
              </div>
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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">Case Type (default)</label>
                  <Select value={caseType} onValueChange={setCaseType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select case type" />
                    </SelectTrigger>
                    <SelectContent>
                      {CASE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">Our Reference Handling</label>
                  <div className="flex gap-6 pt-1">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={refPreserveMode === "preserve"}
                        onCheckedChange={() => setRefPreserveMode("preserve")}
                      />
                      <span className="text-sm text-slate-700">Preserve Our Ref from file</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={refPreserveMode === "override"}
                        onCheckedChange={() => setRefPreserveMode("override")}
                      />
                      <span className="text-sm text-slate-700">Auto-generate new Our Ref</span>
                    </label>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-900">Core Data</h3>
                <Badge variant="outline" className="text-xs">
                  {mappings.filter((m) => m.group === "core" && m.required && m.mappedColumn).length} / {mappings.filter((m) => m.group === "core" && m.required).length} required mapped
                </Badge>
              </div>
              <div className="space-y-1">
                {mappings.filter((m) => m.group === "core").map((row) => (
                  <div
                    key={row.fieldKey}
                    className="grid grid-cols-12 gap-4 items-center py-2.5 border-b border-slate-100 last:border-0"
                  >
                    <div className="col-span-5 flex items-center gap-2">
                      <span className="text-sm text-slate-900">{row.fieldLabel}</span>
                      {row.required && <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">Required</Badge>}
                    </div>
                    <div className="col-span-5">
                      <Select
                        value={row.mappedColumn ?? ""}
                        onValueChange={(v) => {
                          setMappings((prev) =>
                            prev.map((m) =>
                              m.fieldKey === row.fieldKey
                                ? { ...m, mappedColumn: v || null, autoMapped: false, needsReview: false }
                                : m
                            )
                          );
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select Excel column" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__ignore__">— Ignore —</SelectItem>
                          {uploadData?.columns.map((c) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2 flex justify-end">
                      {row.autoMapped && row.mappedColumn && (
                        <Badge variant="secondary" className="text-[10px] bg-sky-50 text-sky-700 border-sky-200">Auto</Badge>
                      )}
                      {row.needsReview && row.mappedColumn && (
                        <Badge variant="secondary" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">Review</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              {!optionalExpanded ? (
                <button
                  type="button"
                  onClick={() => setOptionalExpanded(true)}
                  className="text-sm text-amber-600 hover:text-amber-700 font-medium"
                >
                  View Optional Fields (Dates / Address / Loan / Other)
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

                  {["dates", "address", "loan", "other"].map((group) => {
                    const groupRows = mappings.filter((m) => m.group === group);
                    if (groupRows.length === 0) return null;
                    const groupLabel = group === "dates" ? "Dates" : group === "address" ? "Address" : group === "loan" ? "Loan" : "Other";
                    return (
                      <div key={group} className="pt-2">
                        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">{groupLabel}</h4>
                        <div className="space-y-1">
                          {groupRows.map((row) => (
                            <div
                              key={row.fieldKey}
                              className="grid grid-cols-12 gap-4 items-center py-2 border-b border-slate-100 last:border-0"
                            >
                              <div className="col-span-5">
                                <span className="text-sm text-slate-700">{row.fieldLabel}</span>
                              </div>
                              <div className="col-span-5">
                                {row.group === "dates" ? (
                                  <Select
                                    value={row.mappedColumn ?? ""}
                                    onValueChange={(v) => {
                                      setMappings((prev) =>
                                        prev.map((m) =>
                                          m.fieldKey === row.fieldKey
                                            ? { ...m, mappedColumn: v || null, autoMapped: false }
                                            : m
                                        )
                                      );
                                    }}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="Map to system date" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__ignore__" className="text-slate-400">Ignore</SelectItem>
                                      <SelectItem value="__snapshot__">Legacy Snapshot Only</SelectItem>
                                      {SYSTEM_DATE_TARGETS.slice(0, 5).map((d) => (
                                        <SelectItem key={d} value={`date:${d}`}>{d}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : (
                                  <Select
                                    value={row.mappedColumn ?? ""}
                                    onValueChange={(v) => {
                                      setMappings((prev) =>
                                        prev.map((m) =>
                                          m.fieldKey === row.fieldKey
                                            ? { ...m, mappedColumn: v || null, autoMapped: false }
                                            : m
                                        )
                                      );
                                    }}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="Select mapping" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__ignore__" className="text-slate-400">Ignore</SelectItem>
                                      <SelectItem value="__snapshot__">Legacy Snapshot Only</SelectItem>
                                      {uploadData?.columns.map((c) => (
                                        <SelectItem key={c} value={c}>{c}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}
                              </div>
                              <div className="col-span-2 flex justify-end">
                                {row.autoMapped && row.mappedColumn && (
                                  <Badge variant="secondary" className="text-[10px] bg-sky-50 text-sky-700 border-sky-200">Auto</Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
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
                    Next time you upload a file with matching column headers, Lawcaspro will auto-apply this mapping.
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
            <Button
              className="bg-amber-500 hover:bg-amber-600 text-white"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
            >
              {previewMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Continue Preview
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
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
                <Tabs value={previewTab} onValueChange={(v) => { setPreviewTab(v as any); setPreviewPage(1); }}>
                  <TabsList className="h-auto p-1 bg-slate-100">
                    <TabsTrigger value="all" className="text-xs px-3 py-1.5 data-[state=active]:bg-white">
                      All
                      <span className="ml-1.5 text-slate-400 text-[10px]">{previewRows.length}</span>
                    </TabsTrigger>
                    <TabsTrigger value="ready" className="text-xs px-3 py-1.5 data-[state=active]:bg-white">
                      Ready
                      <span className="ml-1.5 text-slate-400 text-[10px]">{previewCounts.ready}</span>
                    </TabsTrigger>
                    <TabsTrigger value="warning" className="text-xs px-3 py-1.5 data-[state=active]:bg-white">
                      Warnings
                      <span className="ml-1.5 text-slate-400 text-[10px]">{previewCounts.warning}</span>
                    </TabsTrigger>
                    <TabsTrigger value="review" className="text-xs px-3 py-1.5 data-[state=active]:bg-white">
                      Review
                      <span className="ml-1.5 text-slate-400 text-[10px]">{previewCounts.review}</span>
                    </TabsTrigger>
                    <TabsTrigger value="duplicate" className="text-xs px-3 py-1.5 data-[state=active]:bg-white">
                      Duplicates
                      <span className="ml-1.5 text-slate-400 text-[10px]">{previewCounts.duplicate}</span>
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search Our Ref / Purchaser / Property…"
                    className="pl-9 w-full md:w-72"
                    value={previewSearch}
                    onChange={(e) => { setPreviewSearch(e.target.value); setPreviewPage(1); }}
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
                      <th className="text-left px-4 py-3 font-medium">Property</th>
                      <th className="text-left px-4 py-3 font-medium w-28">Result</th>
                      <th className="text-left px-4 py-3 font-medium w-48">Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row) => (
                      <tr
                        key={row.rowIndex}
                        className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer transition-colors"
                        onClick={() => setSelectedRow(row)}
                      >
                        <td className="px-4 py-3 text-slate-500 font-mono text-xs">{row.rowIndex + 1}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-900">{row.ourRef || "—"}</td>
                        <td className="px-4 py-3 text-slate-800 truncate" title={row.purchaser}>
                          {row.purchaser || "—"}
                        </td>
                        <td className="px-4 py-3 text-slate-800 truncate" title={row.property}>
                          {row.property || "—"}
                        </td>
                        <td className="px-4 py-3">
                          {row.status === "ready" && (
                            <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">Ready</Badge>
                          )}
                          {row.status === "warning" && (
                            <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200">Warning</Badge>
                          )}
                          {row.status === "review" && (
                            <Badge variant="secondary" className="bg-orange-50 text-orange-700 border-orange-200">Review</Badge>
                          )}
                          {row.status === "duplicate" && (
                            <Badge variant="outline" className="border-slate-300 text-slate-600">Duplicate</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500 truncate" title={row.issues.join("; ")}>
                          {row.issues[0] || "—"}
                          {row.issues.length > 1 && ` +${row.issues.length - 1}`}
                        </td>
                      </tr>
                    ))}
                    {pagedRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-16 text-center text-sm text-slate-400">
                          No rows match current filters
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </ScrollArea>

              <div className="flex items-center justify-between mt-4 pt-2">
                <div className="text-xs text-slate-500">
                  Showing {filteredRows.length === 0 ? 0 : (previewPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(previewPage * PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
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
                    disabled={importableCount === 0 || startImportMutation.isPending}
                  >
                    {startImportMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
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
              <div className="text-2xl font-bold text-emerald-800">{importResult.created}</div>
            </div>
            <div className="p-4 rounded-lg border bg-slate-50 border-slate-200">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-medium text-slate-600">Skipped (Duplicates)</span>
              </div>
              <div className="text-2xl font-bold text-slate-800">{importResult.skippedDuplicates}</div>
            </div>
            <div className="p-4 rounded-lg border bg-orange-50/60 border-orange-100">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="w-4 h-4 text-orange-600" />
                <span className="text-xs font-medium text-orange-700">Need Review</span>
              </div>
              <div className="text-2xl font-bold text-orange-800">{importResult.needReview}</div>
            </div>
            <div className="p-4 rounded-lg border bg-rose-50/60 border-rose-100">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-rose-600" />
                <span className="text-xs font-medium text-rose-700">Failed</span>
              </div>
              <div className="text-2xl font-bold text-rose-800">{importResult.failed}</div>
            </div>
          </div>

          <Card>
            <CardContent className="p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Import Complete</h3>
              <p className="text-sm text-slate-600 mb-6">
                {importResult.created > 0
                  ? `${importResult.created.toLocaleString()} new case${importResult.created === 1 ? "" : "s"} created successfully. `
                  : ""}
                {importResult.skippedDuplicates > 0
                  ? `${importResult.skippedDuplicates} duplicate${importResult.skippedDuplicates === 1 ? "" : "s"} skipped. `
                  : ""}
                {importResult.needReview > 0
                  ? `${importResult.needReview} row${importResult.needReview === 1 ? "" : "s"} need manual review. `
                  : ""}
                {importResult.failed > 0
                  ? `${importResult.failed} row${importResult.failed === 1 ? "" : "s"} failed — download the error report below and retry.`
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/app/cases">
                  <Button className="bg-amber-500 hover:bg-amber-600 text-white">
                    View Imported Cases
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </Link>
                {importResult.failed > 0 && (
                  <Button variant="outline" onClick={downloadErrorReport}>
                    <Download className="w-4 h-4 mr-2" />
                    Download Error Rows
                  </Button>
                )}
                {importResult.failed > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => retryFailedMutation.mutate()}
                    disabled={retryFailedMutation.isPending}
                  >
                    {retryFailedMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
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
                        key={imp.batchId}
                        className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                      >
                        <td className="py-3 px-2 text-slate-900 truncate max-w-[240px]" title={imp.fileName}>
                          <div className="flex items-center gap-2">
                            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="truncate">{imp.fileName}</span>
                          </div>
                        </td>
                        <td className="py-3 px-2 text-slate-600 text-xs">{imp.importedAt || "—"}</td>
                        <td className="py-3 px-2 text-slate-600 text-xs">{imp.importedBy || "—"}</td>
                        <td className="py-3 px-2 text-right font-medium text-emerald-700">{imp.created}</td>
                        <td className="py-3 px-2 text-right font-medium text-rose-700">{imp.failed || 0}</td>
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
                    {(recentImportsQuery.data ?? []).length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-xs text-slate-400">
                          No recent imports
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

      <Dialog open={!!selectedRow} onOpenChange={(o) => !o && setSelectedRow(null)}>
        <DialogContent className="max-w-3xl">
          {selectedRow && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  Row {selectedRow.rowIndex + 1} · {selectedRow.ourRef || "No Ref"}
                  {selectedRow.status === "ready" && <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">Ready</Badge>}
                  {selectedRow.status === "warning" && <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200">Warning</Badge>}
                  {selectedRow.status === "review" && <Badge variant="secondary" className="bg-orange-50 text-orange-700 border-orange-200">Needs Review</Badge>}
                  {selectedRow.status === "duplicate" && <Badge variant="outline" className="border-slate-300 text-slate-600">Duplicate</Badge>}
                </DialogTitle>
                <DialogDescription>
                  Review row details and decide next action
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Our Ref</div>
                  <div className="font-mono text-slate-900">{selectedRow.ourRef || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Purchaser</div>
                  <div className="text-slate-900">{selectedRow.purchaser || "—"}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-xs text-slate-500 mb-1">Property</div>
                  <div className="text-slate-900">{selectedRow.property || "—"}</div>
                </div>
              </div>

              {selectedRow.issues.length > 0 && (
                <div className="p-3 rounded-md bg-amber-50 border border-amber-200">
                  <div className="text-xs font-semibold text-amber-800 mb-2 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Issues
                  </div>
                  <ul className="text-xs text-amber-900 space-y-1">
                    {selectedRow.issues.map((i, idx) => (
                      <li key={idx}>· {i}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedRow.duplicateCaseId && (
                <div className="p-4 rounded-md border border-slate-200 bg-slate-50">
                  <div className="text-xs font-semibold text-slate-700 mb-3">Possible Duplicate — Excel vs Existing Case</div>
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="text-slate-500 mb-1">Excel Row</div>
                      <div className="p-3 rounded border border-slate-200 bg-white space-y-1">
                        <div><span className="text-slate-500">Our Ref:</span> <span className="font-mono">{selectedRow.ourRef || "—"}</span></div>
                        <div><span className="text-slate-500">Purchaser:</span> {selectedRow.purchaser || "—"}</div>
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500 mb-1">Lawcaspro Case #{selectedRow.duplicateCaseId}</div>
                      <div className="p-3 rounded border border-slate-200 bg-white space-y-1">
                        <div><span className="text-slate-500">Our Ref:</span> <span className="font-mono">—</span></div>
                        <div><span className="text-slate-500">Purchaser:</span> —</div>
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
                  <Link href={`/app/cases/${selectedRow.duplicateCaseId}`}>
                    <Button variant="secondary">
                      Open Existing Case
                    </Button>
                  </Link>
                )}
                <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={handleImportAnyway}>
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
          {importProgress && (
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-xs text-slate-600 mb-2">
                  <span>
                    {importProgress.created + importProgress.skippedDuplicates + importProgress.needReview + importProgress.failed} / {importProgress.total} processed
                  </span>
                  <span>{progressPct}%</span>
                </div>
                <Progress value={progressPct} />
              </div>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                <div className="p-2 rounded bg-emerald-50 text-emerald-700">
                  <div className="font-bold text-base">{importProgress.created}</div>
                  Created
                </div>
                <div className="p-2 rounded bg-slate-50 text-slate-700">
                  <div className="font-bold text-base">{importProgress.skippedDuplicates}</div>
                  Skipped
                </div>
                <div className="p-2 rounded bg-orange-50 text-orange-700">
                  <div className="font-bold text-base">{importProgress.needReview}</div>
                  Review
                </div>
                <div className="p-2 rounded bg-rose-50 text-rose-700">
                  <div className="font-bold text-base">{importProgress.failed}</div>
                  Failed
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
