import { ApiError } from "../../../lib/api-response.js";
import {
  clampPreview,
  htmlToPlainText,
  ImportedMessage,
  mapFolderType,
  parseGraphRecipients,
  parseGraphSender,
  toDateOrNull,
} from "../email-provider-utils.js";

const MICROSOFT_AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const MICROSOFT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MICROSOFT_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "User.Read",
  "Mail.Read",
];

type GraphTokenResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
};

type GraphFolder = {
  providerFolderId: string;
  parentProviderFolderId: string | null;
  displayName: string;
  folderType: string;
};

type GraphFetchWindow = {
  limit: number;
  since?: Date | null;
  until?: Date | null;
};

function readMicrosoftConfig() {
  const clientId = String(process.env.MICROSOFT_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.MICROSOFT_CLIENT_SECRET ?? "").trim();
  const redirectUri = String(process.env.MICROSOFT_REDIRECT_URI ?? "").trim();
  return { clientId, clientSecret, redirectUri };
}

export function getMicrosoftOauthSetupStatus() {
  const { clientId, clientSecret, redirectUri } = readMicrosoftConfig();
  const missing = [
    !clientId ? "MICROSOFT_CLIENT_ID" : null,
    !clientSecret ? "MICROSOFT_CLIENT_SECRET" : null,
    !redirectUri ? "MICROSOFT_REDIRECT_URI" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    configured: missing.length === 0,
    missing,
  };
}

export function ensureMicrosoftOauthConfigured() {
  const { clientId, clientSecret, redirectUri } = readMicrosoftConfig();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new ApiError({
      status: 400,
      code: "MICROSOFT_OAUTH_NOT_CONFIGURED",
      message: "Microsoft 365 connection requires OAuth configuration.",
      suggestion: "Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI.",
    });
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildMicrosoftConnectUrl(state: string): string {
  const { clientId, redirectUri } = ensureMicrosoftOauthConfigured();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state,
    prompt: "select_account",
  });
  return `${MICROSOFT_AUTH_BASE}/authorize?${params.toString()}`;
}

async function fetchGraphJson<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
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
      code: "MICROSOFT_GRAPH_REQUEST_FAILED",
      message: "Microsoft Graph request failed.",
      details: { status: res.status, body: errorText.slice(0, 500) },
    });
  }
  return await res.json() as T;
}

export async function exchangeMicrosoftCodeForTokens(code: string): Promise<GraphTokenResult> {
  const { clientId, clientSecret, redirectUri } = ensureMicrosoftOauthConfigured();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code,
    scope: MICROSOFT_SCOPES.join(" "),
  });
  const res = await fetch(`${MICROSOFT_AUTH_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    throw new ApiError({
      status: 400,
      code: "MICROSOFT_OAUTH_TOKEN_EXCHANGE_FAILED",
      message: "Microsoft OAuth token exchange failed.",
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

export async function refreshMicrosoftAccessToken(refreshToken: string): Promise<GraphTokenResult> {
  const { clientId, clientSecret, redirectUri } = ensureMicrosoftOauthConfigured();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES.join(" "),
  });
  const res = await fetch(`${MICROSOFT_AUTH_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    throw new ApiError({
      status: 400,
      code: "MICROSOFT_OAUTH_REFRESH_FAILED",
      message: "Microsoft access token refresh failed.",
      details: { status: res.status, error: (json as any)?.error ?? null },
    });
  }
  const expiresIn = Number((json as any)?.expires_in ?? 0);
  return {
    accessToken: String((json as any)?.access_token ?? ""),
    refreshToken: String((json as any)?.refresh_token ?? refreshToken).trim() || refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + (expiresIn - 60) * 1000) : null,
  };
}

export async function fetchMicrosoftMailboxProfile(accessToken: string) {
  const profile = await fetchGraphJson<{
    displayName?: string | null;
    mail?: string | null;
    userPrincipalName?: string | null;
  }>(`${MICROSOFT_GRAPH_BASE}/me?$select=displayName,mail,userPrincipalName`, accessToken);

  const emailAddress = String(profile.mail ?? profile.userPrincipalName ?? "").trim();
  if (!emailAddress) {
    throw new ApiError({
      status: 400,
      code: "MICROSOFT_PROFILE_EMAIL_MISSING",
      message: "Microsoft mailbox email address is missing from profile.",
    });
  }

  return {
    emailAddress,
    displayName: String(profile.displayName ?? "").trim() || null,
  };
}

async function fetchMicrosoftFoldersPage(accessToken: string, url: string, results: GraphFolder[]) {
  const json = await fetchGraphJson<{
    value?: Array<{ id?: string; displayName?: string; parentFolderId?: string | null }>;
    "@odata.nextLink"?: string;
  }>(url, accessToken);

  for (const row of json.value ?? []) {
    const providerFolderId = String(row.id ?? "").trim();
    if (!providerFolderId) continue;
    results.push({
      providerFolderId,
      parentProviderFolderId: String(row.parentFolderId ?? "").trim() || null,
      displayName: String(row.displayName ?? "").trim() || providerFolderId,
      folderType: mapFolderType("microsoft_graph", String(row.displayName ?? ""), providerFolderId),
    });
    await fetchMicrosoftFoldersPage(
      accessToken,
      `${MICROSOFT_GRAPH_BASE}/me/mailFolders/${providerFolderId}/childFolders?$top=200&$select=id,displayName,parentFolderId`,
      results,
    );
  }

  if (json["@odata.nextLink"]) {
    await fetchMicrosoftFoldersPage(accessToken, json["@odata.nextLink"], results);
  }
}

export async function fetchMicrosoftFolders(accessToken: string): Promise<GraphFolder[]> {
  const folders: GraphFolder[] = [];
  await fetchMicrosoftFoldersPage(
    accessToken,
    `${MICROSOFT_GRAPH_BASE}/me/mailFolders?$top=200&$select=id,displayName,parentFolderId`,
    folders,
  );
  return folders;
}

async function fetchMicrosoftAttachments(accessToken: string, providerMessageId: string) {
  const json = await fetchGraphJson<{
    value?: Array<{ id?: string; name?: string; contentType?: string | null; size?: number | null }>;
  }>(
    `${MICROSOFT_GRAPH_BASE}/me/messages/${providerMessageId}/attachments?$top=200&$select=id,name,contentType,size`,
    accessToken,
  );
  return (json.value ?? [])
    .map((row) => {
      const filename = String(row.name ?? "").trim();
      if (!filename) return null;
      return {
        providerAttachmentId: String(row.id ?? "").trim() || null,
        filename,
        mimeType: String(row.contentType ?? "").trim() || null,
        sizeBytes: typeof row.size === "number" && Number.isFinite(row.size) ? row.size : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export async function fetchMicrosoftFolderMessages(accessToken: string, providerFolderId: string, window: GraphFetchWindow): Promise<ImportedMessage[]> {
  const out: ImportedMessage[] = [];
  let url = `${MICROSOFT_GRAPH_BASE}/me/mailFolders/${providerFolderId}/messages?$top=50&$orderby=receivedDateTime DESC&$select=id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,isRead,parentFolderId`;
  while (url && out.length < window.limit) {
    const page = await fetchGraphJson<{
      value?: Array<Record<string, unknown>>;
      "@odata.nextLink"?: string;
    }>(url, accessToken);

    for (const item of page.value ?? []) {
      const providerMessageId = String(item.id ?? "").trim();
      if (!providerMessageId) continue;
      const receivedAt = toDateOrNull(String(item.receivedDateTime ?? ""));
      const sentAt = toDateOrNull(String(item.sentDateTime ?? ""));
      const compareAt = receivedAt ?? sentAt;
      if (window.until && compareAt && compareAt.getTime() > window.until.getTime()) {
        continue;
      }
      if (window.since && compareAt && compareAt.getTime() < window.since.getTime()) {
        url = "";
        break;
      }
      const sender = parseGraphSender(item.from);
      const bodyHtml = typeof item.body === "object" && item.body && String((item.body as any).contentType ?? "").toLowerCase() === "html"
        ? String((item.body as any).content ?? "")
        : null;
      const bodyText = bodyHtml ? htmlToPlainText(bodyHtml) : String((item.bodyPreview ?? "")).trim() || null;
      const attachments = item.hasAttachments ? await fetchMicrosoftAttachments(accessToken, providerMessageId) : [];
      out.push({
        provider: "microsoft_graph",
        providerMessageId,
        providerThreadId: String(item.conversationId ?? "").trim() || null,
        providerConversationId: String(item.conversationId ?? "").trim() || null,
        providerFolder: String(item.parentFolderId ?? providerFolderId ?? "").trim() || null,
        internetMessageId: String(item.internetMessageId ?? "").trim() || null,
        providerUid: null,
        providerIsRead: Boolean(item.isRead),
        direction: providerFolderId.toLowerCase() === "sentitems" ? "outgoing" : "incoming",
        fromAddress: sender.address,
        fromName: sender.name,
        toAddresses: parseGraphRecipients(item.toRecipients),
        ccAddresses: parseGraphRecipients(item.ccRecipients),
        bccAddresses: parseGraphRecipients(item.bccRecipients),
        subject: String(item.subject ?? "").trim() || null,
        bodyPreview: clampPreview(String(item.bodyPreview ?? "").trim() || bodyText),
        bodyText,
        bodyHtml,
        receivedAt,
        sentAt,
        attachments,
      });
      if (out.length >= window.limit) break;
    }

    url = out.length >= window.limit ? "" : String(page["@odata.nextLink"] ?? "").trim();
  }
  return out;
}
