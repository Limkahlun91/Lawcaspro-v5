import { sql, type SQL } from "@workspace/db";

export function daysAgoSql(days: number): SQL<Date> {
  return sql<Date>`(CURRENT_DATE - (${days} * INTERVAL '1 day'))::date`;
}
