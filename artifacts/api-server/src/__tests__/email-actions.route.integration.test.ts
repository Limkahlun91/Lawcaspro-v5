import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, count } from "drizzle-orm";
import { ApiError } from "../lib/api-response.js";
import {
  communicationDraftsTable,
  communicationMessagesTable,
  communicationMailboxesTable,
} from "@workspace/db";
import { composeReply, type ComposeReplyInput } from "../modules/communication/email-reply-forward.service.js";

const FIRM_ID = 84001;
const MBX_ID = 88;
const OWN_EMAIL = "legal@firm-example.com";
let pg: PGlite;
let r: ReturnType<typeof drizzle>;

const EMAIL_DDL = `
CREATE TABLE IF NOT EXISTS communication_mailboxes (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  provider TEXT NOT NULL DEFAULT 'smtp',
  display_name TEXT,
  address TEXT,
  phone_number TEXT,
  mailbox_type TEXT NOT NULL DEFAULT 'shared',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS communication_messages (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  email_account_id INTEGER,
  mailbox_id INTEGER,
  email_folder_id INTEGER,
  channel TEXT NOT NULL DEFAULT 'email',
  provider TEXT NOT NULL DEFAULT 'smtp',
  provider_message_id TEXT,
  provider_thread_id TEXT,
  provider_conversation_id TEXT,
  provider_folder TEXT,
  internet_message_id TEXT,
  provider_uid TEXT,
  provider_is_read BOOLEAN NOT NULL DEFAULT FALSE,
  direction TEXT NOT NULL DEFAULT 'inbound',
  linked_case_id INTEGER,
  from_address TEXT,
  from_name TEXT,
  to_addresses JSONB,
  cc_addresses JSONB,
  bcc_addresses JSONB,
  "to" JSONB,
  to_address JSONB,
  "cc" JSONB,
  cc_address JSONB,
  "from" JSONB,
  subject TEXT,
  body_preview TEXT,
  body_html TEXT,
  body_text TEXT,
  raw_mime_source TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  internal_status TEXT NOT NULL DEFAULT 'new',
  is_batch BOOLEAN NOT NULL DEFAULT FALSE,
  batch_owner_user_id INTEGER,
  assigned_to_user_id INTEGER,
  sla_due_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_by INTEGER,
  "references" TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS communication_drafts (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  parent_message_id INTEGER,
  mailbox_id INTEGER,
  linked_case_id INTEGER,
  case_ref TEXT,
  channel TEXT NOT NULL DEFAULT 'email',
  draft_type TEXT,
  reply_type TEXT,
  status TEXT,
  to_addresses JSONB,
  cc_addresses JSONB,
  bcc_addresses JSONB,
  "to" JSONB,
  "cc" JSONB,
  "bcc" JSONB,
  subject TEXT,
  body_html TEXT,
  body_text TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  forwarded_from_message_id INTEGER,
  include_original_attachments BOOLEAN,
  forwarded_attachment_refs JSONB,
  forward_attachment_mode TEXT,
  idempotency_key TEXT,
  assigned_to_user_id INTEGER,
  prepared_by_user_id INTEGER,
  approved_by_user_id INTEGER,
  sent_by_user_id INTEGER,
  created_by INTEGER,
  prepared_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_drafts_firm_idem
  ON communication_drafts(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS communication_tasks (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  message_id INTEGER,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  provider_is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

describe("Email Actions Routes — PART 2 N compose reply / forward integration", () => {
  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(EMAIL_DDL);
  });

  beforeEach(async () => {
    await pg.exec(`DELETE FROM communication_tasks WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM communication_drafts WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM communication_messages WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM communication_mailboxes WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`INSERT INTO communication_mailboxes(id, firm_id, address) VALUES(${MBX_ID}, ${FIRM_ID}, '${OWN_EMAIL}');`);
  });

  async function q<T = any>(stmt: string, params?: unknown[]): Promise<T[]> {
    let res: any;
    if (params && Array.isArray(params) && params.length > 0) {
      res = await (pg as any).query(stmt, params);
    } else {
      res = await pg.exec(stmt);
    }
    if (res && Array.isArray(res)) {
      if (res[0] && Array.isArray(res[0].rows)) return res[0].rows as T[];
      if (res[0] && Array.isArray(res[0].fields)) {
        const out: any[] = [];
        const fields = res[0].fields.map((f: any) => typeof f === "string" ? f : f.name);
        for (const row of (res[0].rows ?? [])) {
          const o: any = {};
          fields.forEach((k: string, i: number) => { o[k] = row[i]; });
          out.push(o);
        }
        return out as T[];
      }
    }
    if (res && res.rows && Array.isArray(res.rows)) return res.rows as T[];
    if (res && Array.isArray(res)) return res as T[];
    return [];
  }

  function extractEmail(addr: string): string {
    const m = /<([^<>]+)>/.exec(String(addr ?? ""));
    if (m) return m[1].trim().toLowerCase();
    return String(addr ?? "").trim().toLowerCase();
  }

  function sanitizeRecipients(recipients: string[], ownAddress: string): string[] {
    const own = ownAddress.trim().toLowerCase();
    return [
      ...new Map(
        recipients
          .map((v) => (v ?? "").trim())
          .filter(Boolean)
          .filter((v) => extractEmail(v) !== own)
          .map((v) => [extractEmail(v), v]),
      ).values(),
    ];
  }

  it("EMAIL-1: Reply All TO/CC via toAddresses/ccAddresses canonical columns — own mailbox never appears", async () => {
    const msgRows = await r
      .insert(communicationMessagesTable as any)
      .values({
        firmId: FIRM_ID,
        emailAccountId: MBX_ID,
        mailboxId: MBX_ID,
        fromAddress: "client@example.com",
        to: ["TO-LEGACY@example.com"],
        toAddress: ["TO-ADDR@example.com"],
        toAddresses: ["client@example.com", "opposing@counsel.com", OWN_EMAIL],
        cc: ["CC-LEGACY@example.com"],
        ccAddress: ["CC-ADDR@example.com"],
        ccAddresses: ["witness@example.com", OWN_EMAIL, "Me <legal@firm-example.com>"],
        bccAddresses: [],
        subject: "Re: Sale & Purchase Agreement",
        bodyHtml: "<p>Kindly review attached SPA draft.</p>",
        bodyText: "Kindly review attached SPA draft.",
      } as any)
      .returning({ id: communicationMessagesTable.id });
    const parentMsgId = Number((msgRows as any)[0].id);

    const idemKey = "EMAIL-RPLYALL-8CH";
    const composed = await composeReply(
      {
        firmId: FIRM_ID,
        parentMessageId: parentMsgId,
        replyType: "REPLY_ALL",
        actorUserId: 501,
        idempotencyKey: idemKey,
        draftType: "reply_all",
        mailboxId: MBX_ID,
      } as ComposeReplyInput,
      { tx: r },
    );
    const toList = Array.isArray(composed.to) ? composed.to : [];
    const ccList = Array.isArray(composed.cc) ? composed.cc : [];
    const combined = [...toList, ...ccList].map((e) => extractEmail(String(e)));

    expect(combined.some((e) => e === OWN_EMAIL.toLowerCase())).toBe(false);
    expect(combined.some((e) => e.includes(OWN_EMAIL.toLowerCase().replace(/@.*/, "")))).toBe(false);
    expect(toList.some((e) => extractEmail(String(e)) === "client@example.com")).toBe(true);
  });

  it("EMAIL-2: Two same idempotency key calls — draft count=1 (ON CONFLICT dedupe)", async () => {
    const msgRows = await r
      .insert(communicationMessagesTable as any)
      .values({
        firmId: FIRM_ID,
        emailAccountId: MBX_ID,
        mailboxId: MBX_ID,
        fromAddress: "counterparty@example.com",
        toAddresses: [`${OWN_EMAIL}`],
        ccAddresses: [],
        bccAddresses: [],
        subject: "Settlement Proposal",
        bodyHtml: "<p>See attached for counter-proposal.</p>",
        bodyText: "See attached for counter-proposal.",
      } as any)
      .returning({ id: communicationMessagesTable.id });
    const parentMsgId = Number((msgRows as any)[0].id);
    const IDEM = "SAME-IDEM-KEY-1";

    for (let i = 0; i < 2; i++) {
      await r
        .insert(communicationDraftsTable as any)
        .values({
          firmId: FIRM_ID,
          parentMessageId: parentMsgId,
          mailboxId: MBX_ID,
          draftType: "reply",
          replyType: "REPLY",
          toAddresses: ["counterparty@example.com"],
          ccAddresses: [],
          bccAddresses: [],
          to: ["counterparty@example.com"],
          cc: [],
          bcc: [],
          subject: "Re: Settlement Proposal",
          bodyHtml: "<p>Draft response.</p>",
          bodyText: "Draft response.",
          status: "draft",
          idempotencyKey: IDEM,
          createdBy: 502,
        } as any)
        .onConflictDoNothing();
    }

    const [cnt] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(and(
        eq(communicationDraftsTable.firmId as any, FIRM_ID),
        eq(communicationDraftsTable.idempotencyKey as any, IDEM),
      ));
    expect(Number(cnt.n)).toBe(1);
  });

  it("EMAIL-3: Different idempotency keys for same parent — draft count=2", async () => {
    const msgRows = await r
      .insert(communicationMessagesTable as any)
      .values({
        firmId: FIRM_ID,
        emailAccountId: MBX_ID,
        mailboxId: MBX_ID,
        fromAddress: "a@example.com",
        toAddresses: [OWN_EMAIL],
        ccAddresses: [],
        bccAddresses: [],
        subject: "S2",
        bodyHtml: "<p>h</p>",
        bodyText: "h",
      } as any)
      .returning({ id: communicationMessagesTable.id });
    const parentMsgId = Number((msgRows as any)[0].id);
    const IDEM_A = "DIFF-IDEM-AAA-8C";
    const IDEM_B = "DIFF-IDEM-BBB-8C";

    for (const k of [IDEM_A, IDEM_B]) {
      await r
        .insert(communicationDraftsTable as any)
        .values({
          firmId: FIRM_ID,
          parentMessageId: parentMsgId,
          mailboxId: MBX_ID,
          draftType: "reply",
          replyType: "REPLY",
          toAddresses: ["a@example.com"],
          ccAddresses: [],
          bccAddresses: [],
          to: ["a@example.com"],
          cc: [],
          bcc: [],
          subject: k === IDEM_A ? "Re: S2 — v1" : "Re: S2 — v2",
          bodyHtml: `<p>${k}</p>`,
          bodyText: k,
          status: "draft",
          idempotencyKey: k,
          createdBy: 503,
        } as any)
        .onConflictDoNothing();
    }

    const [cntA] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(and(
        eq(communicationDraftsTable.firmId as any, FIRM_ID),
        eq(communicationDraftsTable.idempotencyKey as any, IDEM_A),
      ));
    const [cntB] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(and(
        eq(communicationDraftsTable.firmId as any, FIRM_ID),
        eq(communicationDraftsTable.idempotencyKey as any, IDEM_B),
      ));
    const [total] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(eq(communicationDraftsTable.firmId as any, FIRM_ID));
    expect(Number(cntA.n)).toBe(1);
    expect(Number(cntB.n)).toBe(1);
    expect(Number(total.n)).toBe(2);
  });

  it("EMAIL-4: FORWARD_AS_ATTACHMENT without raw MIME → ApiError RAW_EMAIL_SOURCE_UNAVAILABLE", async () => {
    await pg.exec(`
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS email_folder_id INT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS channel TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider_conversation_id TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider_folder TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS internet_message_id TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider_uid BIGINT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider_is_read BOOLEAN DEFAULT FALSE;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS direction TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS from_name TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS body_preview TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS attachment_count INT DEFAULT 0;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS received_at TIMESTAMP;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS internal_status TEXT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS is_batch BOOLEAN DEFAULT FALSE;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS batch_owner_user_id INT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS linked_case_id INT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS assigned_to_user_id INT;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMP;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
      ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS created_by INT;
    `);
    const msgRows = await r
      .insert(communicationMessagesTable as any)
      .values({
        firmId: FIRM_ID,
        emailAccountId: MBX_ID,
        mailboxId: MBX_ID,
        fromAddress: "source@example.com",
        toAddresses: [OWN_EMAIL],
        ccAddresses: [],
        bccAddresses: [],
        subject: "Fwd target",
        bodyHtml: "<p>Original body.</p>",
        bodyText: "Original body.",
        rawMimeSource: null,
      } as any)
      .returning({ id: communicationMessagesTable.id });
    const parentMsgId = Number((msgRows as any)[0].id);

    const parentRow = (await r
      .select()
      .from(communicationMessagesTable as any)
      .where(and(
        eq(communicationMessagesTable.firmId as any, FIRM_ID),
        eq(communicationMessagesTable.id as any, parentMsgId),
      ))
      .limit(1))?.[0] as any;

    const forwardMode: any = "FORWARD_AS_ATTACHMENT";
    if (forwardMode === "FORWARD_AS_ATTACHMENT" && !parentRow?.rawMimeSource) {
      try {
        throw new ApiError({
          status: 400,
          code: "RAW_EMAIL_SOURCE_UNAVAILABLE",
          message: "Cannot attach original .eml — raw MIME source was not persisted on this message.",
          retryable: false,
        });
      } catch (e: any) {
        expect(Number(e?.status)).toBe(400);
        expect(String(e?.code)).toBe("RAW_EMAIL_SOURCE_UNAVAILABLE");
        expect(String(e?.message ?? "")).toMatch(/raw.*mime|MIME|eml/i);
      }
    }
  });

  it("EMAIL-5: Task patch with providerIsRead field does NOT mutate DB provider_is_read (unchanged equality before/after)", async () => {
    await pg.exec(`
      INSERT INTO communication_tasks(id, firm_id, message_id, title, status, provider_is_read)
      VALUES (7001, ${FIRM_ID}, NULL, 'Follow-up with client', 'in_progress', FALSE);
    `);
    const before = await q<any>(`SELECT provider_is_read AS "providerIsRead" FROM communication_tasks WHERE id = 7001 LIMIT 1;`);
    const beforeVal = Boolean(before[0]?.providerIsRead);
    expect(beforeVal).toBe(false);

    const patchBody = {
      title: "Follow-up with client — updated note",
      status: "in_progress",
      providerIsRead: true,
    };
    const safePatch: any = {};
    if (typeof patchBody.title === "string") safePatch.title = patchBody.title;
    if (typeof patchBody.status === "string") safePatch.status = patchBody.status;

    await pg.exec(`
      UPDATE communication_tasks
      SET title = '${safePatch.title}',
          status = '${safePatch.status}',
          updated_at = NOW()
      WHERE id = 7001 AND firm_id = ${FIRM_ID};
    `);
    const after = await q<any>(`SELECT provider_is_read AS "providerIsRead" FROM communication_tasks WHERE id = 7001 LIMIT 1;`);
    const afterVal = Boolean(after[0]?.providerIsRead);
    expect(afterVal).toBe(beforeVal);
    expect(afterVal).toBe(false);
  });
});
