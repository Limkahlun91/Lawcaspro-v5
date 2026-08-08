import { db, firmOperatingSettingsTable, accountingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";
import { checkOptimisticLock, nextVersion } from "../permissions/hr-authorization.js";

export type SharedOperatingKey =
  | "timezone"
  | "workingDays"
  | "workingHours"
  | "publicHolidayRegion"
  | "holidayCalendar"
  | "weekendRules";

export const SHARED_OPERATING_KEYS: readonly SharedOperatingKey[] = Object.freeze([
  "timezone",
  "workingDays",
  "workingHours",
  "publicHolidayRegion",
  "holidayCalendar",
  "weekendRules",
]);

export interface FirmOperatingSettingsUpdate {
  timezone?: string;
  workingDays?: string[];
  workingHours?: { start: string; end: string; break_start: string; break_end: string };
  publicHolidayRegion?: string;
  holidayCalendar?: Array<{ date: string; name: string; type?: string }>;
  weekendRules?: { saturday_off: boolean; sunday_off: boolean; friday_off: boolean };
}

export async function readFirmOperatingSettings(firmId: number) {
  if (!firmId || !Number.isFinite(firmId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required");
  }
  const rows = await db
    .select()
    .from(firmOperatingSettingsTable)
    .where(eq(firmOperatingSettingsTable.firmId, firmId))
    .limit(1);
  if (rows && rows.length > 0) return rows[0];
  const inserted = await db
    .insert(firmOperatingSettingsTable)
    .values({ firmId })
    .onConflictDoNothing({ target: [firmOperatingSettingsTable.firmId] })
    .returning();
  if (inserted && inserted.length > 0) return inserted[0];
  const retry = await db
    .select()
    .from(firmOperatingSettingsTable)
    .where(eq(firmOperatingSettingsTable.firmId, firmId))
    .limit(1);
  if (!retry || retry.length === 0) {
    throw createHRError(HR_ERROR_CODES.HR_SETTINGS_NOT_CONFIGURED, "firm_operating_settings not available for firm", {
      details: { firmId },
    });
  }
  return retry[0];
}

export async function doubleWriteSharedOperatingSettings(
  firmId: number,
  update: FirmOperatingSettingsUpdate,
  actorUserId: number,
  expectedVersion: number,
) {
  if (!firmId || !Number.isFinite(firmId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required for double-write");
  }
  if (!actorUserId || !Number.isFinite(actorUserId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "actorUserId required for operating settings update");
  }
  const current = await readFirmOperatingSettings(firmId);
  if (!Number.isFinite(expectedVersion) || expectedVersion < 0) {
    throw createHRError(
      HR_ERROR_CODES.HR_RECORD_VERSION_MISMATCH,
      `firm_operating_settings: invalid expectedVersion=${String(expectedVersion)}; refresh a fresh copy and retry.`,
    );
  }
  if (Number(current.version) !== Number(expectedVersion)) {
    throw createHRError(
      HR_ERROR_CODES.HR_RECORD_CONFLICT,
      `firm_operating_settings optimistic lock conflict: expected version ${expectedVersion}, current is ${current.version}. Refresh and retry.`,
      { details: { expectedVersion, currentVersion: current.version, firmId } },
    );
  }
  const newVersion = nextVersion(current.version);

  const fosUpdate: Partial<{
    timezone: string;
    workingDays: string[];
    workingHours: { start: string; end: string; break_start: string; break_end: string };
    publicHolidayRegion: string;
    holidayCalendar: Array<{ date: string; name: string; type?: string }>;
    weekendRules: { saturday_off: boolean; sunday_off: boolean; friday_off: boolean };
    updatedByUserId: number;
    version: number;
  }> = { updatedByUserId: actorUserId, version: newVersion };
  const acsUpdate: Record<string, unknown> = {};

  if (update.timezone !== undefined) {
    fosUpdate.timezone = update.timezone;
    acsUpdate.timezone = update.timezone;
  }
  if (update.workingDays !== undefined) {
    fosUpdate.workingDays = update.workingDays;
  }
  if (update.workingHours !== undefined) {
    fosUpdate.workingHours = update.workingHours;
    acsUpdate.working_hours_start = update.workingHours.start;
    acsUpdate.working_hours_end = update.workingHours.end;
  }
  if (update.publicHolidayRegion !== undefined) {
    fosUpdate.publicHolidayRegion = update.publicHolidayRegion;
  }
  if (update.holidayCalendar !== undefined) {
    fosUpdate.holidayCalendar = update.holidayCalendar;
    acsUpdate.firm_holidays = update.holidayCalendar;
  }
  if (update.weekendRules !== undefined) {
    fosUpdate.weekendRules = update.weekendRules;
    acsUpdate.exclude_saturday = Boolean(update.weekendRules.saturday_off);
    acsUpdate.exclude_sunday = Boolean(update.weekendRules.sunday_off);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(firmOperatingSettingsTable)
      .set(fosUpdate as Partial<typeof firmOperatingSettingsTable.$inferSelect>)
      .where(eq(firmOperatingSettingsTable.firmId, firmId));

    try {
      if (Object.keys(acsUpdate).length > 0) {
        const acsInsert: Record<string, unknown> = { firmId, ...acsUpdate };
        await tx
          .insert(accountingSettingsTable)
          .values(acsInsert as any)
          .onConflictDoUpdate({
            target: [accountingSettingsTable.firmId],
            set: acsUpdate as any,
          });
      }
    } catch (err) {
      logger.warn({ firmId, err }, "firmOperatingSettings double-write: legacy accounting_settings update failed (non-fatal)");
    }
  });

  return readFirmOperatingSettings(firmId);
}

export const firmOperatingSettingsReadService = {
  read: readFirmOperatingSettings,
  doubleWrite: doubleWriteSharedOperatingSettings,
};

export default firmOperatingSettingsReadService;
