import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
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
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { downloadBlob } from "@/lib/download";
import { toastError } from "@/lib/toast-error";
import { unwrapApiData } from "@/lib/api-contract";
import { ensureArray, listItems } from "@/lib/list-items";
import { PlatformPage, PlatformPageHeader } from "@/components/platform/page";
import { PlatformEmptyState, PlatformLoadingState } from "@/components/platform/states";

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
  isActive: boolean;
  appliesToPurchaseMode: string | null;
  appliesToTitleType: string | null;
  appliesToCaseType: string | null;
  documentGroup: string | null;
  sortOrder: number | null;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  objectPath: string;
  firmId: number | null;
  folderId: number | null;
  uploadedBy: number;
  createdAt: string;
}

interface DocumentVariableDefinition {
  id: number;
  key: string;
  label: string;
  description: string | null;
  category: string;
  valueType: string;
  sourcePath: string | null;
  formatter: string | null;
  exampleValue: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
}

interface DocumentTemplateBinding {
  variableKey: string;
  sourceMode: "registry_default" | "custom_path" | "fixed_value";
  sourcePath: string | null;
  fixedValue: string | null;
  formatterOverride: string | null;
  isRequired: boolean;
  fallbackValue: string | null;
  notes: string | null;
}

interface TemplateBindingsResponse {
  placeholders: string[];
  variables: DocumentVariableDefinition[];
  bindings: DocumentTemplateBinding[];
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
  const [textUploadContent, setTextUploadContent] = useState("");

  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<number | null>(null);

  const [showEditFolder, setShowEditFolder] = useState(false);
  const [editingFolder, setEditingFolder] = useState<SystemFolder | null>(null);
  const [editFolderName, setEditFolderName] = useState("");

  const [showVarRef, setShowVarRef] = useState(false);
  const [variableRegistryOpen, setVariableRegistryOpen] = useState(false);
  const [variableSearch, setVariableSearch] = useState("");
  const [includeInactiveVariables, setIncludeInactiveVariables] = useState(false);
  const [editVariableOpen, setEditVariableOpen] = useState(false);
  const [editVariableId, setEditVariableId] = useState<number | null>(null);
  const [variableForm, setVariableForm] = useState({
    key: "",
    label: "",
    description: "",
    category: "case",
    valueType: "string",
    sourcePath: "",
    formatter: "",
    exampleValue: "",
    isActive: true,
    sortOrder: 0,
  });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const [editingPdfDoc, setEditingPdfDoc] = useState<PlatformDoc | null>(null);
  const [editingPdfUrl, setEditingPdfUrl] = useState<string | null>(null);
  const [downloadingDocId, setDownloadingDocId] = useState<number | null>(null);

  const [editDocOpen, setEditDocOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<PlatformDoc | null>(null);
  const [editIsActive, setEditIsActive] = useState(true);
  const [editIsRequired, setEditIsRequired] = useState(false);
  const [editPurchaseMode, setEditPurchaseMode] = useState<string>("both");
  const [editTitleType, setEditTitleType] = useState<string>("any");
  const [editCaseType, setEditCaseType] = useState<string>("");
  const [editGroup, setEditGroup] = useState<string>("Others");
  const [editSortOrder, setEditSortOrder] = useState<number>(0);
  const [editCategory, setEditCategory] = useState<string>("general");
  const [editFileNamingRule, setEditFileNamingRule] = useState<string>("");
  const [editClauseInsertionMode, setEditClauseInsertionMode] = useState<string>("prefer_placeholder_else_append");
  const [editApplicabilityMode, setEditApplicabilityMode] = useState<string>("universal");
  const [editApplicabilityRulesText, setEditApplicabilityRulesText] = useState<string>("");
  const [editChecklistMode, setEditChecklistMode] = useState<string>("off");
  const [editChecklistItemsText, setEditChecklistItemsText] = useState<string>("");
  const [namingPreviewCaseId, setNamingPreviewCaseId] = useState<string>("");
  const [namingPreviewFileName, setNamingPreviewFileName] = useState<string>("");
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const [bindingsDraft, setBindingsDraft] = useState<Record<string, DocumentTemplateBinding>>({});
  const [clausesOpen, setClausesOpen] = useState(false);
  const [clauseSearch, setClauseSearch] = useState("");
  const [clauseEditorOpen, setClauseEditorOpen] = useState(false);
  const [editingClause, setEditingClause] = useState<any | null>(null);
  const [clauseTitle, setClauseTitle] = useState("");
  const [clauseCode, setClauseCode] = useState("");
  const [clauseCategory, setClauseCategory] = useState("General");
  const [clauseLanguage, setClauseLanguage] = useState("en");
  const [clauseBody, setClauseBody] = useState("");
  const [clauseStatus, setClauseStatus] = useState("draft");
  const [clauseTags, setClauseTags] = useState("");

  useEffect(() => {
    if (!editingDoc) return;
    setEditIsActive(editingDoc.isActive ?? true);
    setEditPurchaseMode(editingDoc.appliesToPurchaseMode ?? "both");
    setEditTitleType(editingDoc.appliesToTitleType ?? "any");
    setEditCaseType(editingDoc.appliesToCaseType ?? "");
    setEditGroup(editingDoc.documentGroup ?? "Others");
    setEditSortOrder(typeof editingDoc.sortOrder === "number" ? editingDoc.sortOrder : 0);
    setEditCategory(editingDoc.category ?? "general");
    setEditFileNamingRule((editingDoc as any).fileNamingRule ? String((editingDoc as any).fileNamingRule) : "");
    setEditClauseInsertionMode((editingDoc as any).clauseInsertionMode ? String((editingDoc as any).clauseInsertionMode) : "prefer_placeholder_else_append");
    setEditApplicabilityMode((editingDoc as any).applicabilityMode ? String((editingDoc as any).applicabilityMode) : "universal");
    setEditApplicabilityRulesText((editingDoc as any).applicabilityRules ? JSON.stringify((editingDoc as any).applicabilityRules, null, 2) : "");
    setEditChecklistMode((editingDoc as any).checklistMode ? String((editingDoc as any).checklistMode) : "off");
    setEditChecklistItemsText((editingDoc as any).checklistItems ? JSON.stringify((editingDoc as any).checklistItems, null, 2) : "");
    setNamingPreviewCaseId("");
    setNamingPreviewFileName("");
  }, [editingDoc]);

  const platformDocClausePlaceholdersQuery = useQuery<{ supported: boolean; hasClausesPlaceholder: boolean; clauseCodePlaceholders: string[] }>({
    queryKey: ["platform-document-clause-placeholders", editingDoc?.id, editDocOpen],
    queryFn: ({ signal }) => apiFetchJson(`/platform/documents/${editingDoc!.id}/clause-placeholders`, { signal }),
    enabled: editDocOpen && !!editingDoc,
    retry: false,
  });

  const platformDocRulesQuery = useQuery<{ document: PlatformDoc; rules: { isRequired?: boolean | null } | null }>({
    queryKey: ["platform-document-rules", editingDoc?.id, editDocOpen],
    queryFn: ({ signal }) => apiFetchJson(`/platform/documents/${editingDoc!.id}/applicability`, { signal }),
    enabled: editDocOpen && !!editingDoc,
    retry: false,
  });

  useEffect(() => {
    if (!platformDocRulesQuery.data) return;
    const r = platformDocRulesQuery.data.rules as any;
    setEditIsRequired(Boolean(r?.isRequired ?? r?.is_required ?? false));
  }, [platformDocRulesQuery.data]);

  type PlatformClauseRow = {
    id: number;
    clauseCode: string;
    title: string;
    category: string;
    language: string;
    body: string;
    notes: string | null;
    tags: string[];
    status: string;
    isSystem: boolean;
    sortOrder: number;
  };

  const platformClausesQuery = useQuery<PlatformClauseRow[]>({
    queryKey: ["platform-clauses", clausesOpen, clauseSearch],
    queryFn: ({ signal }) => apiFetchJson(`/platform/clauses?q=${encodeURIComponent(clauseSearch)}`, { signal }),
    enabled: clausesOpen,
    retry: false,
  });

  const platformClauseUpsertMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        title: clauseTitle.trim(),
        clauseCode: clauseCode.trim(),
        category: clauseCategory,
        language: clauseLanguage.trim() || "en",
        body: clauseBody,
        status: clauseStatus,
        tags: clauseTags.split(",").map((x) => x.trim()).filter(Boolean),
      };
      if (editingClause?.id) return apiFetchJson(`/platform/clauses/${editingClause.id}`, { method: "PUT", body: JSON.stringify(payload) });
      return apiFetchJson(`/platform/clauses`, { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["platform-clauses"] });
      toast({ title: "Clause saved" });
      setClauseEditorOpen(false);
      setEditingClause(null);
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  const foldersQuery = useQuery<SystemFolder[]>({
    queryKey: ["system-folders"],
    queryFn: async () => listItems<SystemFolder>(await apiFetchJson("/platform/folders")),
    retry: false,
  });
  const folders = foldersQuery.data ?? [];

  const docsQuery = useQuery<PlatformDoc[]>({
    queryKey: ["platform-documents", selectedFolderId],
    queryFn: async () => {
      const url = selectedFolderId !== null
        ? `/platform/documents?folderId=${selectedFolderId}`
        : "/platform/documents";
      const res = await apiFetchJson(url);
      return listItems<PlatformDoc>(res);
    },
    retry: false,
  });
  const docs = docsQuery.data ?? [];
  const docsLoading = docsQuery.isLoading;

  const varGroupsQuery = useQuery<DocumentVariableDefinition[]>({
    queryKey: ["platform-document-variables-ref"],
    queryFn: async () => ensureArray<DocumentVariableDefinition>(await apiFetchJson("/platform/document-variables?active=1")),
    enabled: showVarRef,
    retry: false,
  });

  const platformVariablesQuery = useQuery<DocumentVariableDefinition[]>({
    queryKey: ["platform-document-variables", includeInactiveVariables],
    queryFn: async ({ signal }) =>
      ensureArray<DocumentVariableDefinition>(
        await apiFetchJson(`/platform/document-variables${includeInactiveVariables ? "" : "?active=1"}`, { signal }),
      ),
    enabled: variableRegistryOpen,
    retry: false,
  });

  const saveVariableMutation = useMutation({
    mutationFn: async (payload: { id?: number; data: Record<string, unknown> }) => {
      if (payload.id) {
        return await apiFetchJson(`/platform/document-variables/${payload.id}`, { method: "PUT", body: JSON.stringify(payload.data) });
      }
      return await apiFetchJson("/platform/document-variables", { method: "POST", body: JSON.stringify(payload.data) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["platform-document-variables"] });
      toast({ title: "Variable saved" });
      setEditVariableOpen(false);
      setEditVariableId(null);
    },
    onError: (e) => toastError(toast, e, "Save variable failed"),
  });
  const varGroups = (() => {
    const vars = ensureArray(varGroupsQuery.data);
    const byGroup: Record<string, { group: string; vars: { key: string; label: string }[] }> = {};
    for (const v of vars) {
      const g = v.category || "other";
      if (!byGroup[g]) byGroup[g] = { group: g, vars: [] };
      byGroup[g].vars.push({ key: v.key, label: v.label });
    }
    return Object.values(byGroup).map((g) => ({ ...g, vars: g.vars.sort((a, b) => a.key.localeCompare(b.key)) })).sort((a, b) => a.group.localeCompare(b.group));
  })();

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
      return await apiFetchJson<SystemFolder>("/platform/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId }),
      });
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
    onError: (e) => toastError(toast, e, "Failed to create folder"),
  });

  const updateFolderMutation = useMutation({
    mutationFn: async ({ id, name, isDisabled }: { id: number; name?: string; isDisabled?: boolean }) => {
      return await apiFetchJson<SystemFolder>(`/platform/folders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, isDisabled }),
      });
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
    onError: (e) => toastError(toast, e, "Failed to update folder"),
  });

  const reorderMutation = useMutation({
    mutationFn: async ({ folderId, direction }: { folderId: number; direction: "up" | "down" }) => {
      await apiFetchJson(`/platform/folders/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, direction }),
      });
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
      toastError(toast, e, "Failed to reorder");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["system-folders"] });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId: number) => {
      await apiFetchJson(`/platform/folders/${folderId}`, { method: "DELETE" });
    },
    onSuccess: (_: any, folderId: number) => {
      queryClient.invalidateQueries({ queryKey: ["system-folders"] });
      if (selectedFolderId === folderId) setSelectedFolderId(null);
      toast({ title: "Folder deleted" });
    },
    onError: (e) => toastError(toast, e, "Failed to delete folder"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: number) => {
      await apiFetchJson(`/platform/documents/${docId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-documents"], exact: false });
      toast({ title: "Document deleted" });
    },
    onError: (e) => toastError(toast, e, "Could not delete document"),
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_TYPES[file.type]) {
      toast({ title: "Unsupported file type", description: "Please upload a PDF, Word, Excel, image, or TXT file.", variant: "destructive" });
      return;
    }
    setSelectedFile(file);
    setTextUploadContent("");
    if (!form.name) setForm(f => ({ ...f, name: file.name.replace(/\.[^.]+$/, "") }));
  };

  const handleUpload = async () => {
    if (!form.name) return;
    const file =
      selectedFile ??
      (textUploadContent.trim()
        ? new globalThis.File(
            [textUploadContent],
            form.name.toLowerCase().endsWith(".txt") ? form.name : `${form.name}.txt`,
            { type: "text/plain" },
          )
        : null);
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      const { objectPath } = await apiFetchJson<{ objectPath: string }>("/storage/upload", { method: "POST", body: formData });

      await apiFetchJson(`/platform/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          description: form.description || null,
          category: form.category,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          objectPath,
          firmId: null,
          folderId: selectedFolderId,
        }),
      });

      queryClient.invalidateQueries({ queryKey: ["platform-documents"], exact: false });
      toast({ title: "Document uploaded", description: `${form.name} has been added.` });
      setShowUpload(false);
      setForm({ name: "", description: "", category: "general" });
      setSelectedFile(null);
      setTextUploadContent("");
    } catch (e) {
      toastError(toast, e, "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (doc: PlatformDoc) => {
    if (downloadingDocId === doc.id) return;
    setDownloadingDocId(doc.id);
    try {
      const blob = await apiFetchBlob(`/platform/documents/${doc.id}/download`);
      downloadBlob(blob, doc.fileName || "download");
    } catch (e) {
      toastError(toast, e, "Download failed");
    } finally {
      setDownloadingDocId(null);
    }
  };

  const handleEditPdfMappings = async (doc: PlatformDoc) => {
    try {
      const blob = await apiFetchBlob(`/platform/documents/${doc.id}/download`);
      const url = URL.createObjectURL(blob);
      setEditingPdfUrl(url);
      setEditingPdfDoc(doc);
    } catch (e) {
      toastError(toast, e, "Failed to load PDF");
    }
  };

  const updateDocMutation = useMutation({
    mutationFn: async (payload: { id: number; patch: Record<string, unknown> }) => {
      await apiFetchJson(`/platform/documents/${payload.id}`, { method: "PATCH", body: JSON.stringify(payload.patch) });
      await apiFetchJson(`/platform/documents/${payload.id}/applicability`, { method: "PUT", body: JSON.stringify(payload.patch) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["platform-documents"], exact: false });
      toast({ title: "Document updated" });
    },
    onError: (e) => toastError(toast, e, "Update failed"),
  });

  const bindingsQuery = useQuery<TemplateBindingsResponse>({
    queryKey: ["platform-document-bindings", editingDoc?.id, bindingsOpen],
    queryFn: ({ signal }) => apiFetchJson(`/platform/documents/${editingDoc!.id}/bindings`, { signal }),
    enabled: bindingsOpen && !!editingDoc,
    retry: false,
  });

  useEffect(() => {
    if (!bindingsQuery.data) return;
    if (Object.keys(bindingsDraft).length > 0) return;
    const m: Record<string, DocumentTemplateBinding> = {};
    for (const b of bindingsQuery.data.bindings ?? []) m[b.variableKey] = b;
    setBindingsDraft(m);
  }, [bindingsQuery.data, bindingsDraft]);

  const saveBindingsMutation = useMutation({
    mutationFn: (payload: { id: number; bindings: DocumentTemplateBinding[] }) =>
      apiFetchJson(`/platform/documents/${payload.id}/bindings`, { method: "PUT", body: JSON.stringify({ bindings: payload.bindings }) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["platform-document-bindings"], exact: false });
      toast({ title: "Bindings saved" });
    },
    onError: (e) => toastError(toast, e, "Save bindings failed"),
  });

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
    <PlatformPage>
      <PlatformPageHeader
        title="System Documents"
        description="Manage global system folders and master documents for all firms"
        actions={
          <Button variant="outline" onClick={() => setClausesOpen(true)} className="gap-2">
            <BookOpen className="w-4 h-4" />
            Clauses
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 min-h-[500px]">
        <div className="min-w-0">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-700">Folders</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => { setNewFolderParentId(null); setNewFolderName(""); setShowNewFolder(true); }}
                  disabled={createFolderMutation.isPending || updateFolderMutation.isPending || deleteFolderMutation.isPending}
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

              {foldersQuery.isError ? (
                <QueryFallback title="Folders unavailable" error={foldersQuery.error} onRetry={() => foldersQuery.refetch()} isRetrying={foldersQuery.isFetching} />
              ) : foldersQuery.isLoading ? (
                <PlatformLoadingState title="Loading folders..." className="border-none bg-transparent" />
              ) : (
                <>
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
                    <PlatformEmptyState
                      icon={<FolderOpen className="w-5 h-5" />}
                      title="No folders yet"
                      description="Create a folder to organize system documents."
                      primaryAction={{ label: "New Folder", onClick: () => { setNewFolderParentId(null); setNewFolderName(""); setShowNewFolder(true); } }}
                      className="border-none bg-transparent"
                    />
                  )}
                </>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      setVariableRegistryOpen(true);
                      setIncludeInactiveVariables(false);
                      setVariableSearch("");
                    }}
                  >
                    <FileEdit className="w-3.5 h-3.5" />
                    Variable Registry
                  </Button>
                  <Button onClick={() => setShowUpload(true)} size="sm" className="gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    Upload Document
                  </Button>
                </div>
              </div>

              {docsQuery.isError ? (
                <QueryFallback title="Documents unavailable" error={docsQuery.error} onRetry={() => docsQuery.refetch()} isRetrying={docsQuery.isFetching} />
              ) : docsLoading ? (
                <PlatformLoadingState title="Loading documents..." className="border-none bg-transparent" />
              ) : docs.length === 0 ? (
                <PlatformEmptyState
                  icon={<FileText className="w-5 h-5" />}
                  title="No documents"
                  description={selectedFolder ? `Upload a document to "${selectedFolder.name}".` : "Upload a document to get started."}
                  primaryAction={{ label: "Upload Document", onClick: () => setShowUpload(true) }}
                  className="border-none bg-transparent"
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[900px]">
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
                              <div className="flex items-center gap-2 min-w-0">
                                <p className="font-medium text-slate-900 truncate" title={doc.name}>{doc.name}</p>
                                <Badge variant="outline" className={cn("text-[10px]", doc.isActive ? "text-emerald-700 border-emerald-200" : "text-slate-500 border-slate-200")}>
                                  {doc.isActive ? "Active" : "Inactive"}
                                </Badge>
                              </div>
                              {doc.description && <p className="text-xs text-slate-500">{doc.description}</p>}
                              <p className="text-xs text-slate-400 truncate max-w-[520px]" title={doc.fileName}>{doc.fileName}</p>
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
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 gap-1 text-slate-600 hover:text-slate-700"
                              onClick={() => { setEditingDoc(doc); setEditDocOpen(true); }}
                              title="Edit applicability rules"
                              disabled={deleteMutation.isPending}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                              <span className="text-xs">Rules</span>
                            </Button>
                            {doc.fileType === "application/pdf" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 gap-1 text-blue-600 hover:text-blue-700"
                                onClick={() => handleEditPdfMappings(doc)}
                                title="Edit PDF mappings"
                                disabled={deleteMutation.isPending}
                              >
                                <FileEdit className="w-3.5 h-3.5" />
                                <span className="text-xs">Map</span>
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => handleDownload(doc)}
                              title="Download"
                              disabled={deleteMutation.isPending || downloadingDocId === doc.id}
                            >
                              <Download className={cn("w-3.5 h-3.5", downloadingDocId === doc.id && "animate-bounce")} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                              onClick={() => {
                                if (!confirm(`Delete "${doc.name}"?`)) return;
                                deleteMutation.mutate(doc.id);
                              }}
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
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showUpload} onOpenChange={setShowUpload}>
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Upload Document{selectedFolder ? ` to "${selectedFolder.name}"` : ""}</DialogTitle>
            <DialogDescription className="sr-only">Upload a new platform document.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
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

            {!selectedFile && (
              <div className="space-y-2">
                <Label>Quick TXT Upload</Label>
                <Textarea
                  placeholder="Paste text here to upload a .txt document (no file picker needed)..."
                  value={textUploadContent}
                  onChange={e => setTextUploadContent(e.target.value)}
                  rows={3}
                />
              </div>
            )}

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
          <DialogFooter className="pt-2 border-t">
            <Button variant="outline" onClick={() => setShowUpload(false)}>Cancel</Button>
            <Button onClick={handleUpload} disabled={!form.name || uploading || (!selectedFile && !textUploadContent.trim())}>
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editDocOpen} onOpenChange={(v) => { if (!v) setEditingDoc(null); setEditDocOpen(v); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Document Rules</DialogTitle>
            <DialogDescription className="sr-only">Edit document rule settings.</DialogDescription>
          </DialogHeader>
          {editingDoc && (
            <div className="space-y-4 py-1">
              <div>
                <div className="text-xs text-slate-500">Name</div>
                <div className="text-sm font-medium text-slate-900">{editingDoc.name}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Active</Label>
                  <Select value={String(editIsActive)} onValueChange={(v) => setEditIsActive(v === "true")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Active</SelectItem>
                      <SelectItem value="false">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Group</Label>
                  <Select value={editGroup} onValueChange={setEditGroup}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SPA">SPA</SelectItem>
                      <SelectItem value="Loan">Loan</SelectItem>
                      <SelectItem value="MOT / Transfer">MOT / Transfer</SelectItem>
                      <SelectItem value="Completion">Completion</SelectItem>
                      <SelectItem value="Others">Others</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Applies to Purchase Mode</Label>
                  <Select value={editPurchaseMode} onValueChange={setEditPurchaseMode}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">Both</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="loan">Loan</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Applies to Title Type</Label>
                  <Select value={editTitleType} onValueChange={setEditTitleType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      <SelectItem value="master">Master</SelectItem>
                      <SelectItem value="strata">Strata</SelectItem>
                      <SelectItem value="individual">Individual</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Applies to Case Type (optional)</Label>
                  <Input value={editCaseType} onChange={(e) => setEditCaseType(e.target.value)} placeholder="e.g. Primary Market" />
                </div>
                <div className="space-y-1.5">
                  <Label>Sort order</Label>
                  <Input inputMode="numeric" value={String(editSortOrder)} onChange={(e) => setEditSortOrder(Number(e.target.value || "0"))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={editCategory} onValueChange={setEditCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox checked={editIsRequired} onCheckedChange={(v) => setEditIsRequired(Boolean(v))} />
                <span className="text-sm text-slate-700">Required in checklist</span>
              </div>
              <div className="space-y-1.5">
                <Label>Clause insertion mode</Label>
                <Select value={editClauseInsertionMode} onValueChange={setEditClauseInsertionMode}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prefer_placeholder_else_append">Prefer placeholder else append</SelectItem>
                    <SelectItem value="explicit_placeholder_only">Explicit placeholder only</SelectItem>
                    <SelectItem value="append_to_end">Append to end</SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-xs text-slate-500">
                  Tip: place {"{{clauses}}"} or {"{{clause_CODE}}"} in the DOCX to control insertion location.
                </div>
                {platformDocClausePlaceholdersQuery.data?.supported ? (
                  <div className="text-xs text-slate-600">
                    Detected: {"{{clauses}}"}={platformDocClausePlaceholdersQuery.data.hasClausesPlaceholder ? "yes" : "no"} • {"{{clause_CODE}}"}={platformDocClausePlaceholdersQuery.data.clauseCodePlaceholders.length}
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">Detected placeholders: unavailable (non-DOCX).</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>File naming rule</Label>
                <Textarea
                  value={editFileNamingRule}
                  onChange={(e) => setEditFileNamingRule(e.target.value)}
                  placeholder="{{our_ref}} - {{document_title}}"
                  rows={2}
                />
                <div className="text-xs text-slate-500">
                  Tokens: {"{{our_ref}} {{case_id}} {{document_title}} {{template_name}} {{generated_date}} {{generated_datetime}} {{primary_client_name}} {{purchaser_names}} {{borrower_names}} {{project_name}} {{developer_name}} {{unit_no}} {{parcel_no}} {{property_description_short}} {{bank_name}} {{date_ymd}} {{date_dmy}} {{timestamp_compact}}"}
                </div>
                <div className="flex flex-wrap gap-1">
                  {["{{our_ref}}","{{document_title}}","{{primary_client_name}}","{{project_name}}","{{unit_no}}","{{bank_name}}","{{date_ymd}}"].map((tk) => (
                    <Button key={tk} type="button" variant="outline" size="sm" onClick={() => setEditFileNamingRule((prev) => `${prev}${prev ? " " : ""}${tk}`)}>
                      {tk}
                    </Button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2 items-end">
                  <div className="space-y-1.5">
                    <Label>Preview case ID</Label>
                    <Input value={namingPreviewCaseId} onChange={(e) => setNamingPreviewCaseId(e.target.value)} placeholder="e.g. 123" />
                  </div>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const id = parseInt(namingPreviewCaseId || "", 10);
                      if (!Number.isFinite(id)) {
                        toast({ title: "Invalid case ID" });
                        return;
                      }
                      try {
                        const resp = await apiFetchJson<{ fileName: string; ruleUsed: string; warnings?: string[] }>(`/cases/${id}/documents/filename-preview`, {
                          method: "POST",
                          body: JSON.stringify({
                            platformDocumentId: editingDoc.id,
                            documentName: editingDoc.name,
                            originalFileName: (editingDoc as any).fileName ?? "docx",
                            fallbackExt: ((editingDoc as any).fileType ?? "docx") === "pdf" ? "pdf" : "docx",
                          }),
                        });
                        setNamingPreviewFileName(`${resp.fileName}${resp.warnings?.length ? ` | ${resp.warnings.join(", ")}` : ""}`);
                      } catch (e) {
                        toastError(toast, e, "Preview failed");
                      }
                    }}
                  >
                    Preview filename
                  </Button>
                </div>
                {namingPreviewFileName ? (
                  <div className="text-sm text-slate-700 break-words">
                    <span className="text-xs text-slate-500">Preview:</span> {namingPreviewFileName}
                  </div>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label>Applicability mode</Label>
                <Select value={editApplicabilityMode} onValueChange={setEditApplicabilityMode}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="universal">Universal</SelectItem>
                    <SelectItem value="rules_only">Rules only</SelectItem>
                    <SelectItem value="rules_with_manual_override">Rules + manual override</SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-xs text-slate-500">Example rule: {"{\"all\":[{\"field\":\"purchase_mode\",\"operator\":\"equals\",\"value\":\"loan\"}]}"}</div>
              </div>
              <div className="space-y-1.5">
                <Label>Applicability rules (JSON)</Label>
                <Textarea
                  value={editApplicabilityRulesText}
                  onChange={(e) => setEditApplicabilityRulesText(e.target.value)}
                  rows={6}
                  placeholder='{"all":[{"field":"purchase_mode","operator":"equals","value":"loan"}]}'
                />
              </div>
              <div className="space-y-1.5">
                <Label>Checklist mode</Label>
                <Select value={editChecklistMode} onValueChange={setEditChecklistMode}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="advisory">Advisory</SelectItem>
                    <SelectItem value="required_to_generate">Required to generate</SelectItem>
                    <SelectItem value="required_with_manual_override">Required + manual override</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Checklist items (JSON)</Label>
                <Textarea
                  value={editChecklistItemsText}
                  onChange={(e) => setEditChecklistItemsText(e.target.value)}
                  rows={6}
                  placeholder='[{"id":"bank_name","label":"Bank name exists","type":"required_case_field","required":true,"config":{"fieldKey":"bank_name"}}]'
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => { setBindingsDraft({}); setBindingsOpen(true); }}
                  disabled={!editingDoc || updateDocMutation.isPending}
                >
                  Bindings
                </Button>
                <Button variant="outline" onClick={() => setEditDocOpen(false)} disabled={updateDocMutation.isPending}>Cancel</Button>
                <Button
                  onClick={() => {
                    updateDocMutation.mutate({
                      id: editingDoc.id,
                      patch: {
                        isActive: editIsActive,
                        isRequired: editIsRequired,
                        appliesToPurchaseMode: editPurchaseMode,
                        appliesToTitleType: editTitleType,
                        appliesToCaseType: editCaseType ? editCaseType : null,
                        documentGroup: editGroup,
                        sortOrder: editSortOrder,
                        category: editCategory,
                        fileNamingRule: editFileNamingRule.trim() ? editFileNamingRule.trim() : null,
                        clauseInsertionMode: editClauseInsertionMode || null,
                        applicabilityMode: editApplicabilityMode || "universal",
                        applicabilityRules: (() => {
                          try { return editApplicabilityRulesText.trim() ? JSON.parse(editApplicabilityRulesText) : null; } catch { return null; }
                        })(),
                        checklistMode: editChecklistMode || "off",
                        checklistItems: (() => {
                          try { return editChecklistItemsText.trim() ? JSON.parse(editChecklistItemsText) : null; } catch { return null; }
                        })(),
                      },
                    });
                    setEditDocOpen(false);
                  }}
                  disabled={updateDocMutation.isPending}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={bindingsOpen} onOpenChange={(v) => { if (!v) { setBindingsOpen(false); setBindingsDraft({}); } else setBindingsOpen(true); }}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Document Bindings</DialogTitle>
            <DialogDescription className="sr-only">Configure variable bindings for the selected document.</DialogDescription>
          </DialogHeader>
          {!editingDoc ? (
            <div className="text-slate-500 py-6">No document selected.</div>
          ) : bindingsQuery.isError ? (
            <QueryFallback title="Bindings unavailable" error={bindingsQuery.error} onRetry={() => bindingsQuery.refetch()} isRetrying={bindingsQuery.isFetching} />
          ) : bindingsQuery.isLoading ? (
            <div className="text-slate-500 py-6">Loading bindings...</div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-sm font-medium text-slate-900">Detected placeholders</div>
                <div className="mt-1 text-xs text-slate-600 break-words">
                  {(bindingsQuery.data?.placeholders ?? []).length === 0 ? "No placeholders detected." : (bindingsQuery.data?.placeholders ?? []).join(", ")}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th className="py-2 pr-3">Variable</th>
                      <th className="py-2 pr-3">Mode</th>
                      <th className="py-2 pr-3">Source path / Fixed</th>
                      <th className="py-2 pr-3">Formatter</th>
                      <th className="py-2 pr-3">Required</th>
                      <th className="py-2 pr-3">Fallback</th>
                      <th className="py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const vars = bindingsQuery.data?.variables ?? [];
                      const placeholders = bindingsQuery.data?.placeholders ?? [];
                      const keys = Array.from(new Set<string>([...placeholders, ...vars.map((v) => v.key), ...Object.keys(bindingsDraft)])).sort((a, b) => a.localeCompare(b));
                      return keys.map((key) => {
                        const def = vars.find((v) => v.key === key);
                        const b = bindingsDraft[key] ?? {
                          variableKey: key,
                          sourceMode: "registry_default" as const,
                          sourcePath: def?.sourcePath ?? null,
                          fixedValue: null,
                          formatterOverride: null,
                          isRequired: false,
                          fallbackValue: null,
                          notes: null,
                        };
                        const mode = b.sourceMode;
                        return (
                          <tr key={key} className="border-t border-slate-200 align-top">
                            <td className="py-2 pr-3 min-w-[180px]">
                              <div className="font-medium text-slate-900 break-words">{key}</div>
                              <div className="text-xs text-slate-500 break-words">{def?.label ?? ""}</div>
                            </td>
                            <td className="py-2 pr-3 min-w-[160px]">
                              <Select
                                value={mode}
                                onValueChange={(v) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, sourceMode: (v as any) } }))}
                              >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="registry_default">Registry default</SelectItem>
                                  <SelectItem value="custom_path">Custom path</SelectItem>
                                  <SelectItem value="fixed_value">Fixed value</SelectItem>
                                </SelectContent>
                              </Select>
                            </td>
                            <td className="py-2 pr-3 min-w-[220px]">
                              <Input
                                value={mode === "fixed_value" ? (b.fixedValue ?? "") : (b.sourcePath ?? "")}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setBindingsDraft((prev) => ({ ...prev, [key]: mode === "fixed_value" ? { ...b, fixedValue: v } : { ...b, sourcePath: v } }));
                                }}
                                placeholder={mode === "fixed_value" ? "e.g. RM 500,000.00" : "e.g. reference_no"}
                              />
                            </td>
                            <td className="py-2 pr-3 min-w-[140px]">
                              <Input value={b.formatterOverride ?? ""} onChange={(e) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, formatterOverride: e.target.value || null } }))} placeholder={def?.formatter ?? "e.g. currency"} />
                            </td>
                            <td className="py-2 pr-3">
                              <Checkbox checked={b.isRequired} onCheckedChange={(v) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, isRequired: Boolean(v) } }))} />
                            </td>
                            <td className="py-2 pr-3 min-w-[140px]">
                              <Input value={b.fallbackValue ?? ""} onChange={(e) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, fallbackValue: e.target.value || null } }))} placeholder="(optional)" />
                            </td>
                            <td className="py-2 text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setBindingsDraft((prev) => {
                                    const next = { ...prev };
                                    delete next[key];
                                    return next;
                                  });
                                }}
                              >
                                Clear
                              </Button>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter className="pt-2 border-t">
            <Button variant="outline" onClick={() => { setBindingsOpen(false); setBindingsDraft({}); }}>
              Close
            </Button>
            <Button
              onClick={() => {
                if (!editingDoc) return;
                const bindings = Object.values(bindingsDraft).map((b) => ({
                  ...b,
                  sourcePath: b.sourceMode === "fixed_value" ? null : (b.sourcePath ? b.sourcePath : null),
                  fixedValue: b.sourceMode === "fixed_value" ? (b.fixedValue ?? "") : null,
                }));
                saveBindingsMutation.mutate({ id: editingDoc.id, bindings });
              }}
              disabled={!editingDoc || saveBindingsMutation.isPending}
            >
              {saveBindingsMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{newFolderParentId ? "New Subfolder" : "New Folder"}</DialogTitle>
            <DialogDescription className="sr-only">Create a new folder.</DialogDescription>
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
            <DialogDescription className="sr-only">Edit the selected folder.</DialogDescription>
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
            <DialogDescription className="sr-only">View and copy available template variables.</DialogDescription>
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

      <Dialog open={variableRegistryOpen} onOpenChange={setVariableRegistryOpen}>
        <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Variable Registry</DialogTitle>
            <DialogDescription className="sr-only">Manage system-level document variables.</DialogDescription>
            <p className="text-sm text-slate-500 mt-1">
              Manage system-level document variables used for template bindings and preview.
            </p>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col md:flex-row md:items-center gap-2 justify-between">
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Search key/label..."
                  value={variableSearch}
                  onChange={(e) => setVariableSearch(e.target.value)}
                  className="w-[280px]"
                />
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={includeInactiveVariables}
                    onCheckedChange={(v) => setIncludeInactiveVariables(Boolean(v))}
                  />
                  <span className="text-sm text-slate-600">Include inactive</span>
                </div>
              </div>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setEditVariableId(null);
                  setVariableForm({
                    key: "",
                    label: "",
                    description: "",
                    category: "case",
                    valueType: "string",
                    sourcePath: "",
                    formatter: "",
                    exampleValue: "",
                    isActive: true,
                    sortOrder: 0,
                  });
                  setEditVariableOpen(true);
                }}
              >
                <Plus className="w-3.5 h-3.5" />
                New Variable
              </Button>
            </div>

            {platformVariablesQuery.isError ? (
              <QueryFallback title="Variables unavailable" error={platformVariablesQuery.error} onRetry={() => platformVariablesQuery.refetch()} isRetrying={platformVariablesQuery.isFetching} />
            ) : platformVariablesQuery.isLoading ? (
              <div className="text-slate-500 text-sm py-8 text-center">Loading variables...</div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2">Key</th>
                        <th className="text-left px-3 py-2">Label</th>
                        <th className="text-left px-3 py-2">Category</th>
                        <th className="text-left px-3 py-2">Type</th>
                        <th className="text-left px-3 py-2">Active</th>
                        <th className="text-left px-3 py-2">Source</th>
                        <th className="text-left px-3 py-2">Formatter</th>
                        <th className="text-left px-3 py-2">Sort</th>
                        <th className="text-right px-3 py-2">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {ensureArray(platformVariablesQuery.data)
                        .filter((v) => {
                          const q = variableSearch.trim().toLowerCase();
                          if (!q) return true;
                          return v.key.toLowerCase().includes(q) || v.label.toLowerCase().includes(q);
                        })
                        .map((v) => (
                          <tr key={v.id} className="hover:bg-slate-50/50">
                            <td className="px-3 py-2 font-mono text-xs text-slate-800">{v.key}</td>
                            <td className="px-3 py-2 text-slate-700">{v.label}</td>
                            <td className="px-3 py-2 text-slate-600">{v.category}</td>
                            <td className="px-3 py-2 text-slate-600">{v.valueType}</td>
                            <td className="px-3 py-2">
                              {v.isActive ? (
                                <Badge className="bg-green-100 text-green-800">Active</Badge>
                              ) : (
                                <Badge variant="secondary">Inactive</Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 text-slate-600 font-mono text-xs">{v.sourcePath ?? ""}</td>
                            <td className="px-3 py-2 text-slate-600 font-mono text-xs">{v.formatter ?? ""}</td>
                            <td className="px-3 py-2 text-slate-600">{String(v.sortOrder ?? 0)}</td>
                            <td className="px-3 py-2 text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditVariableId(v.id);
                                  setVariableForm({
                                    key: v.key,
                                    label: v.label,
                                    description: v.description ?? "",
                                    category: v.category ?? "case",
                                    valueType: v.valueType ?? "string",
                                    sourcePath: v.sourcePath ?? "",
                                    formatter: v.formatter ?? "",
                                    exampleValue: v.exampleValue ?? "",
                                    isActive: Boolean(v.isActive),
                                    sortOrder: typeof v.sortOrder === "number" ? v.sortOrder : Number(v.sortOrder ?? 0),
                                  });
                                  setEditVariableOpen(true);
                                }}
                              >
                                Edit
                              </Button>
                            </td>
                          </tr>
                        ))}
                      {ensureArray(platformVariablesQuery.data).length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-3 py-10 text-center text-slate-500">No variables found.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="pt-2 border-t">
            <Button variant="outline" onClick={() => setVariableRegistryOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editVariableOpen} onOpenChange={setEditVariableOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editVariableId ? "Edit Variable" : "New Variable"}</DialogTitle>
            <DialogDescription className="sr-only">Create or edit a document variable definition.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>Key</Label>
              <Input
                value={variableForm.key}
                onChange={(e) => setVariableForm((prev) => ({ ...prev, key: e.target.value }))}
                placeholder="e.g. reference_no"
                disabled={!!editVariableId}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input
                value={variableForm.label}
                onChange={(e) => setVariableForm((prev) => ({ ...prev, label: e.target.value }))}
                placeholder="e.g. Case Reference No."
              />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={variableForm.category} onValueChange={(v) => setVariableForm((prev) => ({ ...prev, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["case", "purchaser", "property", "loan", "developer", "project", "workflow", "custom"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Value Type</Label>
              <Select value={variableForm.valueType} onValueChange={(v) => setVariableForm((prev) => ({ ...prev, valueType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["string", "number", "date", "boolean", "richtext", "array"].map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Source Path</Label>
              <Input
                value={variableForm.sourcePath}
                onChange={(e) => setVariableForm((prev) => ({ ...prev, sourcePath: e.target.value }))}
                placeholder="e.g. reference_no"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Formatter</Label>
              <Input
                value={variableForm.formatter}
                onChange={(e) => setVariableForm((prev) => ({ ...prev, formatter: e.target.value }))}
                placeholder="e.g. currency"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Example Value</Label>
              <Input
                value={variableForm.exampleValue}
                onChange={(e) => setVariableForm((prev) => ({ ...prev, exampleValue: e.target.value }))}
                placeholder="e.g. LCP-000123"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Sort Order</Label>
              <Input
                inputMode="numeric"
                value={String(variableForm.sortOrder)}
                onChange={(e) => setVariableForm((prev) => ({ ...prev, sortOrder: Number(e.target.value || "0") }))}
              />
            </div>
            <div className="md:col-span-2 space-y-1.5">
              <Label>Description</Label>
              <Textarea
                value={variableForm.description}
                onChange={(e) => setVariableForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="(optional)"
                rows={3}
              />
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <Checkbox checked={variableForm.isActive} onCheckedChange={(v) => setVariableForm((prev) => ({ ...prev, isActive: Boolean(v) }))} />
              <span className="text-sm text-slate-700">Active</span>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditVariableOpen(false);
                setEditVariableId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const payload = {
                  key: variableForm.key.trim(),
                  label: variableForm.label.trim(),
                  description: variableForm.description.trim() ? variableForm.description.trim() : null,
                  category: variableForm.category,
                  valueType: variableForm.valueType,
                  sourcePath: variableForm.sourcePath.trim() ? variableForm.sourcePath.trim() : null,
                  formatter: variableForm.formatter.trim() ? variableForm.formatter.trim() : null,
                  exampleValue: variableForm.exampleValue.trim() ? variableForm.exampleValue.trim() : null,
                  isActive: Boolean(variableForm.isActive),
                  sortOrder: Number.isFinite(variableForm.sortOrder) ? Number(variableForm.sortOrder) : 0,
                };
                saveVariableMutation.mutate({ id: editVariableId ?? undefined, data: payload });
              }}
              disabled={saveVariableMutation.isPending || !variableForm.label.trim() || (!editVariableId && !variableForm.key.trim())}
            >
              {saveVariableMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clausesOpen} onOpenChange={setClausesOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Platform Clauses</DialogTitle>
            <DialogDescription className="sr-only">Browse and manage platform clauses.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <Input value={clauseSearch} onChange={(e) => setClauseSearch(e.target.value)} placeholder="Search clauses..." className="w-[320px]" />
              <Button
                size="sm"
                onClick={() => {
                  setEditingClause(null);
                  setClauseTitle("");
                  setClauseCode("");
                  setClauseCategory("General");
                  setClauseLanguage("en");
                  setClauseBody("");
                  setClauseStatus("draft");
                  setClauseTags("");
                  setClauseEditorOpen(true);
                }}
              >
                New clause
              </Button>
            </div>

            {platformClausesQuery.isError ? (
              <QueryFallback title="Clauses unavailable" error={platformClausesQuery.error} onRetry={() => platformClausesQuery.refetch()} isRetrying={platformClausesQuery.isFetching} />
            ) : platformClausesQuery.isLoading ? (
              <div className="text-slate-500 text-sm py-6">Loading clauses...</div>
            ) : (
              <div className="space-y-2">
                {(platformClausesQuery.data ?? []).map((c) => (
                  <div key={c.id} className="rounded border bg-white p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">{c.clauseCode} • {c.title}</div>
                        <div className="text-xs text-slate-500 truncate">{c.category} • {c.language} • {c.status}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingClause(c);
                            setClauseTitle(c.title);
                            setClauseCode(c.clauseCode);
                            setClauseCategory(c.category);
                            setClauseLanguage(c.language);
                            setClauseBody(c.body);
                            setClauseStatus(c.status);
                            setClauseTags((c.tags ?? []).join(", "));
                            setClauseEditorOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                {(platformClausesQuery.data ?? []).length === 0 ? <div className="text-sm text-slate-500 py-6">No clauses.</div> : null}
              </div>
            )}
          </div>

          <Dialog open={clauseEditorOpen} onOpenChange={setClauseEditorOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{editingClause ? "Edit Clause" : "New Clause"}</DialogTitle>
                <DialogDescription className="sr-only">Create or edit a clause.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="space-y-1.5">
                  <Label>Title</Label>
                  <Input value={clauseTitle} onChange={(e) => setClauseTitle(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Clause code</Label>
                    <Input value={clauseCode} onChange={(e) => setClauseCode(e.target.value)} placeholder="e.g. SPA_SPECIAL_CONDITION_01" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Status</Label>
                    <Select value={clauseStatus} onValueChange={setClauseStatus}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="draft">Draft</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="archived">Archived</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Category</Label>
                    <Select value={clauseCategory} onValueChange={setClauseCategory}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["SPA","Loan","Banking","Property","Litigation","Corporate","General","Special Condition"].map((x) => (
                          <SelectItem key={x} value={x}>{x}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Language</Label>
                    <Input value={clauseLanguage} onChange={(e) => setClauseLanguage(e.target.value)} placeholder="en / zh-Hant" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Tags (comma separated)</Label>
                  <Input value={clauseTags} onChange={(e) => setClauseTags(e.target.value)} placeholder="spa, special, purchaser" />
                </div>
                <div className="space-y-1.5">
                  <Label>Body</Label>
                  <Textarea value={clauseBody} onChange={(e) => setClauseBody(e.target.value)} rows={8} />
                  <div className="text-xs text-slate-500">Placeholders: {"{{variable_key}}"}.</div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => { setClauseEditorOpen(false); setEditingClause(null); }}>
                    Cancel
                  </Button>
                  <Button onClick={() => platformClauseUpsertMutation.mutate()} disabled={!clauseTitle.trim() || !clauseBody.trim() || platformClauseUpsertMutation.isPending}>
                    {platformClauseUpsertMutation.isPending ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
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
    </PlatformPage>
  );
}
