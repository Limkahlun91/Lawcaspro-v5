export const WORKFLOW_DOCUMENT_MILESTONES = {
  spa_stamped: { label: "SPA STAMPED" },
  lo_stamped: { label: "LO STAMPED" },
  register_poa: { label: "Register POA" },
  letter_disclaimer: { label: "Letter Disclaimer" },
} as const;

export type WorkflowDocumentMilestoneKey = keyof typeof WORKFLOW_DOCUMENT_MILESTONES;

export const WORKFLOW_DOCUMENT_ALLOWED_KEYS = new Set<string>(
  Object.keys(WORKFLOW_DOCUMENT_MILESTONES),
);

const LEGACY_KEYS_BY_NEW: Record<WorkflowDocumentMilestoneKey, string[]> = {
  spa_stamped: ["spa_stamped_date"],
  lo_stamped: ["letter_of_offer_stamped_date"],
  register_poa: ["register_poa_on"],
  letter_disclaimer: ["letter_disclaimer_dated", "letter_disclaimer_received_on"],
};

export const CASE_ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "jpg",
  "jpeg",
  "png",
]);

export function workflowDocumentLabel(key: string): string | null {
  const rec = (WORKFLOW_DOCUMENT_MILESTONES as Record<string, { label: string } | undefined>)[key];
  return rec?.label ?? null;
}

export function workflowDocumentLegacyKeys(key: WorkflowDocumentMilestoneKey): string[] {
  return LEGACY_KEYS_BY_NEW[key] ?? [];
}

export function normalizeWorkflowDocumentKeyFromDb(key: string): WorkflowDocumentMilestoneKey | null {
  if (WORKFLOW_DOCUMENT_ALLOWED_KEYS.has(key)) return key as WorkflowDocumentMilestoneKey;
  for (const [newKey, legacyKeys] of Object.entries(LEGACY_KEYS_BY_NEW) as Array<[WorkflowDocumentMilestoneKey, string[]]>) {
    if (legacyKeys.includes(key)) return newKey;
  }
  return null;
}

export function fileExtLower(fileName: string): string {
  const base = fileName.trim();
  const idx = base.lastIndexOf(".");
  if (idx < 0) return "";
  return base.slice(idx + 1).toLowerCase();
}
