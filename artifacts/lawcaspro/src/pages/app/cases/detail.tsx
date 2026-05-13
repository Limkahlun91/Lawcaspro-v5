import { Link, useParams, useLocation, useSearch } from "wouter";
import { 
  useGetCase, getGetCaseQueryKey, 
  useGetCaseWorkflow, getGetCaseWorkflowQueryKey, 
  useUpdateWorkflowStep, 
  useGetCaseNotes, getGetCaseNotesQueryKey,
  useCreateCaseNote,
  useListUsers
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle2, Clock, User, Building2, MapPin, Tag, Receipt, Printer, Upload, Download, Trash2, Plus, X, MoreHorizontal, Share2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CaseDocumentsTab from "./components/CaseDocumentsTab";
import CaseBillingTab from "./components/CaseBillingTab";
import CaseCommunicationsTab from "./components/CaseCommunicationsTab";
import CaseTasksTab from "./components/CaseTasksTab";
import CaseTimeTab from "./components/CaseTimeTab";
import CaseComplianceTab from "./components/CaseComplianceTab";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchBlob, apiFetchJson, apiRequest } from "@/lib/api-client";
import { DateOnlyInput, formatYmdToDmy, normalizeDateOnlyFromApi } from "@/components/date-only-input";
import { downloadBlob } from "@/lib/download";
import { printWordBlob } from "@/lib/documents/BrowserPrinter";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { DEFAULT_ALLOWED_MIME_TYPES, validateUploadFile } from "@/lib/upload-validation";
import { WORKFLOW_ATTACHMENT_ACCEPT, WORKFLOW_ATTACHMENT_ITEMS, isAllowedWorkflowAttachmentFileName, type WorkflowAttachmentDocKey, type WorkflowAttachmentDateKey } from "./components/workflow-attachments";

import { getListCasesQueryKey } from "@workspace/api-client-react";

type WorkflowDocument = {
  id: number;
  caseId: number;
  milestoneKey: WorkflowAttachmentDocKey;
  label: string;
  dateValue: string | null;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type LoanStampingItemKey = "facility_agreement" | "deed_of_assignment" | "power_of_attorney" | "charge_annexure" | "other";

type LoanStampingItem = {
  id?: number;
  itemKey: LoanStampingItemKey;
  customName: string | null;
  datedOn: string | null;
  stampedOn: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  sortOrder: number;
};

type LoanStampingSaveItem = Pick<
  LoanStampingItem,
  "id" | "itemKey" | "customName" | "datedOn" | "stampedOn" | "sortOrder"
>;

function safeFileNamePart(name: string): string {
  const base = name.trim().replace(/\s+/g, "_");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
}

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const caseId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const canAssignAny = hasPermission(user, "cases", "assign_any");
  const myUserId = typeof (user as any)?.id === "number" ? (user as any).id : Number((user as any)?.id);
  const roleName = String((user as any)?.roleName ?? "");
  const isPartnerOrManager = roleName.toLowerCase().includes("partner") || roleName.toLowerCase().includes("manager");

  const {
    data: caseInfo,
    isLoading: isLoadingCase,
    isError: isCaseError,
    error: caseError,
    refetch: refetchCase,
    isFetching: isFetchingCase,
  } = useGetCase(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseQueryKey(caseId) }
  });

  const { data: usersRes } = useListUsers({ limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
  const users = usersRes?.data || [];
  const lawyerOptions = users.filter((u) => ["Partner", "Senior Lawyer", "Lawyer"].includes(String(u.roleName ?? "").trim()));
  const clerkOptions = users.filter((u) => ["Senior Clerk", "Clerk"].includes(String(u.roleName ?? "").trim()));
  const currentLawyerId = (Array.isArray((caseInfo as any)?.assignments) ? (caseInfo as any).assignments : [])
    .find((a: any) => a?.roleInCase === "lawyer")?.userId as number | undefined;
  const currentClerkId = (Array.isArray((caseInfo as any)?.assignments) ? (caseInfo as any).assignments : [])
    .find((a: any) => a?.roleInCase === "clerk")?.userId as number | undefined;
  const canAccessClientInteraction = !!caseId && (canAssignAny || isPartnerOrManager || (Number.isFinite(myUserId) && (myUserId === currentLawyerId || myUserId === currentClerkId)));

  const {
    data: workflow,
    isLoading: isLoadingWorkflow,
    isError: isWorkflowError,
    error: workflowError,
    refetch: refetchWorkflow,
    isFetching: isFetchingWorkflow,
  } = useGetCaseWorkflow(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseWorkflowQueryKey(caseId) }
  });

  const { data: notes, isLoading: isLoadingNotes } = useGetCaseNotes(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseNotesQueryKey(caseId) }
  });

  const updateStepMutation = useUpdateWorkflowStep();
  const createNoteMutation = useCreateCaseNote();
  const updateCaseMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      return apiFetchJson(`/cases/${caseId}`, { method: "PATCH", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
    },
    onError: (err) => {
      toastError(toast, err, { fallback: "Failed to update case" });
    },
  });
  const saveKeyDatesMutation = useMutation({
    mutationFn: (vars: { scope: string; payload: Record<string, unknown>; keys: string[] }) =>
      apiFetchJson(`/cases/${caseId}/key-dates`, { method: "PATCH", body: JSON.stringify(vars.payload) }),
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
      queryClient.invalidateQueries({ queryKey: ["case-key-dates", caseId] });
      queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
      setKeyDatesBaseline((prev) => {
        const next = { ...prev };
        for (const k of vars.keys) next[k] = keyDatesDraft[k] ?? "";
        return next;
      });
      setSavingScope("");
      toast({ title: `${vars.scope} saved` });
    },
    onError: (err) => toastError(toast, err, "Save failed"),
  });

  const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
  const todayYmdLocal = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  const autoKeyDatesMutation = useMutation({
    mutationFn: (vars: { payload: Record<string, unknown>; statusLabel: string }) =>
      apiFetchJson(`/cases/${caseId}/key-dates`, { method: "PATCH", body: JSON.stringify(vars.payload) }),
    onSuccess: async (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
      queryClient.invalidateQueries({ queryKey: ["case-key-dates", caseId] });
      queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
      toast({ title: "Loan Status automatically updated", description: `Loan Status automatically updated to ${vars.statusLabel}` });
    },
    onError: (err) => toastError(toast, err, "Auto status update failed"),
  });
  const printMutation = useMutation({
    mutationFn: async (payload: { printKey: string }) => {
      const res = await apiRequest(`/cases/${caseId}/documents/print`, {
        method: "POST",
        timeoutMs: 60000,
        body: JSON.stringify({ ...payload, outputFormat: "docx" }),
      });
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i.exec(cd);
      const fileNameRaw = m?.[1] ?? m?.[2] ?? "download.pdf";
      const fileName = decodeURIComponent(String(fileNameRaw).trim());
      const docId = Number(res.headers.get("x-case-document-id") ?? NaN);
      return { blob, fileName, docId };
    },
    onSuccess: async ({ blob, fileName, docId }, vars) => {
      queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
      if (Number.isFinite(docId)) {
        queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
      }
      await printWordBlob(blob, { title: fileName });
      toast({ title: "Print preview opened" });

      if (vars?.printKey === "acting_letter") {
        autoKeyDatesMutation.mutate({ payload: { acting_letter_issued_date: todayYmdLocal() }, statusLabel: "Acting Letter Issued" });
      } else if (vars?.printKey === "letter_advice_spa_sol_lu") {
        autoKeyDatesMutation.mutate({ payload: { advice_to_bank_date: todayYmdLocal() }, statusLabel: "Advised" });
      }
    },
    onError: (err) => toastError(toast, err, "Print failed"),
  });

  const [noteContent, setNoteContent] = useState("");
  const [activeStepId, setActiveStepId] = useState<number | null>(null);
  const [stepNote, setStepNote] = useState("");
  const [shareTrackingOpen, setShareTrackingOpen] = useState(false);
  const [clientReplyDraft, setClientReplyDraft] = useState("");
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab") ?? "overview";
  const threadIdFromUrl = params.get("threadId");
  const initialThreadIdRaw = threadIdFromUrl ? parseInt(threadIdFromUrl, 10) : NaN;
  const returnToRaw = params.get("returnTo");
  const returnTo =
    returnToRaw && (returnToRaw.startsWith("/app/cases") || returnToRaw.startsWith("/app/dashboard"))
      ? returnToRaw
      : "/app/cases";
  const initialThreadId = Number.isNaN(initialThreadIdRaw) ? null : initialThreadIdRaw;
  const [activeTab, setActiveTab] = useState(tabFromUrl);

  const keyDatesQuery = useQuery<Record<string, unknown>>({
    queryKey: ["case-key-dates", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/key-dates`, { signal }),
    enabled: !!caseId,
    retry: false,
  });
  const keyDates = (keyDatesQuery.data && typeof keyDatesQuery.data === "object") ? keyDatesQuery.data : {};

  const trackingToken = String((caseInfo as any)?.trackingToken ?? "").trim();
  const trackingLink = (() => {
    if (!trackingToken) return "";
    const base = import.meta.env.BASE_URL ? String(import.meta.env.BASE_URL).replace(/\/$/, "") : "";
    return `${window.location.origin}${base}/track/${encodeURIComponent(trackingToken)}`;
  })();

  const workflowDocsQuery = useQuery<WorkflowDocument[]>({
    queryKey: ["case-workflow-documents", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/workflow-documents`, { signal }),
    enabled: !!caseId,
    retry: false,
  });

  const loanStampingQuery = useQuery<LoanStampingItem[]>({
    queryKey: ["case-loan-stamping", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/loan-stamping`, { signal }),
    enabled: !!caseId,
    retry: false,
  });

  const progressQuery = useQuery<any>({
    queryKey: ["case-progress", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/progress`, { signal }),
    enabled: !!caseId,
    retry: false,
  });

  type CaseMessage = {
    id: string;
    senderType: "client" | "staff" | "developer";
    senderId: number | null;
    senderName: string;
    messageText: string;
    attachments: unknown;
    createdAt: string;
  };

  const caseMessagesQuery = useQuery<{ data: CaseMessage[] }>({
    queryKey: ["case-messages", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/messages`, { signal }),
    enabled: !!caseId && canAccessClientInteraction,
    retry: false,
  });

  const sendCaseMessageMutation = useMutation({
    mutationFn: async (messageText: string) => {
      return await apiFetchJson(`/cases/${caseId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messageText }),
      });
    },
    onSuccess: async () => {
      setClientReplyDraft("");
      await queryClient.invalidateQueries({ queryKey: ["case-messages", caseId] });
    },
    onError: (err) => toastError(toast, err, { fallback: "Failed to send message" }),
  });

  const printableQuery = useQuery<any[]>({
    queryKey: ["printable-config"],
    queryFn: ({ signal }) => apiFetchJson("/printable-config", { signal }),
    retry: false,
  });
  const printableConfig = Array.isArray(printableQuery.data) ? printableQuery.data : [];
  const printState = (printKey: string) => (printableConfig || []).find((x) => x?.printKey === printKey) as any;
  const printStatusLabel = (st: any): string => {
    const s = st?.status;
    if (s === "configured") return "Ready";
    if (s === "template_not_template_kind") return "Template misclassified";
    if (s === "template_not_capable") return "Not template-capable";
    return "Template not configured";
  };
  const printTitle = (printKey: string, dateVal: string) => {
    if (!dateVal) return "Enter date to enable printing";
    if (printableQuery.isError) return "Template config unavailable";
    const st = printState(printKey);
    if (st?.status === "configured") return "Print";
    return st?.hint || "Template not configured";
  };
  const canPrint = (printKey: string, dateVal: string) => !printableQuery.isError && Boolean(dateVal) && printState(printKey)?.status === "configured";
  const templateIssuesCount = (printableConfig || []).filter((x) => x?.status && x.status !== "configured").length;
  const [milestoneTab, setMilestoneTab] = useState<"spa" | "loan" | "bank" | "mot">("spa");
  const [savingScope, setSavingScope] = useState<string>("");
  const [keyDatesDraft, setKeyDatesDraft] = useState<Record<string, string>>({});
  const [keyDatesBaseline, setKeyDatesBaseline] = useState<Record<string, string>>({});
  const [keyDatesInitialized, setKeyDatesInitialized] = useState(false);

  const workflowFileInputRef = useRef<HTMLInputElement>(null);
  const workflowUploadKeyRef = useRef<{ docKey: WorkflowAttachmentDocKey; dateKey: WorkflowAttachmentDateKey } | null>(null);
  const [workflowUploadingKey, setWorkflowUploadingKey] = useState<WorkflowAttachmentDocKey | null>(null);
  const [workflowDownloadingId, setWorkflowDownloadingId] = useState<number | null>(null);

  const stampingFileInputRef = useRef<HTMLInputElement>(null);
  const stampingUploadIdRef = useRef<number | null>(null);
  const [stampingUploadingId, setStampingUploadingId] = useState<number | null>(null);
  const [stampingDownloadingId, setStampingDownloadingId] = useState<number | null>(null);
  const [stampingDraft, setStampingDraft] = useState<LoanStampingItem[]>([]);
  const [stampingDirty, setStampingDirty] = useState(false);

  const parseKeyDates = (src: Record<string, unknown>) => ({
    spa_signed_date: normalizeDateOnlyFromApi((src as any).spa_signed_date),
    spa_forward_to_developer_execution_on: normalizeDateOnlyFromApi((src as any).spa_forward_to_developer_execution_on),
    spa_date: normalizeDateOnlyFromApi((src as any).spa_date),
    spa_stamped_date: normalizeDateOnlyFromApi((src as any).spa_stamped_date),
    stamped_spa_send_to_developer_on: normalizeDateOnlyFromApi((src as any).stamped_spa_send_to_developer_on),
    stamped_spa_received_from_developer_on: normalizeDateOnlyFromApi((src as any).stamped_spa_received_from_developer_on),
    letter_of_offer_date: normalizeDateOnlyFromApi((src as any).letter_of_offer_date),
    letter_of_offer_stamped_date: normalizeDateOnlyFromApi((src as any).letter_of_offer_stamped_date),
    loan_docs_pending_date: normalizeDateOnlyFromApi((src as any).loan_docs_pending_date),
    loan_docs_signed_date: normalizeDateOnlyFromApi((src as any).loan_docs_signed_date),
    acting_letter_issued_date: normalizeDateOnlyFromApi((src as any).acting_letter_issued_date),
    developer_confirmation_received_on: normalizeDateOnlyFromApi((src as any).developer_confirmation_received_on),
    developer_confirmation_date: normalizeDateOnlyFromApi((src as any).developer_confirmation_date),
    loan_sent_bank_execution_date: normalizeDateOnlyFromApi((src as any).loan_sent_bank_execution_date),
    loan_bank_executed_date: normalizeDateOnlyFromApi((src as any).loan_bank_executed_date),
    bank_lu_received_date: normalizeDateOnlyFromApi((src as any).bank_lu_received_date),
    bank_lu_forward_to_developer_on: normalizeDateOnlyFromApi((src as any).bank_lu_forward_to_developer_on),
    developer_lu_received_on: normalizeDateOnlyFromApi((src as any).developer_lu_received_on),
    developer_lu_dated: normalizeDateOnlyFromApi((src as any).developer_lu_dated),
    letter_disclaimer_received_on: normalizeDateOnlyFromApi((src as any).letter_disclaimer_received_on),
    letter_disclaimer_dated: normalizeDateOnlyFromApi((src as any).letter_disclaimer_dated),
    letter_disclaimer_reference_nos: typeof (src as any).letter_disclaimer_reference_nos === "string" ? String((src as any).letter_disclaimer_reference_nos) : "",
    redemption_sum: (src as any).redemption_sum !== null && (src as any).redemption_sum !== undefined ? String((src as any).redemption_sum) : "",
    loan_agreement_dated: normalizeDateOnlyFromApi((src as any).loan_agreement_dated),
    loan_agreement_submitted_stamping_date: normalizeDateOnlyFromApi((src as any).loan_agreement_submitted_stamping_date),
    loan_agreement_stamped_date: normalizeDateOnlyFromApi((src as any).loan_agreement_stamped_date),
    register_poa_on: normalizeDateOnlyFromApi((src as any).register_poa_on),
    registered_poa_registration_number: typeof (src as any).registered_poa_registration_number === "string" ? String((src as any).registered_poa_registration_number) : "",
    noa_served_on: normalizeDateOnlyFromApi((src as any).noa_served_on),
    advice_to_bank_date: normalizeDateOnlyFromApi((src as any).advice_to_bank_date),
    bank_1st_release_on: normalizeDateOnlyFromApi((src as any).bank_1st_release_on),
    first_release_amount_rm: (src as any).first_release_amount_rm !== null && (src as any).first_release_amount_rm !== undefined ? String((src as any).first_release_amount_rm) : "",
    discharge_date: normalizeDateOnlyFromApi((src as any).discharge_date),
    consent_to_transfer_date: normalizeDateOnlyFromApi((src as any).consent_to_transfer_date),
    consent_to_charge_date: normalizeDateOnlyFromApi((src as any).consent_to_charge_date),
    mot_received_date: normalizeDateOnlyFromApi((src as any).mot_received_date),
    mot_signed_date: normalizeDateOnlyFromApi((src as any).mot_signed_date),
    mot_stamped_date: normalizeDateOnlyFromApi((src as any).mot_stamped_date),
    mot_registered_date: normalizeDateOnlyFromApi((src as any).mot_registered_date),
    progressive_payment_date: normalizeDateOnlyFromApi((src as any).progressive_payment_date),
    full_settlement_date: normalizeDateOnlyFromApi((src as any).full_settlement_date),
    completion_date: normalizeDateOnlyFromApi((src as any).completion_date),
  });

  const scopeKeys = {
    spa: [
      "spa_date",
      "spa_signed_date",
      "spa_stamped_date",
      "spa_forward_to_developer_execution_on",
      "stamped_spa_send_to_developer_on",
      "stamped_spa_received_from_developer_on",
    ],
    loan: [
      "loan_docs_signed_date",
      "letter_of_offer_date",
      "acting_letter_issued_date",
      "loan_sent_bank_execution_date",
      "loan_bank_executed_date",
      "letter_of_offer_stamped_date",
      "loan_docs_pending_date",
      "developer_confirmation_received_on",
      "developer_confirmation_date",
    ],
    bank: [
      "noa_served_on",
      "bank_lu_forward_to_developer_on",
      "advice_to_bank_date",
      "bank_lu_received_date",
      "developer_lu_received_on",
      "developer_lu_dated",
      "register_poa_on",
      "registered_poa_registration_number",
      "bank_1st_release_on",
      "first_release_amount_rm",
      "redemption_sum",
      "discharge_date",
      "letter_disclaimer_received_on",
      "letter_disclaimer_dated",
      "letter_disclaimer_reference_nos",
    ],
    mot: [
      "completion_date",
      "full_settlement_date",
      "progressive_payment_date",
      "mot_received_date",
      "mot_signed_date",
      "mot_stamped_date",
      "mot_registered_date",
      "consent_to_transfer_date",
      "consent_to_charge_date",
    ],
  } as const;

  const isDirtyTab = (tab: keyof typeof scopeKeys) => {
    for (const k of scopeKeys[tab]) {
      if ((keyDatesDraft[k] ?? "") !== (keyDatesBaseline[k] ?? "")) return true;
    }
    return false;
  };
  const dirtySpa = isDirtyTab("spa");
  const dirtyLoan = isDirtyTab("loan");
  const dirtyBank = isDirtyTab("bank");
  const dirtyMot = isDirtyTab("mot");
  const anyDirty = dirtySpa || dirtyLoan || dirtyBank || dirtyMot;

  useEffect(() => {
    setKeyDatesInitialized(false);
    setKeyDatesDraft({});
    setKeyDatesBaseline({});
    setSavingScope("");
    setMilestoneTab("spa");
  }, [caseId]);

  useEffect(() => {
    const parsed = parseKeyDates(keyDates);
    if (!keyDatesInitialized) {
      setKeyDatesDraft(parsed);
      setKeyDatesBaseline(parsed);
      setKeyDatesInitialized(true);
      return;
    }
    if (!anyDirty) {
      setKeyDatesDraft(parsed);
      setKeyDatesBaseline(parsed);
    }
  }, [keyDates, keyDatesInitialized, anyDirty]);

  useEffect(() => {
    if (stampingDirty) return;
    const rows = Array.isArray(loanStampingQuery.data) ? loanStampingQuery.data : [];
    setStampingDraft(rows.map((x, idx) => ({
      id: x.id,
      itemKey: x.itemKey,
      customName: x.customName ?? null,
      datedOn: x.datedOn ?? null,
      stampedOn: x.stampedOn ?? null,
      fileName: x.fileName ?? null,
      mimeType: x.mimeType ?? null,
      fileSize: x.fileSize ?? null,
      sortOrder: Number.isFinite(x.sortOrder) ? x.sortOrder : idx,
    })));
  }, [loanStampingQuery.data, stampingDirty]);

  useEffect(() => {
    setActiveTab(tabFromUrl);
  }, [tabFromUrl]);

  const workflowDocsByKey = useMemo(() => {
    const rows = Array.isArray(workflowDocsQuery.data) ? workflowDocsQuery.data : [];
    const map = new Map<WorkflowAttachmentDocKey, WorkflowDocument>();
    for (const r of rows) {
      if (r && (r.milestoneKey as any)) map.set(r.milestoneKey as WorkflowAttachmentDocKey, r);
    }
    return map;
  }, [workflowDocsQuery.data]);

  const toastDownloadError = (err: unknown) => {
    const status = (err as any)?.status;
    if (status === 404) toastError(toast, err, "File not found");
    else if (status === 403) toastError(toast, err, "Permission denied");
    else if (status === 503) toastError(toast, err, "Storage unavailable");
    else toastError(toast, err, "Download failed");
  };

  const uploadWorkflowDocMutation = useMutation({
    mutationFn: (vars: { milestoneKey: WorkflowAttachmentDocKey; objectPath: string; file: File; dateYmd: string }) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/workflow-documents`, {
        method: "POST",
        body: JSON.stringify({
          milestoneKey: vars.milestoneKey,
          objectPath: vars.objectPath,
          fileName: vars.file.name,
          mimeType: vars.file.type || null,
          fileSize: vars.file.size,
          dateYmd: vars.dateYmd || null,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-workflow-documents", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      await queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
    },
    onError: (err) => toastError(toast, err, "Upload failed"),
  });

  const deleteWorkflowDocMutation = useMutation({
    mutationFn: (id: number) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/workflow-documents/${id}`, { method: "DELETE", allowStatuses: [204] });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-workflow-documents", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      await queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
      toast({ title: "Deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const saveStampingMutation = useMutation({
    mutationFn: (items: LoanStampingSaveItem[]) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping`, { method: "PUT", body: JSON.stringify({ items }) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
      toast({ title: "Stamping saved" });
    },
    onError: (err) => toastError(toast, err, "Save failed"),
  });

  const deleteStampingRowMutation = useMutation({
    mutationFn: (id: number) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/${id}`, { method: "DELETE", allowStatuses: [204] });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
      toast({ title: "Deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const bindStampingFileMutation = useMutation({
    mutationFn: (vars: { id: number; objectPath: string; file: File }) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/${vars.id}/file`, {
        method: "POST",
        body: JSON.stringify({
          objectPath: vars.objectPath,
          fileName: vars.file.name,
          mimeType: vars.file.type || null,
          fileSize: vars.file.size,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
    },
    onError: (err) => toastError(toast, err, "Upload failed"),
  });

  const clearStampingFileMutation = useMutation({
    mutationFn: (id: number) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/${id}/file`, { method: "DELETE", allowStatuses: [204] });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
      toast({ title: "Deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const ensureStampingItemMutation = useMutation({
    mutationFn: (payload: { itemKey: LoanStampingItemKey; customName?: string | null; sortOrder?: number; datedOn?: string | null; stampedOn?: string | null }) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/ensure`, { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
    },
    onError: (err) => toastError(toast, err, "Failed to prepare upload"),
  });

  const normalizeTitleType = (raw: string): "master" | "strata" | "individual" | "unknown" => {
    const s = (raw || "").trim().toLowerCase();
    if (!s) return "unknown";
    if (s === "master" || s === "master title" || s === "master_title") return "master";
    if (s === "strata" || s === "strata title" || s === "strata_title") return "strata";
    if (s === "individual" || s === "individual title" || s === "individual_title") return "individual";
    return "unknown";
  };
  const titleType = normalizeTitleType(String(caseInfo?.titleType ?? ""));
  const isMasterTitle = titleType === "master";
  const isStrataOrIndividual = titleType === "strata" || titleType === "individual";
  const caseMeta: Record<string, unknown> = caseInfo && typeof caseInfo === "object" ? (caseInfo as unknown as Record<string, unknown>) : {};
  const projectMeta: Record<string, unknown> =
    caseMeta.project && typeof caseMeta.project === "object"
      ? (caseMeta.project as Record<string, unknown>)
      : {};
  const isEncumbered =
    caseMeta.isEncumbered === true ||
    caseMeta.is_encumbered === true ||
    projectMeta.isEncumbered === true ||
    projectMeta.is_encumbered === true;
  const tenureRaw =
    typeof caseMeta.tenure === "string"
      ? caseMeta.tenure.trim().toLowerCase()
      : typeof projectMeta.tenure === "string"
        ? projectMeta.tenure.trim().toLowerCase()
        : "";
  const tenure = tenureRaw === "leasehold" ? "leasehold" : "freehold";
  const showNoaAndPoa = isMasterTitle;
  const showEncumbranceFields = isEncumbered;
  const showLeaseholdConsents = tenure === "leasehold" && isStrataOrIndividual;

  const visibleWorkflowAttachmentItems = useMemo(() => {
    return WORKFLOW_ATTACHMENT_ITEMS.filter((it) => {
      if (it.docKey === "register_poa") return showNoaAndPoa;
      if (it.docKey === "letter_disclaimer") return showEncumbranceFields;
      return true;
    });
  }, [showNoaAndPoa, showEncumbranceFields]);

  const fixedStampingKeys: Array<{ key: LoanStampingItemKey; label: string; visible: boolean }> = [
    { key: "facility_agreement", label: "Facility Agreement", visible: true },
    { key: "deed_of_assignment", label: "Deed of Assignment", visible: isMasterTitle },
    { key: "power_of_attorney", label: "Power of Attorney", visible: isMasterTitle },
    { key: "charge_annexure", label: "Charge Annexure", visible: isStrataOrIndividual },
  ];

  const visibleStampingItems = useMemo(() => {
    const existing = stampingDraft.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const fixed: LoanStampingItem[] = [];
    let order = 0;
    for (const k of fixedStampingKeys) {
      if (!k.visible) continue;
      const row = existing.find((x) => x.itemKey === k.key && x.customName == null);
      fixed.push({
        id: row?.id,
        itemKey: k.key,
        customName: null,
        datedOn: row?.datedOn ?? null,
        stampedOn: row?.stampedOn ?? null,
        fileName: row?.fileName ?? null,
        mimeType: row?.mimeType ?? null,
        fileSize: row?.fileSize ?? null,
        sortOrder: row?.sortOrder ?? order,
      });
      order += 10;
    }
    const others = existing.filter((x) => x.itemKey === "other").map((x, idx) => ({
      ...x,
      sortOrder: Number.isFinite(x.sortOrder) ? x.sortOrder : 1000 + idx,
    }));
    return { fixed, others };
  }, [stampingDraft, fixedStampingKeys.map((x) => x.visible).join("|")]);

  if (!caseId) return <div className="py-10 text-sm text-slate-500">Case not found</div>;
  if (isLoadingCase || isLoadingWorkflow) return <div className="py-10 text-sm text-slate-500">Loading case details...</div>;
  if (isCaseError) return <div className="py-10"><QueryFallback title="Case unavailable" error={caseError} onRetry={() => refetchCase()} isRetrying={isFetchingCase} /></div>;
  if (isWorkflowError) return <div className="py-10"><QueryFallback title="Workflow unavailable" error={workflowError} onRetry={() => refetchWorkflow()} isRetrying={isFetchingWorkflow} /></div>;
  if (!caseInfo) return <div className="py-10 text-sm text-slate-500">Case not found</div>;

  const handleCompleteStep = (stepId: number) => {
    updateStepMutation.mutate(
      { caseId, stepId, data: { status: "completed", notes: stepNote } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
          queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
          toast({ title: "Step marked as completed" });
          setActiveStepId(null);
          setStepNote("");
        },
        onError: (err) => toastError(toast, err, "Update failed"),
      }
    );
  };

  const handleAddNote = () => {
    if (!noteContent.trim()) return;
    createNoteMutation.mutate(
      { caseId, data: { content: noteContent } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCaseNotesQueryKey(caseId) });
          setNoteContent("");
          toast({ title: "Note added" });
        },
        onError: (err) => toastError(toast, err, "Save failed"),
      }
    );
  };

  const safeWorkflow = Array.isArray(workflow) ? workflow : [];
  const commonSteps = safeWorkflow.filter(s => s?.pathType === "common");
  const loanSteps = safeWorkflow.filter(s => s?.pathType === "loan");
  const motSteps = safeWorkflow.filter(s => s?.pathType === "mot");
  const noaPoaSteps = safeWorkflow.filter(s => s?.pathType === "noa_pa");

  const stageStatus = (steps: any[]) => {
    const completed = (steps || []).filter((s) => s?.status === "completed");
    const last = completed.length ? completed[completed.length - 1] : null;
    return last?.stepName ? String(last.stepName) : "Pending";
  };

  const spaStatus = stageStatus(commonSteps);
  const loanStatus = loanSteps.length ? stageStatus(loanSteps) : "N/A";
  const workflowDone = safeWorkflow.filter((s) => s?.status === "completed").length;
  const workflowTotal = safeWorkflow.length;

  const safeAssignments = Array.isArray((caseInfo as any)?.assignments) ? ((caseInfo as any).assignments as any[]) : [];
  const safePurchasers = Array.isArray((caseInfo as any)?.purchasers) ? ((caseInfo as any).purchasers as any[]) : [];

  const saveScope = (scope: "SPA" | "Loan" | "Bank / LU / NOA" | "MOT / Completion") => {
    const tab: keyof typeof scopeKeys =
      scope === "SPA" ? "spa" :
      scope === "Loan" ? "loan" :
      scope === "Bank / LU / NOA" ? "bank" :
      "mot";
    const dirty =
      tab === "spa" ? dirtySpa :
      tab === "loan" ? dirtyLoan :
      tab === "bank" ? dirtyBank :
      dirtyMot;
    if (!dirty) return;

    const keys = scopeKeys[tab] as readonly string[];
    const payload: Record<string, unknown> = {};
    for (const k of keys) {
      const v = keyDatesDraft[k] || "";
      payload[k] = v ? v : null;
    }

    setSavingScope(scope);
    saveKeyDatesMutation.mutate({ scope, payload, keys: keys as string[] });
  };

  async function uploadToPrivateCasePath(objectPath: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    return await apiFetchJson<{ objectPath: string }>(`/storage/upload?objectPath=${encodeURIComponent(objectPath)}`, { method: "POST", body: fd });
  }

  function workflowObjectPath(milestoneKey: WorkflowAttachmentDocKey, file: File): string {
    const firmId = user?.firmId;
    return `/objects/cases/${firmId}/case-${caseId}/workflow/${milestoneKey}/${crypto.randomUUID()}-${safeFileNamePart(file.name)}`;
  }

  function openWorkflowUpload(docKey: WorkflowAttachmentDocKey, dateKey: WorkflowAttachmentDateKey) {
    workflowUploadKeyRef.current = { docKey, dateKey };
    workflowFileInputRef.current?.click();
  }

  async function handleWorkflowFileSelected(file: File | null) {
    const ref = workflowUploadKeyRef.current;
    if (!file || !ref) return;
    if (!hasPermission(user, "documents", "create") && !hasPermission(user, "documents", "update")) {
      toast({ title: "Permission denied", description: "You do not have permission to upload documents.", variant: "destructive" });
      return;
    }
    const v = validateUploadFile(file, { allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES });
    if (!v.ok) {
      toast({ title: "Invalid file", description: v.message, variant: "destructive" });
      return;
    }
    const dateYmd = keyDatesDraft[ref.dateKey] || "";
    if (!dateYmd) {
      toast({ title: "Select date first", description: "Please enter the date before uploading the file." });
      return;
    }
    if (!user?.firmId) {
      toast({ title: "No firm context", description: "Please sign in again." });
      return;
    }
    setWorkflowUploadingKey(ref.docKey);
    try {
      const existed = Boolean(workflowDocsByKey.get(ref.docKey));
      const objectPath = workflowObjectPath(ref.docKey, file);
      const uploaded = await uploadToPrivateCasePath(objectPath, file);
      await uploadWorkflowDocMutation.mutateAsync({
        milestoneKey: ref.docKey,
        objectPath: uploaded.objectPath,
        file,
        dateYmd,
      });
      toast({ title: existed ? "Replace success" : "Upload success" });
    } finally {
      setWorkflowUploadingKey(null);
      workflowUploadKeyRef.current = null;
      if (workflowFileInputRef.current) workflowFileInputRef.current.value = "";
    }
  }

  async function downloadWorkflowDoc(doc: WorkflowDocument) {
    if (workflowDownloadingId === doc.id) return;
    setWorkflowDownloadingId(doc.id);
    try {
      const blob = await apiFetchBlob(`/cases/${caseId}/workflow-documents/${doc.id}/download`);
      downloadBlob(blob, doc.fileName);
    } catch (err) {
      toastDownloadError(err);
    } finally {
      setWorkflowDownloadingId(null);
    }
  }

  function stampingObjectPath(file: File): string {
    const firmId = user?.firmId;
    return `/objects/cases/${firmId}/case-${caseId}/loan-stamping/${crypto.randomUUID()}-${safeFileNamePart(file.name)}`;
  }

  async function ensureStampingRowForUpload(row: LoanStampingItem): Promise<number | null> {
    if (!canDocsUpdate) return null;
    const ensured = await ensureStampingItemMutation.mutateAsync({
      itemKey: row.itemKey,
      customName: row.itemKey === "other" ? (row.customName ?? "") : null,
      sortOrder: row.sortOrder,
      datedOn: row.datedOn ?? null,
      stampedOn: row.stampedOn ?? null,
    });
    const ensuredId = Number((ensured as any)?.id);
    if (!Number.isFinite(ensuredId)) return null;
    setStampingDraft((prev) => {
      const next = [...prev];
      const idx = next.findIndex((x) =>
        x.id
          ? x.id === row.id
          : (row.itemKey !== "other" ? x.itemKey === row.itemKey : x.itemKey === "other" && x.sortOrder === row.sortOrder)
      );
      const merged = {
        ...row,
        id: ensuredId,
        customName: (ensured as any)?.customName ?? row.customName ?? null,
        datedOn: (ensured as any)?.datedOn ?? row.datedOn ?? null,
        stampedOn: (ensured as any)?.stampedOn ?? row.stampedOn ?? null,
      } as LoanStampingItem;
      if (idx >= 0) next[idx] = { ...next[idx], ...merged };
      else next.push(merged);
      return next;
    });
    return ensuredId;
  }

  async function openStampingUpload(row: LoanStampingItem) {
    const ensuredId = row.id ? row.id : await ensureStampingRowForUpload(row);
    if (!ensuredId) return;
    stampingUploadIdRef.current = ensuredId;
    stampingFileInputRef.current?.click();
  }

  async function addStampingOtherRow() {
    if (!canDocsUpdate) return;
    const nextOrder = 1000 + visibleStampingItems.others.length;
    const ensured = await ensureStampingItemMutation.mutateAsync({
      itemKey: "other",
      customName: "",
      sortOrder: nextOrder,
      datedOn: null,
      stampedOn: null,
    });
    const ensuredId = Number((ensured as any)?.id);
    if (!Number.isFinite(ensuredId)) return;
    setStampingDraft((prev) => [
      ...prev,
      { id: ensuredId, itemKey: "other", customName: "", datedOn: null, stampedOn: null, fileName: null, mimeType: null, fileSize: null, sortOrder: nextOrder },
    ]);
  }

  async function handleStampingFileSelected(file: File | null) {
    const id = stampingUploadIdRef.current;
    if (!file || !id) return;
    if (!hasPermission(user, "documents", "create") && !hasPermission(user, "documents", "update")) {
      toast({ title: "Permission denied", description: "You do not have permission to upload documents.", variant: "destructive" });
      return;
    }
    const v = validateUploadFile(file, { allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES });
    if (!v.ok) {
      toast({ title: "Invalid file", description: v.message, variant: "destructive" });
      return;
    }
    if (!user?.firmId) {
      toast({ title: "No firm context", description: "Please sign in again." });
      return;
    }
    setStampingUploadingId(id);
    try {
      const existed = Boolean(stampingDraft.find((x) => x.id === id)?.fileName);
      const objectPath = stampingObjectPath(file);
      const uploaded = await uploadToPrivateCasePath(objectPath, file);
      await bindStampingFileMutation.mutateAsync({ id, objectPath: uploaded.objectPath, file });
      toast({ title: existed ? "Replace success" : "Upload success" });
    } finally {
      setStampingUploadingId(null);
      stampingUploadIdRef.current = null;
      if (stampingFileInputRef.current) stampingFileInputRef.current.value = "";
    }
  }

  async function downloadStampingFile(item: LoanStampingItem) {
    if (!item.id) return;
    if (stampingDownloadingId === item.id) return;
    setStampingDownloadingId(item.id);
    try {
      const blob = await apiFetchBlob(`/cases/${caseId}/loan-stamping/${item.id}/download`);
      downloadBlob(blob, item.fileName || "download");
    } catch (err) {
      toastDownloadError(err);
    } finally {
      setStampingDownloadingId(null);
    }
  }

  const FieldCard = (props: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    type?: "date" | "text" | "number";
    printerKey?: string;
  }) => {
    const type = props.type ?? "date";
    const isDate = type === "date";
    const dateVal = props.value || "";
    const showPrinter = Boolean(props.printerKey);
    const printerKey = props.printerKey || "";
    const st = showPrinter ? printState(printerKey) : null;
    const showStatus = showPrinter && st?.status !== "configured";
    const statusLabel = showStatus ? printStatusLabel(st) : "";

    return (
      <div className="group rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-slate-600">{props.label}</Label>
          {showStatus && (
            <Badge
              variant={st?.status === "configured" ? "secondary" : "outline"}
              className="text-[10px] whitespace-nowrap"
              title={st?.hint}
            >
              {statusLabel}
            </Badge>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          {isDate ? (
            <DateOnlyInput className="flex-1" valueYmd={props.value} onChangeYmd={props.onChange} />
          ) : (
            <Input
              className="flex-1"
              type={type}
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
            />
          )}
          {showPrinter && (
            <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <Button
                size="icon"
                variant={canPrint(printerKey, dateVal) ? "default" : "outline"}
                className={canPrint(printerKey, dateVal) ? "bg-slate-900 hover:bg-slate-800" : undefined}
                title={printTitle(printerKey, dateVal)}
                onClick={() => printMutation.mutate({ printKey: printerKey })}
                disabled={printMutation.isPending || !canPrint(printerKey, dateVal)}
              >
                <Printer className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const canDocsRead = hasPermission(user, "documents", "read");
  const canDocsUpdate = hasPermission(user, "documents", "update");
  const canDocsWrite = hasPermission(user, "documents", "create") || canDocsUpdate;
  const canDocsDelete = hasPermission(user, "documents", "delete");

  const WorkflowFileCard = (props: { label: string; docKey: WorkflowAttachmentDocKey; dateKey: WorkflowAttachmentDateKey; printerKey?: string }) => {
    const value = keyDatesDraft[props.dateKey] ?? "";
    const doc = workflowDocsByKey.get(props.docKey);
    const uploading = workflowUploadingKey === props.docKey || uploadWorkflowDocMutation.isPending;
    const canUpload = canDocsWrite && Boolean(value) && !uploading && !deleteWorkflowDocMutation.isPending;
    const derivedStatus = Array.isArray(progressQuery.data?.attachments)
      ? progressQuery.data.attachments.find((x: any) => x?.docKey === props.docKey)?.status
      : null;
    const showPrinter = Boolean(props.printerKey);
    const printerKey = props.printerKey || "";
    const st = showPrinter ? printState(printerKey) : null;
    const showStatus = showPrinter && st?.status !== "configured";
    const statusLabel = showStatus ? printStatusLabel(st) : "";

    return (
      <div className="group rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-slate-600">{props.label}</Label>
          <div className="flex items-center gap-1">
            {derivedStatus && (
              <Badge
                variant={derivedStatus === "completed" ? "default" : "outline"}
                className="text-[10px] whitespace-nowrap"
              >
                {String(derivedStatus).replace(/_/g, " ")}
              </Badge>
            )}
            {showStatus && (
              <Badge
                variant={st?.status === "configured" ? "secondary" : "outline"}
                className="text-[10px] whitespace-nowrap"
                title={st?.hint}
              >
                {statusLabel}
              </Badge>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <DateOnlyInput
            className="flex-1"
            valueYmd={value}
            onChangeYmd={(v) => setKeyDatesDraft((d) => ({ ...d, [props.dateKey]: v }))}
          />
          {showPrinter && (
            <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <Button
                size="icon"
                variant={canPrint(printerKey, value) ? "default" : "outline"}
                className={canPrint(printerKey, value) ? "bg-slate-900 hover:bg-slate-800" : undefined}
                title={printTitle(printerKey, value)}
                onClick={() => printMutation.mutate({ printKey: printerKey })}
                disabled={printMutation.isPending || !canPrint(printerKey, value)}
              >
                <Printer className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 min-w-0">
          <div className="text-xs text-slate-600 truncate min-w-0" title={doc?.fileName ?? "No file uploaded"}>
            {doc ? doc.fileName : "No file uploaded"}
          </div>
          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {doc ? (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  title="Download"
                  onClick={() => downloadWorkflowDoc(doc)}
                  disabled={!canDocsRead || workflowDownloadingId === doc.id}
                >
                  <Download className="w-4 h-4" />
                </Button>
                {canDocsWrite && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    title="Replace"
                    onClick={() => openWorkflowUpload(props.docKey, props.dateKey)}
                    disabled={!canUpload}
                  >
                    <Upload className="w-4 h-4" />
                  </Button>
                )}
                {canDocsDelete && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-red-600"
                    title="Delete"
                    onClick={() => deleteWorkflowDocMutation.mutate(doc.id)}
                    disabled={deleteWorkflowDocMutation.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </>
            ) : (
              canDocsWrite ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => openWorkflowUpload(props.docKey, props.dateKey)}
                  disabled={!canUpload}
                  title={value ? "Upload file" : "Enter date to enable upload"}
                >
                  <Upload className="w-4 h-4" />
                  Upload
                </Button>
              ) : null
            )}
          </div>
        </div>
      </div>
    );
  };

  const upsertStampingItem = (next: LoanStampingItem) => {
    setStampingDirty(true);
    setStampingDraft((prev) => {
      const idx = next.id
        ? prev.findIndex((x) => x.id === next.id)
        : prev.findIndex((x) => x.id == null && x.itemKey === next.itemKey && (x.customName ?? null) === (next.customName ?? null));
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = { ...copy[idx], ...next };
        return copy;
      }
      return prev.concat(next);
    });
  };

  const removeUnsavedStampingOther = (sortOrder: number) => {
    setStampingDirty(true);
    setStampingDraft((prev) => prev.filter((x) => !(x.id == null && x.itemKey === "other" && x.sortOrder === sortOrder)));
  };

  const saveStamping = () => {
    const items: LoanStampingSaveItem[] = [...visibleStampingItems.fixed, ...visibleStampingItems.others].map((x, idx) => ({
      id: x.id,
      itemKey: x.itemKey,
      customName: x.customName,
      datedOn: x.datedOn,
      stampedOn: x.stampedOn,
      sortOrder: Number.isFinite(x.sortOrder) ? x.sortOrder : idx * 10,
    }));
    saveStampingMutation.mutate(items);
  };

  return (
    <div className="space-y-6 pb-12">
      <input
        ref={workflowFileInputRef}
        type="file"
        accept={WORKFLOW_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => handleWorkflowFileSelected(e.target.files?.[0] ?? null)}
      />
      <input
        ref={stampingFileInputRef}
        type="file"
        accept={WORKFLOW_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => handleStampingFileSelected(e.target.files?.[0] ?? null)}
      />
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 min-w-0">
        <div className="flex items-start gap-4 min-w-0">
          <Button variant="outline" size="icon" onClick={() => setLocation(returnTo)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0">
            <Breadcrumb className="mb-1">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={returnTo}>Cases</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={`/app/projects/${String((caseInfo as any)?.projectId ?? "")}`}>
                      {String((caseInfo as any)?.projectName ?? "Project")}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{String((caseInfo as any).referenceNo ?? "")}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-slate-900 tracking-tight break-words">{String((caseInfo as any).referenceNo ?? "")}</h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider bg-slate-100 text-slate-700 border border-slate-200">
                {String((caseInfo as any).status ?? "").replace(/_/g, " ")}
              </span>
            </div>
            <p className="text-slate-500 mt-1 break-words">
              {[String((caseInfo as any).projectName ?? ""), String((caseInfo as any).developerName ?? "")].filter((x) => x.trim()).join(" • ")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShareTrackingOpen(true)}
            disabled={!trackingToken}
          >
            <Share2 className="w-4 h-4 mr-2" />
            Share Tracking Link
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const purchaserNames = safePurchasers
                .map((p) => (p as any)?.clientName)
                .filter(Boolean)
                .join(", ");
              const params = new URLSearchParams();
              params.set("caseId", String((caseInfo as any).id ?? ""));
              params.set("ref", String((caseInfo as any).referenceNo ?? ""));
              if (purchaserNames) params.set("client", purchaserNames);
              if ((caseInfo as any).spaPrice) params.set("price", String((caseInfo as any).spaPrice));
              const propDesc = [String((caseInfo as any).projectName ?? ""), String((caseInfo as any).developerName ?? "")].filter((x) => x.trim()).join(" • ");
              if (propDesc) params.set("property", propDesc);
              setLocation(`/app/quotations/new?${params.toString()}`);
            }}
          >
            <Receipt className="w-4 h-4 mr-2" />
            Generate Quotation
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setLocation("/app/documents?tab=firm")}>
                Configure Templates
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Dialog open={shareTrackingOpen} onOpenChange={setShareTrackingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share Tracking Link</DialogTitle>
            <DialogDescription>Send this link to your client (no login required).</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-sm font-medium">Tracking URL</div>
            <Input value={trackingLink || "Tracking link unavailable"} readOnly />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!trackingLink) return;
                try {
                  await navigator.clipboard.writeText(trackingLink);
                  toast({ title: "Link copied" });
                } catch (err) {
                  toastError(toast, err, "Copy failed");
                }
              }}
              disabled={!trackingLink}
            >
              Copy Link
            </Button>
            <Button
              onClick={() => {
                if (!trackingLink) return;
                const msg = `Hi, you can track your property transaction progress here: ${trackingLink}`;
                const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
                window.open(url, "_blank", "noopener,noreferrer");
              }}
              disabled={!trackingLink}
            >
              Share via WhatsApp
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!progressQuery.isError && Array.isArray(progressQuery.data?.sections) && progressQuery.data.sections.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Progress Summary</CardTitle>
          </CardHeader>
          <CardContent className="min-w-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 min-w-0">
              {progressQuery.data.sections.map((s: any) => (
                <button
                  key={s.key}
                  type="button"
                  className="min-w-0 rounded-lg border border-slate-200 bg-white p-3 text-left hover:bg-slate-50"
                  onClick={() => {
                    setActiveTab("overview");
                    if (s?.target?.milestoneTab) setMilestoneTab(s.target.milestoneTab);
                  }}
                >
                  <div className="text-sm font-medium text-slate-800 break-words">{s.label}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 min-w-0">
                    <div className="text-xl font-bold text-slate-900">{s.completed}/{s.total}</div>
                    <Badge variant={s.total > 0 && s.completed === s.total ? "default" : "secondary"}>
                      {s.total > 0 && s.completed === s.total ? "Completed" : "In Progress"}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="flex w-full flex-wrap gap-1 mb-6 bg-slate-100 p-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="workflow">Workflow</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="communications">Comms</TabsTrigger>
          {canAccessClientInteraction && <TabsTrigger value="client-interaction">Client Interaction</TabsTrigger>}
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="time">Time</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Case Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm font-medium text-slate-500">Purchase Mode</div>
                    <div className="text-slate-900 capitalize font-medium">{caseInfo.purchaseMode}</div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-500">Title Type</div>
                    <div className="text-slate-900 capitalize font-medium">{caseInfo.titleType}</div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-500">SPA Price</div>
                    <div className="text-slate-900 font-medium">
                      {caseInfo.spaPrice ? `RM ${caseInfo.spaPrice.toLocaleString()}` : 'Not set'}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-500">Assigned Lawyer</div>
                    <div className="text-slate-900 font-medium">
                      {canAssignAny ? (
                        <Select
                          value={currentLawyerId ? String(currentLawyerId) : ""}
                          onValueChange={(v) => {
                            const id = Number(v);
                            if (!Number.isInteger(id) || id <= 0) return;
                            updateCaseMutation.mutate({ assignedLawyerId: id });
                          }}
                        >
                          <SelectTrigger className="h-9 text-sm border-slate-200 bg-white">
                            <SelectValue placeholder="Select lawyer" />
                          </SelectTrigger>
                          <SelectContent>
                            {lawyerOptions.map((u) => (
                              <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        (safeAssignments.find((a) => (a as any)?.roleInCase === "lawyer") as any)?.userName ?? "Unassigned"
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-500">Assigned Clerk</div>
                    <div className="text-slate-900 font-medium">
                      {canAssignAny ? (
                        <Select
                          value={currentClerkId ? String(currentClerkId) : "__none__"}
                          onValueChange={(v) => {
                            if (v === "__none__") {
                              updateCaseMutation.mutate({ assignedClerkId: null });
                              return;
                            }
                            const id = Number(v);
                            if (!Number.isInteger(id) || id <= 0) return;
                            updateCaseMutation.mutate({ assignedClerkId: id });
                          }}
                        >
                          <SelectTrigger className="h-9 text-sm border-slate-200 bg-white">
                            <SelectValue placeholder="Select clerk" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {clerkOptions.map((u) => (
                              <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        (safeAssignments.find((a) => (a as any)?.roleInCase === "clerk") as any)?.userName ?? "Unassigned"
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Purchasers</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {safePurchasers.map((p: any, idx: number) => (
                    <div key={p?.id ?? `p-${idx}`} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <User className="w-5 h-5 text-slate-400 mt-0.5" />
                      <div>
                        <div className="font-medium text-slate-900">{String(p?.clientName ?? "")}</div>
                        <div className="text-xs text-slate-500">{String(p?.icNo ?? "")}</div>
                        <span className="inline-block mt-1 px-2 py-0.5 text-[10px] uppercase font-semibold bg-white border border-slate-200 rounded text-slate-600">
                          {String(p?.role ?? "")} Purchaser
                        </span>
                      </div>
                    </div>
                  ))}
                  {safePurchasers.length === 0 ? (
                    <div className="text-sm text-slate-500">No purchasers.</div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div className="space-y-1">
                <CardTitle>Key Dates & Milestones</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <Badge variant="outline" className="border-slate-200 text-slate-700">SPA: {spaStatus}</Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">Loan: {loanStatus}</Badge>
                  <Badge variant="outline" className={templateIssuesCount ? "border-red-200 text-red-700" : "border-emerald-200 text-emerald-700"}>
                    Print templates: {templateIssuesCount ? `${templateIssuesCount} issue(s)` : "All ready"}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    Workflow: {workflowDone}/{workflowTotal}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    SPA Date: {keyDatesDraft.spa_date ? formatYmdToDmy(keyDatesDraft.spa_date) : "—"}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    Loan Docs: {keyDatesDraft.loan_docs_signed_date ? formatYmdToDmy(keyDatesDraft.loan_docs_signed_date) : "—"}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    Completion: {keyDatesDraft.completion_date ? formatYmdToDmy(keyDatesDraft.completion_date) : "—"}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {keyDatesQuery.isError ? (
                <QueryFallback title="Key dates unavailable" error={keyDatesQuery.error} onRetry={() => keyDatesQuery.refetch()} isRetrying={keyDatesQuery.isFetching} />
              ) : (
              <Tabs value={milestoneTab} onValueChange={(v) => setMilestoneTab(v as "spa" | "loan" | "bank" | "mot")} className="w-full">
                <TabsList className="grid w-full grid-cols-2 md:grid-cols-4 bg-slate-100 p-1">
                  <TabsTrigger value="spa">
                    <span className="flex items-center gap-1">SPA{dirtySpa && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                  </TabsTrigger>
                  <TabsTrigger value="loan">
                    <span className="flex items-center gap-1">Loan{dirtyLoan && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                  </TabsTrigger>
                  <TabsTrigger value="bank">
                    <span className="flex items-center gap-1">Bank / LU / NOA{dirtyBank && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                  </TabsTrigger>
                  <TabsTrigger value="mot">
                    <span className="flex items-center gap-1">MOT / Completion{dirtyMot && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="spa" className="pt-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-800">SPA Dates</div>
                    <Button
                      size="sm"
                      variant={dirtySpa ? "default" : "outline"}
                      className={dirtySpa ? "bg-amber-500 hover:bg-amber-600" : undefined}
                      onClick={() => saveScope("SPA")}
                      disabled={saveKeyDatesMutation.isPending || !dirtySpa}
                    >
                      {saveKeyDatesMutation.isPending && savingScope === "SPA" ? "Saving..." : dirtySpa ? "Save SPA" : "Saved"}
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    <FieldCard label="SPA Date" value={keyDatesDraft.spa_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_date: v }))} />
                    <FieldCard label="SPA Signed" value={keyDatesDraft.spa_signed_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_signed_date: v }))} />
                    <WorkflowFileCard label="SPA STAMPED" docKey="spa_stamped" dateKey="spa_stamped_date" />
                    <FieldCard label="SPA Forward to Dev. Execution On" value={keyDatesDraft.spa_forward_to_developer_execution_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_forward_to_developer_execution_on: v }))} />
                    <FieldCard label="Stamped SPA Send to Dev. On" value={keyDatesDraft.stamped_spa_send_to_developer_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, stamped_spa_send_to_developer_on: v }))} />
                    <FieldCard label="Stamped SPA Received from Dev. On" value={keyDatesDraft.stamped_spa_received_from_developer_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, stamped_spa_received_from_developer_on: v }))} />
                  </div>
                </TabsContent>

                <TabsContent value="loan" className="pt-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-800">Loan Dates</div>
                    <Button
                      size="sm"
                      variant={dirtyLoan ? "default" : "outline"}
                      className={dirtyLoan ? "bg-amber-500 hover:bg-amber-600" : undefined}
                      onClick={() => saveScope("Loan")}
                      disabled={saveKeyDatesMutation.isPending || !dirtyLoan}
                    >
                      {saveKeyDatesMutation.isPending && savingScope === "Loan" ? "Saving..." : dirtyLoan ? "Save Loan" : "Saved"}
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div className="text-sm font-semibold text-slate-800">Offer & Signing</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <FieldCard label="Loan Docs Signed" value={keyDatesDraft.loan_docs_signed_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, loan_docs_signed_date: v }))} />
                        <FieldCard label="Letter of Offer Date" value={keyDatesDraft.letter_of_offer_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_of_offer_date: v }))} />
                        <FieldCard label="Loan Docs Pending Signing" value={keyDatesDraft.loan_docs_pending_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, loan_docs_pending_date: v }))} />
                        <WorkflowFileCard label="LO STAMPED" docKey="lo_stamped" dateKey="letter_of_offer_stamped_date" />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="text-sm font-semibold text-slate-800">Letters & Execution</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <FieldCard label="Acting Letter Issued" value={keyDatesDraft.acting_letter_issued_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, acting_letter_issued_date: v }))} printerKey="acting_letter" />
                        <FieldCard label="Loan Sent for Bank Execution" value={keyDatesDraft.loan_sent_bank_execution_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, loan_sent_bank_execution_date: v }))} printerKey="letter_forward_bank_execution" />
                        <FieldCard label="Loan Bank Executed" value={keyDatesDraft.loan_bank_executed_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, loan_bank_executed_date: v }))} />
                        <FieldCard label="Developer Confirmation Received On" value={keyDatesDraft.developer_confirmation_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_confirmation_received_on: v }))} />
                        <FieldCard label="Developer Confirmation Date" value={keyDatesDraft.developer_confirmation_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_confirmation_date: v }))} />
                      </div>
                    </div>
                  </div>

                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="text-sm">Stamping</CardTitle>
                        {progressQuery.data?.stamping && (
                          <div className="mt-1 text-xs text-slate-600 break-words">
                            {progressQuery.data.stamping.completed}/{progressQuery.data.stamping.total} completed
                            {Array.isArray(progressQuery.data.stamping.missing) && progressQuery.data.stamping.missing.length > 0 && (
                              <span className="ml-2">
                                Missing: {progressQuery.data.stamping.missing
                                  .slice(0, 4)
                                  .map((m: any) => `${m.itemKey}(${String(m.status).replace(/_/g, " ")})`)
                                  .join(", ")}
                                {progressQuery.data.stamping.missing.length > 4 ? "…" : ""}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={addStampingOtherRow}
                          disabled={!canDocsUpdate}
                        >
                          <Plus className="w-4 h-4" />
                          Add Another Document
                        </Button>
                        <Button
                          size="sm"
                          variant={stampingDirty ? "default" : "outline"}
                          className={stampingDirty ? "bg-amber-500 hover:bg-amber-600" : undefined}
                          onClick={saveStamping}
                          disabled={!canDocsUpdate || saveStampingMutation.isPending || !stampingDirty}
                        >
                          {saveStampingMutation.isPending ? "Saving..." : stampingDirty ? "Save Stamping" : "Saved"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {loanStampingQuery.isError ? (
                        <QueryFallback title="Stamping unavailable" error={loanStampingQuery.error} onRetry={() => loanStampingQuery.refetch()} isRetrying={loanStampingQuery.isFetching} />
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[980px] text-sm">
                            <thead className="bg-slate-50 border-b">
                              <tr>
                                <th className="text-left px-3 py-2 font-medium text-slate-600 w-[320px]">Document</th>
                                <th className="text-left px-3 py-2 font-medium text-slate-600 w-[180px]">Dated</th>
                                <th className="text-left px-3 py-2 font-medium text-slate-600 w-[180px]">Stamped On</th>
                                <th className="text-left px-3 py-2 font-medium text-slate-600">File</th>
                                <th className="text-right px-3 py-2 font-medium text-slate-600 w-[140px]">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {visibleStampingItems.fixed.map((row) => (
                                <tr key={`fixed-${row.itemKey}`}>
                                  <td className="px-3 py-2 font-medium text-slate-800">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="truncate">{fixedStampingKeys.find((x) => x.key === row.itemKey)?.label}</span>
                                      {Array.isArray(progressQuery.data?.stampingItems) && (
                                        (() => {
                                          const st = progressQuery.data.stampingItems.find((x: any) => x?.itemKey === row.itemKey && (row.id ? x?.id === row.id : true));
                                          return st?.status ? (
                                            <Badge variant={st.status === "completed" ? "default" : "outline"} className="text-[10px] whitespace-nowrap">
                                              {String(st.status).replace(/_/g, " ")}
                                            </Badge>
                                          ) : null;
                                        })()
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.datedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, datedOn: v || null })} />
                                  </td>
                                  <td className="px-3 py-2">
                                    <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.stampedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, stampedOn: v || null })} />
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="truncate text-slate-600" title={row.fileName || "No file uploaded"}>{row.fileName || "No file uploaded"}</div>
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <div className="inline-flex items-center gap-1">
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8"
                                        title="Download"
                                        disabled={!canDocsRead || !row.id || !row.fileName || stampingDownloadingId === row.id}
                                        onClick={() => downloadStampingFile(row)}
                                      >
                                        <Download className="w-4 h-4" />
                                      </Button>
                                      {canDocsUpdate && (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8"
                                          title="Upload/Replace"
                                          disabled={ensureStampingItemMutation.isPending || stampingUploadingId === row.id}
                                          onClick={() => openStampingUpload(row)}
                                        >
                                          <Upload className="w-4 h-4" />
                                        </Button>
                                      )}
                                      {canDocsUpdate && (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8 text-red-600"
                                          title="Remove file"
                                          disabled={!row.id || !row.fileName || clearStampingFileMutation.isPending}
                                          onClick={() => row.id && clearStampingFileMutation.mutate(row.id)}
                                        >
                                          <X className="w-4 h-4" />
                                        </Button>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                              {visibleStampingItems.others.map((row) => (
                                <tr key={`other-${row.id ?? row.sortOrder}`}>
                                  <td className="px-3 py-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <Input
                                        className="min-w-0"
                                        value={row.customName ?? ""}
                                        placeholder="Other document name"
                                        onChange={(e) => upsertStampingItem({ ...row, customName: e.target.value })}
                                        disabled={!canDocsUpdate}
                                      />
                                      {Array.isArray(progressQuery.data?.stampingItems) && (
                                        (() => {
                                          const st = progressQuery.data.stampingItems.find((x: any) => x?.itemKey === "other" && (row.id ? x?.id === row.id : x?.sortOrder === row.sortOrder));
                                          return st?.status ? (
                                            <Badge variant={st.status === "completed" ? "default" : "outline"} className="text-[10px] whitespace-nowrap">
                                              {String(st.status).replace(/_/g, " ")}
                                            </Badge>
                                          ) : null;
                                        })()
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.datedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, datedOn: v || null })} />
                                  </td>
                                  <td className="px-3 py-2">
                                    <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.stampedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, stampedOn: v || null })} />
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="truncate text-slate-600" title={row.fileName || "No file uploaded"}>{row.fileName || "No file uploaded"}</div>
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <div className="inline-flex items-center gap-1">
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8"
                                        title="Download"
                                        disabled={!canDocsRead || !row.id || !row.fileName || stampingDownloadingId === row.id}
                                        onClick={() => downloadStampingFile(row)}
                                      >
                                        <Download className="w-4 h-4" />
                                      </Button>
                                      {canDocsUpdate && (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8"
                                          title="Upload/Replace"
                                          disabled={ensureStampingItemMutation.isPending || stampingUploadingId === row.id}
                                          onClick={() => openStampingUpload(row)}
                                        >
                                          <Upload className="w-4 h-4" />
                                        </Button>
                                      )}
                                      {(row.fileName ? canDocsUpdate : row.id ? canDocsDelete : canDocsUpdate) ? (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8 text-red-600"
                                          title={row.fileName ? "Remove file" : "Remove row"}
                                          disabled={clearStampingFileMutation.isPending || deleteStampingRowMutation.isPending}
                                          onClick={() => {
                                            if (row.fileName && row.id) {
                                              clearStampingFileMutation.mutate(row.id);
                                              return;
                                            }
                                            if (row.id) {
                                              deleteStampingRowMutation.mutate(row.id);
                                              return;
                                            }
                                            removeUnsavedStampingOther(row.sortOrder);
                                          }}
                                        >
                                          <X className="w-4 h-4" />
                                        </Button>
                                      ) : null}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="bank" className="pt-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-800">Bank / LU / NOA</div>
                    <Button
                      size="sm"
                      variant={dirtyBank ? "default" : "outline"}
                      className={dirtyBank ? "bg-amber-500 hover:bg-amber-600" : undefined}
                      onClick={() => saveScope("Bank / LU / NOA")}
                      disabled={saveKeyDatesMutation.isPending || !dirtyBank}
                    >
                      {saveKeyDatesMutation.isPending && savingScope === "Bank / LU / NOA" ? "Saving..." : dirtyBank ? "Save Bank" : "Saved"}
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div className="text-sm font-semibold text-slate-800">Bank / LU</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <FieldCard label="Bank LU Forward to Dev. On" value={keyDatesDraft.bank_lu_forward_to_developer_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bank_lu_forward_to_developer_on: v }))} printerKey="letter_forward_bank_lu_to_dev" />
                        <FieldCard label="Advice to Bank Date" value={keyDatesDraft.advice_to_bank_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, advice_to_bank_date: v }))} printerKey="letter_advice_spa_sol_lu" />
                        <FieldCard label="Bank LU Received" value={keyDatesDraft.bank_lu_received_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bank_lu_received_date: v }))} />
                        <FieldCard label="Developer LU Received On" value={keyDatesDraft.developer_lu_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_lu_received_on: v }))} />
                        <FieldCard label="Developer LU Dated" value={keyDatesDraft.developer_lu_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_lu_dated: v }))} />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="text-sm font-semibold text-slate-800">NOA / POA / Disclaimer</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {showNoaAndPoa ? (
                          <FieldCard label="NOA Served On" value={keyDatesDraft.noa_served_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, noa_served_on: v }))} printerKey="noa" />
                        ) : null}
                        {showNoaAndPoa ? (
                          <WorkflowFileCard label="Register POA" docKey="register_poa" dateKey="register_poa_on" />
                        ) : null}
                        {showNoaAndPoa ? (
                          <FieldCard label="Registered POA Registration Number" type="text" value={keyDatesDraft.registered_poa_registration_number || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, registered_poa_registration_number: v }))} />
                        ) : null}
                        {showEncumbranceFields ? (
                          <FieldCard label="Letter Disclaimer Received On" value={keyDatesDraft.letter_disclaimer_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_received_on: v }))} />
                        ) : null}
                        {showEncumbranceFields ? (
                          <WorkflowFileCard label="Letter Disclaimer" docKey="letter_disclaimer" dateKey="letter_disclaimer_dated" />
                        ) : null}
                        {showEncumbranceFields ? (
                          <FieldCard label="Letter Disclaimer Reference Nos" type="text" value={keyDatesDraft.letter_disclaimer_reference_nos || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_reference_nos: v }))} />
                        ) : null}
                      </div>

                      <div className="pt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {showEncumbranceFields ? (
                          <FieldCard label="Redemption Sum (RM)" type="number" value={keyDatesDraft.redemption_sum || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, redemption_sum: v }))} />
                        ) : null}
                        {showEncumbranceFields ? (
                          <FieldCard label="Discharge Date" value={keyDatesDraft.discharge_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, discharge_date: v }))} />
                        ) : null}
                        <FieldCard label="Bank 1st Release On" value={keyDatesDraft.bank_1st_release_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bank_1st_release_on: v }))} />
                        <FieldCard label="First Release Amount (RM)" type="number" value={keyDatesDraft.first_release_amount_rm || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, first_release_amount_rm: v }))} />
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="mot" className="pt-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-800">MOT / Completion</div>
                    <Button
                      size="sm"
                      variant={dirtyMot ? "default" : "outline"}
                      className={dirtyMot ? "bg-amber-500 hover:bg-amber-600" : undefined}
                      onClick={() => saveScope("MOT / Completion")}
                      disabled={saveKeyDatesMutation.isPending || !dirtyMot}
                    >
                      {saveKeyDatesMutation.isPending && savingScope === "MOT / Completion" ? "Saving..." : dirtyMot ? "Save MOT" : "Saved"}
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    <FieldCard label="Completion Date" value={keyDatesDraft.completion_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, completion_date: v }))} />
                    <FieldCard label="Full Settlement Date" value={keyDatesDraft.full_settlement_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, full_settlement_date: v }))} />
                    <FieldCard label="Progressive Payment Date" value={keyDatesDraft.progressive_payment_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, progressive_payment_date: v }))} />
                    <FieldCard label="MOT Received" value={keyDatesDraft.mot_received_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, mot_received_date: v }))} />
                    <FieldCard label="MOT Signed" value={keyDatesDraft.mot_signed_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, mot_signed_date: v }))} />
                    <FieldCard label="MOT Stamped" value={keyDatesDraft.mot_stamped_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, mot_stamped_date: v }))} />
                    <FieldCard label="MOT Registered" value={keyDatesDraft.mot_registered_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, mot_registered_date: v }))} />
                    {showLeaseholdConsents ? (
                      <FieldCard label="Consent to Transfer" value={keyDatesDraft.consent_to_transfer_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, consent_to_transfer_date: v }))} />
                    ) : null}
                    {showLeaseholdConsents ? (
                      <FieldCard label="Consent to Charge" value={keyDatesDraft.consent_to_charge_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, consent_to_charge_date: v }))} />
                    ) : null}
                  </div>
                </TabsContent>
              </Tabs>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="workflow" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Workflow Attachments</CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 min-w-0">
                {visibleWorkflowAttachmentItems.map((it) => (
                  <WorkflowFileCard key={it.docKey} label={it.label} docKey={it.docKey} dateKey={it.dateKey} />
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Conveyancing Workflow</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-8">
                {/* Common Steps */}
                <div>
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs">1</span>
                    Initial SPA Stage
                  </h3>
                  <div className="space-y-3 pl-3 border-l-2 border-slate-200 ml-3">
                    {commonSteps.map(step => (
                      <div key={step.id} className="relative pl-6">
                        <div className={`absolute -left-[23px] top-1 w-5 h-5 rounded-full border-2 bg-white flex items-center justify-center ${
                          step.status === 'completed' ? 'border-amber-500' : 'border-slate-300'
                        }`}>
                          {step.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-amber-500" />}
                        </div>
                        
                        <div className={`p-4 rounded-lg border ${
                          step.status === 'completed' ? 'bg-amber-50/30 border-amber-100' : 'bg-white border-slate-200 shadow-sm'
                        }`}>
                          <div className="flex justify-between items-start mb-2">
                            <h4 className="font-semibold text-slate-900">{step.stepName}</h4>
                            <span className="text-xs text-slate-500">
                              {step.status === "completed"
                                ? `Done by ${step.completedByName}`
                                : (Array.isArray(progressQuery.data?.workflowSteps)
                                  ? (progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus
                                    ? String(progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus).replace(/_/g, " ")
                                    : "Pending")
                                  : "Pending")}
                            </span>
                          </div>
                          
                          {step.status === 'completed' && step.notes && (
                            <p className="text-sm text-slate-600 mt-2 italic border-l-2 border-amber-200 pl-2">"{step.notes}"</p>
                          )}

                          {step.status !== 'completed' && activeStepId === step.id && (
                            <div className="mt-4 space-y-3">
                              <Textarea 
                                placeholder="Add optional notes for this step..." 
                                value={stepNote}
                                onChange={e => setStepNote(e.target.value)}
                                className="text-sm"
                              />
                              <div className="flex gap-2">
                                <Button size="sm" onClick={() => handleCompleteStep(step.id)} disabled={updateStepMutation.isPending}>
                                  Confirm Completion
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setActiveStepId(null)}>Cancel</Button>
                              </div>
                            </div>
                          )}

                          {step.status !== "completed"
                            && activeStepId !== step.id
                            && !(Array.isArray(progressQuery.data?.workflowSteps) && progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus)
                            && (
                              <Button size="sm" variant="secondary" className="mt-2 text-xs" onClick={() => setActiveStepId(step.id)}>
                                Mark Complete
                              </Button>
                            )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Loan Steps */}
                {loanSteps.length > 0 && (
                  <div>
                    <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs">2</span>
                      Loan Stage
                    </h3>
                    <div className="space-y-3 pl-3 border-l-2 border-slate-200 ml-3">
                      {loanSteps.map(step => (
                        <div key={step.id} className="relative pl-6">
                           <div className={`absolute -left-[23px] top-1 w-5 h-5 rounded-full border-2 bg-white flex items-center justify-center ${
                            step.status === 'completed' ? 'border-amber-500' : 'border-slate-300'
                          }`}>
                            {step.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-amber-500" />}
                          </div>
                          
                          <div className={`p-4 rounded-lg border ${
                            step.status === 'completed' ? 'bg-amber-50/30 border-amber-100' : 'bg-white border-slate-200 shadow-sm'
                          }`}>
                            <div className="flex justify-between items-start mb-2">
                              <h4 className="font-semibold text-slate-900">{step.stepName}</h4>
                              <span className="text-xs text-slate-500">
                                {step.status === "completed"
                                  ? "Completed"
                                  : (Array.isArray(progressQuery.data?.workflowSteps)
                                    ? (progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus
                                      ? String(progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus).replace(/_/g, " ")
                                      : "Pending")
                                    : "Pending")}
                              </span>
                            </div>
                            
                            {step.status !== 'completed' && activeStepId === step.id && (
                              <div className="mt-4 space-y-3">
                                <Textarea 
                                  placeholder="Add optional notes for this step..." 
                                  value={stepNote}
                                  onChange={e => setStepNote(e.target.value)}
                                  className="text-sm"
                                />
                                <div className="flex gap-2">
                                  <Button size="sm" onClick={() => handleCompleteStep(step.id)} disabled={updateStepMutation.isPending}>
                                    Confirm Completion
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={() => setActiveStepId(null)}>Cancel</Button>
                                </div>
                              </div>
                            )}

                            {step.status !== "completed"
                              && activeStepId !== step.id
                              && !(Array.isArray(progressQuery.data?.workflowSteps) && progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus)
                              && (
                                <Button size="sm" variant="secondary" className="mt-2 text-xs" onClick={() => setActiveStepId(step.id)}>
                                  Mark Complete
                                </Button>
                              )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents">
          <CaseDocumentsTab caseId={caseId} />
        </TabsContent>

        <TabsContent value="billing">
          <CaseBillingTab caseId={caseId} />
        </TabsContent>

        <TabsContent value="communications">
          <CaseCommunicationsTab caseId={caseId} initialThreadId={initialThreadId} />
        </TabsContent>

        {canAccessClientInteraction && (
          <TabsContent value="client-interaction" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Client Interaction</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {caseMessagesQuery.isLoading && (
                  <div className="text-sm text-slate-500">Loading messages...</div>
                )}
                {caseMessagesQuery.isError && (
                  <div className="text-sm text-red-600">Failed to load messages.</div>
                )}
                {!caseMessagesQuery.isLoading && !caseMessagesQuery.isError && (
                  <div className="space-y-2">
                    {(Array.isArray(caseMessagesQuery.data?.data) ? caseMessagesQuery.data!.data : []).map((m) => {
                      const isExternal = m.senderType !== "staff";
                      return (
                        <div key={m.id} className={`flex ${isExternal ? "justify-start" : "justify-end"}`}>
                          <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${isExternal ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-white"}`}>
                            <div className={`text-[11px] ${isExternal ? "text-slate-500" : "text-slate-200"}`}>
                              {isExternal ? (m.senderType === "developer" ? "Developer" : "Client") : (m.senderName || "Staff")}
                            </div>
                            <div className="text-sm whitespace-pre-wrap break-words">{m.messageText}</div>
                            <div className={`mt-1 text-[10px] ${isExternal ? "text-slate-400" : "text-slate-300"}`}>
                              {m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {(Array.isArray(caseMessagesQuery.data?.data) ? caseMessagesQuery.data!.data : []).length === 0 && (
                      <div className="text-sm text-slate-600">No client messages yet.</div>
                    )}
                  </div>
                )}

                <div className="pt-2 border-t border-slate-200 space-y-2">
                  <Textarea
                    value={clientReplyDraft}
                    onChange={(e) => setClientReplyDraft(e.target.value)}
                    placeholder="Reply to client..."
                    className="min-h-[90px]"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-500">{Math.min(2000, clientReplyDraft.length)}/2000</div>
                    <Button
                      onClick={() => {
                        const t = clientReplyDraft.trim();
                        if (!t) return;
                        if (t.length > 2000) return;
                        sendCaseMessageMutation.mutate(t);
                      }}
                      disabled={sendCaseMessageMutation.isPending || !clientReplyDraft.trim()}
                    >
                      Send
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="tasks">
          <CaseTasksTab caseId={caseId} />
        </TabsContent>

        <TabsContent value="time">
          <CaseTimeTab caseId={caseId} />
        </TabsContent>

        <TabsContent value="notes" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Case Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 mb-6">
                <Textarea 
                  placeholder="Type a new note here..." 
                  value={noteContent}
                  onChange={e => setNoteContent(e.target.value)}
                  className="min-h-[100px]"
                />
                <Button 
                  onClick={handleAddNote} 
                  disabled={!noteContent.trim() || createNoteMutation.isPending}
                  className="bg-amber-500 hover:bg-amber-600"
                >
                  Add Note
                </Button>
              </div>

              <div className="space-y-4 border-t border-slate-100 pt-6">
                {isLoadingNotes ? (
                  <div className="text-slate-500">Loading notes...</div>
                ) : notes?.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">No notes added yet.</div>
                ) : (
                  notes?.map(note => (
                    <div key={note.id} className="bg-slate-50 p-4 rounded-lg border border-slate-100">
                      <div className="flex justify-between items-center mb-2">
                        <div className="font-semibold text-sm text-slate-900">{note.authorName}</div>
                        <div className="text-xs text-slate-500 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(note.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <p className="text-sm text-slate-700 whitespace-pre-wrap">{note.content}</p>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="compliance">
          <CaseComplianceTab caseId={caseId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
