import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Copy, Plus } from "lucide-react";

type CustomVariableRow = {
  id: number;
  key: string;
  display_name: string;
  group_key: string;
  status: "active" | "disabled" | "deprecated";
  is_published: boolean;
  deprecated_at: string | null;
  current_version_no: number;
  body_template: string;
};

type PreviewResponse = { id: number; key: string; token: string; rendered: string; warnings: Array<{ key: string; warning: string }> };

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

export default function PlatformCustomVariablesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [qRaw, setQRaw] = useState("");
  const q = useMemo(() => qRaw.trim(), [qRaw]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ key: "", displayName: "", groupKey: "custom_variables", status: "active", isPublished: false, bodyTemplate: "" });

  const listQuery = useQuery({
    queryKey: ["platform", "custom-variables", q, statusFilter],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      if (statusFilter !== "all") qs.set("status", statusFilter);
      const res = await apiFetchJson<CustomVariableRow[]>(`/platform/custom-variables?${qs.toString()}`);
      return Array.isArray(res) ? res : [];
    },
    retry: false,
  });

  const filtered = useMemo(() => {
    const arr = listQuery.data ?? [];
    if (!q) return arr;
    const nq = norm(q);
    return arr.filter((x) => norm(x.key).includes(nq) || norm(x.display_name).includes(nq) || norm(x.body_template).includes(nq));
  }, [listQuery.data, q]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        key: form.key,
        displayName: form.displayName,
        groupKey: form.groupKey,
        status: form.status,
        isPublished: form.isPublished,
        bodyTemplate: form.bodyTemplate,
      };
      if (editId) return await apiFetchJson(`/platform/custom-variables/${editId}`, { method: "PUT", body: JSON.stringify(payload) });
      return await apiFetchJson(`/platform/custom-variables`, { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      setEditOpen(false);
      await qc.invalidateQueries({ queryKey: ["platform", "custom-variables"] });
      toast({ title: "Saved" });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  const [previewFirmId, setPreviewFirmId] = useState("");
  const [previewCaseId, setPreviewCaseId] = useState("");
  const [previewId, setPreviewId] = useState<number | null>(null);

  const previewQuery = useQuery({
    queryKey: ["platform", "custom-variables", "preview", previewId, previewFirmId, previewCaseId],
    enabled: Boolean(previewId) && Boolean(previewFirmId) && Boolean(previewCaseId),
    queryFn: async () => {
      return await apiFetchJson<PreviewResponse>(`/platform/custom-variables/${previewId}/preview?firmId=${encodeURIComponent(previewFirmId)}&caseId=${encodeURIComponent(previewCaseId)}`);
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
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Master Custom Variables</h1>
          <p className="text-slate-500">Founder-managed custom variables with publish and versioning.</p>
        </div>
        <Button
          className="gap-2"
          onClick={() => {
            setEditId(null);
            setForm({ key: "", displayName: "", groupKey: "custom_variables", status: "active", isPublished: false, bodyTemplate: "" });
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
                    <th className="px-6 py-3 font-semibold">Published</th>
                    <th className="px-6 py-3 font-semibold">Status</th>
                    <th className="px-6 py-3 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((v) => (
                    <tr key={v.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-900">{v.display_name}</div>
                        <div className="text-xs text-slate-500">{v.group_key}</div>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-700">{`{{${v.key}}}`}</td>
                      <td className="px-6 py-4 text-slate-700">{v.is_published ? "Yes" : "No"}</td>
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
                                isPublished: v.is_published,
                                bodyTemplate: v.body_template,
                              });
                              setEditOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setPreviewId(v.id)}>
                            Preview
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
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
          <div className="text-sm font-semibold text-slate-900">Preview (requires active support session for firm)</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Firm ID</Label>
              <Input value={previewFirmId} onChange={(e) => setPreviewFirmId(e.target.value)} placeholder="e.g. 1" />
            </div>
            <div className="space-y-1.5">
              <Label>Case ID</Label>
              <Input value={previewCaseId} onChange={(e) => setPreviewCaseId(e.target.value)} placeholder="e.g. 123" />
            </div>
            <div className="space-y-1.5">
              <Label>Selected Variable</Label>
              <Input value={previewId ? String(previewId) : ""} readOnly placeholder="Click Preview in table" />
            </div>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-800 whitespace-pre-wrap min-h-16">
            {previewQuery.isFetching || previewQuery.isLoading ? "Loading…" : previewQuery.isError ? "Preview unavailable." : previewQuery.data?.rendered?.trim() ? previewQuery.data.rendered : "—"}
          </div>
          {previewQuery.data?.token ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => copyText(previewQuery.data!.token)}>Copy Token</Button>
              <Button size="sm" variant="outline" onClick={() => copyText(previewQuery.data!.rendered?.trim() ? previewQuery.data!.rendered : "")}>Copy Output</Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit Master Custom Variable" : "New Master Custom Variable"}</DialogTitle>
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
              <Input value={form.groupKey} onChange={(e) => setForm((p) => ({ ...p, groupKey: e.target.value }))} />
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
            <div className="flex items-center gap-2">
              <Checkbox checked={form.isPublished} onCheckedChange={(v) => setForm((p) => ({ ...p, isPublished: Boolean(v) }))} />
              <span className="text-sm text-slate-700">Published to firms</span>
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

