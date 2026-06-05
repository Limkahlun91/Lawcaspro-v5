import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetchJson } from "@/lib/api-client";
import { Copy, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";

type CaseSearchItem = {
  id: number;
  referenceNo: string;
  status: string;
  assignedLawyerName?: string | null;
  assignedClerkName?: string | null;
  clientName?: string | null;
  projectName?: string | null;
  developerName?: string | null;
  property?: string | null;
};

type CaseListResponse = {
  data: CaseSearchItem[];
  total: number;
  page: number;
  limit: number;
};

type VariableItem = {
  id: number;
  key: string;
  token: string;
  label: string;
  description: string | null;
  category: string;
  valueType: string;
  sourcePath: string | null;
  formatter: string | null;
  exampleValue: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  previewValue: unknown;
};

type LoopItem = {
  key: string;
  label: string;
  startToken: string;
  endToken: string;
  template: string;
  innerVariables: Array<{ key: string; token: string }>;
  preview: string | null;
};

type VariablesPreviewResponse = {
  variables: VariableItem[];
  loops: LoopItem[];
};

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

function formatPreviewValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.trim() ? v : "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    const flat = v
      .map((x) => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : ""))
      .filter(Boolean);
    if (flat.length) return flat.join(", ");
    return v.length ? JSON.stringify(v) : "—";
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function groupKeyFor(v: VariableItem): string {
  const k = String(v.key ?? "");
  if (k.startsWith("firm_")) return "firm";
  if (k.endsWith("_date") || k.includes("date_") || k.includes("_date_")) return "date";
  return String(v.category ?? "general") || "general";
}

export default function VariableDictionaryPage() {
  const { toast } = useToast();
  const [caseQueryRaw, setCaseQueryRaw] = useState("");
  const caseQuery = useMemo(() => caseQueryRaw.trim(), [caseQueryRaw]);
  const [caseResults, setCaseResults] = useState<CaseSearchItem[]>([]);
  const [caseSearching, setCaseSearching] = useState(false);
  const [selectedCase, setSelectedCase] = useState<CaseSearchItem | null>(null);
  const [varQueryRaw, setVarQueryRaw] = useState("");
  const varQuery = useMemo(() => norm(varQueryRaw), [varQueryRaw]);
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const lastAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = caseQuery;
    if (!q) {
      setCaseResults([]);
      setCaseSearching(false);
      return;
    }
    const t = setTimeout(async () => {
      lastAbortRef.current?.abort();
      const controller = new AbortController();
      lastAbortRef.current = controller;
      setCaseSearching(true);
      try {
        const res = await apiFetchJson<CaseListResponse>(`/cases?search=${encodeURIComponent(q)}&page=1&limit=10`, { signal: controller.signal });
        setCaseResults(Array.isArray(res.data) ? res.data : []);
      } catch {
        setCaseResults([]);
      } finally {
        if (!controller.signal.aborted) setCaseSearching(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [caseQuery]);

  const previewQuery = useQuery<VariablesPreviewResponse>({
    queryKey: ["documents", "variables-preview", selectedCase?.id ?? null],
    enabled: typeof selectedCase?.id === "number" && selectedCase.id > 0,
    queryFn: async () => {
      const caseId = selectedCase!.id;
      return await apiFetchJson<VariablesPreviewResponse>(`/documents/variables?caseId=${caseId}&includeLoops=1`);
    },
    retry: false,
  });

  const variables = Array.isArray(previewQuery.data?.variables) ? previewQuery.data!.variables : [];
  const loops = Array.isArray(previewQuery.data?.loops) ? previewQuery.data!.loops : [];

  const groupOptions = useMemo(() => {
    const s = new Set<string>(["all"]);
    for (const v of variables) s.add(groupKeyFor(v));
    if (loops.length) s.add("dynamic_loops");
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [variables, loops]);

  const filteredVariables = useMemo(() => {
    return variables.filter((v) => {
      const g = groupKeyFor(v);
      if (groupFilter !== "all" && groupFilter !== g) return false;
      if (!varQuery) return true;
      const pv = formatPreviewValue(v.previewValue);
      const hay = `${norm(g)} ${norm(v.label)} ${norm(v.key)} ${norm(v.token)} ${norm(pv)} ${norm(v.sourcePath)}`;
      return hay.includes(varQuery);
    });
  }, [variables, varQuery, groupFilter]);

  const filteredLoops = useMemo(() => {
    if (!loops.length) return [];
    if (groupFilter !== "all" && groupFilter !== "dynamic_loops") return [];
    return loops.filter((l) => {
      if (!varQuery) return true;
      const hay = `${norm(l.label)} ${norm(l.key)} ${norm(l.template)} ${norm(l.preview)}`;
      return hay.includes(varQuery);
    });
  }, [loops, varQuery, groupFilter]);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied" });
    } catch (e) {
      toastError(toast, e, "Copy failed");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Variable Dictionary</h1>
        <p className="text-slate-500">Select a case to preview actual values.</p>
      </div>

      <Card className="border-slate-200">
        <CardContent className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
            <div className="md:col-span-2 space-y-2">
              <div className="text-xs text-slate-500">Case</div>
              <div className="relative">
                <Input
                  value={caseQueryRaw}
                  onChange={(e) => setCaseQueryRaw(e.target.value)}
                  placeholder="Search by ref / purchaser / project / property / parcel…"
                />
                <div className="absolute right-2 top-2 text-slate-400">
                  <Search className="w-4 h-4" />
                </div>
              </div>
              {selectedCase ? (
                <div className="text-sm text-slate-700">
                  Selected: <span className="font-semibold">{selectedCase.referenceNo || `Case #${selectedCase.id}`}</span>
                  <Button variant="ghost" size="sm" className="ml-2" onClick={() => setSelectedCase(null)}>
                    Change
                  </Button>
                </div>
              ) : null}
              {!selectedCase && (caseQuery || caseSearching) ? (
                <div className="rounded-md border border-slate-200 bg-white overflow-hidden">
                  <div className="max-h-64 overflow-auto divide-y divide-slate-100">
                    {caseSearching ? (
                      <div className="px-3 py-2 text-sm text-slate-500">Searching…</div>
                    ) : caseResults.length ? (
                      caseResults.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="w-full text-left px-3 py-2 hover:bg-slate-50"
                          onClick={() => {
                            setSelectedCase(c);
                            setCaseQueryRaw("");
                            setCaseResults([]);
                          }}
                        >
                          <div className="text-sm font-semibold text-slate-900">{c.referenceNo || `Case #${c.id}`}</div>
                          <div className="text-xs text-slate-500 truncate">
                            {c.clientName ? `Client: ${c.clientName}` : "Client: —"}
                            <span className="text-slate-300"> · </span>
                            {c.projectName ? `Project: ${c.projectName}` : "Project: —"}
                            <span className="text-slate-300"> · </span>
                            {c.property ? `Parcel: ${c.property}` : "Parcel: —"}
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-sm text-slate-500">{caseQuery ? "No results." : "Type to search."}</div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-500">Filter</div>
              <Select value={groupFilter} onValueChange={setGroupFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Group" />
                </SelectTrigger>
                <SelectContent>
                  {groupOptions.map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input value={varQueryRaw} onChange={(e) => setVarQueryRaw(e.target.value)} placeholder="Search variables…" />
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedCase ? (
        <Card className="border-slate-200">
          <CardContent className="p-0">
            {previewQuery.isLoading ? (
              <div className="p-8 text-center text-slate-500">Loading variables…</div>
            ) : previewQuery.isError ? (
              <div className="p-6 text-sm text-slate-700">
                Variables unavailable.
                <Button className="ml-2" size="sm" variant="outline" onClick={() => previewQuery.refetch()} disabled={previewQuery.isFetching}>
                  Retry
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 font-semibold">Group</th>
                      <th className="px-6 py-3 font-semibold">Variable Name</th>
                      <th className="px-6 py-3 font-semibold">Token</th>
                      <th className="px-6 py-3 font-semibold">Preview Value</th>
                      <th className="px-6 py-3 font-semibold">Source</th>
                      <th className="px-6 py-3 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredVariables.map((v) => (
                      <tr key={v.key} className="hover:bg-slate-50/50">
                        <td className="px-6 py-4 text-slate-700">{groupKeyFor(v)}</td>
                        <td className="px-6 py-4 text-slate-900 font-medium">{v.label || v.key}</td>
                        <td className="px-6 py-4 font-mono text-xs text-slate-700">{v.token}</td>
                        <td className="px-6 py-4 text-slate-700 whitespace-pre-wrap">{formatPreviewValue(v.previewValue)}</td>
                        <td className="px-6 py-4 text-xs text-slate-500">{v.sourcePath || v.key}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={() => copyText(v.token)} aria-label="Copy token">
                              <Copy className="w-4 h-4" />
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => copyText(formatPreviewValue(v.previewValue) === "—" ? "" : formatPreviewValue(v.previewValue))} aria-label="Copy value">
                              Copy Value
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredVariables.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-6 py-8 text-center text-slate-500">No variables.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-slate-200">
          <CardContent className="p-8 text-center text-slate-500">Select a case to preview variables.</CardContent>
        </Card>
      )}

      {selectedCase && filteredLoops.length ? (
        <Card className="border-slate-200">
          <CardContent className="p-0">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="font-semibold text-slate-900">Dynamic Loops</div>
              <div className="text-xs text-slate-500">Loop blocks and preview output for the selected case.</div>
            </div>
            <div className="divide-y divide-slate-100">
              {filteredLoops.map((l) => (
                <div key={l.key} className="p-6 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">{l.label}</div>
                      <div className="text-xs text-slate-500 font-mono">{l.startToken} … {l.endToken}</div>
                      <div className="text-xs text-slate-500">
                        Inner variables: {l.innerVariables.map((x) => x.token).join(", ")}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => copyText(l.template)}>
                      Copy Loop Block
                    </Button>
                  </div>
                  <div className="rounded-md border border-slate-200 bg-slate-50 overflow-hidden">
                    <pre className="p-3 text-[12px] leading-5 font-mono text-slate-700 whitespace-pre-wrap overflow-x-auto">
                      <code>{l.template}</code>
                    </pre>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Preview Output</div>
                    <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700 whitespace-pre-wrap">
                      {l.preview ? l.preview : "—"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

