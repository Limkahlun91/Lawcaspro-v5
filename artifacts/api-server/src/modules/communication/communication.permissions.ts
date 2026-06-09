import type { AuthRequest } from "../../lib/auth.js";

export function getRoleNameFromReq(req: AuthRequest): string {
  const cached = (req as any)._roleCache as { name?: string } | undefined;
  return String(cached?.name ?? "");
}

export function isPartnerOrAdminRole(roleName: string): boolean {
  const n = roleName.trim().toLowerCase();
  if (!n) return false;
  return n.includes("partner") || n.includes("admin");
}

export function canAcknowledgeTask(args: {
  actorUserId: number;
  roleName: string;
  assignedToUserId: number | null;
  responsibleLawyerId: number | null;
  responsibleClerkId: number | null;
}): boolean {
  if (isPartnerOrAdminRole(args.roleName)) return true;
  if (args.assignedToUserId && args.assignedToUserId === args.actorUserId) return true;
  if (args.responsibleLawyerId && args.responsibleLawyerId === args.actorUserId) return true;
  if (args.responsibleClerkId && args.responsibleClerkId === args.actorUserId) return true;
  return false;
}

export function canMutateTask(args: {
  actorUserId: number;
  roleName: string;
  assignedToUserId: number | null;
  responsibleLawyerId: number | null;
  responsibleClerkId: number | null;
}): boolean {
  if (isPartnerOrAdminRole(args.roleName)) return true;
  if (args.assignedToUserId && args.assignedToUserId === args.actorUserId) return true;
  return false;
}

