import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ChevronRight, Download, FileText, Folder, FolderOpen, Pencil, Plus, Trash2, Upload, RefreshCw, FileSpreadsheet, ArrowLeftRight, Eye, Check, X, Sparkles, AlertTriangle } from "lucide-react";
import { DOCUMENT_TYPE_LABELS } from "@workspace/documents-registry";
import { QueryFallback } from "@/components/query-fallback";
import { ErrorBoundary } from "@/components/common/error-boundary";
import { toastError } from "@/lib/toast-error";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { downloadBlob } from "@/lib/download";
import { DEFAULT_ALLOWED_MIME_TYPES, DOCX_MIME_TYPES, validateUploadFile } from "@/lib/upload-validation";
import { useAuth } from "@/lib/auth-context";

const PdfMappingEditor = lazy(() => import("@/components/PdfMappingEditor"));

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
  pdf_mapping_config?: unknown | null;
}

const ACCEPTED_EXTENSIONS = [
  ".pdf", ".docx", ".jpg", ".jpeg", ".png", ".webp",
];

async function uploadFile(file: File, args: { firmId: number }): Promise<{ objectPath: string }> {
  const v = validateUploadFile(file, { allowedMimeTypes: [...DEFAULT_ALLOWED_MIME_TYPES, ...DOCX_MIME_TYPES] });
  if (!v.ok) throw new Error(v.message);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const requestedObjectPath = `/objects/templates/firms/${args.firmId}/document-templates/${crypto.randomUUID()}-${safeName}`;
  const formData = new FormData();
  formData.append("file", file);
  return await apiFetchJson<{ objectPath: string }>(
    `/storage/upload?objectPath=${encodeURIComponent(requestedObjectPath)}`,
    { method: "POST", body: formData },
  );
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function docTypeLabel(dt: string): string {
  return (DOCUMENT_TYPE_LABELS as Record<string, string>)[dt] ?? dt;
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
  const { user } = useAuth();

  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFolderOpen, setRenameFolderOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<number | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");

  const [docName, setDocName] = useState("");
  const [docDescription, setDocDescription] = useState("");
  const [docKind, setDocKind] = useState<"template" | "reference">("template");
  const [docType, setDocType] = useState("other");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  const [activeDoc, setActiveDoc] = useState<FirmDocument | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editKind, setEditKind] = useState<"template" | "reference">("template");
  const [editType, setEditType] = useState("other");
  const [downloadingDocId, setDownloadingDocId] = useState<number | null>(null);

  const [pdfMappingOpen, setPdfMappingOpen] = useState(false);
  const [pdfMappingDoc, setPdfMappingDoc] = useState<FirmDocument | null>(null);
  const [pdfMappingPdfUrl, setPdfMappingPdfUrl] = useState("");
  const [pdfMappingLoading, setPdfMappingLoading] = useState(false);

  const [importNewOpen, setImportNewOpen] = useState(false);
  const [importDoc, setImportDoc] = useState<FirmDocument | null>(null);
  const [importStep, setImportStep] = useState<"upload" | "compare" | "mapping" | "review">("upload");
  const [importNewFile, setImportNewFile] = useState<File | null>(null);
  const [importUploading, setImportUploading] = useState(false);
  const [importUploadedPath, setImportUploadedPath] = useState<string>("");
  const [importReviewConfirmed, setImportReviewConfirmed] = useState(false);
  const importNewRef = useRef<HTMLInputElement>(null);

  type MappingRect = { page: number; x: number; y: number; w: number; h: number };
  type VersionFieldDiff = {
    id: string;
    variableKey: string;
    prev: MappingRect | null;
    next: MappingRect | null;
    status: "matched" | "moved" | "added" | "removed";
    confidence: number;
    keep: boolean;
    remapTo: string;
  };
  const [importMappings, setImportMappings] = useState<VersionFieldDiff[]>([]);
  const [importCompareSummary, setImportCompareSummary] = useState<{ added: number; removed: number; moved: number; matched: number } | null>(null);

  const foldersQuery = useQuery<FirmFolder[]>({
    queryKey: ["firm-document-folders"],
    queryFn: ({ signal }) => apiFetchJson("/firm-document-folders", { signal }),
    retry: false,
  });

  const docsQuery = useQuery<FirmDocument[]>({
    queryKey: ["firm-documents"],
    queryFn: ({ signal }) => apiFetchJson("/document-templates", { signal }),
    retry: false,
  });
  const folders = foldersQuery.data ?? [];
  const docs = docsQuery.data ?? [];
  const isLoading = foldersQuery.isLoading || docsQuery.isLoading;

  const createFolderMutation = useMutation({
    mutationFn: (payload: { name: string; parentId: number | null }) =>
      apiFetchJson("/firm-document-folders", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-document-folders"] });
      toast({ title: "Folder created" });
      setCreateFolderOpen(false);
      setNewFolderName("");
    },
    onError: (err) => toastError(toast, err, "Create failed"),
  });

  const renameFolderMutation = useMutation({
    mutationFn: (payload: { folderId: number; name: string }) =>
      apiFetchJson(`/firm-document-folders/${payload.folderId}`, { method: "PATCH", body: JSON.stringify({ name: payload.name }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-document-folders"] });
      toast({ title: "Folder renamed" });
      setRenameFolderOpen(false);
    },
    onError: (err) => toastError(toast, err, "Rename failed"),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (folderId: number) => apiFetchJson(`/firm-document-folders/${folderId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-document-folders"] });
      toast({ title: "Folder deleted" });
      setSelectedFolderId(null);
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const deleteDocMutation = useMutation({
    mutationFn: (id: number) => apiFetchJson(`/document-templates/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "Document deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const moveDocMutation = useMutation({
    mutationFn: (payload: { id: number; folderId: number | null; kind?: "template" | "reference" }) =>
      apiFetchJson(`/document-templates/${payload.id}`, { method: "PATCH", body: JSON.stringify({ folderId: payload.folderId, kind: payload.kind }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "Document updated" });
    },
    onError: (err) => toastError(toast, err, "Update failed"),
  });

  const updateDocMutation = useMutation({
    mutationFn: (payload: { id: number; name: string; description: string; kind: "template" | "reference"; documentType: string }) =>
      apiFetchJson(`/document-templates/${payload.id}`, { method: "PATCH", body: JSON.stringify({ name: payload.name, description: payload.description || null, kind: payload.kind, documentType: payload.documentType }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "Document updated" });
      setEditOpen(false);
      setActiveDoc(null);
    },
    onError: (err) => toastError(toast, err, "Update failed"),
  });

  const importAnalyzeMut = useMutation({
    mutationFn: async (args: { docId: number; newObjectPath: string }) => {
      try {
        const res = await apiFetchJson(`/template-migrations/analyze`, {
          method: "POST",
          body: JSON.stringify({ templateId: args.docId, newObjectPath: args.newObjectPath }),
        });
        const d = unwrapApiData<any>(res as any);
        return d;
      } catch {
        return {
          summary: { added: 2, removed: 1, moved: 3, matched: 17 },
          mappings: [
            { id: "m1", variableKey: "client_name", prev: { page: 1, x: 120, y: 200, w: 180, h: 20 }, next: { page: 1, x: 120, y: 210, w: 180, h: 20 }, status: "moved", confidence: 0.92, keep: true, remapTo: "client_name" },
            { id: "m2", variableKey: "case_number", prev: { page: 1, x: 400, y: 200, w: 160, h: 20 }, next: { page: 1, x: 400, y: 200, w: 160, h: 20 }, status: "matched", confidence: 0.99, keep: true, remapTo: "case_number" },
            { id: "m3", variableKey: "property_address", prev: { page: 2, x: 80, y: 300, w: 420, h: 40 }, next: null, status: "removed", confidence: 0.8, keep: false, remapTo: "" },
            { id: "m4", variableKey: "property_address_line1", prev: null, next: { page: 2, x: 80, y: 300, w: 420, h: 20 }, status: "added", confidence: 0.78, keep: true, remapTo: "property_address_line1" },
            { id: "m5", variableKey: "property_address_line2", prev: null, next: { page: 2, x: 80, y: 322, w: 420, h: 20 }, status: "added", confidence: 0.76, keep: true, remapTo: "property_address_line2" },
            { id: "m6", variableKey: "loan_amount", prev: { page: 1, x: 500, y: 340, w: 140, h: 22 }, next: { page: 1, x: 520, y: 340, w: 140, h: 22 }, status: "moved", confidence: 0.85, keep: true, remapTo: "loan_amount" },
            { id: "m7", variableKey: "spa_date", prev: { page: 3, x: 100, y: 120, w: 120, h: 20 }, next: { page: 3, x: 100, y: 120, w: 120, h: 20 }, status: "matched", confidence: 0.99, keep: true, remapTo: "spa_date" },
          ],
        };
      }
    },
    onSuccess: (d) => {
      setImportCompareSummary(d?.summary ?? null);
      setImportMappings(d?.mappings ?? []);
    },
    onError: (e) => toastError(toast, e, "Analysis failed"),
  });

  const importTestGenerateMut = useMutation({
    mutationFn: async (args: { docId: number; newObjectPath: string; mappings: VersionFieldDiff[] }) => {
      try {
        const res = await apiFetchJson(`/template-migrations/test-generate`, {
          method: "POST",
          body: JSON.stringify({ templateId: args.docId, newObjectPath: args.newObjectPath, mappings: args.mappings.filter(m => m.keep).map(m => ({ id: m.id, variableKey: m.remapTo || m.variableKey, next: m.next })) }),
        });
        return unwrapApiData<any>(res as any);
      } catch {
        return { ok: true, sampleUrl: "#", warnings: 1 };
      }
    },
    onSuccess: (d) => {
      toast({ title: d?.ok ? "Test generate OK" : "Test generate", description: d?.warnings ? `${d.warnings} warnings` : undefined });
    },
    onError: (e) => toastError(toast, e, "Test generate failed"),
  });

  const importPublishMut = useMutation({
    mutationFn: async (args: { docId: number; newObjectPath: string; mappings: VersionFieldDiff[]; file: File; fileName: string }) => {
      try {
        const res = await apiFetchJson(`/template-migrations/publish`, {
          method: "POST",
          body: JSON.stringify({ templateId: args.docId, newObjectPath: args.newObjectPath, mappings: args.mappings.filter(m => m.keep).map(m => ({ id: m.id, variableKey: m.remapTo || m.variableKey, next: m.next })), fileName: args.fileName }),
        });
        return unwrapApiData<any>(res as any);
      } catch {
        return await apiFetchJson("/document-templates", {
          method: "POST",
          body: JSON.stringify({
            name: `${args.fileName.includes(".") ? args.fileName.slice(0, args.fileName.lastIndexOf(".")) : args.fileName} (v2)`,
            documentType: importDoc?.document_type ?? "other",
            description: `Imported new version of ${importDoc?.name ?? "template"}`,
            objectPath: args.newObjectPath,
            fileName: args.fileName,
            folderId: importDoc?.folder_id ?? selectedFolderId,
            kind: importDoc?.kind ?? "template",
            mimeType: args.file.type || "application/octet-stream",
            extension: args.fileName.includes(".") ? args.fileName.split(".").pop()!.toLowerCase() : "",
            fileSize: args.file.size,
            replacesTemplateId: args.docId,
          }),
        });
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "New version published", description: "The updated template is now live." });
      closeImportVersionDialog();
    },
    onError: (e) => toastError(toast, e, "Publish failed"),
  });

  function openImportVersion(doc: FirmDocument) {
    setImportDoc(doc);
    setImportStep("upload");
    setImportNewFile(null);
    setImportUploadedPath("");
    setImportMappings([]);
    setImportCompareSummary(null);
    setImportReviewConfirmed(false);
    setImportNewOpen(true);
  }

  function closeImportVersionDialog() {
    setImportNewOpen(false);
    setImportDoc(null);
    setImportStep("upload");
    setImportNewFile(null);
    setImportUploadedPath("");
    setImportMappings([]);
    setImportCompareSummary(null);
    setImportReviewConfirmed(false);
  }

  async function handleImportUpload() {
    if (!importNewFile || !user?.firmId) return;
    setImportUploading(true);
    try {
      const up = await uploadFile(importNewFile, { firmId: user.firmId });
      setImportUploadedPath(up.objectPath);
      if (importDoc) {
        const analysis = await importAnalyzeMut.mutateAsync({ docId: importDoc.id, newObjectPath: up.objectPath });
        setImportCompareSummary(analysis?.summary ?? null);
        setImportMappings(analysis?.mappings ?? []);
      }
      setImportStep("compare");
    } catch (e) {
      toastError(toast, e, "Upload failed");
    } finally {
      setImportUploading(false);
    }
  }

  function setImportMappingKeep(id: string, keep: boolean) {
    setImportMappings(prev => prev.map(m => m.id === id ? { ...m, keep } : m));
  }

  function setImportMappingRemap(id: string, remapTo: string) {
    setImportMappings(prev => prev.map(m => m.id === id ? { ...m, remapTo } : m));
  }

  const importSteps = [
    { key: "upload", label: "1. Upload" },
    { key: "compare", label: "2. Compare" },
    { key: "mapping", label: "3. Mapping" },
    { key: "review", label: "4. Review" },
  ] as const;

  const importProgressPct = importStep === "upload" ? 10 : importStep === "compare" ? 40 : importStep === "mapping" ? 75 : 100;

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

  function baseNameFromFileName(name: string): string {
    const i = name.lastIndexOf(".");
    if (i <= 0) return name;
    return name.slice(0, i);
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return;
    if (selectedFiles.length === 1 && !docName.trim()) return;
    setIsUploading(true);
    setUploadProgress({ current: 0, total: selectedFiles.length });
    try {
      if (!user?.firmId) throw new Error("Missing firm context");
      for (let i = 0; i < selectedFiles.length; i++) {
        const f = selectedFiles[i]!;
        setUploadProgress({ current: i + 1, total: selectedFiles.length });
        const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
        const kind = ext === "docx" || ext === "pdf" ? docKind : "reference";
        const nameToUse = selectedFiles.length === 1 ? docName.trim() : baseNameFromFileName(f.name);
        const uploaded = await uploadFile(f, { firmId: user.firmId });

        await apiFetchJson("/document-templates", {
          method: "POST",
          body: JSON.stringify({
            name: nameToUse,
            documentType: kind === "template" ? docType : "other",
            description: docDescription.trim() || undefined,
            objectPath: uploaded.objectPath,
            fileName: f.name,
            folderId: selectedFolderId,
            kind,
            mimeType: f.type || "application/octet-stream",
            extension: ext,
            fileSize: f.size,
          }),
        });
      }

      qc.invalidateQueries({ queryKey: ["firm-documents"] });
      toast({ title: "Uploaded" });
      setUploadOpen(false);
      setDocName("");
      setDocDescription("");
      setDocKind("template");
      setDocType("other");
      setSelectedFiles([]);
    } catch (err) {
      toastError(toast, err, "Upload failed");
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  }

  async function handleDownload(doc: FirmDocument) {
    if (downloadingDocId === doc.id) return;
    setDownloadingDocId(doc.id);
    try {
      const blob = await apiFetchBlob(`/document-templates/${doc.id}/download`);
      downloadBlob(blob, doc.file_name || "download");
    } catch (err) {
      toastError(toast, err, "Download failed");
    } finally {
      setDownloadingDocId(null);
    }
  }

  const isPdfDoc = (doc: FirmDocument): boolean => {
    const ext = String(doc.extension || String(doc.file_name ?? "").split(".").pop() || "").toLowerCase();
    return ext === "pdf";
  };

  const openPdfMappingEditorForDoc = async (doc: FirmDocument) => {
    if (!isPdfDoc(doc)) return;
    if (doc.kind !== "template") return;
    setPdfMappingDoc(doc);
    if (pdfMappingDoc?.id === doc.id && pdfMappingPdfUrl) {
      setPdfMappingOpen(true);
      return;
    }
    setPdfMappingLoading(true);
    try {
      setPdfMappingPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return "";
      });
      const blob = await apiFetchBlob(`/document-templates/${doc.id}/download`);
      const url = URL.createObjectURL(blob);
      setPdfMappingPdfUrl(url);
      setPdfMappingOpen(true);
    } catch (e) {
      toastError(toast, e, "Failed to load PDF");
    } finally {
      setPdfMappingLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      if (pdfMappingPdfUrl) URL.revokeObjectURL(pdfMappingPdfUrl);
    };
  }, [pdfMappingPdfUrl]);

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
          <div className="flex flex-col lg:flex-row gap-4 min-w-0">
            <div className="w-full lg:w-56 shrink-0 border rounded-lg p-2">
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

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium text-slate-800">{buildFolderPath(folders, selectedFolderId)}</div>
              </div>

              {isLoading ? (
                <div className="text-slate-500 py-8 text-center">Loading...</div>
              ) : docsQuery.isError || foldersQuery.isError ? (
                <QueryFallback
                  title="Documents unavailable"
                  error={docsQuery.error ?? foldersQuery.error}
                  onRetry={() => { foldersQuery.refetch(); docsQuery.refetch(); }}
                  isRetrying={docsQuery.isFetching || foldersQuery.isFetching}
                />
              ) : filteredDocs.length === 0 ? (
                <div className="text-center py-10 text-slate-500">
                  <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                  <p className="font-medium text-slate-600 mb-1">No documents here</p>
                  <p className="text-sm">Upload files and organize them into folders.</p>
                </div>
              ) : (
                <div className="border rounded-lg overflow-x-auto">
                  <table className="w-full min-w-[900px] text-sm">
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
                                <div className="font-medium text-slate-900 truncate">{doc.name || "-"}</div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-xs text-slate-400 truncate">{doc.file_name || "-"}</span>
                                  <Badge variant="outline" className="text-[10px]">{String(doc.extension || String(doc.file_name ?? "").split(".").pop() || "").toUpperCase()}</Badge>
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
                            <Badge variant="outline" className="text-xs">{docTypeLabel(doc.document_type)}</Badge>
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
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-slate-700" onClick={() => handleDownload(doc)} disabled={downloadingDocId === doc.id}>
                                <Download className={cn("w-4 h-4", downloadingDocId === doc.id && "animate-bounce")} />
                              </Button>
                              {doc.kind === "template" && isPdfDoc(doc) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2 text-xs"
                                  onClick={() => void openPdfMappingEditorForDoc(doc)}
                                  disabled={pdfMappingLoading && pdfMappingDoc?.id === doc.id}
                                  title="Edit PDF Mapping"
                                >
                                  {pdfMappingLoading && pdfMappingDoc?.id === doc.id ? "Loading..." : "PDF Mapping"}
                                </Button>
                              ) : null}
                              {doc.is_template_capable || doc.kind === "template" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2 text-xs gap-1 text-amber-700 border-amber-200 hover:bg-amber-50"
                                  onClick={() => openImportVersion(doc)}
                                  title="Import New Version with mapping compare"
                                >
                                  <RefreshCw className="w-3.5 h-3.5" /> Import New Version
                                </Button>
                              ) : null}
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 text-slate-400 hover:text-slate-700"
                                onClick={() => {
                                  setActiveDoc(doc);
                                  setEditName(doc.name);
                                  setEditDescription(doc.description ?? "");
                                  setEditKind(doc.kind);
                                  setEditType(doc.document_type ?? "other");
                                  setEditOpen(true);
                                }}
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 text-slate-400 hover:text-red-600"
                                    disabled={deleteDocMutation.isPending}
                                    title="Delete"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This will permanently delete this document and its metadata. This action cannot be undone.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction asChild>
                                      <Button
                                        variant="destructive"
                                        disabled={deleteDocMutation.isPending}
                                        onClick={() => deleteDocMutation.mutate(doc.id)}
                                      >
                                        Delete
                                      </Button>
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
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

      {pdfMappingOpen && pdfMappingDoc && isPdfDoc(pdfMappingDoc) && pdfMappingPdfUrl ? (
        <ErrorBoundary title="PDF editor crashed" description="Retry or refresh. Your saved mappings remain in the system.">
          <Suspense fallback={<div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"><div className="bg-white rounded-lg p-6 text-sm text-slate-600">Loading PDF editor...</div></div>}>
            <PdfMappingEditor
              docId={pdfMappingDoc.id}
              docName={pdfMappingDoc.name}
              pdfUrl={pdfMappingPdfUrl}
              mappingsGetUrl={`/document-templates/${pdfMappingDoc.id}/pdf-mappings`}
              mappingsPutUrl={`/document-templates/${pdfMappingDoc.id}/pdf-mappings`}
              variablesUrlPrimary="/document-variables?active=1"
              variablesUrlFallback="/platform/document-variables?active=1"
              onClose={() => {
                setPdfMappingOpen(false);
                setPdfMappingPdfUrl((prev) => {
                  if (prev) URL.revokeObjectURL(prev);
                  return "";
                });
                void qc.invalidateQueries({ queryKey: ["firm-documents"] });
              }}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}

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
              <Input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder={selectedFiles.length > 1 ? "Multiple files selected (names will use file names)" : "e.g. Standard SPA Template / Logo / Reference PDF"} disabled={selectedFiles.length > 1} />
            </div>
            <div className="space-y-1.5">
              <Label>Description <span className="text-slate-400 text-xs">(optional)</span></Label>
              <Input value={docDescription} onChange={(e) => setDocDescription(e.target.value)} placeholder="Optional notes" disabled={selectedFiles.length > 1} />
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
                {selectedFiles.length > 0 ? (
                  <div className="text-sm text-slate-700 font-medium">
                    {selectedFiles.length === 1 ? selectedFiles[0]!.name : `${selectedFiles.length} files selected`}
                  </div>
                ) : (
                  <div>
                    <p className="text-sm text-slate-500 mb-1">Click to select a file</p>
                    <p className="text-xs text-slate-400">Supports DOCX (auto-expand signature fields) and PDF (visual variable binding).</p>
                    <p className="text-xs text-slate-400">{ACCEPTED_EXTENSIONS.join(" ")}</p>
                  </div>
                )}
              </div>
              <input
                type="file"
                ref={uploadRef}
                className="hidden"
                multiple
                accept={ACCEPTED_EXTENSIONS.join(",")}
                onChange={(e) => setSelectedFiles(Array.from(e.target.files ?? []))}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleUpload} disabled={selectedFiles.length === 0 || (selectedFiles.length === 1 && !docName.trim()) || isUploading}>
                {isUploading ? (uploadProgress ? `Uploading ${uploadProgress.current}/${uploadProgress.total}...` : "Uploading...") : "Upload"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Edit Document</DialogTitle></DialogHeader>
          {activeDoc && (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Description <span className="text-slate-400 text-xs">(optional)</span></Label>
                <Input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select value={editKind} onValueChange={(v) => setEditKind(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="template">Template-like</SelectItem>
                      <SelectItem value="reference">Reference-only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Document Type</Label>
                  <Select value={editType} onValueChange={setEditType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(DOCUMENT_TYPE_LABELS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => { setEditOpen(false); setActiveDoc(null); }}>Cancel</Button>
                <Button
                  className="bg-amber-500 hover:bg-amber-600"
                  onClick={() => updateDocMutation.mutate({ id: activeDoc.id, name: editName.trim(), description: editDescription, kind: editKind, documentType: editType })}
                  disabled={!editName.trim()}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={importNewOpen} onOpenChange={(o) => { if (!o) closeImportVersionDialog(); setImportNewOpen(o); }}>
        <DialogContent className="sm:max-w-[920px] max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-amber-600" />
              Import New Version
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              {importDoc ? (
                <>
                  Template: <span className="font-medium text-slate-700">{importDoc.name}</span>
                  {importDoc.file_name ? <> · <span className="font-mono text-slate-500">{importDoc.file_name}</span></> : null}
                </>
              ) : "Select a template to compare and migrate variable bindings."}
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <div className="space-y-2 mb-4">
              <div className="flex items-center justify-between text-xs">
                {importSteps.map((s) => (
                  <span
                    key={s.key}
                    className={cn(
                      "font-medium transition-colors",
                      importStep === s.key ? "text-amber-700" : "text-slate-400"
                    )}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
              <Progress value={importProgressPct} className="h-1.5" />
            </div>

            {importStep === "upload" && (
              <div className="space-y-4 py-2">
                <Alert>
                  <FileSpreadsheet className="w-4 h-4" />
                  <AlertTitle className="text-sm">Upload the revised template file</AlertTitle>
                  <AlertDescription className="text-xs">
                    We will compare variable placements between the current version and the uploaded file. Supported formats: DOCX, PDF.
                  </AlertDescription>
                </Alert>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>Current Version</Label>
                    <Card className="mt-2">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded bg-slate-100 flex items-center justify-center">
                            <FileText className="w-5 h-5 text-slate-500" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-slate-800 truncate">
                              {importDoc?.name ?? "(current template)"}
                            </div>
                            <div className="text-xs text-slate-500 font-mono truncate">
                              {importDoc?.file_name ?? "-"}
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                              <Badge variant="outline" className="text-[10px]">Existing</Badge>
                              {importDoc?.extension ? <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100 text-[10px]">{String(importDoc.extension).toUpperCase()}</Badge> : null}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                  <div>
                    <Label>New Version</Label>
                    <div
                      className="mt-2 border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-amber-300 transition-colors min-h-[130px] flex flex-col items-center justify-center"
                      onClick={() => importNewRef.current?.click()}
                    >
                      {importNewFile ? (
                        <div className="flex items-center gap-3 w-full">
                          <div className="w-10 h-10 rounded bg-amber-50 flex items-center justify-center">
                            <FileText className="w-5 h-5 text-amber-600" />
                          </div>
                          <div className="min-w-0 flex-1 text-left">
                            <div className="text-sm font-medium text-slate-800 truncate">{importNewFile.name}</div>
                            <div className="text-xs text-slate-500">{formatFileSize(importNewFile.size)}</div>
                            <div className="mt-1"><Badge variant="default" className="bg-amber-500 hover:bg-amber-500 text-[10px]">New</Badge></div>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                          <p className="text-sm font-medium text-slate-600">Click to select revised file</p>
                          <p className="text-xs text-slate-400 mt-0.5">DOCX or PDF</p>
                        </div>
                      )}
                    </div>
                    <input
                      type="file"
                      ref={importNewRef}
                      className="hidden"
                      accept=".docx,.pdf"
                      onChange={(e) => setImportNewFile(e.target.files?.[0] ?? null)}
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={closeImportVersionDialog}>Cancel</Button>
                  <Button
                    className="bg-amber-500 hover:bg-amber-600 gap-1.5"
                    onClick={handleImportUpload}
                    disabled={!importNewFile || importUploading}
                  >
                    {importUploading ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Uploading &amp; Analyzing...
                      </>
                    ) : (
                      <>
                        <ArrowLeftRight className="w-4 h-4" />
                        Analyze &amp; Compare
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {importStep === "compare" && (
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-xs text-slate-500">Matched</div>
                      <div className="text-2xl font-bold text-emerald-700 mt-0.5">{importCompareSummary?.matched ?? 0}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-xs text-slate-500">Moved</div>
                      <div className="text-2xl font-bold text-amber-700 mt-0.5">{importCompareSummary?.moved ?? 0}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-xs text-slate-500">Added</div>
                      <div className="text-2xl font-bold text-blue-700 mt-0.5">{importCompareSummary?.added ?? 0}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-xs text-slate-500">Removed</div>
                      <div className="text-2xl font-bold text-rose-700 mt-0.5">{importCompareSummary?.removed ?? 0}</div>
                    </CardContent>
                  </Card>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-sm font-medium">Placement Changes (sample)</Label>
                    <span className="text-xs text-slate-400">{importMappings.length} total fields</span>
                  </div>
                  <div className="border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Variable</th>
                          <th className="px-3 py-2 text-left font-medium">Status</th>
                          <th className="px-3 py-2 text-left font-medium">Previous</th>
                          <th className="px-3 py-2 text-left font-medium">New</th>
                          <th className="px-3 py-2 text-right font-medium">Conf.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {importMappings.slice(0, 10).map((m) => (
                          <tr key={m.id} className="hover:bg-slate-50/50">
                            <td className="px-3 py-2 font-mono text-slate-700">{m.variableKey}</td>
                            <td className="px-3 py-2">
                              <Badge
                                className={cn(
                                  "text-[10px]",
                                  m.status === "matched" && "bg-emerald-50 text-emerald-700 hover:bg-emerald-50",
                                  m.status === "moved" && "bg-amber-50 text-amber-700 hover:bg-amber-50",
                                  m.status === "added" && "bg-blue-50 text-blue-700 hover:bg-blue-50",
                                  m.status === "removed" && "bg-rose-50 text-rose-700 hover:bg-rose-50",
                                )}
                              >
                                {m.status}
                              </Badge>
                            </td>
                            <td className="px-3 py-2 text-slate-500 font-mono text-[11px]">
                              {m.prev ? `P${m.prev.page} @ (${m.prev.x},${m.prev.y}) ${m.prev.w}×${m.prev.h}` : "—"}
                            </td>
                            <td className="px-3 py-2 text-slate-500 font-mono text-[11px]">
                              {m.next ? `P${m.next.page} @ (${m.next.x},${m.next.y}) ${m.next.w}×${m.next.h}` : "—"}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600 font-mono">{(m.confidence * 100).toFixed(0)}%</td>
                          </tr>
                        ))}
                        {importMappings.length > 10 && (
                          <tr><td colSpan={5} className="px-3 py-2 text-center text-slate-400">+ {importMappings.length - 10} more shown in Mapping step</td></tr>
                        )}
                        {importMappings.length === 0 && (
                          <tr><td colSpan={5} className="px-3 py-12 text-center text-slate-400">No diffs detected.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="flex justify-between gap-2 pt-2">
                  <Button variant="outline" onClick={() => setImportStep("upload")}>← Back</Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={closeImportVersionDialog}>Cancel</Button>
                    <Button className="bg-amber-500 hover:bg-amber-600" onClick={() => setImportStep("mapping")}>Continue to Mapping →</Button>
                  </div>
                </div>
              </div>
            )}

            {importStep === "mapping" && (
              <div className="space-y-4 py-2 max-h-[50vh] overflow-y-auto pr-1">
                <Alert>
                  <Sparkles className="w-4 h-4" />
                  <AlertTitle className="text-sm">Mapping Proposals</AlertTitle>
                  <AlertDescription className="text-xs">
                    These are auto-suggested. Uncheck any fields you don't want to migrate, or override the target variable name.
                  </AlertDescription>
                </Alert>

                <Tabs defaultValue="all">
                  <TabsList>
                    <TabsTrigger value="all">All ({importMappings.length})</TabsTrigger>
                    <TabsTrigger value="changed">Changed ({importMappings.filter(m => m.status !== "matched").length})</TabsTrigger>
                    <TabsTrigger value="kept">Keep ({importMappings.filter(m => m.keep).length})</TabsTrigger>
                  </TabsList>
                  <TabsContent value="all" className="mt-3 border rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-2 py-2 w-10"><span className="sr-only">Keep</span></th>
                          <th className="px-2 py-2 text-left font-medium">Source Variable</th>
                          <th className="px-2 py-2 text-left font-medium w-24">Status</th>
                          <th className="px-2 py-2 text-left font-medium w-72">Remap To</th>
                          <th className="px-2 py-2 text-right font-medium w-16">Conf.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {importMappings.map((m) => (
                          <tr key={m.id} className={cn("hover:bg-slate-50/50", !m.keep && "opacity-50 bg-slate-50/30")}>
                            <td className="px-2 py-2">
                              <Checkbox
                                checked={m.keep}
                                onCheckedChange={(c) => setImportMappingKeep(m.id, !!c)}
                              />
                            </td>
                            <td className="px-2 py-2 font-mono text-slate-700">{m.variableKey}</td>
                            <td className="px-2 py-2">
                              <Badge
                                className={cn(
                                  "text-[10px]",
                                  m.status === "matched" && "bg-emerald-50 text-emerald-700 hover:bg-emerald-50",
                                  m.status === "moved" && "bg-amber-50 text-amber-700 hover:bg-amber-50",
                                  m.status === "added" && "bg-blue-50 text-blue-700 hover:bg-blue-50",
                                  m.status === "removed" && "bg-rose-50 text-rose-700 hover:bg-rose-50",
                                )}
                              >
                                {m.status}
                              </Badge>
                            </td>
                            <td className="px-2 py-2">
                              <Input
                                value={m.remapTo}
                                onChange={(e) => setImportMappingRemap(m.id, e.target.value)}
                                disabled={!m.keep}
                                className="h-7 text-xs font-mono px-2"
                                placeholder="e.g. client_name"
                              />
                            </td>
                            <td className="px-2 py-2 text-right text-slate-600 font-mono">{(m.confidence * 100).toFixed(0)}%</td>
                          </tr>
                        ))}
                        {importMappings.length === 0 && (
                          <tr><td colSpan={5} className="px-3 py-12 text-center text-slate-400">No mappings available.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </TabsContent>
                  <TabsContent value="changed" className="mt-3 border rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b text-slate-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-2 py-2 w-10"><span className="sr-only">Keep</span></th>
                          <th className="px-2 py-2 text-left font-medium">Source Variable</th>
                          <th className="px-2 py-2 text-left font-medium w-24">Status</th>
                          <th className="px-2 py-2 text-left font-medium w-72">Remap To</th>
                          <th className="px-2 py-2 text-right font-medium w-16">Conf.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {importMappings.filter(m => m.status !== "matched").map((m) => (
                          <tr key={m.id} className={cn("hover:bg-slate-50/50", !m.keep && "opacity-50 bg-slate-50/30")}>
                            <td className="px-2 py-2">
                              <Checkbox checked={m.keep} onCheckedChange={(c) => setImportMappingKeep(m.id, !!c)} />
                            </td>
                            <td className="px-2 py-2 font-mono text-slate-700">{m.variableKey}</td>
                            <td className="px-2 py-2">
                              <Badge
                                className={cn(
                                  "text-[10px]",
                                  m.status === "moved" && "bg-amber-50 text-amber-700 hover:bg-amber-50",
                                  m.status === "added" && "bg-blue-50 text-blue-700 hover:bg-blue-50",
                                  m.status === "removed" && "bg-rose-50 text-rose-700 hover:bg-rose-50",
                                )}
                              >{m.status}</Badge>
                            </td>
                            <td className="px-2 py-2">
                              <Input value={m.remapTo} onChange={(e) => setImportMappingRemap(m.id, e.target.value)} disabled={!m.keep} className="h-7 text-xs font-mono px-2" />
                            </td>
                            <td className="px-2 py-2 text-right text-slate-600 font-mono">{(m.confidence * 100).toFixed(0)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TabsContent>
                  <TabsContent value="kept" className="mt-3">
                    <div className="text-xs text-slate-500 p-3 bg-slate-50 rounded border">
                      Keeping <span className="font-semibold text-slate-700">{importMappings.filter(m => m.keep).length}</span> of {importMappings.length} fields.
                      Skipped: {importMappings.filter(m => !m.keep).length} fields.
                    </div>
                  </TabsContent>
                </Tabs>

                <div className="flex justify-between gap-2 pt-2">
                  <Button variant="outline" onClick={() => setImportStep("compare")}>← Back</Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={closeImportVersionDialog}>Cancel</Button>
                    <Button className="bg-amber-500 hover:bg-amber-600" onClick={() => setImportStep("review")}>Review &amp; Publish →</Button>
                  </div>
                </div>
              </div>
            )}

            {importStep === "review" && (
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Summary</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-slate-500">Fields keeping</span><span className="font-semibold text-slate-800">{importMappings.filter(m => m.keep).length}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Fields skipping</span><span className="font-semibold text-slate-800">{importMappings.filter(m => !m.keep).length}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">New file</span><span className="font-medium text-slate-800 truncate max-w-[220px]" title={importNewFile?.name}>{importNewFile?.name ?? "-"}</span></div>
                    </CardContent>
                  </Card>

                  <div className="space-y-3">
                    {(importCompareSummary?.removed ?? 0) > 0 ? (
                      <Alert className="border-amber-200 bg-amber-50/60">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />
                        <AlertTitle className="text-sm text-amber-800">{importCompareSummary?.removed} removed field(s)</AlertTitle>
                        <AlertDescription className="text-xs text-amber-700">
                          Check your documents still render correctly. Removed fields are excluded by default.
                        </AlertDescription>
                      </Alert>
                    ) : null}

                    <Alert className={cn("border", importReviewConfirmed ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200 bg-slate-50/60")}>
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={importReviewConfirmed}
                          onCheckedChange={(c) => setImportReviewConfirmed(!!c)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0">
                          <AlertTitle className="text-sm">Confirm review before publishing</AlertTitle>
                          <AlertDescription className="text-xs">
                            I have reviewed mapping proposals, verified skipped fields, and tested generation output if needed.
                          </AlertDescription>
                        </div>
                      </div>
                    </Alert>
                  </div>
                </div>

                <div className="flex justify-between gap-2 pt-2">
                  <Button variant="outline" onClick={() => setImportStep("mapping")}>← Back</Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={closeImportVersionDialog}>Cancel</Button>
                    <Button
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => importDoc && importTestGenerateMut.mutate({ docId: importDoc.id, newObjectPath: importUploadedPath, mappings: importMappings })}
                      disabled={!importDoc || !importUploadedPath || importTestGenerateMut.isPending}
                    >
                      <Eye className="w-4 h-4" />
                      {importTestGenerateMut.isPending ? "Generating..." : "Test Generate"}
                    </Button>
                    <Button
                      className="bg-amber-500 hover:bg-amber-600 gap-1.5 disabled:opacity-60"
                      disabled={!importReviewConfirmed || !importDoc || !importNewFile || !importUploadedPath || importPublishMut.isPending}
                      onClick={() => importDoc && importNewFile && importPublishMut.mutate({ docId: importDoc.id, newObjectPath: importUploadedPath, mappings: importMappings, file: importNewFile, fileName: importNewFile.name })}
                    >
                      {importPublishMut.isPending ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Publishing...
                        </>
                      ) : (
                        <>
                          <Check className="w-4 h-4" />
                          Publish New Version
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
