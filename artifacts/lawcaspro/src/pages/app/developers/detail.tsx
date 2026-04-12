import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, Building2, Phone, Mail, User, MapPin, Pencil, X, Save, Plus, Trash2, Briefcase,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getListDevelopersQueryKey } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchJson, apiRequest } from "@/lib/api-client";

interface Contact {
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
  contacts: Contact[];
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  projectCount: number;
  createdAt: string;
}

const emptyContact = (): Contact => ({ name: "", department: "", phone: "", phoneExt: "", email: "" });

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

  const fetchDeveloper = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiFetchJson<Developer>(`/developers/${developerId}`);
      setDeveloper(data);
      setForm({
        name: data.name,
        companyRegNo: data.companyRegNo ?? "",
        address: data.address ?? "",
        businessAddress: data.businessAddress ?? "",
        email: data.email ?? "",
      });
      setContacts(
        data.contacts && data.contacts.length > 0
          ? data.contacts
          : [{ name: data.contactPerson ?? "", department: "", phone: data.phone ?? "", phoneExt: "", email: data.email ?? "" }]
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

  const updateContact = (index: number, field: keyof Contact, value: string) => {
    setContacts((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
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
          contacts: contacts.filter((c) => c.name.trim()),
          contactPerson: primaryContact.name || null,
          phone: primaryContact.phone || null,
          email: form.email || primaryContact.email || null,
        }),
      });
      setDeveloper(updated);
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
    setForm({
      name: developer.name,
      companyRegNo: developer.companyRegNo ?? "",
      address: developer.address ?? "",
      businessAddress: developer.businessAddress ?? "",
      email: developer.email ?? "",
    });
    setContacts(
      developer.contacts && developer.contacts.length > 0
        ? developer.contacts
        : [{ name: developer.contactPerson ?? "", department: "", phone: developer.phone ?? "", phoneExt: "", email: developer.email ?? "" }]
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
              {contacts.length < 5 && (
                <Button type="button" variant="outline" size="sm" onClick={addContact} className="gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Add Contact
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {contacts.map((contact, index) => (
                <div key={index} className="p-4 border border-slate-200 rounded-lg bg-slate-50 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-600">
                      Contact {index + 1} {index === 0 ? "(Primary)" : ""}
                    </span>
                    {contacts.length > 1 && (
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
                      <Input className="bg-white" value={contact.name} onChange={(e) => updateContact(index, "name", e.target.value)} placeholder="Full name" />
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
              {contacts.length < 5 && (
                <button
                  type="button"
                  onClick={addContact}
                  className="w-full py-2 border-2 border-dashed border-slate-200 rounded-lg text-sm text-slate-400 hover:border-slate-300 hover:text-slate-500 transition-colors"
                >
                  + Add another contact person ({contacts.length}/5)
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
              {developer.contacts && developer.contacts.length > 0 ? (
                developer.contacts.map((c, i) => (
                  <div key={i} className={`space-y-2 ${i > 0 ? "pt-4 border-t border-slate-100" : ""}`}>
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-400 shrink-0" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{c.name || "—"}</div>
                        {c.department && (
                          <div className="text-xs text-slate-500">{c.department}</div>
                        )}
                      </div>
                      {i === 0 && (
                        <Badge variant="outline" className="text-xs ml-auto">Primary</Badge>
                      )}
                    </div>
                    {(c.phone || c.phoneExt) && (
                      <div className="flex items-center gap-2 ml-6">
                        <Phone className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-sm text-slate-700">
                          {c.phone}{c.phoneExt ? ` Ext: ${c.phoneExt}` : ""}
                        </span>
                      </div>
                    )}
                    {c.email && (
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
    </div>
  );
}
