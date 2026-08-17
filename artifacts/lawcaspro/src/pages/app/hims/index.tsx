import { useMemo, useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search,
  Shield,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Activity,
  AlertOctagon,
  CheckCheck,
  Clock3,
  Settings,
  UserCheck,
  ArrowRight,
  Eye,
} from "lucide-react";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { useEffectiveUserFeature } from "@/lib/feature-guards";
import { getErrorMessage, getDiscriminatedErrorTitle, getDiscriminatedErrorDetail, shouldShowRetryForError } from "@/lib/error-message";

export type HimsCaseRow = {
  caseId: number;
  caseReference: string | null;
  purchaser: string | null;
  project: string | null;
  phase: string | null;
  unitLotTitle: string | null;
  himsStatus: string | null;
  espaStatus: string | null;
  dataMatch: boolean | string | null;
  lastChecked: string | null;
};

export type HimsCasesList = {
  items: HimsCaseRow[];
  configurationStatus: "configured" | "no_connections" | "no_mappings" | "no_data";
};

const DEBOUNCE_MS = 250;
type FilterKey = "all" | "attention" | "mismatch" | "recent";

function statusBadgeClass(status: string | null): string {
  if (!status) return "bg-slate-100 text-slate-500";
  const s = String(status).toLowerCase();
  if (s.includes("error") || s.includes("fail") || s.includes("mismatch")) {
    return "bg-rose-50 text-rose-700 border border-rose-200";
  }
  if (
    s.includes("match") ||
    s.includes("stamped") ||
    s.includes("done") ||
    s.includes("complete")
  ) {
    return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  }
  if (
    s.includes("pending") ||
    s.includes("progress") ||
    s.includes("submitted")
  ) {
    return "bg-amber-50 text-amber-700 border border-amber-200";
  }
  return "bg-slate-100 text-slate-600";
}

function DataMatchCell({ value }: { value: boolean | string | null }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400 text-sm">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <CheckCircle2 className="w-4 h-4" />
        <span className="text-sm">Match</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-rose-700">
        <XCircle className="w-4 h-4" />
        <span className="text-sm">Mismatch</span>
      </span>
    );
  }
  const s = String(value);
  const low = s.toLowerCase();
  if (
    low === "true" ||
    low === "1" ||
    low === "yes" ||
    low === "match"
  ) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <CheckCircle2 className="w-4 h-4" />
        <span className="text-sm">{s}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-rose-700">
      <XCircle className="w-4 h-4" />
      <span className="text-sm">{s}</span>
    </span>
  );
}

function getErrorRequestId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const anyErr = error as {
    requestId?: unknown;
    data?: { meta?: { request_id?: unknown } };
  };
  if (typeof anyErr.requestId === "string" && anyErr.requestId.trim()) {
    return anyErr.requestId;
  }
  const nested = anyErr.data?.meta?.request_id;
  if (typeof nested === "string" && nested.trim()) return nested;
  return null;
}

function formatHimsErrorId(error: unknown): string {
  const rid = getErrorRequestId(error);
  if (rid) {
    const short = rid.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    if (short) return short;
  }
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `HIMS-${rand}`;
}

function fmtLastChecked(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = String(iso);
  if (s.length >= 16) return s.slice(0, 16).replace("T", " ");
  return s;
}

function isPartnerOrManager(roleName: string | null | undefined): boolean {
  const r = String(roleName ?? "").trim().toLowerCase();
  return (
    r === "partner" ||
    r.includes("partner") ||
    r === "founder" ||
    r.includes("manager")
  );
}

function needsAttention(row: HimsCaseRow): boolean {
  const matchRaw = row.dataMatch;
  let mismatch = false;
  if (typeof matchRaw === "boolean") mismatch = matchRaw === false;
  else if (typeof matchRaw === "string") {
    const low = matchRaw.toLowerCase();
    mismatch =
      low === "false" || low === "0" || low === "no" || low === "mismatch";
  }
  if (mismatch) return true;
  const himsLow = String(row.himsStatus ?? "").toLowerCase();
  const espaLow = String(row.espaStatus ?? "").toLowerCase();
  if (
    himsLow.includes("error") ||
    himsLow.includes("fail") ||
    espaLow.includes("error") ||
    espaLow.includes("fail")
  ) {
    return true;
  }
  return false;
}

function isMatched(row: HimsCaseRow): boolean {
  const v = row.dataMatch;
  if (typeof v === "boolean") return v === true;
  if (typeof v === "string") {
    const low = v.toLowerCase();
    return (
      low === "true" || low === "1" || low === "yes" || low === "match"
    );
  }
  return false;
}

function parseDay(s: string | null | undefined): string | null {
  if (!s) return null;
  return String(s).slice(0, 10);
}

export default function HimsTrackerIndexPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const roleName = String((user as any)?.roleName ?? "");
  const isPartnerRole = isPartnerOrManager(roleName);
  const canReadHimsCases = hasPermission(user, "cases", "read");
  const canStatusCheck = useEffectiveUserFeature("hims.status_check");

  const [search, setSearch] = useState<string>("");
  const debouncedSearch = useDebouncedValue(search, DEBOUNCE_MS);
  const [filter, setFilter] = useState<FilterKey>("all");
  const abortRef = useRef<AbortController | null>(null);

  const listQuery = useQuery<HimsCasesList>({
    queryKey: ["hims-cases-index", debouncedSearch],
    queryFn: async ({ signal }): Promise<HimsCasesList> => {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // noop
        }
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const params = new URLSearchParams();
      if (debouncedSearch && debouncedSearch.trim().length >= 2) {
        params.set("q", debouncedSearch.trim());
      }
      const url =
        "/hims/cases" +
        (params.toString() ? `?${params.toString()}` : "");
      const res = await apiFetchJson(url, {
        signal: signal ?? ctrl.signal,
      });
      const unwrapped = unwrapApiData<any>(res);
      const rawItems = Array.isArray(unwrapped?.items)
        ? unwrapped.items
        : Array.isArray(unwrapped)
          ? unwrapped
          : [];
      const items: HimsCaseRow[] = rawItems.map((r: any) => ({
        caseId: Number((r as any).caseId ?? (r as any).id ?? 0),
        caseReference:
          (r as any).caseReference ??
          (r as any).reference ??
          (r as any).refNo ??
          null,
        purchaser:
          (r as any).purchaser ??
          (r as any).purchaserName ??
          (r as any).client ??
          null,
        project: (r as any).project ?? (r as any).projectName ?? null,
        phase: (r as any).phase ?? (r as any).phaseName ?? null,
        unitLotTitle:
          (r as any).unitLotTitle ??
          (r as any).unit ??
          (r as any).lot ??
          (r as any).title ??
          null,
        himsStatus:
          (r as any).himsStatus ??
          (r as any).portalStatus ??
          (r as any).status ??
          null,
        espaStatus:
          (r as any).espaStatus ?? (r as any).spaStatus ?? null,
        dataMatch:
          typeof (r as any).dataMatch !== "undefined"
            ? (r as any).dataMatch
            : (r as any).matchStatus ?? null,
        lastChecked:
          (r as any).lastChecked ??
          (r as any).lastCheck ??
          (r as any).checkedAt ??
          null,
      }));
      const configStatus =
        (unwrapped as any)?.configurationStatus ??
        (items.length === 0 ? undefined : "configured");
      return {
        items,
        configurationStatus:
          configStatus ?? (items.length > 0 ? "configured" : "no_data"),
      };
    },
    staleTime: 30_000,
    retry: false,
    enabled: !!canReadHimsCases,
  });

  const items = listQuery.data?.items ?? [];
  const configStatus = listQuery.data?.configurationStatus ?? "no_data";

  const filteredItems = useMemo(() => {
    const today = parseDay(new Date().toISOString());
    return items.filter((r) => {
      if (filter === "all") return true;
      if (filter === "attention") return needsAttention(r);
      if (filter === "mismatch") {
        const v = r.dataMatch;
        if (typeof v === "boolean") return v === false;
        if (typeof v === "string") {
          const low = v.toLowerCase();
          return (
            low === "false" ||
            low === "0" ||
            low === "no" ||
            low === "mismatch"
          );
        }
        return false;
      }
      if (filter === "recent") {
        const d = parseDay(r.lastChecked);
        if (!d) return false;
        return d === today;
      }
      return true;
    });
  }, [items, filter]);

  const summary = useMemo(() => {
    let tracked = 0;
    let attention = 0;
    let matched = 0;
    let latestTs: string | null = null;
    for (const row of items) {
      if (row.lastChecked || row.himsStatus || row.espaStatus || row.dataMatch != null) {
        tracked += 1;
      }
      if (needsAttention(row)) attention += 1;
      if (isMatched(row)) matched += 1;
      if (row.lastChecked) {
        if (!latestTs || String(row.lastChecked) > latestTs) {
          latestTs = String(row.lastChecked);
        }
      }
    }
    return { tracked, attention, matched, latestTs };
  }, [items]);

  const integrationHref =
    "/app/settings?tab=integrations&integration=hims";

  return (
    <div className="space-y-4 p-4 md:p-6 min-h-[calc(100vh-80px)]">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Shield className="w-6 h-6 text-slate-600" />
            HIMS / eSPA Tracker
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            Read-only tracker status overview. Click any row to open the case
            HIMS tracker detail.
          </p>
          <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-50 border border-slate-200 text-[11px] text-slate-500">
            <Eye className="w-3.5 h-3.5" />
            Read-only tracker. Lawcaspro does NOT create or submit eSPA here.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void listQuery.refetch();
            }}
            disabled={listQuery.isFetching}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${listQuery.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {listQuery.isLoading ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="pt-4 pb-4 px-4">
                  <Skeleton className="h-3 w-20 mb-2" />
                  <Skeleton className="h-8 w-14" />
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader className="pb-3">
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent className="pt-0">
              <div className="py-16 text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto text-slate-400" />
                <div className="mt-3 text-sm text-slate-500">
                  Loading HIMS tracker…
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : listQuery.isError ? (
        <Card>
          <CardContent className="pt-8 pb-8 px-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <div className="font-semibold text-slate-900 text-base">
                    {getDiscriminatedErrorTitle(listQuery.error, "HIMS status")}
                  </div>
                  <p className="text-sm text-slate-500 mt-1">
                    {getDiscriminatedErrorDetail(listQuery.error, "HIMS status")}
                  </p>
                  <p className="text-xs text-slate-400 mt-2 break-words">
                    {getErrorMessage(listQuery.error)}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {shouldShowRetryForError(listQuery.error) ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        void listQuery.refetch();
                      }}
                      disabled={listQuery.isFetching}
                    >
                      Retry
                    </Button>
                  ) : null}
                  <div className="text-xs text-slate-500">
                    Error ID:{" "}
                    <code className="px-2 py-1 bg-slate-100 rounded font-mono">
                      {formatHimsErrorId(listQuery.error)}
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : configStatus === "no_connections" ? (
        <Card>
          <CardContent className="pt-12 pb-12 text-center">
            <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" />
            <div className="mt-3 text-sm font-medium text-slate-700">
              HIMS not configured
            </div>
            <div className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
              Configure developer portal credentials in Settings →
              Integrations → HIMS / eSPA.
            </div>
            <div className="mt-6">
              {isPartnerRole ? (
                <Button
                  size="sm"
                  onClick={() => setLocation(integrationHref)}
                >
                  <Settings className="w-4 h-4 mr-2" />
                  Configure HIMS
                </Button>
              ) : (
                <div className="text-xs text-slate-500">
                  Contact your Partner to configure HIMS.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : configStatus === "no_mappings" ? (
        <Card>
          <CardContent className="pt-12 pb-12 text-center">
            <AlertOctagon className="w-10 h-10 mx-auto text-amber-500" />
            <div className="mt-3 text-sm font-medium text-slate-700">
              {isPartnerRole
                ? "Projects are not mapped to HIMS yet."
                : "Project mapping has not been configured."}
            </div>
            <div className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
              Map your Projects and Phases to HIMS references in Settings →
              Integrations → HIMS / eSPA.
            </div>
            <div className="mt-6">
              {isPartnerRole ? (
                <Button
                  size="sm"
                  onClick={() => setLocation(integrationHref)}
                >
                  <Settings className="w-4 h-4 mr-2" />
                  Configure Project Mapping
                </Button>
              ) : (
                <div className="text-xs text-slate-500">
                  Contact your Partner.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="pt-12 pb-12 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center text-slate-400">
              <Shield className="w-6 h-6" />
            </div>
            <div className="mt-3 text-sm font-medium text-slate-700">
              No HIMS status checks yet
            </div>
            <div className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
              Cases will appear after their first tracker check.
            </div>
            {canStatusCheck.enabled ? (
              <div className="mt-6">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void listQuery.refetch();
                  }}
                  disabled={listQuery.isFetching}
                >
                  <Activity className="w-4 h-4 mr-2" />
                  Check Status
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="pt-4 pb-4 px-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                    <Shield className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-slate-500 truncate">
                      Tracked Cases
                    </div>
                    <div className="text-xl font-bold text-slate-900 leading-tight truncate">
                      {summary.tracked}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 px-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                    <AlertOctagon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-slate-500 truncate">
                      Needs Attention
                    </div>
                    <div className="text-xl font-bold text-slate-900 leading-tight truncate">
                      {summary.attention}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 px-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <CheckCheck className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-slate-500 truncate">
                      Matched
                    </div>
                    <div className="text-xl font-bold text-slate-900 leading-tight truncate">
                      {summary.matched}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 px-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
                    <Clock3 className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-slate-500 truncate">
                      Last Checked
                    </div>
                    <div className="text-sm font-semibold text-slate-900 leading-tight truncate">
                      {summary.latestTs ? fmtLastChecked(summary.latestTs) : "—"}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <CardTitle className="text-base">Tracker Cases</CardTitle>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5 text-xs">
                    {(
                      [
                        ["all", "All"],
                        ["attention", "Needs Attention"],
                        ["mismatch", "Mismatch"],
                        ["recent", "Recently Checked"],
                      ] as [FilterKey, string][]
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setFilter(k)}
                        className={`px-2.5 py-1 rounded transition-colors ${
                          filter === k
                            ? "bg-slate-900 text-white"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="relative w-full sm:w-80">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search reference, project, unit, purchaser… (min 2 chars)"
                      className="pl-9 h-9"
                    />
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {filteredItems.length === 0 ? (
                <div className="py-16 text-center">
                  <UserCheck className="w-10 h-10 mx-auto text-slate-300 opacity-60" />
                  <div className="mt-3 text-sm font-medium text-slate-600">
                    No cases match current filter
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Try clearing the filter or adjusting your search.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-3 text-left font-medium">
                          Case Reference
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          Purchaser
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          Project
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          Phase
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          Unit / Lot / Title
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          HIMS Status
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          eSPA Status
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          Data Match
                        </th>
                        <th className="px-3 py-3 text-left font-medium">
                          Last Checked
                        </th>
                        <th className="px-3 py-3 text-right font-medium w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((row, i) => (
                        <tr
                          key={`${row.caseId || 0}-${i}`}
                          className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                          onClick={() => {
                            if (row.caseId > 0) {
                              setLocation(
                                `/app/cases/${String(row.caseId)}?tab=hims-tracker`,
                              );
                            }
                          }}
                        >
                          <td className="py-2.5 px-3 font-medium text-slate-900">
                            {row.caseReference ?? (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-700">
                            {row.purchaser ?? (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-700">
                            {row.project ?? (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-700">
                            {row.phase ?? (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-700">
                            {row.unitLotTitle ?? (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            <Badge
                              variant="outline"
                              className={statusBadgeClass(row.himsStatus)}
                            >
                              {row.himsStatus ?? "—"}
                            </Badge>
                          </td>
                          <td className="py-2.5 px-3">
                            <Badge
                              variant="outline"
                              className={statusBadgeClass(row.espaStatus)}
                            >
                              {row.espaStatus ?? "—"}
                            </Badge>
                          </td>
                          <td className="py-2.5 px-3">
                            <DataMatchCell value={row.dataMatch} />
                          </td>
                          <td className="py-2.5 px-3 text-slate-500 text-xs">
                            {fmtLastChecked(row.lastChecked)}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <ArrowRight className="w-4 h-4 text-slate-400 ml-auto" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
