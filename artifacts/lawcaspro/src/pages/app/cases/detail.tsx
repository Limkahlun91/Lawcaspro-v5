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
import { ArrowLeft, CheckCircle2, Clock, User, Building2, MapPin, Tag, Receipt } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CaseDocumentsTab from "./components/CaseDocumentsTab";
import CaseBillingTab from "./components/CaseBillingTab";
import CaseCommunicationsTab from "./components/CaseCommunicationsTab";
import CaseTasksTab from "./components/CaseTasksTab";
import CaseTimeTab from "./components/CaseTimeTab";
import CaseComplianceTab from "./components/CaseComplianceTab";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
      const msg = typeof parsed.error === "string" ? parsed.error : text;
      const code = typeof parsed.code === "string" ? ` (${parsed.code})` : "";
      throw new Error(`${msg}${code}`);
    } catch {
      throw new Error(text);
    }
  }
  if (res.status === 204) return null;
  return res.json();
}

function dateInputValue(v: unknown): string {
  if (!v) return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return "";
}

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const caseId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: caseInfo, isLoading: isLoadingCase } = useGetCase(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseQueryKey(caseId) }
  });

  const { data: workflow, isLoading: isLoadingWorkflow } = useGetCaseWorkflow(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseWorkflowQueryKey(caseId) }
  });

  const { data: notes, isLoading: isLoadingNotes } = useGetCaseNotes(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseNotesQueryKey(caseId) }
  });

  const updateStepMutation = useUpdateWorkflowStep();
  const createNoteMutation = useCreateCaseNote();
  const saveKeyDatesMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => apiFetch(`/cases/${caseId}/key-dates`, { method: "PATCH", body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
      queryClient.invalidateQueries({ queryKey: ["case-key-dates", caseId] });
      toast({ title: "Key dates saved" });
    },
    onError: (err) => toast({ title: "Save failed", description: String(err), variant: "destructive" }),
  });
  const printMutation = useMutation({
    mutationFn: (payload: { printKey: string }) => apiFetch(`/cases/${caseId}/documents/print`, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Document generated" });
    },
    onError: (err) => toast({ title: "Print failed", description: String(err), variant: "destructive" }),
  });

  const [noteContent, setNoteContent] = useState("");
  const [activeStepId, setActiveStepId] = useState<number | null>(null);
  const [stepNote, setStepNote] = useState("");
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab") ?? "overview";
  const threadIdFromUrl = params.get("threadId");
  const initialThreadIdRaw = threadIdFromUrl ? parseInt(threadIdFromUrl, 10) : NaN;
  const initialThreadId = Number.isNaN(initialThreadIdRaw) ? null : initialThreadIdRaw;
  const [activeTab, setActiveTab] = useState(tabFromUrl);

  const { data: keyDates = {} } = useQuery<Record<string, unknown>>({
    queryKey: ["case-key-dates", caseId],
    queryFn: () => apiFetch(`/cases/${caseId}/key-dates`),
    enabled: !!caseId,
  });
  const [keyDatesDraft, setKeyDatesDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setKeyDatesDraft({
      spa_signed_date: dateInputValue((keyDates as any).spa_signed_date),
      spa_forward_to_developer_execution_on: dateInputValue((keyDates as any).spa_forward_to_developer_execution_on),
      spa_date: dateInputValue((keyDates as any).spa_date),
      spa_stamped_date: dateInputValue((keyDates as any).spa_stamped_date),
      stamped_spa_send_to_developer_on: dateInputValue((keyDates as any).stamped_spa_send_to_developer_on),
      stamped_spa_received_from_developer_on: dateInputValue((keyDates as any).stamped_spa_received_from_developer_on),
      letter_of_offer_date: dateInputValue((keyDates as any).letter_of_offer_date),
      letter_of_offer_stamped_date: dateInputValue((keyDates as any).letter_of_offer_stamped_date),
      loan_docs_pending_date: dateInputValue((keyDates as any).loan_docs_pending_date),
      loan_docs_signed_date: dateInputValue((keyDates as any).loan_docs_signed_date),
      acting_letter_issued_date: dateInputValue((keyDates as any).acting_letter_issued_date),
      developer_confirmation_received_on: dateInputValue((keyDates as any).developer_confirmation_received_on),
      developer_confirmation_date: dateInputValue((keyDates as any).developer_confirmation_date),
      loan_sent_bank_execution_date: dateInputValue((keyDates as any).loan_sent_bank_execution_date),
      loan_bank_executed_date: dateInputValue((keyDates as any).loan_bank_executed_date),
      bank_lu_received_date: dateInputValue((keyDates as any).bank_lu_received_date),
      bank_lu_forward_to_developer_on: dateInputValue((keyDates as any).bank_lu_forward_to_developer_on),
      developer_lu_received_on: dateInputValue((keyDates as any).developer_lu_received_on),
      developer_lu_dated: dateInputValue((keyDates as any).developer_lu_dated),
      letter_disclaimer_received_on: dateInputValue((keyDates as any).letter_disclaimer_received_on),
      letter_disclaimer_dated: dateInputValue((keyDates as any).letter_disclaimer_dated),
      letter_disclaimer_reference_nos: typeof (keyDates as any).letter_disclaimer_reference_nos === "string" ? String((keyDates as any).letter_disclaimer_reference_nos) : "",
      redemption_sum: (keyDates as any).redemption_sum !== null && (keyDates as any).redemption_sum !== undefined ? String((keyDates as any).redemption_sum) : "",
      loan_agreement_dated: dateInputValue((keyDates as any).loan_agreement_dated),
      loan_agreement_submitted_stamping_date: dateInputValue((keyDates as any).loan_agreement_submitted_stamping_date),
      loan_agreement_stamped_date: dateInputValue((keyDates as any).loan_agreement_stamped_date),
      register_poa_on: dateInputValue((keyDates as any).register_poa_on),
      registered_poa_registration_number: typeof (keyDates as any).registered_poa_registration_number === "string" ? String((keyDates as any).registered_poa_registration_number) : "",
      noa_served_on: dateInputValue((keyDates as any).noa_served_on),
      advice_to_bank_date: dateInputValue((keyDates as any).advice_to_bank_date),
      bank_1st_release_on: dateInputValue((keyDates as any).bank_1st_release_on),
      first_release_amount_rm: (keyDates as any).first_release_amount_rm !== null && (keyDates as any).first_release_amount_rm !== undefined ? String((keyDates as any).first_release_amount_rm) : "",
      mot_received_date: dateInputValue((keyDates as any).mot_received_date),
      mot_signed_date: dateInputValue((keyDates as any).mot_signed_date),
      mot_stamped_date: dateInputValue((keyDates as any).mot_stamped_date),
      mot_registered_date: dateInputValue((keyDates as any).mot_registered_date),
      progressive_payment_date: dateInputValue((keyDates as any).progressive_payment_date),
      full_settlement_date: dateInputValue((keyDates as any).full_settlement_date),
      completion_date: dateInputValue((keyDates as any).completion_date),
    });
  }, [caseId, keyDates]);

  useEffect(() => {
    setActiveTab(tabFromUrl);
  }, [tabFromUrl]);

  if (isLoadingCase) return <div>Loading case details...</div>;
  if (!caseInfo) return <div>Case not found</div>;

  const handleCompleteStep = (stepId: number) => {
    updateStepMutation.mutate(
      { caseId, stepId, data: { status: "completed", notes: stepNote } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
          toast({ title: "Step marked as completed" });
          setActiveStepId(null);
          setStepNote("");
        }
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
        }
      }
    );
  };

  const commonSteps = workflow?.filter(s => s.pathType === "common") || [];
  const loanSteps = workflow?.filter(s => s.pathType === "loan") || [];
  const motSteps = workflow?.filter(s => s.pathType === "mot") || [];

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => setLocation("/app/cases")}>
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
                  {caseInfo.purchasers.map((p) => (
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
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Key Dates & Milestones</CardTitle>
              <Button
                size="sm"
                className="bg-amber-500 hover:bg-amber-600"
                onClick={() => {
                  const payload: Record<string, unknown> = {};
                  const dateKeys = [
                    "spa_signed_date",
                    "spa_forward_to_developer_execution_on",
                    "spa_date",
                    "spa_stamped_date",
                    "stamped_spa_send_to_developer_on",
                    "stamped_spa_received_from_developer_on",
                    "letter_of_offer_date",
                    "letter_of_offer_stamped_date",
                    "loan_docs_pending_date",
                    "loan_docs_signed_date",
                    "acting_letter_issued_date",
                    "developer_confirmation_received_on",
                    "developer_confirmation_date",
                    "loan_sent_bank_execution_date",
                    "loan_bank_executed_date",
                    "bank_lu_received_date",
                    "bank_lu_forward_to_developer_on",
                    "developer_lu_received_on",
                    "developer_lu_dated",
                    "letter_disclaimer_received_on",
                    "letter_disclaimer_dated",
                    "loan_agreement_dated",
                    "loan_agreement_submitted_stamping_date",
                    "loan_agreement_stamped_date",
                    "register_poa_on",
                    "noa_served_on",
                    "advice_to_bank_date",
                    "bank_1st_release_on",
                    "mot_received_date",
                    "mot_signed_date",
                    "mot_stamped_date",
                    "mot_registered_date",
                    "progressive_payment_date",
                    "full_settlement_date",
                    "completion_date",
                  ];
                  for (const k of dateKeys) {
                    const v = keyDatesDraft[k] || "";
                    payload[k] = v ? v : null;
                  }
                  payload.letter_disclaimer_reference_nos = keyDatesDraft.letter_disclaimer_reference_nos ? keyDatesDraft.letter_disclaimer_reference_nos : null;
                  payload.registered_poa_registration_number = keyDatesDraft.registered_poa_registration_number ? keyDatesDraft.registered_poa_registration_number : null;
                  payload.redemption_sum = keyDatesDraft.redemption_sum ? keyDatesDraft.redemption_sum : null;
                  payload.first_release_amount_rm = keyDatesDraft.first_release_amount_rm ? keyDatesDraft.first_release_amount_rm : null;
                  saveKeyDatesMutation.mutate(payload);
                }}
                disabled={saveKeyDatesMutation.isPending}
              >
                {saveKeyDatesMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-slate-800">SPA</div>
                  <div className="space-y-1.5">
                    <Label>SPA Signed</Label>
                    <Input type="date" value={keyDatesDraft.spa_signed_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, spa_signed_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>SPA Forward to Dev. Execution On</Label>
                    <Input type="date" value={keyDatesDraft.spa_forward_to_developer_execution_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, spa_forward_to_developer_execution_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>SPA Date</Label>
                    <Input type="date" value={keyDatesDraft.spa_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, spa_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>SPA Stamped</Label>
                    <Input type="date" value={keyDatesDraft.spa_stamped_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, spa_stamped_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Stamped SPA Send to Dev. On</Label>
                    <Input type="date" value={keyDatesDraft.stamped_spa_send_to_developer_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, stamped_spa_send_to_developer_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Stamped SPA Received from Dev. On</Label>
                    <Input type="date" value={keyDatesDraft.stamped_spa_received_from_developer_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, stamped_spa_received_from_developer_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Letter of Offer Date</Label>
                    <Input type="date" value={keyDatesDraft.letter_of_offer_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, letter_of_offer_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Letter of Offer Stamped</Label>
                    <Input type="date" value={keyDatesDraft.letter_of_offer_stamped_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, letter_of_offer_stamped_date: e.target.value }))} />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-semibold text-slate-800">Loan</div>
                  <div className="space-y-1.5">
                    <Label>Loan Docs Pending Signing</Label>
                    <Input type="date" value={keyDatesDraft.loan_docs_pending_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, loan_docs_pending_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Loan Docs Signed</Label>
                    <Input type="date" value={keyDatesDraft.loan_docs_signed_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, loan_docs_signed_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Acting Letter Issued</Label>
                    <div className="flex gap-2">
                      <Input type="date" value={keyDatesDraft.acting_letter_issued_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, acting_letter_issued_date: e.target.value }))} />
                      <Button size="sm" variant="outline" onClick={() => printMutation.mutate({ printKey: "acting_letter" })} disabled={printMutation.isPending}>
                        Acting Letter
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Developer Confirmation Received On</Label>
                    <Input type="date" value={keyDatesDraft.developer_confirmation_received_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, developer_confirmation_received_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Developer Confirmation Date</Label>
                    <Input type="date" value={keyDatesDraft.developer_confirmation_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, developer_confirmation_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Loan Sent for Bank Execution</Label>
                    <div className="flex gap-2">
                      <Input type="date" value={keyDatesDraft.loan_sent_bank_execution_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, loan_sent_bank_execution_date: e.target.value }))} />
                      <Button size="sm" variant="outline" onClick={() => printMutation.mutate({ printKey: "letter_forward_bank_execution" })} disabled={printMutation.isPending}>
                        Letter Forward Bank Execution
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Loan Bank Executed</Label>
                    <Input type="date" value={keyDatesDraft.loan_bank_executed_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, loan_bank_executed_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Bank LU Received</Label>
                    <Input type="date" value={keyDatesDraft.bank_lu_received_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, bank_lu_received_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Bank LU Forward to Dev. On</Label>
                    <div className="flex gap-2">
                      <Input type="date" value={keyDatesDraft.bank_lu_forward_to_developer_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, bank_lu_forward_to_developer_on: e.target.value }))} />
                      <Button size="sm" variant="outline" onClick={() => printMutation.mutate({ printKey: "letter_forward_bank_lu_to_dev" })} disabled={printMutation.isPending}>
                        Letter Forward Bank’s LU to Dev.
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Developer LU Received On</Label>
                    <Input type="date" value={keyDatesDraft.developer_lu_received_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, developer_lu_received_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Developer LU Dated</Label>
                    <Input type="date" value={keyDatesDraft.developer_lu_dated || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, developer_lu_dated: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Letter Disclaimer Received On</Label>
                    <Input type="date" value={keyDatesDraft.letter_disclaimer_received_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_received_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Letter Disclaimer Dated</Label>
                    <Input type="date" value={keyDatesDraft.letter_disclaimer_dated || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_dated: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Letter Disclaimer Reference Nos</Label>
                    <Input value={keyDatesDraft.letter_disclaimer_reference_nos || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_reference_nos: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Redemption Sum (RM)</Label>
                    <Input type="number" step="0.01" value={keyDatesDraft.redemption_sum || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, redemption_sum: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Loan Agreement Dated</Label>
                    <Input type="date" value={keyDatesDraft.loan_agreement_dated || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, loan_agreement_dated: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Loan Agreement Submitted Stamping</Label>
                    <Input type="date" value={keyDatesDraft.loan_agreement_submitted_stamping_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, loan_agreement_submitted_stamping_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Loan Agreement Stamped</Label>
                    <Input type="date" value={keyDatesDraft.loan_agreement_stamped_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, loan_agreement_stamped_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Register POA On</Label>
                    <Input type="date" value={keyDatesDraft.register_poa_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, register_poa_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Registered POA Registration Number</Label>
                    <Input value={keyDatesDraft.registered_poa_registration_number || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, registered_poa_registration_number: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>NOA Served On</Label>
                    <div className="flex gap-2">
                      <Input type="date" value={keyDatesDraft.noa_served_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, noa_served_on: e.target.value }))} />
                      <Button size="sm" variant="outline" onClick={() => printMutation.mutate({ printKey: "noa" })} disabled={printMutation.isPending}>
                        NOA
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Advice to Bank Date</Label>
                    <div className="flex gap-2">
                      <Input type="date" value={keyDatesDraft.advice_to_bank_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, advice_to_bank_date: e.target.value }))} />
                      <Button size="sm" variant="outline" onClick={() => printMutation.mutate({ printKey: "letter_advice_spa_sol_lu" })} disabled={printMutation.isPending}>
                        Letter Advice & SPA Sol. LU
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Bank 1st Release On</Label>
                    <Input type="date" value={keyDatesDraft.bank_1st_release_on || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, bank_1st_release_on: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>First Release Amount (RM)</Label>
                    <Input type="number" step="0.01" value={keyDatesDraft.first_release_amount_rm || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, first_release_amount_rm: e.target.value }))} />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-semibold text-slate-800">MOT / Completion</div>
                  <div className="space-y-1.5">
                    <Label>MOT Received</Label>
                    <Input type="date" value={keyDatesDraft.mot_received_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, mot_received_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>MOT Signed</Label>
                    <Input type="date" value={keyDatesDraft.mot_signed_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, mot_signed_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>MOT Stamped</Label>
                    <Input type="date" value={keyDatesDraft.mot_stamped_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, mot_stamped_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>MOT Registered</Label>
                    <Input type="date" value={keyDatesDraft.mot_registered_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, mot_registered_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Progressive Payment Date</Label>
                    <Input type="date" value={keyDatesDraft.progressive_payment_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, progressive_payment_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Full Settlement Date</Label>
                    <Input type="date" value={keyDatesDraft.full_settlement_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, full_settlement_date: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Completion Date</Label>
                    <Input type="date" value={keyDatesDraft.completion_date || ""} onChange={(e) => setKeyDatesDraft((p) => ({ ...p, completion_date: e.target.value }))} />
                  </div>
                </div>
              </div>
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
