import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db, firmsTable, rolesTable, usersTable } from "@workspace/db";
import { logger } from "./logger";

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required but was not provided.`);
  }
  return value.trim();
}

async function ensureFirm(params: { name: string; slug: string }) {
  const [existing] = await db.select().from(firmsTable).where(eq(firmsTable.slug, params.slug));
  if (existing) return existing;
  const [created] = await db
    .insert(firmsTable)
    .values({
      name: params.name,
      slug: params.slug,
      subscriptionPlan: "professional",
      status: "active",
    })
    .returning();
  return created;
}

async function ensureRole(params: { firmId: number; name: string }) {
  const [existing] = await db
    .select()
    .from(rolesTable)
    .where(and(eq(rolesTable.firmId, params.firmId), eq(rolesTable.name, params.name)));
  if (existing) return existing;
  const [created] = await db
    .insert(rolesTable)
    .values({ firmId: params.firmId, name: params.name, isSystemRole: true })
    .returning();
  return created;
}

async function ensureUser(params: {
  email: string;
  name: string;
  password: string;
  userType: "founder" | "firm_user";
  firmId?: number | null;
  roleId?: number | null;
}) {
  const email = params.email.trim().toLowerCase();
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    const updates: Partial<(typeof usersTable)["$inferInsert"]> = {};
    if (existing.name !== params.name) updates.name = params.name;
    if (existing.status !== "active") updates.status = "active";
    if (existing.userType !== params.userType) updates.userType = params.userType;
    if ((existing.firmId ?? null) !== (params.firmId ?? null)) updates.firmId = params.firmId ?? null;
    if ((existing.roleId ?? null) !== (params.roleId ?? null)) updates.roleId = params.roleId ?? null;
    if (Object.keys(updates).length > 0) {
      await db.update(usersTable).set(updates).where(eq(usersTable.id, existing.id));
    }
    return { user: existing, created: false };
  }

  const passwordHash = await bcrypt.hash(params.password, 10);
  const [created] = await db
    .insert(usersTable)
    .values({
      email,
      name: params.name,
      passwordHash,
      userType: params.userType,
      firmId: params.firmId ?? null,
      roleId: params.roleId ?? null,
      status: "active",
    })
    .returning();
  return { user: created, created: true };
}

export async function seedIfEmpty() {
  const shouldSeed = isTruthyEnv(process.env.SEED_DEMO_DATA);
  if (!shouldSeed) {
    return;
  }

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    logger.warn("SEED_DEMO_DATA ignored in production");
    return;
  }

  const founderEmail = process.env.SEED_FOUNDER_EMAIL || "lun.6923@hotmail.com";
  const founderPassword = isProduction ? requireEnv("SEED_FOUNDER_PASSWORD") : process.env.SEED_FOUNDER_PASSWORD || "founder123";

  const firmName = process.env.SEED_FIRM_NAME || "Messrs. Tan & Associates";
  const firmSlug = process.env.SEED_FIRM_SLUG || "tan-associates";

  const partnerEmail = process.env.SEED_PARTNER_EMAIL || "partner@tan-associates.my";
  const clerkEmail = process.env.SEED_CLERK_EMAIL || "clerk@tan-associates.my";

  const partnerPassword = isProduction ? requireEnv("SEED_PARTNER_PASSWORD") : process.env.SEED_PARTNER_PASSWORD || "partner123";
  const clerkPassword = isProduction ? requireEnv("SEED_CLERK_PASSWORD") : process.env.SEED_CLERK_PASSWORD || "clerk123";

  logger.info("Ensuring demo accounts exist");

  const firm = await ensureFirm({ name: firmName.trim(), slug: firmSlug.trim() });
  const partnerRole = await ensureRole({ firmId: firm.id, name: "Partner" });
  await ensureRole({ firmId: firm.id, name: "Lawyer" });
  const clerkRole = await ensureRole({ firmId: firm.id, name: "Clerk" });

  const founderRes = await ensureUser({
    email: founderEmail,
    name: "System Founder",
    password: founderPassword.trim(),
    userType: "founder",
    firmId: null,
    roleId: null,
  });
  const partnerRes = await ensureUser({
    email: partnerEmail,
    name: "Ahmad Tan Wei Ming",
    password: partnerPassword.trim(),
    userType: "firm_user",
    firmId: firm.id,
    roleId: partnerRole.id,
  });
  const clerkRes = await ensureUser({
    email: clerkEmail,
    name: "Siti Nur Fatimah",
    password: clerkPassword.trim(),
    userType: "firm_user",
    firmId: firm.id,
    roleId: clerkRole.id,
  });

  logger.info(
    {
      founderCreated: founderRes.created,
      partnerCreated: partnerRes.created,
      clerkCreated: clerkRes.created,
      firmId: firm.id,
    },
    "Ensured demo accounts"
  );
}
