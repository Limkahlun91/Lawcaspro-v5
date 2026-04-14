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

const TEMPLATE_FIELDS = [
  { key: "reference_no", label: "Case Reference No." },
  { key: "date", label: "Document Date (formatted)" },
  { key: "spa_price", label: "SPA Price (formatted, e.g. RM 500,000.00)" },
  { key: "spa_price_raw", label: "SPA Price (raw number)" },
  { key: "purchase_mode", label: "Purchase Mode (cash/loan)" },
  { key: "title_type", label: "Title Type (master/individual/strata)" },
  { key: "project_name", label: "Project Name" },
  { key: "project_type", label: "Project Type" },
  { key: "developer_name", label: "Developer Name" },
  { key: "developer_reg_no", label: "Developer Company Reg No." },
  { key: "developer_address", label: "Developer Address" },
  { key: "purchaser_name", label: "Main Purchaser Name" },
  { key: "purchaser_ic", label: "Main Purchaser IC No." },
  { key: "purchaser_nationality", label: "Main Purchaser Nationality" },
  { key: "purchaser_address", label: "Main Purchaser Address" },
  { key: "purchaser_phone", label: "Main Purchaser Phone" },
  { key: "purchaser_email", label: "Main Purchaser Email" },
  { key: "lawyer_name", label: "Assigned Lawyer Name" },
  { key: "lawyer_email", label: "Assigned Lawyer Email" },
  { key: "clerk_name", label: "Assigned Clerk Name" },
];

export default function DocumentTemplates() {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
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

  const [editIsActive, setEditIsActive] = useState(true);
  const [editPurchaseMode, setEditPurchaseMode] = useState<string>("both");
  const [editTitleType, setEditTitleType] = useState<string>("any");
  const [editCaseType, setEditCaseType] = useState<string>("");
  const [editGroup, setEditGroup] = useState<string>("Others");
  const [editSortOrder, setEditSortOrder] = useState<number>(0);

  useEffect(() => {
    if (!activeTemplate) return;
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
              <div className="pt-2 flex gap-2 justify-end">
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
                  Save
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
            <div className="space-y-1">
              {TEMPLATE_FIELDS.map((f) => (
                <div key={f.key} className="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
                  <code className="text-xs bg-amber-50 text-amber-800 px-2 py-1 rounded font-mono flex-shrink-0 mt-0.5">
                    {`{{${f.key}}}`}
                  </code>
                  <span className="text-sm text-slate-600">{f.label}</span>
                </div>
              ))}
            </div>
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
