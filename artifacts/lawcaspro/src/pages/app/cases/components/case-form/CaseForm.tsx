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
import { HistoryInput } from "./HistoryInput";
import { PricingBreakdown } from "./PricingBreakdown";
import { composeMalaysiaAddress, emptyAddressLines, joinAddressLines, normalizeAddressText, normalizeMalaysiaPostcodeInput } from "./address";
import type { BorrowerForm, CaseFormValues, CaseType, Encumbrances, LandCondition, LoanPartyType, PerfectionType, PurchaserForm, PurchaseMode, TitleCategory } from "./types";
import { calculateLoanAmounts } from "@/lib/loan-amounts";
import { amountToEnglishWords, formatRMAmount, toMoneyNumber } from "@/lib/money";
import { getStateFromPostcode } from "@/utils/my-address-helper";

const MALAYSIA_STATE_OPTIONS = [
  "Kuala Lumpur",
  "Selangor",
  "Johor",
  "Penang",
  "Perak",
  "Pahang",
  "Kelantan",
  "Terengganu",
  "Kedah",
  "Perlis",
  "Negeri Sembilan",
  "Melaka",
  "Sabah",
  "Sarawak",
] as const;

function newPurchaser(): PurchaserForm {
  return {
    id: crypto.randomUUID(),
    isCompany: false,
    name: "",
    icOrCompanyNo: "",
    tin: "",
    tel: "",
    email: "",
    postcode: "",
    city: "",
    state: "",
    addressLines: emptyAddressLines(),
    address: "",
  };
}

function newBorrower(): BorrowerForm {
  return {
    id: crypto.randomUUID(),
    name: "",
    ic: "",
    tin: "",
    hp: "",
    email: "",
    postcode: "",
    city: "",
    state: "",
    addressLines: emptyAddressLines(),
    address: "",
  };
}

export function createDefaultCaseFormValues(): CaseFormValues {
  return {
    caseType: "",
    projectId: "",
    developerId: "",
    titleCategory: "",
    purchaseMode: "cash",
    landCondition: "",
    encumbrances: "",
    actingFor: "",
    perfectionType: "",
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
      postcode: "",
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
  canOverrideProjectDerivedFields?: boolean;
}) {
  const submitting = Boolean(props.submitting);
  const canOverrideProjectDerivedFields = Boolean(props.canOverrideProjectDerivedFields);
  const v = props.value;
  const set = props.onChange;
  const [activeTab, setActiveTab] = useState<"spa" | "loan" | "property">("spa");
  const [developerManuallyChanged, setDeveloperManuallyChanged] = useState(false);
  const [titleManuallyChanged, setTitleManuallyChanged] = useState(false);
  const [purchasePriceManuallyChanged, setPurchasePriceManuallyChanged] = useState(false);
  const [postcodeWarnings, setPostcodeWarnings] = useState<Record<string, string>>({});

  const { data: projectsRes } = useListProjects({ limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
  const projects = projectsRes?.data || [];
  const { data: devsRes } = useListDevelopers({ limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
  const developers = devsRes?.data || [];

  const selectedProject = useMemo(() => {
    const pid = Number(v.projectId);
    if (!Number.isFinite(pid)) return null;
    return projects.find((p: any) => Number(p.id) === pid) ?? null;
  }, [projects, v.projectId]);

  const selectedProjectDeveloperId = useMemo(() => {
    if (!selectedProject) return "";
    const raw = (selectedProject as any)?.developerId;
    return raw ? String(raw) : "";
  }, [selectedProject]);

  const selectedProjectTitleCategory = useMemo<TitleCategory | "">(() => {
    if (!selectedProject) return "";
    const raw = String((selectedProject as any)?.titleCategory ?? (selectedProject as any)?.titleType ?? "").trim().toLowerCase();
    if (raw === "strata") return "strata";
    if (raw === "individual") return "individual";
    if (raw === "master") return "master";
    return "";
  }, [selectedProject]);

  const selectedProjectAutoFillWarning = useMemo(() => {
    if (!selectedProject || v.caseType !== "developer_sales") return "";
    const missing: string[] = [];
    if (!selectedProjectDeveloperId) missing.push("developer");
    if (!selectedProjectTitleCategory) missing.push("title type");
    return missing.length > 0
      ? `Selected project is missing ${missing.join(" and ")} mapping. Please update the project master data.`
      : "";
  }, [selectedProject, selectedProjectDeveloperId, selectedProjectTitleCategory, v.caseType]);

  useEffect(() => {
    if (!selectedProject) return;
    if (v.caseType !== "developer_sales") return;
    let changed = false;
    const nextValue: CaseFormValues = {
      ...v,
      property: { ...v.property },
    };

    if (!developerManuallyChanged || !canOverrideProjectDerivedFields) {
      const nextDeveloperId = selectedProjectDeveloperId || "";
      if (nextValue.developerId !== nextDeveloperId) {
        nextValue.developerId = nextDeveloperId;
        changed = true;
      }
    }

    if (!v.titleCategory || !titleManuallyChanged || !canOverrideProjectDerivedFields) {
      const nextTitleCategory = selectedProjectTitleCategory;
      if (nextValue.titleCategory !== nextTitleCategory) {
        nextValue.titleCategory = nextTitleCategory;
        changed = true;
      }
    }

    const mukim = String((selectedProject as any)?.mukim ?? "").trim();
    const daerah = String((selectedProject as any)?.daerah ?? "").trim();
    const negeri = String((selectedProject as any)?.negeri ?? "").trim();
    if (mukim && !nextValue.property.bandarMukim) {
      nextValue.property.bandarMukim = mukim;
      changed = true;
    }
    if (daerah && !nextValue.property.daerah) {
      nextValue.property.daerah = daerah;
      changed = true;
    }
    if (negeri && !nextValue.property.negeri) {
      nextValue.property.negeri = negeri;
      changed = true;
    }

    if (changed) set(nextValue);
  }, [
    canOverrideProjectDerivedFields,
    developerManuallyChanged,
    selectedProject,
    selectedProjectDeveloperId,
    selectedProjectTitleCategory,
    set,
    titleManuallyChanged,
    v,
  ]);

  useEffect(() => {
    if (!v.purchasePrice.trim()) setPurchasePriceManuallyChanged(false);
  }, [v.purchasePrice]);

  useEffect(() => {
    const apdl = toMoneyNumber(v.apdlPrice);
    const dev = toMoneyNumber(v.developerDiscount);
    const bumi = toMoneyNumber(v.bumiputraDiscount);
    if (!v.apdlPrice && !v.developerDiscount && !v.bumiputraDiscount) return;
    if (purchasePriceManuallyChanged) return;
    const computed = apdl - dev - bumi;
    set({ ...v, purchasePrice: Math.max(0, computed).toFixed(2) });
  }, [v.apdlPrice, v.developerDiscount, v.bumiputraDiscount, purchasePriceManuallyChanged]);

  useEffect(() => {
    if (v.purchaseMode !== "loan") return;
    if (v.loanPartyType !== "1st_party") return;
    set({
      ...v,
      borrowers: v.purchasers.map((p) => ({
        id: crypto.randomUUID(),
        name: p.name,
        ic: p.icOrCompanyNo,
        tin: p.tin,
        hp: p.tel,
        email: p.email,
        postcode: p.postcode,
        city: p.city,
        state: p.state,
        addressLines: p.addressLines,
        address: p.address,
      })),
    });
  }, [v.purchaseMode, v.loanPartyType]);

  const loanAmounts = useMemo(() => calculateLoanAmounts({
    financingSum: v.financingSum,
    others: v.othersSum,
  }), [v.financingSum, v.othersSum]);

  const totalLoan = loanAmounts.totalLoan;
  const totalLoanWords = loanAmounts.totalLoanWords;
  const purchasePriceAmount = useMemo(() => toMoneyNumber(v.purchasePrice), [v.purchasePrice]);
  const purchasePriceWords = useMemo(() => amountToEnglishWords(purchasePriceAmount), [purchasePriceAmount]);

  const canSubmit = (() => {
    if (!v.caseType) return false;
    if (v.caseType === "developer_sales") return Boolean(v.projectId && v.titleCategory && v.purchaseMode);
    if (v.caseType === "subsale") return Boolean(v.titleCategory && v.landCondition && v.encumbrances && v.actingFor);
    if (v.caseType === "perfection") return Boolean(v.perfectionType);
    return false;
  })();

  const setCaseType = (next: CaseType) => {
    if (next === v.caseType) return;
    if (next === "developer_sales") {
      set({
        ...v,
        caseType: next,
        landCondition: "",
        encumbrances: "",
        actingFor: "",
        perfectionType: "",
      });
      return;
    }
    if (next === "subsale") {
      setDeveloperManuallyChanged(false);
      set({
        ...v,
        caseType: next,
        projectId: "",
        developerId: "",
        purchaseMode: "cash",
        perfectionType: "",
      });
      return;
    }
    setDeveloperManuallyChanged(false);
    set({
      ...v,
      caseType: next,
      projectId: "",
      developerId: "",
      titleCategory: "",
      purchaseMode: "cash",
      landCondition: "",
      encumbrances: "",
      actingFor: "",
    });
  };

  const onComposePurchaserAddress = (id: string) => {
    const nextPurchasers = v.purchasers.map((p) => {
      if (p.id !== id) return p;
      const address = joinAddressLines(p.addressLines);
      return { ...p, address };
    });
    set({ ...v, purchasers: nextPurchasers });
  };

  const onComposeBorrowerAddress = (id: string) => {
    const nextBorrowers = v.borrowers.map((b) => {
      if (b.id !== id) return b;
      const address = joinAddressLines(b.addressLines);
      return { ...b, address };
    });
    set({ ...v, borrowers: nextBorrowers });
  };

  const onComposeBranchAddress = () => {
    set({ ...v, branchAddress: joinAddressLines(v.branchAddressLines) });
  };

  const onComposePropertyAddress = () => {
    const composed = composeMalaysiaAddress({
      lines: v.property.propertyAddressLines,
      postcode: v.property.postcode,
      city: v.property.bandarMukim,
      state: v.property.negeri,
    });
    set({ ...v, property: { ...v.property, propertyAddress: composed.address, negeri: composed.derivedState ?? v.property.negeri } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Case Type *</Label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Button type="button" variant={v.caseType === "developer_sales" ? "default" : "outline"} onClick={() => setCaseType("developer_sales")} disabled={submitting}>
            Developer Sales
          </Button>
          <Button type="button" variant={v.caseType === "subsale" ? "default" : "outline"} onClick={() => setCaseType("subsale")} disabled={submitting}>
            Subsale
          </Button>
          <Button type="button" variant={v.caseType === "perfection" ? "default" : "outline"} onClick={() => setCaseType("perfection")} disabled={submitting}>
            Perfection
          </Button>
        </div>
      </div>

      {!v.caseType ? (
        <div className="text-sm text-slate-600">Select a Case Type to continue.</div>
      ) : v.caseType === "developer_sales" ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-4 space-y-1.5">
              <Label>Project *</Label>
              <Select value={v.projectId} onValueChange={(next) => {
                setDeveloperManuallyChanged(false);
                setTitleManuallyChanged(false);
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
              {selectedProjectAutoFillWarning ? (
                <div className="text-xs text-amber-700">{selectedProjectAutoFillWarning}</div>
              ) : null}
            </div>
            <div className="md:col-span-4 space-y-1.5">
              <Label>Developer *</Label>
              <Select value={v.developerId} onValueChange={(next) => {
                setDeveloperManuallyChanged(true);
                set({ ...v, developerId: next });
              }} disabled={submitting || (Boolean((selectedProject as any)?.developerId) && !canOverrideProjectDerivedFields)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select developer" />
                </SelectTrigger>
                <SelectContent>
                  {developers.map((d: any) => (
                    <SelectItem key={d.id} value={String(d.id)}>{String(d.name ?? `Developer ${d.id}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-slate-500">Auto-filled from selected Project</div>
            </div>
            <div className="md:col-span-4 space-y-1.5">
              <Label>Title Type *</Label>
              <Select
                value={v.titleCategory}
                onValueChange={(next) => {
                  setTitleManuallyChanged(true);
                  set({ ...v, titleCategory: next as any });
                }}
                disabled={submitting || (Boolean((selectedProject as any)?.titleType) && !canOverrideProjectDerivedFields)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select title category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="master">Master</SelectItem>
                  <SelectItem value="strata">Strata</SelectItem>
                  <SelectItem value="individual">Individual</SelectItem>
                </SelectContent>
              </Select>
              <div className="text-xs text-slate-500">Auto-filled from selected Project</div>
            </div>
            <div className="md:col-span-8 space-y-1.5">
              <Label>Purchase Mode *</Label>
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
                  <div className="flex items-center gap-2">
                    {idx >= 1 ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const source = v.purchasers[0];
                          const nextLines = source ? source.addressLines : emptyAddressLines();
                          const address = joinAddressLines(nextLines);
                          set({
                            ...v,
                            purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, addressLines: nextLines, address } : x),
                          });
                        }}
                        disabled={submitting || v.purchasers.length < 2}
                      >
                        Address as per Purchaser 1
                      </Button>
                    ) : null}
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
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-3 flex items-center gap-2 pt-6">
                    <Checkbox checked={p.isCompany} onCheckedChange={(c) => {
                      set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, isCompany: !!c } : x) });
                    }} disabled={submitting} />
                    <Label>Is Company</Label>
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Name</Label>
                    <Input value={p.name} onChange={(e) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x) })} disabled={submitting} />
                  </div>
                  <div className="md:col-span-3 space-y-1.5">
                    <Label>IC / Company No</Label>
                    <Input value={p.icOrCompanyNo} onChange={(e) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, icOrCompanyNo: e.target.value } : x) })} disabled={submitting} />
                  </div>
                  <div className="md:col-span-2 space-y-1.5">
                    <Label>TIN</Label>
                    <Input value={p.tin} onChange={(e) => set({ ...v, purchasers: v.purchasers.map((x) => x.id === p.id ? { ...x, tin: e.target.value } : x) })} disabled={submitting} />
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
                  normalize={normalizeAddressText}
                  historyKeyPrefix="purchaser.address"
                  disabled={submitting}
                  maxLines={5}
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
                        tin: p.tin,
                        hp: p.tel,
                        email: p.email,
                        postcode: p.postcode,
                        city: p.city,
                        state: p.state,
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
                      <div className="md:col-span-3 space-y-1.5">
                        <Label>IC</Label>
                        <Input value={b.ic} onChange={(e) => set({ ...v, borrowers: v.borrowers.map((x) => x.id === b.id ? { ...x, ic: e.target.value } : x) })} disabled={submitting} />
                      </div>
                      <div className="md:col-span-3 space-y-1.5">
                        <Label>TIN</Label>
                        <Input value={b.tin} onChange={(e) => set({ ...v, borrowers: v.borrowers.map((x) => x.id === b.id ? { ...x, tin: e.target.value } : x) })} disabled={submitting} />
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
                      normalize={normalizeAddressText}
                      historyKeyPrefix="borrower.address"
                      disabled={submitting}
                      maxLines={5}
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
                      normalize={normalizeAddressText}
                      historyKeyPrefix="loan.branchAddress"
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
                    <HistoryInput storageKey="loan.financingSum" value={v.financingSum} onChange={(next) => set({ ...v, financingSum: next })} disabled={submitting} inputMode="decimal" />
                    {v.financingSum.trim() ? (
                      <div className="text-xs text-slate-500">Formatted: {formatRMAmount(v.financingSum)}</div>
                    ) : null}
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Others (MRTA/Legal Fees)</Label>
                    <HistoryInput storageKey="loan.othersText" value={v.othersSum} onChange={(next) => set({ ...v, othersSum: next })} disabled={submitting} />
                    {v.othersSum.trim() ? (
                      loanAmounts.detectedAmounts.length > 0 ? (
                        <div className="space-y-1 text-xs text-slate-500">
                          <div>Detected amounts: {loanAmounts.detectedAmounts.map((amount) => formatRMAmount(amount)).join(" + ")}</div>
                          <div>Others Total: {formatRMAmount(loanAmounts.othersTotal)}</div>
                        </div>
                      ) : (
                        <div className="text-xs text-slate-500">No valid amount detected from Others field.</div>
                      )
                    ) : null}
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Total Loan Amount</Label>
                    <Input value={formatRMAmount(totalLoan)} readOnly />
                  </div>
                  <div className="md:col-span-12 space-y-1.5">
                    <Label>Total Loan In Words</Label>
                    <Input value={totalLoanWords} readOnly />
                  </div>
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="property" className="space-y-4 pt-3">
          <div className="rounded-lg border p-3 space-y-4">
            <div className="text-sm font-medium text-slate-900">Property Unit / Parcel Details</div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-12 space-y-1.5">
                <Label>Parcel / Unit / Lot No.</Label>
                <HistoryInput
                  storageKey="property.parcelUnitLotNo"
                  value={v.property.parcelNo || v.property.lotNo || v.property.petakNo || v.property.unitNo}
                  onChange={(next) => set({ ...v, property: { ...v.property, parcelNo: next, unitNo: next, lotNo: next, petakNo: next } })}
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4 space-y-1.5">
                <Label>Property Purchase Price</Label>
                <HistoryInput
                  storageKey="purchasePrice"
                  value={v.purchasePrice}
                  onChange={(next) => {
                    setPurchasePriceManuallyChanged(true);
                    set({ ...v, purchasePrice: next });
                  }}
                  disabled={submitting}
                  inputMode="decimal"
                />
                {v.purchasePrice.trim() ? (
                  <div className="text-xs text-slate-500">Formatted: {formatRMAmount(v.purchasePrice)}</div>
                ) : null}
              </div>
              <div className="md:col-span-8 space-y-1.5">
                <Label>Purchase Price In Words</Label>
                <Input value={purchasePriceWords} readOnly />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4 space-y-1.5">
                <Label>APDL Price</Label>
                <HistoryInput storageKey="apdlPrice" value={v.apdlPrice} onChange={(next) => set({ ...v, apdlPrice: next })} disabled={submitting} inputMode="decimal" />
                {v.apdlPrice.trim() ? (
                  <div className="text-xs text-slate-500">Formatted: {formatRMAmount(v.apdlPrice)}</div>
                ) : null}
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Developer Discount</Label>
                <HistoryInput storageKey="developerDiscount" value={v.developerDiscount} onChange={(next) => set({ ...v, developerDiscount: next })} disabled={submitting} inputMode="decimal" />
                {v.developerDiscount.trim() ? (
                  <div className="text-xs text-slate-500">Formatted: {formatRMAmount(v.developerDiscount)}</div>
                ) : null}
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Bumiputra Discount</Label>
                <HistoryInput storageKey="bumiputraDiscount" value={v.bumiputraDiscount} onChange={(next) => set({ ...v, bumiputraDiscount: next })} disabled={submitting} inputMode="decimal" />
                {v.bumiputraDiscount.trim() ? (
                  <div className="text-xs text-slate-500">Formatted: {formatRMAmount(v.bumiputraDiscount)}</div>
                ) : null}
              </div>
            </div>

            <PricingBreakdown purchasePrice={v.purchasePrice} />

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-6 space-y-1.5">
                <Label>Property Type (A / A1 / B / B1)</Label>
                <HistoryInput storageKey="property.propertyType" value={v.property.propertyType} onChange={(next) => set({ ...v, property: { ...v.property, propertyType: next } })} disabled={submitting} />
                <div className="text-xs text-slate-500">A 22x70 Intermediate Lot / B 22x70 Corner Lot</div>
              </div>
              <div className="md:col-span-6 space-y-1.5">
                <Label>Parcel Area</Label>
                <HistoryInput storageKey="property.parcelAreaSqm" value={v.property.areaSqm} onChange={(next) => set({ ...v, property: { ...v.property, areaSqm: next } })} disabled={submitting} />
                <div className="text-xs text-slate-500">square meter • High Rise Unit Area / Landed Land Area as per Title</div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-700">HighRise / Landed Strata only</div>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-3 space-y-1.5">
                  <Label>Building No.</Label>
                  <Input value={v.property.buildingNo || v.property.bangunanNo} onChange={(e) => {
                    const next = e.target.value;
                    set({ ...v, property: { ...v.property, buildingNo: next, bangunanNo: next } });
                  }} disabled={submitting} />
                </div>
                <div className="md:col-span-2 space-y-1.5">
                  <Label>Floor No.</Label>
                  <Input value={v.property.floorNo || v.property.tingkatNo} onChange={(e) => {
                    const next = e.target.value;
                    set({ ...v, property: { ...v.property, floorNo: next, tingkatNo: next } });
                  }} disabled={submitting} />
                </div>
                <div className="md:col-span-3 space-y-1.5">
                  <Label>Accessory Parcel No.</Label>
                  <Input value={v.property.accessoryPetakNo} onChange={(e) => set({ ...v, property: { ...v.property, accessoryPetakNo: e.target.value } })} disabled={submitting} />
                </div>
                <div className="md:col-span-2 space-y-1.5">
                  <Label>Carpark No.</Label>
                  <Input value={v.property.carparkNo} onChange={(e) => set({ ...v, property: { ...v.property, carparkNo: e.target.value } })} disabled={submitting} />
                </div>
                <div className="md:col-span-2 space-y-1.5">
                  <Label>Carpark Level</Label>
                  <Input value={v.property.carparkLevel} onChange={(e) => set({ ...v, property: { ...v.property, carparkLevel: e.target.value } })} disabled={submitting} />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <div className="text-sm font-medium text-slate-900">Property Completed</div>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-8">
                <AddressLinesFields
                  label="Property Address"
                  value={v.property.propertyAddressLines}
                  onChange={(next) => set({ ...v, property: { ...v.property, propertyAddressLines: next } })}
                  onBlurCompose={onComposePropertyAddress}
                  normalize={normalizeAddressText}
                  historyKeyPrefix="property.address"
                  disabled={submitting}
                />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>Postcode (if property completed)</Label>
                <Input
                  value={v.property.postcode}
                  onChange={(e) => {
                    const nextPostcode = normalizeMalaysiaPostcodeInput(e.target.value);
                    const derived = nextPostcode.length === 5 ? getStateFromPostcode(nextPostcode) : null;
                    setPostcodeWarnings((prev) => {
                      const next = { ...prev };
                      if (derived && v.property.negeri.trim() && v.property.negeri.trim() !== derived) next["property"] = `Warning: Postcode ${nextPostcode} belongs to ${derived}`;
                      else delete next["property"];
                      return next;
                    });
                    const nextNegeri = derived ?? v.property.negeri;
                    const composed = composeMalaysiaAddress({
                      lines: v.property.propertyAddressLines,
                      postcode: nextPostcode,
                      city: v.property.bandarMukim,
                      state: nextNegeri,
                    });
                    set({
                      ...v,
                      property: {
                        ...v.property,
                        postcode: nextPostcode,
                        negeri: derived ?? v.property.negeri,
                        propertyAddress: composed.address,
                      },
                    });
                  }}
                  disabled={submitting}
                  inputMode="numeric"
                />
                {postcodeWarnings["property"] ? (
                  <div className="text-xs text-amber-700 mt-1">{postcodeWarnings["property"]}</div>
                ) : null}
              </div>
              <div className="md:col-span-12 space-y-1.5">
                <Label>Composed Property Address</Label>
                <Input value={v.property.propertyAddress} readOnly />
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <div className="text-sm font-medium text-slate-900">Individual Title / Strata Title Details</div>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4 space-y-1.5">
                <Label>Individual Title / Strata Title</Label>
                <Select
                  value={v.property.titleTypeLabel}
                  onValueChange={(next) => set({ ...v, property: { ...v.property, titleTypeLabel: next } })}
                  disabled={submitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {(v.titleCategory === "individual"
                      ? ["HS(D)", "HS(M)"]
                      : ["Geran", "GM"]
                    ).map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-8 space-y-1.5">
                <Label>TITLE Number</Label>
                <Input value={v.property.hakmilikNo} onChange={(e) => set({ ...v, property: { ...v.property, hakmilikNo: e.target.value } })} disabled={submitting} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4 space-y-1.5">
                <Label>BANDAR / PEKAN / MUKIM</Label>
                  <HistoryInput storageKey="property.bandarMukim" value={v.property.bandarMukim} onChange={(next) => set({ ...v, property: { ...v.property, bandarMukim: next } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>DAERAH</Label>
                  <HistoryInput storageKey="property.daerah" value={v.property.daerah} onChange={(next) => set({ ...v, property: { ...v.property, daerah: next } })} disabled={submitting} />
              </div>
              <div className="md:col-span-4 space-y-1.5">
                <Label>NEGERI</Label>
                <Select
                  value={v.property.negeri}
                  onValueChange={(nextState) => {
                    const derived = v.property.postcode.length === 5 ? getStateFromPostcode(v.property.postcode) : null;
                    setPostcodeWarnings((prev) => {
                      const next = { ...prev };
                      if (derived && nextState.trim() && nextState.trim() !== derived) next["property"] = `Warning: Postcode ${v.property.postcode} belongs to ${derived}`;
                      else delete next["property"];
                      return next;
                    });
                    const composed = composeMalaysiaAddress({
                      lines: v.property.propertyAddressLines,
                      postcode: v.property.postcode,
                      city: v.property.bandarMukim,
                      state: nextState,
                    });
                    set({ ...v, property: { ...v.property, negeri: nextState, propertyAddress: composed.address } });
                  }}
                  disabled={submitting || Boolean(v.property.postcode.length === 5 && getStateFromPostcode(v.property.postcode))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {MALAYSIA_STATE_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-6 space-y-1.5">
                <Label>TITLE LAND / PARCEL AREA</Label>
                <Input value={v.property.landArea} onChange={(e) => set({ ...v, property: { ...v.property, landArea: e.target.value } })} disabled={submitting} />
                <div className="text-xs text-slate-500">square meter</div>
              </div>
              <div className="md:col-span-6 space-y-1.5">
                <Label>ACCESSORY AREA</Label>
                <Input value={v.property.accessoryArea} onChange={(e) => set({ ...v, property: { ...v.property, accessoryArea: e.target.value } })} disabled={submitting} />
                <div className="text-xs text-slate-500">square meter</div>
              </div>
            </div>
          </div>
        </TabsContent>
          </Tabs>
        </>
      ) : v.caseType === "subsale" ? (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-3 space-y-1.5">
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
          <div className="md:col-span-3 space-y-1.5">
            <Label>Land Condition *</Label>
            <Select value={v.landCondition} onValueChange={(next) => set({ ...v, landCondition: next as LandCondition })} disabled={submitting}>
              <SelectTrigger>
                <SelectValue placeholder="Select land condition" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="freehold">Freehold</SelectItem>
                <SelectItem value="leasehold">Leasehold</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-3 space-y-1.5">
            <Label>Encumbrances *</Label>
            <Select value={v.encumbrances} onValueChange={(next) => set({ ...v, encumbrances: next as Encumbrances })} disabled={submitting}>
              <SelectTrigger>
                <SelectValue placeholder="Select encumbrances" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no_encumbrance">Free from Encumbrances</SelectItem>
                <SelectItem value="has_encumbrance">Encumbrances</SelectItem>
                <SelectItem value="to_confirm">To Confirm</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-3 space-y-1.5">
            <Label>Acting *</Label>
            <Select value={v.actingFor} onValueChange={(next) => set({ ...v, actingFor: next as any })} disabled={submitting}>
              <SelectTrigger>
                <SelectValue placeholder="Select acting" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vendor">Vendor</SelectItem>
                <SelectItem value="purchaser">Purchaser</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-4 space-y-1.5">
            <Label>Perfection Type *</Label>
            <Select value={v.perfectionType} onValueChange={(next) => set({ ...v, perfectionType: next as PerfectionType })} disabled={submitting}>
              <SelectTrigger>
                <SelectValue placeholder="Select perfection type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="transfer_and_charge">Transfer &amp; Charge</SelectItem>
                <SelectItem value="transfer">Transfer</SelectItem>
                <SelectItem value="charge">Charge</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" onClick={props.onSubmit} disabled={!canSubmit || submitting}>
          {submitting ? "Saving..." : (props.submitLabel ?? (props.mode === "create" ? "Create Case" : "Save Changes"))}
        </Button>
      </div>
    </div>
  );
}

