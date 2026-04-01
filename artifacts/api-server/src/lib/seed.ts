import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, firmsTable, rolesTable, usersTable } from "@workspace/db";
import { logger } from "./logger";

export async function seedIfEmpty() {
  const existingUsers = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (existingUsers.length > 0) {
    return;
  }

  logger.info("Database is empty — running initial seed");

  const founderHash = await bcrypt.hash("founder123", 10);
  const [founder] = await db
    .insert(usersTable)
    .values({
      email: "founder@lawcaspro.com",
      name: "System Founder",
      passwordHash: founderHash,
      userType: "founder",
      status: "active",
    })
    .returning();
  logger.info({ userId: founder.id }, "Seeded founder user");

  const [firm] = await db
    .insert(firmsTable)
    .values({
      name: "Messrs. Tan & Associates",
      slug: "tan-associates",
      subscriptionPlan: "professional",
      status: "active",
    })
    .returning();
  logger.info({ firmId: firm.id }, "Seeded demo firm");

  const [partnerRole] = await db.insert(rolesTable).values({ firmId: firm.id, name: "Partner", isSystemRole: true }).returning();
  const [lawyerRole] = await db.insert(rolesTable).values({ firmId: firm.id, name: "Lawyer", isSystemRole: true }).returning();
  const [clerkRole] = await db.insert(rolesTable).values({ firmId: firm.id, name: "Clerk", isSystemRole: true }).returning();
  logger.info("Seeded roles");

  const partnerHash = await bcrypt.hash("partner123", 10);
  const lawyerHash = await bcrypt.hash("lawyer123", 10);
  const clerkHash = await bcrypt.hash("clerk123", 10);

  await db.insert(usersTable).values([
    {
      email: "partner@tan-associates.my",
      name: "Ahmad Tan Wei Ming",
      passwordHash: partnerHash,
      userType: "firm_user",
      firmId: firm.id,
      roleId: partnerRole.id,
      status: "active",
    },
    {
      email: "lawyer@tan-associates.my",
      name: "Sarah Lim Mei Ling",
      passwordHash: lawyerHash,
      userType: "firm_user",
      firmId: firm.id,
      roleId: lawyerRole.id,
      status: "active",
    },
    {
      email: "clerk@tan-associates.my",
      name: "Siti Nur Fatimah",
      passwordHash: clerkHash,
      userType: "firm_user",
      firmId: firm.id,
      roleId: clerkRole.id,
      status: "active",
    },
  ]);
  logger.info("Seeded firm users — partner123 / lawyer123 / clerk123");
}
