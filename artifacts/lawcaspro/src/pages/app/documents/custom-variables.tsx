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

export default function CustomVariablesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [qRaw, setQRaw] = useState("");
  const q = useMemo(() => qRaw.trim(), [qRaw]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ key: "", displayName: "", groupKey: "custom_variables", status: "active", bodyTemplate: "" });

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

  const saveMutation = useMutation({
    mutationFn: async () => {
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
          key: form.key,
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
    onError: (e) => toastError(toast, e, "Save failed"),
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
  const [selectedCase, setSelectedCase] = useState<CaseSearchItem | null>(null);
  const [caseOpen, setCaseOpen] = useState(false);
  const lastAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!caseOpen) {
      lastAbortRef.current?.abort();
      setCaseResults([]);
      setCaseSearching(false);
      return;
    }
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
  }, [caseQuery, caseOpen]);

  const [previewId, setPreviewId] = useState<number | null>(null);
  const previewQuery = useQuery({
    queryKey: ["documents", "custom-variable-preview", previewId, selectedCase?.id ?? null],
    enabled: typeof previewId === "number" && previewId > 0 && typeof selectedCase?.id === "number" && selectedCase.id > 0,
    queryFn: async () => {
      return await apiFetchJson<PreviewResponse>(`/documents/custom-variables/${previewId}/preview?caseId=${selectedCase!.id}`);
    },
    retry: false,
  });

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
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Custom Variables</h1>
          <p className="text-slate-500">Create reusable paragraphs with existing variables.</p>
        </div>
        <Button
          className="gap-2"
          onClick={() => {
            setEditId(null);
            setForm({ key: "", displayName: "", groupKey: "custom_variables", status: "active", bodyTemplate: "" });
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
                    <CommandInput value={caseQueryRaw} onValueChange={setCaseQueryRaw} placeholder="Search case…" />
                    <CommandList>
                      <CommandEmpty>
                        <div className="text-sm text-slate-500">
                          {caseSearching ? "Searching…" : (caseQuery ? "No results." : "Type to search.")}
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
                  <Button variant="ghost" size="sm" className="ml-2" onClick={() => setSelectedCase(null)}>Clear</Button>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-500">Rendered Output</div>
              {previewQuery.isFetching || previewQuery.isLoading ? (
                <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-500">Loading…</div>
              ) : previewQuery.isError ? (
                <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700">Preview unavailable.</div>
              ) : previewQuery.data ? (
                <div className="space-y-2">
                  <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-800 whitespace-pre-wrap">
                    {previewQuery.data.rendered?.trim() ? previewQuery.data.rendered : "—"}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => copyText(previewQuery.data.token)}>Copy Token</Button>
                    <Button size="sm" variant="outline" onClick={() => copyText(previewQuery.data.rendered?.trim() ? previewQuery.data.rendered : "")}>Copy Output</Button>
                  </div>
                  {previewQuery.data.missingVariables?.length ? (
                    <div className="text-xs text-amber-700">Missing: {previewQuery.data.missingVariables.join(", ")}</div>
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
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Custom Variable" : "New Custom Variable"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>Key</Label>
              <Input value={form.key} onChange={(e) => setForm((p) => ({ ...p, key: e.target.value }))} disabled={!!editId} placeholder="e.g. property_full_description" />
            </div>
            <div className="space-y-1.5">
              <Label>Display Name</Label>
              <Input value={form.displayName} onChange={(e) => setForm((p) => ({ ...p, displayName: e.target.value }))} placeholder="e.g. Property Full Description" />
            </div>
            <div className="space-y-1.5">
              <Label>Group</Label>
              <Input value={form.groupKey} onChange={(e) => setForm((p) => ({ ...p, groupKey: e.target.value }))} placeholder="custom_variables" />
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
            <div className="md:col-span-2 space-y-1.5">
              <Label>Body Template</Label>
              <Textarea value={form.bodyTemplate} onChange={(e) => setForm((p) => ({ ...p, bodyTemplate: e.target.value }))} rows={10} placeholder="Use {{variable_tokens}} inside." />
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
