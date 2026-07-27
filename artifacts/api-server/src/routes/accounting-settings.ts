import express, { type Response, type Router as ExpressRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { accountingSettingsTable, db, permissionsTable, rolesTable } from "@workspace/db";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import {
  ACCOUNTING_ACTIONS,
  buildRoleTemplate,
  diffPermissions,
  getDefaultAccountingSettings,
  normalizeAccountingSettings,
} from "../modules/accounting/accounting-settings.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const rdb = (req: AuthRequest) => req.rlsDb ?? db;

const AccountingSettingsPatchSchema = z.object({
  accountManagerRoleIds: z.array(z.number().int().positive()).default([]),
  accountAdminRoleIds: z.array(z.number().int().positive()).default([]),
  timezone: z.string().trim().min(1),
  workingHoursStart: z.string().trim().regex(/^\d{2}:\d{2}$/),
  workingHoursEnd: z.string().trim().regex(/^\d{2}:\d{2}$/),
  excludeSaturday: z.boolean().default(true),
  excludeSunday: z.boolean().default(true),
  firmHolidays: z.array(z.object({
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
    label: z.string().trim().min(1).optional(),
  })).default([]),
  approvalRules: z.record(z.string(), z.unknown()).default({}),
  paymentVoucherSla: z.record(z.string(), z.unknown()).default({}),
  clerkActionSla: z.record(z.string(), z.unknown()).default({}),
  paymentProofRequired: z.boolean().default(true),
});

const MANAGED_PERMISSION_KEYS = new Set<string>([
  ...ACCOUNTING_ACTIONS.map((action) => `accounting:${action}`),
  "reports:read",
  "reports:export",
  "audit:read",
]);

async function buildRoleChangePreview(args: {
  req: AuthRequest;
  next: ReturnType<typeof normalizeAccountingSettings>;
}) {
  const r = rdb(args.req);
  const firmId = args.req.firmId!;
  const [existingSettingsRow] = await r
    .select()
    .from(accountingSettingsTable)
    .where(eq(accountingSettingsTable.firmId, firmId))
    .limit(1);
  const existing = normalizeAccountingSettings(firmId, existingSettingsRow as Record<string, unknown> | undefined);
  const previousMappedRoleIds = Array.from(new Set([...existing.accountManagerRoleIds, ...existing.accountAdminRoleIds]));
  const managedRoleIds = Array.from(new Set([...previousMappedRoleIds, ...args.next.accountManagerRoleIds, ...args.next.accountAdminRoleIds]));
  const existingPermissions = managedRoleIds.length > 0
    ? await r.select().from(permissionsTable).where(inArray(permissionsTable.roleId, managedRoleIds))
    : [];
  const permsByRole = new Map<number, typeof existingPermissions>();
  for (const perm of existingPermissions) {
    const list = permsByRole.get(perm.roleId) ?? [];
    list.push(perm);
    permsByRole.set(perm.roleId, list);
  }

  const roleChanges: Array<{ roleId: number; additions: Array<{ module: string; action: string }>; removals: Array<{ module: string; action: string }> }> = [];
  for (const roleId of managedRoleIds) {
    const current = permsByRole.get(roleId) ?? [];
    const template = args.next.accountManagerRoleIds.includes(roleId)
      ? buildRoleTemplate("account_manager", args.next)
      : args.next.accountAdminRoleIds.includes(roleId)
        ? buildRoleTemplate("account_admin", args.next)
        : [];
    const currentManaged = current.filter((perm) => MANAGED_PERMISSION_KEYS.has(`${perm.module}:${perm.action}`));
    const { additions, removals } = diffPermissions(currentManaged, template);
    roleChanges.push({
      roleId,
      additions: additions.map((row) => ({ module: row.module, action: row.action })),
      removals: removals.map((row) => ({ module: row.module, action: row.action })),
    });
  }

  return { existing, hasExistingSettings: Boolean(existingSettingsRow), roleChanges };
}

router.get("/accounting/settings", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const firmId = req.firmId!;
  const [settingsRow] = await r
    .select()
    .from(accountingSettingsTable)
    .where(eq(accountingSettingsTable.firmId, firmId))
    .limit(1);
  const settings = normalizeAccountingSettings(firmId, settingsRow as Record<string, unknown> | undefined);

  const roles = await r.select().from(rolesTable).where(eq(rolesTable.firmId, firmId));
  const roleIds = roles.map((role) => role.id);
  const permissions = roleIds.length > 0
    ? await r.select().from(permissionsTable).where(inArray(permissionsTable.roleId, roleIds))
    : [];
  const permsByRole = new Map<number, Array<{ module: string; action: string; allowed: boolean }>>();
  for (const perm of permissions) {
    const list = permsByRole.get(perm.roleId) ?? [];
    list.push({ module: perm.module, action: perm.action, allowed: perm.allowed });
    permsByRole.set(perm.roleId, list);
  }
  const roleSummaries = roles.map((role) => {
    const rolePerms = permsByRole.get(role.id) ?? [];
    const hasAccountingPermission = rolePerms.some((perm) => perm.allowed && perm.module === "accounting");
    return {
      id: role.id,
      name: role.name,
      isSystemRole: role.isSystemRole,
      permissions: rolePerms,
      suggestedAccountingRole: hasAccountingPermission,
      mappedKind: settings.accountManagerRoleIds.includes(role.id)
        ? "account_manager"
        : settings.accountAdminRoleIds.includes(role.id)
          ? "account_admin"
          : null,
    };
  });

  res.json({
    settings,
    roles: roleSummaries,
    suggestedRoleIds: roleSummaries.filter((role) => role.suggestedAccountingRole).map((role) => role.id),
    defaults: getDefaultAccountingSettings(firmId),
  });
});

router.post("/accounting/settings/preview", requireAuth, requireFirmUser, requirePermission("accounting", "manage_settings"), async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = AccountingSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const firmId = req.firmId!;
  const next = normalizeAccountingSettings(firmId, parsed.data);
  const overlap = next.accountManagerRoleIds.filter((id) => next.accountAdminRoleIds.includes(id));
  if (overlap.length > 0) {
    res.status(400).json({ error: "A role cannot be both Account Manager and Account Admin" });
    return;
  }
  const roleIds = Array.from(new Set([...next.accountManagerRoleIds, ...next.accountAdminRoleIds]));
  const roles = roleIds.length > 0
    ? await rdb(req).select().from(rolesTable).where(and(eq(rolesTable.firmId, firmId), inArray(rolesTable.id, roleIds)))
    : [];
  if (roles.length !== roleIds.length) {
    res.status(400).json({ error: "One or more roles are invalid for this firm" });
    return;
  }
  const preview = await buildRoleChangePreview({ req, next });
  res.json({
    settings: next,
    existingSettings: preview.existing,
    roleChanges: preview.roleChanges,
  });
});

router.patch("/accounting/settings", requireAuth, requireFirmUser, requirePermission("accounting", "manage_settings"), async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = AccountingSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const firmId = req.firmId!;
  const next = normalizeAccountingSettings(firmId, parsed.data);
  const overlap = next.accountManagerRoleIds.filter((id) => next.accountAdminRoleIds.includes(id));
  if (overlap.length > 0) {
    res.status(400).json({ error: "A role cannot be both Account Manager and Account Admin" });
    return;
  }

  const r = rdb(req);
  const roleIds = Array.from(new Set([...next.accountManagerRoleIds, ...next.accountAdminRoleIds]));
  const roles = roleIds.length > 0
    ? await r.select().from(rolesTable).where(and(eq(rolesTable.firmId, firmId), inArray(rolesTable.id, roleIds)))
    : [];
  if (roles.length !== roleIds.length) {
    res.status(400).json({ error: "One or more roles are invalid for this firm" });
    return;
  }

  const preview = await buildRoleChangePreview({ req, next });
  const result = await r.transaction(async (tx) => {
    const previousMappedRoleIds = Array.from(new Set([...preview.existing.accountManagerRoleIds, ...preview.existing.accountAdminRoleIds]));
    const managedRoleIds = Array.from(new Set([...previousMappedRoleIds, ...next.accountManagerRoleIds, ...next.accountAdminRoleIds]));
    const existingPermissions = managedRoleIds.length > 0
      ? await tx.select().from(permissionsTable).where(inArray(permissionsTable.roleId, managedRoleIds))
      : [];
    const permsByRole = new Map<number, typeof existingPermissions>();
    for (const perm of existingPermissions) {
      const list = permsByRole.get(perm.roleId) ?? [];
      list.push(perm);
      permsByRole.set(perm.roleId, list);
    }

    for (const roleId of managedRoleIds) {
      const current = permsByRole.get(roleId) ?? [];
      const template = next.accountManagerRoleIds.includes(roleId)
        ? buildRoleTemplate("account_manager", next)
        : next.accountAdminRoleIds.includes(roleId)
          ? buildRoleTemplate("account_admin", next)
          : [];
      const currentManaged = current.filter((perm) => MANAGED_PERMISSION_KEYS.has(`${perm.module}:${perm.action}`));

      const keepKeys = new Set(template.filter((row) => row.allowed).map((row) => `${row.module}:${row.action}`));
      for (const perm of currentManaged) {
        const key = `${perm.module}:${perm.action}`;
        if (keepKeys.has(key)) {
          if (!perm.allowed) {
            await tx.update(permissionsTable).set({ allowed: true }).where(eq(permissionsTable.id, perm.id));
          }
          continue;
        }
        await tx.delete(permissionsTable).where(eq(permissionsTable.id, perm.id));
      }
      for (const row of template.filter((item) => item.allowed)) {
        const key = `${row.module}:${row.action}`;
        const existingPerm = currentManaged.find((perm) => `${perm.module}:${perm.action}` === key);
        if (existingPerm) {
          if (!existingPerm.allowed) {
            await tx.update(permissionsTable).set({ allowed: true }).where(eq(permissionsTable.id, existingPerm.id));
          }
        } else {
          await tx.insert(permissionsTable).values({ roleId, module: row.module, action: row.action, allowed: true });
        }
      }
    }

    if (preview.hasExistingSettings) {
      await tx
        .update(accountingSettingsTable)
        .set({
          accountManagerRoleIds: next.accountManagerRoleIds,
          accountAdminRoleIds: next.accountAdminRoleIds,
          timezone: next.timezone,
          workingHoursStart: next.workingHoursStart,
          workingHoursEnd: next.workingHoursEnd,
          excludeSaturday: next.excludeSaturday,
          excludeSunday: next.excludeSunday,
          firmHolidays: next.firmHolidays,
          approvalRules: next.approvalRules,
          paymentVoucherSla: next.paymentVoucherSla,
          clerkActionSla: next.clerkActionSla,
          paymentProofRequired: next.paymentProofRequired,
          updatedBy: req.userId!,
          updatedAt: new Date(),
        })
        .where(eq(accountingSettingsTable.firmId, firmId));
    } else {
      await tx.insert(accountingSettingsTable).values({
        firmId,
        accountManagerRoleIds: next.accountManagerRoleIds,
        accountAdminRoleIds: next.accountAdminRoleIds,
        timezone: next.timezone,
        workingHoursStart: next.workingHoursStart,
        workingHoursEnd: next.workingHoursEnd,
        excludeSaturday: next.excludeSaturday,
        excludeSunday: next.excludeSunday,
        firmHolidays: next.firmHolidays,
        approvalRules: next.approvalRules,
        paymentVoucherSla: next.paymentVoucherSla,
        clerkActionSla: next.clerkActionSla,
        paymentProofRequired: next.paymentProofRequired,
        createdBy: req.userId!,
        updatedBy: req.userId!,
      });
    }

    return { next, roleChanges: preview.roleChanges };
  });

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "accounting.settings.updated",
    entityType: "firm",
    entityId: firmId,
    detail: `managerRoles=${next.accountManagerRoleIds.join(",")} adminRoles=${next.accountAdminRoleIds.join(",")}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });

  for (const change of result.roleChanges) {
    if (change.additions.length === 0 && change.removals.length === 0) continue;
    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "accounting.settings.role_template_applied",
      entityType: "role",
      entityId: change.roleId,
      detail: `add=${change.additions.map((x) => `${x.module}:${x.action}`).join("|")} remove=${change.removals.map((x) => `${x.module}:${x.action}`).join("|")}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    }, { db: req.rlsDb });
  }

  res.json({
    settings: next,
    roleChanges: result.roleChanges,
  });
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
