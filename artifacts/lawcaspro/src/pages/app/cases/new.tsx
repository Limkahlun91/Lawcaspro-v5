import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getListCasesQueryKey, useListProjects, useListUsers } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Plus, X } from "lucide-react";
import { apiFetchJson } from "@/lib/api-client";

const TABS = ["SPA Details", "Property", "Loan", "Lawyer", "Title", "Company"] as const;
type Tab = typeof TABS[number];

const CASE_TYPES = ["Sub-sale", "Primary Market", "Commercial", "Refinancing", "Transfer", "Other"];
const PROPERTY_TYPES = ["Apartment", "Condominium", "Landed (Terrace)", "Landed (Semi-D)", "Landed (Bungalow)", "Shop", "Office", "Industrial", "Other"];
const PROGRESS_PAYMENTS = ["10%", "15%", "20%", "25%", "30%", "35%", "40%", "45%", "50%", "55%", "60%", "65%", "70%", "75%", "80%", "85%", "90%", "95%", "100%"];
const TITLE_TYPES = ["Master Title", "Individual Title", "Strata Title"];
const MY_STATES = ["Johor", "Kedah", "Kelantan", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Perlis", "Pulau Pinang", "Sabah", "Sarawak", "Selangor", "Terengganu", "Kuala Lumpur", "Putrajaya", "Labuan"];

export default function NewCasePage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: projectsRes } = useListProjects({ limit: 100 });
  const projects = projectsRes?.data || [];
  const { data: usersRes } = useListUsers({ limit: 100 });
  const users = usersRes?.data || [];
  const lawyers = users.filter(u => {
    const role = u.roleName?.trim() || "";
    return ["Partner", "Senior Lawyer", "Lawyer"].includes(role);
  });
  const clerks = users.filter(u => {
    const role = u.roleName?.trim() || "";
    return ["Senior Clerk", "Clerk"].includes(role);
  });

  const [activeTab, setActiveTab] = useState<Tab>("SPA Details");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    project?: string;
    purchaser?: string;
    lawyer?: string;
  }>({});

  // Basic Info
  const [ourReference, setOurReference] = useState("");
  const [projectId, setProjectId] = useState("");
  const [caseType, setCaseType] = useState("");
  const [parcelNo, setParcelNo] = useState("");

  // SPA Details - dynamic purchasers (manual text entry)
  const [purchasers, setPurchasers] = useState<{ name: string; ic: string }[]>([{ name: "", ic: "" }]);
  const [addrLine1, setAddrLine1] = useState("");
  const [addrLine2, setAddrLine2] = useState("");
  const [addrLine3, setAddrLine3] = useState("");
  const [addrLine4, setAddrLine4] = useState("");
  const [addrLine5, setAddrLine5] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [mailingManuallyEdited, setMailingManuallyEdited] = useState(false);
  const [contactNumber, setContactNumber] = useState("");
  const [emailAddress, setEmailAddress] = useState("");

  // Property
  const [floorNo, setFloorNo] = useState("");
  const [propertyType, setPropertyType] = useState("");
  const [areaSqm, setAreaSqm] = useState("");
  const [buildingNo, setBuildingNo] = useState("");
  const [carParkNo, setCarParkNo] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [progressPayment, setProgressPayment] = useState("");
  const [devDiscount, setDevDiscount] = useState("");
  const [bumiDiscount, setBumiDiscount] = useState("");
  const [approvedPrice, setApprovedPrice] = useState("");

  // Loan
  const [purchaseMode, setPurchaseMode] = useState("loan");
  const [borrower1Name, setBorrower1Name] = useState("");
  const [borrower1Ic, setBorrower1Ic] = useState("");
  const [borrower2Name, setBorrower2Name] = useState("");
  const [borrower2Ic, setBorrower2Ic] = useState("");
  const [endFinancier, setEndFinancier] = useState("");
  const [bankRef, setBankRef] = useState("");
  const [bankBranch, setBankBranch] = useState("");
  const [financingSum, setFinancingSum] = useState("");
  const [otherCharges, setOtherCharges] = useState("");
  const [totalLoan, setTotalLoan] = useState("");

  // Lawyer
  const [assignedLawyerId, setAssignedLawyerId] = useState("");
  const [assignedClerkId, setAssignedClerkId] = useState("");
  const [lawyerNric, setLawyerNric] = useState("");
  const [lawyerBcNo, setLawyerBcNo] = useState("");

  // Title
  const [titleType, setTitleType] = useState("Master Title");
  const [titleNo, setTitleNo] = useState("");
  const [lotNo, setLotNo] = useState("");
  const [mukim, setMukim] = useState("");
  const [district, setDistrict] = useState("");
  const [titleState, setTitleState] = useState("");

  // Company
  const [director1Name, setDirector1Name] = useState("");
  const [director1Ic, setDirector1Ic] = useState("");
  const [director2Name, setDirector2Name] = useState("");
  const [director2Ic, setDirector2Ic] = useState("");

  // Auto-fill from selections
  const selectedLawyer = users.find(u => String(u.id) === assignedLawyerId);
  const selectedClerk = users.find(u => String(u.id) === assignedClerkId);
  const selectedProject = projects.find(p => String(p.id) === projectId);
  const developerId = selectedProject?.developerId ? String(selectedProject.developerId) : "";

  // Auto-compute approved purchase price
  useEffect(() => {
    const price = parseFloat(purchasePrice) || 0;
    const dev = parseFloat(devDiscount) || 0;
    const bumi = parseFloat(bumiDiscount) || 0;
    if (price > 0) setApprovedPrice((price - dev - bumi).toFixed(2));
  }, [purchasePrice, devDiscount, bumiDiscount]);

  // Auto-populate mailing address from address lines (unless manually edited)
  useEffect(() => {
    if (mailingManuallyEdited) return;
    const lines = [addrLine1, addrLine2, addrLine3, addrLine4, addrLine5].filter(l => l.trim());
    setMailingAddress(lines.join(", "));
  }, [addrLine1, addrLine2, addrLine3, addrLine4, addrLine5, mailingManuallyEdited]);

  function addPurchaser() {
    setPurchasers(prev => [...prev, { name: "", ic: "" }]);
  }

  function removePurchaser(index: number) {
    setPurchasers(prev => prev.filter((_, i) => i !== index));
  }

  function updatePurchaser(index: number, field: "name" | "ic", value: string) {
    setPurchasers(prev => prev.map((p, i) => i === index ? { ...p, [field]: value } : p));
  }

  const titleTypeApiMap: Record<string, string> = {
    "Master Title": "master",
    "Individual Title": "individual",
    "Strata Title": "strata",
  };

  async function handleSubmit() {
    setFormError(null);

    // Inline field validation — show errors beside each field, navigate to first failing tab
    const nextFieldErrors: { project?: string; purchaser?: string; lawyer?: string } = {};
    if (!projectId) nextFieldErrors.project = "Please select a project";
    if (!purchasers[0]?.name.trim()) nextFieldErrors.purchaser = "At least one purchaser name is required";
    if (!assignedLawyerId) nextFieldErrors.lawyer = "Please assign a lawyer";

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      if (nextFieldErrors.project || nextFieldErrors.purchaser) setActiveTab("SPA Details");
      else if (nextFieldErrors.lawyer) setActiveTab("Lawyer");
      return;
    }
    setFieldErrors({});

    const validPurchasers = purchasers.filter(p => p.name.trim());

    const resolvedClerkId = (assignedClerkId && assignedClerkId !== "__none__")
      ? Number(assignedClerkId)
      : undefined;

    // developerId is intentionally omitted — server derives it from projectId
    const payload = {
      referenceNo: ourReference.trim() || undefined,
      projectId: Number(projectId),
      purchaseMode,
      titleType: titleTypeApiMap[titleType] ?? "master",
      spaPrice: purchasePrice ? Number(purchasePrice) : undefined,
      assignedLawyerId: Number(assignedLawyerId),
      assignedClerkId: resolvedClerkId,
      purchasers: validPurchasers.map(p => ({ name: p.name.trim(), ic: p.ic.trim() || undefined })),
      caseType,
      parcelNo,
      spaDetails: {
        purchasers: validPurchasers,
        addressLine1: addrLine1,
        addressLine2: addrLine2,
        addressLine3: addrLine3,
        addressLine4: addrLine4,
        addressLine5: addrLine5,
        mailingAddress,
        contactNumber,
        emailAddress,
      },
      propertyDetails: {
        parcelNo,
        floorNo,
        propertyType,
        areaSqm,
        buildingNo,
        carParkNo,
        purchasePrice,
        progressPayment,
        devDiscount,
        bumiDiscount,
        approvedPurchasePrice: approvedPrice,
      },
      loanDetails: purchaseMode === "loan" ? {
        borrower1Name,
        borrower1Ic,
        borrower2Name,
        borrower2Ic,
        endFinancier,
        bankRef,
        bankBranch,
        financingSum,
        otherCharges,
        totalLoan,
      } : null,
      titleDetails: {
        titleNo,
        lotNo,
        mukim,
        district,
        state: titleState,
      },
      companyDetails: {
        director1Name,
        director1Ic,
        director2Name,
        director2Ic,
      },
      lawyerDetails: {
        lawyerName: selectedLawyer?.name ?? "",
        lawyerNric,
        lawyerBcNo,
        clerkName: selectedClerk?.name ?? "",
      },
    };

    setIsSubmitting(true);
    try {
      await apiFetchJson("/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      toast({ title: "Case created successfully" });
      navigate("/app/cases");
    } catch (e: unknown) {
      // Extract a user-friendly message from the API error — never show raw JSON
      const apiErr = e as { data?: { error?: string } | null; status?: number } | null;
      const serverMsg = apiErr?.data?.error ?? null;
      const fallback = e instanceof Error
        ? e.message.replace(/^HTTP \d+ \S+: /, "")
        : "Failed to create case";
      setFormError(serverMsg ?? fallback);
    } finally {
      setIsSubmitting(false);
    }
  }

  const currentTabIndex = TABS.indexOf(activeTab);

  return (
    <div className="space-y-6 min-w-0">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => navigate("/app/cases")}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-3"
          >
            ← Back to Cases
          </button>
          <h1 className="text-2xl font-bold text-[#0f1729]">Create New Case</h1>
          <p className="text-sm text-gray-500 mt-1">Enter case details and information</p>
        </div>

        {formError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {formError}
          </div>
        )}

        {Object.keys(fieldErrors).length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
            Please fix the highlighted fields before submitting.
          </div>
        )}

        {/* Basic Information */}
        <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
          <div className="mb-4">
            <h2 className="font-semibold text-[#0f1729] text-sm">Basic Information</h2>
            <p className="text-xs text-gray-500">Case identification and type</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium text-gray-600">Our Reference</Label>
              <Input
                className="h-9 text-sm border-gray-300"
                placeholder="e.g. TAN/CONV/2026/001"
                value={ourReference}
                onChange={(e) => setOurReference(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-gray-600">
                Project <span className="text-red-500">*</span>
              </Label>
              <Select value={projectId} onValueChange={v => { setProjectId(v); setFieldErrors(fe => ({ ...fe, project: undefined })); }}>
                <SelectTrigger className={cn("h-9 text-sm", fieldErrors.project ? "border-red-400 focus:ring-red-300" : "border-gray-300")}>
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldErrors.project && <p className="text-xs text-red-500">{fieldErrors.project}</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-gray-600">Case Type</Label>
              <Select value={caseType} onValueChange={setCaseType}>
                <SelectTrigger className="h-9 text-sm border-gray-300">
                  <SelectValue placeholder="Select case type" />
                </SelectTrigger>
                <SelectContent>
                  {CASE_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-gray-600">Parcel / Unit No.</Label>
              <Input
                className="h-9 text-sm border-gray-300"
                placeholder="Enter parcel/unit number"
                value={parcelNo}
                onChange={e => setParcelNo(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Tabbed Content */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-gray-200 overflow-x-auto">
            {TABS.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "flex-shrink-0 px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  activeTab === tab
                    ? "border-[#f5a623] text-[#f5a623] bg-amber-50/30"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="p-6">

            {/* ──────────── SPA Details ──────────── */}
            {activeTab === "SPA Details" && (
              <div className="space-y-5">
                <div>
                  <h3 className="font-semibold text-sm text-[#0f1729]">SPA Details</h3>
                  <p className="text-xs text-gray-500">Sale and Purchase Agreement information</p>
                </div>

                <div className="space-y-3">
                  {purchasers.map((p, i) => (
                    <div key={i} className="grid grid-cols-2 gap-x-6 gap-y-2 items-end">
                      <div className="space-y-1">
                        <Label className="text-xs font-medium text-gray-600">
                          Purchaser {i + 1} Name {i === 0 && <span className="text-red-500">*</span>}
                        </Label>
                        <Input
                          className={cn("h-9 text-sm", i === 0 && fieldErrors.purchaser ? "border-red-400" : "border-gray-300")}
                          placeholder="Enter purchaser name"
                          value={p.name}
                          onChange={e => {
                            updatePurchaser(i, "name", e.target.value);
                            if (i === 0) setFieldErrors(fe => ({ ...fe, purchaser: undefined }));
                          }}
                        />
                        {i === 0 && fieldErrors.purchaser && <p className="text-xs text-red-500">{fieldErrors.purchaser}</p>}
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="space-y-1 flex-1">
                          <Label className="text-xs font-medium text-gray-600">
                            Purchaser {i + 1} IC / Company No
                          </Label>
                          <Input
                            className="h-9 text-sm border-gray-300"
                            placeholder="Enter IC / Company No"
                            value={p.ic}
                            onChange={e => updatePurchaser(i, "ic", e.target.value)}
                          />
                        </div>
                        {i > 0 && (
                          <button
                            type="button"
                            onClick={() => removePurchaser(i)}
                            className="h-9 w-9 flex items-center justify-center rounded-md border border-gray-300 text-gray-400 hover:text-red-500 hover:border-red-300 transition-colors shrink-0"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addPurchaser}
                    className="flex items-center gap-1.5 text-sm text-[#f5a623] hover:text-[#e09000] font-medium mt-1"
                  >
                    <Plus className="w-4 h-4" />
                    Add Purchaser
                  </button>
                </div>

                {/* Address */}
                <div className="border-t border-gray-100 pt-4 space-y-2">
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide block mb-2">Address</Label>
                  {([
                    [addrLine1, setAddrLine1, "Address Line 1"],
                    [addrLine2, setAddrLine2, "Address Line 2"],
                    [addrLine3, setAddrLine3, "Address Line 3"],
                    [addrLine4, setAddrLine4, "Address Line 4"],
                    [addrLine5, setAddrLine5, "Address Line 5"],
                  ] as [string, (v: string) => void, string][]).map(([val, setter, ph]) => (
                    <Input
                      key={ph}
                      className="h-9 text-sm border-gray-300"
                      placeholder={ph}
                      value={val}
                      onChange={e => setter(e.target.value)}
                    />
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Mailing Address</Label>
                    <Textarea
                      className="text-sm border-gray-300 resize-none"
                      rows={3}
                      placeholder="Auto-filled from address lines above"
                      value={mailingAddress}
                      onChange={e => {
                        setMailingManuallyEdited(true);
                        setMailingAddress(e.target.value);
                      }}
                    />
                    {mailingManuallyEdited && (
                      <button
                        type="button"
                        onClick={() => {
                          setMailingManuallyEdited(false);
                        }}
                        className="text-xs text-[#f5a623] hover:text-[#e09000]"
                      >
                        Reset to auto-fill from address lines
                      </button>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-xs font-medium text-gray-600">Contact Number</Label>
                      <Input className="h-9 text-sm border-gray-300" placeholder="Enter contact number" value={contactNumber} onChange={e => setContactNumber(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-medium text-gray-600">Email Address</Label>
                      <Input className="h-9 text-sm border-gray-300" type="email" placeholder="Enter email address" value={emailAddress} onChange={e => setEmailAddress(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ──────────── Property ──────────── */}
            {activeTab === "Property" && (
              <div className="space-y-5">
                <div>
                  <h3 className="font-semibold text-sm text-[#0f1729]">Property Details</h3>
                  <p className="text-xs text-gray-500">Property information and pricing</p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Parcel / Unit / Lot No</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter parcel/unit/lot number" value={parcelNo} onChange={e => setParcelNo(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Floor No</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter floor number" value={floorNo} onChange={e => setFloorNo(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Property Type</Label>
                    <Select value={propertyType} onValueChange={setPropertyType}>
                      <SelectTrigger className="h-9 text-sm border-gray-300">
                        <SelectValue placeholder="e.g. Apartment, Condo, Landed" />
                      </SelectTrigger>
                      <SelectContent>
                        {PROPERTY_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Area of Parcel (sqm)</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter area in square meters" value={areaSqm} onChange={e => setAreaSqm(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Building No</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter building number" value={buildingNo} onChange={e => setBuildingNo(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Car Park No</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter car park number" value={carParkNo} onChange={e => setCarParkNo(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Purchase Price (RM)</Label>
                    <Input className="h-9 text-sm border-gray-300" type="number" placeholder="Enter purchase price" value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Progress Payment %</Label>
                    <Select value={progressPayment} onValueChange={setProgressPayment}>
                      <SelectTrigger className="h-9 text-sm border-gray-300">
                        <SelectValue placeholder="Select percentage" />
                      </SelectTrigger>
                      <SelectContent>
                        {PROGRESS_PAYMENTS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Developer Discount (RM)</Label>
                    <Input className="h-9 text-sm border-gray-300" type="number" placeholder="Enter developer discount" value={devDiscount} onChange={e => setDevDiscount(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Bumi Discount (RM)</Label>
                    <Input className="h-9 text-sm border-gray-300" type="number" placeholder="Enter bumi discount" value={bumiDiscount} onChange={e => setBumiDiscount(e.target.value)} />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Approved Purchase Price (RM)</Label>
                    <Input
                      className="h-9 text-sm border-gray-300 bg-gray-50"
                      placeholder="Auto-calculated or enter manually"
                      value={approvedPrice}
                      onChange={e => setApprovedPrice(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ──────────── Loan ──────────── */}
            {activeTab === "Loan" && (
              <div className="space-y-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-sm text-[#0f1729]">Loan Details</h3>
                    <p className="text-xs text-gray-500">Financing and loan information</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Label className="text-xs font-medium text-gray-600">Purchase Mode</Label>
                    <div className="flex rounded-md border border-gray-300 overflow-hidden text-sm">
                      {["loan", "cash"].map(m => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setPurchaseMode(m)}
                          className={cn(
                            "px-4 py-1.5 font-medium capitalize transition-colors",
                            purchaseMode === m
                              ? "bg-[#f5a623] text-white"
                              : "bg-white text-gray-600 hover:bg-gray-50"
                          )}
                        >
                          {m === "loan" ? "Loan" : "Cash"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {purchaseMode === "cash" && (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 px-3 py-2 rounded">
                    Choosing "Cash" will disable loan workflow paths.
                  </p>
                )}

                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Borrower 1 Name</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter borrower 1 name" value={borrower1Name} onChange={e => setBorrower1Name(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Borrower 1 IC</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter IC" value={borrower1Ic} onChange={e => setBorrower1Ic(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Borrower 2 Name</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter borrower 2 name" value={borrower2Name} onChange={e => setBorrower2Name(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Borrower 2 IC</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter IC" value={borrower2Ic} onChange={e => setBorrower2Ic(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">End Financier (Bank)</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter bank name" value={endFinancier} onChange={e => setEndFinancier(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Bank Reference</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter bank reference" value={bankRef} onChange={e => setBankRef(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Bank Branch</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter bank branch" value={bankBranch} onChange={e => setBankBranch(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Property Financing Sum (RM)</Label>
                    <Input className="h-9 text-sm border-gray-300" type="number" placeholder="Enter financing amount" value={financingSum} onChange={e => setFinancingSum(e.target.value)} />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Other Charges (MRTA/MRTT/Legal Fees)</Label>
                    <Textarea
                      className="text-sm border-gray-300 resize-none"
                      rows={2}
                      placeholder="e.g. MRTA/MRTT of RM2,111.00 & Legal Fees of RM6,000.00"
                      value={otherCharges}
                      onChange={e => setOtherCharges(e.target.value)}
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Total Loan (RM)</Label>
                    <Input className="h-9 text-sm border-gray-300" type="number" placeholder="Enter total loan amount" value={totalLoan} onChange={e => setTotalLoan(e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            {/* ──────────── Lawyer ──────────── */}
            {activeTab === "Lawyer" && (
              <div className="space-y-5">
                <div>
                  <h3 className="font-semibold text-sm text-[#0f1729]">Lawyer Information</h3>
                  <p className="text-xs text-gray-500">Lawyer in charge of this case</p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">
                      Select Lawyer <span className="text-red-500">*</span>
                    </Label>
                    <Select value={assignedLawyerId} onValueChange={v => { setAssignedLawyerId(v); setFieldErrors(fe => ({ ...fe, lawyer: undefined })); }}>
                      <SelectTrigger className={cn("h-9 text-sm", fieldErrors.lawyer ? "border-red-400" : "border-gray-300")}>
                        <SelectValue placeholder="Choose a lawyer" />
                      </SelectTrigger>
                      <SelectContent>
                        {(lawyers.length > 0 ? lawyers : users).map(l => (
                          <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {fieldErrors.lawyer
                      ? <p className="text-xs text-red-500">{fieldErrors.lawyer}</p>
                      : <p className="text-xs text-gray-400">Select a lawyer to auto-fill their details</p>
                    }
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Select Clerk Person in Charge</Label>
                    <Select value={assignedClerkId} onValueChange={setAssignedClerkId}>
                      <SelectTrigger className="h-9 text-sm border-gray-300">
                        <SelectValue placeholder="Choose a clerk" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {(clerks.length > 0 ? clerks : users).map(c => (
                          <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-400">Select a clerk to auto-fill their name</p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Lawyer Name</Label>
                    <Input
                      className="h-9 text-sm border-gray-300 bg-gray-50"
                      readOnly
                      value={selectedLawyer?.name ?? ""}
                      placeholder="Lawyer name"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Lawyer NRIC</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Lawyer NRIC" value={lawyerNric} onChange={e => setLawyerNric(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Lawyer BC Number</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="BC number" value={lawyerBcNo} onChange={e => setLawyerBcNo(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Clerk Person in Charge Name</Label>
                    <Input
                      className="h-9 text-sm border-gray-300 bg-gray-50"
                      readOnly
                      value={(assignedClerkId && assignedClerkId !== "__none__") ? (selectedClerk?.name ?? "") : ""}
                      placeholder="Clerk name"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ──────────── Title ──────────── */}
            {activeTab === "Title" && (
              <div className="space-y-5">
                <div>
                  <h3 className="font-semibold text-sm text-[#0f1729]">Title Details</h3>
                  <p className="text-xs text-gray-500">Land title and registration information</p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Title Type</Label>
                    <Select value={titleType} onValueChange={setTitleType}>
                      <SelectTrigger className="h-9 text-sm border-gray-300">
                        <SelectValue placeholder="Select title type" />
                      </SelectTrigger>
                      <SelectContent>
                        {TITLE_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Title No</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter title number" value={titleNo} onChange={e => setTitleNo(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Lot No</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter lot number" value={lotNo} onChange={e => setLotNo(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Mukim</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter mukim" value={mukim} onChange={e => setMukim(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">District</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter district" value={district} onChange={e => setDistrict(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">State</Label>
                    <Select value={titleState} onValueChange={setTitleState}>
                      <SelectTrigger className="h-9 text-sm border-gray-300">
                        <SelectValue placeholder="Select state" />
                      </SelectTrigger>
                      <SelectContent>
                        {MY_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}

            {/* ──────────── Company ──────────── */}
            {activeTab === "Company" && (
              <div className="space-y-5">
                <div>
                  <h3 className="font-semibold text-sm text-[#0f1729]">Company Details</h3>
                  <p className="text-xs text-gray-500">If purchaser is a company</p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Director 1 Name</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter director 1 name" value={director1Name} onChange={e => setDirector1Name(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Director 1 IC</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter IC" value={director1Ic} onChange={e => setDirector1Ic(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Director 2 Name</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter director 2 name" value={director2Name} onChange={e => setDirector2Name(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-gray-600">Director 2 IC</Label>
                    <Input className="h-9 text-sm border-gray-300" placeholder="Enter IC" value={director2Ic} onChange={e => setDirector2Ic(e.target.value)} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bottom action bar */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/60">
            <div className="flex gap-2">
              {currentTabIndex > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveTab(TABS[currentTabIndex - 1])}
                >
                  ← Previous
                </Button>
              )}
              {currentTabIndex < TABS.length - 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveTab(TABS[currentTabIndex + 1])}
                >
                  Next →
                </Button>
              )}
            </div>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => navigate("/app/cases")}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="bg-[#f5a623] hover:bg-[#e09000] text-white px-6"
              >
                {isSubmitting ? "Creating..." : "Create Case File"} 
              </Button>
            </div>
          </div>
        </div>
    </div>
  );
}
