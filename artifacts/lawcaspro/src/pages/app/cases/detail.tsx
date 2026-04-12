import { useParams, useLocation, useSearch } from "wouter";
import { 
  useGetCase, getGetCaseQueryKey, 
  useGetCaseWorkflow, getGetCaseWorkflowQueryKey, 
  useUpdateWorkflowStep, 
  useGetCaseNotes, getGetCaseNotesQueryKey,
  useCreateCaseNote
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle2, Clock, User, Building2, MapPin, Tag, Receipt, Printer } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import CaseDocumentsTab from "./components/CaseDocumentsTab";
import CaseBillingTab from "./components/CaseBillingTab";
import CaseCommunicationsTab from "./components/CaseCommunicationsTab";
import CaseTasksTab from "./components/CaseTasksTab";
import CaseTimeTab from "./components/CaseTimeTab";
import CaseComplianceTab from "./components/CaseComplianceTab";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchJson } from "@/lib/api-client";

function dateInputValue(v: unknown): string {
  if (!v) return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

function formatYmdToDmy(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const caseId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();

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
  const saveKeyDatesMutation = useMutation({
    mutationFn: (vars: { scope: string; payload: Record<string, unknown>; keys: string[] }) =>
      apiFetchJson(`/cases/${caseId}/key-dates`, { method: "PATCH", body: JSON.stringify(vars.payload) }),
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
      queryClient.invalidateQueries({ queryKey: ["case-key-dates", caseId] });
      queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
      setKeyDatesBaseline((prev) => {
        const next = { ...prev };
        for (const k of vars.keys) next[k] = keyDatesDraft[k] ?? "";
        return next;
      });
      setSavingScope("");
      const payload = (data && typeof data === "object") ? (data as Record<string, unknown>) : {};
      const synced = Array.isArray(payload.synced_workflow_steps) ? payload.synced_workflow_steps.filter((x) => typeof x === "string") : [];
      toast({ title: `${vars.scope} saved`, description: synced.length ? `${synced.length} milestone(s) synced to workflow` : undefined });
    },
    onError: (err) => toastError(toast, err, "Save failed"),
  });
  const printMutation = useMutation({
    mutationFn: (payload: { printKey: string }) => apiFetchJson(`/cases/${caseId}/documents/print`, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Document generated" });
    },
    onError: (err) => toastError(toast, err, "Print failed"),
  });

  const [noteContent, setNoteContent] = useState("");
  const [activeStepId, setActiveStepId] = useState<number | null>(null);
  const [stepNote, setStepNote] = useState("");
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
    queryFn: () => apiFetchJson(`/cases/${caseId}/key-dates`),
    enabled: !!caseId,
    retry: false,
  });
  const keyDates = (keyDatesQuery.data && typeof keyDatesQuery.data === "object") ? keyDatesQuery.data : {};

  const printableQuery = useQuery<any[]>({
    queryKey: ["printable-config"],
    queryFn: () => apiFetchJson("/printable-config"),
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

  const parseKeyDates = (src: Record<string, unknown>) => ({
    spa_signed_date: dateInputValue((src as any).spa_signed_date),
    spa_forward_to_developer_execution_on: dateInputValue((src as any).spa_forward_to_developer_execution_on),
    spa_date: dateInputValue((src as any).spa_date),
    spa_stamped_date: dateInputValue((src as any).spa_stamped_date),
    stamped_spa_send_to_developer_on: dateInputValue((src as any).stamped_spa_send_to_developer_on),
    stamped_spa_received_from_developer_on: dateInputValue((src as any).stamped_spa_received_from_developer_on),
    letter_of_offer_date: dateInputValue((src as any).letter_of_offer_date),
    letter_of_offer_stamped_date: dateInputValue((src as any).letter_of_offer_stamped_date),
    loan_docs_pending_date: dateInputValue((src as any).loan_docs_pending_date),
    loan_docs_signed_date: dateInputValue((src as any).loan_docs_signed_date),
    acting_letter_issued_date: dateInputValue((src as any).acting_letter_issued_date),
    developer_confirmation_received_on: dateInputValue((src as any).developer_confirmation_received_on),
    developer_confirmation_date: dateInputValue((src as any).developer_confirmation_date),
    loan_sent_bank_execution_date: dateInputValue((src as any).loan_sent_bank_execution_date),
    loan_bank_executed_date: dateInputValue((src as any).loan_bank_executed_date),
    bank_lu_received_date: dateInputValue((src as any).bank_lu_received_date),
    bank_lu_forward_to_developer_on: dateInputValue((src as any).bank_lu_forward_to_developer_on),
    developer_lu_received_on: dateInputValue((src as any).developer_lu_received_on),
    developer_lu_dated: dateInputValue((src as any).developer_lu_dated),
    letter_disclaimer_received_on: dateInputValue((src as any).letter_disclaimer_received_on),
    letter_disclaimer_dated: dateInputValue((src as any).letter_disclaimer_dated),
    letter_disclaimer_reference_nos: typeof (src as any).letter_disclaimer_reference_nos === "string" ? String((src as any).letter_disclaimer_reference_nos) : "",
    redemption_sum: (src as any).redemption_sum !== null && (src as any).redemption_sum !== undefined ? String((src as any).redemption_sum) : "",
    loan_agreement_dated: dateInputValue((src as any).loan_agreement_dated),
    loan_agreement_submitted_stamping_date: dateInputValue((src as any).loan_agreement_submitted_stamping_date),
    loan_agreement_stamped_date: dateInputValue((src as any).loan_agreement_stamped_date),
    register_poa_on: dateInputValue((src as any).register_poa_on),
    registered_poa_registration_number: typeof (src as any).registered_poa_registration_number === "string" ? String((src as any).registered_poa_registration_number) : "",
    noa_served_on: dateInputValue((src as any).noa_served_on),
    advice_to_bank_date: dateInputValue((src as any).advice_to_bank_date),
    bank_1st_release_on: dateInputValue((src as any).bank_1st_release_on),
    first_release_amount_rm: (src as any).first_release_amount_rm !== null && (src as any).first_release_amount_rm !== undefined ? String((src as any).first_release_amount_rm) : "",
    mot_received_date: dateInputValue((src as any).mot_received_date),
    mot_signed_date: dateInputValue((src as any).mot_signed_date),
    mot_stamped_date: dateInputValue((src as any).mot_stamped_date),
    mot_registered_date: dateInputValue((src as any).mot_registered_date),
    progressive_payment_date: dateInputValue((src as any).progressive_payment_date),
    full_settlement_date: dateInputValue((src as any).full_settlement_date),
    completion_date: dateInputValue((src as any).completion_date),
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
    setActiveTab(tabFromUrl);
  }, [tabFromUrl]);

  if (!caseId) return <div className="p-6 text-slate-500">Case not found</div>;
  if (isLoadingCase || isLoadingWorkflow) return <div className="p-6 text-slate-500">Loading case details...</div>;
  if (isCaseError) return <div className="p-6"><QueryFallback title="Case unavailable" error={caseError} onRetry={() => refetchCase()} isRetrying={isFetchingCase} /></div>;
  if (isWorkflowError) return <div className="p-6"><QueryFallback title="Workflow unavailable" error={workflowError} onRetry={() => refetchWorkflow()} isRetrying={isFetchingWorkflow} /></div>;
  if (!caseInfo) return <div className="p-6 text-slate-500">Case not found</div>;

  const handleCompleteStep = (stepId: number) => {
    updateStepMutation.mutate(
      { caseId, stepId, data: { status: "completed", notes: stepNote } },
      {
        onSuccess: () => {
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
    const dmy = isDate && dateVal ? formatYmdToDmy(dateVal) : "";
    const showPrinter = Boolean(props.printerKey);
    const printerKey = props.printerKey || "";
    const st = showPrinter ? printState(printerKey) : null;
    const showStatus = showPrinter && st?.status !== "configured";
    const statusLabel = showStatus ? printStatusLabel(st) : "";

    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
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
          <Input
            className="flex-1"
            type={type}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            placeholder={isDate ? "YYYY-MM-DD" : undefined}
          />
          {showPrinter && (
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
          )}
        </div>
        {isDate && (
          <div className="mt-1 text-[10px] text-slate-500">
            {dmy ? `Display: ${dmy}` : "Format: YYYY-MM-DD"}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => setLocation(returnTo)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{caseInfo.referenceNo}</h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider bg-amber-100 text-amber-800">
                {caseInfo.status.replace(/_/g, ' ')}
              </span>
            </div>
            <p className="text-slate-500 mt-1">{caseInfo.projectName} • {caseInfo.developerName}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const spaDetails = caseInfo.spaDetails ? JSON.parse(caseInfo.spaDetails) : {};
            const loanDetails = caseInfo.loanDetails ? JSON.parse(caseInfo.loanDetails) : {};
            const propertyDetails = caseInfo.propertyDetails ? JSON.parse(caseInfo.propertyDetails) : {};
            const purchaserNames = (spaDetails.purchasers || []).map((p: any) => p.name).filter(Boolean).join(", ");
            const params = new URLSearchParams();
            params.set("caseId", String(caseInfo.id));
            params.set("ref", caseInfo.referenceNo);
            if (purchaserNames) params.set("client", purchaserNames);
            if (caseInfo.spaPrice) params.set("price", String(caseInfo.spaPrice));
            if (loanDetails.bankName) params.set("bank", loanDetails.bankName);
            if (loanDetails.loanAmount) params.set("loan", `RM ${loanDetails.loanAmount}`);
            const propDesc = [propertyDetails.address, propertyDetails.propertyType, caseInfo.parcelNo].filter(Boolean).join(", ");
            if (propDesc) params.set("property", propDesc);
            setLocation(`/app/quotations/new?${params.toString()}`);
          }}
          className="text-amber-600 border-amber-300 hover:bg-amber-50"
        >
          <Receipt className="w-4 h-4 mr-2" />
          Generate Quotation
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-9 mb-6 bg-slate-100 p-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="workflow">Workflow</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="communications">Comms</TabsTrigger>
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
                    <div className="text-slate-900 font-medium">{caseInfo.assignedLawyerName || 'Unassigned'}</div>
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
                  {(Array.isArray(caseInfo.purchasers) ? caseInfo.purchasers : []).map((p) => (
                    <div key={p.id} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <User className="w-5 h-5 text-slate-400 mt-0.5" />
                      <div>
                        <div className="font-medium text-slate-900">{p.clientName}</div>
                        <div className="text-xs text-slate-500">{p.icNo}</div>
                        <span className="inline-block mt-1 px-2 py-0.5 text-[10px] uppercase font-semibold bg-white border border-slate-200 rounded text-slate-600">
                          {p.role} Purchaser
                        </span>
                      </div>
                    </div>
                  ))}
                  {!Array.isArray(caseInfo.purchasers) || caseInfo.purchasers.length === 0 ? (
                    <div className="text-sm text-slate-500">No purchasers.</div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="space-y-1">
                <CardTitle>Key Dates & Milestones</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <Badge variant="outline" className="border-amber-200 text-amber-800">SPA: {spaStatus}</Badge>
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
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setLocation("/app/documents?tab=firm")}
                >
                  Configure Templates
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {keyDatesQuery.isError ? (
                <QueryFallback title="Key dates unavailable" error={keyDatesQuery.error} onRetry={() => keyDatesQuery.refetch()} isRetrying={keyDatesQuery.isFetching} />
              ) : (
              <Tabs value={milestoneTab} onValueChange={(v) => setMilestoneTab(v as "spa" | "loan" | "bank" | "mot")} className="w-full">
                <TabsList className="grid w-full grid-cols-2 md:grid-cols-4 bg-slate-100 p-1">
                  <TabsTrigger value="spa">
                    <span className="flex items-center gap-1">SPA{dirtySpa && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}</span>
                  </TabsTrigger>
                  <TabsTrigger value="loan">
                    <span className="flex items-center gap-1">Loan{dirtyLoan && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}</span>
                  </TabsTrigger>
                  <TabsTrigger value="bank">
                    <span className="flex items-center gap-1">Bank / LU / NOA{dirtyBank && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}</span>
                  </TabsTrigger>
                  <TabsTrigger value="mot">
                    <span className="flex items-center gap-1">MOT / Completion{dirtyMot && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}</span>
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
                    <FieldCard label="SPA Stamped" value={keyDatesDraft.spa_stamped_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_stamped_date: v }))} />
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
                        <FieldCard label="Letter of Offer Stamped" value={keyDatesDraft.letter_of_offer_stamped_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_of_offer_stamped_date: v }))} />
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
                        <FieldCard label="NOA Served On" value={keyDatesDraft.noa_served_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, noa_served_on: v }))} printerKey="noa" />
                        <FieldCard label="Register POA On" value={keyDatesDraft.register_poa_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, register_poa_on: v }))} />
                        <FieldCard label="Registered POA Registration Number" type="text" value={keyDatesDraft.registered_poa_registration_number || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, registered_poa_registration_number: v }))} />
                        <FieldCard label="Letter Disclaimer Received On" value={keyDatesDraft.letter_disclaimer_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_received_on: v }))} />
                        <FieldCard label="Letter Disclaimer Dated" value={keyDatesDraft.letter_disclaimer_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_dated: v }))} />
                        <FieldCard label="Letter Disclaimer Reference Nos" type="text" value={keyDatesDraft.letter_disclaimer_reference_nos || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_reference_nos: v }))} />
                      </div>

                      <div className="pt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                        <FieldCard label="Redemption Sum (RM)" type="number" value={keyDatesDraft.redemption_sum || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, redemption_sum: v }))} />
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
                              {step.status === 'completed' ? `Done by ${step.completedByName}` : 'Pending'}
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

                          {step.status !== 'completed' && activeStepId !== step.id && (
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
                                {step.status === 'completed' ? 'Completed' : 'Pending'}
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

                            {step.status !== 'completed' && activeStepId !== step.id && (
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
