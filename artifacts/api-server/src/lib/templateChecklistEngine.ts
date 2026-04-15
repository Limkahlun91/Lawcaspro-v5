export type ChecklistMode = "off" | "advisory" | "required_to_generate" | "required_with_manual_override";
export type ChecklistStatus = "ready" | "warning" | "blocked";
export type ChecklistItemType =
  | "required_case_field"
  | "required_generated_variable"
  | "required_uploaded_document"
  | "required_milestone"
  | "manual_confirmation";

export type TemplateChecklistItemConfig = {
  id: string;
  label: string;
  type: ChecklistItemType;
  required?: boolean;
  message?: string;
  config?: Record<string, unknown>;
};

export type TemplateChecklistResultItem = {
  id: string;
  label: string;
  type: ChecklistItemType;
  passed: boolean;
  required: boolean;
  message: string;
  source: string;
  checkedBy?: number | null;
  checkedAt?: string | null;
};

export type TemplateChecklistResult = {
  checklistStatus: ChecklistStatus;
  totalItems: number;
  passedItems: number;
  missingRequiredItems: number;
  warningItems: number;
  manuallyOverridable: boolean;
  items: TemplateChecklistResultItem[];
};

export function normalizeChecklistMode(v: unknown): ChecklistMode {
  if (v === "advisory") return "advisory";
  if (v === "required_to_generate") return "required_to_generate";
  if (v === "required_with_manual_override") return "required_with_manual_override";
  return "off";
}

export function parseChecklistItems(v: unknown): TemplateChecklistItemConfig[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => Boolean(x))
    .map((x, idx) => ({
      id: typeof x.id === "string" && x.id.trim() ? x.id.trim() : `item_${idx + 1}`,
      label: typeof x.label === "string" && x.label.trim() ? x.label.trim() : `Checklist item ${idx + 1}`,
      type: typeof x.type === "string" ? (x.type as ChecklistItemType) : "required_case_field",
      required: Object.prototype.hasOwnProperty.call(x, "required") ? Boolean(x.required) : true,
      message: typeof x.message === "string" ? x.message : "",
      config: (x.config && typeof x.config === "object") ? (x.config as Record<string, unknown>) : {},
    }))
    .filter((x) => ["required_case_field","required_generated_variable","required_uploaded_document","required_milestone","manual_confirmation"].includes(x.type));
}

export function evaluateTemplateChecklist(params: {
  checklistMode?: unknown;
  checklistItems?: unknown;
  caseContext: Record<string, unknown>;
  resolvedVariables?: Record<string, unknown>;
  uploadedDocuments?: Array<{ fileName?: string | null; documentType?: string | null; checklistKey?: string | null; source?: string | null; hasFile?: boolean }>;
  milestones?: Record<string, { completed: boolean }>;
  manualConfirmations?: Record<string, { checkedBy?: number | null; checkedAt?: string | null; passed: boolean }>;
}): TemplateChecklistResult {
  const mode = normalizeChecklistMode(params.checklistMode);
  const items = parseChecklistItems(params.checklistItems);
  if (mode === "off" || items.length === 0) {
    return {
      checklistStatus: "ready",
      totalItems: items.length,
      passedItems: items.length,
      missingRequiredItems: 0,
      warningItems: 0,
      manuallyOverridable: false,
      items: items.map((it) => ({ id: it.id, label: it.label, type: it.type, passed: true, required: Boolean(it.required), message: "", source: "off" })),
    };
  }

  const ctx = params.caseContext ?? {};
  const vars = params.resolvedVariables ?? {};
  const docs = params.uploadedDocuments ?? [];
  const milestones = params.milestones ?? {};
  const confirms = params.manualConfirmations ?? {};

  const out: TemplateChecklistResultItem[] = [];
  for (const it of items) {
    const required = Boolean(it.required ?? true);
    const cfg = it.config ?? {};
    let passed = true;
    let source = "config";
    let message = it.message || "";
    let checkedBy: number | null | undefined;
    let checkedAt: string | null | undefined;

    if (it.type === "required_case_field") {
      const fieldKey = typeof cfg.fieldKey === "string" ? cfg.fieldKey : "";
      const v = fieldKey ? ctx[fieldKey] : null;
      passed = !(v === null || v === undefined || String(v).trim() === "");
      source = `case.${fieldKey || "unknown"}`;
      if (!passed && !message) message = `Missing case field: ${fieldKey || "unknown"}`;
    } else if (it.type === "required_generated_variable") {
      const variableKey = typeof cfg.variableKey === "string" ? cfg.variableKey : "";
      const v = variableKey ? (vars[variableKey] ?? ctx[variableKey]) : null;
      passed = !(v === null || v === undefined || String(v).trim() === "");
      source = `variable.${variableKey || "unknown"}`;
      if (!passed && !message) message = `Missing generated variable: ${variableKey || "unknown"}`;
    } else if (it.type === "required_uploaded_document") {
      const checklistKey = typeof cfg.checklistKey === "string" ? cfg.checklistKey : "";
      const docType = typeof cfg.documentType === "string" ? cfg.documentType.toLowerCase() : "";
      const fileNameContains = typeof cfg.fileNameContains === "string" ? cfg.fileNameContains.toLowerCase() : "";
      passed = docs.some((d) => {
        if (d.hasFile === false) return false;
        if (checklistKey && String(d.checklistKey ?? "") === checklistKey) return true;
        if (docType && String(d.documentType ?? "").toLowerCase() === docType) return true;
        if (fileNameContains && String(d.fileName ?? "").toLowerCase().includes(fileNameContains)) return true;
        return false;
      });
      source = "uploaded_documents";
      if (!passed && !message) message = "Required uploaded document not found";
    } else if (it.type === "required_milestone") {
      const milestoneKey = typeof cfg.milestoneKey === "string" ? cfg.milestoneKey : "";
      const m = milestoneKey ? milestones[milestoneKey] : null;
      passed = Boolean(m?.completed);
      source = `milestone.${milestoneKey || "unknown"}`;
      if (!passed && !message) message = `Milestone not completed: ${milestoneKey || "unknown"}`;
    } else if (it.type === "manual_confirmation") {
      const c = confirms[it.id];
      passed = Boolean(c?.passed);
      checkedBy = c?.checkedBy ?? null;
      checkedAt = c?.checkedAt ?? null;
      source = "manual_confirmation";
      if (!passed && !message) message = "Manual confirmation required";
    }

    out.push({ id: it.id, label: it.label, type: it.type, passed, required, message, source, checkedBy, checkedAt });
  }

  const totalItems = out.length;
  const passedItems = out.filter((x) => x.passed).length;
  const missingRequiredItems = out.filter((x) => !x.passed && x.required).length;
  const warningItems = out.filter((x) => !x.passed && !x.required).length;
  let checklistStatus: ChecklistStatus = "ready";
  if (mode === "advisory" && (missingRequiredItems > 0 || warningItems > 0)) checklistStatus = "warning";
  if ((mode === "required_to_generate" || mode === "required_with_manual_override") && missingRequiredItems > 0) checklistStatus = "blocked";

  return {
    checklistStatus,
    totalItems,
    passedItems,
    missingRequiredItems,
    warningItems,
    manuallyOverridable: mode === "required_with_manual_override",
    items: out,
  };
}

