import { ApiError } from "../../../lib/api-response.js";
import {
  clampPreview,
  htmlToPlainText,
  type ImportedAttachmentMetadata,
  type ImportedMessage,
  mapFolderType,
} from "../email-provider-utils.js";

const GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GMAIL_ALL_MAIL_LABEL_ID = "__gmail_all__";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
];

type GoogleTokenResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
};

type GmailLabel = {
  providerFolderId: string;
  parentProviderFolderId: string | null;
  displayName: string;
  folderType: string;
};

type GmailFetchWindow = {
  limit: number;
  since?: Date | null;
  until?: Date | null;
};

function readGoogleConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI ?? "").trim();
  return { clientId, clientSecret, redirectUri };
}

export function getGoogleOauthSetupStatus() {
  const { clientId, clientSecret, redirectUri } = readGoogleConfig();
  const missing = [
    !clientId ? "GOOGLE_CLIENT_ID" : null,
    !clientSecret ? "GOOGLE_CLIENT_SECRET" : null,
    !redirectUri ? "GOOGLE_REDIRECT_URI" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    configured: missing.length === 0,
    missing,
  };
}

export function ensureGoogleOauthConfigured() {
  const { clientId, clientSecret, redirectUri } = readGoogleConfig();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new ApiError({
      status: 400,
      code: "GOOGLE_OAUTH_NOT_CONFIGURED",
      message: "Gmail connection requires OAuth configuration.",
      suggestion: "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
    });
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildGoogleConnectUrl(state: string): string {
  const { clientId, redirectUri } = ensureGoogleOauthConfigured();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES.join(" "),
    state,
  });
  return `${GOOGLE_AUTH_BASE}?${params.toString()}`;
}

async function fetchGoogleJson<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new ApiError({
      status: res.status >= 400 && res.status < 500 ? 400 : 502,
      code: "GOOGLE_GMAIL_REQUEST_FAILED",
      message: "Google Gmail request failed.",
      details: { status: res.status, body: errorText.slice(0, 500) },
    });
  }
  return await res.json() as T;
}

export async function exchangeGoogleCodeForTokens(code: string): Promise<GoogleTokenResult> {
  const { clientId, clientSecret, redirectUri } = ensureGoogleOauthConfigured();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    throw new ApiError({
      status: 400,
      code: "GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED",
      message: "Google OAuth token exchange failed.",
      details: { status: res.status, error: (json as any)?.error ?? null },
    });
  }
  const expiresIn = Number((json as any)?.expires_in ?? 0);
  return {
    accessToken: String((json as any)?.access_token ?? ""),
    refreshToken: String((json as any)?.refresh_token ?? "").trim() || null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + (expiresIn - 60) * 1000) : null,
  };
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<GoogleTokenResult> {
  const { clientId, clientSecret, redirectUri } = ensureGoogleOauthConfigured();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    throw new ApiError({
      status: 400,
      code: "GOOGLE_OAUTH_REFRESH_FAILED",
      message: "Google access token refresh failed.",
      details: { status: res.status, error: (json as any)?.error ?? null },
    });
  }
  const expiresIn = Number((json as any)?.expires_in ?? 0);
  return {
    accessToken: String((json as any)?.access_token ?? ""),
    refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + (expiresIn - 60) * 1000) : null,
  };
}

export async function fetchGoogleMailboxProfile(accessToken: string) {
  const [profile, userInfo] = await Promise.all([
    fetchGoogleJson<{ emailAddress?: string | null }>(`${GOOGLE_GMAIL_BASE}/users/me/profile`, accessToken),
    fetchGoogleJson<{ name?: string | null; email?: string | null }>(GOOGLE_USERINFO_URL, accessToken),
  ]);
  const emailAddress = String(profile.emailAddress ?? userInfo.email ?? "").trim();
  if (!emailAddress) {
    throw new ApiError({
      status: 400,
      code: "GOOGLE_PROFILE_EMAIL_MISSING",
      message: "Gmail mailbox email address is missing from profile.",
    });
  }
  return {
    emailAddress,
    displayName: String(userInfo.name ?? "").trim() || null,
  };
}

export async function fetchGoogleLabels(accessToken: string): Promise<GmailLabel[]> {
  const json = await fetchGoogleJson<{
    labels?: Array<{ id?: string; name?: string; type?: string | null }>;
  }>(`${GOOGLE_GMAIL_BASE}/users/me/labels`, accessToken);
  const labels = (json.labels ?? [])
    .map((row) => {
      const providerFolderId = String(row.id ?? "").trim();
      const displayName = String(row.name ?? "").trim();
      if (!providerFolderId || !displayName) return null;
      return {
        providerFolderId,
        parentProviderFolderId: null,
        displayName,
        folderType: mapFolderType("gmail", displayName, providerFolderId),
      };
    })
    .filter((row): row is GmailLabel => Boolean(row));

  labels.unshift({
    providerFolderId: GMAIL_ALL_MAIL_LABEL_ID,
    parentProviderFolderId: null,
    displayName: "All Mail",
    folderType: mapFolderType("gmail", "All Mail", GMAIL_ALL_MAIL_LABEL_ID),
  });

  return labels;
}

function toGmailQueryDate(value: Date) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function buildGmailSearchQuery(window: GmailFetchWindow) {
  const parts: string[] = [];
  if (window.since) parts.push(`after:${toGmailQueryDate(window.since)}`);
  if (window.until) parts.push(`before:${toGmailQueryDate(window.until)}`);
  return parts.join(" ").trim();
}

function decodeBase64Url(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function extractHeader(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string) {
  const lower = name.toLowerCase();
  return headers?.find((header) => String(header.name ?? "").toLowerCase() === lower)?.value ?? null;
}

function collectPayloadParts(
  payload: Record<string, any> | null | undefined,
  out: {
    textParts: string[];
    htmlParts: string[];
    attachments: ImportedAttachmentMetadata[];
  },
) {
  if (!payload || typeof payload !== "object") return;

  const mimeType = String(payload.mimeType ?? "").toLowerCase();
  const filename = String(payload.filename ?? "").trim();
  const bodyData = decodeBase64Url(payload.body?.data);
  if (mimeType === "text/plain" && bodyData) out.textParts.push(bodyData);
  if (mimeType === "text/html" && bodyData) out.htmlParts.push(bodyData);

  const attachmentId = String(payload.body?.attachmentId ?? "").trim() || null;
  if (filename) {
    out.attachments.push({
      providerAttachmentId: attachmentId,
      filename,
      mimeType: mimeType || null,
      sizeBytes: typeof payload.body?.size === "number" && Number.isFinite(payload.body.size) ? payload.body.size : null,
    });
  }

  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) collectPayloadParts(part, out);
  }
}

async function fetchGmailMessage(accessToken: string, messageId: string, labelId: string): Promise<ImportedMessage> {
  const json = await fetchGoogleJson<Record<string, any>>(
    `${GOOGLE_GMAIL_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    accessToken,
  );

  const headers = Array.isArray(json.payload?.headers) ? json.payload.headers : [];
  const collected = { textParts: [] as string[], htmlParts: [] as string[], attachments: [] as ImportedAttachmentMetadata[] };
  collectPayloadParts(json.payload, collected);
  if (!collected.textParts.length && !collected.htmlParts.length) {
    const fallbackBody = decodeBase64Url(json.payload?.body?.data);
    if (fallbackBody) collected.textParts.push(fallbackBody);
  }

  const bodyHtml = collected.htmlParts.join("\n").trim() || null;
  const bodyTextRaw = collected.textParts.join("\n").trim() || (bodyHtml ? htmlToPlainText(bodyHtml) : null);
  const labelIds = Array.isArray(json.labelIds) ? json.labelIds.map((value) => String(value)) : [];
  const fromHeader = String(extractHeader(headers, "From") ?? "").trim();
  const fromMatch = fromHeader.match(/^(.*)<([^>]+)>/);
  const sentLabel = labelIds.includes("SENT");

  return {
    provider: "gmail",
    providerMessageId: String(json.id ?? messageId).trim() || messageId,
    providerThreadId: String(json.threadId ?? "").trim() || null,
    providerConversationId: String(json.threadId ?? "").trim() || null,
    providerFolder: labelId === GMAIL_ALL_MAIL_LABEL_ID ? "All Mail" : labelId,
    internetMessageId: String(extractHeader(headers, "Message-ID") ?? "").trim() || null,
    providerUid: null,
    providerIsRead: !labelIds.includes("UNREAD"),
    direction: sentLabel ? "outgoing" : "incoming",
    fromAddress: fromMatch ? fromMatch[2].trim() || null : (fromHeader || null),
    fromName: fromMatch ? fromMatch[1].replace(/^"+|"+$/g, "").trim() || null : null,
    toAddresses: String(extractHeader(headers, "To") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    ccAddresses: String(extractHeader(headers, "Cc") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    bccAddresses: [],
    subject: String(extractHeader(headers, "Subject") ?? "").trim() || null,
    bodyPreview: clampPreview(String(json.snippet ?? "").trim() || bodyTextRaw),
    bodyText: bodyHtml ? htmlToPlainText(bodyHtml) : bodyTextRaw,
    bodyHtml,
    receivedAt: typeof json.internalDate === "string" ? new Date(Number(json.internalDate)) : null,
    sentAt: (() => {
      const sentDate = String(extractHeader(headers, "Date") ?? "").trim();
      if (!sentDate) return typeof json.internalDate === "string" ? new Date(Number(json.internalDate)) : null;
      const parsed = new Date(sentDate);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })(),
    attachments: collected.attachments,
  };
}

export async function fetchGoogleLabelMessages(accessToken: string, providerFolderId: string, window: GmailFetchWindow): Promise<ImportedMessage[]> {
  const out: ImportedMessage[] = [];
  let pageToken: string | null = null;
  const query = buildGmailSearchQuery(window);

  while (out.length < window.limit) {
    const params = new URLSearchParams({
      maxResults: String(Math.min(500, window.limit - out.length)),
    });
    if (providerFolderId !== GMAIL_ALL_MAIL_LABEL_ID) params.set("labelIds", providerFolderId);
    if (pageToken) params.set("pageToken", pageToken);
    if (query) params.set("q", query);

    const list = await fetchGoogleJson<{
      messages?: Array<{ id?: string; threadId?: string }>;
      nextPageToken?: string;
    }>(`${GOOGLE_GMAIL_BASE}/users/me/messages?${params.toString()}`, accessToken);

    const messages = list.messages ?? [];
    if (!messages.length) break;

    for (const item of messages) {
      const messageId = String(item.id ?? "").trim();
      if (!messageId) continue;
      out.push(await fetchGmailMessage(accessToken, messageId, providerFolderId));
      if (out.length >= window.limit) break;
    }

    pageToken = String(list.nextPageToken ?? "").trim() || null;
    if (!pageToken) break;
  }

  return out;
}
