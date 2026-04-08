import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  FileText, Upload, Trash2, Download, Plus, File, Search,
  FolderOpen, Folder, ChevronUp, ChevronDown, Pencil, FolderPlus,
  Eye, EyeOff, ChevronRight, BookOpen, Copy, Check, FileEdit,
} from "lucide-react";
import { lazy, Suspense } from "react";
const PdfMappingEditor = lazy(() => import("@/components/PdfMappingEditor"));
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.BASE_URL + "api";

const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "text/plain": "TXT",
};

const CATEGORIES = ["general", "template", "guide", "announcement", "form", "policy", "other"];

interface SystemFolder {
  id: number;
  name: string;
  parentId: number | null;
  sortOrder: number;
  isDisabled: boolean;
  createdAt: string;
}

interface PlatformDoc {
  id: number;
  name: string;
  description: string | null;
  category: string;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  objectPath: string;
  firmId: number | null;
  folderId: number | null;
  uploadedBy: number;
  createdAt: string;
}

function fileTypeLabel(mime: string) {
  return ALLOWED_TYPES[mime] ?? mime.split("/").pop()?.toUpperCase() ?? "FILE";
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FolderTreeItem({
  folder,
  folders,
  selectedFolderId,
  onSelect,
  onEdit,
  onToggleDisable,
  onReorder,
  onAddSub,
  onDelete,
  depth = 0,
}: {
  folder: SystemFolder;
  folders: SystemFolder[];
  selectedFolderId: number | null;
  onSelect: (id: number) => void;
  onEdit: (folder: SystemFolder) => void;
  onToggleDisable: (folder: SystemFolder) => void;
  onReorder: (folderId: number, direction: "up" | "down") => void;
  onAddSub: (parentId: number) => void;
  onDelete: (folder: SystemFolder) => void;
  depth?: number;
}) {
  const children = folders
    .filter(f => f.parentId === folder.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const isSelected = selectedFolderId === folder.id;
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <div
        className={cn(
          "group rounded-md cursor-pointer text-sm transition-colors",
          isSelected ? "bg-amber-50 border border-amber-200" : "hover:bg-slate-50 border border-transparent",
          folder.isDisabled && "opacity-50"
        )}
      >
        <div className="flex items-center gap-1.5 py-2 px-2" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
          {children.length > 0 ? (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); setExpanded(!expanded); }}
              className="p-0.5 hover:bg-slate-200 rounded shrink-0"
              aria-label={expanded ? "Collapse folder" : "Expand folder"}
            >
              <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-90")} />
            </button>
          ) : (
            <span className="w-[18px]" />
          )}
          <button
            type="button"
            className="flex items-center gap-1.5 flex-1 text-left"
            onClick={() => onSelect(folder.id)}
          >
            {isSelected ? (
              <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
            ) : (
              <Folder className="w-4 h-4 text-slate-400 shrink-0" />
            )}
            <span className={cn("font-medium flex-1 break-words leading-snug", isSelected ? "text-amber-700" : "text-slate-700")}>
              {folder.name}
            </span>
          </button>
        </div>
        <div
          className={cn(
            "items-center gap-1 pb-1.5 px-2",
            isSelected ? "flex" : "hidden group-hover:flex",
          )}
          style={{ paddingLeft: `${depth * 16 + 34}px` }}
        >
          <button onClick={e => { e.stopPropagation(); onReorder(folder.id, "up"); }} className="p-1 hover:bg-slate-200 rounded" title="Move up">
            <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <button onClick={e => { e.stopPropagation(); onReorder(folder.id, "down"); }} className="p-1 hover:bg-slate-200 rounded" title="Move down">
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <button onClick={e => { e.stopPropagation(); onEdit(folder); }} className="p-1 hover:bg-slate-200 rounded" title="Rename">
            <Pencil className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <button onClick={e => { e.stopPropagation(); onToggleDisable(folder); }} className="p-1 hover:bg-slate-200 rounded" title={folder.isDisabled ? "Enable" : "Disable"}>
            {folder.isDisabled ? <Eye className="w-3.5 h-3.5 text-green-500" /> : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
          </button>
          <button onClick={e => { e.stopPropagation(); onAddSub(folder.id); }} className="p-1 hover:bg-slate-200 rounded" title="Add subfolder">
            <FolderPlus className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <button onClick={e => { e.stopPropagation(); onDelete(folder); }} className="p-1 hover:bg-slate-200 rounded" title="Delete">
            <Trash2 className="w-3.5 h-3.5 text-slate-400" />
          </button>
        </div>
      </div>
      {expanded && children.map(child => (
        <FolderTreeItem
          key={child.id}
          folder={child}
          folders={folders}
          selectedFolderId={selectedFolderId}
          onSelect={onSelect}
          onEdit={onEdit}
          onToggleDisable={onToggleDisable}
          onReorder={onReorder}
          onAddSub={onAddSub}
          onDelete={onDelete}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export default function PlatformDocuments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", category: "general" });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<number | null>(null);

  const [showEditFolder, setShowEditFolder] = useState(false);
  const [editingFolder, setEditingFolder] = useState<SystemFolder | null>(null);
  const [editFolderName, setEditFolderName] = useState("");

  const [showVarRef, setShowVarRef] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const [editingPdfDoc, setEditingPdfDoc] = useState<PlatformDoc | null>(null);
  const [editingPdfUrl, setEditingPdfUrl] = useState<string | null>(null);

  const { data: folders = [] } = useQuery<SystemFolder[]>({
    queryKey: ["system-folders"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/platform/folders`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load folders");
      return res.json();
    },
  });

  const { data: docs = [], isLoading: docsLoading } = useQuery<PlatformDoc[]>({
    queryKey: ["platform-documents", selectedFolderId],
    queryFn: async () => {
      const url = selectedFolderId !== null
        ? `${API_BASE}/platform/documents?folderId=${selectedFolderId}`
        : `${API_BASE}/platform/documents`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load documents");
      return res.json();
    },
  });

  const { data: varGroups = [] } = useQuery<{ group: string; vars: { key: string; label: string }[] }[]>({
    queryKey: ["document-variables"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/document-variables`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load variables");
      return res.json();
    },
    enabled: showVarRef,
  });

  const handleCopyVar = (key: string, type?: string) => {
    let text: string;
    if (type === "loop") {
      text = `{#${key}}...{/${key}}`;
    } else if (type === "loopField") {
      text = `{${key}}`;
    } else {
      text = `{{${key}}}`;
    }
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const rootFolders = folders.filter(f => f.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const selectedFolder = folders.find(f => f.id === selectedFolderId);

  const createFolderMutation = useMutation({
    mutationFn: async ({ name, parentId }: { name: string; parentId: number | null }) => {
      const res = await fetch(`${API_BASE}/platform/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId }),
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to create folder");
      return body as SystemFolder;
    },
    onSuccess: (folder) => {
      queryClient.setQueryData<SystemFolder[]>(["system-folders"], (prev) => {
        const list = Array.isArray(prev) ? prev : [];
        return [...list.filter((f) => f.id !== folder.id), folder];
      });
      queryClient.invalidateQueries({ queryKey: ["system-folders"] });
      toast({ title: "Folder created" });
      setShowNewFolder(false);
      setNewFolderName("");
      setNewFolderParentId(null);
    },
    onError: (e: any) => toast({ title: "Failed to create folder", description: e.message, variant: "destructive" }),
  });

  const updateFolderMutation = useMutation({
    mutationFn: async ({ id, name, isDisabled }: { id: number; name?: string; isDisabled?: boolean }) => {
      const res = await fetch(`${API_BASE}/platform/folders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, isDisabled }),
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to update folder");
      return body as SystemFolder;
    },
    onSuccess: (folder) => {
      queryClient.setQueryData<SystemFolder[]>(["system-folders"], (prev) => {
        const list = Array.isArray(prev) ? prev : [];
        return list.map((f) => (f.id === folder.id ? folder : f));
      });
      queryClient.invalidateQueries({ queryKey: ["system-folders"] });
      toast({ title: "Folder updated" });
      setShowEditFolder(false);
      setEditingFolder(null);
    },
    onError: (e: any) => toast({ title: "Failed to update folder", description: e.message, variant: "destructive" }),
  });

  const reorderMutation = useMutation({
    mutationFn: async ({ folderId, direction }: { folderId: number; direction: "up" | "down" }) => {
      const res = await fetch(`${API_BASE}/platform/folders/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, direction }),
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to reorder");
      return { folderId, direction };
    },
    onMutate: async ({ folderId, direction }) => {
      await queryClient.cancelQueries({ queryKey: ["system-folders"] });
      const prev = queryClient.getQueryData<SystemFolder[]>(["system-folders"]);
      queryClient.setQueryData<SystemFolder[]>(["system-folders"], (cur) => {
        const list = Array.isArray(cur) ? [...cur] : [];
        const target = list.find((f) => f.id === folderId);
        if (!target) return list;
        const siblings = list
          .filter((f) => f.parentId === target.parentId)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const idx = siblings.findIndex((s) => s.id === folderId);
        const swapIdx = direction === "up" ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= siblings.length) return list;
        const swap = siblings[swapIdx];
        return list.map((f) => {
          if (f.id === target.id) return { ...f, sortOrder: swap.sortOrder };
          if (f.id === swap.id) return { ...f, sortOrder: target.sortOrder };
          return f;
        });
      });
      return { prev };
    },
    onError: (e: any, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["system-folders"], ctx.prev);
      toast({ title: "Failed to reorder", description: e.message, variant: "destructive" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["system-folders"] });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId: number) => {
      const res = await fetch(`${API_BASE}/platform/folders/${folderId}`, { method: "DELETE", credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to delete folder");
    },
    onSuccess: (_: any, folderId: number) => {
      queryClient.invalidateQueries({ queryKey: ["system-folders"] });
      if (selectedFolderId === folderId) setSelectedFolderId(null);
      toast({ title: "Folder deleted" });
    },
    onError: (e: any) => toast({ title: "Failed to delete folder", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: number) => {
      const res = await fetch(`${API_BASE}/platform/documents/${docId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-documents"], exact: false });
      toast({ title: "Document deleted" });
    },
    onError: (e: any) => toast({ title: "Could not delete document", description: e.message, variant: "destructive" }),
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_TYPES[file.type]) {
      toast({ title: "Unsupported file type", description: "Please upload a PDF, Word, Excel, or image file.", variant: "destructive" });
      return;
    }
    setSelectedFile(file);
    if (!form.name) setForm(f => ({ ...f, name: file.name.replace(/\.[^.]+$/, "") }));
  };

  const handleUpload = async () => {
    if (!selectedFile || !form.name) return;
    setUploading(true);
    try {
      const reqUrlRes = await fetch(`${API_BASE}/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: selectedFile.name, size: selectedFile.size, contentType: selectedFile.type }),
        credentials: "include",
      });
      if (!reqUrlRes.ok) {
        const err = await reqUrlRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to get upload URL");
      }
      const { uploadURL, objectPath } = await reqUrlRes.json();

      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": selectedFile.type },
        body: selectedFile,
      });
      if (!putRes.ok) {
        throw new Error("File upload failed");
      }

      const saveRes = await fetch(`${API_BASE}/platform/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description || null,
          category: form.category,
          fileName: selectedFile.name,
          fileType: selectedFile.type,
          fileSize: selectedFile.size,
          objectPath,
          firmId: null,
          folderId: selectedFolderId,
        }),
        credentials: "include",
      });
      if (!saveRes.ok) {
        const err = await saveRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save document");
      }

      queryClient.invalidateQueries({ queryKey: ["platform-documents"], exact: false });
      toast({ title: "Document uploaded", description: `${form.name} has been added.` });
      setShowUpload(false);
      setForm({ name: "", description: "", category: "general" });
      setSelectedFile(null);
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (doc: PlatformDoc) => {
    try {
      const pathPart = doc.objectPath.replace(/^\/objects\//, "");
      const res = await fetch(`${API_BASE}/storage/objects/${pathPart}`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    }
  };

  const handleEditPdfMappings = async (doc: PlatformDoc) => {
    try {
      const pathPart = doc.objectPath.replace(/^\/objects\//, "");
      const res = await fetch(`${API_BASE}/storage/objects/${pathPart}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load PDF");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setEditingPdfUrl(url);
      setEditingPdfDoc(doc);
    } catch (e: any) {
      toast({ title: "Failed to load PDF", description: e.message, variant: "destructive" });
    }
  };

  const handleStartAddSub = (parentId: number) => {
    setNewFolderParentId(parentId);
    setNewFolderName("");
    setShowNewFolder(true);
  };

  const handleStartEdit = (folder: SystemFolder) => {
    setEditingFolder(folder);
    setEditFolderName(folder.name);
    setShowEditFolder(true);
  };

  const handleToggleDisable = (folder: SystemFolder) => {
    updateFolderMutation.mutate({ id: folder.id, isDisabled: !folder.isDisabled });
  };

  const folderPath = (): string => {
    if (!selectedFolder) return "All Documents";
    const parts: string[] = [];
    let current: SystemFolder | undefined = selectedFolder;
    while (current) {
      parts.unshift(current.name);
      current = folders.find(f => f.id === current!.parentId);
    }
    return parts.join(" / ");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">System Documents</h1>
          <p className="text-slate-500 mt-1">Manage global system folders and master documents for all firms</p>
        </div>
      </div>

      <div className="flex gap-6 min-h-[500px]">
        <div className="w-80 shrink-0">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-700">Folders</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => { setNewFolderParentId(null); setNewFolderName(""); setShowNewFolder(true); }}
                >
                  New Folder
                </Button>
              </div>
              <p className="text-xs text-slate-400 mb-3">System folder tree</p>

              <button
                type="button"
                className={cn(
                  "py-2 px-2 rounded-md cursor-pointer text-sm flex items-center gap-2 transition-colors mb-1",
                  selectedFolderId === null ? "bg-amber-50 border border-amber-200 text-amber-700 font-medium" : "hover:bg-slate-50 text-slate-600 border border-transparent"
                )}
                onClick={() => setSelectedFolderId(null)}
              >
                <FolderOpen className="w-4 h-4" />
                All Documents
              </button>

              <div className="space-y-0.5">
                {rootFolders.map(folder => (
                  <FolderTreeItem
                    key={folder.id}
                    folder={folder}
                    folders={folders}
                    selectedFolderId={selectedFolderId}
                    onSelect={setSelectedFolderId}
                    onEdit={handleStartEdit}
                    onToggleDisable={handleToggleDisable}
                    onReorder={(folderId, direction) => reorderMutation.mutate({ folderId, direction })}
                    onAddSub={handleStartAddSub}
                    onDelete={(f) => { if (confirm(`Delete folder "${f.name}"?`)) deleteFolderMutation.mutate(f.id); }}
                  />
                ))}
              </div>

              {rootFolders.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No folders yet</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex-1 min-w-0">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700">Documents</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {selectedFolder ? `Folder: ${folderPath()}` : "Showing all documents"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setShowVarRef(true); setExpandedGroups({}); }}>
                    <BookOpen className="w-3.5 h-3.5" />
                    Variable Reference
                  </Button>
                  <Button onClick={() => setShowUpload(true)} size="sm" className="gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    Upload Document
                  </Button>
                </div>
              </div>

              {docsLoading ? (
                <div className="text-slate-500 text-sm py-12 text-center">Loading documents...</div>
              ) : docs.length === 0 ? (
                <div className="text-center py-12">
                  <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-500 font-medium">No documents</p>
                  <p className="text-slate-400 text-sm mt-1">
                    {selectedFolder ? `Upload a document to "${selectedFolder.name}"` : "Upload a document to get started"}
                  </p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Name</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600 w-20">Type</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600 w-20">Size</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600 w-28">Category</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map(doc => (
                      <tr key={doc.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <File className="w-4 h-4 text-slate-400 shrink-0" />
                            <div>
                              <p className="font-medium text-slate-900">{doc.name}</p>
                              {doc.description && <p className="text-xs text-slate-500">{doc.description}</p>}
                              <p className="text-xs text-slate-400">{doc.fileName}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant="outline" className="text-xs">{fileTypeLabel(doc.fileType)}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-slate-500 text-xs">{formatBytes(doc.fileSize)}</td>
                        <td className="px-3 py-2.5">
                          <Badge variant="secondary" className="text-xs capitalize">{doc.category}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {doc.fileType === "application/pdf" && (
                              <Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-blue-600 hover:text-blue-700" onClick={() => handleEditPdfMappings(doc)} title="Edit PDF mappings">
                                <FileEdit className="w-3.5 h-3.5" />
                                <span className="text-xs">Map</span>
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleDownload(doc)} title="Download">
                              <Download className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                              onClick={() => deleteMutation.mutate(doc.id)}
                              disabled={deleteMutation.isPending}
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showUpload} onOpenChange={setShowUpload}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Document{selectedFolder ? ` to "${selectedFolder.name}"` : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                selectedFile ? "border-amber-400 bg-amber-50" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.txt"
                onChange={handleFileSelect}
              />
              {selectedFile ? (
                <div>
                  <File className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                  <p className="font-medium text-sm text-slate-900">{selectedFile.name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{formatBytes(selectedFile.size)}</p>
                </div>
              ) : (
                <div>
                  <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                  <p className="text-sm font-medium text-slate-700">Click to select file</p>
                  <p className="text-xs text-slate-400 mt-1">PDF, Word, Excel, Image (max 50MB)</p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Document Name</Label>
              <Input
                placeholder="e.g. Fee Schedule 2025"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Textarea
                placeholder="Brief description of this document..."
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => (
                    <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUpload(false)}>Cancel</Button>
            <Button onClick={handleUpload} disabled={!selectedFile || !form.name || uploading}>
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{newFolderParentId ? "New Subfolder" : "New Folder"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {newFolderParentId && (
              <p className="text-sm text-slate-500">
                Adding subfolder under: <span className="font-medium text-slate-700">{folders.find(f => f.id === newFolderParentId)?.name}</span>
              </p>
            )}
            <div className="space-y-2">
              <Label>Folder Name</Label>
              <Input
                placeholder="e.g. LOAN AGREEMENT"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && newFolderName.trim()) {
                    createFolderMutation.mutate({ name: newFolderName, parentId: newFolderParentId });
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewFolder(false)}>Cancel</Button>
            <Button
              onClick={() => createFolderMutation.mutate({ name: newFolderName, parentId: newFolderParentId })}
              disabled={!newFolderName.trim() || createFolderMutation.isPending}
            >
              {createFolderMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditFolder} onOpenChange={setShowEditFolder}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit Folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Folder Name</Label>
              <Input
                value={editFolderName}
                onChange={e => setEditFolderName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && editFolderName.trim() && editingFolder) {
                    updateFolderMutation.mutate({ id: editingFolder.id, name: editFolderName });
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditFolder(false)}>Cancel</Button>
            <Button
              onClick={() => editingFolder && updateFolderMutation.mutate({ id: editingFolder.id, name: editFolderName })}
              disabled={!editFolderName.trim() || updateFolderMutation.isPending}
            >
              {updateFolderMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showVarRef} onOpenChange={setShowVarRef}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Template Variable Reference</DialogTitle>
            <p className="text-sm text-slate-500 mt-1">
              Use these variables in DOCX templates. Click to copy. Variables use {"{{variable_name}}"} syntax.
            </p>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {varGroups.map(group => {
              const isExpanded = expandedGroups[group.group] !== false;
              const isLoop = group.group.toLowerCase().includes("loop");
              return (
                <div key={group.group} className="border rounded-lg overflow-hidden">
                  <button
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2.5 text-left text-sm font-medium transition-colors",
                      isLoop ? "bg-blue-50 text-blue-800 hover:bg-blue-100" : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                    )}
                    onClick={() => toggleGroup(group.group)}
                  >
                    <span className="flex items-center gap-2">
                      {group.group}
                      <Badge variant="secondary" className="text-xs font-normal">{group.vars.length}</Badge>
                    </span>
                    <ChevronRight className={cn("w-4 h-4 transition-transform", isExpanded && "rotate-90")} />
                  </button>
                  {isExpanded && (
                    <div className="divide-y divide-slate-100">
                      {group.vars.map((v: any) => {
                        const varType = v.type as string | undefined;
                        const isLoopVar = varType === "loop";
                        const isLoopField = varType === "loopField";
                        const displaySyntax = isLoopVar
                          ? `{#${v.key}}...{/${v.key}}`
                          : isLoopField
                            ? `{${v.key}}`
                            : `{{${v.key}}}`;
                        const isCopied = copiedKey === v.key;
                        return (
                          <div
                            key={v.key}
                            className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 cursor-pointer group"
                            onClick={() => handleCopyVar(v.key, varType)}
                          >
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-slate-500">{v.label}</span>
                              {v.fields && (
                                <span className="text-xs text-slate-400 ml-1">({v.fields})</span>
                              )}
                              <div className="flex items-center gap-2 mt-0.5">
                                <code className={cn(
                                  "text-xs px-1.5 py-0.5 rounded font-mono",
                                  isLoopVar ? "bg-blue-50 text-blue-700" : isLoopField ? "bg-blue-50/50 text-blue-600" : "bg-amber-50 text-amber-800"
                                )}>
                                  {displaySyntax}
                                </code>
                              </div>
                            </div>
                            <div className="shrink-0 ml-2">
                              {isCopied ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4 text-slate-300 group-hover:text-slate-500" />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {varGroups.length === 0 && (
              <div className="text-center py-8 text-slate-400 text-sm">Loading variables...</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVarRef(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editingPdfDoc && editingPdfUrl && (
        <Suspense fallback={<div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"><div className="bg-white rounded-lg p-8">Loading editor...</div></div>}>
          <PdfMappingEditor
            docId={editingPdfDoc.id}
            docName={editingPdfDoc.name}
            pdfUrl={editingPdfUrl}
            onClose={() => {
              setEditingPdfDoc(null);
              if (editingPdfUrl) URL.revokeObjectURL(editingPdfUrl);
              setEditingPdfUrl(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
