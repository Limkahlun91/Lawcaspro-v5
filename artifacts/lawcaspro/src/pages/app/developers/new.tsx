import { useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListDevelopersQueryKey } from "@workspace/api-client-react";
import { toastError } from "@/lib/toast-error";
import { apiRequest } from "@/lib/api-client";

interface Contact {
  name: string;
  department: string;
  phone: string;
  phoneExt: string;
  email: string;
}

const emptyContact = (): Contact => ({ name: "", department: "", phone: "", phoneExt: "", email: "" });

export default function NewDeveloper() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    name: "",
    companyRegNo: "",
    address: "",
    businessAddress: "",
    email: "",
  });
  const [contacts, setContacts] = useState<Contact[]>([emptyContact()]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: "Company name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const primaryContact = contacts[0];
      await apiRequest("/developers", {
        method: "POST",
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
      queryClient.invalidateQueries({ queryKey: getListDevelopersQueryKey() });
      toast({ title: "Developer created successfully" });
      setLocation("/app/developers");
    } catch (e) {
      toastError(toast, e, "Create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl pb-12">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/developers")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Add Developer</h1>
          <p className="text-slate-500 mt-1">Register a new property developer</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>Company Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Company Name <span className="text-red-500">*</span></Label>
              <Input
                placeholder="e.g. MESTIKA BISTARI SDN BHD"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>Registration No.</Label>
              <Input
                placeholder="e.g. 199401005217 (290896-D)"
                value={form.companyRegNo}
                onChange={(e) => setForm((f) => ({ ...f, companyRegNo: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>Registered Address</Label>
              <Textarea
                placeholder="Registered office address as per SSM..."
                rows={2}
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>Business Address</Label>
              <Textarea
                placeholder="Principal place of business (if different from registered address)..."
                rows={2}
                value={form.businessAddress}
                onChange={(e) => setForm((f) => ({ ...f, businessAddress: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label>Company Email</Label>
              <Input
                type="email"
                placeholder="info@developer.com.my"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Contact Persons</CardTitle>
            {contacts.length < 5 && (
              <Button type="button" variant="outline" size="sm" onClick={addContact} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" />
                Add Contact
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {contacts.map((contact, index) => (
              <div key={index} className="p-4 border border-slate-200 rounded-lg bg-slate-50 space-y-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-slate-600">
                    Contact Person {index + 1} {index === 0 ? "(Primary)" : ""}
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
                    <Input
                      placeholder="e.g. MS. VIVIEN CHOR"
                      value={contact.name}
                      onChange={(e) => updateContact(index, "name", e.target.value)}
                      className="bg-white"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Department</Label>
                    <Input
                      placeholder="e.g. Sales & Marketing"
                      value={contact.department}
                      onChange={(e) => updateContact(index, "department", e.target.value)}
                      className="bg-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Phone</Label>
                    <Input
                      placeholder="+603-92216888"
                      value={contact.phone}
                      onChange={(e) => updateContact(index, "phone", e.target.value)}
                      className="bg-white"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Ext No.</Label>
                    <Input
                      placeholder="e.g. 201"
                      value={contact.phoneExt}
                      onChange={(e) => updateContact(index, "phoneExt", e.target.value)}
                      className="bg-white"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Email</Label>
                  <Input
                    type="email"
                    placeholder="contact@developer.com.my"
                    value={contact.email}
                    onChange={(e) => updateContact(index, "email", e.target.value)}
                    className="bg-white"
                  />
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

        <div className="flex justify-end gap-4">
          <Button type="button" variant="outline" onClick={() => setLocation("/app/developers")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} className="bg-amber-500 hover:bg-amber-600">
            {saving ? "Saving..." : "Save Developer"}
          </Button>
        </div>
      </form>
    </div>
  );
}
