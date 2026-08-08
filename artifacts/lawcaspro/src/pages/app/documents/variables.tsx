import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetchJson } from "@/lib/api-client";
import { ChevronDown, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import CustomVariablesPage from "./custom-variables";

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
  groupKey?: string | null;
  valueType: string;
  sourcePath: string | null;
  formatter: string | null;
  exampleValue: string | null;
  isSystem: boolean;
  isActive: boolean;
  isHidden?: boolean;
  isPublished?: boolean;
  deprecatedAt?: string | null;
  replacementKey?: string | null;
  sortOrder: number;
  previewValue: unknown;
  custom?: {
    scope: "founder_master" | "firm" | "template_specific";
    status: "active" | "disabled" | "deprecated";
    currentVersionNo: number;
  };
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

function isAbortError(e: unknown): boolean {
  const n = typeof (e as any)?.name === "string" ? String((e as any).name) : "";
  return n === "AbortError";
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
  const g = typeof v.groupKey === "string" ? v.groupKey.trim() : "";
  if (g) return g;
  const k = String(v.key ?? "");
  if (k.startsWith("firm_")) return "firm";
  if (k.endsWith("_date") || k.includes("date_") || k.includes("_date_")) return "date";
  return String(v.category ?? "general") || "general";
}

function sourceFor(v: VariableItem): string {
  if (v.isSystem) return "System";
  const scope = v.custom?.scope;
  if (scope === "template_specific") return "Template";
  if (scope === "firm") return "Firm";
  if (scope === "founder_master") return "Founder";
  return "Founder";
}

function deprecatedWarning(v: VariableItem): string | null {
  if (!v.deprecatedAt) return null;
  return "Deprecated — still supported for old templates, not recommended for new templates.";
}

export default function VariableDictionaryPage() {
  const { toast } = useToast();
  const [caseQueryRaw, setCaseQueryRaw] = useState("");
  const caseQuery = useMemo(() => caseQueryRaw.trim(), [caseQueryRaw]);
  const [caseResults, setCaseResults] = useState<CaseSearchItem[]>([]);
  const [caseSearching, setCaseSearching] = useState(false);
  const [caseSearchError, setCaseSearchError] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<CaseSearchItem | null>(null);
  const [caseOpen, setCaseOpen] = useState(false);
  const [varQueryRaw, setVarQueryRaw] = useState("");
  const varQuery = useMemo(() => norm(varQueryRaw), [varQueryRaw]);
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const lastAbortRef = useRef<AbortController | null>(null);
  const lastGoodByCaseIdRef = useRef<Map<number, VariablesPreviewResponse>>(new Map());

  useEffect(() => {
    if (!caseOpen) {
      lastAbortRef.current?.abort();
      setCaseResults([]);
      setCaseSearching(false);
      setCaseSearchError(null);
      return;
    }
    const q = caseQuery;
    if (!q) {
      setCaseResults([]);
      setCaseSearching(false);
      setCaseSearchError(null);
      return;
    }
    const t = setTimeout(async () => {
      lastAbortRef.current?.abort();
      const controller = new AbortController();
      lastAbortRef.current = controller;
      setCaseSearching(true);
      setCaseSearchError(null);
      try {
        const res = await apiFetchJson<CaseListResponse>(`/cases?search=${encodeURIComponent(q)}&page=1&limit=10`, { signal: controller.signal });
        setCaseResults(Array.isArray(res.data) ? res.data : []);
      } catch (e) {
        if (isAbortError(e) || controller.signal.aborted) return;
        setCaseSearchError("Failed to load cases.");
      } finally {
        if (!controller.signal.aborted) setCaseSearching(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [caseQuery, caseOpen]);

  const previewQuery = useQuery<VariablesPreviewResponse>({
    queryKey: ["documents", "variables-preview", selectedCase?.id ?? null],
    enabled: typeof selectedCase?.id === "number" && selectedCase.id > 0,
    queryFn: async ({ signal }) => {
      const caseId = selectedCase!.id;
      return await apiFetchJson<VariablesPreviewResponse>(`/documents/variables?caseId=${caseId}&includeLoops=1`, { signal });
    },
    retry: false,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    const id = selectedCase?.id;
    if (!id || id <= 0) return;
    const d = previewQuery.data;
    if (!d) return;
    if (!Array.isArray(d.variables) || !Array.isArray(d.loops)) return;
    lastGoodByCaseIdRef.current.set(id, d);
  }, [previewQuery.data, selectedCase?.id]);

  const cachedPreview = selectedCase?.id ? (lastGoodByCaseIdRef.current.get(selectedCase.id) ?? null) : null;
  const previewData = previewQuery.data ?? cachedPreview;
  const variables = Array.isArray(previewData?.variables) ? previewData!.variables : [];
  const loops = Array.isArray(previewData?.loops) ? previewData!.loops : [];
  const previewIsAbortError = isAbortError(previewQuery.error);
  const showPreviewWarning = previewQuery.isError && !previewIsAbortError && !!previewData;

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
      const hay = `${norm(g)} ${norm(v.label)} ${norm(v.key)} ${norm(v.token)} ${norm(pv)} ${norm(sourceFor(v))}`;
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
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Variables</h1>
        <p className="text-slate-500">Browse system variables or manage custom firm-level dictionaries.</p>
      </div>

      <Tabs defaultValue="system" className="space-y-6">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="system">System Variables</TabsTrigger>
          <TabsTrigger value="custom">Custom Variables</TabsTrigger>
        </TabsList>

        <TabsContent value="system" className="space-y-6 mt-0">
          <VariableDictionaryCore />
        </TabsContent>

        <TabsContent value="custom" className="mt-0">
          <CustomVariablesPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VariableDictionaryCore() {
  const { toast } = useToast();
  const [caseQueryRaw, setCaseQueryRaw] = useState("");
  const caseQuery = useMemo(() => caseQueryRaw.trim(), [caseQueryRaw]);
  const [caseResults, setCaseResults] = useState<CaseSearchItem[]>([]);
  const [caseSearching, setCaseSearching] = useState(false);
  const [caseSearchError, setCaseSearchError] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<CaseSearchItem | null>(null);
  const [caseOpen, setCaseOpen] = useState(false);
  const [varQueryRaw, setVarQueryRaw] = useState("");
  const varQuery = useMemo(() => norm(varQueryRaw), [varQueryRaw]);
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const lastAbortRef = useRef<AbortController | null>(null);
  const lastGoodByCaseIdRef = useRef<Map<number, VariablesPreviewResponse>>(new Map());

  useEffect(() => {
    if (!caseOpen) {
      lastAbortRef.current?.abort();
      setCaseResults([]);
      setCaseSearching(false);
      setCaseSearchError(null);
      return;
    }
    const q = caseQuery;
    if (!q) {
      setCaseResults([]);
      setCaseSearching(false);
      setCaseSearchError(null);
      return;
    }
    const t = setTimeout(async () => {
      lastAbortRef.current?.abort();
      const controller = new AbortController();
      lastAbortRef.current = controller;
      setCaseSearching(true);
      setCaseSearchError(null);
      try {
        const res = await apiFetchJson<CaseListResponse>(`/cases?search=${encodeURIComponent(q)}&page=1&limit=10`, { signal: controller.signal });
        setCaseResults(Array.isArray(res.data) ? res.data : []);
      } catch (e) {
        if (isAbortError(e) || controller.signal.aborted) return;
        setCaseSearchError("Failed to load cases.");
      } finally {
        if (!controller.signal.aborted) setCaseSearching(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [caseQuery, caseOpen]);

  const previewQuery = useQuery<VariablesPreviewResponse>({
    queryKey: ["documents", "variables-preview", selectedCase?.id ?? null],
    enabled: typeof selectedCase?.id === "number" && selectedCase.id > 0,
    queryFn: async ({ signal }) => {
      const caseId = selectedCase!.id;
      return await apiFetchJson<VariablesPreviewResponse>(`/documents/variables?caseId=${caseId}&includeLoops=1`, { signal });
    },
    retry: false,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    const id = selectedCase?.id;
    if (!id || id <= 0) return;
    const d = previewQuery.data;
    if (!d) return;
    if (!Array.isArray(d.variables) || !Array.isArray(d.loops)) return;
    lastGoodByCaseIdRef.current.set(id, d);
  }, [previewQuery.data, selectedCase?.id]);

  const cachedPreview = selectedCase?.id ? (lastGoodByCaseIdRef.current.get(selectedCase.id) ?? null) : null;
  const previewData = previewQuery.data ?? cachedPreview;
  const variables = Array.isArray(previewData?.variables) ? previewData!.variables : [];
  const loops = Array.isArray(previewData?.loops) ? previewData!.loops : [];
  const previewIsAbortError = isAbortError(previewQuery.error);
  const showPreviewWarning = previewQuery.isError && !previewIsAbortError && !!previewData;

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
      const hay = `${norm(g)} ${norm(v.label)} ${norm(v.key)} ${norm(v.token)} ${norm(pv)} ${norm(sourceFor(v))}`;
      return hay.includes(varQuery);
    });
  }, [variables, varQuery, groupFilter]);

  const filteredLoops = useMemo(() => {
    if (!loops.length) return [];
    if (groupFilter !== "all" && groupFilter !== "dynamic_loops") return [];
    if (!varQuery) return loops;
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
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-slate-900 tracking-tight">Variable Dictionary</h2>
        <p className="text-sm text-slate-500">Select a case to preview actual values.</p>
      </div>

      <Card className="border-slate-200">
        <CardContent className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
            <div className="md:col-span-2 space-y-2">
              <div className="text-xs text-slate-500">Case</div>
              <Popover
                open={caseOpen}
                onOpenChange={(open) => {
                  setCaseOpen(open);
                  if (open) setCaseQueryRaw("");
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={caseOpen}
                    className="w-full justify-between"
                  >
                    <span className="truncate">
                      {selectedCase ? (selectedCase.referenceNo || `Case #${selectedCase.id}`) : "Select a case…"}
                    </span>
                    <ChevronDown className="w-4 h-4 text-slate-500" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="p-0 w-[520px] max-w-[calc(100vw-2rem)]">
                  <Command>
                    <CommandInput
                      value={caseQueryRaw}
                      onValueChange={setCaseQueryRaw}
                      placeholder="Search by ref / purchaser / project / property / parcel…"
                    />
                    <CommandList>
                      <CommandEmpty>
                        <div className="text-sm text-slate-500">
                          {caseSearchError ? caseSearchError : (caseSearching ? "Searching…" : (caseQuery ? "No results." : "Type to search."))}
                        </div>
                      </CommandEmpty>
                      <CommandGroup heading="Cases">
                        {caseResults.map((c) => (
                          <CommandItem
                            key={c.id}
                            value={`${c.referenceNo ?? ""} ${c.clientName ?? ""} ${c.projectName ?? ""} ${c.property ?? ""}`}
                            onSelect={() => {
                              setSelectedCase(c);
                              setCaseOpen(false);
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-900 truncate">{c.referenceNo || `Case #${c.id}`}</div>
                              <div className="text-xs text-slate-500 truncate">
                                {c.clientName ? `Client: ${c.clientName}` : "Client: —"}
                                <span className="text-slate-300"> · </span>
                                {c.projectName ? `Project: ${c.projectName}` : "Project: —"}
                                <span className="text-slate-300"> · </span>
                                {c.property ? `Parcel: ${c.property}` : "Parcel: —"}
                              </div>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {selectedCase ? (
                <div className="text-sm text-slate-700">
                  Selected: <span className="font-semibold">{selectedCase.referenceNo || `Case #${selectedCase.id}`}</span>
                  <Button variant="ghost" size="sm" className="ml-2" onClick={() => setSelectedCase(null)}>
                    Clear
                  </Button>
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
            {(previewQuery.isLoading && !previewData) ? (
              <div className="p-8 text-center text-slate-500">Loading variables…</div>
            ) : (previewQuery.isError && !previewIsAbortError && !previewData) ? (
              <div className="p-6 text-sm text-slate-700">
                Variables unavailable.
                <Button className="ml-2" size="sm" variant="outline" onClick={() => previewQuery.refetch()} disabled={previewQuery.isFetching}>
                  Retry
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                {showPreviewWarning ? (
                  <div className="px-4 py-3 border-b border-slate-200 bg-amber-50 flex items-center justify-between gap-3">
                    <div className="text-sm text-amber-900">
                      Failed to refresh variables. Showing cached results.
                    </div>
                    <Button size="sm" variant="outline" onClick={() => previewQuery.refetch()} disabled={previewQuery.isFetching}>
                      Retry
                    </Button>
                  </div>
                ) : null}
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 font-semibold">Group / Section</th>
                      <th className="px-6 py-3 font-semibold">Display Name</th>
                      <th className="px-6 py-3 font-semibold">Token</th>
                      <th className="px-6 py-3 font-semibold">Actual Value</th>
                      <th className="px-6 py-3 font-semibold">Source Level</th>
                      <th className="px-6 py-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredVariables.map((v) => (
                      <tr key={v.key} className="hover:bg-slate-50/50">
                        <td className="px-6 py-4 text-slate-700">{groupKeyFor(v)}</td>
                        <td className="px-6 py-4">
                          <div className="text-slate-900 font-medium">{v.label || v.key}</div>
                          {deprecatedWarning(v) ? (
                            <div className="text-xs text-amber-700 mt-1">{deprecatedWarning(v)}</div>
                          ) : null}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-slate-700">{v.token}</td>
                        <td className="px-6 py-4 text-slate-700 whitespace-pre-wrap">{formatPreviewValue(v.previewValue)}</td>
                        <td className="px-6 py-4 text-xs text-slate-500">{sourceFor(v)}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={() => copyText(v.token)}>
                              <Copy className="w-4 h-4" />
                              <span className="ml-2">Copy Token</span>
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => copyText(formatPreviewValue(v.previewValue) === "—" ? "" : formatPreviewValue(v.previewValue))}>
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
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Loop Section</th>
                    <th className="px-6 py-3 font-semibold">Start Token</th>
                    <th className="px-6 py-3 font-semibold">End Token</th>
                    <th className="px-6 py-3 font-semibold">Preview</th>
                    <th className="px-6 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredLoops.map((l) => (
                    <tr key={l.key} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <div className="text-slate-900 font-medium">{l.label}</div>
                        <div className="text-xs text-slate-500 mt-1">
                          Inner: {l.innerVariables.map((v) => v.token).join(", ")}
                        </div>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-700">{l.startToken}</td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-700">{l.endToken}</td>
                      <td className="px-6 py-4 text-slate-700 whitespace-pre-wrap max-w-md">{l.preview ?? "—"}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => copyText(`${l.startToken}\n${l.template}\n${l.endToken}`)}>
                            Copy Template
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
