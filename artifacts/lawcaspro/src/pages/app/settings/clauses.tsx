import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Copy, Plus, Trash2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

type VariableDef = {
  id: number;
  key: string;
  label: string;
  category: string;
};

type CustomClauseRow = {
  id: number;
  clauseName: string;
  title: string;
  content: string;
  status: string;
  updatedAt: string | null;
};

type ListCustomClausesResponse = { data: CustomClauseRow[] };

function normalizeClauseNameInput(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

export default function ClausesSettingsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const clausesQuery = useQuery<ListCustomClausesResponse>({
    queryKey: ["settings", "custom-clauses"],
    queryFn: ({ signal }) => apiFetchJson("/settings/custom-clauses", { signal }),
    retry: false,
  });

  const varsQuery = useQuery<VariableDef[]>({
    queryKey: ["settings", "document-variables"],
    queryFn: ({ signal }) => apiFetchJson("/document-variables?active=1", { signal }),
    retry: false,
  });

  const clauses = Array.isArray(clausesQuery.data?.data) ? clausesQuery.data!.data : [];
  const vars = Array.isArray(varsQuery.data) ? varsQuery.data : [];

  const inlineVars = useMemo(
    () => vars.filter((v) => typeof v.key === "string" && v.key.endsWith("_inline")).slice().sort((a, b) => String(a.key).localeCompare(String(b.key))),
    [vars]
  );

  const varsByCategory = useMemo(() => {
    const m = new Map<string, VariableDef[]>();
    for (const v of vars) {
      if (typeof v.key === "string" && v.key.endsWith("_inline")) continue;
      const cat = String(v.category ?? "General") || "General";
      const list = m.get(cat) ?? [];
      list.push(v);
      m.set(cat, list);
    }
    for (const [k, list] of m.entries()) {
      list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
      m.set(k, list);
    }
    return m;
  }, [vars]);

  const categories = useMemo(() => Array.from(varsByCategory.keys()).sort((a, b) => a.localeCompare(b)), [varsByCategory]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [clauseName, setClauseName] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const createMutation = useMutation({
    mutationFn: async () => {
      return await apiFetchJson("/settings/custom-clauses", {
        method: "POST",
        body: JSON.stringify({ clauseName, title, content }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["settings", "custom-clauses"] });
      toast({ title: "Clause created" });
      setDialogOpen(false);
    },
    onError: (e) => toastError(toast, e, "Create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      return await apiFetchJson(`/settings/custom-clauses/${editingId}`, {
        method: "PUT",
        body: JSON.stringify({ clauseName, title, content }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["settings", "custom-clauses"] });
      toast({ title: "Clause updated" });
      setDialogOpen(false);
    },
    onError: (e) => toastError(toast, e, "Update failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiFetchJson(`/settings/custom-clauses/${id}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["settings", "custom-clauses"] });
      toast({ title: "Clause archived" });
    },
    onError: (e) => toastError(toast, e, "Delete failed"),
  });

  const saving = createMutation.isPending || updateMutation.isPending;

  function openCreate() {
    setEditingId(null);
    setClauseName("");
    setTitle("");
    setContent("");
    setDialogOpen(true);
  }

  function openEdit(row: CustomClauseRow) {
    setEditingId(row.id);
    setClauseName(String(row.clauseName ?? ""));
    setTitle(String(row.title ?? ""));
    setContent(String(row.content ?? ""));
    setDialogOpen(true);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied!" });
    } catch (err) {
      toastError(toast, err, "Copy failed");
    }
  }

  function insertVariable(key: string) {
    insertText(`{{${key}}}`);
  }

  function insertText(token: string) {
    const el = contentRef.current;
    if (!el) {
      setContent((prev) => `${prev}${prev ? "\n" : ""}${token}`);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = `${content.slice(0, start)}${token}${content.slice(end)}`;
    setContent(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Custom Clauses</h1>
          <p className="text-slate-500 mt-1 text-sm">Reusable text blocks with variables (e.g. {"{{"}propertyType{"}}"}).</p>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="w-4 h-4" />
          New Clause
        </Button>
      </div>

      {clausesQuery.isError ? (
        <QueryFallback title="Clauses unavailable" error={clausesQuery.error} onRetry={() => clausesQuery.refetch()} isRetrying={clausesQuery.isFetching} />
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Clauses</CardTitle>
        </CardHeader>
        <CardContent>
          {clausesQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading clauses...</div>
          ) : clauses.length === 0 ? (
            <div className="text-sm text-slate-500 py-6 text-center">No custom clauses yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-slate-600">
                    <th className="py-3 px-4 font-medium">Clause Name</th>
                    <th className="py-3 px-4 font-medium">Title</th>
                    <th className="py-3 px-4 font-medium">Updated</th>
                    <th className="py-3 px-4 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clauses.map((c) => (
                    <tr key={c.id} className="border-b border-slate-100">
                      <td className="py-3 px-4 font-mono text-slate-900">{c.clauseName}</td>
                      <td className="py-3 px-4 text-slate-900">{c.title}</td>
                      <td className="py-3 px-4 text-slate-600">{c.updatedAt ? new Date(c.updatedAt).toLocaleString() : "—"}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={() => openEdit(c)} className="gap-1.5">
                            <Pencil className="w-3.5 h-3.5" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => deleteMutation.mutate(c.id)}
                            disabled={deleteMutation.isPending}
                            className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => copy(`{{clause_${c.clauseName}}}`)} className="gap-1.5">
                            <Copy className="w-3.5 h-3.5" />
                            Copy Placeholder
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(v) => { if (!v) setDialogOpen(false); else setDialogOpen(true); }}>
        <DialogContent className="w-[95vw] sm:w-[900px] sm:max-w-[900px] max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Clause" : "New Clause"}</DialogTitle>
            <DialogDescription className="sr-only">Clause builder</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 min-h-0">
            <div className="lg:col-span-2 space-y-4 min-h-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Clause Name</Label>
                  <Input
                    value={clauseName}
                    onChange={(e) => setClauseName(normalizeClauseNameInput(e.target.value))}
                    placeholder="CLAUSE_PROPERTY"
                    className="font-mono"
                  />
                  <div className="text-[11px] text-slate-500 font-mono">
                    Placeholder: {"{{"}clause_{normalizeClauseNameInput(clauseName || "CLAUSE")}{"}}"}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Title</Label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Clause title" />
                </div>
              </div>

              <div className="space-y-1.5 min-h-0">
                <Label>Content</Label>
                <Textarea
                  ref={contentRef}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={`Example: A unit of {{propertyType}}, Unit No. {{unitNo}}...`}
                  className="min-h-[260px] font-mono"
                />
              </div>
            </div>

            <div className="lg:col-span-1 min-h-0">
              <div className="rounded-md border border-slate-200 bg-white h-full flex flex-col min-h-0">
                <div className="px-3 py-2 border-b border-slate-200">
                  <div className="text-sm font-semibold text-slate-900">Variable Dictionary</div>
                  <div className="text-xs text-slate-500">Click to insert</div>
                </div>
                <div className="p-3 space-y-4 overflow-y-auto min-h-0">
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Parties (Formatted)</div>
                    <div className="space-y-1">
                      {inlineVars.length === 0 ? (
                        <div className="text-sm text-slate-500">No formatted party variables.</div>
                      ) : (
                        inlineVars.map((v) => (
                          <button
                            key={v.key}
                            type="button"
                            className={cn("w-full text-left rounded-md border border-slate-200 px-2 py-1.5 hover:bg-slate-50")}
                            onClick={() => insertVariable(v.key)}
                          >
                            <div className="text-xs font-medium text-slate-900 truncate">{v.label || v.key}</div>
                            <div className="text-[10px] text-slate-500 font-mono truncate">{"{{"}{v.key}{"}}"}</div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Dynamic Blocks (Looping)</div>
                    <div className="text-[11px] text-slate-500">
                      Tip: Wrap your signature blocks with these tags. The system will automatically duplicate the content inside based on the actual number of people.
                    </div>
                    <div className="space-y-1">
                      {[
                        { label: "Purchasers Loop Start", value: "{#purchasers}" },
                        { label: "Purchasers Loop End", value: "{/purchasers}" },
                        { label: "Borrowers Loop Start", value: "{#borrowers}" },
                        { label: "Borrowers Loop End", value: "{/borrowers}" },
                        { label: "Vendors Loop Start", value: "{#vendors}" },
                        { label: "Vendors Loop End", value: "{/vendors}" },
                      ].map((x) => (
                        <button
                          key={x.value}
                          type="button"
                          className={cn("w-full text-left rounded-md border border-slate-200 px-2 py-1.5 hover:bg-slate-50")}
                          onClick={() => insertText(x.value)}
                        >
                          <div className="text-xs font-medium text-slate-900 truncate">{x.label}</div>
                          <div className="text-[10px] text-slate-500 font-mono truncate">{x.value}</div>
                          <div className="text-[10px] text-slate-400 truncate">Use for multi-person signature blocks.</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Ready-to-use Snippets</div>
                    <div className="text-[11px] text-slate-500">Copy and paste these blocks into Word. New lines and dotted lines are preserved.</div>
                    {[
                      {
                        title: "Buyer Signature Block (買家簽名欄)",
                        value: `{#purchasers}\n...................................................\n{{name}}\n(NRIC NO.: {{nric}})\n\n{/purchasers}\n`,
                      },
                      {
                        title: "Borrower Signature Block (借貸人簽名欄)",
                        value: `{#borrowers}\n...................................................\n{{name}}\n(NRIC NO.: {{ic_no}})\n\n{/borrowers}\n`,
                      },
                    ].map((s) => (
                      <div key={s.title} className="rounded-md border border-slate-200 bg-white">
                        <div className="flex items-start justify-between gap-2 px-2 py-1.5 border-b border-slate-100">
                          <div className="text-xs font-medium text-slate-900">{s.title}</div>
                          <Button variant="outline" size="sm" onClick={() => copy(s.value)}>Copy Block</Button>
                        </div>
                        <pre className="p-2 text-[11px] leading-5 font-mono text-slate-700 whitespace-pre-wrap bg-slate-50 rounded-b-md">
                          <code>{s.value}</code>
                        </pre>
                      </div>
                    ))}
                  </div>

                  {varsQuery.isLoading ? (
                    <div className="text-sm text-slate-500">Loading variables...</div>
                  ) : varsQuery.isError ? (
                    <div className="text-sm text-red-600">Failed to load variables.</div>
                  ) : (
                    categories.map((cat) => {
                      const items = varsByCategory.get(cat) ?? [];
                      if (!items.length) return null;
                      return (
                        <div key={cat} className="space-y-2">
                          <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">{cat}</div>
                          <div className="space-y-1">
                            {items.map((v) => (
                              <button
                                key={v.key}
                                type="button"
                                className={cn("w-full text-left rounded-md border border-slate-200 px-2 py-1.5 hover:bg-slate-50")}
                                onClick={() => insertVariable(v.key)}
                              >
                                <div className="text-xs font-medium text-slate-900 truncate">{v.label || v.key}</div>
                                <div className="text-[10px] text-slate-500 font-mono truncate">{"{{"}{v.key}{"}}"}</div>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button
              onClick={() => {
                if (editingId) updateMutation.mutate();
                else createMutation.mutate();
              }}
              disabled={saving || !clauseName.trim() || !content.trim()}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
