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
import { composeMalaysiaAddress, emptyAddressLines, joinAddressLines, normalizeMalaysiaPostcodeInput } from "./address";
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

  useEffect(() => {
    if (!selectedProject) return;
    if (v.caseType !== "developer_sales") return;
    const projectDeveloperId = (selectedProject as any)?.developerId ? String((selectedProject as any).developerId) : "";
    if (projectDeveloperId && (!developerManuallyChanged || !canOverrideProjectDerivedFields)) {
      set({ ...v, developerId: projectDeveloperId });
    }
    const tt = String((selectedProject as any)?.titleType ?? "").trim().toLowerCase();
    const titleCategory: TitleCategory = tt === "strata" ? "strata" : tt === "individual" ? "individual" : "master";
    if (!v.titleCategory || !titleManuallyChanged || !canOverrideProjectDerivedFields) {
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
    const apdl = toMoneyNumber(v.apdlPrice);
    const dev = toMoneyNumber(v.developerDiscount);
    const bumi = toMoneyNumber(v.bumiputraDiscount);
    if (!v.apdlPrice && !v.developerDiscount && !v.bumiputraDiscount) return;
    const computed = apdl - dev - bumi;
    set({ ...v, purchasePrice: Math.max(0, computed).toFixed(2) });
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
      const composed = composeMalaysiaAddress({ lines: p.addressLines, postcode: p.postcode, city: p.city, state: p.state });
      return { ...p, address: composed.address, state: composed.derivedState ?? p.state };
    });
    set({ ...v, purchasers: nextPurchasers });
  };

  const onComposeBorrowerAddress = (id: string) => {
    const nextBorrowers = v.borrowers.map((b) => {
      if (b.id !== id) return b;
      const composed = composeMalaysiaAddress({ lines: b.addressLines, postcode: b.postcode, city: b.city, state: b.state });
      return { ...b, address: composed.address, state: composed.derivedState ?? b.state };
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
                  maxLines={2}
                />

                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>City</Label>
                    <Input
                      value={p.city}
                      onChange={(e) => {
                        const nextCity = e.target.value;
                        const nextPurchasers = v.purchasers.map((x) => {
                          if (x.id !== p.id) return x;
                          const composed = composeMalaysiaAddress({ lines: x.addressLines, postcode: x.postcode, city: nextCity, state: x.state });
                          return { ...x, city: nextCity, address: composed.address, state: composed.derivedState ?? x.state };
                        });
                        set({ ...v, purchasers: nextPurchasers });
                      }}
                      disabled={submitting}
                      placeholder="e.g. Muar"
                    />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Postcode</Label>
                    <Input
                      value={p.postcode}
                      onChange={(e) => {
                        const nextPostcode = normalizeMalaysiaPostcodeInput(e.target.value);
                        const derived = nextPostcode.length === 5 ? getStateFromPostcode(nextPostcode) : null;
                        const key = `purchaser:${p.id}`;
                        setPostcodeWarnings((prev) => {
                          const next = { ...prev };
                          if (derived && p.state.trim() && p.state.trim() !== derived) next[key] = `Warning: Postcode ${nextPostcode} belongs to ${derived}`;
                          else delete next[key];
                          return next;
                        });
                        const nextPurchasers = v.purchasers.map((x) => {
                          if (x.id !== p.id) return x;
                          const nextState = derived ?? x.state;
                          const composed = composeMalaysiaAddress({ lines: x.addressLines, postcode: nextPostcode, city: x.city, state: nextState });
                          return { ...x, postcode: nextPostcode, state: derived ?? x.state, address: composed.address };
                        });
                        set({ ...v, purchasers: nextPurchasers });
                      }}
                      disabled={submitting}
                      inputMode="numeric"
                      placeholder="e.g. 84000"
                    />
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>State</Label>
                    <Select
                      value={p.state}
                      onValueChange={(nextState) => {
                        const key = `purchaser:${p.id}`;
                        const derived = p.postcode.length === 5 ? getStateFromPostcode(p.postcode) : null;
                        setPostcodeWarnings((prev) => {
                          const next = { ...prev };
                          if (derived && nextState.trim() && nextState.trim() !== derived) next[key] = `Warning: Postcode ${p.postcode} belongs to ${derived}`;
                          else delete next[key];
                          return next;
                        });
                        const nextPurchasers = v.purchasers.map((x) => {
                          if (x.id !== p.id) return x;
                          const composed = composeMalaysiaAddress({ lines: x.addressLines, postcode: x.postcode, city: x.city, state: nextState });
                          return { ...x, state: nextState, address: composed.address };
                        });
                        set({ ...v, purchasers: nextPurchasers });
                      }}
                      disabled={submitting || Boolean(p.postcode.length === 5 && getStateFromPostcode(p.postcode))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select state" />
                      </SelectTrigger>
                      <SelectContent>
                        {MALAYSIA_STATE_OPTIONS.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {postcodeWarnings[`purchaser:${p.id}`] ? (
                      <div className="text-xs text-amber-700 mt-1">{postcodeWarnings[`purchaser:${p.id}`]}</div>
                    ) : null}
                  </div>
                </div>
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
                      maxLines={2}
                    />

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-4 space-y-1.5">
                        <Label>City</Label>
                        <Input
                          value={b.city}
                          onChange={(e) => {
                            const nextCity = e.target.value;
                            const nextBorrowers = v.borrowers.map((x) => {
                              if (x.id !== b.id) return x;
                              const composed = composeMalaysiaAddress({ lines: x.addressLines, postcode: x.postcode, city: nextCity, state: x.state });
                              return { ...x, city: nextCity, address: composed.address, state: composed.derivedState ?? x.state };
                            });
                            set({ ...v, borrowers: nextBorrowers });
                          }}
                          disabled={submitting}
                          placeholder="e.g. Muar"
                        />
                      </div>
                      <div className="md:col-span-4 space-y-1.5">
                        <Label>Postcode</Label>
                        <Input
                          value={b.postcode}
                          onChange={(e) => {
                            const nextPostcode = normalizeMalaysiaPostcodeInput(e.target.value);
                            const derived = nextPostcode.length === 5 ? getStateFromPostcode(nextPostcode) : null;
                            const key = `borrower:${b.id}`;
                            setPostcodeWarnings((prev) => {
                              const next = { ...prev };
                              if (derived && b.state.trim() && b.state.trim() !== derived) next[key] = `Warning: Postcode ${nextPostcode} belongs to ${derived}`;
                              else delete next[key];
                              return next;
                            });
                            const nextBorrowers = v.borrowers.map((x) => {
                              if (x.id !== b.id) return x;
                              const nextState = derived ?? x.state;
                              const composed = composeMalaysiaAddress({ lines: x.addressLines, postcode: nextPostcode, city: x.city, state: nextState });
                              return { ...x, postcode: nextPostcode, state: derived ?? x.state, address: composed.address };
                            });
                            set({ ...v, borrowers: nextBorrowers });
                          }}
                          disabled={submitting}
                          inputMode="numeric"
                          placeholder="e.g. 84000"
                        />
                      </div>
                      <div className="md:col-span-4 space-y-1.5">
                        <Label>State</Label>
                        <Select
                          value={b.state}
                          onValueChange={(nextState) => {
                            const key = `borrower:${b.id}`;
                            const derived = b.postcode.length === 5 ? getStateFromPostcode(b.postcode) : null;
                            setPostcodeWarnings((prev) => {
                              const next = { ...prev };
                              if (derived && nextState.trim() && nextState.trim() !== derived) next[key] = `Warning: Postcode ${b.postcode} belongs to ${derived}`;
                              else delete next[key];
                              return next;
                            });
                            const nextBorrowers = v.borrowers.map((x) => {
                              if (x.id !== b.id) return x;
                              const composed = composeMalaysiaAddress({ lines: x.addressLines, postcode: x.postcode, city: x.city, state: nextState });
                              return { ...x, state: nextState, address: composed.address };
                            });
                            set({ ...v, borrowers: nextBorrowers });
                          }}
                          disabled={submitting || Boolean(b.postcode.length === 5 && getStateFromPostcode(b.postcode))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select state" />
                          </SelectTrigger>
                          <SelectContent>
                            {MALAYSIA_STATE_OPTIONS.map((s) => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {postcodeWarnings[`borrower:${b.id}`] ? (
                          <div className="text-xs text-amber-700 mt-1">{postcodeWarnings[`borrower:${b.id}`]}</div>
                        ) : null}
                      </div>
                    </div>
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
                    {v.financingSum.trim() ? (
                      <div className="text-xs text-slate-500">Formatted: {formatRMAmount(v.financingSum)}</div>
                    ) : null}
                  </div>
                  <div className="md:col-span-4 space-y-1.5">
                    <Label>Others (MRTA/Legal Fees)</Label>
                    <Input value={v.othersSum} onChange={(e) => set({ ...v, othersSum: e.target.value })} disabled={submitting} />
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
              <Label>Postcode</Label>
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
                placeholder="e.g. 52100"
              />
            </div>
            <div className="md:col-span-4 space-y-1.5">
              <Label>Daerah</Label>
              <Input value={v.property.daerah} onChange={(e) => set({ ...v, property: { ...v.property, daerah: e.target.value } })} disabled={submitting} />
            </div>
            <div className="md:col-span-4 space-y-1.5">
              <Label>Negeri</Label>
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
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {MALAYSIA_STATE_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {postcodeWarnings["property"] ? (
                <div className="text-xs text-amber-700 mt-1">{postcodeWarnings["property"]}</div>
              ) : null}
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
                <Input value={formatRMAmount(purchasePriceAmount)} readOnly />
              </div>
              <div className="md:col-span-9 space-y-1.5">
                <Label>Purchase Price In Words</Label>
                <Input value={purchasePriceWords} readOnly />
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

