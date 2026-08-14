import { useMemo, useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Shield, Loader2, AlertTriangle, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { QueryFallback } from "@/components/query-fallback";

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

function statusBadgeClass(status: string | null): string {
  if (!status) return "bg-slate-100 text-slate-500";
  const s = String(status).toLowerCase();
  if (s.includes("error") || s.includes("fail") || s.includes("mismatch")) return "bg-rose-50 text-rose-700 border border-rose-200";
  if (s.includes("match") || s.includes("stamped") || s.includes("done") || s.includes("complete")) return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (s.includes("pending") || s.includes("progress") || s.includes("submitted")) return "bg-amber-50 text-amber-700 border border-amber-200";
  return "bg-slate-100 text-slate-600";
}

function DataMatchCell({ value }: { value: boolean | string | null }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400 text-sm">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? (
      <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-4 h-4" /><span className="text-sm">Match</span></span>
    ) : (
      <span className="inline-flex items-center gap-1 text-rose-700"><XCircle className="w-4 h-4" /><span className="text-sm">Mismatch</span></span>
    );
  }
  const s = String(value);
  const low = s.toLowerCase();
  if (low === "true" || low === "1" || low === "yes" || low === "match") return <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-4 h-4" /><span className="text-sm">{s}</span></span>;
  return <span className="inline-flex items-center gap-1 text-rose-700"><XCircle className="w-4 h-4" /><span className="text-sm">{s}</span></span>;
}

function ErrorIdBox(err: unknown): { id: string } {
  try {
    const code = (err as any)?.code ?? (err as any)?.errorCode ?? (err as any)?.status ?? "UNKNOWN";
    const rawStamp = (err as any)?.requestId ?? Number(Date.now() & 0xffffff).toString(16);
    const stamp = String(rawStamp).replace(/[^A-Za-z0-9]/g, "").toUpperCase().padStart(6, "0").slice(0, 8);
    return { id: `HIMS-${String(code).toUpperCase()}-${stamp}` };
  } catch {
    return { id: "HIMS-ERR-000000" };
  }
}

function fmtLastChecked(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = String(iso);
  if (s.length >= 16) return s.slice(0, 16).replace("T", " ");
  return s;
}

export default function HimsTrackerIndexPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const canWriteHims = hasPermission(user, "cases", "read");

  const [search, setSearch] = useState<string>("");
  const debouncedSearch = useDebouncedValue(search, DEBOUNCE_MS);
  const abortRef = useRef<AbortController | null>(null);

  const listQuery = useQuery<HimsCasesList>({
    queryKey: ["hims-cases-index", debouncedSearch],
    queryFn: async ({ signal }): Promise<HimsCasesList> => {
      if (abortRef.current) try { abortRef.current.abort(); } catch {}
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const params = new URLSearchParams();
      if (debouncedSearch && debouncedSearch.trim().length >= 2) params.set("q", debouncedSearch.trim());
      const url = "/hims/cases" + (params.toString() ? `?${params.toString()}` : "");
      try {
        const res = await apiFetchJson(url, { signal: signal ?? ctrl.signal });
        const unwrapped = unwrapApiData<any>(res);
        const rawItems = Array.isArray(unwrapped?.items) ? unwrapped.items : (Array.isArray(unwrapped) ? unwrapped : []);
        const items: HimsCaseRow[] = rawItems.map((r: any) => ({
          caseId: Number((r as any).caseId ?? (r as any).id ?? 0),
          caseReference: (r as any).caseReference ?? (r as any).reference ?? (r as any).refNo ?? null,
          purchaser: (r as any).purchaser ?? (r as any).purchaserName ?? (r as any).client ?? null,
          project: (r as any).project ?? (r as any).projectName ?? null,
          phase: (r as any).phase ?? (r as any).phaseName ?? null,
          unitLotTitle: (r as any).unitLotTitle ?? (r as any).unit ?? (r as any).lot ?? (r as any).title ?? null,
          himsStatus: (r as any).himsStatus ?? (r as any).portalStatus ?? (r as any).status ?? null,
          espaStatus: (r as any).espaStatus ?? (r as any).spaStatus ?? null,
          dataMatch: typeof (r as any).dataMatch !== "undefined" ? (r as any).dataMatch : (r as any).matchStatus ?? null,
          lastChecked: (r as any).lastChecked ?? (r as any).lastCheck ?? (r as any).checkedAt ?? null,
        }));
        const configStatus = (unwrapped as any)?.configurationStatus ?? (items.length === 0 ? undefined : "configured");
        return { items, configurationStatus: configStatus ?? (items.length > 0 ? "configured" : "no_data") };
      } catch (err: any) {
        throw err;
      }
    },
    staleTime: 30_000,
    retry: false,
    enabled: !!canWriteHims,
  });

  const items = listQuery.data?.items ?? [];
  const configStatus = listQuery.data?.configurationStatus ?? "no_data";

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Shield className="w-6 h-6 text-slate-600" />
            HIMS / eSPA Tracker
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            Read-only tracker status overview. Click any row to open the case HIMS tracker detail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void listQuery.refetch(); }}
            disabled={listQuery.isFetching}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${listQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <CardTitle className="text-base">Tracker Cases</CardTitle>
            <div className="relative w-full md:w-80">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reference, project, unit, purchaser… (min 2 chars)"
                className="pl-9 h-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {listQuery.isLoading ? (
            <div className="py-16 text-center">
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-slate-400" />
              <div className="mt-3 text-sm text-slate-500">Loading HIMS tracker…</div>
            </div>
          ) : listQuery.isError ? (
            <div className="py-8">
              <QueryFallback
                title="Unable to load HIMS status"
                error={Object.assign(new Error("Tracker endpoint returned an error."), {
                  cause: listQuery.error,
                })}
                onRetry={() => void listQuery.refetch()}
                isRetrying={listQuery.isFetching}
              />
              <div className="mt-3 text-xs text-slate-500 text-center">
                Error ID: <code className="px-2 py-1 bg-slate-100 rounded font-mono">{ErrorIdBox(listQuery.error).id}</code>
              </div>
            </div>
          ) : configStatus === "no_connections" ? (
            <div className="py-16 text-center">
              <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" />
              <div className="mt-3 text-sm font-medium text-slate-700">HIMS not configured</div>
              <div className="mt-1 text-xs text-slate-500">
                Configure developer portal credentials in Settings → Integrations → HIMS / eSPA.
              </div>
            </div>
          ) : configStatus === "no_mappings" ? (
            <div className="py-16 text-center">
              <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" />
              <div className="mt-3 text-sm font-medium text-slate-700">No project / phase mappings</div>
              <div className="mt-1 text-xs text-slate-500">
                Map your Projects and Phases to HIMS references in Settings → Integrations → HIMS / eSPA.
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center">
              <div className="text-slate-300 mx-auto w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center">
                <Shield className="w-6 h-6 text-slate-400" />
              </div>
              <div className="mt-3 text-sm font-medium text-slate-700">No tracker data yet</div>
              <div className="mt-1 text-xs text-slate-500">
                Cases linked with HIMS projects will appear here once the first status check runs.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">Case Reference</th>
                    <th className="px-3 py-3 text-left font-medium">Purchaser</th>
                    <th className="px-3 py-3 text-left font-medium">Project</th>
                    <th className="px-3 py-3 text-left font-medium">Phase</th>
                    <th className="px-3 py-3 text-left font-medium">Unit / Lot / Title</th>
                    <th className="px-3 py-3 text-left font-medium">HIMS Status</th>
                    <th className="px-3 py-3 text-left font-medium">eSPA Status</th>
                    <th className="px-3 py-3 text-left font-medium">Data Match</th>
                    <th className="px-3 py-3 text-left font-medium">Last Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, i) => (
                  <tr
                    key={`${row.caseId || 0}-${i}`}
                    className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => {
                      if (row.caseId > 0) setLocation(`/app/cases/${String(row.caseId)}?tab=hims-tracker`);
                    }}
                  >
                    <td className="py-2.5 px-3 font-medium text-slate-900">
                      {row.caseReference ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">
                      {row.purchaser ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">
                      {row.project ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">
                      {row.phase ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">
                      {row.unitLotTitle ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 px-3">
                      <Badge variant="outline" className={statusBadgeClass(row.himsStatus)}>
                        {row.himsStatus ?? "—"}
                      </Badge>
                    </td>
                    <td className="py-2.5 px-3">
                      <Badge variant="outline" className={statusBadgeClass(row.espaStatus)}>
                        {row.espaStatus ?? "—"}
                      </Badge>
                    </td>
                    <td className="py-2.5 px-3">
                      <DataMatchCell value={row.dataMatch} />
                    </td>
                    <td className="py-2.5 px-3 text-slate-500 text-xs">
                      {fmtLastChecked(row.lastChecked)}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
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
