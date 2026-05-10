import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { ensureArray, listItems } from "@/lib/list-items";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { TemplatePdfMappingEditor } from "@/components/TemplatePdfMappingEditor";
import { throwIfApiFailure, getApiFailureCodeFromError } from "@/lib/api-failure";
import { SupportSessionRequired } from "@/components/support-session-required";

type TemplateRow = {
  id: number;
  firm_id: number | null;
  firm_name: string | null;
  name: string;
  file_type: string;
  storage_path: string;
  mapping_config?: unknown;
  is_active: boolean;
  created_at?: string;
};

type VariableRow = {
  key: string;
  label: string;
  category: string;
  valueType: string;
  isActive: boolean;
};

function inferFileType(file: File | null): "docx" | "pdf" | null {
  if (!file) return null;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  return null;
}

export default function FirmTemplatesSettingsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const firmId = user?.userType === "firm_user" ? (user.firmId ?? null) : null;

  type FilterKey = "all" | "global" | "firm" | "pdf" | "word" | "active" | "inactive";
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  const templatesQuery = useQuery<TemplateRow[]>({
    queryKey: ["templates"],
    queryFn: async () => {
      const res = await apiFetchJson("/templates");
      throwIfApiFailure(res);
      return ensureArray<TemplateRow>(res);
    },
    enabled: Boolean(firmId),
    retry: false,
  });

  const templates = templatesQuery.data ?? [];
  const sorted = useMemo(() => [...templates].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))), [templates]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchesSearch = (t: TemplateRow) => {
      if (!q) return true;
      const parts = [
        t.name,
        t.file_type,
        t.firm_id == null ? "global" : "firm",
        t.created_at ?? "",
      ].map((x) => String(x ?? "").toLowerCase());
      return parts.some((p) => p.includes(q));
    };
    const matchesFilter = (t: TemplateRow) => {
      const scope = t.firm_id == null ? "global" : "firm";
      const type = String(t.file_type ?? "").toLowerCase();
      const isActive = Boolean(t.is_active);
      if (filter === "all") return true;
      if (filter === "global") return scope === "global";
      if (filter === "firm") return scope === "firm";
      if (filter === "pdf") return type === "pdf";
      if (filter === "word") return type === "docx";
      if (filter === "active") return isActive;
      if (filter === "inactive") return !isActive;
      return true;
    };
    return sorted.filter((t) => matchesSearch(t) && matchesFilter(t));
  }, [sorted, search, filter]);

  const counts = useMemo(() => {
    const by = {
      all: sorted.length,
      global: sorted.filter((t) => t.firm_id == null).length,
      firm: sorted.filter((t) => t.firm_id != null).length,
      pdf: sorted.filter((t) => String(t.file_type ?? "").toLowerCase() === "pdf").length,
      word: sorted.filter((t) => String(t.file_type ?? "").toLowerCase() === "docx").length,
      active: sorted.filter((t) => Boolean(t.is_active)).length,
      inactive: sorted.filter((t) => !t.is_active).length,
    } satisfies Record<FilterKey, number>;
    return by;
  }, [sorted]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const [editingPdf, setEditingPdf] = useState<{ tpl: TemplateRow; url: string } | null>(null);
  const [varsOpen, setVarsOpen] = useState(false);
  const [varsSearch, setVarsSearch] = useState("");

  const variablesQuery = useQuery<VariableRow[]>({
    queryKey: ["document-variables", "active"],
    queryFn: async ({ signal }) => {
      const res = await apiFetchJson("/document-variables?active=1", { signal });
      throwIfApiFailure(res);
      return listItems<VariableRow>(res);
    },
    enabled: varsOpen,
    retry: false,
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const fileType = inferFileType(uploadFile);
      if (!uploadFile || !fileType) throw new Error("Unsupported file type");
      if (!firmId) throw new Error("Missing firm context");

      const uuid = crypto.randomUUID();
      const objectPath = `/objects/templates/firms/${firmId}/${uuid}.${fileType}`;
      const formData = new FormData();
      formData.append("file", uploadFile);
      const up = await apiFetchJson<{ objectPath: string }>(`/storage/upload?objectPath=${encodeURIComponent(objectPath)}`, { method: "POST", body: formData });
      const storagePath = up.objectPath;

      return await apiFetchJson<TemplateRow>("/templates", {
        method: "POST",
        body: JSON.stringify({
          name: uploadName,
          fileType,
          storagePath,
        }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["templates"] });
      toast({ title: "Template uploaded" });
      setUploadOpen(false);
      setUploadName("");
      setUploadFile(null);
    },
    onError: (e) => toastError(toast, e, "Upload failed"),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async (tpl: TemplateRow) => {
      return await apiFetchJson(`/templates/${tpl.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !tpl.is_active }) });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e) => toastError(toast, e, "Update failed"),
  });

  const download = async (tpl: TemplateRow) => {
    try {
      const blob = await apiFetchBlob(`/templates/${tpl.id}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = tpl.file_type?.toLowerCase() === "pdf" ? "pdf" : "docx";
      a.download = `${tpl.name || `template_${tpl.id}`}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toastError(toast, e, "Download failed");
    }
  };

  const openPdfEditor = async (tpl: TemplateRow) => {
    try {
      const blob = await apiFetchBlob(`/templates/${tpl.id}/download`);
      const url = URL.createObjectURL(blob);
      setEditingPdf({ tpl, url });
    } catch (e) {
      toastError(toast, e, "Failed to load PDF");
    }
  };

  const closePdfEditor = () => {
    if (editingPdf?.url) URL.revokeObjectURL(editingPdf.url);
    setEditingPdf(null);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Categories</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-1">
            {([
              { key: "all", label: "All templates" },
              { key: "global", label: "Global" },
              { key: "firm", label: "Firm" },
              { key: "word", label: "Word" },
              { key: "pdf", label: "PDF" },
              { key: "active", label: "Active" },
              { key: "inactive", label: "Inactive" },
            ] as Array<{ key: FilterKey; label: string }>).map((item) => {
              const active = filter === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setFilter(item.key)}
                  className={[
                    "w-full rounded-md border px-3 py-2 text-left text-sm",
                    "flex items-center justify-between gap-2",
                    active
                      ? "bg-slate-50 border-slate-200 text-slate-900"
                      : "bg-white border-transparent hover:bg-slate-50 text-slate-700",
                  ].join(" ")}
                >
                  <span className="truncate">{item.label}</span>
                  <Badge variant={active ? "default" : "secondary"}>{counts[item.key]}</Badge>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <CardTitle className="truncate">Document Templates</CardTitle>
              <div className="text-sm text-slate-500 mt-1">
                Global templates + your firm templates.
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button variant="outline" onClick={() => { setVarsOpen(true); setVarsSearch(""); }}>
                Variable Registry
              </Button>
              <Button onClick={() => setUploadOpen(true)} disabled={!firmId}>Create New Template</Button>
            </div>
          </div>
          <div className="mt-3">
            <Input
              placeholder="Search / filter templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>

        {templatesQuery.isError ? (
          <CardContent>
            {getApiFailureCodeFromError(templatesQuery.error) === "SUPPORT_SESSION_REQUIRED" ? (
              <SupportSessionRequired title="Support session required" />
            ) : (
              <QueryFallback title="Templates unavailable" error={templatesQuery.error} onRetry={() => templatesQuery.refetch()} isRetrying={templatesQuery.isFetching} />
            )}
          </CardContent>
        ) : (
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((t) => {
                const scope = t.firm_id == null ? "GLOBAL" : "FIRM";
                const isPdf = String(t.file_type || "").toLowerCase() === "pdf";
                const fileLabel = isPdf ? "PDF" : "Word";
                const canEdit = t.firm_id != null && t.firm_id === firmId;
                const created = t.created_at ? new Date(String(t.created_at)).toLocaleDateString("en-MY") : "—";
                return (
                  <div key={t.id} className="rounded-lg border border-slate-200 bg-white p-4 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={scope === "GLOBAL" ? "secondary" : "default"}>{scope}</Badge>
                          <Badge variant="secondary">{fileLabel}</Badge>
                          {!t.is_active ? <Badge variant="secondary">Inactive</Badge> : null}
                        </div>
                        <div className="mt-2 font-medium text-slate-900 truncate" title={t.name}>{t.name}</div>
                      </div>
                      <div className="text-xs text-slate-500 text-right whitespace-nowrap">{created}</div>
                    </div>

                    <div className="flex items-center justify-end gap-2 mt-auto">
                      <Button variant="outline" size="sm" onClick={() => download(t)}>Download</Button>
                      {isPdf ? (
                        <Button variant="outline" size="sm" onClick={() => openPdfEditor(t)} disabled={!canEdit}>
                          Edit PDF Mapping
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (!confirm(t.is_active ? "Delete this template? (It can be restored by activating again.)" : "Restore this template?")) return;
                          toggleActiveMutation.mutate(t);
                        }}
                        disabled={!canEdit || toggleActiveMutation.isPending}
                        className={t.is_active ? "text-red-600" : undefined}
                      >
                        {t.is_active ? "Delete" : "Restore"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>

      <Dialog open={uploadOpen} onOpenChange={(v) => setUploadOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload firm template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-1">Name</div>
              <Input value={uploadName} onChange={(e) => setUploadName(e.target.value)} placeholder="Template name" />
            </div>
            <div>
              <div className="text-sm font-medium mb-1">File (.docx / .pdf)</div>
              <Input type="file" accept=".pdf,.docx" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
              <div className="text-xs text-slate-500 mt-1">
                Uploads to templates/firms/{firmId ?? "—"}.
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button
              onClick={() => uploadMutation.mutate()}
              disabled={!uploadName.trim() || !uploadFile || !inferFileType(uploadFile) || uploadMutation.isPending}
            >
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editingPdf ? (
        <TemplatePdfMappingEditor
          open={true}
          templateId={editingPdf.tpl.id}
          templateName={editingPdf.tpl.name}
          pdfUrl={editingPdf.url}
          initialMappingConfig={editingPdf.tpl.mapping_config}
          onClose={closePdfEditor}
          onSaved={async () => {
            await qc.invalidateQueries({ queryKey: ["templates"] });
            closePdfEditor();
          }}
        />
      ) : null}

      <Dialog open={varsOpen} onOpenChange={setVarsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Variable Registry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Search variables..." value={varsSearch} onChange={(e) => setVarsSearch(e.target.value)} />
            {variablesQuery.isError ? (
              <QueryFallback title="Variables unavailable" error={variablesQuery.error} onRetry={() => variablesQuery.refetch()} isRetrying={variablesQuery.isFetching} />
            ) : variablesQuery.isLoading ? (
              <div className="text-sm text-slate-500">Loading variables...</div>
            ) : (
              <div className="max-h-[60vh] overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white border-b">
                    <tr className="text-left text-slate-500">
                      <th className="px-3 py-2">Key</th>
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2">Category</th>
                      <th className="px-3 py-2">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(variablesQuery.data ?? [])
                      .filter((v) => {
                        const q = varsSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          String(v.key ?? "").toLowerCase().includes(q) ||
                          String(v.label ?? "").toLowerCase().includes(q) ||
                          String(v.category ?? "").toLowerCase().includes(q)
                        );
                      })
                      .map((v) => (
                        <tr key={v.key} className="border-t">
                          <td className="px-3 py-2 font-mono text-xs text-slate-700">{v.key}</td>
                          <td className="px-3 py-2 text-slate-800">{v.label}</td>
                          <td className="px-3 py-2"><Badge variant="secondary">{v.category}</Badge></td>
                          <td className="px-3 py-2 text-slate-600">{v.valueType}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVarsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
