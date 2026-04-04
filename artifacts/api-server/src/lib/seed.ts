import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
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

export async function seedIfEmpty() {
  const isProduction = process.env.NODE_ENV === "production";
  const shouldSeedInProduction = isTruthyEnv(process.env.SEED_DEMO_DATA);
  if (isProduction && !shouldSeedInProduction) {
    return;
  }

  const existingUsers = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (existingUsers.length > 0) {
    return;
  }

  logger.info("Database is empty — running initial seed");

  const founderEmail = (process.env.SEED_FOUNDER_EMAIL || "founder@lawcaspro.com").trim();
  const founderPassword = isProduction ? requireEnv("SEED_FOUNDER_PASSWORD") : (process.env.SEED_FOUNDER_PASSWORD || "founder123").trim();
  const founderHash = await bcrypt.hash(founderPassword, 10);
  const [founder] = await db
    .insert(usersTable)
    .values({
      email: founderEmail,
      name: "System Founder",
      passwordHash: founderHash,
      userType: "founder",
      status: "active",
    })
    .returning();
  logger.info({ userId: founder.id }, "Seeded founder user");

  const firmName = (process.env.SEED_FIRM_NAME || "Messrs. Tan & Associates").trim();
  const firmSlug = (process.env.SEED_FIRM_SLUG || "tan-associates").trim();
  const [firm] = await db
    .insert(firmsTable)
    .values({
      name: firmName,
      slug: firmSlug,
      subscriptionPlan: "professional",
      status: "active",
    })
    .returning();
  logger.info({ firmId: firm.id }, "Seeded demo firm");

  const [partnerRole] = await db.insert(rolesTable).values({ firmId: firm.id, name: "Partner", isSystemRole: true }).returning();
  const [lawyerRole] = await db.insert(rolesTable).values({ firmId: firm.id, name: "Lawyer", isSystemRole: true }).returning();
  const [clerkRole] = await db.insert(rolesTable).values({ firmId: firm.id, name: "Clerk", isSystemRole: true }).returning();
  logger.info("Seeded roles");

  const partnerPassword = isProduction ? requireEnv("SEED_PARTNER_PASSWORD") : (process.env.SEED_PARTNER_PASSWORD || "partner123").trim();
  const lawyerPassword = isProduction ? requireEnv("SEED_LAWYER_PASSWORD") : (process.env.SEED_LAWYER_PASSWORD || "lawyer123").trim();
  const clerkPassword = isProduction ? requireEnv("SEED_CLERK_PASSWORD") : (process.env.SEED_CLERK_PASSWORD || "clerk123").trim();

  const partnerHash = await bcrypt.hash(partnerPassword, 10);
  const lawyerHash = await bcrypt.hash(lawyerPassword, 10);
  const clerkHash = await bcrypt.hash(clerkPassword, 10);

  await db.insert(usersTable).values([
    {
      email: (process.env.SEED_PARTNER_EMAIL || "partner@tan-associates.my").trim(),
      name: "Ahmad Tan Wei Ming",
      passwordHash: partnerHash,
      userType: "firm_user",
      firmId: firm.id,
      roleId: partnerRole.id,
      status: "active",
    },
    {
      email: (process.env.SEED_LAWYER_EMAIL || "lawyer@tan-associates.my").trim(),
      name: "Sarah Lim Mei Ling",
      passwordHash: lawyerHash,
      userType: "firm_user",
      firmId: firm.id,
      roleId: lawyerRole.id,
      status: "active",
    },
    {
      email: (process.env.SEED_CLERK_EMAIL || "clerk@tan-associates.my").trim(),
      name: "Siti Nur Fatimah",
      passwordHash: clerkHash,
      userType: "firm_user",
      firmId: firm.id,
      roleId: clerkRole.id,
      status: "active",
    },
  ]);
  logger.info("Seeded firm users");
}
