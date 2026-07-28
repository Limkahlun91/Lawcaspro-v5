import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ChevronDown, Copy, Plus } from "lucide-react";

type CustomVariableRow = {
  id: number;
  scope: "firm" | "template_specific" | "founder_master";
  firm_id: number | null;
  template_id: number | null;
  key: string;
  display_name: string;
  group_key: string;
  status: "active" | "disabled" | "deprecated";
  is_published: boolean;
  deprecated_at: string | null;
  current_version_no: number;
  body_template: string;
};

type PreviewResponse = {
  id: number;
  key: string;
  displayName: string;
  token: string;
  rendered: string;
  usedVariables: string[];
  missingVariables: string[];
  warnings: Array<{ key: string; warning: string }>;
};

type CaseSearchItem = {
  id: number;
  referenceNo: string;
  clientName?: string | null;
  projectName?: string | null;
  property?: string | null;
};

type CaseListResponse = {
  data: CaseSearchItem[];
};

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

const KEY_REGEX = /^[a-z][a-z0-9_]*$/;

function canonicalizeKey(input: unknown): string {
  const raw = String(input ?? "").trim().toLowerCase();
  const replaced = raw.replace(/[\s-]+/g, "_");
  const cleaned = replaced.replace(/[^a-z0-9_]/g, "");
  const collapsed = cleaned.replace(/_+/g, "_");
  return collapsed.replace(/^_+|_+$/g, "");
}

function validateKey(key: string): string | null {
  const k = String(key ?? "");
  if (!k.trim()) return "Key is required.";
  if (!KEY_REGEX.test(k)) return "Key may contain only lowercase letters, numbers and underscores, and must start with a letter.";
  return null;
}

function findTokenSyntaxError(body: unknown): string | null {
  const text = String(body ?? "");
  const firstOpen = text.indexOf("{{");
  const firstClose = text.indexOf("}}");
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) return "Invalid token syntax near {{...}}.";
  const tokenRe = /^[a-zA-Z][a-zA-Z0-9_]*$/;
  let i = 0;
  while (true) {
    const open = text.indexOf("{{", i);
    if (open === -1) break;
    const close = text.indexOf("}}", open + 2);
    if (close === -1) return "Invalid token syntax near {{...}}.";
    const token = text.slice(open + 2, close).trim();
    if (!token || token.includes("{") || token.includes("}") || /\s/.test(token) || !tokenRe.test(token)) return "Invalid token syntax near {{...}}.";
    i = close + 2;
  }
  return null;
}

function formatValue(v: unknown): string {
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

function isAbortError(e: unknown): boolean {
  const n = typeof (e as any)?.name === "string" ? String((e as any).name) : "";
  return n === "AbortError";
}

export default function CustomVariablesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [qRaw, setQRaw] = useState("");
  const q = useMemo(() => qRaw.trim(), [qRaw]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ key: "", displayName: "", groupKey: "custom_variables", status: "active", bodyTemplate: "" });
  const [keyTouched, setKeyTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ key?: string; displayName?: string; groupKey?: string; bodyTemplate?: string }>({});

  const listQuery = useQuery({
    queryKey: ["documents", "custom-variables", q, statusFilter],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      if (statusFilter !== "all") qs.set("status", statusFilter);
      const res = await apiFetchJson<CustomVariableRow[]>(`/documents/custom-variables?${qs.toString()}`);
      return Array.isArray(res) ? res.filter((x) => x.scope === "firm" || x.scope === "template_specific") : [];
    },
    retry: false,
  });

  function validateForm(next: typeof form): boolean {
    const nextErrors: typeof fieldErrors = {};
    const key = canonicalizeKey(next.key);
    const keyErr = editId ? null : validateKey(key);
    if (!editId && keyErr) nextErrors.key = keyErr;
    if (!String(next.displayName ?? "").trim()) nextErrors.displayName = "Display Name is required.";
    if (!String(next.bodyTemplate ?? "").trim()) nextErrors.bodyTemplate = "Body Template is required.";
    const tokenErr = findTokenSyntaxError(next.bodyTemplate);
    if (tokenErr) nextErrors.bodyTemplate = tokenErr;
    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function extractFieldErrorsFromApiError(err: unknown): { next: typeof fieldErrors; toastMessage: string } | null {
    const status = typeof (err as any)?.status === "number" ? (err as any).status : null;
    const data = (err as any)?.data;
    const requestIdFromError = typeof (err as any)?.requestId === "string" ? String((err as any).requestId) : null;
    const requestIdFromBody = typeof (data as any)?.meta?.request_id === "string" ? String((data as any).meta.request_id) : null;
    const requestId = requestIdFromError ?? requestIdFromBody;

    const isApiFailure =
      !!data && typeof data === "object" && (data as any).ok === false && typeof (data as any).error === "object" && (data as any).error;
    const apiDetails = isApiFailure ? ((data as any).error as any).details : null;
    const apiMessage = isApiFailure && typeof (data as any).error?.message === "string" ? String((data as any).error.message) : null;

    if (status === 400) {
      const issuesRaw =
        Array.isArray((data as any)?.issues) ? ((data as any).issues as any[])
        : Array.isArray(apiDetails?.issues) ? (apiDetails.issues as any[])
        : null;
      if (!issuesRaw) return null;
      const next: typeof fieldErrors = {};
      for (const issue of issuesRaw) {
        const path0 = Array.isArray(issue?.path) ? String(issue.path[0] ?? "") : "";
        const msg = typeof issue?.message === "string" ? issue.message : "Invalid input.";
        if (path0 === "key") next.key = msg;
        if (path0 === "displayName") next.displayName = msg;
        if (path0 === "groupKey") next.groupKey = msg;
        if (path0 === "bodyTemplate") next.bodyTemplate = msg;
      }
      const toastMessage = requestId ? `Request invalid. Ref: ${requestId}` : "Request invalid.";
      return { next, toastMessage };
    }

    if (status === 409) {
      const field =
        typeof (data as any)?.field === "string" ? String((data as any).field)
        : typeof apiDetails?.field === "string" ? String(apiDetails.field)
        : null;
      if (!field) return null;
      const msgRaw =
        apiMessage ? apiMessage
        : typeof (data as any)?.error === "string" ? String((data as any).error)
        : "Conflict.";
      const next: typeof fieldErrors = {};
      if (field === "key") next.key = msgRaw;
      const toastMessage = requestId ? `${msgRaw} Ref: ${requestId}` : msgRaw;
      return { next, toastMessage };
    }

    if (requestId) {
      return { next: {}, toastMessage: `Unable to save the custom variable. Error reference: ${requestId}.` };
    }
    return null;
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const ok = validateForm(form);
      if (!ok) throw new Error("Validation failed");
      if (editId) {
        return await apiFetchJson(`/documents/custom-variables/${editId}`, {
          method: "PUT",
          body: JSON.stringify({
            displayName: form.displayName,
            groupKey: form.groupKey,
            status: form.status,
            bodyTemplate: form.bodyTemplate,
          }),
        });
      }
      return await apiFetchJson(`/documents/custom-variables`, {
        method: "POST",
        body: JSON.stringify({
          key: canonicalizeKey(form.key),
          displayName: form.displayName,
          groupKey: form.groupKey,
          status: form.status,
          bodyTemplate: form.bodyTemplate,
        }),
      });
    },
    onSuccess: async () => {
      setEditOpen(false);
      await qc.invalidateQueries({ queryKey: ["documents", "custom-variables"] });
      toast({ title: "Saved" });
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "Validation failed") return;
      const parsed = extractFieldErrorsFromApiError(e);
      if (parsed) {
        setFieldErrors(parsed.next);
        toast({ title: "Save failed", description: parsed.toastMessage, variant: "destructive" });
        return;
      }
      toastError(toast, e, "Save failed");
    },
  });

  const deprecateMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiFetchJson(`/documents/custom-variables/${id}`, {
        method: "PUT",
        body: JSON.stringify({ status: "deprecated" }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["documents", "custom-variables"] });
      toast({ title: "Deprecated" });
    },
    onError: (e) => toastError(toast, e, "Update failed"),
  });

  const [caseQueryRaw, setCaseQueryRaw] = useState("");
  const caseQuery = useMemo(() => caseQueryRaw.trim(), [caseQueryRaw]);
  const [caseResults, setCaseResults] = useState<CaseSearchItem[]>([]);
  const [caseSearching, setCaseSearching] = useState(false);
  const [caseSearchError, setCaseSearchError] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<CaseSearchItem | null>(null);
  const [pageCaseOpen, setPageCaseOpen] = useState(false);
  const [modalCaseOpen, setModalCaseOpen] = useState(false);
  const anyCaseOpen = pageCaseOpen || modalCaseOpen;
  const lastAbortRef = useRef<AbortController | null>(null);
  const lastGoodPreviewRef = useRef<Map<string, PreviewResponse>>(new Map());

  useEffect(() => {
    if (!anyCaseOpen) {
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
  }, [caseQuery, anyCaseOpen]);

  const [previewId, setPreviewId] = useState<number | null>(null);
  const previewQuery = useQuery({
    queryKey: ["documents", "custom-variable-preview", previewId, selectedCase?.id ?? null],
    enabled: typeof previewId === "number" && previewId > 0 && typeof selectedCase?.id === "number" && selectedCase.id > 0,
    queryFn: async ({ signal }) => {
      return await apiFetchJson<PreviewResponse>(`/documents/custom-variables/${previewId}/preview?caseId=${selectedCase!.id}`, { signal });
    },
    retry: false,
    placeholderData: (prev) => prev,
  });

  type VariableItem = {
    id: number;
    key: string;
    label: string;
    category: string;
    groupKey?: string | null;
    valueType?: string;
    isSystem: boolean;
    isActive: boolean;
    isHidden?: boolean;
    isPublished?: boolean;
    deprecatedAt?: string | null;
    replacementKey?: string | null;
    sortOrder: number;
    previewValue?: unknown;
    custom?: { scope: "founder_master" | "firm" | "template_specific"; status: "active" | "disabled" | "deprecated"; currentVersionNo: number };
  };

  const variablesRegistryQuery = useQuery<VariableItem[]>({
    queryKey: ["documents", "variable-registry"],
    queryFn: async ({ signal }) => {
      const res = await apiFetchJson<VariableItem[]>(`/document-variables?active=1`, { signal });
      return Array.isArray(res) ? res : [];
    },
    retry: false,
    staleTime: 60_000,
  });

  const variablesPreviewQuery = useQuery<{ variables: VariableItem[]; loops: any[] }>({
    queryKey: ["documents", "variables-preview", selectedCase?.id ?? null],
    enabled: typeof selectedCase?.id === "number" && selectedCase.id > 0,
    queryFn: async ({ signal }) => {
      const caseId = selectedCase!.id;
      return await apiFetchJson<{ variables: VariableItem[]; loops: any[] }>(`/documents/variables?caseId=${caseId}&includeLoops=1`, { signal });
    },
    retry: false,
    placeholderData: (prev) => prev,
  });

  const variablePreviewByKey = useMemo(() => {
    const m = new Map<string, VariableItem>();
    const vars = Array.isArray(variablesPreviewQuery.data?.variables) ? variablesPreviewQuery.data!.variables : [];
    for (const v of vars) if (typeof v?.key === "string" && v.key) m.set(v.key, v);
    return m;
  }, [variablesPreviewQuery.data]);

  const templateValueByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const [k, v] of variablePreviewByKey.entries()) m.set(k, formatValue((v as any).previewValue));
    return m;
  }, [variablePreviewByKey]);

  function renderTemplate(body: string): string {
    const text = String(body ?? "");
    return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_m, keyRaw: string) => {
      const key = String(keyRaw).trim();
      if (!key) return "—";
      const v = templateValueByKey.get(key);
      return v && v !== "—" ? v : "—";
    });
  }

  useEffect(() => {
    if (!previewId || !selectedCase?.id) return;
    const d = previewQuery.data as PreviewResponse | undefined;
    if (!d) return;
    lastGoodPreviewRef.current.set(`${previewId}:${selectedCase.id}`, d);
  }, [previewQuery.data, previewId, selectedCase?.id]);

  const cachedPreview = (previewId && selectedCase?.id)
    ? (lastGoodPreviewRef.current.get(`${previewId}:${selectedCase.id}`) ?? null)
    : null;
  const previewData = (previewQuery.data as PreviewResponse | undefined) ?? cachedPreview;
  const previewIsAbort = isAbortError(previewQuery.error);
  const showPreviewWarning = previewQuery.isError && !previewIsAbort && !!previewData;

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied" });
    } catch (e) {
      toastError(toast, e, "Copy failed");
    }
  }

  function sourceLevelFor(v: VariableItem): string {
    if (v.category === "custom") return "Custom";
    if (v.isSystem) return "System";
    const scope = (v as any).custom?.scope;
    if (scope === "firm") return "Firm";
    if (scope === "founder_master") return "Founder";
    return "Founder";
  }

  const [varSearchRaw, setVarSearchRaw] = useState("");
  const varSearch = useMemo(() => norm(varSearchRaw), [varSearchRaw]);
  const [varFilter, setVarFilter] = useState<string>("all");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const pickerItems = useMemo(() => {
    const registry = Array.isArray(variablesRegistryQuery.data) ? variablesRegistryQuery.data : [];
    const merged = registry.map((r) => {
      const pv = variablePreviewByKey.get(r.key);
      return { ...r, previewValue: pv ? (pv as any).previewValue : undefined };
    });
    return merged
      .filter((v) => {
        const cat = String(v.category ?? "").toLowerCase();
        const key = String(v.key ?? "").toLowerCase();
        const label = String(v.label ?? "").toLowerCase();

        if (varFilter !== "all") {
          if (varFilter === "borrower") {
            if (!key.includes("borrower")) return false;
          } else if (varFilter === "vendor") {
            if (!key.includes("vendor")) return false;
          } else if (varFilter === "firm") {
            if (!(key.startsWith("firm_") || cat === "firm")) return false;
          } else if (varFilter === "purchaser") {
            if (!(cat === "purchaser" || key.includes("purchaser") || key.includes("buyer"))) return false;
          } else if (cat !== varFilter) {
            return false;
          }
        }

        if (!varSearch) return true;
        const token = `{{${v.key}}}`;
        const actual = formatValue((v as any).previewValue);
        const hay = `${label} ${key} ${token.toLowerCase()} ${actual.toLowerCase()} ${sourceLevelFor(v).toLowerCase()}`;
        return hay.includes(varSearch);
      })
      .sort((a, b) => {
        const ac = String(a.category ?? "");
        const bc = String(b.category ?? "");
        if (ac !== bc) return ac.localeCompare(bc);
        return String(a.key ?? "").localeCompare(String(b.key ?? ""));
      });
  }, [varFilter, varSearch, variablesRegistryQuery.data, variablePreviewByKey]);

  function insertToken(token: string) {
    const el = bodyRef.current;
    const current = el ? el.value : form.bodyTemplate;
    const hasFocus = !!el && document.activeElement === el;
    const start = hasFocus && typeof el!.selectionStart === "number" ? el!.selectionStart : current.length;
    const end = hasFocus && typeof el!.selectionEnd === "number" ? el!.selectionEnd : current.length;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    const caret = start + token.length;
    setForm((p) => ({ ...p, bodyTemplate: next }));
    requestAnimationFrame(() => {
      const node = bodyRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  }

  const livePreview = useMemo(() => renderTemplate(form.bodyTemplate), [form.bodyTemplate, templateValueByKey]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Custom Dictionary</h1>
          <p className="text-slate-500">Create reusable clauses using existing variables. Use the picker to insert tokens.</p>
        </div>
        <Button
          className="gap-2"
          onClick={() => {
            setEditId(null);
            setForm({ key: "", displayName: "", groupKey: "custom_variables", status: "active", bodyTemplate: "" });
            setKeyTouched(false);
            setFieldErrors({});
            setEditOpen(true);
          }}
        >
          <Plus className="w-4 h-4" />
          New
        </Button>
      </div>

      <Card className="border-slate-200">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col md:flex-row gap-2 md:items-center md:justify-between">
            <div className="flex gap-2 items-center">
              <Input value={qRaw} onChange={(e) => setQRaw(e.target.value)} placeholder="Search key/name/body…" className="w-[320px]" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px]"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="deprecated">Deprecated</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-sm text-slate-500">
              {listQuery.isLoading ? "Loading…" : `${(listQuery.data?.length ?? 0).toString()} items`}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200">
        <CardContent className="p-0">
          {listQuery.isError ? (
            <div className="p-6 text-sm text-slate-700">
              Custom variables unavailable.
              <Button className="ml-2" size="sm" variant="outline" onClick={() => listQuery.refetch()} disabled={listQuery.isFetching}>Retry</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Name</th>
                    <th className="px-6 py-3 font-semibold">Token</th>
                    <th className="px-6 py-3 font-semibold">Group</th>
                    <th className="px-6 py-3 font-semibold">Status</th>
                    <th className="px-6 py-3 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(listQuery.data ?? []).map((v) => (
                    <tr key={v.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-900">{v.display_name}</div>
                        <div className="text-xs text-slate-500 font-mono">{v.key}</div>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-700">{`{{${v.key}}}`}</td>
                      <td className="px-6 py-4 text-slate-700">{v.group_key}</td>
                      <td className="px-6 py-4 text-slate-700">{v.status}</td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2 items-center">
                          <Button size="sm" variant="outline" onClick={() => copyText(`{{${v.key}}}`)} aria-label="Copy token">
                            <Copy className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditId(v.id);
                              setForm({
                                key: v.key,
                                displayName: v.display_name,
                                groupKey: v.group_key,
                                status: v.status,
                                bodyTemplate: v.body_template,
                              });
                              setKeyTouched(true);
                              setFieldErrors({});
                              setEditOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => deprecateMutation.mutate(v.id)}
                            disabled={v.status === "deprecated" || deprecateMutation.isPending}
                          >
                            Deprecate
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setPreviewId(v.id)} disabled={!selectedCase}>
                            Preview
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {(listQuery.data?.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">No custom variables.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-200">
        <CardContent className="p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-900">Preview</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
            <div className="space-y-2">
              <div className="text-xs text-slate-500">Case</div>
              <Popover
                open={pageCaseOpen}
                onOpenChange={(open) => {
                  setPageCaseOpen(open);
                  if (open) {
                    setModalCaseOpen(false);
                    setCaseQueryRaw("");
                  }
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={pageCaseOpen}
                    onClick={() => {
                      setPageCaseOpen((prev) => {
                        const next = !prev;
                        if (next) {
                          setModalCaseOpen(false);
                          setCaseQueryRaw("");
                        }
                        return next;
                      });
                    }}
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
                    <CommandInput value={caseQueryRaw} onValueChange={setCaseQueryRaw} placeholder="Search case…" />
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
                              setPageCaseOpen(false);
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
                  <Button variant="ghost" size="sm" className="ml-2" onClick={() => setSelectedCase(null)}>Clear</Button>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-500">Rendered Output</div>
              {(previewQuery.isFetching || previewQuery.isLoading) && !previewData ? (
                <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-500">Loading…</div>
              ) : previewQuery.isError && !previewIsAbort && !previewData ? (
                <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700 flex items-center justify-between gap-3">
                  <div>Preview unavailable.</div>
                  <Button size="sm" variant="outline" onClick={() => previewQuery.refetch()} disabled={previewQuery.isFetching}>
                    Retry
                  </Button>
                </div>
              ) : previewData ? (
                <div className="space-y-2">
                  {showPreviewWarning ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900 flex items-center justify-between gap-3">
                      <div>Failed to refresh preview. Showing cached results.</div>
                      <Button size="sm" variant="outline" onClick={() => previewQuery.refetch()} disabled={previewQuery.isFetching}>
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-800 whitespace-pre-wrap">
                    {previewData.rendered?.trim() ? previewData.rendered : "—"}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => copyText(previewData.token)}>Copy Token</Button>
                    <Button size="sm" variant="outline" onClick={() => copyText(previewData.rendered?.trim() ? previewData.rendered : "")}>Copy Output</Button>
                  </div>
                  {previewData.missingVariables?.length ? (
                    <div className="text-xs text-amber-700">Missing: {previewData.missingVariables.join(", ")}</div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-500">Select a case, then click Preview on a variable.</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-[1100px]">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Custom Variable" : "New Custom Variable"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6 py-2">
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Key</Label>
                  <Input
                    value={form.key}
                    onChange={(e) => {
                      if (editId) return;
                      setKeyTouched(true);
                      const key = canonicalizeKey(e.target.value);
                      setForm((p) => ({ ...p, key }));
                      const err = validateKey(key);
                      setFieldErrors((p) => ({ ...p, key: err ?? undefined }));
                    }}
                    disabled={!!editId}
                    placeholder="e.g. property_full_description"
                  />
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="font-mono">{form.key ? `{{${form.key}}}` : "—"}</span>
                    <Button size="sm" variant="outline" onClick={() => copyText(form.key ? `{{${form.key}}}` : "")} disabled={!form.key}>
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                  {fieldErrors.key ? <div className="text-xs text-red-600">{fieldErrors.key}</div> : null}
                </div>
                <div className="space-y-1.5">
                  <Label>Display Name</Label>
                  <Input
                    value={form.displayName}
                    onChange={(e) => {
                      const displayName = e.target.value;
                      setForm((p) => {
                        if (editId || keyTouched) return { ...p, displayName };
                        const key = canonicalizeKey(displayName);
                        return { ...p, displayName, key };
                      });
                      setFieldErrors((p) => {
                        const displayNameErr = displayName.trim() ? undefined : "Display Name is required.";
                        if (editId || keyTouched) return { ...p, displayName: displayNameErr };
                        const key = canonicalizeKey(displayName);
                        const keyErr = validateKey(key) ?? undefined;
                        return { ...p, displayName: displayNameErr, key: keyErr };
                      });
                    }}
                    placeholder="e.g. Property Full Description"
                  />
                  {fieldErrors.displayName ? <div className="text-xs text-red-600">{fieldErrors.displayName}</div> : null}
                </div>
                <div className="space-y-1.5">
                  <Label>Group</Label>
                  <Input value={form.groupKey} onChange={(e) => setForm((p) => ({ ...p, groupKey: e.target.value }))} placeholder="custom_variables" />
                  {fieldErrors.groupKey ? <div className="text-xs text-red-600">{fieldErrors.groupKey}</div> : null}
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select value={form.status} onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">active</SelectItem>
                      <SelectItem value="deprecated">deprecated</SelectItem>
                      <SelectItem value="disabled">disabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Body Template</Label>
                <Textarea
                  ref={bodyRef}
                  value={form.bodyTemplate}
                  onChange={(e) => {
                    const bodyTemplate = e.target.value;
                    setForm((p) => ({ ...p, bodyTemplate }));
                    const err = findTokenSyntaxError(bodyTemplate);
                    setFieldErrors((p) => ({ ...p, bodyTemplate: err ?? undefined }));
                  }}
                  rows={12}
                  placeholder="Use {{variable_tokens}} inside."
                />
                {fieldErrors.bodyTemplate ? <div className="text-xs text-red-600">{fieldErrors.bodyTemplate}</div> : null}
              </div>

              <div className="space-y-1.5">
                <div className="text-sm font-semibold text-slate-900">Preview</div>
                <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-800 whitespace-pre-wrap">
                  {livePreview.trim() ? livePreview : "—"}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-900">Case Preview</div>
                <Popover
                  open={modalCaseOpen}
                  onOpenChange={(open) => {
                    setModalCaseOpen(open);
                    if (open) {
                      setPageCaseOpen(false);
                      setCaseQueryRaw("");
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={modalCaseOpen}
                      onClick={() => {
                        setModalCaseOpen((prev) => {
                          const next = !prev;
                          if (next) {
                            setPageCaseOpen(false);
                            setCaseQueryRaw("");
                          }
                          return next;
                        });
                      }}
                      className="w-full justify-between"
                    >
                      <span className="truncate">
                        {selectedCase ? (selectedCase.referenceNo || `Case #${selectedCase.id}`) : "Select a case…"}
                      </span>
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent portalled={false} align="start" className="p-0 w-[520px] max-w-[calc(100vw-2rem)]">
                    <Command>
                      <CommandInput value={caseQueryRaw} onValueChange={setCaseQueryRaw} placeholder="Search case…" />
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
                                setModalCaseOpen(false);
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
                    <Button variant="ghost" size="sm" className="ml-2" onClick={() => setSelectedCase(null)}>Clear</Button>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">Select a case to preview actual values.</div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-900">Variables</div>
                <div className="flex gap-2">
                  <Input value={varSearchRaw} onChange={(e) => setVarSearchRaw(e.target.value)} placeholder="Search variables..." />
                  <Select value={varFilter} onValueChange={setVarFilter}>
                    <SelectTrigger className="w-[160px]"><SelectValue placeholder="Filter" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="case">case</SelectItem>
                      <SelectItem value="purchaser">purchaser</SelectItem>
                      <SelectItem value="borrower">borrower</SelectItem>
                      <SelectItem value="vendor">vendor</SelectItem>
                      <SelectItem value="project">project</SelectItem>
                      <SelectItem value="property">property</SelectItem>
                      <SelectItem value="loan">loan</SelectItem>
                      <SelectItem value="workflow">workflow</SelectItem>
                      <SelectItem value="firm">firm</SelectItem>
                      <SelectItem value="custom">custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-md border border-slate-200 bg-white overflow-hidden">
                  <div className="max-h-[520px] overflow-auto divide-y divide-slate-100">
                    {variablesRegistryQuery.isLoading ? (
                      <div className="p-3 text-sm text-slate-500">Loading variables…</div>
                    ) : variablesRegistryQuery.isError ? (
                      <div className="p-3 text-sm text-slate-700 flex items-center justify-between gap-3">
                        <div>Variables unavailable.</div>
                        <Button size="sm" variant="outline" onClick={() => variablesRegistryQuery.refetch()} disabled={variablesRegistryQuery.isFetching}>
                          Retry
                        </Button>
                      </div>
                    ) : pickerItems.length ? (
                      pickerItems.map((v) => {
                        const token = `{{${v.key}}}`;
                        const valueText =
                          !selectedCase
                            ? "Select case to preview value"
                            : variablesPreviewQuery.isLoading && !variablesPreviewQuery.data
                              ? "Loading…"
                              : formatValue((v as any).previewValue);
                        const canCopyValue = !!selectedCase && valueText !== "Select case to preview value" && valueText !== "Loading…" && valueText !== "—";
                        return (
                          <div key={v.key} className="p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold text-slate-900 truncate">{v.label || v.key}</div>
                                <div className="text-xs text-slate-500 font-mono">{token}</div>
                                <div className="mt-1 text-xs text-slate-700">
                                  <span className="text-slate-500">Value: </span>
                                  <span className="font-mono">{valueText}</span>
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                  <span className="uppercase">{String(v.category ?? "")}</span>
                                  <span className="text-slate-300"> · </span>
                                  {sourceLevelFor(v)}
                                </div>
                              </div>
                              <div className="shrink-0 flex flex-col gap-2">
                                <Button size="sm" variant="outline" onClick={() => insertToken(token)}>
                                  Insert
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => copyText(token)}>
                                  Copy Token
                                </Button>
                                <Button size="sm" variant="outline" disabled={!canCopyValue} onClick={() => copyText(canCopyValue ? valueText : "")}>
                                  Copy Value
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="p-3 text-sm text-slate-500">No variables.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
