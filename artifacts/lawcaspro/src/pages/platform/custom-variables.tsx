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

function normalizeKeyForSave(input: unknown): { value: string; error: string | null } {
  const value = canonicalizeKey(input);
  return { value, error: validateKey(value) };
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

export default function PlatformCustomVariablesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [qRaw, setQRaw] = useState("");
  const q = useMemo(() => qRaw.trim(), [qRaw]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ key: "", displayName: "", groupKey: "custom_variables", status: "active", isPublished: false, bodyTemplate: "" });
  const [keyTouched, setKeyTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ key?: string; displayName?: string; groupKey?: string; bodyTemplate?: string }>({});

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

  function validateForm(next: typeof form): boolean {
    const nextErrors: typeof fieldErrors = {};
    const normalized = normalizeKeyForSave(next.key);
    if (!editId && normalized.error) nextErrors.key = normalized.error;
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
      const normalized = editId ? null : normalizeKeyForSave(form.key);
      const nextForm = normalized ? { ...form, key: normalized.value } : form;
      if (normalized && normalized.value !== form.key) {
        setForm((p) => ({ ...p, key: normalized.value }));
      }
      const ok = validateForm(nextForm);
      if (!ok) throw new Error("Validation failed");
      const payload = {
        key: nextForm.key,
        displayName: nextForm.displayName,
        groupKey: nextForm.groupKey,
        status: nextForm.status,
        isPublished: nextForm.isPublished,
        bodyTemplate: nextForm.bodyTemplate,
      };
      if (editId) return await apiFetchJson(`/platform/custom-variables/${editId}`, { method: "PUT", body: JSON.stringify(payload) });
      return await apiFetchJson(`/platform/custom-variables`, { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      setEditOpen(false);
      await qc.invalidateQueries({ queryKey: ["platform", "custom-variables"] });
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

  const keyTokenPreview = useMemo(() => {
    const normalized = normalizeKeyForSave(form.key);
    return normalized.value ? `{{${normalized.value}}}` : "—";
  }, [form.key]);

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
                            setKeyTouched(true);
                            setFieldErrors({});
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
              <Input
                value={form.key}
                onChange={(e) => {
                  if (editId) return;
                  const key = e.target.value;
                  setKeyTouched(true);
                  setForm((p) => ({ ...p, key }));
                  setFieldErrors((p) => ({ ...p, key: validateKey(canonicalizeKey(key)) ?? undefined }));
                }}
                onBlur={() => {
                  if (editId) return;
                  const normalized = normalizeKeyForSave(form.key);
                  setForm((p) => ({ ...p, key: normalized.value }));
                  setFieldErrors((p) => ({ ...p, key: normalized.error ?? undefined }));
                }}
                disabled={!!editId}
                placeholder="e.g. property_full_description"
              />
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                <span className="font-mono">{keyTokenPreview}</span>
                <Button size="sm" variant="outline" onClick={() => copyText(keyTokenPreview === "—" ? "" : keyTokenPreview)} disabled={keyTokenPreview === "—"}>
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
                    return { ...p, displayName, key: canonicalizeKey(displayName) };
                  });
                  setFieldErrors((p) => {
                    const displayNameErr = displayName.trim() ? undefined : "Display Name is required.";
                    if (editId || keyTouched) return { ...p, displayName: displayNameErr };
                    return { ...p, displayName: displayNameErr, key: validateKey(canonicalizeKey(displayName)) ?? undefined };
                  });
                }}
                placeholder="e.g. Property Full Description"
              />
              {fieldErrors.displayName ? <div className="text-xs text-red-600">{fieldErrors.displayName}</div> : null}
            </div>
            <div className="space-y-1.5">
              <Label>Group</Label>
              <Input value={form.groupKey} onChange={(e) => setForm((p) => ({ ...p, groupKey: e.target.value }))} />
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
            <div className="flex items-center gap-2">
              <Checkbox checked={form.isPublished} onCheckedChange={(v) => setForm((p) => ({ ...p, isPublished: Boolean(v) }))} />
              <span className="text-sm text-slate-700">Published to firms</span>
            </div>
            <div className="md:col-span-2 space-y-1.5">
              <Label>Body Template</Label>
              <Textarea value={form.bodyTemplate} onChange={(e) => setForm((p) => ({ ...p, bodyTemplate: e.target.value }))} rows={10} placeholder="Use {{variable_tokens}} inside." />
              {fieldErrors.bodyTemplate ? <div className="text-xs text-red-600">{fieldErrors.bodyTemplate}</div> : null}
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
