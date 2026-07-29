import { describe, expect, it } from "vitest";

type ClientLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };

function makeClient(fixtures: {
  regclass?: Record<string, boolean>;
  columns?: Record<string, any>;
  indexes?: Record<string, string>;
  rls?: Record<string, { rls: boolean; force_rls: boolean }>;
  policies?: Record<string, { roles: string[]; cmd: string; qual: string; with_check: string }>;
  fks?: Record<string, { foreign_table: string; foreign_column: string; on_delete: string }>;
}): ClientLike {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const s = String(sql).toLowerCase();
      if (s.includes("select to_regclass")) {
        const name = String(params?.[0] ?? "");
        const ok = fixtures.regclass?.[name] ?? false;
        return { rows: [{ name: ok ? name : null }], rowCount: 1 };
      }
      if (s.includes("from information_schema.columns")) {
        const tableName = String(params?.[0] ?? "");
        const columnName = String(params?.[1] ?? "");
        const key = `${tableName}.${columnName}`;
        const row = fixtures.columns?.[key];
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (s.includes("from pg_indexes")) {
        const indexName = String(params?.[0] ?? "");
        const indexdef = fixtures.indexes?.[indexName];
        return { rows: indexdef ? [{ indexdef }] : [], rowCount: indexdef ? 1 : 0 };
      }
      if (s.includes("from pg_class c") && s.includes("relrowsecurity")) {
        const tableName = String(params?.[0] ?? "");
        const row = fixtures.rls?.[tableName];
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (s.includes("from pg_policies")) {
        const tableName = String(params?.[0] ?? "");
        const policyName = String(params?.[1] ?? "");
        const key = `${tableName}.${policyName}`;
        const row = fixtures.policies?.[key];
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (s.includes("from pg_constraint con") && s.includes("con.contype")) {
        const tableName = String(params?.[0] ?? "");
        const columnName = String(params?.[1] ?? "");
        const key = `${tableName}.${columnName}`;
        const row = fixtures.fks?.[key];
        return { rows: row ? [{ table_name: tableName, column_name: columnName, ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (s.includes("from permissions p") && s.includes("join roles r")) {
        return { rows: [{ c: 2 }], rowCount: 1 };
      }
      throw new Error(`unexpected query in test: ${sql}`);
    },
  };
}

function base0126Fixtures() {
  const expectedExpr =
    "current_setting('app.is_founder', true) = 'true' OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer";

  return {
    regclass: {
      "public.payment_voucher_create_requests": true,
      "public.permissions": true,
      "public.roles": true,
    },
    columns: {
      "payment_vouchers.client_request_id": {
        column_name: "client_request_id",
        data_type: "text",
        udt_name: "text",
        is_nullable: "YES",
        column_default: null,
      },
      "payment_voucher_create_requests.id": {
        column_name: "id",
        data_type: "integer",
        udt_name: "int4",
        is_nullable: "NO",
        column_default: "nextval('payment_voucher_create_requests_id_seq'::regclass)",
      },
      "payment_voucher_create_requests.firm_id": {
        column_name: "firm_id",
        data_type: "integer",
        udt_name: "int4",
        is_nullable: "NO",
        column_default: null,
      },
      "payment_voucher_create_requests.created_by_user_id": {
        column_name: "created_by_user_id",
        data_type: "integer",
        udt_name: "int4",
        is_nullable: "NO",
        column_default: null,
      },
      "payment_voucher_create_requests.client_request_id": {
        column_name: "client_request_id",
        data_type: "text",
        udt_name: "text",
        is_nullable: "NO",
        column_default: null,
      },
      "payment_voucher_create_requests.request_payload_hash": {
        column_name: "request_payload_hash",
        data_type: "text",
        udt_name: "text",
        is_nullable: "YES",
        column_default: null,
      },
      "payment_voucher_create_requests.status": {
        column_name: "status",
        data_type: "text",
        udt_name: "text",
        is_nullable: "NO",
        column_default: "'processing'::text",
      },
      "payment_voucher_create_requests.payment_voucher_id": {
        column_name: "payment_voucher_id",
        data_type: "integer",
        udt_name: "int4",
        is_nullable: "YES",
        column_default: null,
      },
      "payment_voucher_create_requests.last_error": {
        column_name: "last_error",
        data_type: "text",
        udt_name: "text",
        is_nullable: "YES",
        column_default: null,
      },
      "payment_voucher_create_requests.created_at": {
        column_name: "created_at",
        data_type: "timestamp with time zone",
        udt_name: "timestamptz",
        is_nullable: "NO",
        column_default: "now()",
      },
      "payment_voucher_create_requests.updated_at": {
        column_name: "updated_at",
        data_type: "timestamp with time zone",
        udt_name: "timestamptz",
        is_nullable: "NO",
        column_default: "now()",
      },
      "payment_voucher_create_requests.completed_at": {
        column_name: "completed_at",
        data_type: "timestamp with time zone",
        udt_name: "timestamptz",
        is_nullable: "YES",
        column_default: null,
      },
    },
    fks: {
      "payment_voucher_create_requests.firm_id": {
        foreign_table: "firms",
        foreign_column: "id",
        on_delete: "c",
      },
      "payment_voucher_create_requests.created_by_user_id": {
        foreign_table: "users",
        foreign_column: "id",
        on_delete: "r",
      },
      "payment_voucher_create_requests.payment_voucher_id": {
        foreign_table: "payment_vouchers",
        foreign_column: "id",
        on_delete: "n",
      },
    },
    indexes: {
      uq_payment_vouchers_client_request:
        "CREATE UNIQUE INDEX uq_payment_vouchers_client_request ON payment_vouchers USING btree (firm_id, client_request_id) WHERE (client_request_id IS NOT NULL)",
      uq_payment_voucher_create_requests_firm_user_key:
        "CREATE UNIQUE INDEX uq_payment_voucher_create_requests_firm_user_key ON payment_voucher_create_requests USING btree (firm_id, created_by_user_id, client_request_id)",
      idx_payment_voucher_create_requests_firm_status:
        "CREATE INDEX idx_payment_voucher_create_requests_firm_status ON payment_voucher_create_requests USING btree (firm_id, status, created_at DESC)",
      idx_payment_voucher_create_requests_firm_voucher:
        "CREATE INDEX idx_payment_voucher_create_requests_firm_voucher ON payment_voucher_create_requests USING btree (firm_id, payment_voucher_id)",
    },
    rls: {
      payment_voucher_create_requests: { rls: true, force_rls: true },
    },
    policies: {
      "payment_voucher_create_requests.payment_voucher_create_requests_rw": {
        roles: ["public"],
        cmd: "ALL",
        qual: expectedExpr,
        with_check: expectedExpr,
      },
    },
  };
}

describe("manual-migrations postconditions", () => {
  it("complete existing schema passes exact postconditions for 0126", async () => {
    const { verifyMigrationPostconditions } = await import(
      "../../../../lib/db/scripts/manual-migrations/postconditions.mjs"
    );

    const client = makeClient(base0126Fixtures());
    const res = await verifyMigrationPostconditions(client as any, "0126_payment_voucher_create_request_tracking");
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it("wrong policy expression returns partial_schema for 0126", async () => {
    const { verifyMigrationPostconditions } = await import(
      "../../../../lib/db/scripts/manual-migrations/postconditions.mjs"
    );

    const fixtures = base0126Fixtures();
    fixtures.policies["payment_voucher_create_requests.payment_voucher_create_requests_rw"] = {
      ...fixtures.policies["payment_voucher_create_requests.payment_voucher_create_requests_rw"],
      qual: "firm_id = 123",
    };
    const client = makeClient(fixtures);
    const res = await verifyMigrationPostconditions(client as any, "0126_payment_voucher_create_request_tracking");
    expect(res.ok).toBe(false);
    expect(res.issues.some((i: string) => i.includes("policy_using_mismatch"))).toBe(true);
  });

  it("wrong index column order returns partial_schema for 0126", async () => {
    const { verifyMigrationPostconditions } = await import(
      "../../../../lib/db/scripts/manual-migrations/postconditions.mjs"
    );

    const fixtures = base0126Fixtures();
    fixtures.indexes.uq_payment_vouchers_client_request =
      "CREATE UNIQUE INDEX uq_payment_vouchers_client_request ON payment_vouchers USING btree (client_request_id, firm_id) WHERE (client_request_id IS NOT NULL)";
    const client = makeClient(fixtures);
    const res = await verifyMigrationPostconditions(client as any, "0126_payment_voucher_create_request_tracking");
    expect(res.ok).toBe(false);
    expect(res.issues.some((i: string) => i.includes("index_uq_payment_vouchers_client_request_columns_mismatch"))).toBe(true);
  });
});

