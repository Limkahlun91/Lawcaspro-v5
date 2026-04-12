import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { formatCurrencyMYR } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";

type ListingStatus = "new" | "ongoing" | "closed" | "kiv" | "hold";

type CaseFileRow = {
  id: number;
  referenceNo: string;
  clientParties: Array<{ role: string; name: string; idNo: string | null }>;
  purchasePrice: number | null;
  purchaseMode: string;
  loanBank: string | null;
  loanAmount: number | null;
  propertyInfo: string;
  lawyerInCharge: string | null;
  clerkInCharge: string | null;
  fileListingStatus: ListingStatus;
  fileListingReason: string | null;
  updatedAt: string;
};

type ListResponse = {
  data: CaseFileRow[];
  page: number;
  limit: number;
  total: number;
};

function statusLabel(s: ListingStatus): string {
  if (s === "new") return "new";
  if (s === "ongoing") return "ongoing";
  if (s === "closed") return "closed";
  if (s === "kiv") return "KIV";
  return "hold";
}

function statusBadgeVariant(s: ListingStatus): "default" | "secondary" | "destructive" | "outline" {
  if (s === "closed") return "secondary";
  if (s === "hold") return "destructive";
  if (s === "kiv") return "outline";
  if (s === "new") return "default";
  return "default";
}

export default function CaseFileListing() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const canUpdate = hasPermission(user, "cases", "update");

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);

  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pendingStatus, setPendingStatus] = useState<ListingStatus>("ongoing");
  const [pendingCaseId, setPendingCaseId] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const queryKey = useMemo(() => ["case-files", debounced, page, limit] as const, [debounced, page, limit]);
  const listQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<ListResponse> => {
      const params = new URLSearchParams();
      if (debounced) params.set("q", debounced);
      params.set("page", String(page));
      params.set("limit", String(limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return await apiFetchJson(`/case-files${suffix}`);
    },
    retry: false,
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const updateStatusMutation = useMutation({
    mutationFn: async (vars: { caseId: number; status: ListingStatus; reason?: string }) =>
      await apiFetchJson(`/case-files/${vars.caseId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: vars.status, reason: vars.reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-files"] });
      toast({ title: "Status updated" });
    },
    onError: (e) => toastError(toast, e, "Update failed"),
  });

  function openReasonDialog(caseId: number, status: ListingStatus, existingReason?: string | null) {
    setPendingCaseId(caseId);
    setPendingStatus(status);
    setReason(existingReason ?? "");
    setReasonOpen(true);
  }

  function handleStatusChange(caseId: number, next: ListingStatus, existingReason?: string | null) {
    if (!canUpdate) return;
    if (next === "kiv" || next === "hold") {
      openReasonDialog(caseId, next, existingReason);
      return;
    }
    updateStatusMutation.mutate({ caseId, status: next });
  }

  function renderParties(parties: CaseFileRow["clientParties"]) {
    if (!parties.length) return <span className="text-slate-400">—</span>;
    const shown = parties.slice(0, 2);
    const more = parties.length - shown.length;
    return (
      <div className="space-y-1">
        {shown.map((p, idx) => (
          <div key={`${p.role}-${p.name}-${idx}`} className="flex items-center gap-2">
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">{p.role}</Badge>
            <span className="text-sm text-slate-900 truncate">{p.name}</span>
            {p.idNo ? <span className="text-xs text-slate-500 truncate">{p.idNo}</span> : null}
          </div>
        ))}
        {more > 0 ? <div className="text-xs text-slate-500">+{more} more</div> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Case File Listing</h1>
          <p className="text-sm text-slate-600 mt-1">Quick searchable overview of files, parties, assignment and status.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-3">
            <span>Listing</span>
            <div className="relative w-full max-w-md">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                className="pl-9"
                placeholder="Search file ref, client, NRIC, bank, project, lawyer/clerk, status…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isError ? (
            <QueryFallback title="Listing unavailable" error={listQuery.error} onRetry={() => listQuery.refetch()} isRetrying={listQuery.isFetching} />
          ) : listQuery.isLoading ? (
            <div className="text-slate-500 py-10 text-center">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-14 text-slate-500">
              <p className="font-medium text-slate-700">No files found</p>
              <p className="text-sm mt-1">Try a different keyword.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b">
                    <th className="py-3 pr-4 w-14">No.</th>
                    <th className="py-3 pr-4 min-w-[180px]">File Reference</th>
                    <th className="py-3 pr-4 min-w-[260px]">Client Name &amp; NRIC</th>
                    <th className="py-3 pr-4 min-w-[140px]">Purchase Price</th>
                    <th className="py-3 pr-4 min-w-[120px]">Purchase By</th>
                    <th className="py-3 pr-4 min-w-[170px]">Loan Bank</th>
                    <th className="py-3 pr-4 min-w-[140px]">Loan Amount</th>
                    <th className="py-3 pr-4 min-w-[260px]">Property / Project Info</th>
                    <th className="py-3 pr-4 min-w-[160px]">Lawyer In Charge</th>
                    <th className="py-3 pr-4 min-w-[160px]">Clerk In Charge</th>
                    <th className="py-3 pr-4 min-w-[160px]">Current Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => {
                    const no = (page - 1) * limit + idx + 1;
                    const showReason = r.fileListingStatus === "kiv" || r.fileListingStatus === "hold";
                    return (
                      <tr key={r.id} className="border-b last:border-b-0 hover:bg-slate-50">
                        <td className="py-3 pr-4 text-slate-500">{no}</td>
                        <td className="py-3 pr-4 font-medium">
                          <Link href={`/app/cases/${r.id}`}>
                            <span className="text-amber-700 hover:underline cursor-pointer">{r.referenceNo}</span>
                          </Link>
                        </td>
                        <td className="py-3 pr-4 align-top">{renderParties(r.clientParties)}</td>
                        <td className="py-3 pr-4">{r.purchasePrice != null ? formatCurrencyMYR(r.purchasePrice) : "—"}</td>
                        <td className="py-3 pr-4">
                          <Badge variant="outline" className="capitalize">{r.purchaseMode}</Badge>
                        </td>
                        <td className="py-3 pr-4">{r.loanBank ?? "—"}</td>
                        <td className="py-3 pr-4">{r.loanAmount != null ? formatCurrencyMYR(r.loanAmount) : "—"}</td>
                        <td className="py-3 pr-4 text-slate-700">{r.propertyInfo || "—"}</td>
                        <td className="py-3 pr-4">{r.lawyerInCharge ?? "—"}</td>
                        <td className="py-3 pr-4">{r.clerkInCharge ?? "—"}</td>
                        <td className="py-3 pr-4">
                          <div className="space-y-1">
                            {canUpdate ? (
                              <Select
                                value={r.fileListingStatus}
                                onValueChange={(v) => handleStatusChange(r.id, v as ListingStatus, r.fileListingReason)}
                                disabled={updateStatusMutation.isPending}
                              >
                                <SelectTrigger className="h-8 w-[150px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="new">new</SelectItem>
                                  <SelectItem value="ongoing">ongoing</SelectItem>
                                  <SelectItem value="closed">closed</SelectItem>
                                  <SelectItem value="kiv">KIV</SelectItem>
                                  <SelectItem value="hold">hold</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant={statusBadgeVariant(r.fileListingStatus)}>{statusLabel(r.fileListingStatus)}</Badge>
                            )}
                            {showReason ? (
                              <div className="text-xs text-slate-500 break-words">{r.fileListingReason || "—"}</div>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between pt-4">
            <div className="text-xs text-slate-500">
              {total ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total}` : "—"}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || listQuery.isFetching}>
                Prev
              </Button>
              <div className="text-xs text-slate-500">Page {page} / {totalPages}</div>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || listQuery.isFetching}>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={reasonOpen} onOpenChange={setReasonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set reason</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason (required for KIV/hold)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Pending client docs, Bank confirmation, On hold by instruction…" />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReasonOpen(false)} disabled={updateStatusMutation.isPending}>Cancel</Button>
            <Button
              onClick={() => {
                if (!pendingCaseId) return;
                const r = reason.trim();
                if (!r) return;
                updateStatusMutation.mutate({ caseId: pendingCaseId, status: pendingStatus, reason: r });
                setReasonOpen(false);
              }}
              disabled={updateStatusMutation.isPending || !reason.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

