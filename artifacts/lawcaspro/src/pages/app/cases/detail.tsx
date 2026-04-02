import { useParams, useLocation } from "wouter";
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
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import CaseDocumentsTab from "./components/CaseDocumentsTab";
import CaseBillingTab from "./components/CaseBillingTab";
import CaseCommunicationsTab from "./components/CaseCommunicationsTab";

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const caseId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
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

  const [noteContent, setNoteContent] = useState("");
  const [activeStepId, setActiveStepId] = useState<number | null>(null);
  const [stepNote, setStepNote] = useState("");

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

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-6 mb-6 bg-slate-100 p-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="workflow">Workflow</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="communications">Comms</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
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
          <CaseCommunicationsTab caseId={caseId} />
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
      </Tabs>
    </div>
  );
}
