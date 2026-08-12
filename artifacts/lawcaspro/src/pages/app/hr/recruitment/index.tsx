import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { PermissionGuard } from "@/components/permission-guard";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Briefcase, Users, Calendar, FileSignature, UserPlus } from "lucide-react";

type PositionRow = { id: number; title?: string | null; department?: string | null; status?: string | null; openings?: number | null };
type CandidateRow = { id: number; name?: string | null; positionId?: number | null; positionTitle?: string | null; status?: string | null; email?: string | null; phone?: string | null; appliedAt?: string | null };
type InterviewRow = { id: number; candidateId?: number | null; candidateName?: string | null; scheduledAt?: string | null; interviewer?: string | null; status?: string | null; round?: number | null };
type OfferRow = { id: number; candidateId?: number | null; candidateName?: string | null; positionTitle?: string | null; status?: string | null; salaryOffered?: number | string | null; sentAt?: string | null };

function HrRecruitmentInner() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const positionsQuery = useQuery({
    queryKey: ["hr-recruitment-positions"],
    queryFn: async () => {
      try { const res = await apiFetchJson("/hr/recruitment/positions"); const d = unwrapApiData<any>(res); return Array.isArray(d) ? d : d?.items ?? []; }
      catch { return [] as PositionRow[]; }
    },
    staleTime: 30_000, retry: false,
  });

  const candidatesQuery = useQuery({
    queryKey: ["hr-recruitment-candidates"],
    queryFn: async () => {
      try { const res = await apiFetchJson("/hr/recruitment/candidates"); const d = unwrapApiData<any>(res); return Array.isArray(d) ? d : d?.items ?? []; }
      catch { return [] as CandidateRow[]; }
    },
    staleTime: 30_000, retry: false,
  });

  const interviewsQuery = useQuery({
    queryKey: ["hr-recruitment-interviews"],
    queryFn: async () => {
      try { const res = await apiFetchJson("/hr/recruitment/interviews"); const d = unwrapApiData<any>(res); return Array.isArray(d) ? d : d?.items ?? []; }
      catch { return [] as InterviewRow[]; }
    },
    staleTime: 30_000, retry: false,
  });

  const offersQuery = useQuery({
    queryKey: ["hr-recruitment-offers"],
    queryFn: async () => {
      try { const res = await apiFetchJson("/hr/recruitment/offers"); const d = unwrapApiData<any>(res); return Array.isArray(d) ? d : d?.items ?? []; }
      catch { return [] as OfferRow[]; }
    },
    staleTime: 30_000, retry: false,
  });

  const hireMut = useMutation({
    mutationFn: async (candidateId: number) =>
      apiFetchJson(`/hr/recruitment/candidates/${candidateId}/convert-to-employee`, { method: "POST" }),
    onSuccess: () => { toast({ title: "Candidate hired", description: "Employee record created." }); void qc.invalidateQueries({ queryKey: ["hr-recruitment"] }); void qc.invalidateQueries({ queryKey: ["hr-employees"] }); },
    onError: (e) => toastError(toast, e, "Hire failed"),
  });

  const positions = (positionsQuery.data ?? []) as PositionRow[];
  const candidates = (candidatesQuery.data ?? []) as CandidateRow[];
  const interviews = (interviewsQuery.data ?? []) as InterviewRow[];
  const offers = (offersQuery.data ?? []) as OfferRow[];
  const fmt = (v: unknown) => `RM ${Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Briefcase className="w-5 h-5 text-slate-500" /> Recruitment
        </h1>
        <p className="text-slate-500 mt-1">Positions, candidates, interviews, and offers</p>
      </div>

      <Tabs defaultValue="positions">
        <TabsList className="grid grid-cols-4">
          <TabsTrigger value="positions" className="gap-1"><Briefcase className="w-3.5 h-3.5" /> Positions ({positions.length})</TabsTrigger>
          <TabsTrigger value="candidates" className="gap-1"><Users className="w-3.5 h-3.5" /> Candidates ({candidates.length})</TabsTrigger>
          <TabsTrigger value="interviews" className="gap-1"><Calendar className="w-3.5 h-3.5" /> Interviews ({interviews.length})</TabsTrigger>
          <TabsTrigger value="offers" className="gap-1"><FileSignature className="w-3.5 h-3.5" /> Offers ({offers.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="positions">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Open Positions</CardTitle></CardHeader>
            <CardContent>
              {positions.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <Briefcase className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No positions posted yet.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                        <th className="px-4 py-3 text-left font-medium">Title</th>
                        <th className="px-4 py-3 text-left font-medium">Dept</th>
                        <th className="px-4 py-3 text-right font-medium">Openings</th>
                        <th className="px-4 py-3 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {positions.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-medium text-slate-900">{p.title ?? "—"}</td>
                          <td className="px-4 py-3 text-slate-600 text-xs">{p.department ?? "—"}</td>
                          <td className="px-4 py-3 text-right font-mono">{p.openings ?? 1}</td>
                          <td className="px-4 py-3"><Badge variant="outline">{p.status ?? "open"}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="candidates">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Candidates</CardTitle></CardHeader>
            <CardContent>
              {candidates.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No candidates yet.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                        <th className="px-4 py-3 text-left font-medium">Candidate</th>
                        <th className="px-4 py-3 text-left font-medium">Position</th>
                        <th className="px-4 py-3 text-left font-medium">Applied</th>
                        <th className="px-4 py-3 text-left font-medium">Status</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {candidates.map((c) => {
                        const canHire = String(c.status ?? "").toLowerCase().includes("offer") || String(c.status ?? "").toLowerCase().includes("accepted") || String(c.status ?? "").toLowerCase().includes("hired") === false;
                        return (
                          <tr key={c.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3 font-medium text-slate-900">
                              <div>{c.name ?? "—"}</div>
                              <div className="text-xs text-slate-400">{c.email ?? c.phone ?? ""}</div>
                            </td>
                            <td className="px-4 py-3 text-slate-600 text-xs">{c.positionTitle ?? `#${c.positionId ?? "—"}`}</td>
                            <td className="px-4 py-3 text-slate-600 text-xs">{c.appliedAt ? new Date(String(c.appliedAt)).toLocaleDateString() : "—"}</td>
                            <td className="px-4 py-3"><Badge variant="outline">{c.status ?? "applied"}</Badge></td>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 text-green-700 border-green-200 hover:bg-green-50"
                                onClick={() => hireMut.mutate(c.id)}
                                disabled={hireMut.isPending}
                              >
                                <UserPlus className="w-3.5 h-3.5" /> Hire
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="interviews">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Interviews</CardTitle></CardHeader>
            <CardContent>
              {interviews.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No interviews scheduled.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                        <th className="px-4 py-3 text-left font-medium">Candidate</th>
                        <th className="px-4 py-3 text-left font-medium">Scheduled</th>
                        <th className="px-4 py-3 text-left font-medium">Interviewer</th>
                        <th className="px-4 py-3 text-right font-medium">Round</th>
                        <th className="px-4 py-3 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {interviews.map((i) => (
                        <tr key={i.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-medium text-slate-900">{i.candidateName ?? `#${i.candidateId ?? i.id}`}</td>
                          <td className="px-4 py-3 text-slate-600 text-xs">{i.scheduledAt ? new Date(String(i.scheduledAt)).toLocaleString() : "—"}</td>
                          <td className="px-4 py-3 text-slate-600 text-xs">{i.interviewer ?? "—"}</td>
                          <td className="px-4 py-3 text-right font-mono">{i.round ?? 1}</td>
                          <td className="px-4 py-3"><Badge variant="outline">{i.status ?? "scheduled"}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="offers">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Offer Letters</CardTitle></CardHeader>
            <CardContent>
              {offers.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <FileSignature className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No offers yet.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                        <th className="px-4 py-3 text-left font-medium">Candidate</th>
                        <th className="px-4 py-3 text-left font-medium">Position</th>
                        <th className="px-4 py-3 text-right font-medium">Salary</th>
                        <th className="px-4 py-3 text-left font-medium">Sent</th>
                        <th className="px-4 py-3 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {offers.map((o) => (
                        <tr key={o.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-medium text-slate-900">{o.candidateName ?? `#${o.candidateId ?? o.id}`}</td>
                          <td className="px-4 py-3 text-slate-600 text-xs">{o.positionTitle ?? "—"}</td>
                          <td className="px-4 py-3 text-right font-semibold">{fmt(o.salaryOffered)}</td>
                          <td className="px-4 py-3 text-slate-600 text-xs">{o.sentAt ? new Date(String(o.sentAt)).toLocaleDateString() : "—"}</td>
                          <td className="px-4 py-3">
                            {String(o.status ?? "").toLowerCase().includes("accept") ? (
                              <Badge variant="default" className="bg-green-100 text-green-700 hover:bg-green-100">Accepted</Badge>
                            ) : String(o.status ?? "").toLowerCase().includes("decline") || String(o.status ?? "").toLowerCase().includes("reject") ? (
                              <Badge variant="destructive">Declined</Badge>
                            ) : (
                              <Badge variant="secondary">{o.status ?? "sent"}</Badge>
                            )}
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
      </Tabs>
    </div>
  );
}

export default function HRRecruitmentPage() {
  return (
    <PermissionGuard module="hr" action="read">
      <HrRecruitmentInner />
    </PermissionGuard>
  );
}
