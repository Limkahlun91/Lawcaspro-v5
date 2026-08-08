import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getHttpStatus, isApiErrorLike } from "@/lib/error-message";
import { calculateLoanAmounts } from "@/lib/loan-amounts";
import { toMoneyNumber } from "@/lib/money";
import { toastError } from "@/lib/toast-error";
import { CaseForm, createDefaultCaseFormValues } from "./CaseForm";
import type { CaseFormValues, CaseType, Encumbrances, LandCondition, LoanPartyType, PerfectionType, PurchaseMode, TitleCategory } from "./types";
import { composeMalaysiaAddress, joinAddressLines, splitAddressToLines } from "./address";
import { getStateFromPostcode } from "@/utils/my-address-helper";
import { useAuth } from "@/lib/auth-context";
import { useQuery } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api-client";

function parseMoneyOrNull(v: string): number | null {
  const normalized = String(v ?? "").trim();
  if (!normalized) return null;

  const n = toMoneyNumber(normalized);
  return Number.isFinite(n) ? n : null;
}

export function mapCaseToFormValues(caseInfo: any): CaseFormValues {
  const v = createDefaultCaseFormValues();
  const propertyDetails = caseInfo?.propertyDetails && typeof caseInfo.propertyDetails === "object" ? caseInfo.propertyDetails : {};
  const loanDetails = caseInfo?.loanDetails && typeof caseInfo.loanDetails === "object" ? caseInfo.loanDetails : {};

  const titleType = String(caseInfo?.titleType ?? "").trim().toLowerCase();
  const titleCategory: TitleCategory = titleType === "strata" ? "strata" : titleType === "individual" ? "individual" : "master";

  const purchaseModeRaw = String(caseInfo?.purchaseMode ?? "").trim().toLowerCase();
  const purchaseMode: PurchaseMode = purchaseModeRaw === "loan" ? "loan" : purchaseModeRaw === "other" ? "other" : "cash";

  const purchasers = Array.isArray(caseInfo?.purchasers) ? caseInfo.purchasers : [];
  const mappedPurchasers = purchasers.map((p: any) => ({
    id: crypto.randomUUID(),
    isCompany: false,
    name: String(p?.clientName ?? ""),
    icOrCompanyNo: String(p?.icNo ?? ""),
    tin: String(p?.tin ?? ""),
    tel: String(p?.phone ?? ""),
    email: String(p?.email ?? ""),
    postcode: (() => {
      const m = String(p?.address ?? "").match(/\b(\d{5})\b/);
      return m ? m[1] : "";
    })(),
    city: "",
    state: (() => {
      const m = String(p?.address ?? "").match(/\b(\d{5})\b/);
      const pc = m ? m[1] : "";
      return pc ? (getStateFromPostcode(pc) ?? "") : "";
    })(),
    addressLines: splitAddressToLines(String(p?.address ?? "")),
    address: String(p?.address ?? ""),
  }));

  const canonicalBorrowers = Array.isArray((caseInfo as any)?.borrowers) ? (caseInfo as any).borrowers : null;
  const loanBorrowers = Array.isArray((loanDetails as any)?.borrowers) ? (loanDetails as any).borrowers : [];
  const borrowers = canonicalBorrowers && canonicalBorrowers.length > 0 ? canonicalBorrowers : loanBorrowers;
  const mappedBorrowers = borrowers.length ? borrowers.map((b: any) => {
    const lines = {
      line1: String(b?.addressLine1 ?? b?.addressLines?.line1 ?? ""),
      line2: String(b?.addressLine2 ?? b?.addressLines?.line2 ?? ""),
      line3: String(b?.addressLine3 ?? b?.addressLines?.line3 ?? ""),
      line4: String(b?.addressLine4 ?? b?.addressLines?.line4 ?? ""),
      line5: String(b?.addressLine5 ?? b?.addressLines?.line5 ?? ""),
    };
    const anyLineNonEmpty = lines.line1 || lines.line2 || lines.line3 || lines.line4 || lines.line5;
    const finalLines = anyLineNonEmpty ? lines : splitAddressToLines(String(b?.address ?? ""));
    return {
      id: crypto.randomUUID(),
      name: String(b?.name ?? ""),
      ic: String(b?.ic ?? ""),
      tin: String(b?.tin ?? ""),
      hp: String(b?.hp ?? b?.phone ?? ""),
      email: String(b?.email ?? ""),
      postcode: String(b?.postcode ?? ""),
      city: String(b?.city ?? ""),
      state: String(b?.state ?? ""),
      addressLines: finalLines,
      addressLine1: finalLines.line1,
      addressLine2: finalLines.line2,
      addressLine3: finalLines.line3,
      addressLine4: finalLines.line4,
      addressLine5: finalLines.line5,
      address: String(b?.address ?? ""),
    };
  }) : [v.borrowers[0]];

  const caseTypeRaw = String(caseInfo?.caseType ?? "").trim().toLowerCase();
  const caseType: CaseType | "" = caseTypeRaw === "subsale" ? "subsale" : caseTypeRaw === "perfection" ? "perfection" : caseTypeRaw === "developer_sales" ? "developer_sales" : "";
  const landConditionRaw = String(caseInfo?.landCondition ?? "").trim().toLowerCase();
  const landCondition: LandCondition | "" = landConditionRaw === "freehold" ? "freehold" : landConditionRaw === "leasehold" ? "leasehold" : "";
  const encumbrancesRaw = String(caseInfo?.encumbrances ?? "").trim().toLowerCase();
  const encumbrances: Encumbrances | "" = encumbrancesRaw === "no_encumbrance" ? "no_encumbrance" : encumbrancesRaw === "has_encumbrance" ? "has_encumbrance" : encumbrancesRaw === "to_confirm" ? "to_confirm" : "";
  const actingForRaw = String(caseInfo?.actingFor ?? "").trim().toLowerCase();
  const actingFor = actingForRaw === "vendor" ? "vendor" : actingForRaw === "purchaser" ? "purchaser" : actingForRaw === "both" ? "both" : "";
  const perfectionTypeRaw = String(caseInfo?.perfectionType ?? "").trim().toLowerCase();
  const perfectionType: PerfectionType | "" = perfectionTypeRaw === "transfer_and_charge" ? "transfer_and_charge" : perfectionTypeRaw === "transfer" ? "transfer" : perfectionTypeRaw === "charge" ? "charge" : "";

  return {
    ...v,
    caseType,
    projectId: String(caseInfo?.projectId ?? ""),
    developerId: String(caseInfo?.developerId ?? ""),
    titleCategory,
    purchaseMode,
    landCondition,
    encumbrances,
    actingFor: actingFor as any,
    perfectionType,
    purchasers: mappedPurchasers.length ? mappedPurchasers : v.purchasers,
    loanPartyType: (String(caseInfo?.loanPartyType ?? "") === "3rd_party" ? "3rd_party" : "1st_party") as LoanPartyType,
    borrowers: mappedBorrowers,
    endFinancierBank: String((loanDetails as any)?.endFinancierBank ?? (loanDetails as any)?.end_financier ?? ""),
    bankRef: String((loanDetails as any)?.bankRef ?? ""),
    branch: String((loanDetails as any)?.branch ?? ""),
    financingSum: String((loanDetails as any)?.propertyFinancingSum ?? ""),
    othersSum: String((loanDetails as any)?.othersText ?? (loanDetails as any)?.othersSum ?? ""),
    branchAddress: "",
    property: {
      ...v.property,
      titleTypeLabel: String((propertyDetails as any)?.titleTypeLabel ?? ""),
      lotNo: String((propertyDetails as any)?.lotNo ?? ""),
      hakmilikNo: String((propertyDetails as any)?.hakmilikNo ?? ""),
      bangunanNo: String((propertyDetails as any)?.bangunanNo ?? ""),
      tingkatNo: String((propertyDetails as any)?.tingkatNo ?? ""),
      petakNo: String((propertyDetails as any)?.petakNo ?? ""),
      accessoryPetakNo: String((propertyDetails as any)?.accessoryPetakNo ?? ""),
      carparkNo: String((propertyDetails as any)?.carparkNo ?? ""),
      carparkLevel: String((propertyDetails as any)?.carparkLevel ?? ""),
      landArea: String((propertyDetails as any)?.landArea ?? ""),
      accessoryArea: String((propertyDetails as any)?.accessoryArea ?? ""),
      parcelNo: String((propertyDetails as any)?.parcelNo ?? ""),
      unitNo: String((propertyDetails as any)?.unitNo ?? ""),
      buildingNo: String((propertyDetails as any)?.buildingNo ?? ""),
      floorNo: String((propertyDetails as any)?.floorNo ?? ""),
      propertyType: String((propertyDetails as any)?.propertyType ?? ""),
      areaSqm: String((propertyDetails as any)?.areaSqm ?? ""),
      bandarMukim: String((propertyDetails as any)?.bandarMukim ?? ""),
      daerah: String((propertyDetails as any)?.daerah ?? ""),
      negeri: String((propertyDetails as any)?.negeri ?? ""),
      postcode: String((propertyDetails as any)?.postcode ?? ""),
      progressPayment: (() => {
        const stored = (propertyDetails as any)?.progressPayment;
        if (stored === null || stored === undefined || stored === "") return "";
        const n = Number(stored);
        return Number.isFinite(n) ? String(n) : String(stored);
      })(),
      propertyAddress: String((propertyDetails as any)?.propertyAddress ?? ""),
      propertyAddressLines: { line1: "", line2: "", line3: "", line4: "", line5: "" },
    },
    apdlPrice: String(caseInfo?.apdlPrice ?? ""),
    developerDiscount: String(caseInfo?.developerDiscount ?? ""),
    bumiputraDiscount: String(caseInfo?.bumiputraDiscount ?? ""),
    purchasePrice: String(caseInfo?.spaPrice ?? ""),
  };
}

export function buildCasePayloadFromFormValues(values: CaseFormValues, opts?: { proposedReferenceNo?: string | null }): Record<string, unknown> {
  const toPositiveIntOrUndefined = (v: string): number | undefined => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };

  const proposedReferenceNo = typeof opts?.proposedReferenceNo === "string" ? opts.proposedReferenceNo.trim() : "";
  const base: Record<string, unknown> = {
    caseType: values.caseType,
    ...(proposedReferenceNo ? { proposedReferenceNo } : {}),
  };

  if (values.caseType === "subsale") {
    return {
      ...base,
      titleType: values.titleCategory || undefined,
      landCondition: values.landCondition || undefined,
      encumbrances: values.encumbrances || undefined,
      actingFor: values.actingFor || undefined,
    };
  }

  if (values.caseType === "perfection") {
    return {
      ...base,
      perfectionType: values.perfectionType || undefined,
    };
  }

  const purchasers = values.purchasers
    .map((p) => ({
      isCompany: Boolean(p.isCompany),
      name: p.name.trim(),
      ic: p.icOrCompanyNo.trim() ? p.icOrCompanyNo.trim() : null,
      tin: p.tin.trim() ? p.tin.trim() : null,
      phone: p.tel.trim() ? p.tel.trim() : null,
      email: p.email.trim() ? p.email.trim() : null,
      address: (() => {
        const composed = joinAddressLines(p.addressLines);
        return (composed.trim() ? composed.trim() : p.address.trim()).trim() || null;
      })(),
    }))
    .filter((p) => p.name.length > 0);

  const borrowers = values.borrowers
    .map((b) => {
      const al = b.addressLines ?? { line1: "", line2: "", line3: "", line4: "", line5: "" };
      const addressLine1 = al.line1?.trim() ?? "";
      const addressLine2 = al.line2?.trim() ?? "";
      const addressLine3 = al.line3?.trim() ?? "";
      const addressLine4 = al.line4?.trim() ?? "";
      const addressLine5 = al.line5?.trim() ?? "";
      const postcode = b.postcode?.trim() ?? "";
      const city = b.city?.trim() ?? "";
      const state = b.state?.trim() ?? "";
      const composed = composeMalaysiaAddress({
        lines: { line1: addressLine1, line2: addressLine2, line3: addressLine3, line4: addressLine4, line5: addressLine5 },
        postcode,
        city,
        state,
      });
      const addressStr = (b.address?.trim() ? b.address.trim() : String(composed.address ?? "").trim()).trim() || null;
      const out: Record<string, unknown> = {
        name: b.name.trim(),
        address: addressStr ?? "",
      };
      if (b.ic.trim()) out.ic = b.ic.trim();
      if (b.tin.trim()) out.tin = b.tin.trim();
      if (b.hp.trim()) { out.hp = b.hp.trim(); out.phone = b.hp.trim(); }
      if (b.email.trim()) out.email = b.email.trim();
      if (addressLine1) out.addressLine1 = addressLine1;
      if (addressLine2) out.addressLine2 = addressLine2;
      if (addressLine3) out.addressLine3 = addressLine3;
      if (addressLine4) out.addressLine4 = addressLine4;
      if (addressLine5) out.addressLine5 = addressLine5;
      if (postcode) out.postcode = postcode;
      if (city) out.city = city;
      if (state) out.state = state;
      return out;
    })
    .filter((b) => (b.name as string).length > 0);

  const titleType = values.titleCategory;
  const propertyAddressComposed = (() => {
    const raw = values.property.propertyAddress.trim();
    if (raw) return raw;
    const composed = composeMalaysiaAddress({
      lines: values.property.propertyAddressLines,
      postcode: values.property.postcode,
      city: values.property.bandarMukim,
      state: values.property.negeri,
    });
    const v = String(composed.address ?? "").trim();
    return v ? v : "";
  })();
  const propertyDetails: Record<string, unknown> = {
    titleCategory: titleType ? (titleType === "master" ? "Master" : titleType === "strata" ? "Strata" : "Individual") : undefined,
    lotNo: values.property.lotNo.trim() || undefined,
    hakmilikNo: values.property.hakmilikNo.trim() || undefined,
    bangunanNo: values.property.bangunanNo.trim() || undefined,
    tingkatNo: values.property.tingkatNo.trim() || undefined,
    petakNo: values.property.petakNo.trim() || undefined,
    accessoryPetakNo: values.property.accessoryPetakNo.trim() || undefined,
    carparkNo: values.property.carparkNo.trim() || undefined,
    carparkLevel: values.property.carparkLevel.trim() || undefined,
    landArea: values.property.landArea.trim() || undefined,
    accessoryArea: values.property.accessoryArea.trim() || undefined,
    parcelNo: values.property.parcelNo.trim() || undefined,
    buildingNo: values.property.buildingNo.trim() || undefined,
    floorNo: values.property.floorNo.trim() || undefined,
    propertyType: values.property.propertyType.trim() || undefined,
    areaSqm: values.property.areaSqm.trim() || undefined,
    bandarMukim: values.property.bandarMukim.trim() || undefined,
    daerah: values.property.daerah.trim() || undefined,
    negeri: values.property.negeri.trim() || undefined,
    postcode: values.property.postcode.trim() || undefined,
    progressPayment: (() => {
      const raw = values.property.progressPayment.trim();
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    })(),
    propertyAddress: propertyAddressComposed || undefined,
  };

  const loanAmounts = calculateLoanAmounts({
    financingSum: values.financingSum,
    others: values.othersSum,
  });
  const rawOthersText = values.othersSum.trim();

  const loanDetails: Record<string, unknown> = {
    loanPartyType: values.loanPartyType === "3rd_party" ? "3rd Party" : "1st Party",
    borrowers,
    endFinancierBank: values.endFinancierBank.trim() || undefined,
    bankRef: values.bankRef.trim() || undefined,
    branch: values.branch.trim() || undefined,
    branchAddressLine1: values.branchAddressLines.line1.trim() || undefined,
    branchAddressLine2: values.branchAddressLines.line2.trim() || undefined,
    branchAddressLine3: values.branchAddressLines.line3.trim() || undefined,
    branchAddressLine4: values.branchAddressLines.line4.trim() || undefined,
    branchAddressLine5: values.branchAddressLines.line5.trim() || undefined,
    propertyFinancingSum: parseMoneyOrNull(values.financingSum) ?? undefined,
    othersSum: loanAmounts.othersTotal > 0 ? loanAmounts.othersTotal : undefined,
    othersText: rawOthersText || undefined,
    totalLoan: loanAmounts.totalLoan > 0 ? loanAmounts.totalLoan : undefined,
    totalLoanWords: loanAmounts.totalLoanWords || undefined,
  };

  return {
    ...base,
    projectId: toPositiveIntOrUndefined(values.projectId),
    developerId: toPositiveIntOrUndefined(values.developerId),
    titleType,
    purchaseMode: values.purchaseMode,
    purchasers,
    loanPartyType: values.loanPartyType,
    borrowers,
    propertyDetails,
    ...(propertyAddressComposed ? { propertyAddress: propertyAddressComposed } : {}),
    loanDetails,
    apdlPrice: parseMoneyOrNull(values.apdlPrice),
    developerDiscount: parseMoneyOrNull(values.developerDiscount),
    bumiputraDiscount: parseMoneyOrNull(values.bumiputraDiscount),
    spaPrice: parseMoneyOrNull(values.purchasePrice),
  };
}

export function CaseFormModal(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  title?: string;
  initialValues?: CaseFormValues;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  showSuccessToast?: boolean;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const roleName = String((user as any)?.roleName ?? "");
  const roleLower = roleName.trim().toLowerCase();
  const canOverrideProjectDerivedFields =
    roleLower.includes("partner")
    || roleLower.includes("manager")
    || roleLower === "account admin"
    || roleLower === "account manager"
    || (roleLower.includes("account") && roleLower.includes("admin"))
    || (roleLower.includes("account") && roleLower.includes("manager"));
  const [submitting, setSubmitting] = useState(false);
  const [value, setValue] = useState<CaseFormValues>(() => props.initialValues ?? createDefaultCaseFormValues());

  const referenceSuggestionParams = useMemo(() => {
    if (!props.open) return null;
    if (props.mode !== "create") return null;
    if (!value.caseType) return null;
    if (value.caseType === "developer_sales") {
      if (!value.projectId || !value.developerId) return null;
    }
    const params = new URLSearchParams();
    params.set("caseType", value.caseType);
    if (value.projectId) params.set("projectId", value.projectId);
    if (value.developerId) params.set("developerId", value.developerId);
    return params;
  }, [props.mode, props.open, value.caseType, value.projectId, value.developerId]);

  const referenceSuggestionQuery = useQuery<{ suggestedReference: string }>({
    queryKey: ["cases", "reference-suggestions", "create", referenceSuggestionParams?.toString() ?? ""],
    enabled: Boolean(referenceSuggestionParams),
    queryFn: async () => {
      const suffix = referenceSuggestionParams?.toString() ? `?${referenceSuggestionParams.toString()}` : "";
      return await apiFetchJson(`/cases/reference-suggestions${suffix}`);
    },
    retry: false,
    staleTime: 30_000,
  });
  const proposedReferenceNo = referenceSuggestionQuery.data?.suggestedReference ?? "";

  useEffect(() => {
    if (!props.open) return;
    setValue(props.initialValues ?? createDefaultCaseFormValues());
  }, [props.open, props.initialValues]);

  const title = props.title ?? (props.mode === "create" ? "Create Case" : "Edit Case");

  const handleSubmit = async () => {
    if (!value.caseType) {
      toast({ title: "Case Type is required", variant: "destructive" });
      return;
    }
    if (value.caseType === "developer_sales") {
      if (!value.projectId) {
        toast({ title: "Project is required", variant: "destructive" });
        return;
      }
      if (!value.developerId) {
        toast({ title: "Developer is required", variant: "destructive" });
        return;
      }
      if (!value.titleCategory) {
        toast({ title: "Title Category is required", variant: "destructive" });
        return;
      }
    } else if (value.caseType === "subsale") {
      if (!value.titleCategory) {
        toast({ title: "Title Category is required", variant: "destructive" });
        return;
      }
      if (!value.landCondition) {
        toast({ title: "Land Condition is required", variant: "destructive" });
        return;
      }
      if (!value.encumbrances) {
        toast({ title: "Encumbrances is required", variant: "destructive" });
        return;
      }
      if (!value.actingFor) {
        toast({ title: "Acting is required", variant: "destructive" });
        return;
      }
    } else if (value.caseType === "perfection") {
      if (!value.perfectionType) {
        toast({ title: "Perfection Type is required", variant: "destructive" });
        return;
      }
    }
    setSubmitting(true);
    try {
      await props.onSubmit(buildCasePayloadFromFormValues(value, { proposedReferenceNo: props.mode === "create" ? proposedReferenceNo : null }));
      if (props.showSuccessToast !== false) {
        toast({ title: props.mode === "create" ? "Open file submitted for approval." : "Case updated" });
      }
      props.onOpenChange(false);
    } catch (err) {
      const status = getHttpStatus(err);
      if (status === 400 && isApiErrorLike(err)) {
        const data = err.data as any;
        const lines: string[] = [];
        if (Array.isArray(data?.errors)) {
          for (const e of data.errors) {
            const path = typeof e?.path === "string" && e.path.trim() ? e.path.trim() : "";
            const msg = typeof e?.message === "string" && e.message.trim() ? e.message.trim() : "";
            if (!path && !msg) continue;
            lines.push(path ? `${path}: ${msg || "Invalid"}` : msg);
          }
        } else if (data?.fields && typeof data.fields === "object") {
          for (const [k, v] of Object.entries(data.fields as Record<string, unknown>)) {
            const arr = Array.isArray(v) ? v : [];
            for (const msg of arr) {
              if (typeof msg === "string" && msg.trim()) lines.push(`${k}: ${msg.trim()}`);
            }
          }
        }
        if (lines.length > 0) {
          toast({
            title: "Validation failed",
            description: lines.join("\n"),
            variant: "destructive",
          });
          return;
        }
      }
      toastError(toast, err, props.mode === "create" ? "Create failed" : "Update failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-[1100px] w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <CaseForm
          mode={props.mode}
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          submitting={submitting}
          canOverrideProjectDerivedFields={canOverrideProjectDerivedFields}
          proposedReferenceNo={props.mode === "create" ? proposedReferenceNo : ""}
        />
      </DialogContent>
    </Dialog>
  );
}
