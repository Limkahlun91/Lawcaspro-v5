import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { QueryFallback } from "@/components/query-fallback";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { apiFetchJson } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { downloadFromApi } from "@/lib/download";
import { formatYmdToDmy, normalizeDateOnlyFromApi } from "@/components/date-only-input";

type DevPortalStatus =
  | "Completed"
  | "In Progress"
  | "Pending"
  | "Not Yet Required"
  | "Attention Required";

type StageFilter = "all" | "spa" | "spa_stamped" | "loan" | "attention" | "completed";

type NextAction = {
  label: string;
  waitingFor: string;
  since: string | null;
  ageDays: number;
  attentionRequired: boolean;
};

type PurchaserDto = { displayName: string };

type UnitListDto = {
  caseId: number;
  referenceNo: string | null;
  projectName: string | null;
  phase: string | null;
  unitLabel: string;
  propertySummary: string | null;
  purchasers: PurchaserDto[];
  spa: { status: DevPortalStatus; label: string; date: string | null };
  loan: { status: DevPortalStatus; label: string; bankName: string | null; date: string | null };
  mot: { status: DevPortalStatus; label: string; date: string | null };
  currentStage: string;
  nextAction: NextAction | null;
  lastUpdatedAt: string | null;
};

type TimelineEntry = {
  key: string;
  label: string;
  date: string | null;
  state: "done" | "active" | "pending" | "not_required";
};

type ActivityDto = { dateLabel: string; label: string };

type UnitDetailDto = UnitListDto & {
  property: {
    address: string | null;
    addressLines: string[];
    titleType: string | null;
    titleNo: string | null;
    lotNo: string | null;
    hakmilikNo: string | null;
  };
  purchasePrice: string | null;
  endFinancier: string | null;
  responsibleLawyer: string | null;
  assignedClerk: string | null;
  fileOpenedAt: string | null;
  lastActivity: string | null;
  spaLoanTimeline: TimelineEntry[];
  motTimeline: TimelineEntry[];
  recentActivity: ActivityDto[];
  currentAction: NextAction | null;
};

type AttentionItem = {
  caseId: number;
  unitLabel: string;
  referenceNo: string | null;
  label: string;
  waitingFor: string;
  since: string | null;
  ageDays: number;
};

type OverviewResponse = {
  project: { name: string | null; phase: string | null; developerName: string | null; lastUpdatedAt: string };
  summary: {
    totalUnits: number;
    spaInProgress: number;
    spaStamped: number;
    loanInProgress: number;
    needsAttention: number;
    completedHandover: number;
  };
  attentionSummary: { total: number; items: AttentionItem[] };
  progress: {
    spa: { progressing: number };
    loan: { progressing: number };
    mot: { progressing: number };
    completed: { progressing: number };
    total: number;
  };
};

type UnitsResponse = {
  data: UnitListDto[];
  total: number;
  totalMatchingScope: number;
  page: number;
  limit: number;
};

type DevMessage = {
  id: string;
  senderType: "developer" | "staff";
  senderName: string;
  messageText: string;
  attachments: unknown;
  createdAt: string;
};

const LIMIT = 50;

function badgeClassForStatus(s: DevPortalStatus): string {
  switch (s) {
    case "Completed":
      return "bg-emerald-50 text-emerald-700 border border-emerald-200";
    case "In Progress":
      return "bg-sky-50 text-sky-700 border border-sky-200";
    case "Pending":
      return "bg-amber-50 text-amber-700 border border-amber-200";
    case "Attention Required":
      return "bg-rose-50 text-rose-700 border border-rose-200";
    case "Not Yet Required":
    default:
      return "bg-slate-50 text-slate-500 border border-slate-200";
  }
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ym = normalizeDateOnlyFromApi(iso);
  return ym ? formatYmdToDmy(ym) : "—";
}

function purchasersDisplay(list: PurchaserDto[] | undefined, max = 4): string {
  if (!list || list.length === 0) return "—";
  const names = list.map((p) => p.displayName).filter(Boolean);
  if (names.length <= max) return names.join(", ");
  return names.slice(0, max).join(", ") + ` +${names.length - max}`;
}

export default function DeveloperDashboardPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [stage, setStage] = useState<StageFilter>("all");
  const [activeCaseId, setActiveCaseId] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [messageDraft, setMessageDraft] = useState("");

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("limit", String(LIMIT));
    if (search.trim()) sp.set("search", search.trim());
    if (stage !== "all") sp.set("stage", stage);
    if (stage === "attention") sp.set("attention", "1");
    return sp.toString();
  }, [page, search, stage]);

  const overviewQuery = useQuery<OverviewResponse>({
    queryKey: ["developer-portal-overview"],
    queryFn: ({ signal }) => apiFetchJson("/developer/portal/overview", { signal }),
    retry: false,
    staleTime: 30_000,
  });

  const invQuery = useQuery<UnitsResponse>({
    queryKey: ["developer-portal-units", qs],
    queryFn: ({ signal }) => apiFetchJson(`/developer/portal/units?${qs}`, { signal }),
    retry: false,
    staleTime: 20_000,
  });

  const detailQuery = useQuery<{ data: UnitDetailDto }>({
    queryKey: ["developer-portal-unit", activeCaseId],
    queryFn: ({ signal }) => apiFetchJson(`/developer/portal/units/${activeCaseId}`, { signal }),
    enabled: typeof activeCaseId === "number" && activeCaseId > 0 && sheetOpen,
    retry: false,
    staleTime: 30_000,
  });

  const messagesQuery = useQuery<{ data: DevMessage[] }>({
    queryKey: ["developer-case-messages", activeCaseId],
    queryFn: ({ signal }) => apiFetchJson(`/developer/cases/${activeCaseId}/messages?channel=developer`, { signal }),
    enabled: typeof activeCaseId === "number" && activeCaseId > 0 && sheetOpen,
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

  const setCardFilter = (next: StageFilter) => {
    setStage((prev) => (prev === next ? "all" : next));
    setPage(1);
  };

  const openUnit = (caseId: number) => {
    setActiveCaseId(caseId);
    setSheetOpen(true);
    setMessageDraft("");
  };

  const isLoading = overviewQuery.isLoading || invQuery.isLoading;

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-500 text-sm">
        Loading developer portal...
      </div>
    );
  }

  if (overviewQuery.isError) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <QueryFallback
            title="Developer portal unavailable"
            error={overviewQuery.error}
            onRetry={() => overviewQuery.refetch()}
          />
        </div>
      </div>
    );
  }
  if (invQuery.isError) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <QueryFallback
            title="Units unavailable"
            error={invQuery.error}
            onRetry={() => invQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  const overview = overviewQuery.data;
  const items = Array.isArray(invQuery.data?.data) ? invQuery.data!.data : [];
  const totalUnits = Number(invQuery.data?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalUnits / LIMIT));
  const activeListItem = items.find((x) => x.caseId === activeCaseId) ?? null;

  return (
    <div className="min-h-screen bg-slate-50/60">
      <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <Header overview={overview} />

        <SummaryCards summary={overview.summary} activeStage={stage} onPick={setCardFilter} />

        <ProgressStrip progress={overview.progress} />

        <AttentionPanel
          attention={overview.attentionSummary}
          onOpenUnit={openUnit}
        />

        <Card className="rounded-xl border border-slate-200/80 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <CardTitle className="text-base sm:text-lg">Units</CardTitle>
                <p className="text-sm text-slate-500 mt-1">
                  Showing {Math.min(LIMIT, items.length)} of {totalUnits} units
                </p>
              </div>
              <Button
                variant="outline"
                onClick={async () => {
                  const fileName = `developer_portal_units_${new Date().toISOString().slice(0, 10)}.xlsx`;
                  await downloadFromApi(`/developer/portal/export.xlsx?${qs}`, fileName);
                }}
              >
                Export Excel
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search unit, purchaser, case reference..."
                  className="w-full sm:w-96 bg-white"
                />
                <StageFilters active={stage} onChange={(n) => { setStage(n); setPage(1); }} />
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-slate-600">
                    <th className="py-3 px-4 font-medium whitespace-nowrap">Unit / Parcel</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">Purchaser</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">Case Reference</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">SPA</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">Loan</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">MOT / Title</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">Current Stage</th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">Last Updated</th>
                    <th className="py-3 px-2 font-medium w-10" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => (
                    <tr
                      key={u.caseId}
                      onClick={() => openUnit(u.caseId)}
                      className={cn(
                        "border-b border-slate-100 cursor-pointer hover:bg-slate-50/80",
                        activeCaseId === u.caseId && "bg-slate-50"
                      )}
                    >
                      <td className="py-3 px-4">
                        <div className="text-slate-900 font-medium leading-tight">{u.unitLabel}</div>
                        {u.propertySummary ? (
                          <div className="text-xs text-slate-500 mt-1 truncate max-w-[220px]">{u.propertySummary}</div>
                        ) : null}
                      </td>
                      <td className="py-3 px-4 text-slate-800 max-w-[240px]">{purchasersDisplay(u.purchasers)}</td>
                      <td className="py-3 px-4 text-slate-800 font-mono text-xs">{u.referenceNo ?? "—"}</td>
                      <td className="py-3 px-4">
                        <StatusCell label={u.spa.label} status={u.spa.status} date={u.spa.date} />
                      </td>
                      <td className="py-3 px-4">
                        <StatusCell
                          label={u.loan.label}
                          status={u.loan.status}
                          date={u.loan.date}
                          sub={u.loan.bankName ?? undefined}
                        />
                      </td>
                      <td className="py-3 px-4">
                        <StatusCell label={u.mot.label} status={u.mot.status} date={u.mot.date} />
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-800 leading-tight whitespace-nowrap">{u.currentStage}</div>
                        {u.nextAction?.label ? (
                          <div className={cn(
                            "text-xs mt-1 whitespace-nowrap",
                            u.nextAction.attentionRequired ? "text-rose-600" : "text-slate-500"
                          )}>
                            Next: {u.nextAction.label}
                            {u.nextAction.waitingFor ? ` · ${u.nextAction.waitingFor}` : ""}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-3 px-4 text-slate-600 whitespace-nowrap">{formatDateTime(u.lastUpdatedAt)}</td>
                      <td className="py-3 px-2 text-slate-400 text-right">›</td>
                    </tr>
                  ))}

                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-10 text-center text-slate-500">
                        No units found. Clear filters or search again.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm text-slate-500">
                Page {page} / {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Sheet open={sheetOpen} onOpenChange={(open) => {
          if (!open) {
            setSheetOpen(false);
            setActiveCaseId(null);
            setMessageDraft("");
          }
        }}>
          <SheetContent className="w-[92vw] sm:max-w-[780px] p-0 gap-0 rounded-none">
            <UnitDrawer
              listItem={activeListItem}
              detailQuery={detailQuery}
              messagesQuery={messagesQuery}
              messageDraft={messageDraft}
              setMessageDraft={setMessageDraft}
              sendMutation={sendMutation}
            />
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

function Header(props: { overview: OverviewResponse }) {
  const { project } = props.overview;
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-2xl sm:text-3xl font-semibold text-slate-900 tracking-tight">
            {project.name ?? "Project Overview"}
          </h1>
          <Badge variant="outline" className="text-[11px] bg-white text-slate-600 border-slate-200 px-2 py-0.5 h-6">
            Live from Lawcaspro
          </Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
          {project.developerName ? <span>{project.developerName}</span> : null}
          {project.phase ? <span className="inline-flex items-center">· <span className="ml-3">{project.phase}</span></span> : null}
          <span className="inline-flex items-center">· <span className="ml-3">Last updated {formatDateTime(project.lastUpdatedAt)}</span></span>
        </div>
      </div>
    </div>
  );
}

const CARD_STAGE: Array<{ key: StageFilter; label: (s: OverviewResponse["summary"]) => string; value: (s: OverviewResponse["summary"]) => number; tone: string }> = [
  { key: "all", label: () => "Total Units", value: (s) => s.totalUnits, tone: "border-slate-200 text-slate-900" },
  { key: "spa", label: () => "SPA In Progress", value: (s) => s.spaInProgress, tone: "border-sky-200 text-sky-700" },
  { key: "spa_stamped", label: () => "SPA Stamped", value: (s) => s.spaStamped, tone: "border-emerald-200 text-emerald-700" },
  { key: "loan", label: () => "Loan In Progress", value: (s) => s.loanInProgress, tone: "border-indigo-200 text-indigo-700" },
  { key: "attention", label: () => "Needs Attention", value: (s) => s.needsAttention, tone: "border-rose-200 text-rose-700" },
  { key: "completed", label: () => "Completed / Handover", value: (s) => s.completedHandover, tone: "border-teal-200 text-teal-700" },
];

function SummaryCards(props: {
  summary: OverviewResponse["summary"];
  activeStage: StageFilter;
  onPick: (n: StageFilter) => void;
}) {
  const { summary, activeStage, onPick } = props;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {CARD_STAGE.map((c) => {
        const active = activeStage === c.key;
        const val = c.value(summary);
        return (
          <button
            type="button"
            key={c.key}
            onClick={() => onPick(c.key)}
            className={cn(
              "text-left rounded-xl bg-white border shadow-sm p-3 sm:p-4 transition",
              "hover:shadow-md hover:-translate-y-0.5",
              active ? "ring-2 ring-slate-900/90 border-slate-300" : "border-slate-200/80"
            )}
          >
            <div className="text-xs text-slate-500 leading-tight">{c.label(summary)}</div>
            <div className={cn("mt-1 text-2xl font-semibold tracking-tight", c.tone)}>
              {Number(val ?? 0)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ProgressStrip(props: { progress: OverviewResponse["progress"] }) {
  const { progress } = props;
  const total = progress.total || 0;
  const stages: Array<{ key: string; label: string; count: number }> = [
    { key: "spa", label: "SPA", count: progress.spa.progressing },
    { key: "loan", label: "Loan", count: progress.loan.progressing },
    { key: "mot", label: "MOT / Title", count: progress.mot.progressing },
    { key: "done", label: "Completed", count: progress.completed.progressing },
  ];
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white shadow-sm p-4 sm:p-5">
      <div className="grid grid-cols-4 gap-2 sm:gap-4 items-stretch">
        {stages.map((s, idx) => {
          const pct = total > 0 ? Math.min(100, Math.max(0, (s.count / total) * 100)) : 0;
          const isLast = idx === stages.length - 1;
          return (
            <div key={s.key} className="min-w-0 relative">
              <div className="flex items-center gap-2">
                <div className="text-[11px] font-medium text-slate-600">{s.label}</div>
                {!isLast ? <div className="flex-1 h-px bg-slate-200 min-w-[4px]" /> : null}
              </div>
              <div className="mt-2 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full",
                    s.key === "spa" && "bg-sky-500",
                    s.key === "loan" && "bg-indigo-500",
                    s.key === "mot" && "bg-violet-500",
                    s.key === "done" && "bg-emerald-500"
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-slate-500">
                <span className="font-semibold text-slate-800">{s.count}</span>
                <span className="mx-1">/</span>
                <span>{total} progressing</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AttentionPanel(props: {
  attention: { total: number; items: AttentionItem[] };
  onOpenUnit: (caseId: number) => void;
}) {
  const { attention, onOpenUnit } = props;
  if (!attention.total || attention.total === 0) return null;
  const preview = attention.items.slice(0, 2);
  const remain = Math.max(0, attention.total - preview.length);
  return (
    <div className="rounded-xl border border-rose-200/80 bg-rose-50/40 shadow-sm p-4">
      <div className="flex items-center gap-2 text-rose-700">
        <span aria-hidden>⚠</span>
        <div className="font-semibold tracking-tight">
          {attention.total} Unit{attention.total === 1 ? "" : "s"} Need Attention
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        {preview.map((a) => (
          <button
            type="button"
            key={`${a.caseId}-${a.label}`}
            onClick={() => onOpenUnit(a.caseId)}
            className="text-left rounded-xl bg-white border border-rose-200/70 p-3 hover:shadow-md transition"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="font-semibold text-slate-900 text-sm">
                {a.unitLabel}
                {a.referenceNo ? <span className="ml-2 text-xs text-slate-500 font-normal">({a.referenceNo})</span> : null}
              </div>
              <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[11px]">
                {a.ageDays}d
              </Badge>
            </div>
            <div className="mt-2 text-sm text-slate-700 leading-snug">{a.label}</div>
            <div className="mt-1 text-xs text-slate-500">
              Waiting for {a.waitingFor}
              {a.since ? ` · since ${formatDateOnly(a.since)}` : ""}
            </div>
          </button>
        ))}
      </div>
      {remain > 0 ? (
        <div className="mt-3 text-xs text-rose-700">[View all]</div>
      ) : null}
    </div>
  );
}

function StageFilters(props: { active: StageFilter; onChange: (n: StageFilter) => void }) {
  const { active, onChange } = props;
  const chips: Array<{ key: StageFilter; label: string }> = [
    { key: "all", label: "All Status" },
    { key: "spa", label: "SPA" },
    { key: "loan", label: "Loan" },
    { key: "attention", label: "Needs Attention" },
    { key: "completed", label: "Completed" },
  ];
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {chips.map((c) => {
        const on = active === c.key;
        return (
          <button
            type="button"
            key={c.key}
            onClick={() => onChange(c.key)}
            className={cn(
              "text-xs px-3 py-1.5 rounded-full border transition",
              on
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:text-slate-800"
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function StatusCell(props: { label: string; status: DevPortalStatus; date: string | null; sub?: string }) {
  const { label, status, date, sub } = props;
  return (
    <div className="leading-tight min-w-[140px]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium", badgeClassForStatus(status))}>
          {label}
        </span>
      </div>
      <div className="text-xs text-slate-500 mt-1">{formatDateOnly(date)}</div>
      {sub ? <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div> : null}
    </div>
  );
}

function UnitDrawer(props: {
  listItem: UnitListDto | null;
  detailQuery: UseQueryResult<{ data: UnitDetailDto }>;
  messagesQuery: UseQueryResult<{ data: DevMessage[] }>;
  messageDraft: string;
  setMessageDraft: (v: string) => void;
  sendMutation: UseMutationResult<unknown, unknown, { caseId: number; messageText: string }>;
}) {
  const { listItem, detailQuery, messagesQuery, messageDraft, setMessageDraft, sendMutation } = props;
  const d = detailQuery.data?.data ?? null;
  const combined: UnitDetailDto | null =
    d ?? (listItem as UnitDetailDto | null);

  if (!combined) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm p-8">
        {detailQuery.isLoading ? "Loading unit details..." : "No unit selected."}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <SheetHeader className="px-6 pt-6 pb-4 border-b border-slate-200">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 pr-6">
            <SheetTitle className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
              {combined.unitLabel}
              {combined.referenceNo ? (
                <span className="ml-3 text-xs font-mono text-slate-500 font-normal">({combined.referenceNo})</span>
              ) : null}
            </SheetTitle>
            <SheetDescription asChild>
              <div className="mt-2 space-y-1 text-sm">
                <div className="text-slate-700">{purchasersDisplay(combined.purchasers, 6)}</div>
                <div className="flex items-center gap-x-3 text-slate-500 flex-wrap">
                  <span>Case Reference: <span className="font-mono text-slate-700">{combined.referenceNo ?? "—"}</span></span>
                  <span>·</span>
                  <span>Current Stage: <span className="text-slate-700 font-medium">{combined.currentStage}</span></span>
                </div>
              </div>
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <Tabs defaultValue="overview" className="w-full">
          <div className="px-4 sm:px-6 pt-3 sticky top-0 bg-white z-10 border-b border-slate-100">
            <TabsList className="w-full sm:w-auto grid grid-cols-4 bg-slate-100 p-1">
              <TabsTrigger value="overview" className="text-xs sm:text-sm py-1.5">Overview</TabsTrigger>
              <TabsTrigger value="spa-loan" className="text-xs sm:text-sm py-1.5">SPA &amp; Loan</TabsTrigger>
              <TabsTrigger value="title" className="text-xs sm:text-sm py-1.5">Title / MOT</TabsTrigger>
              <TabsTrigger value="communication" className="text-xs sm:text-sm py-1.5">Communication</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="px-4 sm:px-6 py-5 space-y-6">
            <OverviewSection detail={d ?? null} fallback={combined} />
            <RecentActivitySection list={d?.recentActivity ?? null} fallback={combined} />
          </TabsContent>

          <TabsContent value="spa-loan" className="px-4 sm:px-6 py-5 space-y-5">
            <CurrentActionSection action={d?.currentAction ?? combined.nextAction} />
            <TimelineSection entries={d?.spaLoanTimeline ?? fallbackTimelineFromUnit(combined)} title="SPA & Loan" />
          </TabsContent>

          <TabsContent value="title" className="px-4 sm:px-6 py-5">
            <TitleMotSection detail={d ?? null} fallback={combined} />
          </TabsContent>

          <TabsContent value="communication" className="px-4 sm:px-6 py-5">
            <CommunicationSection
              caseId={combined.caseId}
              messagesQuery={messagesQuery}
              messageDraft={messageDraft}
              setMessageDraft={setMessageDraft}
              sendMutation={sendMutation}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function fallbackTimelineFromUnit(u: UnitListDto): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const done = (k: string, label: string, date: string | null) => out.push({ key: k, label, date, state: "done" });
  const active = (k: string, label: string, date: string | null) => out.push({ key: k, label, date, state: "active" });
  if (u.spa.status === "Completed") done("spa", u.spa.label, u.spa.date);
  else if (u.spa.status === "In Progress" || u.spa.status === "Attention Required") active("spa", u.spa.label, u.spa.date);
  if (u.loan.status === "Completed") done("loan", u.loan.label, u.loan.date);
  else if (u.loan.status === "In Progress" || u.loan.status === "Attention Required") active("loan", u.loan.label, u.loan.date);
  if (u.mot.status === "Completed") done("mot", u.mot.label, u.mot.date);
  return out;
}

function OverviewSection(props: { detail: UnitDetailDto | null; fallback: UnitDetailDto }) {
  const d = props.detail ?? props.fallback;
  const rows: Array<[string, string]> = [];
  rows.push(["Project", d.projectName ?? "—"]);
  rows.push(["Phase", d.phase ?? "—"]);
  rows.push(["Unit / Parcel", d.unitLabel]);
  const propAddr = d.property?.address ?? d.propertySummary ?? null;
  rows.push(["Property", propAddr ?? "—"]);
  rows.push(["Case Reference", d.referenceNo ?? "—"]);
  rows.push(["Purchaser", purchasersDisplay(d.purchasers, 10)]);
  if (d.purchasePrice) rows.push(["Purchase Price", d.purchasePrice]);
  rows.push(["End Financier", d.endFinancier ?? "—"]);
  rows.push(["Responsible Lawyer", d.responsibleLawyer ?? "—"]);
  rows.push(["Assigned Clerk", d.assignedClerk ?? "—"]);
  rows.push(["File Opened", formatDateOnly(d.fileOpenedAt ?? d.createdAt as any)]);
  rows.push(["Last Activity", formatDateTime(d.lastActivity ?? d.lastUpdatedAt)]);
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Overview</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-slate-400">{k}</div>
            <div className="text-sm text-slate-800 mt-1 whitespace-pre-wrap break-words">{v || "—"}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecentActivitySection(props: { list: ActivityDto[] | null; fallback: UnitDetailDto }) {
  const list = props.list ?? [];
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Recent Activity</h3>
      {list.length === 0 ? (
        <div className="text-sm text-slate-500">No recent activity recorded yet.</div>
      ) : (
        <ul className="space-y-2">
          {list.slice(0, 5).map((a, i) => (
            <li key={`${a.dateLabel}-${i}-${a.label}`} className="flex items-start gap-3 text-sm">
              <div className="min-w-[64px] text-xs text-slate-500 mt-0.5">{a.dateLabel}</div>
              <div className="text-slate-800">{a.label}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CurrentActionSection(props: { action: NextAction | null }) {
  const a = props.action;
  if (!a) return null;
  const attention = !!a.attentionRequired;
  return (
    <section className={cn(
      "rounded-xl border p-4",
      attention ? "border-rose-200 bg-rose-50/40" : "border-sky-200 bg-sky-50/40"
    )}>
      <div className={cn("text-xs font-semibold uppercase tracking-wider", attention ? "text-rose-700" : "text-sky-700")}>
        Current Action
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Waiting for</div>
          <div className="text-sm text-slate-800 mt-1">{a.waitingFor || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Action</div>
          <div className="text-sm font-medium text-slate-900 mt-1">{a.label}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Since</div>
          <div className="text-sm text-slate-800 mt-1">{formatDateOnly(a.since)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-400">Age</div>
          <div className={cn("text-sm mt-1", attention ? "text-rose-700 font-semibold" : "text-slate-800")}>
            {a.ageDays} day{a.ageDays === 1 ? "" : "s"}
          </div>
        </div>
      </div>
    </section>
  );
}

function TimelineSection(props: { entries: TimelineEntry[]; title: string }) {
  const entries = props.entries;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">{props.title}</h3>
      {entries.length === 0 ? (
        <div className="text-sm text-slate-500">No milestones yet.</div>
      ) : (
        <ol className="relative border-l border-slate-200 ml-2 space-y-4">
          {entries.map((e, idx) => (
            <li key={`${e.key}-${idx}`} className="ml-5">
              <span
                className={cn(
                  "absolute -left-[7px] mt-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border",
                  e.state === "done" && "bg-emerald-500 border-emerald-500",
                  e.state === "active" && "bg-sky-500 border-sky-500",
                  e.state === "pending" && "bg-white border-slate-300",
                  e.state === "not_required" && "bg-white border-slate-200 border-dashed"
                )}
              />
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className={cn(
                  "text-sm font-medium",
                  e.state === "not_required" ? "text-slate-400" : "text-slate-800"
                )}>
                  {e.label}
                </div>
                <div className="text-xs text-slate-500">{formatDateOnly(e.date)}</div>
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {e.state === "done" && "Completed"}
                {e.state === "active" && "In Progress"}
                {e.state === "pending" && "Pending"}
                {e.state === "not_required" && "Not Yet Required"}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TitleMotSection(props: { detail: UnitDetailDto | null; fallback: UnitDetailDto }) {
  const d = props.detail ?? props.fallback;
  const mot = d.mot;
  const timeline = props.detail?.motTimeline ?? null;
  const notYet = mot.status === "Not Yet Required" && !timeline?.some((t) => t.state !== "not_required");
  return (
    <section className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Title / MOT</h3>
        {notYet ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            Title / MOT — Not Yet Required.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {[
              ["Title Type", d.property?.titleType ?? "—"],
              ["Title No.", d.property?.titleNo ?? "—"],
              ["Lot No.", d.property?.lotNo ?? "—"],
              ["MOT Received", props.detail?.motTimeline?.find?.((t) => t.key === "mot_received")?.date ?? "—"],
              ["MOT Signed", props.detail?.motTimeline?.find?.((t) => t.key === "mot_signed")?.date ?? "—"],
              ["MOT Stamped", props.detail?.motTimeline?.find?.((t) => t.key === "mot_stamped")?.date ?? "—"],
              ["MOT Registered", props.detail?.motTimeline?.find?.((t) => t.key === "mot_registered")?.date ?? "—"],
              ["Completion / Handover", props.detail?.motTimeline?.find?.((t) => t.key === "completion")?.date ?? "—"],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">{k}</div>
                <div className="text-sm text-slate-800 mt-1">{formatDateOrText(v as string)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {timeline ? <TimelineSection entries={timeline} title="Title / MOT Timeline" /> : null}
    </section>
  );
}

function formatDateOrText(v: string): string {
  if (!v || v === "—") return "—";
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return formatDateOnly(v);
  return v;
}

function CommunicationSection(props: {
  caseId: number;
  messagesQuery: UseQueryResult<{ data: DevMessage[] }>;
  messageDraft: string;
  setMessageDraft: (v: string) => void;
  sendMutation: UseMutationResult<unknown, unknown, { caseId: number; messageText: string }>;
}) {
  const { caseId, messagesQuery, messageDraft, setMessageDraft, sendMutation } = props;
  const messages = Array.isArray(messagesQuery.data?.data) ? messagesQuery.data!.data : [];
  return (
    <div className="rounded-xl border border-slate-200 bg-white flex flex-col">
      <div className="max-h-[420px] overflow-y-auto p-4 space-y-3">
        {messagesQuery.isLoading ? (
          <div className="text-sm text-slate-500">Loading messages...</div>
        ) : messagesQuery.isError ? (
          <div className="text-sm text-rose-600">Failed to load messages.</div>
        ) : messages.length === 0 ? (
          <div className="text-sm text-slate-600">No messages yet. Send a note to the law firm below.</div>
        ) : (
          messages.map((m) => {
            const mine = m.senderType === "developer";
            return (
              <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 border",
                  mine
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-900 border-slate-200"
                )}>
                  <div className={cn("text-[11px]", mine ? "text-slate-200" : "text-slate-500")}>
                    {mine ? "You" : m.senderName || "Law Firm"}
                  </div>
                  <div className="text-sm whitespace-pre-wrap break-words">{m.messageText}</div>
                  <div className={cn("mt-1 text-[10px]", mine ? "text-slate-300" : "text-slate-400")}>
                    {formatDateTime(m.createdAt)}
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
          className="min-h-[96px] resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-500">
            {Math.min(2000, messageDraft.length)}/2000
          </div>
          <Button
            disabled={sendMutation.isPending || !messageDraft.trim()}
            onClick={() => {
              const t = messageDraft.trim();
              if (!t || t.length > 2000) return;
              sendMutation.mutate({ caseId, messageText: t });
            }}
          >
            Send
          </Button>
        </div>
        {sendMutation.isError ? (
          <div className="text-xs text-rose-600">Failed to send. Please try again.</div>
        ) : null}
      </div>
    </div>
  );
}
