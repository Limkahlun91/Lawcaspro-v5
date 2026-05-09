import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlatformPage, PlatformPageHeader } from "@/components/platform/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { ensureArray } from "@/lib/list-items";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { TemplatePdfMappingEditor } from "@/components/TemplatePdfMappingEditor";

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

type Firm = { id: number; name: string };

function inferFileType(file: File | null): "docx" | "pdf" | null {
  if (!file) return null;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  return null;
}

function inferExt(fileType: "docx" | "pdf"): string {
  return fileType;
}

export default function PlatformTemplates() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const templatesQuery = useQuery<TemplateRow[]>({
    queryKey: ["templates"],
    queryFn: async () => {
      return ensureArray<TemplateRow>(await apiFetchJson("/templates"));
    },
    retry: false,
  });

  const firmsQuery = useQuery<Firm[]>({
    queryKey: ["platform-firms-list"],
    queryFn: async () => {
      return ensureArray<Firm>(await apiFetchJson("/platform/firms?limit=100"));
    },
    retry: false,
  });

  const firms = firmsQuery.data ?? [];
  const templates = templatesQuery.data ?? [];

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadScope, setUploadScope] = useState<"global" | "firm">("global");
  const [uploadFirmId, setUploadFirmId] = useState<string>("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const [editingPdf, setEditingPdf] = useState<{ tpl: TemplateRow; url: string } | null>(null);

  const sorted = useMemo(() => {
    return [...templates].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  }, [templates]);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const fileType = inferFileType(uploadFile);
      if (!uploadFile || !fileType) throw new Error("Unsupported file type");
      const firmId = uploadScope === "global" ? null : Number(uploadFirmId || 0);
      if (uploadScope === "firm" && (!firmId || Number.isNaN(firmId))) throw new Error("Firm is required");

      const uuid = crypto.randomUUID();
      const ext = inferExt(fileType);
      const objectPath = firmId === null
        ? `/objects/templates/global/${uuid}.${ext}`
        : `/objects/templates/firms/${firmId}/${uuid}.${ext}`;

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
          firmId,
        }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["templates"] });
      toast({ title: "Template uploaded" });
      setUploadOpen(false);
      setUploadName("");
      setUploadScope("global");
      setUploadFirmId("");
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
    <PlatformPage>
      <PlatformPageHeader
        title="Templates"
        description="Manage global and firm-specific document templates."
        actions={
          <Button onClick={() => setUploadOpen(true)}>Upload template</Button>
        }
      />

      {templatesQuery.isError ? (
        <QueryFallback title="Templates unavailable" error={templatesQuery.error} onRetry={() => templatesQuery.refetch()} isRetrying={templatesQuery.isFetching} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All templates</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Scope</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t) => {
                  const scope = t.firm_id == null ? "Global" : `Firm · ${t.firm_name || `#${t.firm_id}`}`;
                  const isPdf = String(t.file_type || "").toLowerCase() === "pdf";
                  return (
                    <tr key={t.id} className="border-t">
                      <td className="py-3 pr-3">{t.name}</td>
                      <td className="py-3 pr-3">{scope}</td>
                      <td className="py-3 pr-3"><Badge variant="secondary">{String(t.file_type).toUpperCase()}</Badge></td>
                      <td className="py-3 pr-3">
                        {t.is_active ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                      </td>
                      <td className="py-3 pr-0">
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => download(t)}>Download</Button>
                          {isPdf ? <Button variant="outline" size="sm" onClick={() => openPdfEditor(t)}>PDF mapping</Button> : null}
                          <Button variant="outline" size="sm" onClick={() => toggleActiveMutation.mutate(t)} disabled={toggleActiveMutation.isPending}>
                            {t.is_active ? "Deactivate" : "Activate"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Dialog open={uploadOpen} onOpenChange={(v) => setUploadOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-1">Name</div>
              <Input value={uploadName} onChange={(e) => setUploadName(e.target.value)} placeholder="Template name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-sm font-medium mb-1">Scope</div>
                <Select value={uploadScope} onValueChange={(v) => setUploadScope(v === "firm" ? "firm" : "global")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="firm">Firm-specific</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-sm font-medium mb-1">Firm</div>
                <Select value={uploadFirmId} onValueChange={setUploadFirmId} disabled={uploadScope !== "firm"}>
                  <SelectTrigger><SelectValue placeholder={uploadScope === "firm" ? "Select firm" : "Global"} /></SelectTrigger>
                  <SelectContent>
                    {firms.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1">File (.docx / .pdf)</div>
              <Input type="file" accept=".pdf,.docx" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
              <div className="text-xs text-slate-500 mt-1">
                Uploads to {uploadScope === "global" ? "templates/global" : "templates/firms/[firm_id]"}.
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button
              onClick={() => uploadMutation.mutate()}
              disabled={!uploadName.trim() || !uploadFile || !inferFileType(uploadFile) || (uploadScope === "firm" && !uploadFirmId) || uploadMutation.isPending}
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
    </PlatformPage>
  );
}
