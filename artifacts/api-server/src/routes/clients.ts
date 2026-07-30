import express, { type Router as ExpressRouter } from "express";
import { eq, ilike, count, desc, and, isNull } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { db, clientsTable, casePurchasersTable } from "@workspace/db";
import {
  CreateClientBody,
  UpdateClientBody,
  ListClientsQueryParams,
  GetClientParams,
  UpdateClientParams,
  DeleteClientParams,
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

type ReqLike = IncomingMessage & {
  body?: unknown;
  headers: IncomingHttpHeaders & Record<string, string | string[] | undefined>;
  ip?: string;
  originalUrl?: string;
  params?: Record<string, unknown>;
  path?: string;
  query?: Record<string, unknown>;
  firmId?: number | null;
  userId?: number | null;
  userType?: string | null;
  roleId?: number | null;
  log?: { error?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  rlsDb?: AuthRequest["rlsDb"];
  [key: string]: unknown;
};

type RouteResLike = {
  status: (code: number) => RouteResLike;
  json: (body: unknown) => unknown;
  sendStatus: (code: number) => unknown;
  [key: string]: unknown;
};

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const routerInternal = expressRouter as unknown as RouterInternalLike;

type AuthRequestLike = AuthRequest & ReqLike;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequestLike): DbConn => req.rlsDb ?? db;

type ClientRow = typeof clientsTable.$inferSelect;

async function enrichClient(r: DbConn, client: ClientRow) {
  const [ccRes] = await r
    .select({ c: count() })
    .from(casePurchasersTable)
    .where(eq(casePurchasersTable.clientId, client.id));
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

routerInternal.get("/clients", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = rdb(req);
    const params = ListClientsQueryParams.safeParse(req.query);
    const search = params.success ? params.data.search : undefined;
    const page = params.success ? (params.data.page ?? 1) : 1;
    const limit = params.success ? (params.data.limit ?? 20) : 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(clientsTable.firmId, req.firmId!), isNull(clientsTable.deletedAt)];
    if (search) conditions.push(ilike(clientsTable.name, `%${search}%`));

    const clients = await r
      .select()
      .from(clientsTable)
      .where(and(...conditions))
      .orderBy(desc(clientsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [totalRes] = await r
      .select({ c: count() })
      .from(clientsTable)
      .where(and(...conditions));

    const enriched = await Promise.all(clients.map((c: ClientRow) => enrichClient(r, c)));
    res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[clients]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

routerInternal.post("/clients", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log?.error?.({ route: "POST /api/clients", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
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

    const [client] = await r
      .insert(clientsTable)
      .values(insertPayload)
      .returning();

    res.status(201).json(await enrichClient(r, client));
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[clients]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

routerInternal.get("/clients/:clientId", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = rdb(req);
    const params = GetClientParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [client] = await r
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.id, params.data.clientId), eq(clientsTable.firmId, req.firmId!), isNull(clientsTable.deletedAt)));
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    res.json(await enrichClient(r, client));
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[clients]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

routerInternal.patch("/clients/:clientId", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log?.error?.({ route: "PATCH /api/clients/:clientId", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
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
    updatePayload.updatedAt = new Date();

    const [client] = await r
      .update(clientsTable)
      .set(updatePayload)
      .where(and(eq(clientsTable.id, params.data.clientId), eq(clientsTable.firmId, req.firmId!), isNull(clientsTable.deletedAt)))
      .returning();

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    res.json(await enrichClient(r, client));
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[clients]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

routerInternal.delete("/clients/:clientId", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log?.error?.({ route: "DELETE /api/clients/:clientId", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const params = DeleteClientParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [client] = await r
      .update(clientsTable)
      .set({ deletedAt: new Date(), updatedAt: new Date() } satisfies Partial<typeof clientsTable.$inferInsert>)
      .where(and(eq(clientsTable.id, params.data.clientId), eq(clientsTable.firmId, req.firmId!), isNull(clientsTable.deletedAt)))
      .returning();
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    res.sendStatus(204);
  } catch (err) {
    logger.error({ err, path: req.path, firmId: req.firmId, userId: req.userId }, "[clients]");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
