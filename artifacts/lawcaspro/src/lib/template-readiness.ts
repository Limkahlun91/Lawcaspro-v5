export type TemplateFileReadinessStatus =
  | "ready"
  | "missing_file"
  | "missing_version"
  | "storage_unavailable"
  | "permission_error"
  | string;

export function isTemplateFileReadinessKnown(status: unknown): status is TemplateFileReadinessStatus {
  return typeof status === "string" && status.trim().length > 0;
}

export function isTemplateFileReady(status: unknown): boolean {
  return typeof status === "string" && status === "ready";
}

export function templateFileReadinessLabel(status: unknown): string {
  if (!isTemplateFileReadinessKnown(status)) return "Checking...";
  if (status === "ready") return "Ready";
  if (status === "missing_file") return "Missing template file";
  if (status === "missing_version") return "Missing published version";
  if (status === "storage_unavailable") return "Storage unavailable";
  if (status === "permission_error") return "Storage permission error";
  return "Incomplete";
}

export function blocksTemplateGenerate(status: unknown): boolean {
  return !isTemplateFileReady(status);
}

