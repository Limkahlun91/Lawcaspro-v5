import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FileText, Trash2, Upload, Info, Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { DOCUMENT_TYPE_LABELS } from "@workspace/documents-registry";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { downloadBlob } from "@/lib/download";
import { toastError } from "@/lib/toast-error";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";

function docTypeLabel(dt: string): string {
  return (DOCUMENT_TYPE_LABELS as Record<string, string>)[dt] ?? dt;
}

interface DocumentTemplate {
  id: number;
  name: string;
  document_type: string;
  description: string | null;
  file_name: string;
  object_path: string;
  created_at: string;
  is_active?: boolean;
  applies_to_purchase_mode?: string | null;
  applies_to_title_type?: string | null;
  applies_to_case_type?: string | null;
  document_group?: string | null;
  sort_order?: number | null;
}

interface DocumentTemplateVersion {
  id: number;
  template_id: number;
  version_no: number;
  status: "draft" | "published" | "archived";
  filename: string;
  source_object_path: string;
  created_at: string;
  created_by_name: string | null;
  published_at: string | null;
  published_by_name: string | null;
  archived_at: string | null;
  archived_by_name: string | null;
  variables_snapshot: unknown;
  applicability_rules_snapshot: unknown;
  readiness_rules_snapshot: unknown;
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

interface TemplateApplicabilityResponse {
  effective: {
    isActive: boolean;
    purchaseMode: string | null;
    titleType: string | null;
    caseType: string | null;
    projectType: string | null;
    titleSubType: string | null;
    developmentCondition: string | null;
    unitCategory: string | null;
    isTemplateCapable: boolean;
  };
}

export default function DocumentTemplates() {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const versionUploadRef = useRef<HTMLInputElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<DocumentTemplate | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateType, setTemplateType] = useState("other");
  const [templateDescription, setTemplateDescription] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [isDownloading, setIsDownloading] = useState(false);

  const canRead = hasPermission(user, "documents", "read");
  const canCreate = hasPermission(user, "documents", "create");
  const canUpdate = hasPermission(user, "documents", "update");
  const canDelete = hasPermission(user, "documents", "delete");

  const variablesQuery = useQuery<DocumentVariableDefinition[]>({
    queryKey: ["document-variables", "active"],
    queryFn: ({ signal }) => apiFetchJson("/document-variables?active=1", { signal }),
    enabled: infoOpen && canRead,
    retry: false,
  });

  const [editIsActive, setEditIsActive] = useState(true);
  const [editPurchaseMode, setEditPurchaseMode] = useState<string>("both");
  const [editTitleType, setEditTitleType] = useState<string>("any");
  const [editCaseType, setEditCaseType] = useState<string>("");
  const [editGroup, setEditGroup] = useState<string>("Others");
  const [editSortOrder, setEditSortOrder] = useState<number>(0);
  const [detailTab, setDetailTab] = useState<"details" | "versions" | "bindings" | "applicability">("details");
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [bindingsDraft, setBindingsDraft] = useState<Record<string, DocumentTemplateBinding>>({});
  const [appDraft, setAppDraft] = useState<TemplateApplicabilityResponse["effective"] | null>(null);

  useEffect(() => {
    if (!activeTemplate) return;
    setDetailTab("details");
    setVersionFile(null);
    setBindingsDraft({});
    setAppDraft(null);
    setEditIsActive(activeTemplate.is_active ?? true);
    setEditPurchaseMode(activeTemplate.applies_to_purchase_mode ?? "both");
    setEditTitleType(activeTemplate.applies_to_title_type ?? "any");
    setEditCaseType(activeTemplate.applies_to_case_type ?? "");
    setEditGroup(activeTemplate.document_group ?? "Others");
    setEditSortOrder(typeof activeTemplate.sort_order === "number" ? activeTemplate.sort_order : 0);
  }, [activeTemplate]);

  const templatesQuery = useQuery<DocumentTemplate[]>({
    queryKey: ["document-templates"],
    queryFn: ({ signal }) => apiFetchJson("/document-templates", { signal }),
    retry: false,
    enabled: canRead,
  });
  const templates = templatesQuery.data ?? [];
  const isLoading = templatesQuery.isLoading;

  const versionsQuery = useQuery<DocumentTemplateVersion[]>({
    queryKey: ["document-template-versions", activeTemplate?.id],
    queryFn: ({ signal }) => apiFetchJson(`/document-templates/${activeTemplate!.id}/versions`, { signal }),
    retry: false,
    enabled: detailOpen && !!activeTemplate && canRead,
  });
  const versions = versionsQuery.data ?? [];

  const bindingsQuery = useQuery<TemplateBindingsResponse>({
    queryKey: ["document-template-bindings", activeTemplate?.id],
    queryFn: ({ signal }) => apiFetchJson(`/document-templates/${activeTemplate!.id}/bindings`, { signal }),
    retry: false,
    enabled: detailOpen && !!activeTemplate && canRead && detailTab === "bindings",
  });

  const applicabilityQuery = useQuery<TemplateApplicabilityResponse>({
    queryKey: ["document-template-applicability", activeTemplate?.id],
    queryFn: ({ signal }) => apiFetchJson(`/document-templates/${activeTemplate!.id}/applicability`, { signal }),
    retry: false,
    enabled: detailOpen && !!activeTemplate && canRead && detailTab === "applicability",
  });

  useEffect(() => {
    if (!bindingsQuery.data) return;
    if (Object.keys(bindingsDraft).length > 0) return;
    const m: Record<string, DocumentTemplateBinding> = {};
    for (const b of bindingsQuery.data.bindings ?? []) {
      m[b.variableKey] = b;
    }
    setBindingsDraft(m);
  }, [bindingsQuery.data, bindingsDraft]);

  useEffect(() => {
    if (!applicabilityQuery.data) return;
    if (appDraft) return;
    setAppDraft(applicabilityQuery.data.effective);
  }, [applicabilityQuery.data, appDraft]);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetchJson(`/document-templates/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-templates"] });
      toast({ title: "Template deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: number; patch: Record<string, unknown> }) =>
      apiFetchJson(`/document-templates/${payload.id}`, { method: "PATCH", body: JSON.stringify(payload.patch) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-templates"] });
      toast({ title: "Template updated" });
    },
    onError: (err) => toastError(toast, err, "Update failed"),
  });

  const createVersionMutation = useMutation({
    mutationFn: async (payload: { templateId: number; file?: File | null; patch: Record<string, unknown> }) => {
      let objectPath: string | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (payload.file) {
        const formData = new FormData();
        formData.append("file", payload.file);
        const up = await apiFetchJson<{ objectPath: string }>("/storage/upload", { method: "POST", body: formData });
        objectPath = up.objectPath;
        fileName = payload.file.name;
        mimeType = payload.file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      }
      return apiFetchJson(`/document-templates/${payload.templateId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          objectPath,
          fileName,
          mimeType,
          patch: payload.patch,
        }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-template-versions", activeTemplate?.id] });
      toast({ title: "Draft saved" });
      setVersionFile(null);
    },
    onError: (err) => toastError(toast, err, "Save draft failed"),
  });

  const saveBindingsMutation = useMutation({
    mutationFn: (payload: { templateId: number; bindings: DocumentTemplateBinding[] }) =>
      apiFetchJson(`/document-templates/${payload.templateId}/bindings`, { method: "PUT", body: JSON.stringify({ bindings: payload.bindings }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-template-bindings", activeTemplate?.id] });
      toast({ title: "Bindings saved" });
    },
    onError: (err) => toastError(toast, err, "Save bindings failed"),
  });

  const saveApplicabilityMutation = useMutation({
    mutationFn: (payload: { templateId: number; patch: Record<string, unknown> }) =>
      apiFetchJson(`/document-templates/${payload.templateId}/applicability`, { method: "PUT", body: JSON.stringify(payload.patch) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-template-applicability", activeTemplate?.id] });
      await qc.invalidateQueries({ queryKey: ["document-templates"] });
      toast({ title: "Applicability saved" });
    },
    onError: (err) => toastError(toast, err, "Save applicability failed"),
  });

  const publishVersionMutation = useMutation({
    mutationFn: (payload: { templateId: number; versionId: number }) =>
      apiFetchJson(`/document-templates/${payload.templateId}/versions/${payload.versionId}/publish`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-template-versions", activeTemplate?.id] });
      await qc.invalidateQueries({ queryKey: ["document-templates"] });
      toast({ title: "Version published" });
    },
    onError: (err) => toastError(toast, err, "Publish failed"),
  });

  const restoreVersionMutation = useMutation({
    mutationFn: (payload: { templateId: number; versionId: number }) =>
      apiFetchJson(`/document-templates/${payload.templateId}/versions/${payload.versionId}/restore`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-template-versions", activeTemplate?.id] });
      toast({ title: "Restored as draft" });
    },
    onError: (err) => toastError(toast, err, "Restore failed"),
  });

  const archiveVersionMutation = useMutation({
    mutationFn: (payload: { templateId: number; versionId: number }) =>
      apiFetchJson(`/document-templates/${payload.templateId}/versions/${payload.versionId}/archive`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["document-template-versions", activeTemplate?.id] });
      toast({ title: "Version archived" });
    },
    onError: (err) => toastError(toast, err, "Archive failed"),
  });

  async function handleUpload() {
    if (!selectedFile || !templateName) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const { objectPath } = await apiFetchJson<{ objectPath: string }>("/storage/upload", { method: "POST", body: formData });

      await apiFetchJson("/document-templates", {
        method: "POST",
        body: JSON.stringify({
          name: templateName,
          documentType: templateType,
          description: templateDescription || undefined,
          objectPath,
          fileName: selectedFile.name,
        }),
      });

      await qc.invalidateQueries({ queryKey: ["document-templates"] });
      toast({ title: "Template uploaded successfully" });
      setUploadDialogOpen(false);
      setTemplateName("");
      setTemplateType("other");
      setTemplateDescription("");
      setSelectedFile(null);
    } catch (err) {
      toastError(toast, err, "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <div>
          <CardTitle>Document Templates</CardTitle>
          <p className="text-sm text-slate-500 mt-1">
            Upload DOCX template files to generate documents for cases.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setInfoOpen(true)}
            className="gap-1.5"
          >
            <Info className="w-3.5 h-3.5" />
            Template Fields
          </Button>
          <Button
            size="sm"
            className="bg-amber-500 hover:bg-amber-600 gap-1.5"
            onClick={() => setUploadDialogOpen(true)}
            disabled={!canCreate}
          >
            <Upload className="w-3.5 h-3.5" />
            Upload Template
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!canRead ? (
          <div className="text-slate-500 py-8 text-center">You do not have permission to view document templates.</div>
        ) : templatesQuery.isError ? (
          <QueryFallback title="Templates unavailable" error={templatesQuery.error} onRetry={() => templatesQuery.refetch()} isRetrying={templatesQuery.isFetching} />
        ) : isLoading ? (
          <div className="text-slate-500 py-8 text-center">Loading templates...</div>
        ) : templates.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="font-medium text-slate-600 mb-1">No templates yet</p>
            <p className="text-sm max-w-sm mx-auto">
              Upload a DOCX file with template fields (e.g. <code className="bg-slate-100 px-1 rounded text-xs">{"{{purchaser_name}}"}</code>)
              to start generating documents for cases.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {templates.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 p-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
                role="button"
                tabIndex={0}
                onClick={() => { setActiveTemplate(t); setDetailOpen(true); }}
                onKeyDown={(e) => { if (e.key === "Enter") { setActiveTemplate(t); setDetailOpen(true); } }}
              >
                <FileText className="w-5 h-5 text-amber-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-900 truncate">{t.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                      {docTypeLabel(t.document_type)}
                    </span>
                  <span className="text-xs text-slate-400 truncate" title={t.file_name}>{t.file_name}</span>
                    {t.description && (
                      <span className="text-xs text-slate-500 truncate">{t.description}</span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-slate-400">
                  {new Date(t.created_at).toLocaleDateString("en-MY")}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-slate-400 hover:text-red-600"
                  onClick={(e) => { e.stopPropagation(); if (!confirm("Delete this template?")) return; deleteMutation.mutate(t.id); }}
                  disabled={!canDelete || deleteMutation.isPending}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Template Details</DialogTitle></DialogHeader>
          {activeTemplate && (
            <Tabs value={detailTab} onValueChange={(v) => setDetailTab(v === "versions" ? "versions" : v === "bindings" ? "bindings" : v === "applicability" ? "applicability" : "details")} className="w-full">
              <TabsList className="mb-3">
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="versions">Versions</TabsTrigger>
                <TabsTrigger value="bindings">Bindings</TabsTrigger>
                <TabsTrigger value="applicability">Applicability</TabsTrigger>
              </TabsList>

              <TabsContent value="details">
                <div className="space-y-3">
                  <div>
                    <div className="text-xs text-slate-500">Name</div>
                    <div className="text-sm font-medium text-slate-900">{activeTemplate.name}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-slate-500">Type</div>
                      <div className="text-sm text-slate-900">
                        {(() => {
                          const dt = activeTemplate.document_type;
                          return Object.prototype.hasOwnProperty.call(DOCUMENT_TYPE_LABELS, dt)
                            ? DOCUMENT_TYPE_LABELS[dt as keyof typeof DOCUMENT_TYPE_LABELS]
                            : dt;
                        })()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Uploaded</div>
                      <div className="text-sm text-slate-900">{new Date(activeTemplate.created_at).toLocaleString("en-MY")}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Active</Label>
                      <Select value={String(editIsActive)} onValueChange={(v) => setEditIsActive(v === "true")}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Active</SelectItem>
                          <SelectItem value="false">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Group</Label>
                      <Select value={editGroup} onValueChange={setEditGroup}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
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
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
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
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
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
                      <Input
                        inputMode="numeric"
                        value={String(editSortOrder)}
                        onChange={(e) => setEditSortOrder(Number(e.target.value || "0"))}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>New DOCX (optional)</Label>
                    <div
                      className="border-2 border-dashed border-slate-200 rounded-lg p-4 text-center cursor-pointer hover:border-amber-300 transition-colors"
                      onClick={() => versionUploadRef.current?.click()}
                    >
                      {versionFile ? (
                        <div className="text-sm text-slate-700 font-medium">{versionFile.name}</div>
                      ) : (
                        <div className="text-sm text-slate-500">Click to select a DOCX file for a new draft</div>
                      )}
                    </div>
                    <input
                      type="file"
                      ref={versionUploadRef}
                      className="hidden"
                      accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={(e) => setVersionFile(e.target.files?.[0] ?? null)}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">File</div>
                    <div className="text-sm text-slate-700 break-words">{activeTemplate.file_name}</div>
                  </div>
                  {activeTemplate.description ? (
                    <div>
                      <div className="text-xs text-slate-500">Description</div>
                      <div className="text-sm text-slate-700 whitespace-pre-wrap">{activeTemplate.description}</div>
                    </div>
                  ) : null}
                  <div className="pt-2 flex gap-2 justify-end flex-wrap">
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (!canUpdate) return;
                        createVersionMutation.mutate({
                          templateId: activeTemplate.id,
                          file: versionFile,
                          patch: {
                            isActive: editIsActive,
                            appliesToPurchaseMode: editPurchaseMode,
                            appliesToTitleType: editTitleType,
                            appliesToCaseType: editCaseType ? editCaseType : null,
                            documentGroup: editGroup,
                            sortOrder: editSortOrder,
                          },
                        });
                      }}
                      disabled={!canUpdate || createVersionMutation.isPending}
                    >
                      {createVersionMutation.isPending ? "Saving..." : "Save Draft"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (!canUpdate) return;
                        updateMutation.mutate({
                          id: activeTemplate.id,
                          patch: {
                            isActive: editIsActive,
                            appliesToPurchaseMode: editPurchaseMode,
                            appliesToTitleType: editTitleType,
                            appliesToCaseType: editCaseType ? editCaseType : null,
                            documentGroup: editGroup,
                            sortOrder: editSortOrder,
                          },
                        });
                      }}
                      disabled={!canUpdate || updateMutation.isPending}
                    >
                      Apply Now
                    </Button>
                    <Button
                      variant="outline"
                      disabled={isDownloading}
                      onClick={async () => {
                        setIsDownloading(true);
                        try {
                          const blob = await apiFetchBlob(`/document-templates/${activeTemplate.id}/download`);
                          downloadBlob(blob, activeTemplate.file_name || "download");
                        } catch (e) {
                          toastError(toast, e, "Download failed");
                        } finally {
                          setIsDownloading(false);
                        }
                      }}
                      className="gap-1.5"
                    >
                      <Download className="w-4 h-4" /> {isDownloading ? "Downloading..." : "Download"}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        if (!confirm("Delete this template?")) return;
                        deleteMutation.mutate(activeTemplate.id);
                        setDetailOpen(false);
                      }}
                      className="gap-1.5"
                      disabled={!canDelete || deleteMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4" /> Delete
                    </Button>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="versions">
                {versionsQuery.isError ? (
                  <QueryFallback title="Versions unavailable" error={versionsQuery.error} onRetry={() => versionsQuery.refetch()} isRetrying={versionsQuery.isFetching} />
                ) : versionsQuery.isLoading ? (
                  <div className="text-slate-500 py-4">Loading versions...</div>
                ) : versions.length === 0 ? (
                  <div className="text-slate-500 py-6 text-center">No versions yet.</div>
                ) : (
                  <div className="space-y-3">
                    <div className="text-sm text-slate-700">
                      Current: <span className="font-medium">v{versions[0]?.version_no}</span>
                      {versions.find((v) => v.status === "published") ? (
                        <span className="ml-2 text-slate-500">Last published: v{versions.find((v) => v.status === "published")!.version_no}</span>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      {versions.map((v) => {
                        const keys = (v.variables_snapshot && typeof v.variables_snapshot === "object" && v.variables_snapshot !== null && "keys" in (v.variables_snapshot as any))
                          ? ((v.variables_snapshot as any).keys as unknown[])
                          : [];
                        const keysCount = Array.isArray(keys) ? keys.length : 0;
                        return (
                          <div key={v.id} className="rounded-lg border border-slate-200 bg-white p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium text-slate-900 truncate">v{v.version_no} <span className="text-xs text-slate-500">({v.status})</span></div>
                                <div className="mt-1 text-xs text-slate-500 break-words">{v.filename}</div>
                                <div className="mt-1 text-xs text-slate-400">
                                  Created {new Date(v.created_at).toLocaleString("en-MY")}{v.created_by_name ? ` by ${v.created_by_name}` : ""}
                                  {v.published_at ? ` • Published ${new Date(v.published_at).toLocaleString("en-MY")}${v.published_by_name ? ` by ${v.published_by_name}` : ""}` : ""}
                                  {v.archived_at ? ` • Archived ${new Date(v.archived_at).toLocaleString("en-MY")}${v.archived_by_name ? ` by ${v.archived_by_name}` : ""}` : ""}
                                </div>
                                {keysCount > 0 ? (
                                  <div className="mt-1 text-xs text-slate-600">Variables detected: {keysCount}</div>
                                ) : null}
                              </div>
                              <div className="shrink-0 flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => restoreVersionMutation.mutate({ templateId: activeTemplate.id, versionId: v.id })}
                                  disabled={!canUpdate || restoreVersionMutation.isPending}
                                >
                                  Restore
                                </Button>
                                {v.status === "draft" ? (
                                  <Button
                                    size="sm"
                                    onClick={() => publishVersionMutation.mutate({ templateId: activeTemplate.id, versionId: v.id })}
                                    disabled={!canUpdate || publishVersionMutation.isPending}
                                    className="bg-amber-500 hover:bg-amber-600"
                                  >
                                    Publish
                                  </Button>
                                ) : null}
                                {v.status !== "archived" ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => archiveVersionMutation.mutate({ templateId: activeTemplate.id, versionId: v.id })}
                                    disabled={!canUpdate || archiveVersionMutation.isPending}
                                  >
                                    Archive
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="bindings">
                {bindingsQuery.isError ? (
                  <QueryFallback title="Bindings unavailable" error={bindingsQuery.error} onRetry={() => bindingsQuery.refetch()} isRetrying={bindingsQuery.isFetching} />
                ) : bindingsQuery.isLoading ? (
                  <div className="text-slate-500 py-4">Loading bindings...</div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="text-sm font-medium text-slate-900">Detected placeholders</div>
                      <div className="mt-1 text-xs text-slate-600">
                        {(bindingsQuery.data?.placeholders ?? []).length === 0
                          ? "No placeholders detected (or file is not DOCX)."
                          : (bindingsQuery.data?.placeholders ?? []).join(", ")}
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
                            <th className="py-2 pr-3">Notes</th>
                            <th className="py-2 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const vars = bindingsQuery.data?.variables?.length ? bindingsQuery.data.variables : [];
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
                                  <td className="py-2 pr-3 min-w-[160px]">
                                    <div className="font-medium text-slate-900 break-words">{key}</div>
                                    <div className="text-xs text-slate-500 break-words">{def?.label ?? ""}</div>
                                  </td>
                                  <td className="py-2 pr-3 min-w-[160px]">
                                    <Select
                                      value={mode}
                                      onValueChange={(v) => {
                                        const nextMode = (v as DocumentTemplateBinding["sourceMode"]) || "registry_default";
                                        setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, sourceMode: nextMode } }));
                                      }}
                                      disabled={!canUpdate}
                                    >
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
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
                                        setBindingsDraft((prev) => ({
                                          ...prev,
                                          [key]: mode === "fixed_value" ? { ...b, fixedValue: v } : { ...b, sourcePath: v },
                                        }));
                                      }}
                                      placeholder={mode === "fixed_value" ? "e.g. RM 500,000.00" : "e.g. spa_purchaser1_name"}
                                      disabled={!canUpdate}
                                    />
                                  </td>
                                  <td className="py-2 pr-3 min-w-[140px]">
                                    <Input
                                      value={b.formatterOverride ?? ""}
                                      onChange={(e) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, formatterOverride: e.target.value || null } }))}
                                      placeholder={def?.formatter ?? "e.g. currency"}
                                      disabled={!canUpdate}
                                    />
                                  </td>
                                  <td className="py-2 pr-3">
                                    <Checkbox
                                      checked={b.isRequired}
                                      onCheckedChange={(v) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, isRequired: Boolean(v) } }))}
                                      disabled={!canUpdate}
                                    />
                                  </td>
                                  <td className="py-2 pr-3 min-w-[140px]">
                                    <Input
                                      value={b.fallbackValue ?? ""}
                                      onChange={(e) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, fallbackValue: e.target.value || null } }))}
                                      placeholder="(optional)"
                                      disabled={!canUpdate}
                                    />
                                  </td>
                                  <td className="py-2 pr-3 min-w-[160px]">
                                    <Input
                                      value={b.notes ?? ""}
                                      onChange={(e) => setBindingsDraft((prev) => ({ ...prev, [key]: { ...b, notes: e.target.value || null } }))}
                                      placeholder="(optional)"
                                      disabled={!canUpdate}
                                    />
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
                                      disabled={!canUpdate}
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

                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (!activeTemplate) return;
                          const bindings = Object.values(bindingsDraft).map((b) => ({
                            ...b,
                            sourcePath: b.sourceMode === "fixed_value" ? null : (b.sourcePath ? b.sourcePath : null),
                            fixedValue: b.sourceMode === "fixed_value" ? (b.fixedValue ?? "") : null,
                          }));
                          saveBindingsMutation.mutate({ templateId: activeTemplate.id, bindings });
                        }}
                        disabled={!canUpdate || saveBindingsMutation.isPending}
                      >
                        {saveBindingsMutation.isPending ? "Saving..." : "Save Bindings"}
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="applicability">
                {applicabilityQuery.isError ? (
                  <QueryFallback title="Applicability unavailable" error={applicabilityQuery.error} onRetry={() => applicabilityQuery.refetch()} isRetrying={applicabilityQuery.isFetching} />
                ) : applicabilityQuery.isLoading ? (
                  <div className="text-slate-500 py-4">Loading applicability...</div>
                ) : !appDraft ? (
                  <div className="text-slate-500 py-4">No data.</div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Active</Label>
                        <Select value={String(appDraft.isActive)} onValueChange={(v) => setAppDraft({ ...appDraft, isActive: v === "true" })} disabled={!canUpdate}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">Active</SelectItem>
                            <SelectItem value="false">Inactive</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Template capable</Label>
                        <Select value={String(appDraft.isTemplateCapable)} onValueChange={(v) => setAppDraft({ ...appDraft, isTemplateCapable: v === "true" })} disabled={!canUpdate}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">Yes</SelectItem>
                            <SelectItem value="false">No</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Purchase mode</Label>
                        <Select value={appDraft.purchaseMode ?? "both"} onValueChange={(v) => setAppDraft({ ...appDraft, purchaseMode: v })} disabled={!canUpdate}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="both">Both</SelectItem>
                            <SelectItem value="cash">Cash</SelectItem>
                            <SelectItem value="loan">Loan</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Title type</Label>
                        <Select value={appDraft.titleType ?? "any"} onValueChange={(v) => setAppDraft({ ...appDraft, titleType: v })} disabled={!canUpdate}>
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
                        <Label>Case type</Label>
                        <Input value={appDraft.caseType ?? ""} onChange={(e) => setAppDraft({ ...appDraft, caseType: e.target.value || null })} placeholder="(optional)" disabled={!canUpdate} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Project type</Label>
                        <Input value={appDraft.projectType ?? ""} onChange={(e) => setAppDraft({ ...appDraft, projectType: e.target.value || null })} placeholder="(optional)" disabled={!canUpdate} />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Development condition</Label>
                        <Input value={appDraft.developmentCondition ?? ""} onChange={(e) => setAppDraft({ ...appDraft, developmentCondition: e.target.value || null })} placeholder="(optional)" disabled={!canUpdate} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Unit category</Label>
                        <Input value={appDraft.unitCategory ?? ""} onChange={(e) => setAppDraft({ ...appDraft, unitCategory: e.target.value || null })} placeholder="(optional)" disabled={!canUpdate} />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label>Title sub type</Label>
                      <Input value={appDraft.titleSubType ?? ""} onChange={(e) => setAppDraft({ ...appDraft, titleSubType: e.target.value || null })} placeholder="(optional)" disabled={!canUpdate} />
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (!activeTemplate) return;
                          saveApplicabilityMutation.mutate({
                            templateId: activeTemplate.id,
                            patch: {
                              isActive: appDraft.isActive,
                              purchaseMode: appDraft.purchaseMode,
                              titleType: appDraft.titleType,
                              caseType: appDraft.caseType,
                              projectType: appDraft.projectType,
                              developmentCondition: appDraft.developmentCondition,
                              unitCategory: appDraft.unitCategory,
                              titleSubType: appDraft.titleSubType,
                              isTemplateCapable: appDraft.isTemplateCapable,
                            },
                          });
                        }}
                        disabled={!canUpdate || saveApplicabilityMutation.isPending}
                      >
                        {saveApplicabilityMutation.isPending ? "Saving..." : "Save Applicability"}
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Document Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Template Name</Label>
              <Input
                placeholder="e.g. Standard SPA Template"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Document Type</Label>
              <Select value={templateType} onValueChange={setTemplateType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DOCUMENT_TYPE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Description <span className="text-slate-400 text-xs">(optional)</span></Label>
              <Textarea
                placeholder="Brief description of this template..."
                value={templateDescription}
                onChange={(e) => setTemplateDescription(e.target.value)}
                className="resize-none text-sm"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>DOCX File</Label>
              <div
                className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-amber-300 transition-colors"
                onClick={() => uploadRef.current?.click()}
              >
                {selectedFile ? (
                  <div className="text-sm text-slate-700 font-medium">{selectedFile.name}</div>
                ) : (
                  <div>
                    <p className="text-sm text-slate-500 mb-1">Click to select a DOCX file</p>
                    <p className="text-xs text-slate-400">Use {"{{"} field_name {"}}"}  syntax for template fields</p>
                  </div>
                )}
              </div>
              <input
                type="file"
                ref={uploadRef}
                className="hidden"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>Cancel</Button>
              <Button
                className="bg-amber-500 hover:bg-amber-600"
                onClick={handleUpload}
                disabled={!selectedFile || !templateName || isUploading || !canCreate}
              >
                {isUploading ? "Uploading..." : "Upload Template"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Template Fields Info Dialog */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Available Template Fields</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-slate-600 mb-4">
              Use these field names in double curly braces in your DOCX file. When a document is generated,
              they will be replaced with the actual case data.
            </p>
            {variablesQuery.isError ? (
              <QueryFallback title="Variables unavailable" error={variablesQuery.error} onRetry={() => variablesQuery.refetch()} isRetrying={variablesQuery.isFetching} />
            ) : variablesQuery.isLoading ? (
              <div className="text-sm text-slate-500">Loading variables…</div>
            ) : (
              <div className="space-y-1">
                {(variablesQuery.data ?? []).map((v) => (
                  <div key={v.key} className="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
                    <code className="text-xs bg-amber-50 text-amber-800 px-2 py-1 rounded font-mono flex-shrink-0 mt-0.5">
                      {`{{${v.key}}}`}
                    </code>
                    <div className="min-w-0">
                      <div className="text-sm text-slate-700">{v.label}</div>
                      <div className="text-xs text-slate-500 break-words">
                        {v.category}
                        {v.sourcePath ? ` · ${v.sourcePath}` : ""}
                        {v.formatter ? ` · fmt=${v.formatter}` : ""}
                        {v.exampleValue ? ` · e.g. ${v.exampleValue}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
                {(variablesQuery.data ?? []).length === 0 ? (
                  <div className="text-sm text-slate-500">No variables found.</div>
                ) : null}
              </div>
            )}
            <p className="text-sm text-slate-500 mt-4">
              For multiple purchasers, use a loop tag:
            </p>
            <pre className="text-xs bg-slate-50 p-3 rounded mt-2 text-slate-700 overflow-x-auto">
{`{#purchasers}
  {index}. {name} ({ic})
{/purchasers}`}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
