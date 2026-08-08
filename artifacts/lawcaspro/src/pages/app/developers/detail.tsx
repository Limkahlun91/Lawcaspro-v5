import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DateOnlyInput, normalizeDateOnlyFromApi } from "@/components/date-only-input";
import {
  ArrowLeft, Building2, Phone, Mail, User, MapPin, Pencil, X, Save, Plus, Trash2, Briefcase, Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getListDevelopersQueryKey } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchJson, apiRequest } from "@/lib/api-client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Salutation = "__none__" | "MR." | "MS." | "MRS." | "MDM." | "DR." | "DATUK";

interface Contact {
  salutation?: Salutation;
  name: string;
  department: string;
  phone: string;
  phoneExt: string;
  email: string;
}

interface Developer {
  id: number;
  name: string;
  companyRegNo: string | null;
  address: string | null;
  businessAddress: string | null;
  contacts?: Contact[];
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  projectCount: number;
  createdAt: string;
}

type DeveloperDocument = {
  id: number;
  developerId: number;
  documentName: string;
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

const SALUTATIONS = new Set<Salutation>(["__none__", "MR.", "MS.", "MRS.", "MDM.", "DR.", "DATUK"]);

const normalizeContact = (value: unknown): Contact => {
  const rec = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const rawSal = typeof rec.salutation === "string" ? rec.salutation.trim().toUpperCase() : "";
  const salutation = (SALUTATIONS.has((rawSal || "__none__") as Salutation) ? ((rawSal || "__none__") as Salutation) : "__none__") as Salutation;
  return {
    salutation,
    name: typeof rec.name === "string" ? rec.name : "",
    department: typeof rec.department === "string" ? rec.department : "",
    phone: typeof rec.phone === "string" ? rec.phone : "",
    phoneExt: typeof rec.phoneExt === "string" ? rec.phoneExt : "",
    email: typeof rec.email === "string" ? rec.email : "",
  };
};

const normalizeContacts = (value: unknown): Contact[] => {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeContact);
};

const emptyContact = (): Contact => ({ salutation: "__none__", name: "", department: "", phone: "", phoneExt: "", email: "" });

function formatValidity(doc: { hasExpiry: boolean; validFrom: string | null; validTo: string | null }): string {
  if (!doc.hasExpiry) return "No Expiry / N.A.";
  const from = doc.validFrom ? normalizeDateOnlyFromApi(doc.validFrom) : "";
  const to = doc.validTo ? normalizeDateOnlyFromApi(doc.validTo) : "";
  const left = from || "N.A.";
  const right = to || "N.A.";
  return `${left} → ${right}`;
}

function formatBytes(n: number | null): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DeveloperDetail() {
  const { id } = useParams<{ id: string }>();
  const developerId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [developer, setDeveloper] = useState<Developer | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [form, setForm] = useState({
    name: "",
    companyRegNo: "",
    address: "",
    businessAddress: "",
    email: "",
  });
  const [contacts, setContacts] = useState<Contact[]>([emptyContact()]);

  const [documents, setDocuments] = useState<DeveloperDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<unknown | null>(null);
  const [docName, setDocName] = useState("");
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docHasExpiry, setDocHasExpiry] = useState(false);
  const [docValidFrom, setDocValidFrom] = useState("");
  const [docValidTo, setDocValidTo] = useState("");
  const [docUploading, setDocUploading] = useState(false);
  const [docDeletingId, setDocDeletingId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const canUploadDoc = useMemo(() => Boolean(docName.trim()) && Boolean(docFile) && !docUploading, [docFile, docName, docUploading]);

  const fetchDeveloper = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiFetchJson<Developer>(`/developers/${developerId}`);
      const normalized = normalizeContacts((data as any).contacts);
      setDeveloper({ ...(data as any), contacts: normalized });
      setForm({
        name: typeof (data as any).name === "string" ? (data as any).name : "",
        companyRegNo: data.companyRegNo ?? "",
        address: data.address ?? "",
        businessAddress: data.businessAddress ?? "",
        email: data.email ?? "",
      });
      setContacts(
        normalized.length > 0
          ? normalized
          : [normalizeContact({ salutation: "__none__", name: data.contactPerson ?? "", department: "", phone: data.phone ?? "", phoneExt: "", email: data.email ?? "" })]
      );
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (developerId) fetchDeveloper();
  }, [developerId]);

  const fetchDocuments = async () => {
    setDocsLoading(true);
    setDocsError(null);
    try {
      const rows = await apiFetchJson<DeveloperDocument[]>(`/developers/${developerId}/documents`);
      setDocuments(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setDocsError(e);
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => {
    if (!developerId) return;
    fetchDocuments();
  }, [developerId]);

  const updateContact = (index: number, field: keyof Contact, value: string) => {
    setContacts((prev) => {
      const updated = [...prev];
      const base = updated[index] ?? emptyContact();
      updated[index] = { ...base, [field]: value };
      return updated;
    });
  };

  const addContact = () => {
    if (contacts.length < 5) setContacts((prev) => [...prev, emptyContact()]);
  };

  const removeContact = (index: number) => {
    if (contacts.length > 1) setContacts((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast({ title: "Company name is required", variant: "destructive" });
      return;
    }
    const safeContacts = (contacts ?? []).map(normalizeContact).map((c) => ({ ...c, salutation: c.salutation === "__none__" ? "" : c.salutation }));
    const primaryContact = safeContacts.find((c) => c.name.trim()) ?? emptyContact();
    setSaving(true);
    try {
      const updated = await apiFetchJson<Developer>(`/developers/${developerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          companyRegNo: form.companyRegNo || null,
          address: form.address || null,
          businessAddress: form.businessAddress || null,
          contacts: safeContacts.filter((c) => c.name.trim()),
          contactPerson: primaryContact.name || null,
          phone: primaryContact.phone || null,
          email: form.email || primaryContact.email || null,
        }),
      });
      const normalized = normalizeContacts((updated as any).contacts);
      setDeveloper({ ...(updated as any), contacts: normalized });
      setContacts(normalized.length > 0 ? normalized : [emptyContact()]);
      queryClient.invalidateQueries({ queryKey: getListDevelopersQueryKey() });
      toast({ title: "Developer updated" });
    } catch (e) {
      toastError(toast, e, "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!developerId || deleting) return;
    setDeleting(true);
    try {
      await apiRequest(`/developers/${developerId}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: getListDevelopersQueryKey() });
      toast({ title: "Developer deleted" });
      setLocation("/app/developers");
    } catch (e) {
      toastError(toast, e, "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const handleCancelEdit = () => {
    if (!developer) return;
    const normalized = normalizeContacts((developer as any).contacts);
    setForm({
      name: developer.name,
      companyRegNo: developer.companyRegNo ?? "",
      address: developer.address ?? "",
      businessAddress: developer.businessAddress ?? "",
      email: developer.email ?? "",
    });
    setContacts(
      normalized.length > 0
        ? normalized
        : [normalizeContact({ salutation: "", name: developer.contactPerson ?? "", department: "", phone: developer.phone ?? "", phoneExt: "", email: developer.email ?? "" })]
    );
    setEditing(false);
  };

  if (loading) return <div className="p-8 text-slate-500">Loading developer details...</div>;
  if (loadError) return <div className="p-6"><QueryFallback title="Developer unavailable" error={loadError} onRetry={fetchDeveloper} isRetrying={loading} /></div>;
  if (!developer) return <div className="p-8 text-slate-500">Developer not found.</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => setLocation("/app/developers")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{developer.name}</h1>
            {developer.companyRegNo && (
              <p className="text-slate-500 mt-1">Reg No: {developer.companyRegNo}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button variant="outline" onClick={handleCancelEdit} className="gap-1.5">
                <X className="w-4 h-4" /> Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving} className="gap-1.5 bg-amber-500 hover:bg-amber-600">
                <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save Changes"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setEditing(true)} className="gap-1.5">
                <Pencil className="w-4 h-4" /> Edit Developer
              </Button>
              <Button variant="destructive" onClick={handleDelete} disabled={deleting} className="gap-1.5">
                <Trash2 className="w-4 h-4" /> {deleting ? "Deleting..." : "Delete"}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Badge variant="outline" className="gap-1.5">
          <Briefcase className="w-3.5 h-3.5" />
          {developer.projectCount} Project{developer.projectCount !== 1 ? "s" : ""}
        </Badge>
        <span className="text-xs text-slate-400">
          Added {new Date(developer.createdAt).toLocaleDateString()}
        </span>
      </div>

      {editing ? (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Company Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Company Name <span className="text-red-500">*</span></Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Company name"
                />
              </div>
              <div className="space-y-2">
                <Label>Registration No.</Label>
                <Input
                  value={form.companyRegNo}
                  onChange={(e) => setForm((f) => ({ ...f, companyRegNo: e.target.value }))}
                  placeholder="e.g. 199401005217 (290896-D)"
                />
              </div>
              <div className="space-y-2">
                <Label>Registered Address</Label>
                <Textarea
                  rows={2}
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  placeholder="Registered office address as per SSM..."
                />
              </div>
              <div className="space-y-2">
                <Label>Business Address</Label>
                <Textarea
                  rows={2}
                  value={form.businessAddress}
                  onChange={(e) => setForm((f) => ({ ...f, businessAddress: e.target.value }))}
                  placeholder="Principal place of business..."
                />
              </div>
              <div className="space-y-2">
                <Label>Company Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="info@developer.com.my"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Contact Persons</CardTitle>
              {(contacts ?? []).length < 5 && (
                <Button type="button" variant="outline" size="sm" onClick={addContact} className="gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Add Contact
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {(contacts ?? []).map((contact, index) => (
                <div key={index} className="p-4 border border-slate-200 rounded-lg bg-slate-50 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-600">
                      Contact {index + 1} {index === 0 ? "(Primary)" : ""}
                    </span>
                    {(contacts ?? []).length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeContact(index)}
                        className="text-red-500 hover:text-red-600 hover:bg-red-50 h-7 px-2"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Name</Label>
                      <div className="grid grid-cols-[120px_1fr] gap-2">
                        <Select value={contact.salutation ?? "__none__"} onValueChange={(v) => updateContact(index, "salutation", v as Salutation)}>
                          <SelectTrigger className="bg-white">
                            <SelectValue placeholder="Title" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">—</SelectItem>
                            <SelectItem value="MR.">MR.</SelectItem>
                            <SelectItem value="MS.">MS.</SelectItem>
                            <SelectItem value="MRS.">MRS.</SelectItem>
                            <SelectItem value="MDM.">MDM.</SelectItem>
                            <SelectItem value="DR.">DR.</SelectItem>
                            <SelectItem value="DATUK">DATUK</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input className="bg-white" value={contact.name} onChange={(e) => updateContact(index, "name", e.target.value)} placeholder="Full name" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Department</Label>
                      <Input className="bg-white" value={contact.department} onChange={(e) => updateContact(index, "department", e.target.value)} placeholder="e.g. Sales & Marketing" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Phone</Label>
                      <Input className="bg-white" value={contact.phone} onChange={(e) => updateContact(index, "phone", e.target.value)} placeholder="+603-12345678" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Ext No.</Label>
                      <Input className="bg-white" value={contact.phoneExt} onChange={(e) => updateContact(index, "phoneExt", e.target.value)} placeholder="e.g. 201" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Email</Label>
                    <Input className="bg-white" type="email" value={contact.email} onChange={(e) => updateContact(index, "email", e.target.value)} placeholder="contact@developer.com.my" />
                  </div>
                </div>
              ))}
              {(contacts ?? []).length < 5 && (
                <button
                  type="button"
                  onClick={addContact}
                  className="w-full py-2 border-2 border-dashed border-slate-200 rounded-lg text-sm text-slate-400 hover:border-slate-300 hover:text-slate-500 transition-colors"
                >
                  + Add another contact person ({(contacts ?? []).length}/5)
                </button>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Company Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {developer.address && (
                <div className="flex items-start gap-3">
                  <MapPin className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-0.5">Registered Address</div>
                    <div className="text-sm text-slate-700 whitespace-pre-line">{developer.address}</div>
                  </div>
                </div>
              )}
              {developer.businessAddress && (
                <div className="flex items-start gap-3">
                  <Building2 className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-0.5">Business Address</div>
                    <div className="text-sm text-slate-700 whitespace-pre-line">{developer.businessAddress}</div>
                  </div>
                </div>
              )}
              {!developer.address && !developer.businessAddress && (
                <p className="text-sm text-slate-400 italic">No address recorded</p>
              )}
              {developer.email && (
                <div className="flex items-center gap-3">
                  <Mail className="w-4 h-4 text-slate-400 shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-0.5">Company Email</div>
                    <a href={`mailto:${developer.email}`} className="text-sm text-amber-600 hover:underline">
                      {developer.email}
                    </a>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Contact Persons</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {developer.contacts?.length ? (
                developer.contacts?.map((c, i) => (
                  <div key={i} className={`space-y-2 ${i > 0 ? "pt-4 border-t border-slate-100" : ""}`}>
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-400 shrink-0" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          {`${c?.salutation ? `${c.salutation} ` : ""}${c?.name || ""}`.trim() || "—"}
                        </div>
                        {c?.department && (
                          <div className="text-xs text-slate-500">{c.department}</div>
                        )}
                      </div>
                      {i === 0 && (
                        <Badge variant="outline" className="text-xs ml-auto">Primary</Badge>
                      )}
                    </div>
                    {(c?.phone || c?.phoneExt) && (
                      <div className="flex items-center gap-2 ml-6">
                        <Phone className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-sm text-slate-700">
                          {c?.phone}{c?.phoneExt ? ` Ext: ${c.phoneExt}` : ""}
                        </span>
                      </div>
                    )}
                    {c?.email && (
                      <div className="flex items-center gap-2 ml-6">
                        <Mail className="w-3.5 h-3.5 text-slate-400" />
                        <a href={`mailto:${c.email}`} className="text-sm text-amber-600 hover:underline">{c.email}</a>
                      </div>
                    )}
                  </div>
                ))
              ) : developer.contactPerson ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-slate-400" />
                    <span className="text-sm font-semibold text-slate-900">{developer.contactPerson}</span>
                  </div>
                  {developer.phone && (
                    <div className="flex items-center gap-2 ml-6">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-sm text-slate-700">{developer.phone}</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400 italic">No contact persons recorded</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Developer Documents (基礎文件)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div className="md:col-span-2 space-y-1.5">
              <Label>Document Name</Label>
              <Input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="e.g. SSM, Developer License" />
            </div>
            <div className="md:col-span-1 flex items-center gap-2">
              <Checkbox checked={docHasExpiry} onCheckedChange={(v) => setDocHasExpiry(Boolean(v))} />
              <Label className="text-sm">Has expiry</Label>
            </div>
            <div className="md:col-span-1 space-y-1.5">
              <Label>Valid From</Label>
              <DateOnlyInput valueYmd={docValidFrom} onChangeYmd={setDocValidFrom} disabled={!docHasExpiry} />
            </div>
            <div className="md:col-span-1 space-y-1.5">
              <Label>Valid To</Label>
              <DateOnlyInput valueYmd={docValidTo} onChangeYmd={setDocValidTo} disabled={!docHasExpiry} />
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setDocFile(f);
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
              setDocFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <div className="font-medium text-slate-900">File Upload</div>
            <div className="text-slate-500 mt-1">Drag & drop PDF / image, or click to select.</div>
            <div className="mt-2 text-xs text-slate-600">{docFile ? `Selected: ${docFile.name}` : "No file selected"}</div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={!canUploadDoc}
              onClick={async () => {
                if (!docFile) return;
                setDocUploading(true);
                try {
                  const fd = new FormData();
                  fd.append("documentName", docName.trim());
                  fd.append("hasExpiry", String(docHasExpiry));
                  if (docHasExpiry) {
                    if (docValidFrom) fd.append("validFrom", docValidFrom);
                    if (docValidTo) fd.append("validTo", docValidTo);
                  }
                  fd.append("file", docFile);
                  const created = await apiFetchJson(`/developers/${developerId}/documents`, { method: "POST", body: fd }) as any;
                  setDocName("");
                  setDocFile(null);
                  setDocHasExpiry(false);
                  setDocValidFrom("");
                  setDocValidTo("");
                  await fetchDocuments();
                  queryClient.invalidateQueries({ queryKey: ["developers", developerId, "documents"] });
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
                  setDocUploading(false);
                }
              }}
            >
              {docUploading ? "Uploading..." : "Upload"}
            </Button>
            <Button type="button" variant="outline" onClick={() => fetchDocuments()} disabled={docsLoading}>
              Refresh
            </Button>
          </div>

          {!!docsError && (
            <QueryFallback title="Documents unavailable" error={String(docsError)} onRetry={fetchDocuments} isRetrying={docsLoading} />
          )}

          <div className="border rounded-lg overflow-hidden">
            <div className="grid grid-cols-12 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
              <div className="col-span-4">Document</div>
              <div className="col-span-3">Validity</div>
              <div className="col-span-3">Uploaded</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>
            {docsLoading ? (
              <div className="px-4 py-6 text-sm text-slate-500">Loading documents...</div>
            ) : documents.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-500">No documents uploaded.</div>
            ) : (
              documents.map((d) => (
                <div key={d.id} className="grid grid-cols-12 px-4 py-3 border-t text-sm items-center">
                  {(() => {
                    const isPendingUpload = typeof d.objectPath === "string" && d.objectPath.startsWith("pending_upload");
                    return (
                      <>
                        <div className="col-span-4">
                          <div className="font-medium text-slate-900">{d.documentName}</div>
                          <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
                            <span>{d.fileName}{d.fileSize ? ` • ${formatBytes(d.fileSize)}` : ""}</span>
                            {isPendingUpload && (
                              <Badge className="bg-amber-100 text-amber-900 border border-amber-200">Upload Failed / Pending</Badge>
                            )}
                          </div>
                        </div>
                        <div className="col-span-3 text-slate-700 text-xs">{formatValidity(d)}</div>
                        <div className="col-span-3 text-slate-600 text-xs">{new Date(d.createdAt).toLocaleDateString()}</div>
                        <div className="col-span-2 flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isPendingUpload}
                            onClick={() => window.open(`/api/developers/${developerId}/documents/${d.id}/view`, "_blank")}
                          >
                            <Eye className="h-4 w-4 mr-1" />
                            View
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={docDeletingId === d.id}
                            onClick={async () => {
                              setDocDeletingId(d.id);
                              try {
                                await apiRequest(`/developers/${developerId}/documents/${d.id}`, { method: "DELETE" });
                                await fetchDocuments();
                                toast({ title: "Document deleted" });
                              } catch (e) {
                                toastError(toast, e, "Delete failed");
                              } finally {
                                setDocDeletingId(null);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4 mr-1" />
                            {docDeletingId === d.id ? "Deleting..." : "Delete"}
                          </Button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
