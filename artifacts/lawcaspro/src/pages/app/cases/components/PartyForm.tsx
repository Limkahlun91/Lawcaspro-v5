import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { DateOnlyInput } from "@/components/date-only-input";

interface PartyFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (party: any) => void;
  caseId: number;
}

export default function PartyForm({ open, onOpenChange, onCreated, caseId }: PartyFormProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [partyType, setPartyType] = useState("natural_person");
  const [form, setForm] = useState({
    fullName: "",
    nric: "",
    passportNo: "",
    companyRegNo: "",
    dob: "",
    incorporationDate: "",
    nationality: "",
    jurisdiction: "",
    address: "",
    email: "",
    phone: "",
    occupation: "",
    natureOfBusiness: "",
    transactionPurpose: "",
    isPep: false,
    pepDetails: "",
    isHighRiskJurisdiction: false,
    hasNomineeArrangement: false,
    hasLayeredOwnership: false,
  });

  function setField(key: string, value: unknown) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    if (!form.fullName.trim()) {
      toast({ title: "Full name is required", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      // 1. Create party
      const party = await apiFetchJson<any>("/parties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, partyType }),
      });

      // 2. Link to case
      await apiFetchJson(`/cases/${caseId}/parties`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyId: party.id, partyRole: "client" }),
      });

      toast({ title: "Party added successfully" });
      onCreated(party);
      onOpenChange(false);
      setForm({
        fullName: "", nric: "", passportNo: "", companyRegNo: "", dob: "",
        incorporationDate: "", nationality: "", jurisdiction: "", address: "",
        email: "", phone: "", occupation: "", natureOfBusiness: "",
        transactionPurpose: "", isPep: false, pepDetails: "",
        isHighRiskJurisdiction: false, hasNomineeArrangement: false, hasLayeredOwnership: false,
      });
    } catch (err) {
      toastError(toast, err, "Create failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Party</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Party Type</Label>
            <Select value={partyType} onValueChange={setPartyType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="natural_person">Natural Person</SelectItem>
                <SelectItem value="company">Company</SelectItem>
                <SelectItem value="trust">Trust</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Tabs defaultValue="identity" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="contact">Contact</TabsTrigger>
              <TabsTrigger value="risk">Risk Flags</TabsTrigger>
            </TabsList>

            <TabsContent value="identity" className="space-y-3 pt-3">
              <div>
                <Label>Full Name <span className="text-red-500">*</span></Label>
                <Input value={form.fullName} onChange={e => setField("fullName", e.target.value)} placeholder="As per identity document" />
              </div>

              {partyType === "natural_person" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>NRIC No.</Label>
                      <Input value={form.nric} onChange={e => setField("nric", e.target.value)} placeholder="000000-00-0000" />
                    </div>
                    <div>
                      <Label>Passport No.</Label>
                      <Input value={form.passportNo} onChange={e => setField("passportNo", e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Date of Birth</Label>
                      <DateOnlyInput valueYmd={form.dob} onChangeYmd={(v) => setField("dob", v)} />
                    </div>
                    <div>
                      <Label>Nationality</Label>
                      <Input value={form.nationality} onChange={e => setField("nationality", e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <Label>Occupation</Label>
                    <Input value={form.occupation} onChange={e => setField("occupation", e.target.value)} />
                  </div>
                </>
              )}

              {partyType === "company" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Company Reg. No.</Label>
                      <Input value={form.companyRegNo} onChange={e => setField("companyRegNo", e.target.value)} />
                    </div>
                    <div>
                      <Label>Date of Incorporation</Label>
                      <DateOnlyInput valueYmd={form.incorporationDate} onChangeYmd={(v) => setField("incorporationDate", v)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Jurisdiction</Label>
                      <Input value={form.jurisdiction} onChange={e => setField("jurisdiction", e.target.value)} />
                    </div>
                    <div>
                      <Label>Nature of Business</Label>
                      <Input value={form.natureOfBusiness} onChange={e => setField("natureOfBusiness", e.target.value)} />
                    </div>
                  </div>
                </>
              )}

              {partyType === "trust" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Jurisdiction</Label>
                    <Input value={form.jurisdiction} onChange={e => setField("jurisdiction", e.target.value)} />
                  </div>
                  <div>
                    <Label>Nature of Business</Label>
                    <Input value={form.natureOfBusiness} onChange={e => setField("natureOfBusiness", e.target.value)} />
                  </div>
                </div>
              )}

              <div>
                <Label>Transaction Purpose</Label>
                <Textarea value={form.transactionPurpose} onChange={e => setField("transactionPurpose", e.target.value)} placeholder="Why is the client engaging the firm's services?" rows={2} />
              </div>
            </TabsContent>

            <TabsContent value="contact" className="space-y-3 pt-3">
              <div>
                <Label>Address</Label>
                <Textarea value={form.address} onChange={e => setField("address", e.target.value)} rows={2} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Email</Label>
                  <Input type="email" value={form.email} onChange={e => setField("email", e.target.value)} />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input value={form.phone} onChange={e => setField("phone", e.target.value)} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="risk" className="space-y-4 pt-3">
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50">
                  <Checkbox
                    id="isPep"
                    checked={form.isPep}
                    onCheckedChange={v => setField("isPep", !!v)}
                  />
                  <div>
                    <Label htmlFor="isPep" className="font-medium cursor-pointer">Politically Exposed Person (PEP)</Label>
                    <p className="text-xs text-slate-500">Current or former senior public official or closely associated individual</p>
                  </div>
                </div>

                {form.isPep && (
                  <div className="ml-6">
                    <Label>PEP Details / Position</Label>
                    <Input value={form.pepDetails} onChange={e => setField("pepDetails", e.target.value)} placeholder="e.g. Former Minister of Finance, Malaysia" />
                  </div>
                )}

                <div className="flex items-center gap-3 p-3 rounded-lg border border-orange-200 bg-orange-50">
                  <Checkbox
                    id="highRisk"
                    checked={form.isHighRiskJurisdiction}
                    onCheckedChange={v => setField("isHighRiskJurisdiction", !!v)}
                  />
                  <div>
                    <Label htmlFor="highRisk" className="font-medium cursor-pointer">High-Risk Jurisdiction</Label>
                    <p className="text-xs text-slate-500">Party connected to a jurisdiction listed on FATF grey/black list</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <Checkbox
                    id="nominee"
                    checked={form.hasNomineeArrangement}
                    onCheckedChange={v => setField("hasNomineeArrangement", !!v)}
                  />
                  <div>
                    <Label htmlFor="nominee" className="font-medium cursor-pointer">Nominee Arrangement</Label>
                    <p className="text-xs text-slate-500">Party acts as nominee / beneficial owner is different from legal owner</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-slate-50">
                  <Checkbox
                    id="layered"
                    checked={form.hasLayeredOwnership}
                    onCheckedChange={v => setField("hasLayeredOwnership", !!v)}
                  />
                  <div>
                    <Label htmlFor="layered" className="font-medium cursor-pointer">Layered / Complex Ownership Structure</Label>
                    <p className="text-xs text-slate-500">Multiple layers of corporate ownership obscuring beneficial ownership</p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading} className="bg-[#0f1729] hover:bg-[#1a2540]">
            {loading ? "Adding..." : "Add Party"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
