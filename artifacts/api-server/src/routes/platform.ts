import { Router, type IRouter } from "express";
import { eq, ilike, count, sql, desc } from "drizzle-orm";
import { db, firmsTable, usersTable, casesTable } from "@workspace/db";
import { CreateFirmBody, UpdateFirmBody, ListFirmsQueryParams, GetFirmParams, UpdateFirmParams } from "@workspace/api-zod";
import { requireAuth, requireFounder, type AuthRequest } from "../lib/auth";
import bcrypt from "bcryptjs";

const router: IRouter = Router();

router.get("/platform/firms", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = ListFirmsQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const status = params.success ? params.data.status : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  let query = db.select().from(firmsTable);
  if (search) {
    query = query.where(ilike(firmsTable.name, `%${search}%`)) as typeof query;
  }
  if (status) {
    query = query.where(eq(firmsTable.status, status)) as typeof query;
  }

  const firms = await query.orderBy(desc(firmsTable.createdAt)).limit(limit).offset(offset);

  const totalResult = await db.select({ total: count() }).from(firmsTable);
  const total = totalResult[0]?.total ?? 0;

  const enriched = await Promise.all(
    firms.map(async (firm) => {
      const [userCountRes] = await db
        .select({ c: count() })
        .from(usersTable)
        .where(eq(usersTable.firmId, firm.id));
      const [partnerCountRes] = await db
        .select({ c: count() })
        .from(usersTable)
        .where(sql`firm_id = ${firm.id} AND user_type = 'firm_user'`);
      const [caseCountRes] = await db
        .select({ c: count() })
        .from(casesTable)
        .where(eq(casesTable.firmId, firm.id));

      const docRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents WHERE firm_id = ${firm.id}`);
      const docCount = Number((Array.isArray(docRes) ? docRes[0] : (docRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);

      const billingRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_billing_entries WHERE firm_id = ${firm.id}`);
      const billingCount = Number((Array.isArray(billingRes) ? billingRes[0] : (billingRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);

      const commRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_communications WHERE firm_id = ${firm.id}`);
      const commCount = Number((Array.isArray(commRes) ? commRes[0] : (commRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);

      return {
        ...firm,
        userCount: Number(userCountRes?.c ?? 0),
        partnerCount: Number(partnerCountRes?.c ?? 0),
        caseCount: Number(caseCountRes?.c ?? 0),
        user_count: Number(userCountRes?.c ?? 0),
        case_count: Number(caseCountRes?.c ?? 0),
        document_count: docCount,
        billing_entry_count: billingCount,
        comm_count: commCount,
      };
    })
  );

  res.json({ data: enriched, total: Number(total), page, limit });
});

router.post("/platform/firms", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, slug, subscriptionPlan, partnerName, partnerEmail, partnerPassword } = parsed.data;

  const [existing] = await db.select().from(firmsTable).where(eq(firmsTable.slug, slug));
  if (existing) {
    res.status(400).json({ error: "Slug already taken" });
    return;
  }

  const [firm] = await db
    .insert(firmsTable)
    .values({ name, slug, subscriptionPlan: subscriptionPlan ?? "starter", status: "active" })
    .returning();

  const passwordHash = await bcrypt.hash(partnerPassword, 10);
  const [partnerUser] = await db
    .insert(usersTable)
    .values({
      firmId: firm.id,
      email: partnerEmail.toLowerCase(),
      name: partnerName,
      passwordHash,
      userType: "firm_user",
      status: "active",
    })
    .returning();

  res.status(201).json({
    ...firm,
    userCount: 1,
    partnerCount: 1,
    caseCount: 0,
  });
});

router.get("/platform/firms/:firmId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = GetFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, params.data.firmId));
  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }

  const [userCountRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.firmId, firm.id));
  const [caseCountRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.firmId, firm.id));

  res.json({
    ...firm,
    userCount: Number(userCountRes?.c ?? 0),
    partnerCount: 0,
    caseCount: Number(caseCountRes?.c ?? 0),
  });
});

router.patch("/platform/firms/:firmId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.subscriptionPlan !== undefined) updates.subscriptionPlan = parsed.data.subscriptionPlan;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;

  const [firm] = await db
    .update(firmsTable)
    .set(updates)
    .where(eq(firmsTable.id, params.data.firmId))
    .returning();

  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }

  res.json({ ...firm, userCount: 0, partnerCount: 0, caseCount: 0 });
});

router.get("/platform/stats", requireAuth, requireFounder, async (_req, res): Promise<void> => {
  const [totalFirmsRes] = await db.select({ c: count() }).from(firmsTable);
  const [activeFirmsRes] = await db.select({ c: count() }).from(firmsTable).where(eq(firmsTable.status, "active"));
  const [totalUsersRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.userType, "firm_user"));
  const [totalCasesRes] = await db.select({ c: count() }).from(casesTable);
  const docsRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents`);
  const totalDocuments = Number((Array.isArray(docsRes) ? docsRes[0] : (docsRes as {rows: {c: string}[]}).rows[0])?.c ?? 0);

  res.json({
    totalFirms: Number(totalFirmsRes?.c ?? 0),
    activeFirms: Number(activeFirmsRes?.c ?? 0),
    totalUsers: Number(totalUsersRes?.c ?? 0),
    totalCases: Number(totalCasesRes?.c ?? 0),
    totalDocuments,
  });
});

export default router;
