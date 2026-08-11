import { eq, and, or } from "drizzle-orm";
import {
  caseLedgersTable,
} from "@workspace/db";

export type ClaimsAccountingEventKind =
  | "CLAIM_APPROVED_PAYABLE"
  | "CLAIM_PAID_RECONCILED";

export function buildClaimsAccountingEventKey(args: {
  kind: ClaimsAccountingEventKind;
  claimId: number | string;
  reversal?: 1;
}): string {
  return args.reversal
    ? `CLM:${args.kind}:${args.claimId}:REVERSAL:${args.reversal}`
    : `CLM:${args.kind}:${args.claimId}`;
}

type DbConnLike = {
  select: (cols: any) => any;
  insert: (t: any) => any;
};

function pickConn(tx: unknown): DbConnLike {
  return tx as DbConnLike;
}

async function lazyAudit(args: {
  firmId: number;
  actorId: number;
  actorType?: "firm_user" | "system" | "founder";
  action: string;
  entityType?: string;
  entityId?: number;
  detail?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  try {
    const mod = await import("../../lib/auth.js");
    if (mod && typeof mod.writeAuditLog === "function") {
      await mod.writeAuditLog(args);
      return;
    }
  } catch {
    // test context without compiled lib/auth.js
  }
}

export async function upsertClaimApprovedPayableLedger(
  tx: unknown,
  args: {
    firmId: number;
    caseId: number | null;
    claimId: number;
    claimantEmployeeId: number | null;
    claimReference: string | null;
    amountCents: number;
    description: string;
    entryDate: Date;
    actorId: number;
    ip?: string;
    ua?: string;
  },
): Promise<{ alreadyLinked: boolean; ledgerId: number | null }> {
  const d = pickConn(tx);
  const eventKey = buildClaimsAccountingEventKey({ kind: "CLAIM_APPROVED_PAYABLE", claimId: args.claimId });
  const amount = (args.amountCents / 100);
  const amountStr = amount.toFixed(2);
  const sourceIdCol: any = caseLedgersTable.sourceId;
  const rows = await d
    .select({ id: caseLedgersTable.id })
    .from(caseLedgersTable)
    .where(or(
      and(eq(caseLedgersTable.firmId, args.firmId), eq(caseLedgersTable.eventKey, eventKey)),
      and(eq(caseLedgersTable.firmId, args.firmId), eq(caseLedgersTable.sourceType, "hr_claim"), eq(sourceIdCol, args.claimId as any)),
    ))
    .limit(1);
  const res = await (typeof rows.execute === "function" ? rows.execute() : rows);
  if (res && res[0]?.id) {
    return { alreadyLinked: true, ledgerId: Number(res[0].id) };
  }
  const insert = d.insert(caseLedgersTable).values({
    firmId: args.firmId,
    caseId: args.caseId ?? undefined,
    entryDate: args.entryDate,
    entryType: "hr_claim_payable",
    description: args.description ?? `Claim #${args.claimId} approved payable`,
    debitCents: 0,
    creditCents: args.amountCents,
    amount: amountStr,
    sourceType: "hr_claim",
    sourceId: args.claimId as any,
    sourceReference: args.claimReference ?? null,
    eventKey,
    createdBy: args.actorId,
  } as any).returning({ id: caseLedgersTable.id });
  const insertedRows = await (typeof insert.execute === "function" ? insert.execute() : insert);
  const id = (insertedRows && insertedRows[0]?.id) ? Number(insertedRows[0].id) : null;
  await lazyAudit({
    firmId: args.firmId,
    actorId: args.actorId,
    actorType: "firm_user",
    action: "hr.claim.approved_accounting_link",
    entityType: "hr_claim",
    entityId: args.claimId,
    detail: JSON.stringify({ eventKey, ledgerId: id, amountCents: args.amountCents, caseId: args.caseId }),
    ipAddress: args.ip,
    userAgent: args.ua,
  });
  return { alreadyLinked: false, ledgerId: id };
}
