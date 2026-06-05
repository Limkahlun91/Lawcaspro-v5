import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Copy, Trash2 } from "lucide-react";

type VariableRow = {
  id: number;
  key: string;
  label: string;
  description: string | null;
  category: string;
  groupKey?: string | null;
  valueType: string;
  sourcePath: string | null;
  formatter: string | null;
  isSystem: boolean;
  isActive: boolean;
  isHidden?: boolean;
  isPublished?: boolean;
  deprecatedAt?: string | null;
  replacementKey?: string | null;
  sortOrder: number;
};

type UsageResponse = { id: number; key: string; usage: Record<string, number>; canDelete: boolean };

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

export default function PlatformVariablesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [searchRaw, setSearchRaw] = useState("");
  const search = useMemo(() => norm(searchRaw), [searchRaw]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageData, setUsageData] = useState<UsageResponse | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({
    key: "",
    label: "",
    category: "case",
    groupKey: "case",
    valueType: "string",
    sourcePath: "",
    formatter: "",
    isActive: true,
    isHidden: false,
    isPublished: true,
    deprecated: false,
    replacementKey: "",
    sortOrder: 0,
  });

  const listQuery = useQuery({
    queryKey: ["platform", "document-variables", includeInactive],
    queryFn: async () => {
      const res = await apiFetchJson<VariableRow[]>(`/platform/document-variables${includeInactive ? "" : "?active=1"}`);
      return Array.isArray(res) ? res : [];
    },
    retry: false,
  });

  const filtered = useMemo(() => {
    const vars = listQuery.data ?? [];
    if (!search) return vars;
    return vars.filter((v) => {
      const hay = `${norm(v.key)} ${norm(v.label)} ${norm(v.category)} ${norm(v.groupKey)} ${norm(v.sourcePath)} ${norm(v.formatter)} ${norm(v.replacementKey)}`;
      return hay.includes(search);
    });
  }, [listQuery.data, search]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        label: form.label,
        category: form.category,
        groupKey: form.groupKey,
        valueType: form.valueType,
        sourcePath: form.sourcePath || null,
        formatter: form.formatter || null,
        isActive: form.isActive,
        isHidden: form.isHidden,
        isPublished: form.isPublished,
        deprecatedAt: form.deprecated ? new Date().toISOString() : null,
        replacementKey: form.replacementKey || null,
        sortOrder: form.sortOrder,
      };
      if (editId) {
        return await apiFetchJson(`/platform/document-variables/${editId}`, { method: "PUT", body: JSON.stringify(payload) });
      }
      return await apiFetchJson(`/platform/document-variables`, { method: "POST", body: JSON.stringify({ ...payload, key: form.key }) });
    },
    onSuccess: async () => {
      setEditOpen(false);
      await qc.invalidateQueries({ queryKey: ["platform", "document-variables"] });
      toast({ title: "Saved" });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiFetchJson(`/platform/document-variables/${id}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["platform", "document-variables"] });
      toast({ title: "Deleted" });
    },
    onError: (e) => toastError(toast, e, "Delete failed"),
  });

  async function copyToken(key: string) {
    try {
      await navigator.clipboard.writeText(`{{${key}}}`);
      toast({ title: "Copied" });
    } catch (e) {
      toastError(toast, e, "Copy failed");
    }
  }

  async function openUsage(id: number) {
    try {
      const res = await apiFetchJson<UsageResponse>(`/platform/document-variables/${id}/usage`);
      setUsageData(res);
      setUsageOpen(true);
    } catch (e) {
      toastError(toast, e, "Usage unavailable");
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Master Variable Dictionary</h1>
        <p className="text-slate-500">Manage labels, grouping, visibility, deprecation, aliases and safe delete.</p>
      </div>

      <Card className="border-slate-200">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center gap-2 justify-between">
            <div className="flex items-center gap-2">
              <Input value={searchRaw} onChange={(e) => setSearchRaw(e.target.value)} placeholder="Search key/label…" className="w-[340px]" />
              <div className="flex items-center gap-2">
                <Checkbox checked={includeInactive} onCheckedChange={(v) => setIncludeInactive(Boolean(v))} />
                <span className="text-sm text-slate-600">Include inactive</span>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEditId(null);
                setForm({
                  key: "",
                  label: "",
                  category: "case",
                  groupKey: "case",
                  valueType: "string",
                  sourcePath: "",
                  formatter: "",
                  isActive: true,
                  isHidden: false,
                  isPublished: true,
                  deprecated: false,
                  replacementKey: "",
                  sortOrder: 0,
                });
                setEditOpen(true);
              }}
            >
              New Variable
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200">
        <CardContent className="p-0">
          {listQuery.isError ? (
            <div className="p-6 text-sm text-slate-700">
              Variables unavailable.
              <Button className="ml-2" size="sm" variant="outline" onClick={() => listQuery.refetch()} disabled={listQuery.isFetching}>Retry</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Key</th>
                    <th className="px-6 py-3 font-semibold">Label</th>
                    <th className="px-6 py-3 font-semibold">Group</th>
                    <th className="px-6 py-3 font-semibold">Published</th>
                    <th className="px-6 py-3 font-semibold">Hidden</th>
                    <th className="px-6 py-3 font-semibold">Deprecated</th>
                    <th className="px-6 py-3 font-semibold">Sort</th>
                    <th className="px-6 py-3 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((v) => (
                    <tr key={v.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4 font-mono text-xs text-slate-800">{v.key}</td>
                      <td className="px-6 py-4 text-slate-900">{v.label}</td>
                      <td className="px-6 py-4 text-slate-700">{v.groupKey ?? v.category}</td>
                      <td className="px-6 py-4 text-slate-700">{v.isPublished === false ? "No" : "Yes"}</td>
                      <td className="px-6 py-4 text-slate-700">{v.isHidden ? "Yes" : "No"}</td>
                      <td className="px-6 py-4 text-slate-700">{v.deprecatedAt ? "Yes" : "No"}</td>
                      <td className="px-6 py-4 text-slate-700">{String(v.sortOrder ?? 0)}</td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2 items-center">
                          <Button size="sm" variant="outline" onClick={() => copyToken(v.key)} aria-label="Copy token">
                            <Copy className="w-4 h-4" />
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openUsage(v.id)}>
                            Usage
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditId(v.id);
                              setForm({
                                key: v.key,
                                label: v.label,
                                category: v.category ?? "case",
                                groupKey: (v.groupKey ?? v.category ?? "case") as any,
                                valueType: v.valueType ?? "string",
                                sourcePath: v.sourcePath ?? "",
                                formatter: v.formatter ?? "",
                                isActive: Boolean(v.isActive),
                                isHidden: Boolean(v.isHidden),
                                isPublished: v.isPublished !== false,
                                deprecated: Boolean(v.deprecatedAt),
                                replacementKey: v.replacementKey ?? "",
                                sortOrder: typeof v.sortOrder === "number" ? v.sortOrder : Number(v.sortOrder ?? 0),
                              });
                              setEditOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => deleteMutation.mutate(v.id)} disabled={deleteMutation.isPending}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-slate-500">No variables found.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Variable" : "New Variable"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>Key</Label>
              <Input value={form.key} onChange={(e) => setForm((p) => ({ ...p, key: e.target.value }))} disabled={!!editId} />
            </div>
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input value={form.label} onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm((p) => ({ ...p, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["case", "purchaser", "property", "loan", "developer", "project", "workflow", "custom"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Group</Label>
              <Input value={form.groupKey} onChange={(e) => setForm((p) => ({ ...p, groupKey: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Sort Order</Label>
              <Input value={String(form.sortOrder)} onChange={(e) => setForm((p) => ({ ...p, sortOrder: Number(e.target.value || 0) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Replacement Key</Label>
              <Input value={form.replacementKey} onChange={(e) => setForm((p) => ({ ...p, replacementKey: e.target.value }))} placeholder="optional" />
            </div>
            <div className="space-y-1.5">
              <Label>Source Path</Label>
              <Input value={form.sourcePath} onChange={(e) => setForm((p) => ({ ...p, sourcePath: e.target.value }))} placeholder="e.g. reference_no" />
            </div>
            <div className="space-y-1.5">
              <Label>Formatter</Label>
              <Input value={form.formatter} onChange={(e) => setForm((p) => ({ ...p, formatter: e.target.value }))} placeholder="e.g. currency" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={form.isPublished} onCheckedChange={(v) => setForm((p) => ({ ...p, isPublished: Boolean(v) }))} />
              <span className="text-sm text-slate-700">Published to firms</span>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={form.isHidden} onCheckedChange={(v) => setForm((p) => ({ ...p, isHidden: Boolean(v) }))} />
              <span className="text-sm text-slate-700">Hidden</span>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={form.deprecated} onCheckedChange={(v) => setForm((p) => ({ ...p, deprecated: Boolean(v) }))} />
              <span className="text-sm text-slate-700">Deprecated</span>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={form.isActive} onCheckedChange={(v) => setForm((p) => ({ ...p, isActive: Boolean(v) }))} />
              <span className="text-sm text-slate-700">Active</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>{saveMutation.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={usageOpen} onOpenChange={setUsageOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Usage</DialogTitle>
          </DialogHeader>
          {usageData ? (
            <div className="space-y-2 text-sm text-slate-700">
              <div className="font-mono text-xs text-slate-800">{usageData.key}</div>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(usageData.usage ?? {}).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-2 border rounded px-2 py-1">
                    <div className="text-slate-600">{k}</div>
                    <div className="font-semibold">{String(v)}</div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-slate-500">Safe delete: {usageData.canDelete ? "Yes" : "No"}</div>
            </div>
          ) : (
            <div className="text-sm text-slate-500">Loading…</div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUsageOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
