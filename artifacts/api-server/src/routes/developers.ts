import { Router, type IRouter } from "express";
import { eq, ilike, count, desc, and } from "drizzle-orm";
import { db, developersTable, projectsTable, sql, type Developer } from "@workspace/db";
import {
  ListDevelopersQueryParams,
  GetDeveloperParams, UpdateDeveloperParams, DeleteDeveloperParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

type DeveloperInsert = typeof developersTable.$inferInsert;
type DeveloperInsertPayload = Pick<DeveloperInsert, "firmId" | "name"> & Partial<Omit<
  DeveloperInsert,
  "firmId" | "name" | "id" | "createdAt" | "updatedAt"
>>;

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

async function enrichDeveloper(r: DbConn, dev: Developer) {
  const [pcRes] = await r.select({ c: count() }).from(projectsTable).where(eq(projectsTable.developerId, dev.id));
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
  try {
    const r = rdb(req);
    const params = ListDevelopersQueryParams.safeParse(req.query);
    const search = params.success ? params.data.search : undefined;
    const page = params.success ? (params.data.page ?? 1) : 1;
    const limit = params.success ? (params.data.limit ?? 20) : 20;
    const offset = (page - 1) * limit;

    let devs;
    let totalRes;

    if (search) {
      devs = await r.select().from(developersTable)
        .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)))
        .orderBy(desc(developersTable.createdAt))
        .limit(limit).offset(offset);
      const [t] = await r.select({ c: count() }).from(developersTable)
        .where(and(eq(developersTable.firmId, req.firmId!), ilike(developersTable.name, `%${search}%`)));
      totalRes = t;
    } else {
      devs = await r.select().from(developersTable)
        .where(eq(developersTable.firmId, req.firmId!))
        .orderBy(desc(developersTable.createdAt))
        .limit(limit).offset(offset);
      const [t] = await r.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, req.firmId!));
      totalRes = t;
    }

    const enriched = await Promise.all(devs.map((d) => enrichDeveloper(r, d)));
    res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[developers]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/developers", requireAuth, requireFirmUser, requirePermission("developers", "create"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "POST /api/developers", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
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

    const insertBase = {
      firmId: req.firmId!,
      name,
      companyRegNo: companyRegNo ?? null,
      address: address ?? null,
      businessAddress: businessAddress ?? null,
      contacts: contacts ? JSON.stringify(contacts) : null,
      contactPerson: contactPerson ?? null,
      phone: phone ?? null,
      email: email ?? null,
    } satisfies DeveloperInsertPayload;

    let ctxFirmId: string | null = null;
    let ctxIsFounder: string | null = null;
    try {
      const result = await r.execute(sql`
        select
          current_setting('app.current_firm_id', true) as firm_id,
          current_setting('app.is_founder', true) as is_founder
      `);
      const rows = Array.isArray(result)
        ? result
        : ("rows" in (result as any) ? (result as any).rows : []);
      const row = rows?.[0] as any;
      ctxFirmId = typeof row?.firm_id === "string" ? row.firm_id : null;
      ctxIsFounder = typeof row?.is_founder === "string" ? row.is_founder : null;
    } catch {
    }
    req.log.info({
      route: "POST /api/developers",
      userId: req.userId,
      firmId: req.firmId,
      insertFirmId: insertBase.firmId,
      ctxFirmId,
      ctxIsFounder,
    }, "create route tenant context");

    let dev: Developer;
    const getErrorMessage = (e: unknown): string => {
      const err = e as { message?: unknown; cause?: unknown };
      const msg =
        (typeof err?.message === "string" ? err.message : undefined)
        ?? (typeof (err?.cause as any)?.message === "string" ? (err?.cause as any)?.message : undefined)
        ?? (typeof ((err?.cause as any)?.cause as any)?.message === "string" ? ((err?.cause as any)?.cause as any)?.message : undefined);
      return msg ? String(msg) : "";
    };

    const missingColumnFromMessage = (msg: string): string | null => {
      const m = msg.match(/column \"([^\"]+)\" of relation \"developers\" does not exist/i);
      return m?.[1] ?? null;
    };

    const columnToKey: Record<string, keyof DeveloperInsertPayload> = {
      company_reg_no: "companyRegNo",
      address: "address",
      business_address: "businessAddress",
      contacts: "contacts",
      contact_person: "contactPerson",
      phone: "phone",
      email: "email",
    };

    let insertValues: DeveloperInsertPayload = { ...insertBase };
    for (;;) {
      try {
        [dev] = await r
          .insert(developersTable)
          .values(insertValues)
          .returning();
        break;
      } catch (e) {
        const col = missingColumnFromMessage(getErrorMessage(e));
        if (!col) throw e;
        const key = columnToKey[col];
        if (!key) throw e;
        insertValues = { ...insertValues, [key]: undefined };
      }
    }

    try {
      const createdByUpdate = { createdBy: req.userId } satisfies Partial<typeof developersTable.$inferInsert>;
      await r
        .update(developersTable)
        .set(createdByUpdate)
        .where(and(eq(developersTable.id, dev.id), eq(developersTable.firmId, req.firmId!)));
    } catch {
    }

    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.create", entityType: "developer", entityId: dev.id, detail: `name=${dev.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(await enrichDeveloper(r, dev));
    return;
  } catch (e) {
    const pg = (() => {
      let cur: any = e;
      for (let i = 0; i < 6 && cur; i++) {
        if (typeof cur?.code === "string" || typeof cur?.message === "string" || typeof cur?.detail === "string" || typeof cur?.constraint === "string") {
          const code = typeof cur.code === "string" ? cur.code : undefined;
          const message = typeof cur.message === "string" ? cur.message : undefined;
          const detail = typeof cur.detail === "string" ? cur.detail : undefined;
          const constraint = typeof cur.constraint === "string" ? cur.constraint : undefined;
          return { code, message, detail, constraint };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    req.log.error({ err: e, pg }, "developers.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const params = GetDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, params.data.developerId));
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  res.json(await enrichDeveloper(r, dev));
});

router.patch("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
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

  const updateData: Partial<typeof developersTable.$inferInsert> = {};
  if (name !== undefined) updateData.name = name;
  if (companyRegNo !== undefined) updateData.companyRegNo = companyRegNo;
  if (address !== undefined) updateData.address = address;
  if (businessAddress !== undefined) updateData.businessAddress = businessAddress;
  if (contacts !== undefined) updateData.contacts = JSON.stringify(contacts);
  if (contactPerson !== undefined) updateData.contactPerson = contactPerson;
  if (phone !== undefined) updateData.phone = phone;
  if (email !== undefined) updateData.email = email;

  const [dev] = await r
    .update(developersTable)
    .set(updateData)
    .where(eq(developersTable.id, params.data.developerId))
    .returning();

  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.update", entityType: "developer", entityId: dev.id, detail: `fields=${Object.keys(updateData).join(",")}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(await enrichDeveloper(r, dev));
});

router.delete("/developers/:developerId", requireAuth, requireFirmUser, requirePermission("developers", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteDeveloperParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const r = req.rlsDb;
  if (!r) {
    logger.error({ path: req.path, firmId: req.firmId, userId: req.userId }, "[developers] missing tenant database context");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }

  const [dev] = await r
    .delete(developersTable)
    .where(and(eq(developersTable.id, params.data.developerId), eq(developersTable.firmId, req.firmId!)))
    .returning();
  if (!dev || dev.firmId !== req.firmId) {
    res.status(404).json({ error: "Developer not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "developers.delete", entityType: "developer", entityId: dev.id, detail: `name=${dev.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

export default router;
