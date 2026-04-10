import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ChevronRight, Download, FileText, Folder, FolderOpen, Plus, Trash2, Upload } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

interface FirmFolder {
  id: number;
  firm_id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  created_at: string;
}

interface FirmDocument {
  id: number;
  name: string;
  document_type: string;
  description: string | null;
  file_name: string;
  object_path: string;
  created_at: string;
  folder_id: number | null;
  kind: "template" | "reference";
  mime_type: string | null;
  extension: string | null;
  file_size: number | null;
  is_template_capable: boolean;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  spa: "SPA",
  loan_agreement: "Loan Agreement",
  letter_of_offer: "Letter of Offer",
  mot: "MOT",
  noa: "Notice of Assignment",
  power_of_attorney: "Power of Attorney",
  stamping_receipt: "Stamping Receipt",
  acting_letter: "Acting Letter",
  undertaking: "Undertaking",
  other: "Other",
};

const ACCEPTED_EXTENSIONS = [
  ".docx", ".doc", ".pdf", ".xlsx", ".xls", ".csv", ".pptx", ".txt", ".jpg", ".jpeg", ".png",
];

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

async function uploadFile(file: File): Promise<{ objectPath: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const uploadRes = await fetch(`${API_BASE}/storage/upload`, {
    method: "POST",
    body: formData,
    credentials: "include",
  });
  if (!uploadRes.ok) throw new Error("Upload to storage failed");
  return uploadRes.json();
}

function objectPathToDownloadUrl(objectPath: string): string {
  const pathPart = objectPath.replace(/^\/objects\//, "");
  return `${API_BASE}/storage/objects/${pathPart}`;
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildFolderPath(folders: FirmFolder[], folderId: number | null): string {
  if (folderId === null) return "All Documents";
  const selected = folders.find(f => f.id === folderId);
  if (!selected) return "All Documents";
  const parts: string[] = [];
  let current: FirmFolder | undefined = selected;
  while (current) {
    parts.unshift(current.name);
    current = current.parent_id === null ? undefined : folders.find(f => f.id === current!.parent_id);
  }
  return parts.join(" / ");
}

function FolderTree({
  folders,
  selectedId,
  onSelect,
}: {
  folders: FirmFolder[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  function Item({ folder, depth = 0 }: { folder: FirmFolder; depth?: number }) {
    const children = folders.filter(f => f.parent_id === folder.id).sort((a, b) => a.name.localeCompare(b.name));
    const [expanded, setExpanded] = useState(true);
    const isSelected = selectedId === folder.id;

    return (
      <div>
        <div
          className={cn(
            "flex items-center gap-1.5 py-1.5 px-2 rounded cursor-pointer text-xs transition-colors",
            isSelected ? "bg-amber-50 text-amber-700 font-medium" : "hover:bg-slate-50 text-slate-600"
          )}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          onClick={() => onSelect(folder.id)}
        >
          {children.length > 0 ? (
            <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }} className="p-0.5">
              <ChevronRight className={cn("w-3 h-3 transition-transform", expanded && "rotate-90")} />
            </button>
          ) : <span className="w-4" />}
          {isSelected ? <FolderOpen className="w-3.5 h-3.5 shrink-0" /> : <Folder className="w-3.5 h-3.5 shrink-0" />}
          <span className="truncate">{folder.name}</span>
        </div>
        {expanded && children.map(c => <Item key={c.id} folder={c} depth={depth + 1} />)}
      </div>
    );
  }

  const roots = folders.filter(f => f.parent_id === null).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          "flex items-center gap-1.5 py-1.5 px-2 rounded cursor-pointer text-xs transition-colors",
          selectedId === null ? "bg-amber-50 text-amber-700 font-medium" : "hover:bg-slate-50 text-slate-600"
        )}
        onClick={() => onSelect(null)}
      >
        <FolderOpen className="w-3.5 h-3.5" />
        <span>All Documents</span>
      </div>
      {roots.map(f => <Item key={f.id} folder={f} />)}
    </div>
  );
}

export default function FirmDocuments() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFolderOpen, setRenameFolderOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<number | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");

  const [docName, setDocName] = useState("");
  const [docKind, setDocKind] = useState<"template" | "reference">("template");
  const [docType, setDocType] = useState("other");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { data: folders = [] } = useQuery<FirmFolder[]>({
    queryKey: ["firm-document-folders"],
    queryFn: () => apiFetch("/firm-document-folders"),
  });

  const { data: docs = [], isLoading } = useQuery<FirmDocument[]>({
    queryKey: ["firm-documents"],
    queryFn: () => apiFetch("/document-templates"),
  });

  const createFolderMutation = useMutation({
    mutationFn: (payload: { name: string; parentId: number | null }) =>
      apiFetch("/firm-document-folders", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firm-document-folders"] });
      toast({ title: "Folder created" });
      setCreateFolderOpen(false);
      setNewFolderName("");
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  const renameFolderMutation = useMutation({
    mutationFn: (payload: { folderId: number; name: string }) =>
      apiFetch(`/firm-document-folders/${payload.folderId}`, { method: "PATCH", body: JSON.stringify({ name: payload.name }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firm-document-folders"] });
      toast({ title: "Folder renamed" });
      setRenameFolderOpen(false);
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (folderId: number) => apiFetch(`/firm-document-folders/${folderId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firm-document-folders"] });
      toast({ title: "Folder deleted" });
      setSelectedFolderId(null);
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  const deleteDocMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/document-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "Document deleted" });
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  const moveDocMutation = useMutation({
    mutationFn: (payload: { id: number; folderId: number | null; kind?: "template" | "reference" }) =>
      apiFetch(`/document-templates/${payload.id}`, { method: "PATCH", body: JSON.stringify({ folderId: payload.folderId, kind: payload.kind }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "Document updated" });
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  const filteredDocs = useMemo(() => {
    return selectedFolderId === null ? docs : docs.filter(d => d.folder_id === selectedFolderId);
  }, [docs, selectedFolderId]);

  const folderOptions = useMemo(() => {
    const byParent = new Map<number | null, FirmFolder[]>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), f]);
    }
    for (const [k, arr] of byParent) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
      byParent.set(k, arr);
    }
    const out: Array<{ id: number; label: string }> = [];
    const walk = (parentId: number | null, prefix: string) => {
      const children = byParent.get(parentId) ?? [];
      for (const c of children) {
        out.push({ id: c.id, label: `${prefix}${c.name}` });
        walk(c.id, `${prefix}— `);
      }
    };
    walk(null, "");
    return out;
  }, [folders]);

  async function handleUpload() {
    if (!selectedFile || !docName.trim()) return;
    setIsUploading(true);
    try {
      const ext = selectedFile.name.includes(".") ? selectedFile.name.split(".").pop()!.toLowerCase() : "";
      const kind = ext === "docx" ? docKind : "reference";
      const uploaded = await uploadFile(selectedFile);

      await apiFetch("/document-templates", {
        method: "POST",
        body: JSON.stringify({
          name: docName.trim(),
          documentType: kind === "template" ? docType : "other",
          objectPath: uploaded.objectPath,
          fileName: selectedFile.name,
          folderId: selectedFolderId,
          kind,
          mimeType: selectedFile.type || "application/octet-stream",
          extension: ext,
          fileSize: selectedFile.size,
        }),
      });

      qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "Uploaded" });
      setUploadOpen(false);
      setDocName("");
      setDocKind("template");
      setDocType("other");
      setSelectedFile(null);
    } catch (err) {
      toast({ title: "Upload failed", description: String(err), variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDownload(doc: FirmDocument) {
    try {
      const res = await fetch(objectPathToDownloadUrl(doc.object_path), { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.file_name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: "Download failed", description: String(err), variant: "destructive" });
    }
  }

  const selectedFolder = folders.find(f => f.id === selectedFolderId);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <div>
            <CardTitle>Firm Documents</CardTitle>
            <p className="text-sm text-slate-500 mt-1">Upload templates and reference files. Only .docx templates are usable for generation.</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setNewFolderName(""); setNewFolderParentId(null); setCreateFolderOpen(true); }}>
              <Plus className="w-3.5 h-3.5" /> New Folder
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setNewFolderName(""); setNewFolderParentId(selectedFolderId); setCreateFolderOpen(true); }} disabled={selectedFolderId === null}>
              <Plus className="w-3.5 h-3.5" /> New Subfolder
            </Button>
            <Button size="sm" className="bg-amber-500 hover:bg-amber-600 gap-1.5" onClick={() => setUploadOpen(true)}>
              <Upload className="w-3.5 h-3.5" /> Upload
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            <div className="w-56 shrink-0 border rounded-lg p-2">
              <FolderTree folders={folders} selectedId={selectedFolderId} onSelect={setSelectedFolderId} />
              {selectedFolderId !== null && (
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => { setRenameFolderName(selectedFolder?.name ?? ""); setRenameFolderOpen(true); }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="w-full"
                    onClick={() => deleteFolderMutation.mutate(selectedFolderId)}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>

            <div className="flex-1">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium text-slate-800">{buildFolderPath(folders, selectedFolderId)}</div>
              </div>

              {isLoading ? (
                <div className="text-slate-500 py-8 text-center">Loading...</div>
              ) : filteredDocs.length === 0 ? (
                <div className="text-center py-10 text-slate-500">
                  <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                  <p className="font-medium text-slate-600 mb-1">No documents here</p>
                  <p className="text-sm">Upload files and organize them into folders.</p>
                </div>
              ) : (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium text-slate-600">Name</th>
                        <th className="text-left px-4 py-2 font-medium text-slate-600">Type</th>
                        <th className="text-left px-4 py-2 font-medium text-slate-600">Folder</th>
                        <th className="text-left px-4 py-2 font-medium text-slate-600">Size</th>
                        <th className="text-right px-4 py-2 font-medium text-slate-600">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDocs.map(doc => (
                        <tr key={doc.id} className="border-b last:border-b-0 hover:bg-slate-50/50">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="font-medium text-slate-900 truncate">{doc.name}</div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-xs text-slate-400 truncate">{doc.file_name}</span>
                                  <Badge variant="outline" className="text-[10px]">{(doc.extension || doc.file_name.split(".").pop() || "").toUpperCase()}</Badge>
                                  {doc.is_template_capable ? (
                                    <Badge className="bg-emerald-50 text-emerald-700 hover:bg-emerald-50 text-[10px]">Template-capable</Badge>
                                  ) : (
                                    <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100 text-[10px]">Reference only</Badge>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-xs">{DOCUMENT_TYPE_LABELS[doc.document_type] ?? doc.document_type}</Badge>
                          </td>
                          <td className="px-4 py-3">
                            <Select
                              value={doc.folder_id === null ? "none" : String(doc.folder_id)}
                              onValueChange={(v) => moveDocMutation.mutate({ id: doc.id, folderId: v === "none" ? null : Number(v) })}
                            >
                              <SelectTrigger className="h-8 w-[200px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Unfiled</SelectItem>
                                {folderOptions.map(o => (
                                  <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="px-4 py-3 text-slate-500 text-xs">{formatFileSize(doc.file_size)}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-1">
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-slate-700" onClick={() => handleDownload(doc)}>
                                <Download className="w-4 h-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-red-600" onClick={() => deleteDocMutation.mutate(doc.id)}>
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New Folder</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="e.g. Conveyancing" />
            </div>
            <div className="space-y-1.5">
              <Label>Parent <span className="text-slate-400 text-xs">(optional)</span></Label>
              <Select value={newFolderParentId === null ? "none" : String(newFolderParentId)} onValueChange={(v) => setNewFolderParentId(v === "none" ? null : Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No parent</SelectItem>
                  {folderOptions.map(o => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600" onClick={() => createFolderMutation.mutate({ name: newFolderName.trim(), parentId: newFolderParentId })} disabled={!newFolderName.trim()}>
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameFolderOpen} onOpenChange={setRenameFolderOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Rename Folder</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={renameFolderName} onChange={(e) => setRenameFolderName(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setRenameFolderOpen(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600" onClick={() => selectedFolderId !== null && renameFolderMutation.mutate({ folderId: selectedFolderId, name: renameFolderName.trim() })} disabled={!renameFolderName.trim() || selectedFolderId === null}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Upload Firm Document</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="e.g. Standard SPA Template / Logo / Reference PDF" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={docKind} onValueChange={(v) => setDocKind(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="template">Template-like</SelectItem>
                    <SelectItem value="reference">Reference-only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Document Type</Label>
                <Select value={docType} onValueChange={setDocType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(DOCUMENT_TYPE_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>File</Label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-amber-300 transition-colors" onClick={() => uploadRef.current?.click()}>
                {selectedFile ? (
                  <div className="text-sm text-slate-700 font-medium">{selectedFile.name}</div>
                ) : (
                  <div>
                    <p className="text-sm text-slate-500 mb-1">Click to select a file</p>
                    <p className="text-xs text-slate-400">{ACCEPTED_EXTENSIONS.join(" ")}</p>
                  </div>
                )}
              </div>
              <input
                type="file"
                ref={uploadRef}
                className="hidden"
                accept={ACCEPTED_EXTENSIONS.join(",")}
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleUpload} disabled={!selectedFile || !docName.trim() || isUploading}>
                {isUploading ? "Uploading..." : "Upload"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
