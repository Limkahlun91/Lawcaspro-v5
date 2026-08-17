import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { apiFetchJson } from "@/lib/api-client";
import { RequestTimeoutError } from "@/lib/fetch-with-timeout";
import {
  createGenerationJob,
  finalizeGenerationJob,
  runNextGenerationJob,
  getGenerationJobStatus,
  getGenerationJobDownloadManifest,
  type NormalizedGenerationJob,
} from "@/lib/document-generation-client";
import {
  canDownloadNow,
  canRetryDownload,
  canRetryFailedItems,
  canDownloadSuccessfulFiles,
  canClearJob,
  extractErrorMessage,
  formatProcessingNotice,
  getDisplayStatus,
  getJobSummary,
  getJobTitle,
  getProgress,
  isJobNotReadyForDownload,
  isProgressComplete,
  type DocGenDisplayStatus,
} from "./automation-guards";
import { downloadBlob } from "@/lib/download";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { ChevronRight, ChevronDown, FileText, Printer, AlertTriangle, CheckCircle2, XCircle, Loader2, Clock, FolderArchive } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import JSZip from "jszip";

type AutomationCaseRow = {
  id: number;
  referenceNo: string;
  fileReference?: string;
  parcelNo: string | null;
  purchaserName: string | null;
  projectName?: string | null;
  loanBank: string | null;
  status: string;
  purchaseMode?: string;
  titleType: string;
  caseType?: string;
};

type AutomationCasesResponse = {
  items: AutomationCaseRow[];
  page: number;
  limit: number;
};

type FirmFolder = {
  id: number;
  firm_id?: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  created_at?: string;
  source?: string;
};

type FirmDocumentTemplate = {
  id: number;
  name: string;
  file_name?: string;
  folder_id: number | null;
  extension?: string | null;
  is_template_capable?: boolean;
  is_active?: boolean;
  status?: string;
  source?: string;
};

const EMPTY_AUTOMATION_CASES: AutomationCaseRow[] = [];
const EMPTY_FIRM_FOLDERS: FirmFolder[] = [];
const EMPTY_FIRM_TEMPLATES: FirmDocumentTemplate[] = [];

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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseFilenameFromDisposition(v: string | null): string | null {
  if (!v) return null;
  const m = /filename="([^"]+)"/i.exec(v);
  if (m?.[1]) return m[1];
  return null;
}

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  if (rec.name === "AbortError") return true;
  if (
    typeof rec.message === "string" &&
    rec.message.toLowerCase().includes("signal is aborted")
  )
    return true;
  return false;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function DocumentAutomationHub() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [caseSearchRaw, setCaseSearchRaw] = useState("");
  const caseSearch = useDebouncedValue(caseSearchRaw, 300).trim();
  const [selectedCaseIds, setSelectedCaseIds] = useState<number[]>([]);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<number[]>([]);
  const [activeMode, setActiveMode] = useState<"download" | "print">(
    "download",
  );
  const [selectedMasterDocIds, setSelectedMasterDocIds] = useState<number[]>(
    [],
  );
  const [templateSourceTab, setTemplateSourceTab] = useState<"firm" | "master">(
    "firm",
  );
  const [copies, setCopies] = useState("1");
  const [duplexMode, setDuplexMode] = useState<"double" | "single" | "custom">(
    "double",
  );
  const [customDuplexRange, setCustomDuplexRange] = useState("");
  const [jobStage, setJobStage] = useState<
    | "idle"
    | "ready"
    | "creating"
    | "generating"
    | "finalizing"
    | "preparing_download"
    | "downloading"
    | "packaging"
    | "error"
  >("idle");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const hasActiveJob = activeJobId !== null;
  const busy =
    jobStage !== "idle" &&
    jobStage !== "ready" &&
    jobStage !== "error";
  const [finalizingZip, setFinalizingZip] = useState(false);
  const [job, setJob] = useState<NormalizedGenerationJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [runnerNotice, setRunnerNotice] = useState<string | null>(null);

  type DownloadManifest = {
    ok: true;
    jobId: string;
    fileName: string;
    files: Array<{
      itemId: number;
      status: string;
      fileName: string;
      folderPath: string;
      zipPath: string;
      storagePath: string | null;
      signedUrl: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    }>;
  };

  const downloadZipFromManifest = async (jobId: string, snapshot: NormalizedGenerationJob) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        devLog("manifest:start", { jobId, attempt });
        setRunnerNotice("Preparing download...");
        setJobStage("preparing_download");
        const raw = await getGenerationJobDownloadManifest(jobId);
        const m = raw && typeof raw === "object" ? (raw as any) : null;
        if (!m || m.ok !== true) {
          const code = m?.error?.code ? String(m.error.code) : "";
          const msg = m?.error?.message
            ? String(m.error.message)
            : "Failed to prepare download";
          const e = new Error(code && msg ? `${code}: ${msg}` : msg) as any;
          e.status = 500;
          throw e;
        }

        const manifest = m as DownloadManifest;
        const fileName =
          typeof manifest.fileName === "string" && manifest.fileName.trim()
            ? manifest.fileName.trim()
            : snapshot.downloadFileName ?? `document-automation-${Date.now()}.zip`;
        const downloadable = manifest.files.filter(
          (f) =>
            f.status === "success" &&
            typeof f.signedUrl === "string" &&
            f.signedUrl.trim(),
        );
        const total = downloadable.length;
        if (total <= 0) {
          const e = new Error("No downloadable files found in manifest") as any;
          e.status = 409;
          throw e;
        }

        devLog("zip:download:start", { jobId, files: total });
        const zip = new JSZip();
        let downloaded = 0;
        let cursor = 0;
        const workerCount = Math.max(1, Math.min(4, downloadable.length));
        const workers = Array.from({ length: workerCount }).map(async () => {
          while (cursor < downloadable.length) {
            const i = cursor++;
            const f = downloadable[i]!;
            setRunnerNotice(`Downloading files ${downloaded}/${total}...`);
            setJobStage("downloading");
            const resp = await fetch(String(f.signedUrl));
            if (!resp.ok) {
              const e = new Error(
                `Download failed: ${f.fileName} (${resp.status})`,
              ) as any;
              e.status = resp.status;
              throw e;
            }
            const buf = await resp.arrayBuffer();
            zip.file(f.zipPath, buf);
            downloaded += 1;
            setRunnerNotice(`Downloading files ${downloaded}/${total}...`);
          }
        });
        await Promise.all(workers);

        devLog("zip:packaging:start", { jobId });
        setRunnerNotice("Packaging ZIP...");
        setJobStage("packaging");
        const blob = await zip.generateAsync(
          { type: "blob" },
          (metadata) => {
            const pct =
              typeof (metadata as any)?.percent === "number"
                ? Math.max(
                    0,
                    Math.min(100, Math.round((metadata as any).percent)),
                  )
                : null;
            setRunnerNotice(
              pct !== null ? `Packaging ZIP... ${pct}%` : "Packaging ZIP...",
            );
          },
        );

        devLog("zip:packaging:complete", { jobId });
        downloadBlob(blob, fileName);
        setRunnerNotice("Download ready");
        toast({
          title:
            String(snapshot.status ?? "") === "completed"
              ? "Download started"
              : "Download started (with warnings)",
          description: fileName,
        });
        return;
      } catch (err) {
        devLog("download:failed", {
          jobId,
          attempt,
          message: err instanceof Error ? err.message : String(err ?? ""),
        });
        if (attempt >= 2) throw err;
        await new Promise<void>((r) => setTimeout(r, 900));
      }
    }
    const e = new Error("Generated successfully, but ZIP packaging failed. Retry download.") as any;
    e.status = 409;
    throw e;
  };
  const pollTimerRef = useRef<ReturnType<typeof window.setInterval> | null>(
    null,
  );
  const pollInFlightRef = useRef(0);
  const runNextInFlightRef = useRef(false);
  const finalizeInFlightRef = useRef(false);
  const downloadInFlightRef = useRef(false);
  const finalizeAttemptedJobIdRef = useRef<string | null>(null);
  const downloadAttemptedJobIdRef = useRef<string | null>(null);
  const jobStageRef = useRef(jobStage);
  const runNextConsecutive504Ref = useRef(0);
  const runnerRef = useRef<{
    running: boolean;
    jobId: string | null;
    startedAt: number;
    runNextAttempts: number;
    state:
      | "idle"
      | "creatingJob"
      | "runningItems"
      | "statusOnly"
      | "finalizing"
      | "downloading"
      | "completed"
      | "failed"
      | "cancelled";
    statusOnlyUntil: number;
    finalizeRequestedAt: number;
  }>({
    running: false,
    jobId: null,
    startedAt: 0,
    runNextAttempts: 0,
    state: "idle",
    statusOnlyUntil: 0,
    finalizeRequestedAt: 0,
  });
  const pollConsecutiveErrorRef = useRef(0);
  const pollAbortRef = useRef<AbortController | null>(null);
  const debugRunIdRef = useRef<string>(
    `fe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const [smartMessage, setSmartMessage] = useState<string | null>(null);
  const [smartTemplateIdSet, setSmartTemplateIdSet] = useState<Set<number>>(
    () => new Set(),
  );
  const [smartFolderIdSet, setSmartFolderIdSet] = useState<Set<number>>(
    () => new Set(),
  );
  const [smartDismissedKey, setSmartDismissedKey] = useState<string>("");
  const smartAppliedKeyRef = useRef<string>("");
  const [bundleMessage, setBundleMessage] = useState<string | null>(null);
  const [bundleTemplateIdSet, setBundleTemplateIdSet] = useState<Set<number>>(
    () => new Set(),
  );
  const [bundleFolderIdSet, setBundleFolderIdSet] = useState<Set<number>>(
    () => new Set(),
  );

  // #region debug-point FE:emit
  const emitDbg = (args: {
    hypothesisId: string;
    msg: string;
    data?: Record<string, unknown>;
  }) => {
    try {
      if (!import.meta.env.DEV) return;
      if (typeof window === "undefined") return;
      const host = window.location.hostname;
      if (host !== "localhost" && host !== "127.0.0.1") return;
      fetch("http://127.0.0.1:7777/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "doc-automation-generate-job",
          runId: debugRunIdRef.current,
          hypothesisId: args.hypothesisId,
          location: "DocumentAutomationHub",
          msg: args.msg,
          ts: Date.now(),
          data: args.data ?? {},
        }),
      }).catch(() => {});
    } catch {}
  };
  // #endregion

  const devLog = (msg: string, data?: Record<string, unknown>) => {
    if (!import.meta.env.DEV) return;
    try {
      console.log(`[docgen] ${msg}`, data ?? {});
    } catch {}
  };

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
      pollAbortRef.current?.abort();
      runnerRef.current.running = false;
      runnerRef.current.jobId = null;
    };
  }, []);

  useEffect(() => {
    jobStageRef.current = jobStage;
  }, [jobStage]);

  const storageKey = useMemo(() => {
    const firmId = user?.firmId ?? "unknown_firm";
    const userId = user?.id ?? "unknown_user";
    return `lawcaspro_doc_automation_last_job_${firmId}_${userId}`;
  }, [user?.firmId, user?.id]);

  const pollTimestampStorageKey = useMemo(() => `${storageKey}_polled_at`, [storageKey]);
  const maxRetryAttemptsPerPageLoad = 20;
  const retryAttemptsRef = useRef(0);

  const setDownloadPrepError = (message?: string) => {
    setRunnerNotice("Download preparation failed. Retry Download");
    if (message) setJobError(message);
    setJobStage("error");
  };

  const clearActiveJob = () => {
    setActiveJobId(null);
    setJob(null);
    setJobError(null);
    setRunnerNotice(null);
    setFinalizingZip(false);
    setJobStage("idle");
    finalizeAttemptedJobIdRef.current = null;
    downloadAttemptedJobIdRef.current = null;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {}
  };

  const continueJob = async (jobId: string) => {
    if (!jobId) return;
    if (runnerRef.current.running) return;
    setJobError(null);
    setRunnerNotice(null);
    setJobStage("generating");
    setActiveJobId(jobId);
    runNextConsecutive504Ref.current = 0;
    try {
      window.localStorage.setItem(storageKey, jobId);
    } catch {}
    runnerRef.current.running = true;
    runnerRef.current.jobId = jobId;
    runnerRef.current.startedAt = Date.now();
    runnerRef.current.runNextAttempts = 0;
    runnerRef.current.state = "runningItems";
    try {
      while (runnerRef.current.running && runnerRef.current.jobId === jobId) {
        const st = await getGenerationJobStatus(jobId);
        setJob(st);
        const p = getProgress(st);
        const sLower = String(st.status ?? "").toLowerCase();
        const naLower = String(st.nextAction ?? "").toLowerCase();
        if (naLower === "stop" || sLower === "failed" || sLower === "cancelled") {
          const hasDocxErr = Array.isArray(st.items) && st.items.some((i) => i?.errorCode === "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED");
          setJobError(
            hasDocxErr
              ? "Word template cannot be exported to PDF because DOCX-to-PDF converter is not configured."
              : (st.errorSummary ?? "Generation stopped"),
          );
          setJobStage("error");
          return;
        }
        const progressCompleteNow = isProgressComplete(st);
        if (progressCompleteNow) {
          if (p.success > 0) {
            await finalizeAndDownload(jobId, { snapshot: st });
          } else {
            setJobError("Generation completed but no documents were generated successfully.");
            setJobStage("error");
          }
          return;
        }
        if (p.running > 0) {
          setRunnerNotice("The server is still processing this job. Retrying safely...");
          runnerRef.current.state = "statusOnly";
          await new Promise<void>((r) => setTimeout(r, 1500));
          continue;
        }
        if (p.pending <= 0) {
          setRunnerNotice("The server is still processing this job. Retrying safely...");
          await new Promise<void>((r) => setTimeout(r, 1500));
          continue;
        }

        try {
          const next = await runNextGenerationJob(jobId);
          setJob(next);
          runNextConsecutive504Ref.current = 0;
          const p2 = getProgress(next);
          const nextNa = String(next.nextAction ?? "").toLowerCase();
          const nextSLower = String(next.status ?? "").toLowerCase();
          if (nextNa === "stop" || nextSLower === "failed") {
            const hasDocxErr = Array.isArray(next.items) && next.items.some((i) => i?.errorCode === "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED");
            setJobError(
              hasDocxErr
                ? "Word template cannot be exported to PDF because DOCX-to-PDF converter is not configured."
                : (next.errorSummary ?? "Generation stopped"),
            );
            setJobStage("error");
            return;
          }
          if (isProgressComplete(next) && p2.success > 0) {
            await finalizeAndDownload(jobId, { snapshot: next });
            return;
          }
          setRunnerNotice(formatProcessingNotice(next));
          const backoff = 800 + Math.floor(Math.random() * 700);
          await new Promise<void>((r) => setTimeout(r, backoff));
        } catch (err) {
          const r = asRecord(err);
          const status =
            r && typeof (r as any).status === "number" ? Number((r as any).status) : null;
          if (status === 504 || status === 503 || err instanceof RequestTimeoutError) {
            runNextConsecutive504Ref.current += 1;
            setRunnerNotice("The server is still processing this job. Retrying safely...");
            try {
              const st2 = await getGenerationJobStatus(jobId);
              setJob(st2);
              const p3 = getProgress(st2);
              if (isProgressComplete(st2) && p3.success > 0) {
                await finalizeAndDownload(jobId, { snapshot: st2 });
                return;
              }
              if (runNextConsecutive504Ref.current >= 3) {
                setRunnerNotice("Generation is slow/stuck. Refresh Status or Continue Job.");
                setJobStage("ready");
                return;
              }
            } catch {}
            const backoff = 2000 + Math.floor(Math.random() * 3000);
            await new Promise<void>((r2) => setTimeout(r2, backoff));
            continue;
          }
          const msg = extractErrorMessage(err);
          setJobError(msg);
          setJobStage("error");
          return;
        }
      }
    } finally {
      runnerRef.current.running = false;
    }
  };

  const finalizeAndDownload = async (
    jobId: string,
    opts?: { force?: boolean; snapshot?: NormalizedGenerationJob | null },
  ) => {
    const force = opts?.force === true;
    if (force) {
      finalizeAttemptedJobIdRef.current = null;
      downloadAttemptedJobIdRef.current = null;
    }
    if (!jobId) throw new Error("jobId is missing");
    if (!force && downloadAttemptedJobIdRef.current === jobId) return;
    if (downloadInFlightRef.current) return;

    downloadInFlightRef.current = true;
    downloadAttemptedJobIdRef.current = jobId;
    try {
      devLog("finalizeAndDownload:start", { jobId, force });
      setJobError(null);
      setFinalizingZip(true);
      setActiveJobId(jobId);
      try {
        window.localStorage.setItem(storageKey, jobId);
      } catch {}

      let snap = opts?.snapshot ?? null;
      if (!snap) {
        snap = await getGenerationJobStatus(jobId);
        setJob(snap);
      }

      const s = String(snap.status ?? "");
      const p = getProgress(snap);
      const progressCompleteNow = isProgressComplete(snap);
      if (!progressCompleteNow || p.success <= 0) {
        setRunnerNotice(formatProcessingNotice(snap));
        setJobStage("generating");
        return;
      }
      const shouldFinalize =
        snap.nextAction === "finalize" ||
        s === "finalizing" ||
        (progressCompleteNow &&
          snap.nextAction !== "download" &&
          s !== "completed" &&
          s !== "completed_with_errors");

      if (shouldFinalize) {
        if (!force && finalizeAttemptedJobIdRef.current === jobId) {
          devLog("finalize:skipped", { jobId });
        } else if (!finalizeInFlightRef.current) {
          finalizeAttemptedJobIdRef.current = jobId;
          finalizeInFlightRef.current = true;
          setJobStage("finalizing");
          devLog("finalize:start", { jobId });
          try {
            const fin = await finalizeGenerationJob(jobId);
            setJob(fin);
            snap = fin;
            devLog("finalize:complete", { jobId, status: String(fin.status ?? "") });
          } finally {
            finalizeInFlightRef.current = false;
          }
        }
      }

      setJobStage("preparing_download");
      try {
        await downloadZipFromManifest(jobId, snap);
      } catch (err) {
        if (isJobNotReadyForDownload(err)) {
          setRunnerNotice(formatProcessingNotice(snap));
          setJobStage("generating");
          await continueJob(jobId);
          return;
        }
        throw err;
      }
      devLog("finalizeAndDownload:downloaded", { jobId });
      clearActiveJob();
    } catch (err) {
      const msg = extractErrorMessage(err);
      devLog("finalizeAndDownload:failed", { jobId, message: msg });
      setDownloadPrepError(msg || undefined);
      throw err;
    } finally {
      downloadInFlightRef.current = false;
      setFinalizingZip(false);
    }
  };

  useEffect(() => {
    if (busy) return;
    if (job) return;
    let jobId: string | null = null;
    try {
      jobId = window.localStorage.getItem(storageKey);
    } catch {
      jobId = null;
    }
    if (!jobId) return;
    if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) return;
    void (async () => {
      try {
        setActiveJobId(jobId);
        const st = await getGenerationJobStatus(jobId);

        const storedCreator = st.creatorUserId;
        const currentUserId = user?.id;
        if (storedCreator != null && currentUserId != null && Number(storedCreator) !== Number(currentUserId)) {
          setActiveJobId(null);
          try {
            window.localStorage.removeItem(storageKey);
          } catch {}
          return;
        }

        setJob(st);
        const displayNow = getDisplayStatus(st);
        const stLower = String(st.status ?? "").toLowerCase();
        const nextActionLower = String(st.nextAction ?? "").toLowerCase();
        const isTerminalFail =
          displayNow === "FAILED" || stLower === "failed" || nextActionLower === "stop";

        let lastPolled: number | null = null;
        try {
          const raw = window.localStorage.getItem(pollTimestampStorageKey);
          if (raw) lastPolled = Number(raw) || null;
        } catch {}
        const now = Date.now();
        const isStaleGenerating =
          displayNow === "GENERATING" &&
          lastPolled != null &&
          now - lastPolled > 15 * 60 * 1000;

        if (isTerminalFail) {
          setJobStage("ready");
          devLog("job:recovered:failed", { jobId, status: String(st.status ?? ""), nextAction: st.nextAction ?? null });
          setRunnerNotice(null);
        } else if (isStaleGenerating) {
          setJobStage("ready");
          try {
            const recheck = await getGenerationJobStatus(jobId);
            setJob(recheck);
            const stillStuck = getDisplayStatus(recheck) === "GENERATING";
            setRunnerNotice(
              stillStuck
                ? "This job appears to be stalled. Use Refresh Status or Retry Failed Step."
                : formatProcessingNotice(recheck),
            );
          } catch {
            setRunnerNotice("This job appears to be stalled. Use Refresh Status or Retry Failed Step.");
          }
        } else {
          setJobStage("ready");
          devLog("job:recovered", { jobId, status: String(st.status ?? ""), nextAction: st.nextAction ?? null });
          setRunnerNotice(
            canDownloadNow(st)
              ? "Previous generation job found. You can retry download."
              : formatProcessingNotice(st),
          );
        }
        try {
          window.localStorage.setItem(pollTimestampStorageKey, String(now));
        } catch {}
      } catch (err) {
        const msg = extractErrorMessage(err);
        setJobError(msg || "Failed to recover previous job");
        setJobStage("error");
      }
    })();
  }, [busy, job, storageKey, pollTimestampStorageKey, user?.id]);

  type AutomationBootstrapResponse = {
    cases:
      | { ok: true; items: AutomationCaseRow[]; total: number; limit: number }
      | { ok: false; error: string };
    folders:
      | { ok: true; items: FirmFolder[] }
      | { ok: false; error: string };
    templates:
      | { ok: true; items: FirmDocumentTemplate[] }
      | { ok: false; error: string };
    settings:
      | { ok: true; data: { showMasterDocuments: boolean; useMasterDocuments: boolean } }
      | { ok: false; error: string };
    permissions:
      | { ok: true; data: { permissions: Array<{ module: string; action: string }> } }
      | { ok: false; error: string };
  };

  const bootstrapQuery = useQuery<AutomationBootstrapResponse>({
    queryKey: ["document-automation", "bootstrap"],
    queryFn: ({ signal }) =>
      apiFetchJson("/documents/automation/bootstrap?limit=80", {
        signal,
        timeoutMs: 20000,
      }),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const b = bootstrapQuery.data;
    if (!b) return;
    if (b.cases.ok) {
      queryClient.setQueryData(["document-automation", "cases", ""], {
        items: b.cases.items,
        page: 1,
        limit: b.cases.limit,
      } satisfies AutomationCasesResponse);
    }
    if (b.folders.ok) {
      queryClient.setQueryData(["document-automation", "folders"], b.folders.items);
    }
    if (b.templates.ok) {
      queryClient.setQueryData(["document-automation", "templates"], b.templates.items);
    }
    if (b.settings.ok) {
      queryClient.setQueryData(["firm-settings", "document-automation"], b.settings.data);
    }
  }, [bootstrapQuery.data, queryClient]);

  const bootstrapReady = bootstrapQuery.isSuccess || bootstrapQuery.isError;

  const casesQuery = useQuery<AutomationCasesResponse>({
    queryKey: ["document-automation", "cases", caseSearch],
    enabled: bootstrapReady,
    queryFn: ({ signal }) =>
      apiFetchJson(
        `/documents/automation/cases?search=${encodeURIComponent(caseSearch)}&page=1&limit=80`,
        { signal, timeoutMs: 20000 },
      ),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const foldersQuery = useQuery<FirmFolder[]>({
    queryKey: ["document-automation", "folders"],
    enabled: bootstrapReady,
    queryFn: ({ signal }) =>
      apiFetchJson("/firm-document-folders?limit=2000", {
        signal,
        timeoutMs: 20000,
      }),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const templatesQuery = useQuery<FirmDocumentTemplate[]>({
    queryKey: ["document-automation", "templates"],
    enabled: bootstrapReady,
    queryFn: ({ signal }) =>
      apiFetchJson("/document-templates?templateCapable=true&kind=template&summary=1&limit=2000", {
        signal,
        timeoutMs: 20000,
      }),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const docxPdfHealthQuery = useQuery<{ ok: boolean; engine: string; configured: boolean; error?: string }>({
    queryKey: ["docx-pdf-health"],
    enabled: bootstrapReady,
    queryFn: ({ signal }) => apiFetchJson("/healthz/docx-pdf", { signal, timeoutMs: 10000 }),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const docxPdfConfigured = docxPdfHealthQuery.data?.configured !== false;

  const firmSettingsQuery = useQuery<{
    showMasterDocuments?: boolean;
    useMasterDocuments?: boolean;
  }>({
    queryKey: ["firm-settings", "document-automation"],
    enabled: bootstrapReady,
    queryFn: async ({ signal }) => {
      const res = await apiFetchJson<any>("/firm-settings", {
        signal,
        timeoutMs: 20000,
      });
      return res && typeof res === "object" && "data" in res
        ? (res as any).data
        : res;
    },
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const showMasterDocuments =
    (firmSettingsQuery.data?.showMasterDocuments ??
      firmSettingsQuery.data?.useMasterDocuments) !== false;

  type SystemFolder = {
    id: number;
    name: string;
    parentId: number | null;
    sortOrder: number;
    isDisabled: boolean;
  };
  type SystemDoc = {
    id: number;
    name: string;
    fileName: string;
    folderId: number | null;
  };
  const masterFoldersQuery = useQuery<SystemFolder[]>({
    queryKey: ["hub-folders", "document-automation"],
    queryFn: ({ signal }) =>
      apiFetchJson<SystemFolder[]>("/hub/folders", { signal, timeoutMs: 20000 }),
    enabled: showMasterDocuments,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const masterDocsQuery = useQuery<SystemDoc[]>({
    queryKey: ["hub-documents", "document-automation"],
    queryFn: async ({ signal }) => {
      const res = await apiFetchJson<any>("/hub/documents", {
        signal,
        timeoutMs: 20000,
      });
      if (Array.isArray(res)) return res as SystemDoc[];
      return Array.isArray(res?.documents)
        ? (res.documents as SystemDoc[])
        : [];
    },
    enabled: showMasterDocuments,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const lastCasesRef = useRef<AutomationCaseRow[]>(EMPTY_AUTOMATION_CASES);
  const lastFoldersRef = useRef<FirmFolder[]>(EMPTY_FIRM_FOLDERS);
  const lastTemplatesRef = useRef<FirmDocumentTemplate[]>(EMPTY_FIRM_TEMPLATES);
  const lastMasterFoldersRef = useRef<SystemFolder[]>([]);
  const lastMasterDocsRef = useRef<SystemDoc[]>([]);

  useEffect(() => {
    if (!casesQuery.isSuccess) return;
    const next = casesQuery.data?.items;
    if (!Array.isArray(next)) return;
    lastCasesRef.current = next;
  }, [casesQuery.data, casesQuery.isSuccess]);

  useEffect(() => {
    if (!foldersQuery.isSuccess) return;
    const next = foldersQuery.data;
    if (!Array.isArray(next)) return;
    lastFoldersRef.current = next;
  }, [foldersQuery.data, foldersQuery.isSuccess]);

  useEffect(() => {
    if (!templatesQuery.isSuccess) return;
    const next = templatesQuery.data;
    if (!Array.isArray(next)) return;
    lastTemplatesRef.current = next;
  }, [templatesQuery.data, templatesQuery.isSuccess]);

  useEffect(() => {
    if (!masterFoldersQuery.isSuccess) return;
    const next = masterFoldersQuery.data;
    if (!Array.isArray(next)) return;
    lastMasterFoldersRef.current = next;
  }, [masterFoldersQuery.data, masterFoldersQuery.isSuccess]);

  useEffect(() => {
    if (!masterDocsQuery.isSuccess) return;
    const next = masterDocsQuery.data;
    if (!Array.isArray(next)) return;
    lastMasterDocsRef.current = next;
  }, [masterDocsQuery.data, masterDocsQuery.isSuccess]);

  const cases = casesQuery.data?.items ?? lastCasesRef.current;
  const folders = foldersQuery.data ?? lastFoldersRef.current;
  const templates = templatesQuery.data ?? lastTemplatesRef.current;
  const masterFolders = masterFoldersQuery.data ?? lastMasterFoldersRef.current;
  const masterDocs = masterDocsQuery.data ?? lastMasterDocsRef.current;

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

  const templateNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of templates) {
      if (typeof t.id === "number") m.set(t.id, String(t.name ?? ""));
    }
    return m;
  }, [templates]);

  const selectedCaseIdSet = useMemo(
    () => new Set(selectedCaseIds),
    [selectedCaseIds],
  );
  const selectedTemplateIdSet = useMemo(
    () => new Set(selectedTemplateIds),
    [selectedTemplateIds],
  );
  const selectedMasterDocIdSet = useMemo(
    () => new Set(selectedMasterDocIds),
    [selectedMasterDocIds],
  );

  const selectedHasDocxTemplate = useMemo(() => {
    const hasFirmDocx = templates.some((t) => {
      if (!selectedTemplateIdSet.has(t.id)) return false;
      const ext = String(t.extension ?? "").trim().toLowerCase();
      return ext === "docx";
    });
    if (hasFirmDocx) return true;
    const hasMasterDocx = masterDocs.some((d) => {
      if (!selectedMasterDocIdSet.has(d.id)) return false;
      const fileName = String(d.fileName ?? "").trim().toLowerCase();
      return fileName.endsWith(".docx");
    });
    return hasMasterDocx;
  }, [masterDocs, selectedMasterDocIdSet, selectedTemplateIdSet, templates]);

  const blocksWordTemplates = selectedHasDocxTemplate && !docxPdfConfigured;

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

  const allCasesOnPageSelected =
    cases.length > 0 && cases.every((c) => selectedCaseIdSet.has(c.id));
  const someCasesOnPageSelected =
    cases.some((c) => selectedCaseIdSet.has(c.id)) && !allCasesOnPageSelected;

  function setAllCasesOnPage(checked: boolean) {
    if (!checked) {
      setSelectedCaseIds((prev) =>
        prev.filter((id) => !cases.some((c) => c.id === id)),
      );
      return;
    }
    setSelectedCaseIds((prev) =>
      Array.from(new Set([...prev, ...cases.map((c) => c.id)])),
    );
  }

  function toggleSelectCase(id: number) {
    setSelectedCaseIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const selectedCases = useMemo(() => {
    const out: AutomationCaseRow[] = [];
    for (const id of selectedCaseIds) {
      const c = caseCacheById.get(id);
      if (c) out.push(c);
    }
    return out;
  }, [caseCacheById, selectedCaseIds]);

  const selectedCaseKey = useMemo(
    () =>
      selectedCaseIds
        .slice()
        .sort((a, b) => a - b)
        .join(","),
    [selectedCaseIds],
  );

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

  const masterFolderChildren = useMemo(() => {
    const byParent = new Map<number | null, SystemFolder[]>();
    for (const f of masterFolders) {
      const k = f.parentId ?? null;
      const arr = byParent.get(k) ?? [];
      arr.push(f);
      byParent.set(k, arr);
    }
    for (const [k, arr] of byParent) {
      arr.sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );
      byParent.set(k, arr);
    }
    return byParent;
  }, [masterFolders]);

  const masterDocsByFolder = useMemo(() => {
    const m = new Map<number | null, SystemDoc[]>();
    for (const d of masterDocs) {
      const k = d.folderId ?? null;
      const arr = m.get(k) ?? [];
      arr.push(d);
      m.set(k, arr);
    }
    for (const [k, arr] of m) {
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      m.set(k, arr);
    }
    return m;
  }, [masterDocs]);

  const masterDocIdsInFolder = useMemo(() => {
    const memo = new Map<number | null, number[]>();
    const visit = (folderId: number | null): number[] => {
      if (memo.has(folderId)) return memo.get(folderId)!;
      const direct = (masterDocsByFolder.get(folderId) ?? []).map((d) => d.id);
      const children = masterFolderChildren.get(folderId) ?? [];
      const fromChildren = children.flatMap((c) => visit(c.id));
      const all = [...direct, ...fromChildren];
      memo.set(folderId, all);
      return all;
    };
    visit(null);
    return memo;
  }, [masterDocsByFolder, masterFolderChildren]);

  function toggleSelectTemplate(id: number) {
    setSelectedTemplateIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  useEffect(() => {
    if (!showMasterDocuments && templateSourceTab === "master")
      setTemplateSourceTab("firm");
  }, [showMasterDocuments, templateSourceTab]);

  useEffect(() => {
    if (!selectedCaseKey || smartDismissedKey === selectedCaseKey) {
      smartAppliedKeyRef.current = "";
      setSmartMessage(null);
      setSmartTemplateIdSet(new Set());
      setSmartFolderIdSet(new Set());
      return;
    }

    if (
      selectedCases.length === 0 ||
      folders.length === 0 ||
      templates.length === 0
    ) {
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

      const isRhbIslamic =
        loanBank.includes("rhb") && loanBank.includes("islamic");
      const isStrata = titleType === "strata";

      if (isRhbIslamic && isStrata) {
        const tokens = ["rhb", "islamic", "3rd", "party"];
        const match = folders.find((f) => {
          const path = folderPathById.get(f.id) ?? f.name;
          return (
            includesAllTokens(path, tokens) || includesAllTokens(f.name, tokens)
          );
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
          messages.push(
            `Auto-selected RHB Islamic 3rd Party templates (Strata)`,
          );
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

    const nextIdsSorted = Array.from(recommendedTemplateIds).sort(
      (a, b) => a - b,
    );
    const smartKey = `${selectedCaseKey}:${nextIdsSorted.join(",")}`;
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
    setSmartMessage(
      `✨ Smart Match: ${Array.from(new Set(messages)).join(" / ")}`,
    );

    /*
      Future AI extension point:
      - When users upload a Bank Letter of Offer (PDF), we can send it to:
        POST /api/ai/extract-data
      - The extracted structured fields (bank, amounts, key dates) can then be written back into the Case database,
        allowing the recommender to become data-driven instead of rule-only.
    */
  }, [
    folders,
    folderPathById,
    selectedCaseKey,
    selectedCases,
    smartDismissedKey,
    templateIdsInFolder,
    templates,
  ]);

  function setFolderTemplates(folderId: number | null, checked: boolean) {
    const ids = templateIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return;
    if (!checked) {
      setSelectedTemplateIds((prev) => prev.filter((id) => !ids.includes(id)));
      return;
    }
    setSelectedTemplateIds((prev) => Array.from(new Set([...prev, ...ids])));
  }

  function folderCheckboxState(folderId: number | null): {
    checked: boolean;
    indeterminate: boolean;
  } {
    const ids = templateIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return { checked: false, indeterminate: false };
    const selectedCount = ids.filter((id) =>
      selectedTemplateIdSet.has(id),
    ).length;
    if (selectedCount === 0) return { checked: false, indeterminate: false };
    if (selectedCount === ids.length)
      return { checked: true, indeterminate: false };
    return { checked: false, indeterminate: true };
  }

  function setMasterFolderDocs(folderId: number | null, checked: boolean) {
    const ids = masterDocIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return;
    if (!checked) {
      setSelectedMasterDocIds((prev) => prev.filter((id) => !ids.includes(id)));
      return;
    }
    setSelectedMasterDocIds((prev) => Array.from(new Set([...prev, ...ids])));
  }

  function masterFolderCheckboxState(folderId: number | null): {
    checked: boolean;
    indeterminate: boolean;
  } {
    const ids = masterDocIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return { checked: false, indeterminate: false };
    const selectedCount = ids.filter((id) =>
      selectedMasterDocIdSet.has(id),
    ).length;
    if (selectedCount === 0) return { checked: false, indeterminate: false };
    if (selectedCount === ids.length)
      return { checked: true, indeterminate: false };
    return { checked: false, indeterminate: true };
  }

  function applyBundle(
    bundleName: string,
    tokens: string[],
    coreTemplateTokens?: string[],
  ) {
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
      const core =
        coreTemplateTokens && coreTemplateTokens.length > 0
          ? ids.filter((tid) => {
              const t = templates.find((x) => x.id === tid);
              const n = safeText(t?.name).toLowerCase();
              return coreTemplateTokens.every((tk) =>
                n.includes(tk.toLowerCase()),
              );
            })
          : [];
      const picked = core.length > 0 ? core : ids;
      for (const tid of picked) templateIds.add(tid);
    } else {
      const matchedTemplates = templates.filter((t) =>
        includesAnyToken(safeText(t.name), tokens),
      );
      for (const t of matchedTemplates) templateIds.add(t.id);
    }

    if (templateIds.size === 0) {
      toast({
        title: "Bundle not found",
        description:
          "No matching folder/templates found in your template tree.",
      });
      return;
    }

    setSelectedTemplateIds((prev) =>
      Array.from(new Set([...prev, ...Array.from(templateIds)])),
    );
    setBundleFolderIdSet(folderIds);
    setBundleTemplateIdSet(templateIds);
    setBundleMessage(`Quick Select Bundle: ${bundleName}`);
  }

  async function runGenerate(mode: "download" | "print") {
    if (runnerRef.current.running) {
      toast({
        title: "Generation already running",
        description: "Please wait for the current job to finish before starting a new one.",
      });
      return;
    }
    if (selectedCaseIds.length === 0) {
      toast({ title: "Please select at least one case" });
      return;
    }
    if (selectedTemplateIds.length + selectedMasterDocIds.length === 0) {
      toast({ title: "Please select at least one document" });
      return;
    }
    if (blocksWordTemplates) {
      setJobError("Word template PDF conversion is not configured.");
      setJobStage("error");
      return;
    }
    if (mode === "print") {
      toast({
        title: "Print: Coming soon",
        description: "Current output is DOCX ZIP.",
      });
      mode = "download";
    }

    setJobStage("creating");
    setJob(null);
    setJobError(null);
    setRunnerNotice(null);
    setActiveJobId(null);
    finalizeAttemptedJobIdRef.current = null;
    downloadAttemptedJobIdRef.current = null;
    if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
    pollAbortRef.current?.abort();
    runnerRef.current.running = true;
    runnerRef.current.jobId = null;
    runnerRef.current.startedAt = Date.now();
    runnerRef.current.runNextAttempts = 0;
    runnerRef.current.state = "creatingJob";
    runnerRef.current.statusOnlyUntil = 0;
    runnerRef.current.finalizeRequestedAt = 0;
    try {
      const templates = [
        ...selectedTemplateIds.map((id) => ({ source: "firm" as const, id })),
        ...selectedMasterDocIds.map((id) => ({
          source: "master" as const,
          id,
        })),
      ];
      emitDbg({
        hypothesisId: "H1",
        msg: "runGenerate:start",
        data: {
          selectedCaseIds,
          templates,
        },
      });
      const created = await createGenerationJob({
        caseIds: selectedCaseIds,
        templates,
        config: { action: mode },
      });
      const jobId = created.jobId;
      if (!jobId) throw new Error("jobId is missing");
      runnerRef.current.jobId = jobId;
      setActiveJobId(jobId);
      setJobStage("generating");
      devLog("job:created", { jobId });
      try {
        window.localStorage.setItem(storageKey, jobId);
      } catch {}
      runnerRef.current.state = "runningItems";
      try {
        const initial = await getGenerationJobStatus(jobId);
        setJob(initial);
      } catch {}
      emitDbg({
        hypothesisId: "H1",
        msg: "runGenerate:job-created",
        data: { jobId },
      });

      const formatPollError = (err: unknown): string => {
        if (err instanceof RequestTimeoutError)
          return "Generation request timed out, checking job status...";
        if (isAbortLike(err))
          return "Generation request was interrupted, checking job status...";
        if (err instanceof Error) return err.message;
        const r = asRecord(err);
        const errObj = r ? (asRecord(r.error) ?? r) : null;
        const code = errObj ? safeText((errObj as any).code) : "";
        const msg = errObj ? safeText((errObj as any).message) : "";
        if (code && msg) return `${code}: ${msg}`;
        if (msg) return msg;
        const txt = String(err ?? "");
        return txt && txt !== "[object Object]" ? txt : "Request failed";
      };

      let stopped = false;
      const stopPolling = () => {
        stopped = true;
        if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        pollAbortRef.current?.abort();
      };

      const getApiErrorCode = (err: unknown): string => {
        const r = asRecord(err) ?? {};
        const direct = safeText((r as any).code);
        if (direct) return direct;
        const data = asRecord((r as any).data);
        const errObj = data ? (asRecord((data as any).error) ?? null) : null;
        return errObj ? safeText((errObj as any).code) : "";
      };

      const drive = async () => {
        const maxRuntimeMs = 10 * 60 * 1000;
        const getMaxRunNextAttempts = (snapshot: NormalizedGenerationJob | null) => {
          const totalFromJob = snapshot?.totalCount;
          const total =
            typeof totalFromJob === "number" && Number.isFinite(totalFromJob)
              ? totalFromJob
              : selectedCaseIds.length *
                (selectedTemplateIds.length + selectedMasterDocIds.length);
          const n = Number.isFinite(total) ? Math.max(1, total) : 1;
          return n + 3;
        };

        const stopWithError = (message: string) => {
          stopPolling();
          setJobError(message);
          setRunnerNotice(null);
          setJobStage("error");
        };

        while (!stopped) {
          if (runnerRef.current.jobId !== jobId) {
            stopPolling();
            return;
          }
          if (Date.now() - runnerRef.current.startedAt > maxRuntimeMs) {
            stopWithError("Generation timed out. Please retry.");
            return;
          }
          if (runNextInFlightRef.current) {
            await new Promise<void>((r) => setTimeout(r, 120));
            continue;
          }
          const now = Date.now();
          const shouldStatusOnly =
            runnerRef.current.state !== "runningItems" ||
            now < runnerRef.current.statusOnlyUntil;
          if (shouldStatusOnly) {
            if (runnerRef.current.state === "runningItems") {
              runnerRef.current.state = "statusOnly";
            }
            runNextInFlightRef.current = true;
            const startedAt = Date.now();
            try {
              pollAbortRef.current?.abort();
              const ctrl = new AbortController();
              pollAbortRef.current = ctrl;
              const st = await getGenerationJobStatus(jobId, { signal: ctrl.signal });
              setJob(st);
              setRunnerNotice(null);
              const s = String(st.status ?? "");
              const p = getProgress(st);
              devLog("status:poll", { jobId, status: s, nextAction: st.nextAction ?? null, progress: p });
              const progressCompleteNow = isProgressComplete(st);
              if (progressCompleteNow && p.success > 0) {
                stopPolling();
                try {
                  await finalizeAndDownload(jobId, { snapshot: st });
                } catch {}
                return;
              }

              if (st.nextAction === "finalize" || s === "finalizing") {
                runnerRef.current.state = "finalizing";
                setFinalizingZip(true);
                setJobStage("finalizing");
                await new Promise<void>((r) => setTimeout(r, 1200));
                continue;
              }

              if (
                st.nextAction === "download" ||
                s === "completed" ||
                s === "completed_with_errors"
              ) {
                setRunnerNotice(formatProcessingNotice(st));
                if (p.pending > 0 && p.running === 0) {
                  runnerRef.current.state = "runningItems";
                  runnerRef.current.statusOnlyUntil = 0;
                  await new Promise<void>((r) => setTimeout(r, 250));
                  continue;
                }
                runnerRef.current.state = "statusOnly";
                await new Promise<void>((r) => setTimeout(r, 1500));
                continue;
              }

              if (st.nextAction === "stop" || s === "failed" || s === "cancelled") {
                runnerRef.current.state = s === "cancelled" ? "cancelled" : "failed";
                const hasDocxPdfConfigError =
                  Array.isArray(st.items) &&
                  st.items.some((i) => i?.errorCode === "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED");
                stopWithError(
                  hasDocxPdfConfigError
                    ? "Word template cannot be exported to PDF because DOCX-to-PDF converter is not configured."
                    : (st.errorSummary ?? "Generation failed"),
                );
                return;
              }

              const running =
                s === "running" ||
                (typeof st.runningCount === "number" && st.runningCount > 0);
              const pending =
                typeof st.pendingCount === "number" && st.pendingCount > 0;
              if (st.nextAction === "run_next" && pending && !running) {
                runnerRef.current.state = "runningItems";
                runnerRef.current.statusOnlyUntil = 0;
                await new Promise<void>((r) => setTimeout(r, 250));
                continue;
              }

              runnerRef.current.state = "statusOnly";
              await new Promise<void>((r) => setTimeout(r, 1500));
              continue;
            } catch (err) {
              const status =
                err && typeof err === "object" && "status" in (err as any) && typeof (err as any).status === "number"
                  ? Number((err as any).status)
                  : null;
              if (status === 401) {
                stopWithError("Session expired. Please sign in again.");
                return;
              }
              pollConsecutiveErrorRef.current += 1;
              if (pollConsecutiveErrorRef.current >= 3) {
                stopWithError(formatPollError(err));
                return;
              }
              await new Promise<void>((r) => setTimeout(r, 1200));
              continue;
            } finally {
              runNextInFlightRef.current = false;
              emitDbg({
                hypothesisId: "H3",
                msg: "drive:status-only",
                data: { jobId, ms: Date.now() - startedAt },
              });
            }
          }

          const maxAttempts = getMaxRunNextAttempts(job);
          if (runnerRef.current.runNextAttempts >= maxAttempts) {
            stopWithError("Generation exceeded max attempts. Please retry.");
            return;
          }

          runnerRef.current.runNextAttempts += 1;
          runNextInFlightRef.current = true;
          const startedAt = Date.now();
          try {
            pollAbortRef.current?.abort();
            const ctrl = new AbortController();
            pollAbortRef.current = ctrl;
            const next = await runNextGenerationJob(jobId, { signal: ctrl.signal });
            pollConsecutiveErrorRef.current = 0;
            runNextConsecutive504Ref.current = 0;
            setJob(next);
            setRunnerNotice(null);
            const st = String(next.status ?? "");
            const p = getProgress(next);
            const progressCompleteNow = isProgressComplete(next);
            const nextAction =
              next.nextAction ??
              (() => {
                if (st === "completed" || st === "completed_with_errors") return "download";
                if (st === "finalizing") return "finalize";
                if (st === "failed") return "stop";
                if ((next.runningCount ?? 0) > 0) return "run_next";
                if (next.pendingCount > 0) return "run_next";
                return "run_next";
              })();
            devLog("run-next:ok", {
              jobId,
              status: st,
              nextAction,
              progress: p,
              ms: Date.now() - startedAt,
            });
            emitDbg({
              hypothesisId: "H3",
              msg: "drive:step-ok",
              data: {
                jobId,
                status: st,
                nextAction,
                successCount: next.successCount,
                failedCount: next.failedCount,
                pendingCount: next.pendingCount,
                totalCount: next.totalCount,
                ms: Date.now() - startedAt,
              },
            });

            if (progressCompleteNow && p.success > 0) {
              runnerRef.current.state = "downloading";
              stopPolling();
              try {
                await finalizeAndDownload(jobId, { snapshot: next });
              } catch {}
              return;
            }
            if (
              nextAction === "finalize" ||
              nextAction === "download" ||
              nextAction === "continue" ||
              nextAction === "wait"
            ) {
              setRunnerNotice(formatProcessingNotice(next));
              await new Promise<void>((r) => setTimeout(r, 600));
              continue;
            }
            if (nextAction === "stop" || st === "failed") {
              runnerRef.current.state = st === "cancelled" ? "cancelled" : "failed";
              stopPolling();
              const hasDocxPdfConfigError = Array.isArray(next.items) && next.items.some((i) => i?.errorCode === "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED");
              setJobError(
                hasDocxPdfConfigError
                  ? "Word template cannot be exported to PDF because DOCX-to-PDF converter is not configured."
                  : (next.errorSummary ?? "Generation failed"),
              );
              setJobStage("error");
              return;
            }
            await new Promise<void>((r) => setTimeout(r, 250));
          } catch (err) {
            const code = getApiErrorCode(err);
            const status =
              err && typeof err === "object" && "status" in (err as any) && typeof (err as any).status === "number"
                ? Number((err as any).status)
                : null;
            if (status === 401) {
              stopPolling();
              setJobError("Session expired. Please sign in again.");
              setJobStage("error");
              return;
            }
            if (code === "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED") {
              stopPolling();
              setJobError("Word template PDF conversion is not configured.");
              setJobStage("error");
              return;
            }
            if (code === "RUN_NEXT_IN_FLIGHT") {
              runnerRef.current.state = "statusOnly";
              runnerRef.current.statusOnlyUntil = Date.now() + 5_000;
              setRunnerNotice("Generation still running, checking status...");
              await new Promise<void>((r) => setTimeout(r, 2500));
              continue;
            }
            if (status === 409) {
              stopPolling();
              setJobError(formatPollError(err));
              setJobStage("error");
              return;
            }
            if (code === "JOB_NOT_FOUND" || status === 404) {
              stopPolling();
              try {
                const st = await getGenerationJobStatus(jobId);
                setJob(st);
                const na = st.nextAction ?? "";
                const s = String(st.status ?? "");
                if (
                  na === "download" ||
                  na === "finalize" ||
                  na === "stop" ||
                  s === "finalizing" ||
                  s === "completed" ||
                  s === "completed_with_errors" ||
                  s === "failed" ||
                  s === "cancelled"
                ) {
                  setJobError(
                    `Run-next failed with JOB_NOT_FOUND, but status indicates the job is "${s}" (nextAction="${na}"). Please use the available action (finalize/download) or start a new job.`,
                  );
                } else {
                  setJobError("Job not found (JOB_NOT_FOUND). Please start a new job.");
                }
              } catch {
                setJobError("Job not found (JOB_NOT_FOUND). Please start a new job.");
              }
              setJobStage("error");
              return;
            }
            if (
              err instanceof RequestTimeoutError ||
              isAbortLike(err)
            ) {
              setRunnerNotice("Previous runner timed out, resuming...");
              try {
                const st = await getGenerationJobStatus(jobId);
                setJob(st);
                const p = getProgress(st);
                const progressCompleteNow = isProgressComplete(st);
                if (progressCompleteNow && p.success > 0) {
                  stopPolling();
                  try {
                    await finalizeAndDownload(jobId, { snapshot: st });
                  } catch {}
                  return;
                }
              } catch (err2) {
                const msg = extractErrorMessage(err2);
                setJobError(msg || "Failed to resume job");
                setJobStage("error");
                return;
              }
              runnerRef.current.state = "statusOnly";
              runnerRef.current.statusOnlyUntil = Date.now() + 5_000;
              await new Promise<void>((r) => setTimeout(r, 2500));
              continue;
            }
            if (status === 503 || status === 504) {
              runNextConsecutive504Ref.current += 1;
              setRunnerNotice("The server is still processing this job. Retrying safely...");
              try {
                const st = await getGenerationJobStatus(jobId);
                setJob(st);
                const p = getProgress(st);
                if (isProgressComplete(st) && p.success > 0) {
                  stopPolling();
                  try {
                    await finalizeAndDownload(jobId, { snapshot: st });
                  } catch {}
                  return;
                }
                if (runNextConsecutive504Ref.current >= 3) {
                  stopPolling();
                  setRunnerNotice("Generation is slow/stuck. Refresh Status or Continue Job.");
                  setJobStage("ready");
                  return;
                }
              } catch {}
              runnerRef.current.state = "statusOnly";
              runnerRef.current.statusOnlyUntil = Date.now() + 5_000;
              const backoff = 2000 + Math.floor(Math.random() * 3000);
              await new Promise<void>((r) => setTimeout(r, backoff));
              continue;
            }
            pollConsecutiveErrorRef.current += 1;
            const msg = formatPollError(err);
            setJobError(msg);
            if (pollConsecutiveErrorRef.current >= 3) {
              stopPolling();
              setJobStage("error");
              return;
            }
            await new Promise<void>((r) => setTimeout(r, 700));
          } finally {
            runNextInFlightRef.current = false;
          }
        }
      };

      await drive();
    } catch (err) {
      toastError(toast, err);
    } finally {
      runnerRef.current.running = false;
      runnerRef.current.jobId = null;
      runnerRef.current.state = "idle";
      runnerRef.current.statusOnlyUntil = 0;
      runnerRef.current.finalizeRequestedAt = 0;
    }
  }

  function FolderNode({
    folder,
    depth,
  }: {
    folder: FirmFolder;
    depth: number;
  }) {
    const children = folderChildren.get(folder.id) ?? [];
    const [expanded, setExpanded] = useState(true);
    const cb = folderCheckboxState(folder.id);
    const hasChildren = children.length > 0;
    const hasTemplates = (templateIdsInFolder.get(folder.id) ?? []).length > 0;
    const isSmart =
      smartFolderIdSet.has(folder.id) || bundleFolderIdSet.has(folder.id);

    return (
      <div>
        <div
          className={cn(
            "flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50",
            isSmart && cb.checked && "bg-blue-50",
          )}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          <button
            className={cn("p-0.5", !hasChildren && "invisible")}
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-90",
              )}
            />
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
          {isSmart && cb.checked && (
            <span className="text-[10px] text-blue-600">✨</span>
          )}
        </div>

        {expanded && (
          <div>
            {(templatesByFolder.get(folder.id) ?? []).map((t) => (
              <div
                key={t.id}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50",
                  (smartTemplateIdSet.has(t.id) ||
                    bundleTemplateIdSet.has(t.id)) &&
                    selectedTemplateIdSet.has(t.id) &&
                    "bg-blue-50",
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
                {(smartTemplateIdSet.has(t.id) ||
                  bundleTemplateIdSet.has(t.id)) &&
                  selectedTemplateIdSet.has(t.id) && (
                    <span className="text-[10px] text-blue-600">✨</span>
                  )}
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

  function MasterFolderNode({
    folder,
    depth,
  }: {
    folder: SystemFolder;
    depth: number;
  }) {
    const children = masterFolderChildren.get(folder.id) ?? [];
    const [expanded, setExpanded] = useState(true);
    const cb = masterFolderCheckboxState(folder.id);
    const hasChildren = children.length > 0;
    const hasDocs = (masterDocIdsInFolder.get(folder.id) ?? []).length > 0;

    return (
      <div>
        <div
          className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          <button
            className={cn("p-0.5", !hasChildren && "invisible")}
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
          <Checkbox
            checked={cb.indeterminate ? "indeterminate" : cb.checked}
            disabled={!hasDocs}
            onCheckedChange={(v) => setMasterFolderDocs(folder.id, v === true)}
          />
          <button
            className="flex-1 truncate text-left"
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            {folder.name}
          </button>
        </div>

        {expanded && (
          <div>
            {(masterDocsByFolder.get(folder.id) ?? []).map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
                style={{ paddingLeft: `${(depth + 1) * 14 + 22}px` }}
              >
                <Checkbox
                  checked={selectedMasterDocIdSet.has(d.id)}
                  onCheckedChange={(v) => {
                    const checked = v === true;
                    setSelectedMasterDocIds((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(d.id);
                      else next.delete(d.id);
                      return Array.from(next);
                    });
                  }}
                />
                <FileText className="h-3.5 w-3.5 text-slate-500" />
                <div className="flex-1 truncate">{d.name}</div>
              </div>
            ))}
            {children.map((c) => (
              <MasterFolderNode key={c.id} folder={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const canViewTechnicalDetails = (() => {
    if (!user) return false;
    if (user.userType === "founder") return true;
    const rn = String((user as any)?.roleName ?? "").trim().toLowerCase();
    if (rn.includes("partner")) return true;
    if (rn === "admin" || rn.includes("admin")) return true;
    if (hasPermission(user, "audit", "read")) return true;
    return false;
  })();

  function mapFailureStage(phase: string | null | undefined, errorCode: string | null | undefined): string {
    const p = String(phase ?? "").toLowerCase();
    const c = String(errorCode ?? "").toUpperCase();
    if (p.includes("case") || p.includes("context") || p.includes("data")) return "Case Data Load";
    if (p.includes("template") || c.includes("TEMPLATE")) return "Template Load";
    if (p.includes("variable") || p.includes("resolve") || c.includes("VARIABLE")) return "Variable Resolution";
    if (p.includes("generat") || p.includes("render") || c.includes("DOCX") || c.includes("PDF")) return "Document Generation";
    if (p.includes("storage") || p.includes("object") || p.includes("write") || c.includes("OUTPUT") || c.includes("STORAGE")) return "Storage Write";
    if (p.includes("status") || p.includes("update") || p.includes("finaliz")) return "Job Status Update";
    if (p.includes("zip") || p.includes("packag") || p.includes("assemble")) return "Package Assembly";
    if (p) return p.charAt(0).toUpperCase() + p.slice(1);
    return "Processing";
  }

  function mapHumanError(item: NormalizedGenerationJob["items"][number]): string {
    const code = String(item?.errorCode ?? "").toUpperCase();
    const msg = safeText(item?.errorMessage);
    if (code.includes("TEMPLATE_FILE_MISSING") || code.includes("TEMPLATE_NOT_FOUND")) return "Template file is missing. Re-upload the template.";
    if (code.includes("DOCX_TO_PDF_ENGINE_NOT_CONFIGURED")) return "PDF conversion is not configured for Word templates.";
    if (code.includes("OUTPUT_MISSING")) return "Generation completed but no output file was produced.";
    if (code.includes("VARIABLE") || msg.toLowerCase().includes("variable")) return msg || "A required variable could not be resolved.";
    if (code.includes("CASE") || msg.toLowerCase().includes("case")) return msg || "Case data could not be loaded.";
    if (code.includes("TIMEOUT") || msg.toLowerCase().includes("timeout")) return "Generation timed out. Try with fewer items.";
    if (code.includes("PERMISSION") || code.includes("FORBIDDEN") || msg.toLowerCase().includes("permission")) return "You do not have permission to generate this document.";
    if (code.includes("RLS") || code.includes("ROW LEVEL")) return "Access denied by tenant policy.";
    if (msg) return msg;
    return "Unknown generation error";
  }

  function isRetryableFailure(item: NormalizedGenerationJob["items"][number]): boolean {
    const code = String(item?.errorCode ?? "").toUpperCase();
    if (code.includes("DOCX_TO_PDF_ENGINE_NOT_CONFIGURED")) return false;
    if (code.includes("PERMISSION") || code.includes("FORBIDDEN")) return false;
    if (code.includes("RLS") || code.includes("ROW LEVEL")) return false;
    return true;
  }

  const retryCountExceeded = retryAttemptsRef.current >= maxRetryAttemptsPerPageLoad;

  const initiateRetryContinue = (jobId: string, opts?: { confirm?: boolean }) => {
    if (!jobId) return;
    if (retryAttemptsRef.current >= maxRetryAttemptsPerPageLoad) return;
    retryAttemptsRef.current += 1;
    if (opts?.confirm === true) {
      toast({
        title: "Retrying job",
        description:
          "This will retry failed and pending items; successful outputs will NOT be duplicated.",
      });
    }
    void continueJob(jobId);
  };

  function StatusBadge({ status }: { status: DocGenDisplayStatus }) {
    const map: Record<DocGenDisplayStatus, { label: string; className: string; icon: any }> = {
      GENERATING: { label: "Generating", className: "bg-blue-50 text-blue-700 border-blue-200", icon: Loader2 },
      COMPLETED: { label: "Completed", className: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
      PARTIALLY_COMPLETED: { label: "Partially completed", className: "bg-amber-50 text-amber-700 border-amber-200", icon: AlertTriangle },
      FAILED: { label: "Failed", className: "bg-rose-50 text-rose-700 border-rose-200", icon: XCircle },
      CANCELLED: { label: "Cancelled", className: "bg-slate-100 text-slate-700 border-slate-200", icon: XCircle },
      GENERATED_DOWNLOAD_FAILED: { label: "Package not ready", className: "bg-violet-50 text-violet-700 border-violet-200", icon: FolderArchive },
    };
    const v = map[status];
    const Icon = v.icon;
    return (
      <Badge variant="outline" className={`gap-1.5 inline-flex items-center ${v.className}`}>
        <Icon className={`h-3 w-3 ${status === "GENERATING" ? "animate-spin" : ""}`} />
        {v.label}
      </Badge>
    );
  }

  const displayStatus = job ? getDisplayStatus(job) : null;
  const failedItems = job?.items?.filter((i) => String(i.status) === "failed") ?? [];
  const successItems = job?.items?.filter((i) => String(i.status) === "success") ?? [];
  const [failedOpen, setFailedOpen] = useState(true);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
          Document Automation Hub
        </h1>
        <p className="text-slate-500">
          Batch generate PDFs, export ZIPs, and prepare system print packages
          with full audit logging.
        </p>
      </div>

      <Card className="border-slate-200">
        <CardContent className="p-0">
          <ResizablePanelGroup direction="horizontal" className="h-[720px]">
            <ResizablePanel defaultSize={34} minSize={26}>
              <div className="h-full flex flex-col">
                <div className="p-4 border-b bg-white">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="font-semibold text-slate-900">
                        Case Selection
                      </div>
                      <div className="text-xs text-slate-500">
                        Select one or multiple cases
                      </div>
                    </div>
                    <div className="text-xs text-slate-500">
                      Selected: {selectedCaseIds.length}
                    </div>
                  </div>
                  <div className="mt-3">
                    <Input
                      value={caseSearchRaw}
                      onChange={(e) => setCaseSearchRaw(e.target.value)}
                      placeholder="Search by reference / parcel / purchaser..."
                    />
                    {casesQuery.isError && !isAbortLike(casesQuery.error) ? (
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-amber-700">
                        <div className="truncate">Unable to load cases.</div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void casesQuery.refetch()}
                          disabled={casesQuery.isFetching}
                        >
                          Retry
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex-1 overflow-auto bg-white">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white border-b">
                      <tr className="text-xs text-slate-500">
                        <th className="w-10 px-3 py-2">
                          <Checkbox
                            checked={
                              someCasesOnPageSelected
                                ? "indeterminate"
                                : allCasesOnPageSelected
                            }
                            onCheckedChange={(v) =>
                              setAllCasesOnPage(v === true)
                            }
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
                            <div className="text-slate-900">
                              {c.parcelNo || "-"}
                            </div>
                            <div className="text-xs text-slate-500">
                              {c.referenceNo}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            {c.purchaserName || "-"}
                          </td>
                          <td className="px-3 py-2 align-top">
                            {c.loanBank || "-"}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="line-clamp-2 text-slate-700">
                              {c.status}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {cases.length === 0 && (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-4 py-10 text-center text-sm text-slate-400"
                          >
                            {casesQuery.isLoading || !bootstrapReady
                              ? "Loading cases..."
                              : casesQuery.isError && !isAbortLike(casesQuery.error)
                                ? "Unable to load cases."
                                : casesQuery.isSuccess
                                  ? "No cases found"
                                  : "Loading cases..."}
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
                      <div className="font-semibold text-slate-900">
                        Template / Folder Selector
                      </div>
                      <div className="text-xs text-slate-500">
                        Select templates or entire folders
                      </div>
                    </div>
                    <div className="text-xs text-slate-500">
                      Selected:{" "}
                      {selectedTemplateIds.length + selectedMasterDocIds.length}
                    </div>
                  </div>
                  <div className="mt-3">
                    <Tabs
                      value={templateSourceTab}
                      onValueChange={(v) =>
                        setTemplateSourceTab(v === "master" ? "master" : "firm")
                      }
                    >
                      <TabsList
                        className={cn(
                          "grid w-full",
                          showMasterDocuments ? "grid-cols-2" : "grid-cols-1",
                        )}
                      >
                        <TabsTrigger value="firm">Firm Documents</TabsTrigger>
                        {showMasterDocuments && (
                          <TabsTrigger value="master">
                            Master Documents
                          </TabsTrigger>
                        )}
                      </TabsList>
                    </Tabs>
                  </div>

                  {templateSourceTab === "firm" &&
                  foldersQuery.isError &&
                  !isAbortLike(foldersQuery.error) ? (
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-amber-700">
                      <div className="truncate">Unable to load folders.</div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void foldersQuery.refetch()}
                        disabled={foldersQuery.isFetching}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}

                  {templateSourceTab === "firm" &&
                  templatesQuery.isError &&
                  !isAbortLike(templatesQuery.error) ? (
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-amber-700">
                      <div className="truncate">Unable to load templates.</div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void templatesQuery.refetch()}
                        disabled={templatesQuery.isFetching}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}

                  {templateSourceTab === "master" &&
                  showMasterDocuments &&
                  masterFoldersQuery.isError &&
                  !isAbortLike(masterFoldersQuery.error) ? (
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-amber-700">
                      <div className="truncate">Unable to load master folders.</div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void masterFoldersQuery.refetch()}
                        disabled={masterFoldersQuery.isFetching}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}

                  {templateSourceTab === "master" &&
                  showMasterDocuments &&
                  masterDocsQuery.isError &&
                  !isAbortLike(masterDocsQuery.error) ? (
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-amber-700">
                      <div className="truncate">Unable to load master documents.</div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void masterDocsQuery.refetch()}
                        disabled={masterDocsQuery.isFetching}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}

                  {templateSourceTab === "firm" && (
                    <>
                      <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="text-xs font-medium text-slate-700">
                          Quick Select Bundles
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              applyBundle(
                                "RHB Islamic",
                                ["rhb", "islamic"],
                                ["facility", "agreement"],
                              )
                            }
                          >
                            RHB Islamic
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              applyBundle(
                                "Maybank 3rd Party",
                                ["maybank", "3rd", "party"],
                                ["facility", "agreement"],
                              )
                            }
                          >
                            Maybank 3rd Party
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              applyBundle("Standard SPA", ["spa"], [])
                            }
                          >
                            Standard SPA
                          </Button>
                        </div>
                        {bundleMessage && (
                          <div className="mt-2 text-xs text-slate-600">
                            {bundleMessage}
                          </div>
                        )}
                      </div>
                      {smartMessage && (
                        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 flex items-start justify-between gap-3">
                          <div className="leading-relaxed">{smartMessage}</div>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-6 px-2 text-xs text-blue-800 hover:bg-blue-100"
                            onClick={() =>
                              setSmartDismissedKey(selectedCaseKey)
                            }
                          >
                            Dismiss
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="flex-1 overflow-auto bg-white">
                  <div className="p-2">
                    {templateSourceTab === "firm" && (
                      <>
                        {(folderChildren.get(null) ?? []).map((f) => (
                          <FolderNode key={f.id} folder={f} depth={0} />
                        ))}
                        {(templatesByFolder.get(null) ?? []).length > 0 && (
                          <div className="mt-2">
                            <div className="px-2 py-1 text-xs font-medium text-slate-500">
                              Uncategorized
                            </div>
                            {(templatesByFolder.get(null) ?? []).map((t) => (
                              <div
                                key={t.id}
                                className={cn(
                                  "flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50",
                                  (smartTemplateIdSet.has(t.id) ||
                                    bundleTemplateIdSet.has(t.id)) &&
                                    selectedTemplateIdSet.has(t.id) &&
                                    "bg-blue-50",
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
                                {(smartTemplateIdSet.has(t.id) ||
                                  bundleTemplateIdSet.has(t.id)) &&
                                  selectedTemplateIdSet.has(t.id) && (
                                    <span className="text-[10px] text-blue-600">
                                      ✨
                                    </span>
                                  )}
                              </div>
                            ))}
                          </div>
                        )}

                        {(templatesQuery.isLoading || !bootstrapReady) && templates.length === 0 && (
                          <div className="px-4 py-10 text-center text-sm text-slate-400">
                            Loading templates...
                          </div>
                        )}
                        {templates.length === 0 &&
                          bootstrapReady &&
                          !templatesQuery.isLoading &&
                          !templatesQuery.isFetching &&
                          templatesQuery.isSuccess && (
                            <div className="px-4 py-10 text-center text-sm text-slate-400">
                              No templates found
                            </div>
                          )}
                        {templates.length === 0 &&
                          bootstrapReady &&
                          !templatesQuery.isLoading &&
                          templatesQuery.isError &&
                          !isAbortLike(templatesQuery.error) && (
                            <div className="px-4 py-10 text-center text-sm text-slate-400">
                              Unable to load templates.
                            </div>
                          )}
                      </>
                    )}

                    {templateSourceTab === "master" && !showMasterDocuments && (
                      <div className="px-4 py-10 text-center text-sm text-slate-400">
                        Master Documents are disabled
                      </div>
                    )}

                    {templateSourceTab === "master" && showMasterDocuments && (
                      <>
                        {(masterFolderChildren.get(null) ?? []).map((f) => (
                          <MasterFolderNode key={f.id} folder={f} depth={0} />
                        ))}
                        {(masterDocsByFolder.get(null) ?? []).length > 0 && (
                          <div className="mt-2">
                            <div className="px-2 py-1 text-xs font-medium text-slate-500">
                              Uncategorized
                            </div>
                            {(masterDocsByFolder.get(null) ?? []).map((d) => (
                              <div
                                key={d.id}
                                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
                              >
                                <Checkbox
                                  checked={selectedMasterDocIdSet.has(d.id)}
                                  onCheckedChange={(v) => {
                                    const checked = v === true;
                                    setSelectedMasterDocIds((prev) => {
                                      const next = new Set(prev);
                                      if (checked) next.add(d.id);
                                      else next.delete(d.id);
                                      return Array.from(next);
                                    });
                                  }}
                                />
                                <FileText className="h-3.5 w-3.5 text-slate-500" />
                                <div className="flex-1 truncate">{d.name}</div>
                              </div>
                            ))}
                          </div>
                        )}

                        {(masterDocsQuery.isLoading || !bootstrapReady) && masterDocs.length === 0 && (
                          <div className="px-4 py-10 text-center text-sm text-slate-400">
                            Loading documents...
                          </div>
                        )}
                        {masterDocs.length === 0 &&
                          bootstrapReady &&
                          !masterDocsQuery.isLoading &&
                          !masterDocsQuery.isFetching &&
                          masterDocsQuery.isSuccess && (
                            <div className="px-4 py-10 text-center text-sm text-slate-400">
                              No documents found
                            </div>
                          )}
                        {masterDocs.length === 0 &&
                          bootstrapReady &&
                          !masterDocsQuery.isLoading &&
                          masterDocsQuery.isError &&
                          !isAbortLike(masterDocsQuery.error) && (
                            <div className="px-4 py-10 text-center text-sm text-slate-400">
                              Unable to load documents.
                            </div>
                          )}
                      </>
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
                    <div className="font-semibold text-slate-900">
                      Configuration & Actions
                    </div>
                    <div className="text-xs text-slate-500">
                      Download ZIP or prepare system print output
                    </div>
                  </div>
                </div>

                <div className="p-4 space-y-4 overflow-auto">
                  <Tabs
                    value={activeMode}
                    onValueChange={(v) =>
                      setActiveMode(v === "print" ? "print" : "download")
                    }
                  >
                    {blocksWordTemplates && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        Word templates require PDF conversion service before generation.
                      </div>
                    )}
                    <TabsList className="grid grid-cols-2 w-full">
                      <TabsTrigger value="download" className="gap-2">
                        <FileText className="h-4 w-4" />
                        Download ZIP
                      </TabsTrigger>
                      <TabsTrigger
                        value="print"
                        disabled={selectedMasterDocIds.length > 0}
                        className="gap-2"
                      >
                        <Printer className="h-4 w-4" />
                        System Print
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="download" className="mt-4 space-y-3">
                      <div className="text-sm text-slate-600">
                        Generates PDFs, applies naming rules, and exports a ZIP
                        with the required folder structure.
                      </div>
                      {hasActiveJob && job && displayStatus && (
                        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
                          <div className="p-4 border-b bg-slate-50/50">
                            <div className="flex items-start justify-between gap-3">
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <StatusBadge status={displayStatus} />
                                  <span className="text-[11px] text-slate-400 font-mono">
                                    {activeJobId?.slice(0, 8)}…
                                  </span>
                                </div>
                                <div className="text-base font-semibold text-slate-900 leading-tight">
                                  {getJobTitle(job)}
                                </div>
                                <div className="text-sm text-slate-600">
                                  {getJobSummary(job)}
                                </div>
                              </div>
                            </div>

                            <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                              <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2">
                                <div className="text-[10px] uppercase tracking-wider text-slate-500">Processed</div>
                                <div className="mt-0.5 text-sm font-semibold text-slate-900">
                                  {(getProgress(job).success + getProgress(job).failed)} / {getProgress(job).total || 0}
                                </div>
                              </div>
                              <div className="rounded-md border border-emerald-200 bg-emerald-50/50 px-2.5 py-2">
                                <div className="text-[10px] uppercase tracking-wider text-emerald-700">Succeeded</div>
                                <div className="mt-0.5 text-sm font-semibold text-emerald-900">
                                  {getProgress(job).success}
                                </div>
                              </div>
                              <div className="rounded-md border border-rose-200 bg-rose-50/50 px-2.5 py-2">
                                <div className="text-[10px] uppercase tracking-wider text-rose-700">Failed</div>
                                <div className="mt-0.5 text-sm font-semibold text-rose-900">
                                  {getProgress(job).failed}
                                </div>
                              </div>
                              <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2">
                                <div className="text-[10px] uppercase tracking-wider text-slate-500">Pending</div>
                                <div className="mt-0.5 text-sm font-semibold text-slate-900">
                                  {getProgress(job).pending}
                                </div>
                              </div>
                              <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2">
                                <div className="text-[10px] uppercase tracking-wider text-slate-500">Running</div>
                                <div className="mt-0.5 text-sm font-semibold text-slate-900 flex items-center gap-1">
                                  {getProgress(job).running ?? 0}
                                  {(getProgress(job).running ?? 0) > 0 ? <Loader2 className="h-3 w-3 animate-spin text-blue-600" /> : null}
                                </div>
                              </div>
                            </div>

                            {runnerNotice ? (
                              <div className="mt-3 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-md px-2.5 py-1.5">
                                {runnerNotice}
                              </div>
                            ) : null}
                            {jobError ? (
                              <div className="mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-md px-2.5 py-1.5">
                                {jobError}
                              </div>
                            ) : null}
                          </div>

                          {failedItems.length > 0 ? (
                            <Collapsible
                              open={failedOpen}
                              onOpenChange={setFailedOpen}
                              className="border-b"
                            >
                              <CollapsibleTrigger asChild>
                                <button
                                  type="button"
                                  className="w-full text-left px-4 py-2.5 flex items-center justify-between hover:bg-slate-50"
                                >
                                  <div className="flex items-center gap-2 text-sm">
                                    <XCircle className="h-4 w-4 text-rose-600" />
                                    <span className="font-medium text-slate-900">Failed items ({failedItems.length})</span>
                                  </div>
                                  <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${failedOpen ? "rotate-180" : ""}`} />
                                </button>
                              </CollapsibleTrigger>
                              <CollapsibleContent className="border-t bg-white">
                                <ul className="divide-y max-h-72 overflow-auto">
                                  {failedItems.map((item, idx) => {
                                    const c = caseCacheById.get(item.caseId ?? 0);
                                    const caseRef = c?.referenceNo || (item.caseId ? `Case #${item.caseId}` : "-");
                                    const purchaser = c?.purchaserName ?? "-";
                                    const stage = mapFailureStage((item as any).phase, item.errorCode);
                                    const human = mapHumanError(item);
                                    const templateName = safeText(item.templateName) || `Template #${item.templateId ?? "?"}`;
                                    return (
                                      <li key={item.id ?? idx} className="px-4 py-3">
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="space-y-1 min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                              <span className="text-xs font-mono text-slate-700 truncate max-w-[180px]">{caseRef}</span>
                                              <span className="text-slate-300 text-xs">·</span>
                                              <span className="text-xs text-slate-600 truncate max-w-[200px]">{purchaser}</span>
                                              <span className="text-slate-300 text-xs">·</span>
                                              <Badge variant="outline" className="text-[10px] font-normal">{templateName}</Badge>
                                              <Badge variant="outline" className="text-[10px] font-normal border-rose-200 text-rose-700 bg-rose-50/50">{stage}</Badge>
                                            </div>
                                            <div className="text-sm text-rose-700 leading-snug">
                                              {human}
                                            </div>
                                          </div>
                                        </div>
                                        {canViewTechnicalDetails && item.diagnostic ? (
                                          <Collapsible className="mt-2">
                                            <CollapsibleTrigger asChild>
                                              <button type="button" className="text-[11px] text-slate-500 hover:text-slate-700 underline underline-offset-2">
                                                View Technical Details
                                              </button>
                                            </CollapsibleTrigger>
                                            <CollapsibleContent className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2.5 font-mono text-[10px] text-slate-700 whitespace-pre-wrap max-h-56 overflow-auto">
{[
  item.errorCode ? `error_code: ${item.errorCode}` : null,
  item.errorMessage ? `message: ${item.errorMessage}` : null,
  (item as any).phase ? `worker_stage: ${(item as any).phase}` : null,
  `diagnostic: ${JSON.stringify(item.diagnostic, null, 2)}`,
].filter(Boolean).join("\n")}
                                            </CollapsibleContent>
                                          </Collapsible>
                                        ) : null}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </CollapsibleContent>
                            </Collapsible>
                          ) : null}

                          <div className="p-3 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy || !activeJobId}
                              onClick={() => {
                                if (!activeJobId) return;
                                void (async () => {
                                  setJobError(null);
                                  try {
                                    const st = await getGenerationJobStatus(activeJobId);
                                    setJob(st);
                                    devLog("job:refresh", {
                                      jobId: activeJobId,
                                      status: String(st.status ?? ""),
                                      nextAction: st.nextAction ?? null,
                                    });
                                    setJobStage("ready");
                                  } catch (err) {
                                    const msg = extractErrorMessage(err);
                                    setJobError(msg || "Failed to refresh job status");
                                    setJobStage("error");
                                  }
                                })();
                              }}
                            >
                              Refresh Status
                            </Button>
                            {(() => {
                              const p = getProgress(job);
                              const stLower = String(job?.status ?? "").toLowerCase();
                              const naLower = String(job?.nextAction ?? "").toLowerCase();
                              const hasWorkPending = p.pending > 0 || p.running > 0;
                              const driveStoppedBy504 = runNextConsecutive504Ref.current >= 3;
                              const isPausedState = stLower === "paused";
                              const retryDisabledCommon =
                                busy || !activeJobId || retryCountExceeded;
                              const retryBtnTitle = retryCountExceeded
                                ? "Too many retries this session — please Refresh and try again."
                                : undefined;

                              if (retryCountExceeded && failedItems.length > 0 && displayStatus === "FAILED") {
                                return (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={true}
                                    title="Too many retries this session — please Refresh and try again."
                                  >
                                    Too many retries — Refresh
                                  </Button>
                                );
                              }

                              if (displayStatus === "FAILED" && failedItems.length > 0) {
                                const allRetryable = failedItems.every(isRetryableFailure);
                                const someNonRetryable = failedItems.some((i) => !isRetryableFailure(i));

                                if (allRetryable) {
                                  return (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={retryDisabledCommon}
                                      title={retryBtnTitle}
                                      onClick={() => {
                                        if (!activeJobId) return;
                                        initiateRetryContinue(activeJobId, { confirm: false });
                                      }}
                                    >
                                      Retry Failed Step
                                    </Button>
                                  );
                                }
                                if (someNonRetryable && p.pending === 0 && stLower === "failed") {
                                  return (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={retryDisabledCommon}
                                      title={retryBtnTitle}
                                      onClick={() => {
                                        if (!activeJobId) return;
                                        initiateRetryContinue(activeJobId, { confirm: true });
                                      }}
                                    >
                                      Retry Job
                                    </Button>
                                  );
                                }
                                if (someNonRetryable) {
                                  return (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={retryDisabledCommon}
                                      title={retryBtnTitle}
                                      onClick={() => {
                                        if (!activeJobId) return;
                                        initiateRetryContinue(activeJobId, { confirm: true });
                                      }}
                                    >
                                      Retry Failed Step
                                    </Button>
                                  );
                                }
                              }

                              const showContinue =
                                Boolean(activeJobId) &&
                                displayStatus === "GENERATING" &&
                                hasWorkPending &&
                                (isPausedState || driveStoppedBy504) &&
                                !canRetryDownload(job);
                              if (showContinue) {
                                return (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={busy || !activeJobId}
                                    onClick={() => {
                                      if (!activeJobId) return;
                                      void continueJob(activeJobId);
                                    }}
                                  >
                                    Continue Job
                                  </Button>
                                );
                              }
                              return null;
                            })()}
                            {canDownloadSuccessfulFiles(job) && displayStatus !== "GENERATED_DOWNLOAD_FAILED" ? (
                              <Button
                                type="button"
                                size="sm"
                                disabled={busy || !activeJobId}
                                onClick={() => {
                                  if (!activeJobId) return;
                                  void (async () => {
                                    try {
                                      await finalizeAndDownload(activeJobId, { force: true, snapshot: job });
                                    } catch {}
                                  })();
                                }}
                              >
                                {displayStatus === "COMPLETED" ? "Download ZIP" : "Download Successful Files"}
                              </Button>
                            ) : null}
                            {canRetryDownload(job) ? (
                              <Button
                                type="button"
                                size="sm"
                                disabled={busy || !activeJobId}
                                onClick={() => {
                                  if (!activeJobId) return;
                                  void (async () => {
                                    try {
                                      await finalizeAndDownload(activeJobId, { force: true, snapshot: job });
                                    } catch {}
                                  })();
                                }}
                              >
                                Retry Download
                              </Button>
                            ) : null}
                            {canRetryFailedItems(job) && displayStatus !== "FAILED" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy || !activeJobId || retryCountExceeded}
                                title={retryCountExceeded ? "Too many retries this session — please Refresh and try again." : undefined}
                                onClick={() => {
                                  if (!activeJobId) return;
                                  initiateRetryContinue(activeJobId, { confirm: false });
                                }}
                              >
                                Retry Failed Step
                              </Button>
                            ) : null}
                            {canClearJob(job) ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => clearActiveJob()}
                              >
                                Clear Job
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      )}
                      <Button
                        disabled={busy || (hasActiveJob && displayStatus === "GENERATING") || blocksWordTemplates}
                        className="w-full"
                        onClick={() => runGenerate("download")}
                      >
                        {jobStage === "creating"
                          ? "Creating..."
                          : jobStage === "generating"
                            ? "Generating..."
                            : jobStage === "finalizing"
                              ? "Finalizing..."
                              : jobStage === "preparing_download"
                                ? "Preparing download..."
                                : jobStage === "downloading"
                                  ? "Downloading..."
                                  : jobStage === "packaging"
                                    ? "Packaging ZIP..."
                                    : hasActiveJob && displayStatus === "GENERATING"
                                      ? "Job Active"
                                      : "Generate & Download"}
                      </Button>
                    </TabsContent>

                    <TabsContent value="print" className="mt-4 space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label>Copies</Label>
                          <Input
                            value={copies}
                            onChange={(e) => setCopies(e.target.value)}
                            inputMode="numeric"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Duplex Mode</Label>
                          <Select
                            value={duplexMode}
                            onValueChange={(v) =>
                              setDuplexMode(
                                v === "single"
                                  ? "single"
                                  : v === "custom"
                                    ? "custom"
                                    : "double",
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="double">
                                All Double-Sided
                              </SelectItem>
                              <SelectItem value="single">
                                All Single-Sided
                              </SelectItem>
                              <SelectItem value="custom">
                                Custom Duplex Range
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {duplexMode === "custom" && (
                        <div className="space-y-1.5">
                          <Label>Custom Duplex Range</Label>
                          <Input
                            value={customDuplexRange}
                            onChange={(e) =>
                              setCustomDuplexRange(e.target.value)
                            }
                            placeholder="e.g. 1-2 single; 3-10 double"
                          />
                        </div>
                      )}

                      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 leading-relaxed">
                        Printing settings are recorded for audit. The actual
                        duplex/copies are applied in your system print dialog.
                      </div>
                      {busy && (
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                          <div className="font-medium">Generating...</div>
                          <div className="mt-1 text-xs text-slate-600">
                            {(() => {
                              const expectedTotal =
                                selectedCaseIds.length *
                                (selectedTemplateIds.length +
                                  selectedMasterDocIds.length);
                              const done =
                                (job?.successCount ?? 0) +
                                (job?.failedCount ?? 0);
                              const total =
                                job?.totalCount || expectedTotal || 0;
                              return `Progress: ${done}/${total}  (success=${job?.successCount ?? 0}, failed=${job?.failedCount ?? 0}, pending=${job?.pendingCount ?? 0})`;
                            })()}
                          </div>
                          {jobError && (
                            <div className="mt-2 text-xs text-red-700">
                              {jobError}
                            </div>
                          )}
                        </div>
                      )}
                      <Button
                        disabled={busy || (hasActiveJob && displayStatus === "GENERATING") || blocksWordTemplates}
                        className="w-full"
                        onClick={() => runGenerate("print")}
                      >
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
