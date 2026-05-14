import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { QueryFallback } from "@/components/query-fallback";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetchJson } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { downloadFromApi } from "@/lib/download";
import { formatYmdToDmy, normalizeDateOnlyFromApi } from "@/components/date-only-input";

type DashboardResponse = {
  kpis: { spaSigned: number; loanApproved: number; handover: number };
  stageDistribution: Array<{ stage: string; count: number }>;
  stagnantCases: Array<{
    id: number;
    referenceNo: string;
    unitNo: string | null;
    projectName: string;
    purchaserName: string | null;
    spaStatus: string;
    loanStatus: string | null;
    updatedAt: string;
  }>;
};

type InventoryItem = {
  id: number;
  referenceNo: string;
  unitNo: string | null;
  purchaserNames?: string | null;
  purchaserName: string | null;
  projectName: string;
  spaStatus: string;
  loanStatus: string | null;
  updatedAt: string;
  lawyerStatus: string | null;
  lawyerStatusUpdatedAt: string | null;
  developerStatus: string | null;
  developerStatusUpdatedAt: string | null;
};

type InventoryResponse = { data: InventoryItem[]; total: number; page: number; limit: number };

type DevMessage = {
  id: string;
  senderType: "developer" | "staff";
  senderName: string;
  messageText: string;
  attachments: unknown;
  createdAt: string;
};

type CaseProgressResponse = {
  keyDates: Record<string, string | null>;
};

export default function DeveloperDashboardPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;
  const [activeCaseId, setActiveCaseId] = useState<number | null>(null);
  const [messageDraft, setMessageDraft] = useState("");

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("limit", String(limit));
    if (search.trim()) sp.set("search", search.trim());
    return sp.toString();
  }, [page, limit, search]);

  const dashboardQuery = useQuery<DashboardResponse>({
    queryKey: ["developer-dashboard"],
    queryFn: ({ signal }) => apiFetchJson("/developer/dashboard", { signal }),
    retry: false,
  });

  const invQuery = useQuery<InventoryResponse>({
    queryKey: ["developer-inventory", qs],
    queryFn: ({ signal }) => apiFetchJson(`/developer/inventory?${qs}`, { signal }),
    retry: false,
  });

  const progressQuery = useQuery<CaseProgressResponse>({
    queryKey: ["developer-case-progress", activeCaseId],
    queryFn: ({ signal }) => apiFetchJson(`/developer/cases/${activeCaseId}/progress`, { signal }),
    enabled: typeof activeCaseId === "number" && activeCaseId > 0,
    retry: false,
    staleTime: 30_000,
  });

  const messagesQuery = useQuery<{ data: DevMessage[] }>({
    queryKey: ["developer-case-messages", activeCaseId],
    queryFn: ({ signal }) => apiFetchJson(`/developer/cases/${activeCaseId}/messages?channel=developer`, { signal }),
    enabled: typeof activeCaseId === "number" && activeCaseId > 0,
    retry: false,
  });

  const sendMutation = useMutation<unknown, unknown, { caseId: number; messageText: string }>({
    mutationFn: async ({ caseId, messageText }) => {
      return await apiFetchJson(`/developer/cases/${caseId}/messages?channel=developer`, {
        method: "POST",
        body: JSON.stringify({ messageText, channel: "developer" }),
      });
    },
    onSuccess: async () => {
      setMessageDraft("");
      await queryClient.invalidateQueries({ queryKey: ["developer-case-messages", activeCaseId] });
    },
  });

  const isLoading = dashboardQuery.isLoading || invQuery.isLoading;
  if (isLoading) {
    return <div className="text-slate-500 py-12 text-center text-sm">Loading developer portal...</div>;
  }

  if (dashboardQuery.isError) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <QueryFallback title="Developer portal unavailable" error={dashboardQuery.error} onRetry={() => dashboardQuery.refetch()} />
        </div>
      </div>
    );
  }
  if (invQuery.isError) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <QueryFallback title="Inventory unavailable" error={invQuery.error} onRetry={() => invQuery.refetch()} />
        </div>
      </div>
    );
  }

  const kpis = dashboardQuery.data?.kpis ?? { spaSigned: 0, loanApproved: 0, handover: 0 };
  const items = Array.isArray(invQuery.data?.data) ? invQuery.data!.data : [];
  const totalUnits = Number(invQuery.data?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalUnits / limit));
  const activeItem = items.find((x) => x.id === activeCaseId) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Project Overview</h1>
        <p className="text-slate-500 mt-1 text-sm">Single-page developer portal</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Total Units" value={totalUnits} />
        <KpiCard label="SPA Signed" value={kpis.spaSigned} />
        <KpiCard label="Loan Approved" value={kpis.loanApproved} />
        <KpiCard label="Completed / Handed Over" value={kpis.handover} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle>Units</CardTitle>
            <Button
              variant="outline"
              onClick={async () => {
                const fileName = `developer_inventory_${new Date().toISOString().slice(0, 10)}.xlsx`;
                await downloadFromApi(`/developer/inventory/export.xlsx?${qs}`, fileName);
              }}
            >
              Export Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search unit / purchaser / reference..."
              className="w-full sm:w-96"
            />
            <div className="text-sm text-slate-500">Total: {totalUnits}</div>
          </div>

          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-left text-slate-600">
                  <th className="py-3 px-4 font-medium">Unit No</th>
                  <th className="py-3 px-4 font-medium">Purchaser</th>
                  <th className="py-3 px-4 font-medium">SPA Status</th>
                  <th className="py-3 px-4 font-medium">Loan Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr
                    key={c.id}
                    className={cn("border-b border-slate-100 cursor-pointer hover:bg-slate-50/60", activeCaseId === c.id && "bg-slate-50")}
                    onClick={() => {
                      setActiveCaseId(c.id);
                      setMessageDraft("");
                    }}
                  >
                    <td className="py-3 px-4 text-slate-900 font-medium">{c.unitNo ?? "—"}</td>
                    <td className="py-3 px-4 text-slate-900">{c.purchaserNames ?? c.purchaserName ?? "—"}</td>
                    <td className="py-3 px-4 text-slate-700">{c.spaStatus}</td>
                    <td className="py-3 px-4 text-slate-700">{c.loanStatus ?? "—"}</td>
                  </tr>
                ))}

                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500">No units found.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-sm text-slate-500">
              Page {page} / {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={typeof activeCaseId === "number" && activeCaseId > 0}
        onOpenChange={(open) => {
          if (!open) {
            setActiveCaseId(null);
            setMessageDraft("");
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Unit Details</DialogTitle>
          </DialogHeader>
          {activeItem ? (
            <UnitDetailsDialogContent
              item={activeItem}
              progressQuery={progressQuery}
              messagesQuery={messagesQuery}
              messageDraft={messageDraft}
              setMessageDraft={setMessageDraft}
              sendMutation={sendMutation}
            />
          ) : (
            <div className="text-sm text-slate-500">Loading...</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KpiCard(props: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="text-xs text-slate-500">{props.label}</div>
        <div className="text-3xl font-semibold text-slate-900 leading-tight">{Number(props.value ?? 0)}</div>
      </CardContent>
    </Card>
  );
}

function UnitDetailsDialogContent(props: {
  item: InventoryItem;
  progressQuery: UseQueryResult<CaseProgressResponse>;
  messagesQuery: UseQueryResult<{ data: DevMessage[] }>;
  messageDraft: string;
  setMessageDraft: (v: string) => void;
  sendMutation: UseMutationResult<unknown, unknown, { caseId: number; messageText: string }>;
}) {
  const { item, progressQuery, messagesQuery, messageDraft, setMessageDraft, sendMutation } = props;

  const keyDates = progressQuery.data?.keyDates ?? {};
  const getYmd = (k: string) => normalizeDateOnlyFromApi(keyDates[k]);
  const spaSigned = getYmd("spa_signed_date");
  const loa = getYmd("letter_of_offer_date");
  const bankLu = getYmd("bank_lu_received_date");
  const mot = getYmd("mot_stamped_date") || getYmd("mot_registered_date");
  const completion = getYmd("completion_date");

  const stage = completion ? "done" : mot ? "mot" : (bankLu || loa) ? "loan" : "spa";
  const stageOrder = ["spa", "loan", "mot", "done"] as const;
  const stageIndex = stageOrder.indexOf(stage as any);

  const messages = Array.isArray(messagesQuery.data?.data) ? messagesQuery.data!.data : [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs text-slate-500">Reference</div>
          <div className="text-sm font-medium text-slate-900 truncate">{item.referenceNo}</div>
          <div className="text-xs text-slate-500 mt-1 truncate">{item.projectName}</div>
        </div>
        <div className="text-xs text-slate-500">
          Last updated: {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : "—"}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-600">Key Dates</div>
          <div className="flex items-center gap-2">
            {(["SPA", "Loan", "MOT", "Done"] as const).map((label, idx) => (
              <div key={label} className="flex items-center gap-2 min-w-0">
                <div className={cn("h-2.5 w-2.5 rounded-full", idx <= stageIndex ? "bg-slate-900" : "bg-slate-300")} />
                <div className={cn("text-xs", idx <= stageIndex ? "text-slate-900 font-medium" : "text-slate-500")}>{label}</div>
                {idx < 3 ? <div className="h-px w-6 bg-slate-200" /> : null}
              </div>
            ))}
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-3">
            {progressQuery.isLoading ? (
              <div className="text-sm text-slate-500">Loading key dates...</div>
            ) : progressQuery.isError ? (
              <div className="text-sm text-red-600">Failed to load key dates.</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <KeyDate label="SPA Signed" ymd={spaSigned} />
                <KeyDate label="LO Date" ymd={loa} />
                <KeyDate label="MOT" ymd={mot} />
                <KeyDate label="Completion" ymd={completion} />
                <KeyDate label="SPA Date" ymd={getYmd("spa_date")} />
                <KeyDate label="SPA Stamped" ymd={getYmd("spa_stamped_date")} />
                <KeyDate label="LO Stamped" ymd={getYmd("letter_of_offer_stamped_date")} />
                <KeyDate label="Bank LU Received" ymd={getYmd("bank_lu_received_date")} />
                <KeyDate label="MOT Signed" ymd={getYmd("mot_signed_date")} />
                <KeyDate label="MOT Registered" ymd={getYmd("mot_registered_date")} />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-600">Developer Chat</div>
          <div className="rounded-md border border-slate-200 bg-white">
            <div className="max-h-[360px] overflow-auto p-3 space-y-2">
              {messagesQuery.isLoading ? (
                <div className="text-sm text-slate-500">Loading messages...</div>
              ) : messagesQuery.isError ? (
                <div className="text-sm text-red-600">Failed to load messages.</div>
              ) : messages.length === 0 ? (
                <div className="text-sm text-slate-600">No messages yet.</div>
              ) : (
                messages.map((m) => {
                  const isMine = m.senderType === "developer";
                  return (
                    <div key={m.id} className={cn("flex", isMine ? "justify-end" : "justify-start")}>
                      <div className={cn("max-w-[85%] rounded-2xl px-3 py-2", isMine ? "bg-slate-900 text-white" : "bg-white text-slate-900 border border-slate-200")}>
                        <div className={cn("text-[11px]", isMine ? "text-slate-200" : "text-slate-500")}>
                          {isMine ? "You" : (m.senderName || "Staff")}
                        </div>
                        <div className="text-sm whitespace-pre-wrap break-words">{m.messageText}</div>
                        <div className={cn("mt-1 text-[10px]", isMine ? "text-slate-300" : "text-slate-400")}>
                          {m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="border-t border-slate-200 p-3 space-y-2">
              <Textarea
                value={messageDraft}
                onChange={(e) => setMessageDraft(e.target.value)}
                placeholder="Write a message to the law firm..."
                className="min-h-[90px]"
              />
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">{Math.min(2000, messageDraft.length)}/2000</div>
                <Button
                  onClick={() => {
                    const t = messageDraft.trim();
                    if (!t) return;
                    if (t.length > 2000) return;
                    sendMutation.mutate({ caseId: item.id, messageText: t });
                  }}
                  disabled={sendMutation.isPending || !messageDraft.trim()}
                >
                  Send
                </Button>
              </div>
              {sendMutation.isError ? (
                <div className="text-xs text-red-600">Failed to send. Please try again.</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyDate(props: { label: string; ymd: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-500">{props.label}</div>
      <div className={cn("text-sm font-medium", props.ymd ? "text-slate-900" : "text-slate-500")}>
        {props.ymd ? formatYmdToDmy(props.ymd) : "Missing"}
      </div>
    </div>
  );
}
