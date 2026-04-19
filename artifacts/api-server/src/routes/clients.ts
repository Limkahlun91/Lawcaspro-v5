import { Router, type IRouter } from "express";
import { eq, ilike, count, desc, and } from "drizzle-orm";
import { db, clientsTable, casePurchasersTable } from "@workspace/db";
import {
  CreateClientBody, UpdateClientBody, ListClientsQueryParams,
  GetClientParams, UpdateClientParams, DeleteClientParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

async function enrichClient(client: typeof clientsTable.$inferSelect) {
  const [ccRes] = await db.select({ c: count() }).from(casePurchasersTable).where(eq(casePurchasersTable.clientId, client.id));
  return {
    id: client.id,
    firmId: client.firmId,
    name: client.name,
    icNo: client.icNo ?? null,
    nationality: client.nationality ?? null,
    address: client.address ?? null,
    email: client.email ?? null,
    phone: client.phone ?? null,
    caseCount: Number(ccRes?.c ?? 0),
    createdAt: client.createdAt.toISOString(),
  };
}

router.get("/clients", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = ListClientsQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  const conditions = [eq(clientsTable.firmId, req.firmId!)];
  if (search) conditions.push(ilike(clientsTable.name, `%${search}%`));

  const clients = await db.select().from(clientsTable)
    .where(and(...conditions))
    .orderBy(desc(clientsTable.createdAt))
    .limit(limit).offset(offset);

  const [totalRes] = await db.select({ c: count() }).from(clientsTable).where(and(...conditions));

  const enriched = await Promise.all(clients.map(enrichClient));
  res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
});

router.post("/clients", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const insertPayload = {
    firmId: req.firmId!,
    name: parsed.data.name,
    icNo: parsed.data.icNo,
    nationality: parsed.data.nationality,
    address: parsed.data.address,
    email: parsed.data.email,
    phone: parsed.data.phone,
    createdBy: req.userId,
  } satisfies typeof clientsTable.$inferInsert;

  const [client] = await db
    .insert(clientsTable)
    .values(insertPayload)
    .returning();

  res.status(201).json(await enrichClient(client));
});

router.get("/clients/:clientId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = GetClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, params.data.clientId));
  if (!client || client.firmId !== req.firmId) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(await enrichClient(client));
});

router.patch("/clients/:clientId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updatePayload: Partial<typeof clientsTable.$inferInsert> = {};
  if (parsed.data.name !== undefined) updatePayload.name = parsed.data.name;
  if (parsed.data.icNo !== undefined) updatePayload.icNo = parsed.data.icNo;
  if (parsed.data.nationality !== undefined) updatePayload.nationality = parsed.data.nationality;
  if (parsed.data.address !== undefined) updatePayload.address = parsed.data.address;
  if (parsed.data.email !== undefined) updatePayload.email = parsed.data.email;
  if (parsed.data.phone !== undefined) updatePayload.phone = parsed.data.phone;

  const [client] = await db
    .update(clientsTable)
    .set(updatePayload)
    .where(eq(clientsTable.id, params.data.clientId))
    .returning();

  if (!client || client.firmId !== req.firmId) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(await enrichClient(client));
});

router.delete("/clients/:clientId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db.delete(clientsTable).where(eq(clientsTable.id, params.data.clientId)).returning();
  if (!client || client.firmId !== req.firmId) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
