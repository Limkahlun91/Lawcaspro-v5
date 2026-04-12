import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Download, Pencil, Trash2, Upload } from "lucide-react";
import { apiErrorFromResponse } from "@/lib/http-error";
import { toastError } from "@/lib/toast-error";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

interface FirmLetterhead {
  id: number;
  firm_id: number;
  name: string;
  description: string | null;
  is_default: boolean;
  status: "active" | "inactive";
  footer_mode: "every_page" | "last_page_only";
  first_page_object_path: string;
  first_page_file_name: string;
  continuation_header_object_path: string;
  continuation_header_file_name: string;
  footer_object_path: string | null;
  footer_file_name: string | null;
  created_at: string;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  if (res.status === 204) return null;
  return res.json();
}

async function uploadDocx(file: File): Promise<{ objectPath: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const uploadRes = await fetch(`${API_BASE}/storage/upload`, {
    method: "POST",
    body: formData,
    credentials: "include",
  });
  if (!uploadRes.ok) throw await apiErrorFromResponse(uploadRes);
  return uploadRes.json();
}

export default function FirmLetterHead() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const firstRef = useRef<HTMLInputElement>(null);
  const contRef = useRef<HTMLInputElement>(null);
  const footerRef = useRef<HTMLInputElement>(null);
  const editFirstRef = useRef<HTMLInputElement>(null);
  const editContRef = useRef<HTMLInputElement>(null);
  const editFooterRef = useRef<HTMLInputElement>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [active, setActive] = useState<FirmLetterhead | null>(null);
  const [editMode, setEditMode] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [footerMode, setFooterMode] = useState<"every_page" | "last_page_only">("every_page");
  const [makeDefault, setMakeDefault] = useState(false);
  const [firstFile, setFirstFile] = useState<File | null>(null);
  const [contFile, setContFile] = useState<File | null>(null);
  const [footerFile, setFooterFile] = useState<File | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState<"active" | "inactive">("active");
  const [editFooterMode, setEditFooterMode] = useState<"every_page" | "last_page_only">("every_page");
  const [replaceFirstFile, setReplaceFirstFile] = useState<File | null>(null);
  const [replaceContFile, setReplaceContFile] = useState<File | null>(null);
  const [replaceFooterFile, setReplaceFooterFile] = useState<File | null>(null);
  const [removeFooter, setRemoveFooter] = useState(false);

  const { data: letterheads = [], isLoading } = useQuery<FirmLetterhead[]>({
    queryKey: ["firm-letterheads"],
    queryFn: () => apiFetch("/firm-letterheads"),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/firm-letterheads/${id}/set-default`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firm-letterheads"] });
      toast({ title: "Default letterhead updated" });
    },
    onError: (err) => toastError(toast, err, "Update failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/firm-letterheads/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firm-letterheads"] });
      toast({ title: "Letterhead deleted" });
      setDetailOpen(false);
      setActive(null);
      setEditMode(false);
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  async function handleSave() {
    if (!active) return;
    if (!editName.trim()) return;
    setIsSaving(true);
    try {
      const patch: Record<string, unknown> = {
        name: editName.trim(),
        description: editDescription.trim() ? editDescription.trim() : null,
        status: editStatus,
        footerMode: editFooterMode,
      };

      if (replaceFirstFile) {
        const up = await uploadDocx(replaceFirstFile);
        patch.firstPageObjectPath = up.objectPath;
        patch.firstPageFileName = replaceFirstFile.name;
        patch.firstPageMimeType = replaceFirstFile.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        patch.firstPageExtension = "docx";
        patch.firstPageFileSize = replaceFirstFile.size;
      }
      if (replaceContFile) {
        const up = await uploadDocx(replaceContFile);
        patch.continuationHeaderObjectPath = up.objectPath;
        patch.continuationHeaderFileName = replaceContFile.name;
        patch.continuationHeaderMimeType = replaceContFile.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        patch.continuationHeaderExtension = "docx";
        patch.continuationHeaderFileSize = replaceContFile.size;
      }
      if (removeFooter) {
        patch.footerObjectPath = null;
        patch.footerFileName = null;
        patch.footerMimeType = null;
        patch.footerExtension = null;
      } else if (replaceFooterFile) {
        const up = await uploadDocx(replaceFooterFile);
        patch.footerObjectPath = up.objectPath;
        patch.footerFileName = replaceFooterFile.name;
        patch.footerMimeType = replaceFooterFile.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        patch.footerExtension = "docx";
        patch.footerFileSize = replaceFooterFile.size;
      }

      await apiFetch(`/firm-letterheads/${active.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      qc.invalidateQueries({ queryKey: ["firm-letterheads"] });
      toast({ title: "Letterhead updated" });
      setEditMode(false);
      setReplaceFirstFile(null);
      setReplaceContFile(null);
      setReplaceFooterFile(null);
      setRemoveFooter(false);
      const refreshed = await apiFetch("/firm-letterheads");
      const next = (refreshed as FirmLetterhead[]).find((l) => l.id === active.id) ?? null;
      setActive(next);
    } catch (err) {
      toastError(toast, err, "Update failed");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCreate() {
    if (!name.trim() || !firstFile || !contFile) return;
    setIsCreating(true);
    try {
      const firstUp = await uploadDocx(firstFile);
      const contUp = await uploadDocx(contFile);
      const footerUp = footerFile ? await uploadDocx(footerFile) : null;

      await apiFetch("/firm-letterheads", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          footerMode,
          status: "active",
          isDefault: makeDefault,
          firstPageObjectPath: firstUp.objectPath,
          firstPageFileName: firstFile.name,
          firstPageMimeType: firstFile.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          firstPageExtension: "docx",
          firstPageFileSize: firstFile.size,
          continuationHeaderObjectPath: contUp.objectPath,
          continuationHeaderFileName: contFile.name,
          continuationHeaderMimeType: contFile.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          continuationHeaderExtension: "docx",
          continuationHeaderFileSize: contFile.size,
          footerObjectPath: footerUp?.objectPath,
          footerFileName: footerFile?.name,
          footerMimeType: footerFile?.type,
          footerExtension: footerFile ? "docx" : undefined,
          footerFileSize: footerFile?.size,
        }),
      });

      qc.invalidateQueries({ queryKey: ["firm-letterheads"] });
      toast({ title: "Letterhead created" });
      setCreateOpen(false);
      setName("");
      setDescription("");
      setFooterMode("every_page");
      setMakeDefault(false);
      setFirstFile(null);
      setContFile(null);
      setFooterFile(null);
    } catch (err) {
      toastError(toast, err, "Create failed");
    } finally {
      setIsCreating(false);
    }
  }

  async function downloadTemplate(letterheadId: number, part: "first_page" | "continuation_header" | "footer", fileName: string) {
    const res = await fetch(`${API_BASE}/firm-letterheads/${letterheadId}/templates/${part}/download`, { credentials: "include" });
    if (!res.ok) throw await apiErrorFromResponse(res);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "download";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <div>
          <CardTitle>Firm Letter Head</CardTitle>
          <p className="text-sm text-slate-500 mt-1">Manage your firm letterhead templates for letter generation.</p>
        </div>
        <Button size="sm" className="bg-amber-500 hover:bg-amber-600 gap-1.5" onClick={() => setCreateOpen(true)}>
          <Upload className="w-3.5 h-3.5" /> New Letter Head
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-slate-500 py-8 text-center">Loading...</div>
        ) : letterheads.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="font-medium text-slate-600 mb-1">No letterhead yet</p>
            <p className="text-sm">Create a letterhead to use it when generating letters.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {letterheads.map((lh) => (
              <div
                key={lh.id}
                className="flex items-center gap-3 p-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors cursor-pointer"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setActive(lh);
                  setEditName(lh.name);
                  setEditDescription(lh.description ?? "");
                  setEditStatus(lh.status);
                  setEditFooterMode(lh.footer_mode);
                  setEditMode(false);
                  setReplaceFirstFile(null);
                  setReplaceContFile(null);
                  setReplaceFooterFile(null);
                  setRemoveFooter(false);
                  setDetailOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setActive(lh);
                    setEditName(lh.name);
                    setEditDescription(lh.description ?? "");
                    setEditStatus(lh.status);
                    setEditFooterMode(lh.footer_mode);
                    setEditMode(false);
                    setReplaceFirstFile(null);
                    setReplaceContFile(null);
                    setReplaceFooterFile(null);
                    setRemoveFooter(false);
                    setDetailOpen(true);
                  }
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-900 truncate">{lh.name}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {lh.is_default && <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">Default</Badge>}
                    <Badge variant="outline">{lh.status}</Badge>
                    <Badge variant="outline">{lh.footer_mode === "every_page" ? "Footer: every page" : "Footer: last page only"}</Badge>
                  </div>
                </div>
                {!lh.is_default && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    onClick={(e) => { e.stopPropagation(); setDefaultMutation.mutate(lh.id); }}
                  >
                    Set Default
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>New Firm Letter Head</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Main Letterhead" />
            </div>
            <div className="space-y-1.5">
              <Label>Description <span className="text-slate-400 text-xs">(optional)</span></Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="resize-none text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Footer Mode</Label>
              <Select value={footerMode} onValueChange={(v) => setFooterMode(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="every_page">Every page</SelectItem>
                  <SelectItem value="last_page_only">Last page only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={makeDefault} onCheckedChange={(v) => setMakeDefault(Boolean(v))} />
              <Label className="cursor-pointer" onClick={() => setMakeDefault(v => !v)}>Set as default</Label>
            </div>

            <div className="space-y-1.5">
              <Label>First Page Template (.docx)</Label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-4 text-center cursor-pointer hover:border-amber-300 transition-colors" onClick={() => firstRef.current?.click()}>
                {firstFile ? <div className="text-sm text-slate-700 font-medium">{firstFile.name}</div> : <div className="text-sm text-slate-500">Click to select</div>}
              </div>
              <input type="file" ref={firstRef} className="hidden" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFirstFile(e.target.files?.[0] ?? null)} />
            </div>

            <div className="space-y-1.5">
              <Label>Continuation Header Template (.docx)</Label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-4 text-center cursor-pointer hover:border-amber-300 transition-colors" onClick={() => contRef.current?.click()}>
                {contFile ? <div className="text-sm text-slate-700 font-medium">{contFile.name}</div> : <div className="text-sm text-slate-500">Click to select</div>}
              </div>
              <input type="file" ref={contRef} className="hidden" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setContFile(e.target.files?.[0] ?? null)} />
            </div>

            <div className="space-y-1.5">
              <Label>Footer Template (.docx) <span className="text-slate-400 text-xs">(optional)</span></Label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-4 text-center cursor-pointer hover:border-amber-300 transition-colors" onClick={() => footerRef.current?.click()}>
                {footerFile ? <div className="text-sm text-slate-700 font-medium">{footerFile.name}</div> : <div className="text-sm text-slate-500">Click to select</div>}
              </div>
              <input type="file" ref={footerRef} className="hidden" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFooterFile(e.target.files?.[0] ?? null)} />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleCreate} disabled={!name.trim() || !firstFile || !contFile || isCreating}>
                {isCreating ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Letterhead Details</DialogTitle></DialogHeader>
          {active && (
            <div className="space-y-4">
              {!editMode ? (
                <>
                  <div className="space-y-1">
                    <div className="text-xs text-slate-500">Name</div>
                    <div className="text-sm font-medium text-slate-900">{active.name}</div>
                  </div>
                  {active.description && (
                    <div className="space-y-1">
                      <div className="text-xs text-slate-500">Description</div>
                      <div className="text-sm text-slate-700 whitespace-pre-wrap">{active.description}</div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-slate-500">Status</div>
                      <div className="text-sm text-slate-700">{active.status}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Footer Mode</div>
                      <div className="text-sm text-slate-700">{active.footer_mode === "every_page" ? "Every page" : "Last page only"}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Name</Label>
                    <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Description <span className="text-slate-400 text-xs">(optional)</span></Label>
                    <Textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={2} className="resize-none text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Status</Label>
                      <Select value={editStatus} onValueChange={(v) => setEditStatus(v as any)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">active</SelectItem>
                          <SelectItem value="inactive">inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Footer Mode</Label>
                      <Select value={editFooterMode} onValueChange={(v) => setEditFooterMode(v as any)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="every_page">Every page</SelectItem>
                          <SelectItem value="last_page_only">Last page only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="text-xs text-slate-500">Templates</div>
                <div className="flex flex-col gap-2">
                  <Button variant="outline" className="justify-between" onClick={async () => { try { await downloadTemplate(active.id, "first_page", active.first_page_file_name); } catch (e) { toastError(toast, e, "Download failed"); } }}>
                    First page <Download className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" className="justify-between" onClick={async () => { try { await downloadTemplate(active.id, "continuation_header", active.continuation_header_file_name); } catch (e) { toastError(toast, e, "Download failed"); } }}>
                    Continuation header <Download className="w-4 h-4" />
                  </Button>
                  {active.footer_object_path && active.footer_file_name && (
                    <Button variant="outline" className="justify-between" onClick={async () => { try { await downloadTemplate(active.id, "footer", active.footer_file_name!); } catch (e) { toastError(toast, e, "Download failed"); } }}>
                      Footer <Download className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>

              {editMode && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Replace First Page Template (.docx) <span className="text-slate-400 text-xs">(optional)</span></Label>
                    <div className="border-2 border-dashed border-slate-200 rounded-lg p-3 text-center cursor-pointer hover:border-amber-300 transition-colors" onClick={() => editFirstRef.current?.click()}>
                      {replaceFirstFile ? <div className="text-sm text-slate-700 font-medium">{replaceFirstFile.name}</div> : <div className="text-sm text-slate-500">Click to select</div>}
                    </div>
                    <input type="file" ref={editFirstRef} className="hidden" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setReplaceFirstFile(e.target.files?.[0] ?? null)} />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Replace Continuation Header Template (.docx) <span className="text-slate-400 text-xs">(optional)</span></Label>
                    <div className="border-2 border-dashed border-slate-200 rounded-lg p-3 text-center cursor-pointer hover:border-amber-300 transition-colors" onClick={() => editContRef.current?.click()}>
                      {replaceContFile ? <div className="text-sm text-slate-700 font-medium">{replaceContFile.name}</div> : <div className="text-sm text-slate-500">Click to select</div>}
                    </div>
                    <input type="file" ref={editContRef} className="hidden" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setReplaceContFile(e.target.files?.[0] ?? null)} />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label>Footer Template (.docx) <span className="text-slate-400 text-xs">(optional)</span></Label>
                      {active.footer_object_path && (
                        <Button size="sm" variant="outline" onClick={() => { setRemoveFooter(true); setReplaceFooterFile(null); }}>
                          Remove footer
                        </Button>
                      )}
                    </div>
                    <div className="border-2 border-dashed border-slate-200 rounded-lg p-3 text-center cursor-pointer hover:border-amber-300 transition-colors" onClick={() => editFooterRef.current?.click()}>
                      {removeFooter ? <div className="text-sm text-slate-700 font-medium">Footer will be removed</div> : replaceFooterFile ? <div className="text-sm text-slate-700 font-medium">{replaceFooterFile.name}</div> : <div className="text-sm text-slate-500">Click to select</div>}
                    </div>
                    <input type="file" ref={editFooterRef} className="hidden" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => { setRemoveFooter(false); setReplaceFooterFile(e.target.files?.[0] ?? null); }} />
                  </div>
                </div>
              )}

              <div className="pt-2 flex gap-2 justify-end">
                <Button
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setEditMode((v) => !v)}
                >
                  <Pencil className="w-4 h-4" /> {editMode ? "Cancel Edit" : "Edit"}
                </Button>
                {!active.is_default && (
                  <Button variant="outline" onClick={() => setDefaultMutation.mutate(active.id)}>Set Default</Button>
                )}
                {editMode && (
                  <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleSave} disabled={!editName.trim() || isSaving}>
                    {isSaving ? "Saving..." : "Save"}
                  </Button>
                )}
                <Button variant="destructive" className="gap-1.5" onClick={() => deleteMutation.mutate(active.id)}>
                  <Trash2 className="w-4 h-4" /> Delete
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

