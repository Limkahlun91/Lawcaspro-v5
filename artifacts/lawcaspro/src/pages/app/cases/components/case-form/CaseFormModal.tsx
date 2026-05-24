import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { CaseForm, createDefaultCaseFormValues } from "./CaseForm";
import type { CaseFormValues, LoanPartyType, PurchaseMode, TitleCategory } from "./types";
import { joinAddressLines } from "./address";

function parseMoneyOrNull(v: string): number | null {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
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
    tel: String(p?.phone ?? ""),
    email: String(p?.email ?? ""),
    addressLines: { line1: "", line2: "", line3: "", line4: "", line5: "" },
    address: String(p?.address ?? ""),
  }));

  const borrowers = Array.isArray((loanDetails as any)?.borrowers) ? (loanDetails as any).borrowers : [];
  const mappedBorrowers = borrowers.length ? borrowers.map((b: any) => ({
    id: crypto.randomUUID(),
    name: String(b?.name ?? ""),
    ic: String(b?.ic ?? ""),
    hp: String(b?.hp ?? ""),
    email: String(b?.email ?? ""),
    addressLines: { line1: "", line2: "", line3: "", line4: "", line5: "" },
    address: String(b?.address ?? ""),
  })) : [v.borrowers[0]];

  return {
    ...v,
    referenceNo: String(caseInfo?.referenceNo ?? ""),
    projectId: String(caseInfo?.projectId ?? ""),
    developerId: String(caseInfo?.developerId ?? ""),
    titleCategory,
    purchaseMode,
    purchasers: mappedPurchasers.length ? mappedPurchasers : v.purchasers,
    loanPartyType: (String(caseInfo?.loanPartyType ?? "") === "3rd_party" ? "3rd_party" : "1st_party") as LoanPartyType,
    borrowers: mappedBorrowers,
    endFinancierBank: String((loanDetails as any)?.endFinancierBank ?? (loanDetails as any)?.end_financier ?? ""),
    bankRef: String((loanDetails as any)?.bankRef ?? ""),
    branch: String((loanDetails as any)?.branch ?? ""),
    financingSum: String((loanDetails as any)?.propertyFinancingSum ?? ""),
    othersSum: String((loanDetails as any)?.othersSum ?? ""),
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
      propertyAddress: String((propertyDetails as any)?.propertyAddress ?? ""),
      propertyAddressLines: { line1: "", line2: "", line3: "", line4: "", line5: "" },
    },
    apdlPrice: String(caseInfo?.apdlPrice ?? ""),
    developerDiscount: String(caseInfo?.developerDiscount ?? ""),
    bumiputraDiscount: String(caseInfo?.bumiputraDiscount ?? ""),
    purchasePrice: String(caseInfo?.spaPrice ?? ""),
  };
}

export function buildCasePayloadFromFormValues(values: CaseFormValues): Record<string, unknown> {
  const purchasers = values.purchasers
    .map((p) => ({
      isCompany: Boolean(p.isCompany),
      name: p.name.trim(),
      ic: p.icOrCompanyNo.trim() ? p.icOrCompanyNo.trim() : null,
      phone: p.tel.trim() ? p.tel.trim() : null,
      email: p.email.trim() ? p.email.trim() : null,
      address: p.address.trim() ? p.address.trim() : joinAddressLines(p.addressLines),
    }))
    .filter((p) => p.name.length > 0);

  const borrowers = values.borrowers
    .map((b) => ({
      name: b.name.trim(),
      ic: b.ic.trim() ? b.ic.trim() : null,
      hp: b.hp.trim() ? b.hp.trim() : null,
      email: b.email.trim() ? b.email.trim() : null,
      address: b.address.trim() ? b.address.trim() : joinAddressLines(b.addressLines),
    }))
    .filter((b) => b.name.length > 0);

  const titleType = values.titleCategory;
  const propertyAddressComposed = (() => {
    const raw = values.property.propertyAddress.trim()
      ? values.property.propertyAddress.trim()
      : joinAddressLines(values.property.propertyAddressLines);
    const v = String(raw ?? "").trim();
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
    propertyAddress: propertyAddressComposed || undefined,
  };

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
    propertyFinancingSum: values.financingSum.trim() || undefined,
    othersSum: values.othersSum.trim() || undefined,
  };

  return {
    projectId: Number(values.projectId),
    developerId: Number(values.developerId),
    referenceNo: values.referenceNo.trim(),
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
}) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [value, setValue] = useState<CaseFormValues>(() => props.initialValues ?? createDefaultCaseFormValues());

  useEffect(() => {
    if (!props.open) return;
    setValue(props.initialValues ?? createDefaultCaseFormValues());
  }, [props.open, props.initialValues]);

  const title = props.title ?? (props.mode === "create" ? "Create Case" : "Edit Case");

  const handleSubmit = async () => {
    if (!value.referenceNo.trim()) {
      toast({ title: "Our File Ref is required", variant: "destructive" });
      return;
    }
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
    if (value.purchasers.filter((p) => p.name.trim().length > 0).length === 0) {
      toast({ title: "At least 1 purchaser is required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await props.onSubmit(buildCasePayloadFromFormValues(value));
      toast({ title: props.mode === "create" ? "Case created" : "Case updated" });
      props.onOpenChange(false);
    } catch (err) {
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
        <CaseForm mode={props.mode} value={value} onChange={setValue} onSubmit={handleSubmit} submitting={submitting} />
      </DialogContent>
    </Dialog>
  );
}
