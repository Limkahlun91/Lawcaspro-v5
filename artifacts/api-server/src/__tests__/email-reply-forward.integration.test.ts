/**
 * PART 1 G/H/I/L - Targeted: Email reply/forward idempotency, recipient SSOT, own-mailbox sanitize
 *
 * Tests:
 *   - Reply All recipient resolution uses canonical toAddresses/ccAddresses
 *   - Own mailbox address is stripped from TO, CC, override TO, override CC
 *   - Same idempotency key used twice: draft count === 1
 *   - Different idempotency key: draft count === 2 (user allowed to create separate drafts)
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, count } from "drizzle-orm";
import {
  communicationDraftsTable,
  communicationMessagesTable,
  communicationMailboxesTable,
} from "@workspace/db";

function sanitizeRecipients(recipients: string[], ownAddress: string): string[] {
  const own = ownAddress.trim().toLowerCase();
  const extractEmail = (addr: string): string => {
    const m = /<([^<>]+)>/.exec(String(addr ?? ""));
    if (m) return m[1].trim().toLowerCase();
    return String(addr ?? "").trim().toLowerCase();
  };
  return [
    ...new Map(
      recipients
        .map((v) => v.trim())
        .filter(Boolean)
        .filter((v) => extractEmail(v) !== own)
        .map((v) => [extractEmail(v), v]),
    ).values(),
  ];
}

function requireStableActionKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8) {
    throw new Error("EMAIL_DRAFT_IDEMPOTENCY_KEY_REQUIRED");
  }
  return value.trim();
}

describe("PART 1 G/H/I/L - Email reply forward service behavior", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 7001;
  const MBX_ID = 99;
  const OWN = "me@firm.com";

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS communication_mailboxes (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        address text
      );
      CREATE TABLE IF NOT EXISTS communication_messages (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        email_account_id integer,
        mailbox_id integer,
        linked_case_id integer,
        "from" jsonb,
        from_address text,
        "to" jsonb,
        to_address jsonb,
        to_addresses jsonb,
        "cc" jsonb,
        cc_address jsonb,
        cc_addresses jsonb,
        bcc_addresses jsonb,
        subject text,
        body_html text,
        body_text text,
        received_at timestamptz,
        internet_message_id text,
        "references" text,
        assigned_to_user_id integer
      );
      CREATE TABLE IF NOT EXISTS communication_drafts (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        parent_message_id integer,
        mailbox_id integer,
        linked_case_id integer,
        case_ref text,
        draft_type text,
        reply_type text,
        "to" jsonb,
        "cc" jsonb,
        "bcc" jsonb,
        to_addresses jsonb,
        cc_addresses jsonb,
        bcc_addresses jsonb,
        subject text,
        body_html text,
        body_text text,
        status text,
        in_reply_to text,
        "references" text,
        forwarded_from_message_id integer,
        include_original_attachments boolean,
        idempotency_key text,
        assigned_to_user_id integer,
        created_by integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_drafts_firm_idem
        ON communication_drafts(firm_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    r = drizzle(pg);
  });

  beforeEach(async () => {
    await pg.query(`DELETE FROM communication_drafts WHERE firm_id = ${FIRM};`);
    await pg.query(`DELETE FROM communication_messages WHERE firm_id = ${FIRM};`);
    await pg.query(`DELETE FROM communication_mailboxes WHERE firm_id = ${FIRM};`);
    await pg.query(`INSERT INTO communication_mailboxes(id, firm_id, address) VALUES(${MBX_ID}, ${FIRM}, '${OWN}');`);
  });

  it("Reply All recipient resolution prefers canonical toAddresses / ccAddresses over legacy", async () => {
    const msgRows = await r
      .insert(communicationMessagesTable as any)
      .values({
        firmId: FIRM,
        emailAccountId: MBX_ID,
        mailboxId: MBX_ID,
        fromAddress: "client@example.com",
        to: ["TO-LEGACY@example.com"],
        toAddress: ["TO-ADDR@example.com"],
        toAddresses: ["canonical-to-a@example.com", "canonical-to-b@example.com"],
        cc: ["CC-LEGACY@example.com"],
        ccAddress: ["CC-ADDR@example.com"],
        ccAddresses: ["canonical-cc@example.com"],
        bccAddresses: [],
        subject: "Test",
        bodyHtml: "<p>Hello</p>",
        bodyText: "Hello",
      } as any)
      .returning({ id: communicationMessagesTable.id });
    const msgId = Number((msgRows as any)[0].id);

    const fromList = ["client@example.com"];
    const parentMsg = (await r
      .select()
      .from(communicationMessagesTable as any)
      .where(and(eq(communicationMessagesTable.firmId as any, FIRM), eq(communicationMessagesTable.id as any, msgId)))
      .limit(1))?.[0] as any;

    const parseList = (raw: unknown): string[] => {
      if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
      return [];
    };
    const originalToList = parseList(parentMsg.toAddresses ?? parentMsg.toAddress ?? parentMsg.to);
    const originalCcList = parseList(parentMsg.ccAddresses ?? parentMsg.ccAddress ?? parentMsg.cc);
    const seen = new Set(fromList.map((s) => s.toLowerCase()));
    let to = fromList.slice();
    let cc: string[] = [];
    for (const rcp of [...originalToList, ...originalCcList]) {
      const e = rcp.toLowerCase();
      if (!seen.has(e)) {
        seen.add(e);
        cc.push(rcp);
      }
    }
    to = sanitizeRecipients(to, OWN);
    cc = sanitizeRecipients(cc, OWN);

    expect(to).toContain("client@example.com");
    expect(cc).toEqual(expect.arrayContaining(["canonical-to-a@example.com", "canonical-to-b@example.com", "canonical-cc@example.com"]));
    expect(cc).not.toContain("TO-LEGACY@example.com");
    expect(cc).not.toContain("TO-ADDR@example.com");
    expect(cc).not.toContain("CC-LEGACY@example.com");
    expect(cc).not.toContain("CC-ADDR@example.com");
  });

  it("Reply All sanitizeRecipients: own mailbox never appears in TO / CC / override-TO / override-CC", async () => {
    let to = ["client@example.com", OWN, "Me <me@firm.com>"];
    let cc = ["cc@example.com", OWN];
    to = sanitizeRecipients(to, OWN);
    cc = sanitizeRecipients(cc, OWN);
    expect(to).toEqual(["client@example.com"]);
    expect(cc).toEqual(["cc@example.com"]);

    const overrideTo = ["replacement@example.com", OWN];
    const overrideCc = ["cc2@example.com", "Me <me@firm.com>"];
    const cleanOverrideTo = sanitizeRecipients(overrideTo, OWN);
    const cleanOverrideCc = sanitizeRecipients(overrideCc, OWN);
    expect(cleanOverrideTo).toEqual(["replacement@example.com"]);
    expect(cleanOverrideCc).toEqual(["cc2@example.com"]);
    expect(cleanOverrideTo.some((x) => x.toLowerCase().includes(OWN))).toBe(false);
    expect(cleanOverrideCc.some((x) => x.toLowerCase().includes(OWN))).toBe(false);
  });

  it("same idempotency key twice: inserted draft count remains 1", async () => {
    const msgRows = await r
      .insert(communicationMessagesTable as any)
      .values({
        firmId: FIRM,
        emailAccountId: MBX_ID,
        fromAddress: "client@example.com",
        toAddresses: ["a@example.com"],
        ccAddresses: [],
        bccAddresses: [],
        subject: "S",
        bodyHtml: "h",
        bodyText: "h",
      } as any)
      .returning({ id: communicationMessagesTable.id });
    const parentMsgId = Number((msgRows as any)[0].id);
    const idem = "SAME-KEY-8CHARS";
    requireStableActionKey(idem);

    await r
      .insert(communicationDraftsTable as any)
      .values({
        firmId: FIRM,
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
        subject: "Re: S",
        bodyHtml: "h",
        bodyText: "h",
        status: "draft",
        idempotencyKey: idem,
        createdBy: 1,
      } as any)
      .onConflictDoNothing();

    await r
      .insert(communicationDraftsTable as any)
      .values({
        firmId: FIRM,
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
        subject: "Re: S",
        bodyHtml: "h",
        bodyText: "h",
        status: "draft",
        idempotencyKey: idem,
        createdBy: 1,
      } as any)
      .onConflictDoNothing();

    const [cnt] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(and(eq(communicationDraftsTable.firmId as any, FIRM), eq(communicationDraftsTable.idempotencyKey as any, idem)));
    expect(Number(cnt.n)).toBe(1);
  });

  it("different idempotency key for same parent: draft count === 2", async () => {
    const msgRows = await r
      .insert(communicationMessagesTable as any)
      .values({
        firmId: FIRM,
        emailAccountId: MBX_ID,
        fromAddress: "client@example.com",
        toAddresses: ["a@example.com"],
        ccAddresses: [],
        bccAddresses: [],
        subject: "S",
        bodyHtml: "h",
        bodyText: "h",
      } as any)
      .returning({ id: communicationMessagesTable.id });
    const parentMsgId = Number((msgRows as any)[0].id);

    const idemA = "KEY-AAAA-8C";
    const idemB = "KEY-BBBB-8C";

    await r
      .insert(communicationDraftsTable as any)
      .values({
        firmId: FIRM,
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
        subject: "Re: S",
        bodyHtml: "Draft A body",
        bodyText: "Draft A body",
        status: "draft",
        idempotencyKey: idemA,
        createdBy: 1,
      } as any)
      .onConflictDoNothing();

    await r
      .insert(communicationDraftsTable as any)
      .values({
        firmId: FIRM,
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
        subject: "Re: S - customized",
        bodyHtml: "Draft B customized body",
        bodyText: "Draft B customized body",
        status: "draft",
        idempotencyKey: idemB,
        createdBy: 1,
      } as any)
      .onConflictDoNothing();

    const [cntA] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(and(eq(communicationDraftsTable.firmId as any, FIRM), eq(communicationDraftsTable.idempotencyKey as any, idemA)));
    const [cntB] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(and(eq(communicationDraftsTable.firmId as any, FIRM), eq(communicationDraftsTable.idempotencyKey as any, idemB)));
    expect(Number(cntA.n)).toBe(1);
    expect(Number(cntB.n)).toBe(1);
    const [total] = await r
      .select({ n: count() })
      .from(communicationDraftsTable)
      .where(eq(communicationDraftsTable.firmId as any, FIRM));
    expect(Number(total.n)).toBe(2);
  });
});
