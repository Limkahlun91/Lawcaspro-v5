import express, { type Response, type Router as ExpressRouter } from "express";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { one } from "../lib/http.js";
import { ApiError } from "../lib/api-response.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

export type BankAdapterStatus = "Upcoming" | "Beta" | "Active" | "Deprecated";
export interface BankAdapterDescriptor {
  adapterCode: string;
  displayName: string;
  status: BankAdapterStatus;
  exportAllowed: boolean;
  disabledReason?: string | null;
  formatType: "CSV_MAYBANK2025" | "MT940" | "CAMT053" | "XLSX_CIMB" | "CUSTOM";
  version: string;
}

const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const KNOWN_ADAPTERS: BankAdapterDescriptor[] = [
  {
    adapterCode: "MAYBANK",
    displayName: "Maybank",
    status: "Upcoming",
    exportAllowed: false,
    disabledReason: "Official file specification pending verification",
    formatType: "CSV_MAYBANK2025",
    version: "0.1.0-preview",
  },
  {
    adapterCode: "CIMB_CLICKS",
    displayName: "CIMB Clicks",
    status: "Upcoming",
    exportAllowed: false,
    disabledReason: "CSV/XLSX mapping under QA",
    formatType: "XLSX_CIMB",
    version: "0.1.0-preview",
  },
  {
    adapterCode: "PUBLIC_BANK",
    displayName: "Public Bank",
    status: "Upcoming",
    exportAllowed: false,
    disabledReason: "Bank bulk transfer format alignment pending",
    formatType: "CUSTOM",
    version: "0.1.0-preview",
  },
  {
    adapterCode: "HLB_FPX",
    displayName: "Hong Leong FPX / Bulk",
    status: "Upcoming",
    exportAllowed: false,
    disabledReason: "FPX integration spec awaiting finalization",
    formatType: "CUSTOM",
    version: "0.1.0-preview",
  },
  {
    adapterCode: "RHB_CAMT",
    displayName: "RHB CAMT.053 Statement",
    status: "Upcoming",
    exportAllowed: false,
    disabledReason: "camt.053 (ISO 20022) header mapping under review",
    formatType: "CAMT053",
    version: "0.1.0-preview",
  },
];

export function listBankAdapters(): BankAdapterDescriptor[] {
  return KNOWN_ADAPTERS.map((a) => ({ ...a }));
}

export interface AdapterReadiness {
  ok: boolean;
  code: string;
  message: string;
  adapter: BankAdapterDescriptor | null;
}

export async function assertAdapterExportReady(code: string, _opts?: { tx?: unknown }): Promise<AdapterReadiness> {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  const adapter = KNOWN_ADAPTERS.find((a) => a.adapterCode === normalized) ?? null;
  if (!adapter) {
    return { ok: false, code: "BANK_ADAPTER_UNKNOWN", message: `Bank adapter '${code}' is not registered in the platform registry`, adapter: null };
  }
  if (adapter.status !== "Active" || !adapter.exportAllowed) {
    return {
      ok: false,
      code: "BANK_ADAPTER_NOT_EXPORTABLE",
      message: adapter.disabledReason
        ? `Bank adapter '${adapter.adapterCode}' (${adapter.status}) does not allow export: ${adapter.disabledReason}`
        : `Bank adapter '${adapter.adapterCode}' (${adapter.status}) does not allow export yet`,
      adapter,
    };
  }
  return { ok: true, code: "OK", message: "", adapter };
}

router.get("/bank-adapters", requireAuth, requireFirmUser, requirePermission("finance", "read"), async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ adapters: listBankAdapters() });
});

router.post("/bank-adapters/:code/export", requireAuth, requireFirmUser, requirePermission("finance", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const code = one(req.params?.code) ?? "";
    const readiness = await assertAdapterExportReady(code, { tx: req.rlsDb });
    if (!readiness.ok) {
      res.status(409).json({ code: readiness.code, error: readiness.message, adapter: readiness.adapter });
      return;
    }
    if (!readiness.adapter?.exportAllowed) {
      throw new ApiError({
        status: 409,
        code: "BANK_ADAPTER_NOT_EXPORTABLE",
        message: "Export not allowed; Upcoming adapters must not produce files",
        retryable: false,
      });
    }
    const body = req.body as { batchId?: unknown; format?: unknown; entries?: unknown } ?? {};
    res.status(503).json({
      code: "BANK_ADAPTER_EXPORT_FILE_BUILDER_NOT_IMPLEMENTED",
      error: "Active export file builder is wired but file payload builder is behind a dedicated feature release; no file produced in PART 2 expansion",
      adapter: readiness.adapter,
      requested: {
        batchId: typeof body.batchId === "string" ? body.batchId : null,
        format: typeof body.format === "string" ? body.format : readiness.adapter.formatType,
      },
    });
  } catch (err: any) {
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "bank_adapters.export_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "BANK_ADAPTER_EXPORT_FAILED", error: err?.message ?? "Export failed" });
  }
});

export default expressRouter;
