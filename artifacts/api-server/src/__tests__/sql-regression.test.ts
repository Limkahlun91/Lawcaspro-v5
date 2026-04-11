import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { daysAgoSql } from "../lib/dateSql";
import { milestoneDateSql, milestoneDateYmdSql } from "../lib/caseListLogic";

const dialect = new PgDialect();

describe("SQL regression guards", () => {
  it("daysAgoSql does not embed parameter placeholders inside INTERVAL literals", () => {
    const q = dialect.sqlToQuery(daysAgoSql(7));
    expect(q.sql).not.toMatch(/INTERVAL\s+'\$\d+/);
  });

  it("milestone helpers keep DATE types until final display cast", () => {
    const d = dialect.sqlToQuery(milestoneDateSql("loan_docs_signed_date"));
    expect(d.sql).not.toContain("::text");

    const y = dialect.sqlToQuery(milestoneDateYmdSql("loan_docs_signed_date"));
    expect(y.sql).toContain("::text");
  });
});

