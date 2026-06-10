import net from "node:net";
import tls from "node:tls";
import { ApiError } from "../../../lib/api-response.js";
import {
  clampPreview,
  htmlToPlainText,
  ImportedMessage,
  mapFolderType,
  parseEmailAddressList,
  toDateOrNull,
} from "../email-provider-utils.js";

type ImapConnectionConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  useTls: boolean;
};

type ImapFolder = {
  providerFolderId: string;
  parentProviderFolderId: string | null;
  displayName: string;
  folderType: string;
};

class SimpleImapClient {
  private readonly socket: net.Socket | tls.TLSSocket;
  private buffer = Buffer.alloc(0);
  private tagCounter = 0;

  private constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
  }

  static async connect(config: ImapConnectionConfig): Promise<SimpleImapClient> {
    const socket = config.useTls
      ? tls.connect({
          host: config.host,
          port: config.port,
          servername: config.host,
          rejectUnauthorized: true,
        })
      : net.connect({
          host: config.host,
          port: config.port,
        });

    const client = new SimpleImapClient(socket);
    await client.waitForReady();
    await client.runCommand(`LOGIN ${quoteImapAtom(config.username)} ${quoteImapAtom(config.password)}`);
    return client;
  }

  async disconnect(): Promise<void> {
    try {
      await this.runCommand("LOGOUT");
    } catch {
      // Best effort logout only.
    }
    this.socket.destroy();
  }

  async listFolders(): Promise<ImapFolder[]> {
    const raw = await this.runCommand('LIST "" "*"');
    const folders: ImapFolder[] = [];
    const regex = /^\* LIST \(([^)]*)\) (?:"([^"]+)"|NIL) (?:"((?:[^"\\]|\\.)*)"|([^\r\n]+))$/gim;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw))) {
      const attrs = match[1] ?? "";
      const delimiter = match[2] ?? null;
      const name = unescapeImapString((match[3] ?? match[4] ?? "").trim());
      if (!name) continue;
      folders.push({
        providerFolderId: name,
        parentProviderFolderId: delimiter && name.includes(delimiter) ? name.split(delimiter).slice(0, -1).join(delimiter) || null : null,
        displayName: name,
        folderType: mapFolderType("imap", name),
      });
      void attrs;
    }
    return folders;
  }

  async fetchFolderMessages(folderName: string, limit = 50): Promise<ImportedMessage[]> {
    await this.runCommand(`SELECT ${quoteImapAtom(folderName)}`);
    const searchRaw = await this.runCommand("UID SEARCH ALL");
    const searchMatch = searchRaw.match(/^\* SEARCH\s*(.*)$/im);
    if (!searchMatch) return [];
    const uids = searchMatch[1]
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const selectedUids = uids.slice(-limit).reverse();
    const messages: ImportedMessage[] = [];
    for (const uid of selectedUids) {
      const raw = await this.runCommand(`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.4096>)`);
      messages.push(parseFetchedMessage(raw, folderName, uid));
    }
    return messages;
  }

  private async waitForReady(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const text = this.buffer.toString("utf8");
        if (text.includes("\r\n") || text.startsWith("* ")) {
          cleanup();
          resolve();
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new ApiError({
          status: 400,
          code: "IMAP_CONNECTION_FAILED",
          message: "Unable to connect to IMAP server.",
          details: { message: error.message },
        }));
      };
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
      };
      this.socket.on("data", onData);
      this.socket.on("error", onError);
    });
  }

  private async runCommand(command: string): Promise<string> {
    const tag = `A${String(++this.tagCounter).padStart(4, "0")}`;
    const payload = `${tag} ${command}\r\n`;
    this.socket.write(payload);
    return await this.readUntilTagged(tag);
  }

  private async readUntilTagged(tag: string): Promise<string> {
    let pendingLiteralBytes = 0;
    let scanOffset = 0;

    while (true) {
      const done = scanBuffer(this.buffer, tag, pendingLiteralBytes, scanOffset);
      if (done.complete) {
        const raw = this.buffer.slice(0, done.endOffset).toString("utf8");
        this.buffer = this.buffer.slice(done.endOffset);
        if (!done.tagLine.toUpperCase().startsWith(`${tag} OK`)) {
          throw new ApiError({
            status: 400,
            code: "IMAP_COMMAND_FAILED",
            message: `IMAP command failed: ${commandSummary(done.tagLine)}`,
            details: { tagLine: done.tagLine },
          });
        }
        return raw;
      }

      pendingLiteralBytes = done.pendingLiteralBytes;
      scanOffset = done.scanOffset;
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const onData = (value: Buffer) => {
          cleanup();
          resolve(value);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(new ApiError({
            status: 400,
            code: "IMAP_CONNECTION_DROPPED",
            message: "IMAP connection dropped during command.",
            details: { message: error.message },
          }));
        };
        const cleanup = () => {
          this.socket.off("data", onData);
          this.socket.off("error", onError);
        };
        this.socket.on("data", onData);
        this.socket.on("error", onError);
      });
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }
}

function scanBuffer(buffer: Buffer, tag: string, pendingLiteralBytes: number, scanOffset: number) {
  let cursor = scanOffset;
  let pending = pendingLiteralBytes;
  while (cursor < buffer.length) {
    if (pending > 0) {
      if (buffer.length - cursor < pending) {
        return { complete: false as const, pendingLiteralBytes: pending - (buffer.length - cursor), scanOffset: buffer.length };
      }
      cursor += pending;
      pending = 0;
      continue;
    }

    const lineEnd = buffer.indexOf("\r\n", cursor, "utf8");
    if (lineEnd === -1) {
      return { complete: false as const, pendingLiteralBytes: pending, scanOffset: cursor };
    }
    const line = buffer.slice(cursor, lineEnd).toString("utf8");
    cursor = lineEnd + 2;

    const literalMatch = line.match(/\{(\d+)\}$/);
    if (literalMatch) {
      pending = Number.parseInt(literalMatch[1], 10) + 2;
      continue;
    }

    if (line.startsWith(`${tag} `)) {
      return { complete: true as const, endOffset: cursor, tagLine: line };
    }
  }
  return { complete: false as const, pendingLiteralBytes: pending, scanOffset: cursor };
}

function quoteImapAtom(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unescapeImapString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function commandSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_m, _charset, encoding, body) => {
    try {
      if (String(encoding).toUpperCase() === "B") {
        return Buffer.from(String(body), "base64").toString("utf8");
      }
      const normalized = String(body).replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m2, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      return normalized;
    } catch {
      return String(body);
    }
  });
}

function parseHeaderBlock(raw: string): Record<string, string> {
  const lines = raw.replace(/\r\n[ \t]+/g, " ").split(/\r\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = decodeMimeWords(line.slice(idx + 1).trim());
    headers[key] = value;
  }
  return headers;
}

function parseFromHeader(value: string | null | undefined): { name: string | null; address: string | null } {
  const raw = String(value ?? "").trim();
  if (!raw) return { name: null, address: null };
  const angleMatch = raw.match(/^(.*)<([^>]+)>/);
  if (angleMatch) {
    const name = angleMatch[1].replace(/^"+|"+$/g, "").trim() || null;
    return { name, address: angleMatch[2].trim() || null };
  }
  return { name: null, address: raw };
}

function parseAttachmentMetadataFromBodyStructure(raw: string) {
  const attachments: Array<{ providerAttachmentId: string | null; filename: string; mimeType: string | null; sizeBytes: number | null }> = [];
  const regex = /"([^"]+)"\s+"([^"]+)"(?:\s+\([^)]*\))?\s+(?:"[^"]*"|NIL)\s+(?:"[^"]*"|NIL)\s+"(?:BASE64|QUOTED-PRINTABLE|7BIT|8BIT|BINARY)"\s+(\d+)[^)]*(?:\("ATTACHMENT"|"INLINE")[^)]*(?:"FILENAME"\s+"([^"]+)"|"NAME"\s+"([^"]+)")/gim;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw))) {
    const filename = decodeMimeWords(String(match[4] ?? match[5] ?? "").trim());
    if (!filename) continue;
    attachments.push({
      providerAttachmentId: null,
      filename,
      mimeType: `${String(match[1]).toLowerCase()}/${String(match[2]).toLowerCase()}`,
      sizeBytes: Number.parseInt(match[3], 10) || null,
    });
  }
  return attachments;
}

function parseFetchedMessage(raw: string, folderName: string, uid: string): ImportedMessage {
  const headerMatch = raw.match(/BODY\[HEADER\]\s+\{(\d+)\}\r\n([\s\S]*?)\r\n(?:[^\r\n]*BODY\[TEXT\]|A\d+\sOK)/i);
  const textMatch = raw.match(/BODY\[TEXT\](?:<0>)?\s+\{(\d+)\}\r\n([\s\S]*?)\r\nA\d+\sOK/i);
  const bodyStructureMatch = raw.match(/BODYSTRUCTURE\s+([\s\S]*?)BODY\[HEADER\]/i);
  const headers = parseHeaderBlock(headerMatch?.[2] ?? "");
  const from = parseFromHeader(headers["from"]);
  const bodySnippet = decodeMimeWords(String(textMatch?.[2] ?? "").trim());
  const bodyText = bodySnippet ? bodySnippet.replace(/\0/g, "").trim() : null;
  const bodyHtml = headers["content-type"]?.toLowerCase().includes("text/html") ? bodyText : null;
  const previewSource = bodyHtml ? htmlToPlainText(bodyHtml) : bodyText;
  const attachments = parseAttachmentMetadataFromBodyStructure(bodyStructureMatch?.[1] ?? "");
  const seenFlags = raw.toUpperCase();
  return {
    provider: "imap",
    providerMessageId: String(headers["message-id"] ?? "").trim() || null,
    providerThreadId: null,
    providerConversationId: null,
    providerFolder: folderName,
    internetMessageId: String(headers["message-id"] ?? "").trim() || null,
    providerUid: uid,
    providerIsRead: seenFlags.includes("\\SEEN"),
    direction: mapFolderType("imap", folderName) === "sent" ? "outgoing" : "incoming",
    fromAddress: from.address,
    fromName: from.name,
    toAddresses: parseEmailAddressList(headers["to"]),
    ccAddresses: parseEmailAddressList(headers["cc"]),
    bccAddresses: [],
    subject: headers["subject"] ?? null,
    bodyPreview: clampPreview(previewSource),
    bodyText: bodyHtml ? htmlToPlainText(bodyHtml) : bodyText,
    bodyHtml,
    receivedAt: toDateOrNull(headers["date"]),
    sentAt: toDateOrNull(headers["date"]),
    attachments,
  };
}

export async function testImapConnection(config: ImapConnectionConfig) {
  const client = await SimpleImapClient.connect(config);
  try {
    const folders = await client.listFolders();
    return {
      ok: true as const,
      folders,
    };
  } finally {
    await client.disconnect();
  }
}

export async function fetchImapFolders(config: ImapConnectionConfig): Promise<ImapFolder[]> {
  const client = await SimpleImapClient.connect(config);
  try {
    return await client.listFolders();
  } finally {
    await client.disconnect();
  }
}

export async function fetchImapFolderMessages(config: ImapConnectionConfig, folderName: string, limit = 50) {
  const client = await SimpleImapClient.connect(config);
  try {
    return await client.fetchFolderMessages(folderName, limit);
  } finally {
    await client.disconnect();
  }
}
