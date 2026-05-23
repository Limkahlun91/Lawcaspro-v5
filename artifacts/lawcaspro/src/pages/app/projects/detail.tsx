import { useParams, useLocation } from "wouter";
import { Link } from "wouter";
import { useGetProject, getGetProjectQueryKey, getListProjectsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Building2, MapPin, Tag, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchJson, apiRequest } from "@/lib/api-client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DateOnlyInput, normalizeDateOnlyFromApi } from "@/components/date-only-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ProjectDocument = {
  id: number;
  projectId: number;
  category: "general" | "advertisement_permit" | "developer_license" | "developer_mlu" | "bank_mlu";
  documentName: string;
  licenseNumber: string | null;
  bankName: string | null;
  documentDate: string | null;
  fileName: string;
  objectPath?: string | null;
  mimeType: string | null;
  fileSize: number | null;
  hasExpiry: boolean;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
};

function formatBytes(n: number | null): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatValidity(doc: { hasExpiry: boolean; validFrom: string | null; validTo: string | null }): string {
  if (!doc.hasExpiry) return "No Expiry / N.A.";
  const from = doc.validFrom ? normalizeDateOnlyFromApi(doc.validFrom) : "";
  const to = doc.validTo ? normalizeDateOnlyFromApi(doc.validTo) : "";
  const left = from || "N.A.";
  const right = to || "N.A.";
  return `${left} → ${right}`;
}

function ProjectDocumentsPanel(props: { projectId: number; category: "general" | "developer_mlu" | "bank_mlu" | "mlu" }) {
  const { projectId } = props;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [docs, setDocs] = useState<ProjectDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [documentName, setDocumentName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [licenseNumber, setLicenseNumber] = useState("");
  const [uploadCategory, setUploadCategory] = useState<"general" | "advertisement_permit" | "developer_license">("general");

  const [hasExpiry, setHasExpiry] = useState(false);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");

  const [mluType, setMluType] = useState<"developer_mlu" | "bank_mlu">("developer_mlu");
  const [bankName, setBankName] = useState("");
  const [documentDate, setDocumentDate] = useState("");

  const effectiveCategory = props.category === "mlu" ? mluType : props.category;
  const effectiveUploadCategory = props.category === "mlu" ? effectiveCategory : uploadCategory;
  const apOrDl = effectiveUploadCategory === "advertisement_permit" || effectiveUploadCategory === "developer_license";

  useEffect(() => {
    if (props.category === "mlu") return;
    if (apOrDl) setHasExpiry(true);
  }, [apOrDl, props.category]);

  const nameSuggestions = useMemo(() => {
    if (props.category !== "general") return [];
    return [
      "Building Plan Approval",
      "Layout Approval",
      "MMKN Approval (KM)",
      "HDA Account opening (Lampiran A2)",
      "Contractor All Risks Policy",
    ];
  }, [props.category]);

  const fetchDocs = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs =
        props.category === "mlu"
          ? `?category=${encodeURIComponent(effectiveCategory)}`
          : "";
      const rows = await apiFetchJson<ProjectDocument[]>(`/projects/${projectId}/documents${qs}`);
      const arr = Array.isArray(rows) ? rows : [];
      const filtered = props.category === "mlu"
        ? arr
        : arr.filter((d) => d.category !== "developer_mlu" && d.category !== "bank_mlu");
      setDocs(filtered);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!projectId) return;
    fetchDocs();
  }, [projectId, effectiveCategory, props.category]);

  const canUpload = (() => {
    if (!documentName.trim() || !file || uploading) return false;
    if (props.category === "mlu") return true;
    if (apOrDl) return Boolean(licenseNumber.trim()) && Boolean(validFrom) && Boolean(validTo);
    if (hasExpiry) return Boolean(validFrom) && Boolean(validTo);
    return true;
  })();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{props.category === "mlu" ? "Master Letter of Undertaking (MLU)" : "Project Documents"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {props.category === "mlu" ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={mluType} onValueChange={(v) => setMluType(v === "bank_mlu" ? "bank_mlu" : "developer_mlu")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="developer_mlu">Developer MLU</SelectItem>
                    <SelectItem value="bank_mlu">Bank MLU</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>{mluType === "developer_mlu" ? "To Bank" : "From Bank"}</Label>
                <Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. Maybank" />
              </div>
              <div className="space-y-1.5">
                <Label>Document Date</Label>
                <DateOnlyInput valueYmd={documentDate} onChangeYmd={setDocumentDate} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-7 gap-3 items-end">
              <div className="md:col-span-2 space-y-1.5">
                <Label>Document Name</Label>
                <Input list="project-doc-suggestions" value={documentName} onChange={(e) => setDocumentName(e.target.value)} />
                {nameSuggestions.length > 0 && (
                  <datalist id="project-doc-suggestions">
                    {nameSuggestions.map((s) => <option key={s} value={s} />)}
                  </datalist>
                )}
              </div>
              <div className="md:col-span-2 space-y-1.5">
                <Label>Category</Label>
                <Select value={uploadCategory} onValueChange={(v) => setUploadCategory(v === "developer_license" ? "developer_license" : v === "advertisement_permit" ? "advertisement_permit" : "general")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">General</SelectItem>
                    <SelectItem value="advertisement_permit">Advertisement Permit (AP)</SelectItem>
                    <SelectItem value="developer_license">Developer License (DL)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {apOrDl && (
                <div className="md:col-span-2 space-y-1.5">
                  <Label>License / Permit Number</Label>
                  <Input value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} placeholder="e.g. AP 1234 / DL 5678" />
                </div>
              )}
              <div className="md:col-span-1 flex items-center gap-2">
                <Checkbox checked={hasExpiry} disabled={apOrDl} onCheckedChange={(v) => setHasExpiry(Boolean(v))} />
                <Label className="text-sm">Has expiry</Label>
              </div>
              <div className="md:col-span-1 space-y-1.5">
                <Label>{apOrDl || hasExpiry ? "Valid From *" : "Valid From"}</Label>
                <DateOnlyInput valueYmd={validFrom} onChangeYmd={setValidFrom} disabled={!(apOrDl || hasExpiry)} />
              </div>
              <div className="md:col-span-1 space-y-1.5">
                <Label>{apOrDl || hasExpiry ? "Valid To *" : "Valid To"}</Label>
                <DateOnlyInput valueYmd={validTo} onChangeYmd={setValidTo} disabled={!(apOrDl || hasExpiry)} />
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              e.currentTarget.value = "";
            }}
          />
          <div
            className={`rounded-lg border border-dashed p-4 text-sm ${dragging ? "border-slate-400 bg-slate-50" : "border-slate-200 bg-white"}`}
            onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragging(false);
              const f = e.dataTransfer.files?.[0] ?? null;
              setFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <div className="font-medium text-slate-900">File Upload</div>
            <div className="text-slate-500 mt-1">Drag & drop PDF / image, or click to select.</div>
            <div className="mt-2 text-xs text-slate-600">{file ? `Selected: ${file.name}` : "No file selected"}</div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={!canUpload}
              onClick={async () => {
                if (!file) return;
                setUploading(true);
                try {
                  const fd = new FormData();
                  fd.append("category", effectiveUploadCategory);
                  fd.append("documentName", documentName.trim());
                  if (props.category === "mlu") {
                    if (bankName.trim()) fd.append("bankName", bankName.trim());
                    if (documentDate) fd.append("documentDate", documentDate);
                  } else {
                    if (apOrDl) {
                      fd.append("licenseNumber", licenseNumber.trim());
                    }
                    fd.append("hasExpiry", String(apOrDl ? true : hasExpiry));
                    if (apOrDl || hasExpiry) {
                      if (validFrom) fd.append("validFrom", validFrom);
                      if (validTo) fd.append("validTo", validTo);
                    }
                  }
                  fd.append("file", file);
                  const created = await apiFetchJson(`/projects/${projectId}/documents`, { method: "POST", body: fd }) as any;
                  setDocumentName("");
                  setFile(null);
                  setLicenseNumber("");
                  setUploadCategory("general");
                  setHasExpiry(false);
                  setValidFrom("");
                  setValidTo("");
                  setBankName("");
                  setDocumentDate("");
                  await fetchDocs();
                  queryClient.invalidateQueries({ queryKey: ["projects", projectId, "documents"] });
                  const warningText =
                    typeof created?.warning === "string"
                      ? created.warning
                      : Array.isArray(created?.warnings) && typeof created.warnings?.[0] === "string"
                        ? created.warnings[0]
                        : null;
                  if (warningText) {
                    toast({ title: "Document uploaded (warning)", description: warningText });
                  } else {
                    toast({ title: "Document uploaded" });
                  }
                } catch (e) {
                  toastError(toast, e, "Upload failed");
                } finally {
                  setUploading(false);
                }
              }}
            >
              {uploading ? "Uploading..." : "Upload"}
            </Button>
            <Button type="button" variant="outline" onClick={() => fetchDocs()} disabled={loading}>
              Refresh
            </Button>
          </div>

          {error && (
            <QueryFallback title="Documents unavailable" error={error} onRetry={fetchDocs} isRetrying={loading} />
          )}

          <div className="border rounded-lg overflow-hidden">
            <div className="grid grid-cols-12 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
              <div className="col-span-4">Document</div>
              <div className="col-span-3">{props.category === "mlu" ? "MLU" : "Validity"}</div>
              <div className="col-span-3">Uploaded</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>
            {loading ? (
              <div className="px-4 py-6 text-sm text-slate-500">Loading documents...</div>
            ) : docs.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-500">No documents uploaded.</div>
            ) : (
              docs.map((d) => (
                <div key={d.id} className="grid grid-cols-12 px-4 py-3 border-t text-sm items-center">
                  <div className="col-span-4">
                    <div className="font-medium text-slate-900 flex flex-wrap items-center gap-2">
                      <span>{d.documentName}</span>
                      {(d.category === "advertisement_permit" || d.category === "developer_license") && (
                        <span className="text-xs font-semibold text-slate-700">
                          [{d.category === "advertisement_permit" ? "AP" : "DL"} No: {d.licenseNumber || "N.A."}]
                        </span>
                      )}
                      {(d.category === "advertisement_permit" || d.category === "developer_license") && (
                        <span className="text-xs text-slate-600">[Validity: {formatValidity(d)}]</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
                      <span>{d.fileName}{d.fileSize ? ` • ${formatBytes(d.fileSize)}` : ""}</span>
                      {typeof d.objectPath === "string" && d.objectPath.startsWith("pending_upload") && (
                        <Badge className="bg-amber-100 text-amber-900 border border-amber-200">Upload Failed / Pending</Badge>
                      )}
                    </div>
                  </div>
                  <div className="col-span-3 text-xs text-slate-700">
                    {props.category === "mlu"
                      ? `${d.category === "developer_mlu" ? "To" : "From"} ${d.bankName || "Bank"}${d.documentDate ? ` • ${normalizeDateOnlyFromApi(d.documentDate)}` : ""}`
                      : formatValidity(d)}
                  </div>
                  <div className="col-span-3 text-slate-600 text-xs">{new Date(d.createdAt).toLocaleDateString()}</div>
                  <div className="col-span-2 flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={typeof d.objectPath === "string" && d.objectPath.startsWith("pending_upload")}
                      onClick={() => window.open(`/api/projects/${projectId}/documents/${d.id}/view`, "_blank")}
                    >
                      View
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={deletingId === d.id}
                      onClick={async () => {
                        setDeletingId(d.id);
                        try {
                          await apiRequest(`/projects/${projectId}/documents/${d.id}`, { method: "DELETE" });
                          await fetchDocs();
                          toast({ title: "Document deleted" });
                        } catch (e) {
                          toastError(toast, e, "Delete failed");
                        } finally {
                          setDeletingId(null);
                        }
                      }}
                    >
                      {deletingId === d.id ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);

  const { data: project, isLoading, isError, error, refetch, isFetching } = useGetProject(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetProjectQueryKey(projectId),
    }
  });

  if (isLoading) return <div>Loading project details...</div>;
  if (isError) return <div className="p-6"><QueryFallback title="Project unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} /></div>;
  if (!project) return <div>Project not found</div>;

  const handleDelete = async () => {
    if (!projectId || deleting) return;
    setDeleting(true);
    try {
      await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      toast({ title: "Project deleted" });
      setLocation("/app/projects");
    } catch (err) {
      toastError(toast, err, "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const renderExtraFields = () => {
    if (!project.extraFields) return null;
    
    return (
      <div className="grid grid-cols-2 gap-y-4 gap-x-8 mt-4 pt-4 border-t border-slate-100">
        {Object.entries(project.extraFields).map(([key, value]) => {
          if (!value) return null;
          // convert camelCase to Title Case
          const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
          return (
            <div key={key}>
              <div className="text-sm font-medium text-slate-500">{label}</div>
              <div className="text-slate-900 mt-0.5">{String(value)}</div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => setLocation("/app/projects")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{project.name}</h1>
            <p className="text-slate-500 mt-1">Developer: {project.developerName}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/app/projects/${projectId}/edit`}>
            <Button variant="outline" className="gap-2">
              <Pencil className="w-4 h-4" />
              Edit Project
            </Button>
          </Link>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting} className="gap-2">
            <Trash2 className="w-4 h-4" />
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="bg-white border border-slate-200">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="documents">Project Documents</TabsTrigger>
          <TabsTrigger value="mlu">MLU</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-1 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Project Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
                  <div className="flex items-start gap-3">
                    <Building2 className="w-5 h-5 text-amber-500 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-slate-500">Project Type</div>
                      <div className="text-slate-900 capitalize font-medium">{project.projectType}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Tag className="w-5 h-5 text-amber-500 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-slate-500">Title Type</div>
                      <div className="text-slate-900 capitalize font-medium">{project.titleType}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <MapPin className="w-5 h-5 text-amber-500 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-slate-500">Land Use</div>
                      <div className="text-slate-900 font-medium">{project.landUse || "-"}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Building2 className="w-5 h-5 text-amber-500 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-slate-500">Condition</div>
                      <div className="text-slate-900 font-medium">{project.developmentCondition || "-"}</div>
                    </div>
                  </div>
                </div>

                {renderExtraFields()}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="documents" className="mt-4">
          <ProjectDocumentsPanel projectId={projectId} category="general" />
        </TabsContent>

        <TabsContent value="mlu" className="mt-4">
          <ProjectDocumentsPanel projectId={projectId} category="mlu" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
