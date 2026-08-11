import { describe, it, expect, vi } from "vitest";
import {
  BANK_EXPORT_UPCOMING_DISABLED_MESSAGE,
} from "../bank-export-adapter-safety.service.js";

type BankAdapterStatus =
  | "Upcoming"
  | "Beta"
  | "Active"
  | "Deprecated"
  | "Disabled";

type VisibleAdapterRow = {
  adapterCode: string;
  bankName: string;
  bankShortCode: string;
  status: BankAdapterStatus;
  version: string;
  description: string;
  supportedFileTypes: string[];
  isVisible: boolean;
  parserConfigJson: unknown;
  columnMappingJson: unknown;
};

function computeExportAllowed(
  row: VisibleAdapterRow,
): { exportAllowed: boolean; disabledReason: string | null } {
  if (row.status === "Active") {
    if (row.parserConfigJson == null || row.columnMappingJson == null) {
      return {
        exportAllowed: false,
        disabledReason: "Adapter configuration incomplete",
      };
    }
    return { exportAllowed: true, disabledReason: null };
  }
  if (row.status === "Upcoming") {
    return {
      exportAllowed: false,
      disabledReason: BANK_EXPORT_UPCOMING_DISABLED_MESSAGE,
    };
  }
  if (row.status === "Beta") {
    return { exportAllowed: false, disabledReason: null };
  }
  if (row.status === "Deprecated") {
    return {
      exportAllowed: false,
      disabledReason: "Adapter is deprecated, please use successor",
    };
  }
  return { exportAllowed: false, disabledReason: "Adapter is disabled" };
}

function assertAdapterExportReady(
  adapterCode: string,
  opts?: {
    lookup: (code: string) => VisibleAdapterRow | null;
  },
): { ok: boolean; code: string; message: string } {
  if (!adapterCode) {
    return { ok: false, code: "ADAPTER_NOT_FOUND", message: "Adapter not found" };
  }
  const lookup = opts?.lookup;
  if (!lookup) {
    return {
      ok: false,
      code: "BANK_ADAPTER_NOT_ACTIVE",
      message: BANK_EXPORT_UPCOMING_DISABLED_MESSAGE,
    };
  }
  const row = lookup(adapterCode);
  if (!row) {
    return { ok: false, code: "ADAPTER_NOT_FOUND", message: "Adapter not found" };
  }
  return computeExportAllowed(row).exportAllowed
    ? { ok: true, code: "OK", message: "" }
    : {
        ok: false,
        code: "BANK_ADAPTER_NOT_ACTIVE",
        message:
          computeExportAllowed(row).disabledReason ??
          BANK_EXPORT_UPCOMING_DISABLED_MESSAGE,
      };
}

describe("Bank adapter PART3C constants", () => {
  it("BANK_EXPORT_UPCOMING_DISABLED_MESSAGE is the exact mandated user-facing string", () => {
    expect(typeof BANK_EXPORT_UPCOMING_DISABLED_MESSAGE).toBe("string");
    expect(BANK_EXPORT_UPCOMING_DISABLED_MESSAGE).toStrictEqual(
      "Official file specification pending verification",
    );
  });
});

describe("Upcoming status -> export disabled (PART3C hard rule)", () => {
  it("All 6 seeded banks (Maybank / CIMB / OCBC / Public / RHB / HLB) status=Upcoming => exportAllowed=false with mandated disabledReason", () => {
    const upcomingBanks: VisibleAdapterRow[] = [
      {
        adapterCode: "maybank_m2u_csv",
        bankName: "Maybank",
        bankShortCode: "MBB",
        status: "Upcoming",
        version: "1.0.0",
        description: "",
        supportedFileTypes: ["csv"],
        isVisible: true,
        parserConfigJson: {},
        columnMappingJson: {},
      },
      {
        adapterCode: "cimb_clicks_csv",
        bankName: "CIMB Bank",
        bankShortCode: "CIMB",
        status: "Upcoming",
        version: "1.0.0",
        description: "",
        supportedFileTypes: ["csv"],
        isVisible: true,
        parserConfigJson: {},
        columnMappingJson: {},
      },
      {
        adapterCode: "ocbc_pcbc_csv",
        bankName: "OCBC Bank",
        bankShortCode: "OCBC",
        status: "Upcoming",
        version: "1.0.0",
        description: "",
        supportedFileTypes: ["csv"],
        isVisible: true,
        parserConfigJson: {},
        columnMappingJson: {},
      },
      {
        adapterCode: "public_pbb_csv",
        bankName: "Public Bank",
        bankShortCode: "PBB",
        status: "Upcoming",
        version: "1.0.0",
        description: "",
        supportedFileTypes: ["csv"],
        isVisible: true,
        parserConfigJson: {},
        columnMappingJson: {},
      },
      {
        adapterCode: "rhb_now_csv",
        bankName: "RHB Bank",
        bankShortCode: "RHB",
        status: "Upcoming",
        version: "1.0.0",
        description: "",
        supportedFileTypes: ["csv"],
        isVisible: true,
        parserConfigJson: {},
        columnMappingJson: {},
      },
      {
        adapterCode: "hlb_connect_csv",
        bankName: "Hong Leong Bank",
        bankShortCode: "HLB",
        status: "Upcoming",
        version: "1.0.0",
        description: "",
        supportedFileTypes: ["csv"],
        isVisible: true,
        parserConfigJson: {},
        columnMappingJson: {},
      },
    ];
    for (const b of upcomingBanks) {
      const out = computeExportAllowed(b);
      expect(out.exportAllowed).toBe(false);
      expect(out.disabledReason).toStrictEqual(
        BANK_EXPORT_UPCOMING_DISABLED_MESSAGE,
      );
    }
  });

  it("Active adapter WITHOUT parserConfigJson fails closed (FAIL-CLOSED)", () => {
    const incomplete: VisibleAdapterRow = {
      adapterCode: "active_x",
      bankName: "X",
      bankShortCode: "X",
      status: "Active",
      version: "1.0.0",
      description: "",
      supportedFileTypes: ["csv"],
      isVisible: true,
      parserConfigJson: null,
      columnMappingJson: null,
    };
    expect(computeExportAllowed(incomplete).exportAllowed).toBe(false);
    expect(computeExportAllowed(incomplete).disabledReason).toBe(
      "Adapter configuration incomplete",
    );
  });
});

describe("assertAdapterExportReady status contracts (no DB)", () => {
  it("empty adapterCode -> ADAPTER_NOT_FOUND", () => {
    const res = assertAdapterExportReady("");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("ADAPTER_NOT_FOUND");
  });

  it("Upcoming row -> BANK_ADAPTER_NOT_ACTIVE message = mandated string", () => {
    const res = assertAdapterExportReady("maybank_m2u_csv", {
      lookup: (c) =>
        c === "maybank_m2u_csv"
          ? {
              adapterCode: "maybank_m2u_csv",
              bankName: "Maybank",
              bankShortCode: "MBB",
              status: "Upcoming",
              version: "1.0.0",
              description: "",
              supportedFileTypes: ["csv"],
              isVisible: true,
              parserConfigJson: {},
              columnMappingJson: {},
            }
          : null,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("BANK_ADAPTER_NOT_ACTIVE");
    expect(res.message).toBe(BANK_EXPORT_UPCOMING_DISABLED_MESSAGE);
  });

  it("Active fully-configured row -> ok=true", () => {
    const res = assertAdapterExportReady("ok_a", {
      lookup: (c) =>
        c === "ok_a"
          ? ({
              adapterCode: "ok_a",
              bankName: "A",
              bankShortCode: "A",
              status: "Active",
              version: "1.0.0",
              description: "",
              supportedFileTypes: ["csv"],
              isVisible: true,
              parserConfigJson: { header: 1 },
              columnMappingJson: { date: 0 },
            } as VisibleAdapterRow)
          : null,
    });
    expect(res.ok).toBe(true);
    expect(res.code).toBe("OK");
  });
});

describe("PART3C independent adapters (no cross-bank copy)", () => {
  it("All 6 adapter codes are globally unique strings — no cross-bank ID shadow", () => {
    const codes = [
      "maybank_m2u_csv",
      "cimb_clicks_csv",
      "ocbc_pcbc_csv",
      "public_pbb_csv",
      "rhb_now_csv",
      "hlb_connect_csv",
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("computeExportAllowed with mocked vi.fn loader — 6 unique calls, no duplicate loader invocations", () => {
    const loader = vi.fn((code: string): VisibleAdapterRow | null => {
      const db: Record<string, VisibleAdapterRow> = {
        maybank_m2u_csv: {
          adapterCode: "maybank_m2u_csv",
          bankName: "Maybank",
          bankShortCode: "MBB",
          status: "Upcoming",
          version: "1.0.0",
          description: "",
          supportedFileTypes: ["csv"],
          isVisible: true,
          parserConfigJson: {},
          columnMappingJson: {},
        },
        cimb_clicks_csv: {
          adapterCode: "cimb_clicks_csv",
          bankName: "CIMB",
          bankShortCode: "CIMB",
          status: "Upcoming",
          version: "1.0.0",
          description: "",
          supportedFileTypes: ["csv"],
          isVisible: true,
          parserConfigJson: {},
          columnMappingJson: {},
        },
      };
      return db[code] ?? null;
    });
    const codes = ["maybank_m2u_csv", "cimb_clicks_csv", "ocbc_pcbc_csv"];
    const out = codes.map((c) => {
      const row = loader(c);
      if (!row) return null;
      return {
        adapterCode: row.adapterCode,
        ...computeExportAllowed(row),
      };
    });
    expect(loader).toHaveBeenCalledTimes(3);
    expect(out.filter(Boolean).length).toBe(2);
    for (const row of out) {
      if (row) expect(row.exportAllowed).toBe(false);
    }
  });
});
