import { and, eq, sql } from "drizzle-orm";
import { casesTable, firmsTable, subscriptionPlansTable, usersTable, type AppDb, type RlsDb } from "@workspace/db";
import { ApiError } from "./api-response.js";

export type QuotaResourceType = "users" | "cases" | string;

type DbConn = AppDb | RlsDb;

const firstDayOfCurrentMonth = (): Date => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
};

export async function checkFirmQuota(dbConn: DbConn, firmId: number, resourceType: QuotaResourceType): Promise<void> {
  const [firm] = await dbConn
    .select({
      subscriptionStatus: firmsTable.subscriptionStatus,
      subscriptionPlanId: firmsTable.subscriptionPlanId,
      maxUsers: subscriptionPlansTable.maxUsers,
      maxCasesPerMonth: subscriptionPlansTable.maxCasesPerMonth,
      features: subscriptionPlansTable.features,
      planActive: subscriptionPlansTable.isActive,
    })
    .from(firmsTable)
    .leftJoin(subscriptionPlansTable, eq(firmsTable.subscriptionPlanId, subscriptionPlansTable.id))
    .where(eq(firmsTable.id, firmId))
    .limit(1);

  if (!firm) throw new ApiError({ status: 404, code: "FIRM_NOT_FOUND", message: "Firm not found", retryable: false });

  if (firm.subscriptionStatus === "suspended") {
    throw new ApiError({ status: 403, code: "SUBSCRIPTION_SUSPENDED", message: "Subscription suspended", retryable: false });
  }

  if (!firm.subscriptionPlanId || firm.planActive === false) return;

  if (resourceType === "users") {
    if (firm.maxUsers == null) return;
    const [cnt] = await dbConn
      .select({ c: sql<number>`count(*)` })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, firmId), eq(usersTable.status, "active")));
    const current = Number((cnt as any)?.c ?? 0);
    if (current >= firm.maxUsers) {
      throw new ApiError({ status: 403, code: "QUOTA_EXCEEDED", message: "User quota exceeded", retryable: false });
    }
    return;
  }

  if (resourceType === "cases") {
    if (firm.maxCasesPerMonth == null) return;
    const since = firstDayOfCurrentMonth();
    const [cnt] = await dbConn
      .select({ c: sql<number>`count(*)` })
      .from(casesTable)
      .where(and(eq(casesTable.firmId, firmId), sql`${casesTable.createdAt} >= ${since}`));
    const current = Number((cnt as any)?.c ?? 0);
    if (current >= firm.maxCasesPerMonth) {
      throw new ApiError({ status: 403, code: "QUOTA_EXCEEDED", message: "Case quota exceeded", retryable: false });
    }
    return;
  }

  const features = firm.features && typeof firm.features === "object" ? (firm.features as Record<string, unknown>) : {};
  const raw = features[resourceType];
  const enabled =
    raw === true ||
    raw === "true" ||
    raw === 1 ||
    raw === "1";
  if (!enabled) {
    throw new ApiError({ status: 403, code: "FEATURE_DISABLED", message: `Feature disabled: ${resourceType}`, retryable: false });
  }
}

