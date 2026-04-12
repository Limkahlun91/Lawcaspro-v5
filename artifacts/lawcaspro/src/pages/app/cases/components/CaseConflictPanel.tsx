import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle, ShieldAlert, Search, Lock } from "lucide-react";
import { useReAuth } from "@/components/re-auth-dialog";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";

const RESULT_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  no_match:                       { label: "Clear",            color: "bg-green-100 text-green-700",   icon: CheckCircle },
  warning:                        { label: "Warning",          color: "bg-amber-100 text-amber-700",   icon: AlertTriangle },
  blocked_pending_partner_override: { label: "Blocked",        color: "bg-red-100 text-red-700",       icon: ShieldAlert },
};

interface ConflictPanelProps {
  caseId: number;
  parties: any[];
}

export default function CaseConflictPanel({ caseId, parties }: ConflictPanelProps) {
  const { toast } = useToast();
  const { wrapWithReAuth } = useReAuth();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<{ checkId: number; matchId: number; detail: string } | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideLoading, setOverrideLoading] = useState(false);

  const checksQuery = useQuery({
    queryKey: ["conflict-checks", caseId],
    queryFn: () => apiFetchJson(`/conflict/checks?caseId=${caseId}`),
    retry: false,
  });
  const checksData = checksQuery.data as any;

  const latestCheck = checksData?.data?.[0];

  const checkDetailQuery = useQuery({
    queryKey: ["conflict-check-detail", latestCheck?.id],
    queryFn: async () => {
      if (!latestCheck?.id) return null;
      return await apiFetchJson(`/conflict/checks/${latestCheck.id}`);
    },
    enabled: !!latestCheck?.id,
    retry: false,
  });
  const checkDetail = checkDetailQuery.data as any;

  async function runCheck() {
    if (parties.length === 0) {
      toast({ title: "Add parties first before running conflict check", variant: "destructive" });
      return;
    }

    const partyList = parties.map((p: any) => ({
      name: p.fullName,
      identifier: p.nric || p.passportNo || p.companyRegNo || undefined,
      identifierType: p.nric ? "nric" : p.passportNo ? "passport" : p.companyRegNo ? "company_reg" : "none",
      role: p.caseLinks?.[0]?.partyRole ?? "party",
    }));

    setRunning(true);
    try {
      const data = await apiFetchJson<any>(`/conflict/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, parties: partyList }),
      });
      const result = data.check?.overallResult ?? "unknown";
      toast({
        title: `Conflict check complete`,
        description: result === "no_match" ? "No conflicts found" : `Result: ${RESULT_CONFIG[result]?.label ?? result}`,
      });
      checksQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["conflict-check-detail"] });
    } catch (err) {
      toastError(toast, err, "Conflict check failed");
    } finally {
      setRunning(false);
    }
  }

  async function handleOverride() {
    if (!overrideTarget || overrideReason.trim().length < 10) {
      toast({ title: "Reason must be at least 10 characters", variant: "destructive" });
      return;
    }

    setOverrideLoading(true);
    try {
      await wrapWithReAuth(async (authHeaders) => {
        return await apiFetchJson(`/conflict/checks/${overrideTarget.checkId}/override`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ conflictMatchId: overrideTarget.matchId, overrideReason }),
        });
      }, "Confirm partner override for conflict match");

      toast({ title: "Conflict override applied successfully" });
      setOverrideDialogOpen(false);
      setOverrideReason("");
      setOverrideTarget(null);
      checksQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["conflict-check-detail"] });
    } catch (err) {
      if (err instanceof Error && err.message === "Re-authentication cancelled") return;
      toastError(toast, err, "Override failed");
    } finally {
      setOverrideLoading(false);
    }
  }

  const result = latestCheck?.overallResult;
  const ResultIcon = result ? (RESULT_CONFIG[result]?.icon ?? CheckCircle) : CheckCircle;
  const resultCfg = result ? RESULT_CONFIG[result] : null;
  const overriddenMatchIds = new Set(checkDetail?.overrides?.map((o: any) => o.conflictMatchId) ?? []);

  return (
    <Card className="border border-slate-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-slate-500" />
            <CardTitle className="text-sm font-semibold">Conflict Check</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {resultCfg && (
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${resultCfg.color}`}>
                <ResultIcon className="w-3 h-3" />
                {resultCfg.label}
              </span>
            )}
            <Button size="sm" onClick={runCheck} disabled={running} className="bg-[#0f1729] hover:bg-[#1a2540]">
              {running ? "Running..." : latestCheck ? "Re-run Check" : "Run Check"}
            </Button>
          </div>
        </div>
        {latestCheck && (
          <div className="text-xs text-slate-500 mt-1">
            Last run: {new Date(latestCheck.runAt ?? latestCheck.createdAt).toLocaleString()}
            {latestCheck.status === "running" && <span className="ml-2 text-blue-600">Running...</span>}
          </div>
        )}
      </CardHeader>

      {checksQuery.isError ? (
        <CardContent className="pt-0">
          <QueryFallback title="Conflict check unavailable" error={checksQuery.error} onRetry={() => checksQuery.refetch()} isRetrying={checksQuery.isFetching} />
        </CardContent>
      ) : null}

      {checkDetailQuery.isError ? (
        <CardContent className="pt-0">
          <QueryFallback title="Conflict details unavailable" error={checkDetailQuery.error} onRetry={() => checkDetailQuery.refetch()} isRetrying={checkDetailQuery.isFetching} />
        </CardContent>
      ) : checkDetail?.matches?.length > 0 ? (
        <CardContent className="pt-0 space-y-2">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
            Matches ({checkDetail.matches.length})
          </div>
          {checkDetail.matches.map((match: any) => {
            const isOverridden = overriddenMatchIds.has(match.id);
            const matchResult = isOverridden ? "overridden" : match.result;
            return (
              <div key={match.id} className={`rounded-lg border p-3 text-sm ${
                matchResult === "blocked"    ? "border-red-200 bg-red-50" :
                matchResult === "warning"   ? "border-amber-200 bg-amber-50" :
                matchResult === "overridden"? "border-slate-200 bg-slate-50 opacity-70" :
                "border-slate-200 bg-slate-50"
              }`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="font-medium text-slate-900">{match.partyName}</div>
                    <div className="text-slate-600 text-xs mt-0.5">{match.detail}</div>
                    {isOverridden && (
                      <div className="text-xs text-slate-500 mt-1 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3 text-green-600" />
                        Overridden by partner
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Badge className={`text-xs ${
                      matchResult === "blocked"     ? "bg-red-100 text-red-700 border-red-200" :
                      matchResult === "warning"     ? "bg-amber-100 text-amber-700 border-amber-200" :
                      matchResult === "overridden"  ? "bg-slate-100 text-slate-600 border-slate-200" :
                      "bg-green-100 text-green-700 border-green-200"
                    }`}>
                      {match.matchScore}% match
                    </Badge>
                    {match.result === "blocked" && !isOverridden && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7 border-red-300 text-red-700 hover:bg-red-50"
                        onClick={() => {
                          setOverrideTarget({ checkId: checkDetail.check.id, matchId: match.id, detail: match.detail });
                          setOverrideDialogOpen(true);
                        }}
                      >
                        <Lock className="w-3 h-3 mr-1" />
                        Override
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      ) : null}

      {checkDetail?.matches?.length === 0 && latestCheck?.status === "completed" && (
        <CardContent className="pt-0">
          <div className="flex items-center gap-2 text-sm text-green-700 py-2">
            <CheckCircle className="w-4 h-4" />
            No conflicts found for the parties on this case.
          </div>
        </CardContent>
      )}

      {/* Partner Override Dialog */}
      <Dialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-red-600" />
              Partner Override — Conflict Match
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertTriangle className="w-4 h-4 inline mr-1" />
              {overrideTarget?.detail}
            </div>
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
              This override requires your firm password re-confirmation (re-authentication). The override will be permanently recorded in the audit log.
            </div>
            <div>
              <Label>Override Reason <span className="text-red-500">*</span></Label>
              <Textarea
                value={overrideReason}
                onChange={e => setOverrideReason(e.target.value)}
                placeholder="Provide a detailed justification for overriding this conflict match (minimum 10 characters)..."
                rows={3}
              />
              <p className="text-xs text-slate-500 mt-1">{overrideReason.length}/10 minimum characters</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleOverride}
              disabled={overrideLoading || overrideReason.trim().length < 10}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {overrideLoading ? "Processing..." : "Confirm Override"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
