import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { apiFetchJson, apiRequest } from "@/lib/api-client";
import { downloadBlob, parseFilenameFromContentDisposition } from "@/lib/download";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { ChevronRight, FileText, Printer } from "lucide-react";
import { API_BASE, apiUrl } from "@/lib/api-base";

type AutomationCaseRow = {
  id: number;
  referenceNo: string;
  parcelNo: string | null;
  purchaserName: string | null;
  loanBank: string | null;
  status: string;
  purchaseMode: string;
  titleType: string;
};

type AutomationCasesResponse = {
  items: AutomationCaseRow[];
  page: number;
  limit: number;
};

type PreflightReport = {
  critical: boolean;
  cases: Array<{
    caseId: number;
    referenceNo: string;
    parcelNo: string | null;
    missing: string[];
    warnings?: string[];
  }>;
};

type GenerationJobResponse = {
  job: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
};

type FirmFolder = {
  id: number;
  firm_id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  created_at: string;
};

type FirmDocumentTemplate = {
  id: number;
  name: string;
  file_name: string;
  folder_id: number | null;
  extension: string | null;
  is_template_capable: boolean;
};

const EMPTY_AUTOMATION_CASES: AutomationCaseRow[] = [];
const EMPTY_FIRM_FOLDERS: FirmFolder[] = [];
const EMPTY_FIRM_TEMPLATES: FirmDocumentTemplate[] = [];

function parseFilenameFromContentDisposition(v: string | null): string | null {
  if (!v) return null;
  const m = /filename="([^"]+)"/i.exec(v);
  if (m?.[1]) return m[1];
  return null;
}

function includesAllTokens(haystack: string, tokens: string[]): boolean {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\bthird\b/g, "3rd")
      .trim();
  const h = normalize(haystack);
  return tokens.every((t) => h.includes(normalize(t)));
}

function includesAnyToken(haystack: string, tokens: string[]): boolean {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\bthird\b/g, "3rd")
      .trim();
  const h = normalize(haystack);
  return tokens.some((t) => h.includes(normalize(t)));
}

function safeText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export default function DocumentAutomationHub() {
  const { toast } = useToast();
  const [caseSearch, setCaseSearch] = useState("");
  const [selectedCaseIds, setSelectedCaseIds] = useState<number[]>([]);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<number[]>([]);
  const [activeMode, setActiveMode] = useState<"download" | "print">("download");
  const [copies, setCopies] = useState("1");
  const [duplexMode, setDuplexMode] = useState<"double" | "single" | "custom">("double");
  const [customDuplexRange, setCustomDuplexRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [smartMessage, setSmartMessage] = useState<string | null>(null);
  const [smartTemplateIdSet, setSmartTemplateIdSet] = useState<Set<number>>(() => new Set());
  const [smartFolderIdSet, setSmartFolderIdSet] = useState<Set<number>>(() => new Set());
  const [smartDismissedKey, setSmartDismissedKey] = useState<string>("");
  const smartAppliedKeyRef = useRef<string>("");
  const [bundleMessage, setBundleMessage] = useState<string | null>(null);
  const [bundleTemplateIdSet, setBundleTemplateIdSet] = useState<Set<number>>(() => new Set());
  const [bundleFolderIdSet, setBundleFolderIdSet] = useState<Set<number>>(() => new Set());
  const handledJobKeyRef = useRef<string>("");

  const casesQuery = useQuery<AutomationCasesResponse>({
    queryKey: ["document-automation", "cases", caseSearch],
    queryFn: () => apiFetchJson(`/documents/automation/cases?search=${encodeURIComponent(caseSearch)}&page=1&limit=80`),
    retry: false,
  });

  const foldersQuery = useQuery<FirmFolder[]>({
    queryKey: ["document-automation", "folders"],
    queryFn: () => apiFetchJson("/firm-document-folders"),
    retry: false,
  });

  const templatesQuery = useQuery<FirmDocumentTemplate[]>({
    queryKey: ["document-automation", "templates"],
    queryFn: () => apiFetchJson("/document-templates?templateCapable=true&kind=template"),
    retry: false,
  });

  const cases = casesQuery.data?.items ?? EMPTY_AUTOMATION_CASES;
  const folders = foldersQuery.data ?? EMPTY_FIRM_FOLDERS;
  const templates = templatesQuery.data ?? EMPTY_FIRM_TEMPLATES;

  const caseCacheById = useMemo(() => {
    const m = new Map<number, AutomationCaseRow>();
    for (const c of cases) m.set(c.id, c);
    return m;
  }, [cases]);

  const folderChildren = useMemo(() => {
    const byParent = new Map<number | null, FirmFolder[]>();
    for (const f of folders) {
      const k = f.parent_id ?? null;
      const arr = byParent.get(k) ?? [];
      arr.push(f);
      byParent.set(k, arr);
    }
    for (const [k, arr] of byParent) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
      byParent.set(k, arr);
    }
    return byParent;
  }, [folders]);

  const templatesByFolder = useMemo(() => {
    const m = new Map<number | null, FirmDocumentTemplate[]>();
    for (const t of templates) {
      const k = t.folder_id ?? null;
      const arr = m.get(k) ?? [];
      arr.push(t);
      m.set(k, arr);
    }
    for (const [k, arr] of m) {
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      m.set(k, arr);
    }
    return m;
  }, [templates]);

  const selectedCaseIdSet = useMemo(() => new Set(selectedCaseIds), [selectedCaseIds]);
  const selectedTemplateIdSet = useMemo(() => new Set(selectedTemplateIds), [selectedTemplateIds]);

  const selectedCaseKey = useMemo(() => selectedCaseIds.slice().sort((a, b) => a - b).join(","), [selectedCaseIds]);
  const selectedTemplateKey = useMemo(() => selectedTemplateIds.slice().sort((a, b) => a - b).join(","), [selectedTemplateIds]);

  const folderById = useMemo(() => {
    const m = new Map<number, FirmFolder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);

  const folderPathById = useMemo(() => {
    const memo = new Map<number, string>();
    const build = (id: number): string => {
      const existing = memo.get(id);
      if (existing) return existing;
      const f = folderById.get(id);
      if (!f) return "";
      const parentId = f.parent_id;
      const path = parentId ? `${build(parentId)} / ${f.name}` : f.name;
      memo.set(id, path);
      return path;
    };
    for (const f of folders) build(f.id);
    return memo;
  }, [folderById, folders]);

  const allCasesOnPageSelected = cases.length > 0 && cases.every((c) => selectedCaseIdSet.has(c.id));
  const someCasesOnPageSelected = cases.some((c) => selectedCaseIdSet.has(c.id)) && !allCasesOnPageSelected;

  const preflightEnabled = selectedCaseIds.length > 0 && selectedTemplateIds.length > 0;
  const preflightQuery = useQuery<PreflightReport>({
    queryKey: ["document-automation", "preflight", selectedCaseKey, selectedTemplateKey],
    queryFn: () =>
      apiFetchJson("/documents/automation/preflight", {
        method: "POST",
        body: JSON.stringify({ caseIds: selectedCaseIds, templateIds: selectedTemplateIds }),
      }),
    enabled: preflightEnabled,
    retry: false,
  });
  const preflightMissing = preflightQuery.data?.cases ?? [];
  const preflightCritical = Boolean(preflightQuery.data?.critical);
  const preflightBlocking = preflightEnabled && (preflightQuery.isFetching || preflightQuery.isLoading || preflightCritical || Boolean(preflightQuery.error));

  const jobQuery = useQuery<GenerationJobResponse>({
    queryKey: ["document-automation", "job", jobId],
    queryFn: () => apiFetchJson(`/documents/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) => {
      const st = String((q.state.data?.job as any)?.status ?? "");
      if (st === "completed" || st === "failed") return false;
      return 2000;
    },
    retry: false,
  });

  const jobStatus = String((jobQuery.data?.job as any)?.status ?? "");
  const jobDownloadFileName =
    safeText((jobQuery.data?.job as any)?.download_file_name) ||
    safeText((jobQuery.data?.job as any)?.downloadFileName);

  useEffect(() => {
    if (!jobId) return;
    if (!jobQuery.data?.job) return;

    const handleKey = `${jobId}:${jobStatus}`;
    if ((jobStatus === "completed" || jobStatus === "failed") && handledJobKeyRef.current === handleKey) return;
    if (jobStatus === "completed" || jobStatus === "failed") handledJobKeyRef.current = handleKey;

    if (jobStatus === "failed") {
      const msg = safeText((jobQuery.data?.job as any)?.error_summary) || "Document generation failed";
      toast({ title: "Generation failed", description: msg, variant: "destructive" });
      setJobId(null);
      setBusy(false);
      return;
    }
    if (jobStatus !== "completed") return;

    const failed = (jobQuery.data?.items ?? []).filter((it) => String((it as any).status ?? "") === "failed");
    if (failed.length > 0) {
      toast({ title: "Some documents failed", description: "Open browser console to view failure details." });
      console.warn("[document-automation.failures]", failed);
    }

    const doDownload = async () => {
      const url = apiUrl(`/api/documents/jobs/${jobId}/download`);
      if (activeMode === "print") {
        window.open(url, "_blank", "noopener,noreferrer");
        toast({ title: "Printable PDF generated" });
        return;
      }

      const resp = await apiRequest(`/documents/jobs/${jobId}/download`, { timeoutMs: 60000 });
      const blob = await resp.blob();
      const filename =
        parseFilenameFromContentDisposition(resp.headers.get("Content-Disposition")) ||
        jobDownloadFileName ||
        "document-automation.zip";
      downloadBlob(blob, filename);
      toast({ title: "Export ready", description: filename });
    };

    doDownload()
      .catch((err) => toastError(toast, err))
      .finally(() => {
        setJobId(null);
        setBusy(false);
      });
  }, [jobId, jobQuery.data?.job, jobQuery.data?.items, jobStatus, activeMode, jobDownloadFileName, toast]);

  function setAllCasesOnPage(checked: boolean) {
    if (!checked) {
      setSelectedCaseIds((prev) => prev.filter((id) => !cases.some((c) => c.id === id)));
      return;
    }
    setSelectedCaseIds((prev) => Array.from(new Set([...prev, ...cases.map((c) => c.id)])));
  }

  function toggleSelectCase(id: number) {
    setSelectedCaseIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const selectedCases = useMemo(() => {
    const out: AutomationCaseRow[] = [];
    for (const id of selectedCaseIds) {
      const c = caseCacheById.get(id);
      if (c) out.push(c);
    }
    return out;
  }, [caseCacheById, selectedCaseIds]);

  const templateIdsInFolder = useMemo(() => {
    const memo = new Map<number | null, number[]>();
    const visit = (folderId: number | null): number[] => {
      if (memo.has(folderId)) return memo.get(folderId)!;
      const direct = (templatesByFolder.get(folderId) ?? []).map((t) => t.id);
      const children = folderChildren.get(folderId) ?? [];
      const fromChildren = children.flatMap((c) => visit(c.id));
      const all = [...direct, ...fromChildren];
      memo.set(folderId, all);
      return all;
    };
    visit(null);
    return memo;
  }, [folderChildren, templatesByFolder]);

  function toggleSelectTemplate(id: number) {
    setSelectedTemplateIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  useEffect(() => {
    const key = selectedCaseIds.slice().sort((a, b) => a - b).join(",");
    if (!key || smartDismissedKey === key) {
      smartAppliedKeyRef.current = "";
      setSmartMessage(null);
      setSmartTemplateIdSet(new Set());
      setSmartFolderIdSet(new Set());
      return;
    }

    if (selectedCases.length === 0 || folders.length === 0 || templates.length === 0) {
      smartAppliedKeyRef.current = "";
      setSmartMessage(null);
      setSmartTemplateIdSet(new Set());
      setSmartFolderIdSet(new Set());
      return;
    }

    const recommendedFolderIds = new Set<number>();
    const recommendedTemplateIds = new Set<number>();
    const messages: string[] = [];

    for (const c of selectedCases) {
      const loanBank = safeText(c.loanBank).toLowerCase();
      const titleType = safeText(c.titleType).toLowerCase();

      const isRhbIslamic = loanBank.includes("rhb") && loanBank.includes("islamic");
      const isStrata = titleType === "strata";

      if (isRhbIslamic && isStrata) {
        const tokens = ["rhb", "islamic", "3rd", "party"];
        const match = folders.find((f) => {
          const path = folderPathById.get(f.id) ?? f.name;
          return includesAllTokens(path, tokens) || includesAllTokens(f.name, tokens);
        });
        if (match) {
          recommendedFolderIds.add(match.id);
          const allIds = templateIdsInFolder.get(match.id) ?? [];
          const core = allIds.filter((tid) => {
            const t = templates.find((x) => x.id === tid);
            const n = safeText(t?.name).toLowerCase();
            return n.includes("facility") && n.includes("agreement");
          });
          const picked = core.length > 0 ? core : allIds;
          for (const tid of picked) recommendedTemplateIds.add(tid);
          messages.push(`Auto-selected RHB Islamic 3rd Party templates (Strata)`);
        }
      }
    }

    if (recommendedTemplateIds.size === 0) {
      smartAppliedKeyRef.current = "";
      setSmartMessage(null);
      setSmartTemplateIdSet(new Set());
      setSmartFolderIdSet(new Set());
      return;
    }

    const nextIdsSorted = Array.from(recommendedTemplateIds).sort((a, b) => a - b);
    const smartKey = `${key}:${nextIdsSorted.join(",")}`;
    if (smartAppliedKeyRef.current === smartKey) return;
    smartAppliedKeyRef.current = smartKey;

    setSelectedTemplateIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const tid of recommendedTemplateIds) {
        if (!next.has(tid)) {
          next.add(tid);
          changed = true;
        }
      }
      return changed ? Array.from(next) : prev;
    });
    setSmartTemplateIdSet(new Set(recommendedTemplateIds));
    setSmartFolderIdSet(new Set(recommendedFolderIds));
    setSmartMessage(`✨ Smart Match: ${Array.from(new Set(messages)).join(" / ")}`);

    /*
      Future AI extension point:
      - When users upload a Bank Letter of Offer (PDF), we can send it to:
        POST /api/ai/extract-data
      - The extracted structured fields (bank, amounts, key dates) can then be written back into the Case database,
        allowing the recommender to become data-driven instead of rule-only.
    */
  }, [folders, folderPathById, selectedCaseIds, selectedCases, smartDismissedKey, templateIdsInFolder, templates]);

  function setFolderTemplates(folderId: number | null, checked: boolean) {
    const ids = templateIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return;
    if (!checked) {
      setSelectedTemplateIds((prev) => prev.filter((id) => !ids.includes(id)));
      return;
    }
    setSelectedTemplateIds((prev) => Array.from(new Set([...prev, ...ids])));
  }

  function folderCheckboxState(folderId: number | null): { checked: boolean; indeterminate: boolean } {
    const ids = templateIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return { checked: false, indeterminate: false };
    const selectedCount = ids.filter((id) => selectedTemplateIdSet.has(id)).length;
    if (selectedCount === 0) return { checked: false, indeterminate: false };
    if (selectedCount === ids.length) return { checked: true, indeterminate: false };
    return { checked: false, indeterminate: true };
  }

  function applyBundle(bundleName: string, tokens: string[], coreTemplateTokens?: string[]) {
    if (folders.length === 0 || templates.length === 0) {
      toast({ title: "Templates are still loading" });
      return;
    }

    const matchFolder = folders.find((f) => {
      const path = folderPathById.get(f.id) ?? f.name;
      return includesAnyToken(path, tokens) || includesAnyToken(f.name, tokens);
    });

    const folderIds = new Set<number>();
    const templateIds = new Set<number>();

    if (matchFolder) {
      folderIds.add(matchFolder.id);
      const ids = templateIdsInFolder.get(matchFolder.id) ?? [];
      const core = coreTemplateTokens && coreTemplateTokens.length > 0
        ? ids.filter((tid) => {
            const t = templates.find((x) => x.id === tid);
            const n = safeText(t?.name).toLowerCase();
            return coreTemplateTokens.every((tk) => n.includes(tk.toLowerCase()));
          })
        : [];
      const picked = core.length > 0 ? core : ids;
      for (const tid of picked) templateIds.add(tid);
    } else {
      const matchedTemplates = templates.filter((t) => includesAnyToken(safeText(t.name), tokens));
      for (const t of matchedTemplates) templateIds.add(t.id);
    }

    if (templateIds.size === 0) {
      toast({ title: "Bundle not found", description: "No matching folder/templates found in your template tree." });
      return;
    }

    setSelectedTemplateIds((prev) => Array.from(new Set([...prev, ...Array.from(templateIds)])));
    setBundleFolderIdSet(folderIds);
    setBundleTemplateIdSet(templateIds);
    setBundleMessage(`Quick Select Bundle: ${bundleName}`);
  }

  async function runGenerate(mode: "download" | "print", opts?: { force?: boolean }) {
    if (selectedCaseIds.length === 0) {
      toast({ title: "Please select at least one case" });
      return;
    }
    if (selectedTemplateIds.length === 0) {
      toast({ title: "Please select at least one template" });
      return;
    }

    setBusy(true);
    let startedJob = false;
    try {
      if (preflightEnabled && !opts?.force) {
        const preflight = await preflightQuery.refetch();
        if (preflight.error) {
          throw preflight.error;
        }
        if (preflight.data?.critical) {
          toast({ title: "Missing required case data", description: "Please fix missing fields before generating." });
          return;
        }
      }

      const duplexSettings =
        mode === "print"
          ? duplexMode === "custom"
            ? { mode: "custom", range: customDuplexRange }
            : { mode: duplexMode }
          : undefined;

      const payload = {
        caseIds: selectedCaseIds,
        templateIds: selectedTemplateIds,
        config: {
          action: mode,
          copies: mode === "print" ? Number(copies || 1) : undefined,
          duplexSettings,
        },
      };

      const forceQs = opts?.force ? "?force=true" : "";
      const data = await apiFetchJson<any>(`/documents/automation/generate-job${forceQs}`, {
        method: "POST",
        body: JSON.stringify(payload),
        timeoutMs: 60000,
      });
      const nextJobId = safeText((data as any)?.jobId);
      if (!nextJobId) throw new Error("Missing jobId");
      setJobId(nextJobId);
      startedJob = true;
      toast({ title: "Generation started", description: opts?.force ? "Draft mode enabled. Missing fields will be marked in the output." : "Processing in background. This page will auto-download when ready." });
    } catch (err) {
      toastError(toast, err);
    } finally {
      if (!startedJob) setBusy(false);
    }
  }

  function FolderNode({ folder, depth }: { folder: FirmFolder; depth: number }) {
    const children = folderChildren.get(folder.id) ?? [];
    const [expanded, setExpanded] = useState(true);
    const cb = folderCheckboxState(folder.id);
    const hasChildren = children.length > 0;
    const hasTemplates = (templateIdsInFolder.get(folder.id) ?? []).length > 0;
    const isSmart = smartFolderIdSet.has(folder.id) || bundleFolderIdSet.has(folder.id);

    return (
      <div>
        <div
          className={cn(
            "flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50",
            isSmart && cb.checked && "bg-blue-50"
          )}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          <button
            className={cn("p-0.5", !hasChildren && "invisible")}
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
          </button>
          <Checkbox
            checked={cb.indeterminate ? "indeterminate" : cb.checked}
            disabled={!hasTemplates}
            onCheckedChange={(v) => setFolderTemplates(folder.id, v === true)}
          />
          <button
            className="flex-1 truncate text-left"
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            {folder.name}
          </button>
          {isSmart && cb.checked && <span className="text-[10px] text-blue-600">✨</span>}
        </div>

        {expanded && (
          <div>
            {(templatesByFolder.get(folder.id) ?? []).map((t) => (
              <div
                key={t.id}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50",
                  (smartTemplateIdSet.has(t.id) || bundleTemplateIdSet.has(t.id)) && selectedTemplateIdSet.has(t.id) && "bg-blue-50"
                )}
                style={{ paddingLeft: `${(depth + 1) * 14 + 22}px` }}
              >
                <Checkbox
                  checked={selectedTemplateIdSet.has(t.id)}
                  onCheckedChange={(v) => {
                    const checked = v === true;
                    setSelectedTemplateIds((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(t.id);
                      else next.delete(t.id);
                      return Array.from(next);
                    });
                  }}
                />
                <FileText className="h-3.5 w-3.5 text-slate-500" />
                <div className="flex-1 truncate">{t.name}</div>
                {(smartTemplateIdSet.has(t.id) || bundleTemplateIdSet.has(t.id)) && selectedTemplateIdSet.has(t.id) && <span className="text-[10px] text-blue-600">✨</span>}
              </div>
            ))}
            {children.map((c) => (
              <FolderNode key={c.id} folder={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Document Automation Hub</h1>
        <p className="text-slate-500">Batch generate PDFs, export ZIPs, and prepare system print packages with full audit logging.</p>
      </div>

      <Card className="border-slate-200">
        <CardContent className="p-0">
          <ResizablePanelGroup direction="horizontal" className="h-[720px]">
            <ResizablePanel defaultSize={34} minSize={26}>
              <div className="h-full flex flex-col">
                <div className="p-4 border-b bg-white">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="font-semibold text-slate-900">Case Selection</div>
                      <div className="text-xs text-slate-500">Select one or multiple cases</div>
                    </div>
                    <div className="text-xs text-slate-500">Selected: {selectedCaseIds.length}</div>
                  </div>
                  <div className="mt-3">
                    <Input value={caseSearch} onChange={(e) => setCaseSearch(e.target.value)} placeholder="Search by reference / parcel / purchaser..." />
                  </div>
                </div>

                <div className="flex-1 overflow-auto bg-white">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white border-b">
                      <tr className="text-xs text-slate-500">
                        <th className="w-10 px-3 py-2">
                          <Checkbox
                            checked={someCasesOnPageSelected ? "indeterminate" : allCasesOnPageSelected}
                            onCheckedChange={(v) => setAllCasesOnPage(v === true)}
                          />
                        </th>
                        <th className="text-left px-3 py-2">Parcel / Unit</th>
                        <th className="text-left px-3 py-2">Purchaser</th>
                        <th className="text-left px-3 py-2">Loan Bank</th>
                        <th className="text-left px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {cases.map((c) => (
                        <tr key={c.id} className="hover:bg-slate-50">
                          <td className="px-3 py-2 align-top">
                            <Checkbox
                              checked={selectedCaseIdSet.has(c.id)}
                              onCheckedChange={(v) => {
                                const checked = v === true;
                                setSelectedCaseIds((prev) => {
                                  const next = new Set(prev);
                                  if (checked) next.add(c.id);
                                  else next.delete(c.id);
                                  return Array.from(next);
                                });
                              }}
                            />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="text-slate-900">{c.parcelNo || "-"}</div>
                            <div className="text-xs text-slate-500">{c.referenceNo}</div>
                          </td>
                          <td className="px-3 py-2 align-top">{c.purchaserName || "-"}</td>
                          <td className="px-3 py-2 align-top">{c.loanBank || "-"}</td>
                          <td className="px-3 py-2 align-top">
                            <div className="line-clamp-2 text-slate-700">{c.status}</div>
                          </td>
                        </tr>
                      ))}
                      {cases.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">
                            {casesQuery.isLoading ? "Loading cases..." : "No cases found"}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={33} minSize={26}>
              <div className="h-full flex flex-col">
                <div className="p-4 border-b bg-white">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="font-semibold text-slate-900">Template / Folder Selector</div>
                      <div className="text-xs text-slate-500">Select templates or entire folders</div>
                    </div>
                    <div className="text-xs text-slate-500">Selected: {selectedTemplateIds.length}</div>
                  </div>
                  <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="text-xs font-medium text-slate-700">Quick Select Bundles</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" size="sm" onClick={() => applyBundle("RHB Islamic", ["rhb", "islamic"], ["facility", "agreement"])}>
                        RHB Islamic
                      </Button>
                      <Button type="button" variant="secondary" size="sm" onClick={() => applyBundle("Maybank 3rd Party", ["maybank", "3rd", "party"], ["facility", "agreement"])}>
                        Maybank 3rd Party
                      </Button>
                      <Button type="button" variant="secondary" size="sm" onClick={() => applyBundle("Standard SPA", ["spa"], [])}>
                        Standard SPA
                      </Button>
                    </div>
                    {bundleMessage && (
                      <div className="mt-2 text-xs text-slate-600">{bundleMessage}</div>
                    )}
                  </div>
                  {smartMessage && (
                    <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 flex items-start justify-between gap-3">
                      <div className="leading-relaxed">{smartMessage}</div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-blue-800 hover:bg-blue-100"
                        onClick={() => setSmartDismissedKey(selectedCaseKey)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </div>

                <div className="flex-1 overflow-auto bg-white">
                  <div className="p-2">
                    {(folderChildren.get(null) ?? []).map((f) => (
                      <FolderNode key={f.id} folder={f} depth={0} />
                    ))}
                    {(templatesByFolder.get(null) ?? []).length > 0 && (
                      <div className="mt-2">
                        <div className="px-2 py-1 text-xs font-medium text-slate-500">Uncategorized</div>
                        {(templatesByFolder.get(null) ?? []).map((t) => (
                          <div
                            key={t.id}
                            className={cn(
                              "flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50",
                              (smartTemplateIdSet.has(t.id) || bundleTemplateIdSet.has(t.id)) && selectedTemplateIdSet.has(t.id) && "bg-blue-50"
                            )}
                          >
                            <Checkbox
                              checked={selectedTemplateIdSet.has(t.id)}
                              onCheckedChange={(v) => {
                                const checked = v === true;
                                setSelectedTemplateIds((prev) => {
                                  const next = new Set(prev);
                                  if (checked) next.add(t.id);
                                  else next.delete(t.id);
                                  return Array.from(next);
                                });
                              }}
                            />
                            <FileText className="h-3.5 w-3.5 text-slate-500" />
                            <div className="flex-1 truncate">{t.name}</div>
                            {(smartTemplateIdSet.has(t.id) || bundleTemplateIdSet.has(t.id)) && selectedTemplateIdSet.has(t.id) && <span className="text-[10px] text-blue-600">✨</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {templatesQuery.isLoading && (
                      <div className="px-4 py-10 text-center text-sm text-slate-400">Loading templates...</div>
                    )}
                    {!templatesQuery.isLoading && templates.length === 0 && (
                      <div className="px-4 py-10 text-center text-sm text-slate-400">No templates found</div>
                    )}
                  </div>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={33} minSize={26}>
              <div className="h-full flex flex-col bg-white">
                <div className="p-4 border-b">
                  <div className="space-y-0.5">
                    <div className="font-semibold text-slate-900">Configuration & Actions</div>
                    <div className="text-xs text-slate-500">Download ZIP or prepare system print output</div>
                  </div>
                </div>

                <div className="p-4 space-y-4 overflow-auto">
                  <Tabs value={activeMode} onValueChange={(v) => setActiveMode(v === "print" ? "print" : "download")}>
                    <TabsList className="grid grid-cols-2 w-full">
                      <TabsTrigger value="download" className="gap-2"><FileText className="h-4 w-4" />Download ZIP</TabsTrigger>
                      <TabsTrigger value="print" className="gap-2"><Printer className="h-4 w-4" />System Print</TabsTrigger>
                    </TabsList>

                    <TabsContent value="download" className="mt-4 space-y-3">
                      <div className="text-sm text-slate-600">
                        Generates PDFs, applies naming rules, and exports a ZIP with the required folder structure.
                      </div>
                      {busy && jobId && (
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                          Generating document, please wait... (Estimated ~15 seconds)
                        </div>
                      )}
                      {preflightEnabled && (preflightBlocking || preflightMissing.length > 0) && (
                        <Alert variant={preflightCritical ? "destructive" : "default"}>
                          <AlertTitle>{preflightCritical ? "Missing data detected" : "Preflight warnings"}</AlertTitle>
                          <AlertDescription>
                            <div className="space-y-1.5">
                              {preflightQuery.isFetching || preflightQuery.isLoading ? (
                                <div>Running pre-flight validation...</div>
                              ) : preflightQuery.error ? (
                                <div>Pre-flight validation failed. Please retry.</div>
                              ) : (
                                preflightMissing.map((c) => (
                                  <div key={c.caseId}>
                                    ⚠️ File Ref: {c.parcelNo || c.referenceNo || `Case ${c.caseId}`} - {c.missing.length > 0 ? `Missing ${c.missing.join(", ")}` : "OK"}{(c.warnings?.length ?? 0) > 0 ? ` • Warning: ${c.warnings?.join(", ")}` : ""}.
                                  </div>
                                ))
                              )}
                            </div>
                          </AlertDescription>
                        </Alert>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <Button disabled={busy} className="w-full" onClick={() => runGenerate("download")}>
                          {busy ? "Generating..." : "Generate & Download"}
                        </Button>
                        <Button disabled={busy} className="w-full" variant="outline" onClick={() => runGenerate("download", { force: true })}>
                          {busy ? "Generating..." : "Download Draft"}
                        </Button>
                      </div>
                    </TabsContent>

                    <TabsContent value="print" className="mt-4 space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label>Copies</Label>
                          <Input value={copies} onChange={(e) => setCopies(e.target.value)} inputMode="numeric" />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Duplex Mode</Label>
                          <Select value={duplexMode} onValueChange={(v) => setDuplexMode(v === "single" ? "single" : v === "custom" ? "custom" : "double")}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="double">All Double-Sided</SelectItem>
                              <SelectItem value="single">All Single-Sided</SelectItem>
                              <SelectItem value="custom">Custom Duplex Range</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {duplexMode === "custom" && (
                        <div className="space-y-1.5">
                          <Label>Custom Duplex Range</Label>
                          <Input
                            value={customDuplexRange}
                            onChange={(e) => setCustomDuplexRange(e.target.value)}
                            placeholder="e.g. 1-2 single; 3-10 double"
                          />
                        </div>
                      )}

                      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 leading-relaxed">
                        Printing settings are recorded for audit. The actual duplex/copies are applied in your system print dialog.
                      </div>
                      {busy && jobId && (
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                          Generating document, please wait... (Estimated ~15 seconds)
                        </div>
                      )}

                      {preflightEnabled && (preflightBlocking || preflightMissing.length > 0) && (
                        <Alert variant={preflightCritical ? "destructive" : "default"}>
                          <AlertTitle>{preflightCritical ? "Missing data detected" : "Preflight warnings"}</AlertTitle>
                          <AlertDescription>
                            <div className="space-y-1.5">
                              {preflightQuery.isFetching || preflightQuery.isLoading ? (
                                <div>Running pre-flight validation...</div>
                              ) : preflightQuery.error ? (
                                <div>Pre-flight validation failed. Please retry.</div>
                              ) : (
                                preflightMissing.map((c) => (
                                  <div key={c.caseId}>
                                    ⚠️ File Ref: {c.parcelNo || c.referenceNo || `Case ${c.caseId}`} - {c.missing.length > 0 ? `Missing ${c.missing.join(", ")}` : "OK"}{(c.warnings?.length ?? 0) > 0 ? ` • Warning: ${c.warnings?.join(", ")}` : ""}.
                                  </div>
                                ))
                              )}
                            </div>
                          </AlertDescription>
                        </Alert>
                      )}

                      <Button disabled={busy || preflightBlocking} className="w-full" onClick={() => runGenerate("print")}>
                        {busy ? "Generating..." : "Generate Printable PDF"}
                      </Button>
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </CardContent>
      </Card>
    </div>
  );
}
