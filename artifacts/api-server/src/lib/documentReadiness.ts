import { deriveStatusFromRequirement, WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY } from "./workflowAutomation";
import { computeStampingSummary } from "./stampingProgress";
import type { PurchaseMode, TitleType } from "./documentApplicability";
import type { WorkflowDocumentMilestoneKey } from "./caseWorkflowDocuments";
import type { LoanStampingItemKey, NormalizedTitleType } from "./loanStamping";

export type ReadinessStatus = "ready" | "missing_data" | "missing_file" | "incomplete";

export type MissingItem = {
  code: string;
  message: string;
};

export type TemplateReadinessInputs = {
  purchaseMode: PurchaseMode | null;
  titleType: TitleType | null;
  caseType: string | null;
  referenceNo: string | null;
  projectName: string | null;
  purchaser1Name: string | null;
  purchaser1Ic: string | null;
  loanTotal: string | null;
  loanEndFinancier: string | null;
  keyDates: Record<string, string | null | undefined>;
  workflowDocs: Partial<Record<WorkflowDocumentMilestoneKey, { hasFile: boolean }>>;
  stampingItems: Array<{
    itemKey: LoanStampingItemKey;
    customName: string | null;
    datedOn: string | null;
    stampedOn: string | null;
    hasFile: boolean;
    sortOrder: number;
  }>;
};

export type TemplateReadinessResult = {
  status: ReadinessStatus;
  missing: MissingItem[];
};

function pushMissing(list: MissingItem[], code: string, message: string) {
  list.push({ code, message });
}

export function evaluateTemplateReadiness(params: {
  documentGroup: string;
  input: TemplateReadinessInputs;
}): TemplateReadinessResult {
  const group = (params.documentGroup || "Others").trim();
  const input = params.input;
  const missing: MissingItem[] = [];

  if (!input.referenceNo) pushMissing(missing, "missing_reference_no", "Missing case reference number");
  if (!input.purchaser1Name) pushMissing(missing, "missing_purchaser_name", "Missing purchaser name");
  if (!input.purchaser1Ic) pushMissing(missing, "missing_purchaser_nric", "Missing purchaser NRIC");

  const g = group.toLowerCase();

  if (g.includes("loan")) {
    if (input.purchaseMode === "loan") {
      if (!input.loanEndFinancier) pushMissing(missing, "missing_end_financier", "Missing end financier");
      if (!input.loanTotal) pushMissing(missing, "missing_total_loan", "Missing total loan amount");

      const titleType: NormalizedTitleType = input.titleType ?? null;
      const stampingSummary = computeStampingSummary(titleType, input.stampingItems.map((x) => ({
        id: null,
        itemKey: x.itemKey,
        customName: x.customName,
        datedOn: x.datedOn,
        stampedOn: x.stampedOn,
        hasFile: x.hasFile,
        sortOrder: x.sortOrder,
      })));
      if (stampingSummary.missing.length > 0) {
        for (const m of stampingSummary.missing.slice(0, 10)) {
          pushMissing(missing, `missing_stamping_${m.itemKey}_${m.status}`, `Missing stamping: ${m.itemKey} (${m.status.replace(/_/g, " ")})`);
        }
      }
    }
  }

  if (g.includes("spa")) {
    const spaReq = WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY["spa_stamped"];
    const spaDerived = deriveStatusFromRequirement(spaReq, { keyDates: input.keyDates, workflowDocs: input.workflowDocs as any });
    if (spaDerived !== "completed") {
      if (spaDerived === "missing_date") pushMissing(missing, "missing_spa_stamped_date", "Missing SPA stamped date");
      if (spaDerived === "missing_file") pushMissing(missing, "missing_spa_stamped_file", "Missing SPA stamped file");
      if (spaDerived === "incomplete") {
        pushMissing(missing, "missing_spa_stamped_date", "Missing SPA stamped date");
        pushMissing(missing, "missing_spa_stamped_file", "Missing SPA stamped file");
      }
    }
  }

  if (g.includes("mot") || g.includes("transfer")) {
    if (input.titleType === "strata" || input.titleType === "individual") {
      if (!input.keyDates["mot_received_date"]) pushMissing(missing, "missing_mot_received_date", "Missing MOT received date");
    }
  }

  if (g.includes("completion")) {
    if (!input.keyDates["completion_date"]) pushMissing(missing, "missing_completion_date", "Missing completion date");
  }

  if (g.includes("bank") || g.includes("noa") || g.includes("lu")) {
    const poaReq = WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY["pa_registered"];
    const poaDerived = deriveStatusFromRequirement(poaReq, { keyDates: input.keyDates, workflowDocs: input.workflowDocs as any });
    if (poaDerived !== "completed") {
      if (poaDerived === "missing_date") pushMissing(missing, "missing_register_poa_date", "Missing register POA date");
      if (poaDerived === "missing_file") pushMissing(missing, "missing_register_poa_file", "Missing register POA file");
    }

    const ldReq = WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY["letter_disclaimer"];
    const ldDerived = deriveStatusFromRequirement(ldReq, { keyDates: input.keyDates, workflowDocs: input.workflowDocs as any });
    if (ldDerived !== "completed") {
      if (ldDerived === "missing_date") pushMissing(missing, "missing_letter_disclaimer_date", "Missing letter disclaimer dated");
      if (ldDerived === "missing_file") pushMissing(missing, "missing_letter_disclaimer_file", "Missing letter disclaimer file");
    }
  }

  if (missing.length === 0) return { status: "ready", missing: [] };
  const hasMissingFile = missing.some((m) => m.code.includes("missing_file") || m.code.endsWith("_file"));
  return { status: hasMissingFile ? "missing_file" : "missing_data", missing };
}
