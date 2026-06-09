import type { AuthRequest } from "../../lib/auth.js";
import type { DbConn } from "./communication.repository.js";
import { insertCommunicationAuditLog } from "./communication.repository.js";

export async function writeCommunicationAuditLog(args: {
  r: DbConn;
  req: Pick<AuthRequest, "firmId" | "userId" | "ip" | "headers">;
  action: string;
  messageId?: number | null;
  caseTaskId?: number | null;
  draftId?: number | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}) {
  await insertCommunicationAuditLog(args.r, {
    firmId: args.req.firmId!,
    messageId: args.messageId ?? null,
    caseTaskId: args.caseTaskId ?? null,
    draftId: args.draftId ?? null,
    actorUserId: args.req.userId ?? null,
    action: args.action,
    oldValue: args.oldValue ?? null,
    newValue: args.newValue ?? null,
    ipAddress: args.req.ip ?? null,
    userAgent: (args.req.headers as any)?.["user-agent"] ?? null,
  });
}

