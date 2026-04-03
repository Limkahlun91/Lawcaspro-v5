import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { getApiBaseUrl } from "@/lib/api";

const API_BASE = getApiBaseUrl();

interface BeneficialOwnerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (bo: any) => void;
  partyId: number;
  partyName: string;
}

export default function BeneficialOwnerForm({ open, onOpenChange, onCreated, partyId, partyName }: BeneficialOwnerFormProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    ownerName: "",
    ownerType: "natural_person",
    ownershipPercentage: "",
    nric: "",
    passportNo: "",
    nationality: "",
    address: "",
    isPep: false,
    isUltimateBeneficialOwner: false,
    throughEntityName: "",
  });

  function setField(key: string, value: unknown) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    if (!form.ownerName.trim()) {
      toast({ title: "Owner name is required", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/parties/${partyId}/beneficial-owners`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to add beneficial owner");
      const bo = await res.json();
      toast({ title: "Beneficial owner added" });
      onCreated(bo);
      onOpenChange(false);
      setForm({ ownerName: "", ownerType: "natural_person", ownershipPercentage: "", nric: "", passportNo: "", nationality: "", address: "", isPep: false, isUltimateBeneficialOwner: false, throughEntityName: "" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Beneficial Owner</DialogTitle>
          <p className="text-sm text-slate-500">For: {partyName}</p>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Full Name <span className="text-red-500">*</span></Label>
            <Input value={form.ownerName} onChange={e => setField("ownerName", e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Owner Type</Label>
              <Select value={form.ownerType} onValueChange={v => setField("ownerType", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="natural_person">Natural Person</SelectItem>
                  <SelectItem value="company">Company</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Ownership %</Label>
              <Input value={form.ownershipPercentage} onChange={e => setField("ownershipPercentage", e.target.value)} placeholder="e.g. 25" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>NRIC</Label>
              <Input value={form.nric} onChange={e => setField("nric", e.target.value)} />
            </div>
            <div>
              <Label>Passport No.</Label>
              <Input value={form.passportNo} onChange={e => setField("passportNo", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Nationality</Label>
              <Input value={form.nationality} onChange={e => setField("nationality", e.target.value)} />
            </div>
            <div>
              <Label>Through Entity (if indirect)</Label>
              <Input value={form.throughEntityName} onChange={e => setField("throughEntityName", e.target.value)} />
            </div>
          </div>

          <div>
            <Label>Address</Label>
            <Input value={form.address} onChange={e => setField("address", e.target.value)} />
          </div>

          <div className="flex gap-6 pt-1">
            <div className="flex items-center gap-2">
              <Checkbox id="ubo_pep" checked={form.isPep} onCheckedChange={v => setField("isPep", !!v)} />
              <Label htmlFor="ubo_pep" className="cursor-pointer">PEP</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="is_ubo" checked={form.isUltimateBeneficialOwner} onCheckedChange={v => setField("isUltimateBeneficialOwner", !!v)} />
              <Label htmlFor="is_ubo" className="cursor-pointer">Ultimate Beneficial Owner (UBO)</Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading} className="bg-[#0f1729] hover:bg-[#1a2540]">
            {loading ? "Adding..." : "Add UBO"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
