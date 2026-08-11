import { eq, asc } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  type AppDb,
  type RlsDb,
  bankExportAdaptersTable,
  type BankExportAdapter,
} from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

export const BANK_EXPORT_UPCOMING_DISABLED_MESSAGE =
  "Official file specification pending verification";

const ADAPTER_NOT_FOUND = "ADAPTER_NOT_FOUND";
const BANK_ADAPTER_NOT_ACTIVE = "BANK_ADAPTER_NOT_ACTIVE";
const BANK_ADAPTER_CONFIG_INCOMPLETE = "BANK_ADAPTER_CONFIG_INCOMPLETE";
const BANK_ADAPTER_DEPRECATED = "BANK_ADAPTER_DEPRECATED";

// Cross-bank copy guard note (PART3C intent, not fully enforced at service layer):
// Each bank adapter (Maybank, CIMB, OCBC, Public Bank, RHB, HLB) must be independent.
// No cross-bank format copy allowed. If a future similarity check is implemented,
// compare sha256(JSON.stringify(columnMappingJson|parserConfigJson)) fingerprints
// across adapters and emit a warning when similarity > 90%, but do NOT auto-flag as error.

type BankAdapterStatus =
  | "Upcoming"
  | "Active"
  | "Beta"
  | "Deprecated"
  | "Disabled"
  | string;

export interface ListVisibleAdapterRow {
  adapterCode: string;
  bankName: string;
  bankShortCode: string | null;
  status: string;
  version: string;
  description: string | null;
  supportedFileTypes: string[];
  isVisible: boolean;
  exportAllowed: boolean;
  disabledReason: string | null;
}

export async function listVisibleAdapters(opts: { tx?: unknown } = {}): Promise<
  ListVisibleAdapterRow[]
> {
  const conn = pickDbConn(opts.tx);

  const rows = await conn
    .select({
      adapterCode: bankExportAdaptersTable.adapterCode,
      bankName: bankExportAdaptersTable.bankName,
      bankShortCode: bankExportAdaptersTable.bankShortCode,
      status: bankExportAdaptersTable.status,
      version: bankExportAdaptersTable.version,
      description: bankExportAdaptersTable.description,
      supportedFileTypes: bankExportAdaptersTable.supportedFileTypes,
      isVisible: bankExportAdaptersTable.isVisible,
      parserConfigJson: bankExportAdaptersTable.parserConfigJson,
      columnMappingJson: bankExportAdaptersTable.columnMappingJson,
    })
    .from(bankExportAdaptersTable as any)
    .where(eq(bankExportAdaptersTable.isVisible, true))
    .orderBy(asc(bankExportAdaptersTable.sortOrder));

  return rows.map((row) => {
    const status = (row.status as BankAdapterStatus) ?? "Upcoming";
    let exportAllowed = status === "Active";
    let disabledReason: string | null = null;

    if (status === "Upcoming") {
      disabledReason = BANK_EXPORT_UPCOMING_DISABLED_MESSAGE;
    } else if (status === "Beta") {
      disabledReason = null;
    } else if (status === "Deprecated") {
      disabledReason = "Adapter is deprecated, please use successor";
    } else if (status === "Disabled") {
      disabledReason = "Adapter is disabled";
    }

    if (
      status === "Active" &&
      (row.parserConfigJson == null || row.columnMappingJson == null)
    ) {
      exportAllowed = false;
      disabledReason = "Adapter configuration incomplete";
    }

    return {
      adapterCode: row.adapterCode,
      bankName: row.bankName,
      bankShortCode: row.bankShortCode ?? null,
      status: row.status,
      version: row.version,
      description: row.description ?? null,
      supportedFileTypes: Array.isArray(row.supportedFileTypes)
        ? (row.supportedFileTypes as string[])
        : [],
      isVisible: Boolean(row.isVisible),
      exportAllowed,
      disabledReason,
    };
  });
}

export interface AssertAdapterExportReadySuccess {
  ok: true;
  adapter: BankExportAdapter;
}

export interface AssertAdapterExportReadyFailure {
  ok: false;
  code: string;
  message: string;
}

export type AssertAdapterExportReadyResult =
  | AssertAdapterExportReadySuccess
  | AssertAdapterExportReadyFailure;

const adapterCodeSchema = z.string().min(1).max(128);

export async function assertAdapterExportReady(
  adapterCode: string,
  opts: { tx?: unknown } = {},
): Promise<AssertAdapterExportReadyResult> {
  const conn = pickDbConn(opts.tx);

  const codeParse = adapterCodeSchema.safeParse(adapterCode);
  if (!codeParse.success) {
    return {
      ok: false,
      code: ADAPTER_NOT_FOUND,
      message: "Adapter not found",
    };
  }

  const row = (await conn
    .select()
    .from(bankExportAdaptersTable as any)
    .where(eq(bankExportAdaptersTable.adapterCode, codeParse.data))
    .limit(1))?.[0] as BankExportAdapter | undefined;

  if (!row) {
    return {
      ok: false,
      code: ADAPTER_NOT_FOUND,
      message: "Adapter not found",
    };
  }

  const status = (row.status as BankAdapterStatus) ?? "Upcoming";

  if (status === "Deprecated" && row.successorAdapterId != null) {
    return {
      ok: false,
      code: BANK_ADAPTER_DEPRECATED,
      message: "Adapter is deprecated, please use successor",
    };
  }

  if (status !== "Active") {
    return {
      ok: false,
      code: BANK_ADAPTER_NOT_ACTIVE,
      message: BANK_EXPORT_UPCOMING_DISABLED_MESSAGE,
    };
  }

  if (row.parserConfigJson == null || row.columnMappingJson == null) {
    return {
      ok: false,
      code: BANK_ADAPTER_CONFIG_INCOMPLETE,
      message: "Adapter configuration incomplete",
    };
  }

  return {
    ok: true,
    adapter: row,
  };
}
