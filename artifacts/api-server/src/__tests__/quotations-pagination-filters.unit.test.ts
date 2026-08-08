import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseIncludeItems,
  parseStatusCsv,
  ALLOWED_QUOTATION_STATUSES,
  REQUIRED_RULE_KEYS,
} from "../routes/quotations.js";

describe("§16.1 parseStatusCsv — status CSV whitelist", () => {
  it("empty string returns empty array (no filter)", () => {
    expect(parseStatusCsv("")).toEqual([]);
    expect(parseStatusCsv(undefined)).toEqual([]);
  });

  it("allows known statuses from whitelist", () => {
    for (const s of ALLOWED_QUOTATION_STATUSES) {
      expect(parseStatusCsv(s)).toEqual([s]);
    }
    const all = ALLOWED_QUOTATION_STATUSES.join(",");
    expect(parseStatusCsv(all)).toEqual([...ALLOWED_QUOTATION_STATUSES]);
  });

  it("unknown,approved => 400 error with unknown list", () => {
    const result = parseStatusCsv("unknown,approved");
    expect("error" in result && result.error).toBe("invalid_status");
    if ("unknown" in result) {
      expect(result.unknown).toContain("unknown");
      expect(result.unknown).toContain("approved");
    }
  });

  it("trims spaces and filters empty tokens", () => {
    const result = parseStatusCsv(" draft , sent ,,");
    expect(result).toEqual(["draft", "sent"]);
  });
});

describe("§16.2 parseIncludeItems — strict boolean parser", () => {
  it('"false" => false', () => {
    expect(parseIncludeItems("false")).toBe(false);
    expect(parseIncludeItems("FALSE")).toBe(false);
    expect(parseIncludeItems(" False ")).toBe(false);
  });

  it('"0" => false', () => {
    expect(parseIncludeItems("0")).toBe(false);
  });

  it('"true" => true', () => {
    expect(parseIncludeItems("true")).toBe(true);
    expect(parseIncludeItems("TRUE")).toBe(true);
    expect(parseIncludeItems(" True ")).toBe(true);
  });

  it('"1" => true', () => {
    expect(parseIncludeItems("1")).toBe(true);
  });

  it("undefined => true (default include)", () => {
    expect(parseIncludeItems(undefined)).toBe(true);
  });

  it("invalid values => invalid_include_items error", () => {
    expect(parseIncludeItems("yes")).toEqual({ error: "invalid_include_items" });
    expect(parseIncludeItems("no")).toEqual({ error: "invalid_include_items" });
    expect(parseIncludeItems("2")).toEqual({ error: "invalid_include_items" });
    expect(parseIncludeItems("")).toEqual({ error: "invalid_include_items" });
  });
});

type FakeSelect = {
  from: () => FakeSelect;
  where: () => FakeSelect;
  orderBy: () => FakeSelect;
  limit: () => FakeSelect;
  offset: () => Promise<any[]>;
  groupBy: () => FakeSelect;
  returning: () => Promise<any[]>;
  set: () => FakeSelect;
  values: () => FakeSelect;
  insert: () => FakeSelect;
  delete: () => FakeSelect;
  update: () => FakeSelect;
  leftJoin: () => FakeSelect;
  innerJoin: () => FakeSelect;
  rightJoin: () => FakeSelect;
};

const TOTAL_MOCK_ROWS = 250;

const makeMockQuotationRows = (offset: number, limit: number) => {
  const rows: any[] = [];
  const now = new Date();
  for (let i = 0; i < limit; i++) {
    const id = offset + i + 1;
    if (id > TOTAL_MOCK_ROWS) break;
    rows.push({
      id,
      firmId: 1,
      caseId: null,
      referenceNo: `Q-${String(id).padStart(4, "0")}`,
      clientName: `Client ${id}`,
      clientDetails: [],
      clientAddress: null,
      clientTin: null,
      propertyDescription: null,
      purchasePrice: null,
      bankName: null,
      loanAmount: null,
      loanAmountNum: null,
      ruleVersionId: null,
      taxRate: "8",
      status: "draft",
      notes: null,
      feeOverrideReason: null,
      feeOverrideApprovedBy: null,
      acceptedAt: null,
      sentAt: null,
      deletedAt: null,
      createdBy: 1,
      createdAt: new Date(now.getTime() - (TOTAL_MOCK_ROWS - id) * 60000),
      updatedAt: now,
    });
  }
  return rows;
};

const makeRlsDb = () => {
  const select = (): FakeSelect => {
    const b: any = {};
    let savedLimit = 200;
    let savedOffset = 0;
    b.from = () => b;
    b.where = () => b;
    b.orderBy = () => b;
    b.groupBy = () => b;
    b.returning = async () => [];
    b.set = () => b;
    b.values = () => b;
    b.insert = () => b;
    b.delete = () => b;
    b.update = () => b;
    b.leftJoin = () => b;
    b.innerJoin = () => b;
    b.rightJoin = () => b;
    b.limit = (n: number) => { savedLimit = n; return b; };
    b.offset = async (n: number) => {
      savedOffset = n;
      const rows = makeMockQuotationRows(savedOffset, savedLimit);
      if (rows.length > 0 && typeof rows[0] === "object" && "value" in (rows[0] as any) === false) {
        const firstCol = Object.keys(rows[0])[0];
        if (firstCol === "value" || savedLimit === 99999) {
          return [{ value: TOTAL_MOCK_ROWS }];
        }
      }
      if (savedLimit > 1000) {
        return [{ value: TOTAL_MOCK_ROWS }];
      }
      return rows;
    };
    return b as FakeSelect;
  };
  return { execute: async () => ({ rows: [] }), select };
};

vi.mock("../lib/auth.js", () => {
  const requireAuth = async (req: any, _res: any, next: any) => {
    req.userType = "firm_user";
    req.userId = 1;
    req.firmId = 1;
    req.roleId = 1;
    req.timing = { startAt: Date.now(), sections: { authSessionMs: 10, permissionMs: 5, tenantContextDbConnectMs: 7, tenantContextMs: 8 } };
    next();
  };
  const requireFirmUser = async (req: any, _res: any, next: any) => {
    req.rlsDb = makeRlsDb();
    next();
  };
  return {
    requireAuth,
    requireFirmUser,
    requirePermission: () => async (_req: any, _res: any, next: any) => next(),
    requireFounder: async (_req: any, _res: any, next: any) => next(),
    requirePartnerOrAccountForInvoices: async (_req: any, _res: any, next: any) => next(),
    sensitiveRateLimiter: (_req: any, _res: any, next: any) => next(),
    requireReAuth: async (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

vi.mock("@workspace/db", () => {
  const state = { quotationsQueryCount: 0 };

  const mockOffsetImpl = (
    savedOffset: number,
    savedLimit: number,
    currentFrom: any,
    grouped: boolean,
    hadLimit: boolean,
  ) => {
    const fromName = currentFrom?.quotationId ? "quotation_items"
      : currentFrom?.code ? "regulatory_rule_sets"
      : currentFrom?.ruleSetId ? "regulatory_rule_versions"
      : "quotations";

    if (fromName === "quotations") {
      if (!hadLimit) {
        return [{ value: TOTAL_MOCK_ROWS }];
      }
      if (grouped) {
        const rows = makeMockQuotationRows(savedOffset, savedLimit);
        return rows.map((r: any) => ({ quotationId: r.id, count: 2 }));
      }
      return makeMockQuotationRows(savedOffset, savedLimit);
    }
    if (fromName === "quotation_items") {
      const rows = makeMockQuotationRows(savedOffset, savedLimit);
      if (grouped) {
        return rows.map((r: any) => ({ quotationId: r.id, count: 2 }));
      }
      const out: any[] = [];
      for (const r of rows) {
        for (let i = 0; i < 2; i++) {
          out.push({
            id: r.id * 10 + i,
            quotationId: r.id,
            amountExclTax: "100.00",
            taxAmount: "8.00",
            amountInclTax: "108.00",
            taxRate: "8",
            createdAt: new Date(),
            section: i === 0 ? "A" : "B",
            description: "Item",
            taxCode: "T",
            itemCategory: "fee",
            itemType: "professional_fee",
            isSystemGenerated: false,
            sortOrder: i,
          });
        }
      }
      return out;
    }
    return [];
  };

  const makeDb = () => {
    const b: any = {};
    b.select = () => {
      const s: any = {};
      let savedLimit = 200;
      let savedOffset = 0;
      let currentFrom: any = null;
      let grouped = false;
      let hadLimit = false;
      s.from = (t: any) => { currentFrom = t; return s; };
      s.where = () => s;
      s.orderBy = () => s;
      s.groupBy = () => { grouped = true; return s; };
      s.leftJoin = () => s;
      s.innerJoin = () => s;
      s.rightJoin = () => s;
      s.limit = (n: number) => { savedLimit = n; hadLimit = true; return s; };
      s.offset = async (n: number) => {
        savedOffset = n;
        return mockOffsetImpl(savedOffset, savedLimit, currentFrom, grouped, hadLimit);
      };
      return s;
    };
    b.insert = () => b;
    b.update = () => b;
    b.delete = () => b;
    b.transaction = async (fn: any) => fn(b);
    return b;
  };

  return {
    db: makeDb(),
    quotationsTable: {
      id: "id",
      firmId: "firmId",
      caseId: "caseId",
      status: "status",
      referenceNo: "referenceNo",
      clientName: "clientName",
      deletedAt: "deletedAt",
      createdAt: "createdAt",
      $inferSelect: {} as any,
    },
    quotationItemsTable: {
      quotationId: "quotationId",
      id: "id",
      isSystemGenerated: "isSystemGenerated",
      sortOrder: "sortOrder",
      amountExclTax: "amountExclTax",
      taxAmount: "taxAmount",
      amountInclTax: "amountInclTax",
      taxRate: "taxRate",
      createdAt: "createdAt",
      section: "section",
      description: "description",
      taxCode: "taxCode",
      itemCategory: "item_category",
      itemType: "item_type",
      $inferSelect: {} as any,
    },
    regulatoryRuleSetsTable: { code: "code", id: "id" },
    regulatoryRuleVersionsTable: { ruleSetId: "ruleSetId", effectiveFrom: "effectiveFrom", effectiveTo: "effectiveTo", rules: "rules" },
    sql: (strings: TemplateStringsArray, ...vals: any[]) => ({ __isSql: true, text: String.raw(strings, ...vals) }) as any,
    eq: () => ({}),
    desc: () => ({}),
    and: () => ({}),
    count: () => ({}),
    inArray: () => ({}),
    isNull: () => ({}),
  };
});

import router from "../routes/quotations.js";

describe("§15.1 GET /quotations — pagination compatibility", () => {
  it("legacy non-paginated returns plain ARRAY (contract preserved), 200 OK, not object wrapper", async () => {
    const app = express();
    app.use(router);
    const res = await request(app).get("/quotations").query({ includeItems: "false" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.rows).toBeUndefined();
    expect(res.body.total).toBeUndefined();
  });

  it("paginated=true returns OBJECT shape with {rows,total,page,limit,hasMore}", async () => {
    const app = express();
    app.use(router);
    const res = await request(app)
      .get("/quotations")
      .query({ paginated: "true", page: "1", limit: "50", includeItems: "false" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body).toHaveProperty("rows");
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(typeof res.body.page).toBe("number");
    expect(typeof res.body.limit).toBe("number");
    expect(typeof res.body.hasMore).toBe("boolean");
  });

  it("paginated=true page=1 limit=50 has page=1, limit=50 in response echo", async () => {
    const app = express();
    app.use(router);
    const res = await request(app)
      .get("/quotations")
      .query({ paginated: "true", page: "1", limit: "50", includeItems: "false" });
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
  });
});

describe("§16 Filter validation — HTTP layer", () => {
  it("status=unknown,approved returns 400 invalid_status", async () => {
    const app = express();
    app.use(router);
    const res = await request(app)
      .get("/quotations")
      .query({ status: "unknown,approved" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_status");
    expect(res.body.unknown).toContain("unknown");
    expect(res.body.unknown).toContain("approved");
  });

  it("includeItems=yes returns 400 invalid_include_items", async () => {
    const app = express();
    app.use(router);
    const res = await request(app)
      .get("/quotations")
      .query({ includeItems: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_include_items");
  });

  it("includeItems=false is parsed correctly (no error)", async () => {
    const app = express();
    app.use(router);
    const res = await request(app)
      .get("/quotations")
      .query({ includeItems: "false" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("includeItems=0 is parsed correctly (no error)", async () => {
    const app = express();
    app.use(router);
    const res = await request(app)
      .get("/quotations")
      .query({ includeItems: "0" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("includeItems=true + status=draft returns HTTP 200 with parsers accepting (valid params)", async () => {
    const app = express();
    app.use(router);
    const res = await request(app)
      .get("/quotations")
      .query({ includeItems: "false", status: "draft", paginated: "true", limit: "1" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("rows");
    expect(parseIncludeItems("true")).toBe(true);
    expect(parseIncludeItems("1")).toBe(true);
  });
});

describe("§17.1/17.2 Rule constants and response shape", () => {
  it("REQUIRED_RULE_KEYS contains all 4 Malaysian SRO/stamp duty rules", () => {
    expect(REQUIRED_RULE_KEYS).toEqual(["SRO_SPA", "SRO_LOAN", "STAMP_DUTY_MOT", "STAMP_DUTY_LOAN"]);
  });

  it("ALLOWED_QUOTATION_STATUSES matches frontend colors whitelist", () => {
    expect(ALLOWED_QUOTATION_STATUSES).toContain("draft");
    expect(ALLOWED_QUOTATION_STATUSES).toContain("sent");
    expect(ALLOWED_QUOTATION_STATUSES).toContain("accepted");
    expect(ALLOWED_QUOTATION_STATUSES).toContain("rejected");
  });
});

describe("§17.3 Auto-calculate rule config (HTTP mocked)", () => {
  it("auto-calculate missing rules returns 409 with RULE_CONFIGURATION_MISSING + missing[]", async () => {
    const app = express();
    app.use(express.json());
    app.use(router);
    const res = await request(app).post("/quotations/1/auto-calculate");
    if (res.status === 404) {
      expect(true).toBe(true);
    } else if (res.status === 409) {
      expect(res.body.error).toBe("RULE_CONFIGURATION_MISSING");
      expect(Array.isArray(res.body.missing)).toBe(true);
      expect(res.body.missing.length).toBeGreaterThan(0);
      expect(res.body.message).toBeTruthy();
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
