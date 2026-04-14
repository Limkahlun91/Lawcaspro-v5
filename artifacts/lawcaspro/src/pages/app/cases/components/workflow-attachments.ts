export type WorkflowAttachmentDocKey =
  | "spa_stamped"
  | "lo_stamped"
  | "register_poa"
  | "letter_disclaimer";

export type WorkflowAttachmentDateKey =
  | "spa_stamped_date"
  | "letter_of_offer_stamped_date"
  | "register_poa_on"
  | "letter_disclaimer_dated";

export type WorkflowAttachmentConfigItem = {
  docKey: WorkflowAttachmentDocKey;
  dateKey: WorkflowAttachmentDateKey;
  label: string;
};

export const WORKFLOW_ATTACHMENT_ITEMS: WorkflowAttachmentConfigItem[] = [
  { docKey: "spa_stamped", dateKey: "spa_stamped_date", label: "SPA STAMPED" },
  { docKey: "lo_stamped", dateKey: "letter_of_offer_stamped_date", label: "LO STAMPED" },
  { docKey: "register_poa", dateKey: "register_poa_on", label: "Register POA" },
  { docKey: "letter_disclaimer", dateKey: "letter_disclaimer_dated", label: "Letter Disclaimer" },
];

export const WORKFLOW_ATTACHMENT_ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png";

export function isAllowedWorkflowAttachmentFileName(name: string): boolean {
  const idx = name.lastIndexOf(".");
  const ext = idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
  return ext === "pdf" || ext === "doc" || ext === "docx" || ext === "jpg" || ext === "jpeg" || ext === "png";
}

