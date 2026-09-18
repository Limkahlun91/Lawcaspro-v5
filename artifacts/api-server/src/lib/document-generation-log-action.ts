export type DocGenLogDbAction =
  | "download"
  | "print"
  | "download_zip"
  | "system_print";

export type DocGenLogAction =
  | "download"
  | "print"
  | "DOCUMENT_GENERATION_STARTED"
  | "DOCUMENT_GENERATION_SUCCEEDED"
  | "DOCUMENT_GENERATION_FAILED"
  | "DOCUMENT_GENERATION_PARTIAL"
  | "DOCUMENT_ZIP_CREATED"
  | "DOCUMENT_ZIP_DOWNLOAD_SUCCEEDED"
  | "DOCUMENT_ZIP_DOWNLOAD_FAILED"
  | "DOCUMENT_SYSTEM_PRINT_PREPARED"
  | "DOCUMENT_SYSTEM_PRINT_FAILED";

const DOC_GEN_LOG_ACTION_MAP = {
  download: "download",
  print: "print",
  DOCUMENT_GENERATION_STARTED: "download",
  DOCUMENT_GENERATION_SUCCEEDED: "download",
  DOCUMENT_GENERATION_FAILED: "download",
  DOCUMENT_GENERATION_PARTIAL: "download",
  DOCUMENT_ZIP_CREATED: "download_zip",
  DOCUMENT_ZIP_DOWNLOAD_SUCCEEDED: "download_zip",
  DOCUMENT_ZIP_DOWNLOAD_FAILED: "download_zip",
  DOCUMENT_SYSTEM_PRINT_PREPARED: "system_print",
  DOCUMENT_SYSTEM_PRINT_FAILED: "system_print",
} satisfies Record<DocGenLogAction, DocGenLogDbAction>;

export function normalizeDocGenLogAction(
  action: DocGenLogAction,
): DocGenLogDbAction {
  return DOC_GEN_LOG_ACTION_MAP[action];
}

export const DOC_GEN_LOG_DB_ACTIONS = [
  "download",
  "print",
  "download_zip",
  "system_print",
] as const satisfies ReadonlyArray<DocGenLogDbAction>;
