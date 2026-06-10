import { ApiError } from "../../lib/api-response.js";

export type ImportedAttachmentMetadata = {
  providerAttachmentId: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
};

export type ImportedMessage = {
  provider: "microsoft_graph" | "imap";
  providerMessageId: string | null;
  providerThreadId: string | null;
  providerConversationId: string | null;
  providerFolder: string | null;
  internetMessageId: string | null;
  providerUid: string | null;
  providerIsRead: boolean;
  direction: "incoming" | "outgoing";
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string | null;
  bodyPreview: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  attachments: ImportedAttachmentMetadata[];
};

export function ensureAbsoluteReturnTo(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.toString();
  } catch {
    throw new ApiError({
      status: 400,
      code: "EMAIL_PROVIDER_RETURN_TO_INVALID",
      message: "returnTo must be a valid absolute URL.",
    });
  }
}

export function htmlToPlainText(input: string | null | undefined): string | null {
  const raw = String(input ?? "");
  if (!raw.trim()) return null;
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim() || null;
}

export function clampPreview(input: string | null | undefined, max = 500): string | null {
  const raw = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return raw.length <= max ? raw : raw.slice(0, max);
}

export function parseEmailAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseGraphRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const emailAddress = (entry as { emailAddress?: { address?: string | null } }).emailAddress;
      return String(emailAddress?.address ?? "").trim() || null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

export function parseGraphSender(value: unknown): { address: string | null; name: string | null } {
  if (!value || typeof value !== "object") return { address: null, name: null };
  const emailAddress = (value as { emailAddress?: { address?: string | null; name?: string | null } }).emailAddress;
  return {
    address: String(emailAddress?.address ?? "").trim() || null,
    name: String(emailAddress?.name ?? "").trim() || null,
  };
}

export function toDateOrNull(value: string | null | undefined): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function mapFolderType(provider: "microsoft_graph" | "imap", folderName: string, providerId?: string | null): string {
  const normalizedName = String(folderName ?? "").trim().toLowerCase();
  const normalizedProviderId = String(providerId ?? "").trim().toLowerCase();
  if (provider === "microsoft_graph") {
    if (normalizedName === "inbox" || normalizedProviderId === "inbox") return "inbox";
    if (normalizedName === "sent items" || normalizedProviderId === "sentitems") return "sent";
    if (normalizedName === "drafts" || normalizedProviderId === "drafts") return "drafts";
    if (normalizedName === "archive" || normalizedProviderId === "archive") return "archive";
    if (normalizedName === "junk email" || normalizedProviderId === "junkemail") return "junk";
    if (normalizedName === "deleted items" || normalizedProviderId === "deleteditems") return "deleted";
    return "custom";
  }

  if (normalizedName === "inbox") return "inbox";
  if (normalizedName.includes("sent")) return "sent";
  if (normalizedName.includes("draft")) return "drafts";
  if (normalizedName.includes("archive")) return "archive";
  if (normalizedName.includes("junk") || normalizedName.includes("spam")) return "junk";
  if (normalizedName.includes("trash") || normalizedName.includes("deleted")) return "deleted";
  return "custom";
}
