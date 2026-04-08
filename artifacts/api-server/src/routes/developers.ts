import { Router, type IRouter } from "express";
import { eq, ilike, count, desc, and } from "drizzle-orm";
import { db, developersTable, projectsTable, type Developer, type InsertDeveloper } from "@workspace/db";
import {
  ListDevelopersQueryParams,
  GetDeveloperParams, UpdateDeveloperParams, DeleteDeveloperParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

interface DeveloperContact {
  name: string;
  department: string;
  phone: string;
  phoneExt: string;
  email: string;
}

function parseContacts(raw: string | null | undefined): DeveloperContact[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function enrichDeveloper(dev: Developer) {
  const [pcRes] = await db.select({ c: count() }).from(projectsTable).where(eq(projectsTable.developerId, dev.id));
  return {
    id: dev.id,
    firmId: dev.firmId,
    name: dev.name,
    companyRegNo: dev.companyRegNo ?? null,
    address: dev.address ?? null,
    businessAddress: dev.businessAddress ?? null,
    contacts: parseContacts(dev.contacts),
    contactPerson: dev.contactPerson ?? null,
    phone: dev.phone ?? null,
    email: dev.email ?? null,
    projectCount: Number(pcRes?.c ?? 0),
    createdAt: dev.createdAt.toISOString(),
  };
}

router.get("/developers", requireAuth, requireFirmUser, requirePermission("developers", "read"), async (req: AuthRequest, res): Promise<void> => {
  const params = ListDevelopersQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  let devs;
  let totalRes;

  if (search) {
    devs = await db.select().from(developersTable)
      .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)))
      .orderBy(desc(developersTable.createdAt))
      .limit(limit).offset(offset);
    const [t] = await db.select({ c: count() }).from(developersTable)
      .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)));
    totalRes = t;
  } else {
    devs = await db.select().from(developersTable)
      .where(eq(developersTable.firmId, req.firmId!))
      .orderBy(desc(developersTable.createdAt))
      .limit(limit).offset(offset);
    const [t] = await db.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, req.firmId!));
    totalRes = t;
  }

  const enriched = await Promise.all(devs.map(enrichDeveloper));
  res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
});

router.post("/developers", requireAuth, requireFirmUser, requirePermission("developers", "create"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const { name, companyRegNo, address, businessAddress, contacts, contactPerson, phone, email } = req.body as {
      name: string;
      companyRegNo?: string;
      address?: string;
      businessAddress?: string;
      contacts?: DeveloperContact[];
      contactPerson?: string;
      phone?: string;
      email?: string;
    };
    if (!name) {
      res.status(400).json({ error: "Company name is required" });
      return;
    }

    const isMissingCreatedByColumn = (e: unknown): boolean => {
      const err = e as { code?: string; message?: string; cause?: unknown };
      const code = err?.code
        ?? (err?.cause as any)?.code
        ?? ((err?.cause as any)?.cause as any)?.code;
      if (code === "42703") return true;
      const msg = String(
        err?.message
        ?? (err?.cause as any)?.message
        ?? ((err?.cause as any)?.cause as any)?.message
        ?? ""
      );
      return msg.includes("created_by") && msg.includes("does not exist");
    };

    const insertBase: Omit<InsertDeveloper, "createdBy"> = {
      firmId: req.firmId!,
      name,
      companyRegNo: companyRegNo ?? null,
      address: address ?? null,
      businessAddress: businessAddress ?? null,
      contacts: contacts ? JSON.stringify(contacts) : null,
      contactPerson: contactPerson ?? null,
      phone: phone ?? null,
      email: email ?? null,
    };

    let dev: Developer;
    try {
      [dev] = await db
        .insert(developersTable)
        .values({ ...insertBase, createdBy: req.userId })
        .returning();
    } catch (e) {
      if (!isMissingCreatedByColumn(e)) throw e;
      [dev] = await db
        .insert(developersTable)
        .values(insertBase)
        .returning();
    }

    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.create", entityType: "developer", entityId: dev.id, detail: `name=${dev.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(await enrichDeveloper(dev));
    return;
  } catch (e) {
    (req as any).log?.error?.({ err: e }, "developers.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "read"), async (req: AuthRequest, res): Promise<void> => {
  const params = GetDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [dev] = await db.select().from(developersTable).where(eq(developersTable.id, params.data.developerId));
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  res.json(await enrichDeveloper(dev));
});

router.patch("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "update"), async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { name, companyRegNo, address, businessAddress, contacts, contactPerson, phone, email } = req.body as {
    name?: string;
    companyRegNo?: string;
    address?: string;
    businessAddress?: string;
    contacts?: DeveloperContact[];
    contactPerson?: string;
    phone?: string;
    email?: string;
  };

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (companyRegNo !== undefined) updateData.companyRegNo = companyRegNo;
  if (address !== undefined) updateData.address = address;
  if (businessAddress !== undefined) updateData.businessAddress = businessAddress;
  if (contacts !== undefined) updateData.contacts = JSON.stringify(contacts);
  if (contactPerson !== undefined) updateData.contactPerson = contactPerson;
  if (phone !== undefined) updateData.phone = phone;
  if (email !== undefined) updateData.email = email;

  const [dev] = await db
    .update(developersTable)
    .set(updateData as any)
    .where(eq(developersTable.id, params.data.developerId))
    .returning();

  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.update", entityType: "developer", entityId: dev.id, detail: `fields=${Object.keys(updateData).join(",")}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(await enrichDeveloper(dev));
});

router.delete("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [dev] = await db.delete(developersTable).where(eq(developersTable.id, params.data.developerId)).returning();
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.delete", entityType: "developer", entityId: dev.id, detail: `name=${dev.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

export default router;
