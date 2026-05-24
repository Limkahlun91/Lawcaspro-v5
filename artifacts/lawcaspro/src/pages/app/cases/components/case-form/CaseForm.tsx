import { useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Plus, Trash2 } from "lucide-react";
import { useListDevelopers, useListProjects } from "@workspace/api-client-react";
import { AddressLinesFields } from "./AddressLinesFields";
import { PricingBreakdown } from "./PricingBreakdown";
import { emptyAddressLines, joinAddressLines } from "./address";
import type { BorrowerForm, CaseFormValues, LoanPartyType, PurchaserForm, PurchaseMode, TitleCategory } from "./types";
import { toRinggitMalaysiaWords } from "@/lib/ringgit-words";

function newPurchaser(): PurchaserForm {
  return {
    id: crypto.randomUUID(),
    isCompany: false,
    name: "",
    icOrCompanyNo: "",
    tel: "",
    email: "",
    addressLines: emptyAddressLines(),
    address: "",
  };
}

function newBorrower(): BorrowerForm {
  return {
    id: crypto.randomUUID(),
    name: "",
    ic: "",
    hp: "",
    email: "",
    addressLines: emptyAddressLines(),
    address: "",
  };
}

function parseMoney(v: string): number {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

export function createDefaultCaseFormValues(): CaseFormValues {
  return {
    referenceNo: "",
    projectId: "",
    developerId: "",
    titleCategory: "",
    purchaseMode: "cash",
    purchasers: [newPurchaser()],
    loanPartyType: "1st_party",
    borrowers: [newBorrower()],
    endFinancierBank: "",
    bankRef: "",
    branch: "",
    branchAddressLines: emptyAddressLines(),
    branchAddress: "",
    financingSum: "",
    othersSum: "",
    property: {
      titleTypeLabel: "",
      lotNo: "",
      hakmilikNo: "",
      bangunanNo: "",
      tingkatNo: "",
      petakNo: "",
      accessoryPetakNo: "",
      carparkNo: "",
      carparkLevel: "",
      landArea: "",
      accessoryArea: "",
      parcelNo: "",
      unitNo: "",
      buildingNo: "",
      floorNo: "",
      propertyType: "",
      areaSqm: "",
      bandarMukim: "",
      daerah: "",
      negeri: "",
      propertyAddressLines: emptyAddressLines(),
      propertyAddress: "",
    },
    apdlPrice: "",
    developerDiscount: "",
    bumiputraDiscount: "",
    purchasePrice: "",
  };
}

export function CaseForm(props: {
  mode: "create" | "edit";
  value: CaseFormValues;
  onChange: (next: CaseFormValues) => void;
  onSubmit: () => void;
  submitting?: boolean;
  submitLabel?: string;
}) {
  const submitting = Boolean(props.submitting);
  const v = props.value;
  const set = props.onChange;
  const [activeTab, setActiveTab] = useState<"spa" | "loan" | "property">("spa");
  const [developerManuallyChanged, setDeveloperManuallyChanged] = useState(false);

  const { data: projectsRes } = useListProjects({ limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
  const projects = projectsRes?.data || [];
  const { data: devsRes } = useListDevelopers({ limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
  const developers = devsRes?.data || [];

  const selectedProject = useMemo(() => {
    const pid = Number(v.projectId);
    if (!Number.isFinite(pid)) return null;
    return projects.find((p: any) => Number(p.id) === pid) ?? null;
  }, [projects, v.projectId]);

  useEffect(() => {
    if (!selectedProject) return;
    const projectDeveloperId = (selectedProject as any)?.developerId ? String((selectedProject as any).developerId) : "";
    if (projectDeveloperId && !developerManuallyChanged) {
      set({ ...v, developerId: projectDeveloperId });
    }
    const tt = String((selectedProject as any)?.titleType ?? "").trim().toLowerCase();
    const titleCategory: TitleCategory = tt === "strata" ? "strata" : tt === "individual" ? "individual" : "master";
    if (!v.titleCategory) {
      set({ ...v, titleCategory });
    }
    const mukim = String((selectedProject as any)?.mukim ?? "").trim();
    const daerah = String((selectedProject as any)?.daerah ?? "").trim();
    const negeri = String((selectedProject as any)?.negeri ?? "").trim();
    if (mukim || daerah || negeri) {
      set({
        ...v,
        property: {
          ...v.property,
          bandarMukim: v.property.bandarMukim || mukim,
          daerah: v.property.daerah || daerah,
          negeri: v.property.negeri || negeri,
        },
      });
    }
  }, [selectedProject]);

  useEffect(() => {
    const apdl = parseMoney(v.apdlPrice);
    const dev = parseMoney(v.developerDiscount);
    const bumi = parseMoney(v.bumiputraDiscount);
    if (!v.apdlPrice && !v.developerDiscount && !v.bumiputraDiscount) return;
    const computed = apdl - dev - bumi;
    set({ ...v, purchasePrice: fmtMoney(Math.max(0, computed)) });
  }, [v.apdlPrice, v.developerDiscount, v.bumiputraDiscount]);

  useEffect(() => {
    if (v.purchaseMode !== "loan") return;
    if (v.loanPartyType !== "1st_party") return;
    set({
      ...v,
      borrowers: v.purchasers.map((p) => ({
        id: crypto.randomUUID(),
        name: p.name,
        ic: p.icOrCompanyNo,
        hp: p.tel,
        email: p.email,
        addressLines: p.addressLines,
        address: p.address,
      })),
    });
  }, [v.purchaseMode, v.loanPartyType]);

  const totalLoan = useMemo(() => {
    const fin = parseMoney(v.financingSum);
    const oth = parseMoney(v.othersSum);
    return fin + oth;
  }, [v.financingSum, v.othersSum]);

  const totalLoanWords = useMemo(() => {
    if (!totalLoan) return "";
    return toRinggitMalaysiaWords(totalLoan);
  }, [totalLoan]);

  const canSubmit = Boolean(v.referenceNo.trim() && v.projectId && v.developerId && v.titleCategory);

  const onComposePurchaserAddress = (id: string) => {
    const nextPurchasers = v.purchasers.map((p) => {
      if (p.id !== id) return p;
      return { ...p, address: joinAddressLines(p.addressLines) };
    });
    set({ ...v, purchasers: nextPurchasers });
  };

  const onComposeBorrowerAddress = (id: string) => {
    const nextBorrowers = v.borrowers.map((b) => {
      if (b.id !== id) return b;
      return { ...b, address: joinAddressLines(b.addressLines) };
    });
    set({ ...v, borrowers: nextBorrowers });
  };

  const onComposeBranchAddress = () => {
    set({ ...v, branchAddress: joinAddressLines(v.branchAddressLines) });
  };

  const onComposePropertyAddress = () => {
    set({ ...v, property: { ...v.property, propertyAddress: joinAddressLines(v.property.propertyAddressLines) } });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-4 space-y-1.5">
          <Label>Our File Ref *</Label>
          <Input value={v.referenceNo} onChange={(e) => set({ ...v, referenceNo: e.target.value })} disabled={submitting} />
        </div>
        <div className="md:col-span-4 space-y-1.5">
          <Label>Project *</Label>
          <Select value={v.projectId} onValueChange={(next) => {
            setDeveloperManuallyChanged(false);
            set({ ...v, projectId: next });
          }} disabled={submitting}>
            <SelectTrigger>
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p: any) => (
                <SelectItem key={p.id} value={String(p.id)}>{String(p.name ?? `Project ${p.id}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-4 space-y-1.5">
          <Label>Developer *</Label>
          <Select value={v.developerId} onValueChange={(next) => {
            setDeveloperManuallyChanged(true);
            set({ ...v, developerId: next });
          }} disabled={submitting}>
            <SelectTrigger>
              <SelectValue placeholder="Select developer" />
            </SelectTrigger>
            <SelectContent>
              {developers.map((d: any) => (
                <SelectItem key={d.id} value={String(d.id)}>{String(d.name ?? `Developer ${d.id}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-4 space-y-1.5">
          <Label>Title Category *</Label>
          <Select value={v.titleCategory} onValueChange={(next) => set({ ...v, titleCategory: next as any })} disabled={submitting}>
            <SelectTrigger>
              <SelectValue placeholder="Select title category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="master">Master</SelectItem>
              <SelectItem value="strata">Strata</SelectItem>
              <SelectItem value="individual">Individual</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-8 space-y-1.5">
          <Label>Purchase Mode</Label>
          <div className="flex flex-wrap gap-3 pt-1">
            {(["cash", "loan", "other"] as PurchaseMode[]).map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={v.purchaseMode === m}
                  onChange={() => set({ ...v, purchaseMode: m })}
                  disabled={submitting}
                />
                {m === "cash" ? "Cash" : m === "loan" ? "Loan" : "Other"}
              </label>
            ))}
          </div>
        </div>
      </div>

      <Separator />

      <Tabs value={activeTab} onValueChange={(t) => setActiveTab(t as any)}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="spa">SPA Details</TabsTrigger>
          <TabsTrigger value="loan" disabled={v.purchaseMode !== "loan"}>Loan Details</TabsTrigger>
          <TabsTrigger value="property">Property Details</TabsTrigger>
        </TabsList>

        <TabsContent value="spa" className="space-y-4 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-900">Purchasers</div>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ ...v, purchasers: [...v.purchasers, newPurchaser()] })} disabled={submitting}>
              <Plus className="h-4 w-4 mr-2" />Add Purchaser
            </Button>
          </div>

          <div className="space-y-4">
            {v.purchasers.map((p, idx) => (
              <div key={p.id} className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">Purchaser {idx + 1}</div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => set({ ...v, purchasers: v.purchasers.filter((x) => x.id !== p.id) })}
                    disabled={submitting || v.purchasers.length <= 1}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />Remove
                  </Button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-3 flex items-center gap-2 pt-6">
                    <Checkbox checked={p.isCompany} onCheckedChange={(c) => {
                      set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, isCompany: !!c } : x) });
                    }} disabled={submitting} />
                    <Label>Is Company</Label>
                  </div>
                  <div className="md:col-span-5 space-y-1.5">
                    <Label>Name</Label>
                    <Input value={p.name} onChange={(e) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x) })} disabled={submitting} />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>IC / Company No</Label>
                    <Input value={p.icOrCompanyNo} onChange={(e) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, icOrCompanyNo: e.target.value } : x) })} disabled={submitting} />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Tel</Label>
                    <Input value={p.tel} onChange={(e) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, tel: e.target.value } : x) })} disabled={submitting} />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Email</Label>
                    <Input type="email" value={p.email} onChange={(e) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, email: e.target.value } : x) })} disabled={submitting} />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Composed Address</Label>
                    <Input value={p.address} readOnly />
                  </div>
                </div>

                <AddressLinesFields
                  label="Address"
                  value={p.addressLines}
                  onChange={(next) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, addressLines: next } : x) })}
                  onBlurCompose={() => onComposePurchaserAddress(p.id)}
                  disabled={submitting}
                />
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="loan" className="space-y-4 pt-3">
          {v.purchaseMode !== "loan" ? (
            <div className="text-sm text-slate-600">Loan Details are available only when Purchase Mode is Loan.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                <div className="md:col-span-4 space-y-1.5">
                  <Label>Party Type</Label>
                  <Select value={v.loanPartyType} onValueChange={(next) => set({ ...v, loanPartyType: next as LoanPartyType })} disabled={submitting}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1st_party">1st Party</SelectItem>
                      <SelectItem value="3rd_party">3rd Party</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-8 flex gap-2 justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const copied = v.purchasers.map((p) => ({
                        id: crypto.randomUUID(),
                        name: p.name,
                        ic: p.icOrCompanyNo,
                        hp: p.tel,
                        email: p.email,
                        addressLines: p.addressLines,
                        address: p.address,
                      }));
                      set({ ...v, borrowers: copied.length ? copied : [newBorrower()], loanPartyType: "1st_party" });
                    }}
                    disabled={submitting}
                  >
                    Copy from Purchasers
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-900">Borrowers</div>
                <Button type="button" variant="outline" size="sm" onClick={() => set({ ...v, borrowers: [...v.borrowers, newBorrower()] })} disabled={submitting}>
                  <Plus className="h-4 w-4 mr-2" />Add Borrower
                </Button>
              </div>

              <div className="space-y-4">
                {v.borrowers.map((b, idx) => (
                  <div key={b.id} className="rounded-lg border p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-slate-900">Borrower {idx + 1}</div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => set({ ...v, borrowers: v.borrowers.filter((x) => x.id !== b.id) })}
                        disabled={submitting || v.borrowers.length <= 1}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />Remove
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>Name</Label>
                        <Input value={b.name} onChange={(e) => set({ ...v, borrowers: v.borrowers.map((x) => x.id === b.id ? { ...x, name: e.target.value } : x) })} disabled={submitting} />
                      </div>
                      <div className="md:col-span-6 space-y-1.5">
                        <Label>IC</Label>
                        <Input value={b.ic} onChange={(e) => set({ ...v, borrowers: v.borrowers.map((x) => x.id === b.id ? { ...x, ic: e.target.value } : x) })} disabled={submitting} />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-4 space-y-1.5">
                        <Label>HP</Label>
                        <Input value={b.hp} onChange={(e) => set({ ...v, borrowers: v.borrowers.map((x) => x.id === b.id ? { ...x, hp: e.target.value } : x) })} disabled={submitting} />
                      </div>
                      <div className="md:col-span-4 space-y-1.5">
                        <Label>Email</Label>
                        <Input type="email" value={b.email} onChange={(e) => set({ ...v, borrowers: v.borrowers.map((x) => x.id === b.id ? { ...x, email: e.target.value } : x) })} disabled={submitting} />
                      </div>
                      <div className="md:col-span-4 space-y-1.5">
                        <Label>Composed Address</Label>
                        <Input value={b.address} readOnly />
                      </div>
                    </div>

                    <AddressLinesFields
                      label="Address"
                      value={b.addressLines}
                      onChange={(next) => set({ ...v, borrowers: v.borrowers.map((x) => x.id === b.id ? { ...x, addressLines: next } : x) })}
                      onBlurCompose={() => onComposeBorrowerAddress(b.id)}
                      disabled={submitting}
                    />
                  </div>
                ))}
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="text-sm font-medium text-slate-900">End Financier</div>
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Bank Name</Label>
                    <Input value={v.endFinancierBank} onChange={(e) => set({ ...v, endFinancierBank: e.target.value })} disabled={submitting} />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Branch</Label>
                    <Input value={v.branch} onChange={(e) => set({ ...v, branch: e.target.value })} disabled={submitting} />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Bank Ref</Label>
                    <Input value={v.bankRef} onChange={(e) => set({ ...v, bankRef: e.target.value })} disabled={submitting} />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-8">
                    <AddressLinesFields
                      label="Branch Address"
                      value={v.branchAddressLines}
                      onChange={(next) => set({ ...v, branchAddressLines: next })}
                      onBlurCompose={onComposeBranchAddress}
                      disabled={submitting}
                    />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Composed Address</Label>
                    <Input value={v.branchAddress} readOnly />
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="text-sm font-medium text-slate-900">Loan Amounts</div>
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Financing Sum</Label>
                    <Input value={v.financingSum} onChange={(e) => set({ ...v, financingSum: e.target.value })} disabled={submitting} inputMode="decimal" />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Others (MRTA/Legal Fees)</Label>
                    <Input value={v.othersSum} onChange={(e) => set({ ...v, othersSum: e.target.value })} disabled={submitting} inputMode="decimal" />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Total Loan</Label>
                    <Input value={fmtMoney(totalLoan)} readOnly />
                  </div>
                  <div className="md:col-span-12 space-y-1.5">
                    <Label>Total Loan (Words)</Label>
                    <Input value={totalLoanWords} readOnly />
                  </div>
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="property" className="space-y-4 pt-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-4 space-y-1.5">
              <Label>Title Type</Label>
              <Input value={v.property.titleTypeLabel} onChange={(e) => set({ ...v, property: { ...v.property, titleTypeLabel: e.target.value } })} disabled={submitting} placeholder={v.titleCategory === "strata" ? "Geran/GM" : v.titleCategory === "individual" ? "HS(D)/HS(M)" : ""} />
            </div>
            <div className="md:col-span-4 space-y-1.5">
              <Label>Bandar / Mukim</Label>
              <Input value={v.property.bandarMukim} onChange={(e) => set({ ...v, property: { ...v.property, bandarMukim: e.target.value } })} disabled={submitting} />
            </div>
            <div className="md:col-span-4 space-y-1.5">
              <Label>Daerah</Label>
              <Input value={v.property.daerah} onChange={(e) => set({ ...v, property: { ...v.property, daerah: e.target.value } })} disabled={submitting} />
            </div>
            <div className="md:col-span-4 space-y-1.5">
              <Label>Negeri</Label>
              <Input value={v.property.negeri} onChange={(e) => set({ ...v, property: { ...v.property, negeri: e.target.value } })} disabled={submitting} />
            </div>
          </div>

          {v.titleCategory === "master" && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4 space-y-1.5">
                <Label>Parcel/Unit No</Label>
                <Input value={v.property.parcelNo} onChange={(e) => set({ ...v, property: { ...v.property, parcelNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Area</Label>
                <Input value={v.property.areaSqm} onChange={(e) => set({ ...v, property: { ...v.property, areaSqm: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Building No</Label>
                <Input value={v.property.buildingNo} onChange={(e) => set({ ...v, property: { ...v.property, buildingNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Floor</Label>
                <Input value={v.property.floorNo} onChange={(e) => set({ ...v, property: { ...v.property, floorNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Type</Label>
                <Input value={v.property.propertyType} onChange={(e) => set({ ...v, property: { ...v.property, propertyType: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Accessory Parcel</Label>
                <Input value={v.property.accessoryPetakNo} onChange={(e) => set({ ...v, property: { ...v.property, accessoryPetakNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Carpark No</Label>
                <Input value={v.property.carparkNo} onChange={(e) => set({ ...v, property: { ...v.property, carparkNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Carpark Level</Label>
                <Input value={v.property.carparkLevel} onChange={(e) => set({ ...v, property: { ...v.property, carparkLevel: e.target.value } })} disabled={submitting} />
              </div>
            </div>
          )}

          {v.titleCategory === "strata" && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4 space-y-1.5">
                <Label>Lot No</Label>
                <Input value={v.property.lotNo} onChange={(e) => set({ ...v, property: { ...v.property, lotNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Hakmilik</Label>
                <Input value={v.property.hakmilikNo} onChange={(e) => set({ ...v, property: { ...v.property, hakmilikNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Bangunan</Label>
                <Input value={v.property.bangunanNo} onChange={(e) => set({ ...v, property: { ...v.property, bangunanNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Tingkat</Label>
                <Input value={v.property.tingkatNo} onChange={(e) => set({ ...v, property: { ...v.property, tingkatNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Petak</Label>
                <Input value={v.property.petakNo} onChange={(e) => set({ ...v, property: { ...v.property, petakNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Accessory Petak</Label>
                <Input value={v.property.accessoryPetakNo} onChange={(e) => set({ ...v, property: { ...v.property, accessoryPetakNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Luas Petak</Label>
                <Input value={v.property.landArea} onChange={(e) => set({ ...v, property: { ...v.property, landArea: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Luas Accessory</Label>
                <Input value={v.property.accessoryArea} onChange={(e) => set({ ...v, property: { ...v.property, accessoryArea: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-12">
                <AddressLinesFields
                  label="Property Address"
                  value={v.property.propertyAddressLines}
                  onChange={(next) => set({ ...v, property: { ...v.property, propertyAddressLines: next } })}
                  onBlurCompose={onComposePropertyAddress}
                  disabled={submitting}
                />
              </div>
              <div className="md:col-span-12 space-y-1.5">
                <Label>Composed Property Address</Label>
                <Input value={v.property.propertyAddress} readOnly />
              </div>
            </div>
          )}

          {v.titleCategory === "individual" && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4 space-y-1.5">
                <Label>Lot No</Label>
                <Input value={v.property.lotNo} onChange={(e) => set({ ...v, property: { ...v.property, lotNo: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Luas Tanah</Label>
                <Input value={v.property.landArea} onChange={(e) => set({ ...v, property: { ...v.property, landArea: e.target.value } })} disabled={submitting} />
              </div>
              <div className="md:col-span-12">
                <AddressLinesFields
                  label="Property Address"
                  value={v.property.propertyAddressLines}
                  onChange={(next) => set({ ...v, property: { ...v.property, propertyAddressLines: next } })}
                  onBlurCompose={onComposePropertyAddress}
                  disabled={submitting}
                />
              </div>
              <div className="md:col-span-12 space-y-1.5">
                <Label>Composed Property Address</Label>
                <Input value={v.property.propertyAddress} readOnly />
              </div>
            </div>
          )}

          <Separator />

          <div className="space-y-3">
            <div className="text-sm font-medium text-slate-900">Pricing</div>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-3 space-y-1.5">
                <Label>Purchase Price</Label>
                <Input value={v.purchasePrice} readOnly />
              </div>
              <div className="md:col-span-3 space-y-1.5">
                <Label>APDL Price</Label>
                <Input value={v.apdlPrice} onChange={(e) => set({ ...v, apdlPrice: e.target.value })} disabled={submitting} inputMode="decimal" />
              </div>
              <div className="md:col-span-3 space-y-1.5">
                <Label>Developer Discount</Label>
                <Input value={v.developerDiscount} onChange={(e) => set({ ...v, developerDiscount: e.target.value })} disabled={submitting} inputMode="decimal" />
              </div>
              <div className="md:col-span-3 space-y-1.5">
                <Label>Bumiputra Discount</Label>
                <Input value={v.bumiputraDiscount} onChange={(e) => set({ ...v, bumiputraDiscount: e.target.value })} disabled={submitting} inputMode="decimal" />
              </div>
            </div>
            <PricingBreakdown purchasePrice={v.purchasePrice} />
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" onClick={props.onSubmit} disabled={!canSubmit || submitting}>
          {submitting ? "Saving..." : (props.submitLabel ?? (props.mode === "create" ? "Create Case" : "Save Changes"))}
        </Button>
      </div>
    </div>
  );
}

