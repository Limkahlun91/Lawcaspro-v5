import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle, Clock, Plus, User, Building2, ChevronDown, ChevronUp } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import PartyForm from "./PartyForm";
import BeneficialOwnerForm from "./BeneficialOwnerForm";
import CaseConflictPanel from "./CaseConflictPanel";

const CDD_STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  not_started:                        { label: "Not Started",    color: "bg-slate-100 text-slate-600",  icon: Clock },
  in_progress:                        { label: "In Progress",    color: "bg-blue-100 text-blue-700",    icon: Clock },
  pending_review:                     { label: "Pending Review", color: "bg-amber-100 text-amber-700",  icon: Clock },
  approved:                           { label: "Approved",       color: "bg-green-100 text-green-700",  icon: CheckCircle },
  rejected:                           { label: "Rejected",       color: "bg-red-100 text-red-700",      icon: AlertTriangle },
  enhanced_due_diligence_required:    { label: "EDD Required",   color: "bg-orange-100 text-orange-700", icon: AlertTriangle },
};

const RISK_LEVEL_CONFIG: Record<string, { label: string; color: string }> = {
  low:       { label: "Low",       color: "bg-green-100 text-green-700" },
  medium:    { label: "Medium",    color: "bg-amber-100 text-amber-700" },
  high:      { label: "High",      color: "bg-orange-100 text-orange-700" },
  very_high: { label: "Very High", color: "bg-red-100 text-red-700" },
};

function RiskBadge({ level }: { level: string }) {
  const cfg = RISK_LEVEL_CONFIG[level] ?? RISK_LEVEL_CONFIG.low;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cfg.color}`}>{cfg.label}</span>;
}

function CddBadge({ status }: { status: string }) {
  const cfg = CDD_STATUS_CONFIG[status] ?? CDD_STATUS_CONFIG.not_started;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function PartyCard({ party, onRefresh }: { party: any; onRefresh: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [showBoForm, setShowBoForm] = useState(false);
  const [showStatusDialog, setShowStatusDialog] = useState(false);
  const [newStatus, setNewStatus] = useState("");
  const [statusNotes, setStatusNotes] = useState("");
  const [statusLoading, setStatusLoading] = useState(false);

  const profile = party.complianceProfile;
  const PartyIcon = party.partyType === "company" ? Building2 : User;

  async function updateCddStatus() {
    if (!newStatus || !profile) return;
    setStatusLoading(true);
    try {
      await apiFetchJson(`/compliance/profiles/${profile.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cddStatus: newStatus, notes: statusNotes }),
      });
      toast({ title: "CDD status updated" });
      setShowStatusDialog(false);
      onRefresh();
    } catch (err) {
      toastError(toast, err, "Update failed");
    } finally {
      setStatusLoading(false);
    }
  }

  async function runRiskAssessment() {
    if (!profile) return;
    const factors = {
      factorIsPep: !!party.isPep,
      factorHighRiskJurisdiction: !!party.isHighRiskJurisdiction,
      factorComplexOwnership: !!party.hasLayeredOwnership,
      factorNomineeArrangement: !!party.hasNomineeArrangement,
      factorMissingSourceOfFunds: (party.complianceProfile?.sourceOfFunds?.length ?? 0) === 0,
      factorSuspiciousInconsistencies: false,
    };
    try {
      const data = await apiFetchJson<any>(`/compliance/profiles/${profile.id}/risk-assessment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(factors),
      });
      toast({ title: `Risk assessed: ${data.profile.riskLevel} (score ${data.profile.riskScore})` });
      onRefresh();
    } catch (err) {
      toastError(toast, err, "Assessment failed");
    }
  }

  return (
    <Card className="border border-slate-200">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
              <PartyIcon className="w-4 h-4 text-slate-600" />
            </div>
            <div>
              <div className="font-semibold text-slate-900">{party.fullName}</div>
              <div className="text-xs text-slate-500 capitalize">{party.partyType.replace("_", " ")}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {profile && <CddBadge status={profile.cddStatus} />}
            {profile && <RiskBadge level={profile.riskLevel} />}
            <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {profile?.eddTriggered && (
          <div className="mt-2 flex items-center gap-2 p-2 rounded bg-orange-50 border border-orange-200 text-xs text-orange-700">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            <span>EDD Required: {profile.eddReason}</span>
          </div>
        )}
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-4">
          {/* Identity info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            {party.nric && <div><span className="text-slate-500">NRIC:</span> <span className="font-medium">{party.nric}</span></div>}
            {party.passportNo && <div><span className="text-slate-500">Passport:</span> <span className="font-medium">{party.passportNo}</span></div>}
            {party.companyRegNo && <div><span className="text-slate-500">Co. Reg:</span> <span className="font-medium">{party.companyRegNo}</span></div>}
            {party.nationality && <div><span className="text-slate-500">Nationality:</span> <span className="font-medium">{party.nationality}</span></div>}
            {party.occupation && <div><span className="text-slate-500">Occupation:</span> <span className="font-medium">{party.occupation}</span></div>}
            {party.transactionPurpose && <div className="col-span-2"><span className="text-slate-500">Purpose:</span> <span className="font-medium">{party.transactionPurpose}</span></div>}
          </div>

          {/* Risk flags */}
          {(party.isPep || party.isHighRiskJurisdiction || party.hasNomineeArrangement || party.hasLayeredOwnership) && (
            <div className="flex flex-wrap gap-2">
              {party.isPep && <Badge className="bg-red-100 text-red-700 border-red-200">PEP</Badge>}
              {party.isHighRiskJurisdiction && <Badge className="bg-orange-100 text-orange-700 border-orange-200">High-Risk Jurisdiction</Badge>}
              {party.hasNomineeArrangement && <Badge className="bg-amber-100 text-amber-700 border-amber-200">Nominee Arrangement</Badge>}
              {party.hasLayeredOwnership && <Badge className="bg-amber-100 text-amber-700 border-amber-200">Layered Ownership</Badge>}
            </div>
          )}

          {/* Beneficial owners */}
          {party.beneficialOwners?.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Beneficial Owners</div>
              <div className="space-y-2">
                {party.beneficialOwners.map((bo: any) => (
                  <div key={bo.id} className="flex items-center justify-between p-2 rounded bg-slate-50 text-sm">
                    <div>
                      <span className="font-medium">{bo.ownerName}</span>
                      {bo.ownershipPercentage && <span className="text-slate-500 ml-2">{bo.ownershipPercentage}%</span>}
                      {bo.isUltimateBeneficialOwner && <Badge className="ml-2 bg-blue-100 text-blue-700 border-blue-200 text-xs">UBO</Badge>}
                      {bo.isPep && <Badge className="ml-2 bg-red-100 text-red-700 border-red-200 text-xs">PEP</Badge>}
                    </div>
                    <span className="text-xs text-slate-400 capitalize">{bo.ownerType.replace("_", " ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
            <Button size="sm" variant="outline" onClick={() => setShowBoForm(true)}>
              <Plus className="w-3 h-3 mr-1" /> Add UBO
            </Button>
            {profile && (
              <>
                <Button size="sm" variant="outline" onClick={runRiskAssessment}>
                  Re-assess Risk
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setNewStatus(profile.cddStatus); setShowStatusDialog(true); }}>
                  Update CDD Status
                </Button>
              </>
            )}
          </div>
        </CardContent>
      )}

      {/* UBO Form */}
      <BeneficialOwnerForm
        open={showBoForm}
        onOpenChange={setShowBoForm}
        onCreated={() => onRefresh()}
        partyId={party.id}
        partyName={party.fullName}
      />

      {/* Status dialog */}
      <Dialog open={showStatusDialog} onOpenChange={setShowStatusDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Update CDD Status</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>New Status</Label>
              <Select value={newStatus} onValueChange={setNewStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CDD_STATUS_CONFIG).map(([key, cfg]) => (
                    <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea value={statusNotes} onChange={e => setStatusNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setShowStatusDialog(false)}>Cancel</Button>
            <Button onClick={updateCddStatus} disabled={statusLoading} className="bg-[#0f1729] hover:bg-[#1a2540]">
              {statusLoading ? "Saving..." : "Update"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface CaseComplianceTabProps {
  caseId: number;
}

export default function CaseComplianceTab({ caseId }: CaseComplianceTabProps) {
  const [showPartyForm, setShowPartyForm] = useState(false);
  const queryClient = useQueryClient();

  const partiesQuery = useQuery({
    queryKey: ["case-compliance-parties", caseId],
    queryFn: async () => {
      const links = await apiFetchJson<any[]>(`/cases/${caseId}/parties`);
      if (!Array.isArray(links) || links.length === 0) return [];

      // Fetch full party data for each linked party
      const details = await Promise.all(
        links.map(async (link: any) => {
          try {
            return await apiFetchJson(`/parties/${link.partyId}`);
          } catch {
            return null;
          }
        })
      );
      return details.filter(Boolean);
    },
    retry: false,
  });
  const parties = (partiesQuery.data ?? []) as any[];

  function handleRefresh() {
    partiesQuery.refetch();
    queryClient.invalidateQueries({ queryKey: ["case-compliance-parties", caseId] });
  }

  const totalParties = parties.length;
  const approvedCount = parties.filter((p: any) => p.complianceProfile?.cddStatus === "approved").length;
  const eddCount = parties.filter((p: any) => p.complianceProfile?.eddTriggered).length;
  const highRiskCount = parties.filter((p: any) => ["high", "very_high"].includes(p.complianceProfile?.riskLevel)).length;

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-2xl font-bold text-slate-900">{totalParties}</div>
            <div className="text-sm text-slate-500">Total Parties</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-2xl font-bold text-green-700">{approvedCount}</div>
            <div className="text-sm text-slate-500">CDD Approved</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-2xl font-bold text-orange-700">{eddCount}</div>
            <div className="text-sm text-slate-500">EDD Required</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-2xl font-bold text-red-700">{highRiskCount}</div>
            <div className="text-sm text-slate-500">High Risk</div>
          </CardContent>
        </Card>
      </div>

      {/* Conflict check panel */}
      <CaseConflictPanel caseId={caseId} parties={parties ?? []} />

      {/* Parties list */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-slate-900">Parties &amp; CDD Profiles</h3>
          <Button size="sm" className="bg-[#0f1729] hover:bg-[#1a2540]" onClick={() => setShowPartyForm(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add Party
          </Button>
        </div>

        {partiesQuery.isError ? (
          <QueryFallback title="Compliance parties unavailable" error={partiesQuery.error} onRetry={() => partiesQuery.refetch()} isRetrying={partiesQuery.isFetching} />
        ) : partiesQuery.isLoading ? (
          <div className="text-sm text-slate-500 py-8 text-center">Loading parties...</div>
        ) : parties.length === 0 ? (
          <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-lg">
            <User className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-sm text-slate-500">No parties added yet.</p>
            <p className="text-xs text-slate-400 mt-1">Add parties to begin CDD/KYC compliance.</p>
            <Button size="sm" className="mt-4 bg-[#0f1729] hover:bg-[#1a2540]" onClick={() => setShowPartyForm(true)}>
              <Plus className="w-4 h-4 mr-1" /> Add First Party
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {parties.map((party: any) => (
              <PartyCard key={party.id} party={party} onRefresh={handleRefresh} />
            ))}
          </div>
        )}
      </div>

      <PartyForm
        open={showPartyForm}
        onOpenChange={setShowPartyForm}
        onCreated={() => handleRefresh()}
        caseId={caseId}
      />
    </div>
  );
}
