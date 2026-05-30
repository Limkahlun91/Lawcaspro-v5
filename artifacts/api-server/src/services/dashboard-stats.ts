import { and, count, desc, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import {
  caseAssignmentsTable,
  caseKeyDatesTable,
  casesTable,
  clientsTable,
  developersTable,
  projectsTable,
  sql,
  usersTable,
  type RlsDb,
  db,
} from "@workspace/db";

type DbConn = typeof db | RlsDb;

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function tableExists(r: DbConn, reg: string): Promise<boolean> {
  const rows = await queryRows(r, sql`SELECT to_regclass(${reg}) AS reg`);
  return Boolean(rows[0]?.reg);
}

type DashboardStatsOpts = { assignedToUserId?: number; includeErrorDetails?: boolean; deadlineAt?: number };

type DashboardWarning = {
  module: string;
  code: string | null;
  message: string;
  stack?: string;
};

function toNumber0(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

function getPgCode(err: unknown): string | null {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : null;
}

function isMissingRelationOrColumnError(err: unknown): boolean {
  const code = getPgCode(err);
  return code === "42P01" || code === "42703" || code === "42501";
}

async function safeTableExists(r: DbConn, reg: string): Promise<boolean> {
  try {
    return await tableExists(r, reg);
  } catch {
    return false;
  }
}

export async function computeDashboardStats(
  r: DbConn,
  firmId: number,
  opts?: DashboardStatsOpts,
): Promise<Record<string, unknown>> {
  const warnings: DashboardWarning[] = [];
  const unavailableFields: string[] = [];
  const includeErrorDetails = Boolean(opts?.includeErrorDetails);
  const deadlineAt = typeof opts?.deadlineAt === "number" ? opts.deadlineAt : null;

  const warn = (module: string, err: unknown, fields?: string[]) => {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push({
      module,
      code: getPgCode(err),
      message: msg,
      ...(includeErrorDetails && err instanceof Error ? { stack: err.stack } : {}),
    });
    for (const f of fields ?? []) {
      if (!unavailableFields.includes(f)) unavailableFields.push(f);
    }
  };

  const deadlineExceeded = () => (deadlineAt != null ? Date.now() > deadlineAt : false);
  const deadlineSkip = (module: string, fields?: string[]) => {
    warnings.push({ module, code: "DEADLINE", message: "Skipped due to dashboard time budget" });
    for (const f of fields ?? []) {
      if (!unavailableFields.includes(f)) unavailableFields.push(f);
    }
  };

  const hasKeyDates = await safeTableExists(r, "public.case_key_dates");
  const hasCommunications = await safeTableExists(r, "public.case_communications");
  const hasBillingEntries = false;
  const hasCaseLedgers = false;

  const assignedToUserId = opts?.assignedToUserId;
  const assignedFilter = assignedToUserId ? { assignedToUserId: String(assignedToUserId) } : {};
  const assignedCasesJoin = assignedToUserId
    ? and(
        eq(caseAssignmentsTable.caseId, casesTable.id),
        eq(caseAssignmentsTable.userId, assignedToUserId),
        isNull(caseAssignmentsTable.unassignedAt),
      )
    : undefined;

  const countCases = async (where: SQL, fieldKey: string) => {
    try {
      const base = assignedCasesJoin
        ? r.select({ c: count() }).from(casesTable).innerJoin(caseAssignmentsTable, assignedCasesJoin)
        : r.select({ c: count() }).from(casesTable);
      const [row] = await base.where(where);
      return toNumber0(row?.c);
    } catch (err) {
      warn(`cases.${fieldKey}`, err, [fieldKey]);
      return 0;
    }
  };

  const totalCases = await countCases(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt)), "totalCases");
  const cashCases = await countCases(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt), eq(casesTable.purchaseMode, "cash")), "cashCases");
  const loanCases = await countCases(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt), eq(casesTable.purchaseMode, "loan")), "loanCases");
  const masterTitleCases = await countCases(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt), eq(casesTable.titleType, "master")), "masterTitleCases");
  const individualTitleCases = await countCases(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt), eq(casesTable.titleType, "individual")), "individualTitleCases");
  const strataTitleCases = await countCases(and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt), eq(casesTable.titleType, "strata")), "strataTitleCases");

  const completedCases = hasKeyDates
    ? (await (async () => {
        const base = assignedCasesJoin
          ? r.select({ c: count() }).from(casesTable)
              .innerJoin(caseAssignmentsTable, assignedCasesJoin)
              .leftJoin(caseKeyDatesTable, and(
                eq(caseKeyDatesTable.caseId, casesTable.id),
                eq(caseKeyDatesTable.firmId, casesTable.firmId),
              ))
          : r.select({ c: count() }).from(casesTable)
              .leftJoin(caseKeyDatesTable, and(
                eq(caseKeyDatesTable.caseId, casesTable.id),
                eq(caseKeyDatesTable.firmId, casesTable.firmId),
              ));
        try {
          const [row] = await base.where(and(
            eq(casesTable.firmId, firmId),
            isNull(casesTable.deletedAt),
            isNotNull(caseKeyDatesTable.completionDate),
          ));
          return toNumber0(row?.c);
        } catch (err) {
          if (!isMissingRelationOrColumnError(err)) {
            warn("cases.completedCases", err, ["completedCases"]);
            return 0;
          }
          return 0;
        }
      })())
    : 0;
  const activeCases = Math.max(0, totalCases - completedCases);

  const recentCases = await (async () => {
    if (deadlineExceeded()) {
      deadlineSkip("cases.recentCases", ["recentCases"]);
      return [];
    }
    try {
      const rows = await queryRows(r, sql`
        SELECT *
        FROM (
          SELECT DISTINCT ON (c.id)
            c.id,
            c.reference_no,
            c.purchase_mode,
            c.title_type,
            c.status,
            c.created_at,
            c.updated_at,
            COALESCE(p.name, 'Unknown') AS project_name,
            COALESCE(d.name, 'Unknown') AS developer_name,
            u.name AS assigned_lawyer_name,
            kd.advice_to_bank_date,
            kd.completion_sla_activated_at
          FROM cases c
          ${assignedToUserId
            ? sql`JOIN case_assignments caf ON caf.case_id = c.id AND caf.user_id = ${assignedToUserId} AND caf.unassigned_at IS NULL`
            : sql``}
          LEFT JOIN projects p ON p.id = c.project_id
          LEFT JOIN developers d ON d.id = c.developer_id
          LEFT JOIN LATERAL (
            SELECT ca.user_id
            FROM case_assignments ca
            WHERE ca.case_id = c.id AND ca.unassigned_at IS NULL
            ORDER BY ca.id DESC
            LIMIT 1
          ) ca1 ON TRUE
          LEFT JOIN users u ON u.id = ca1.user_id
          ${hasKeyDates ? sql`LEFT JOIN case_key_dates kd ON kd.case_id = c.id AND kd.firm_id = c.firm_id` : sql`LEFT JOIN LATERAL (SELECT NULL::date AS advice_to_bank_date, NULL::timestamptz AS completion_sla_activated_at) kd ON TRUE`}
          WHERE c.firm_id = ${firmId} AND c.deleted_at IS NULL
          ORDER BY c.id, c.updated_at DESC
        ) x
        ORDER BY x.updated_at DESC
        LIMIT 5
      `);

      return rows.map((row) => {
        const completionSlaActivatedAt = (row as any).completion_sla_activated_at as unknown;
        const adviceToBankDate = (row as any).advice_to_bank_date as unknown;
        const completionSla = (() => {
          if (!completionSlaActivatedAt) return null;
          if (adviceToBankDate) return null;
          const t = completionSlaActivatedAt instanceof Date
            ? completionSlaActivatedAt.getTime()
            : new Date(completionSlaActivatedAt as any).getTime();
          if (!Number.isFinite(t)) return null;
          const ms = Date.now() - t;
          const hours = Math.max(0, ms / 3600_000);
          const status = hours >= 72 ? "overdue" : hours >= 48 ? "soon" : "due";
          return { status, activatedAt: new Date(t).toISOString(), hoursElapsed: hours };
        })();

        return {
          id: Number((row as any).id),
          referenceNo: String((row as any).reference_no ?? ""),
          projectName: String((row as any).project_name ?? "Unknown"),
          developerName: String((row as any).developer_name ?? "Unknown"),
          purchaseMode: (row as any).purchase_mode ?? null,
          titleType: (row as any).title_type ?? null,
          status: (row as any).status ?? null,
          assignedLawyerName: typeof (row as any).assigned_lawyer_name === "string" ? String((row as any).assigned_lawyer_name) : null,
          completionSla,
          createdAt: (() => {
            const v = (row as any).created_at;
            const dt = v instanceof Date ? v : new Date(v as any);
            return Number.isFinite(dt.getTime()) ? dt.toISOString() : new Date().toISOString();
          })(),
        };
      });
    } catch (err) {
      warn("cases.recentCases", err, ["recentCases"]);
      return [];
    }
  })();

  const totalClients = await (async () => {
    try {
      const [row] = await r.select({ c: count() }).from(clientsTable).where(eq(clientsTable.firmId, firmId));
      return toNumber0(row?.c);
    } catch (err) {
      warn("counts.totalClients", err, ["totalClients"]);
      return 0;
    }
  })();
  const totalDevelopers = await (async () => {
    try {
      const [row] = await r.select({ c: count() }).from(developersTable).where(eq(developersTable.firmId, firmId));
      return toNumber0(row?.c);
    } catch (err) {
      warn("counts.totalDevelopers", err, ["totalDevelopers"]);
      return 0;
    }
  })();
  const totalProjects = await (async () => {
    try {
      const [row] = await r.select({ c: count() }).from(projectsTable).where(eq(projectsTable.firmId, firmId));
      return toNumber0(row?.c);
    } catch (err) {
      warn("counts.totalProjects", err, ["totalProjects"]);
      return 0;
    }
  })();

  const billing = hasBillingEntries
    ? (await (async () => {
        if (deadlineExceeded()) {
          deadlineSkip("billing.summary", ["billing"]);
          return {};
        }
        try {
          return (await queryRows(r, sql`
            SELECT
              SUM(amount * quantity) as total_billed,
              SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as total_paid,
              SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as total_outstanding
            FROM case_billing_entries WHERE firm_id = ${firmId}
          `))[0] ?? {};
        } catch (err) {
          warn("billing.summary", err, ["billing"]);
          return {};
        }
      })())
    : {};

  const outstandingAdvances = hasCaseLedgers
    ? (await (async () => {
        if (deadlineExceeded()) {
          deadlineSkip("accounting.outstandingAdvances", ["outstandingAdvances"]);
          return { caseCount: 0, totalAmount: 0, topCases: [] as any[] };
        }
        try {
          const [totals] = await queryRows(r, sql`
          SELECT
            COUNT(*) as case_count,
            COALESCE(SUM(outstanding_amount), 0) as total_amount
          FROM (
            SELECT
              cl.case_id,
              (
                COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
              ) as outstanding_amount
            FROM case_ledgers cl
            WHERE cl.firm_id = ${firmId}
            GROUP BY cl.case_id
            HAVING (
              COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
            ) > 0
          ) t
        `);
          const rows = await queryRows(r, sql`
          SELECT
            cl.case_id as case_id,
            c.reference_no as reference_no,
            COALESCE((
              SELECT string_agg(DISTINCT cc.name, ', ')
              FROM case_purchasers cp
              JOIN clients cc ON cc.id = cp.client_id
              WHERE cp.case_id = c.id
            ), '') as client_names,
            (
              COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
            ) as outstanding_amount
          FROM case_ledgers cl
          JOIN cases c ON c.id = cl.case_id AND c.firm_id = cl.firm_id
          WHERE cl.firm_id = ${firmId}
          GROUP BY cl.case_id, c.reference_no
          HAVING (
            COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_paid' THEN cl.amount ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN cl.entry_type = 'advance_recovered' THEN cl.amount ELSE 0 END), 0)
          ) > 0
          ORDER BY outstanding_amount DESC
          LIMIT 10
        `);
          const topCases = rows.map((rr) => ({
            caseId: toNumber0(rr.case_id),
            referenceNo: String(rr.reference_no ?? ""),
            clientNames: String(rr.client_names ?? "") || null,
            amount: toNumber0((rr as any).outstanding_amount),
          })).filter((x) => x.caseId > 0 && x.amount > 0);
          const caseCount = toNumber0((totals as any)?.case_count);
          const totalAmount = toNumber0((totals as any)?.total_amount);
          return { caseCount, totalAmount, topCases };
        } catch (err) {
          warn("accounting.outstandingAdvances", err, ["outstandingAdvances"]);
          return { caseCount: 0, totalAmount: 0, topCases: [] as any[] };
        }
      })())
    : { caseCount: 0, totalAmount: 0, topCases: [] as any[] };

  const commsThisMonth = hasCommunications
    ? await (async () => {
        if (deadlineExceeded()) {
          deadlineSkip("comms.thisMonth", ["commsThisMonth"]);
          return 0;
        }
        try {
          return Number((await queryRows(r, sql`
            SELECT COUNT(*) as total_this_month
            FROM case_communications
            WHERE firm_id = ${firmId}
            AND created_at >= date_trunc('month', NOW())
          `))[0]?.total_this_month ?? 0);
        } catch (err) {
          warn("comms.thisMonth", err, ["commsThisMonth"]);
          return 0;
        }
      })()
    : 0;

  const milestoneSections: any[] = [];
  const milestoneCards: any[] = [];

  const completionSlaOverdue = hasKeyDates
    ? await (async () => {
        if (deadlineExceeded()) {
          deadlineSkip("completionSla.overdue", ["completionSlaOverdue"]);
          return [];
        }
        try {
          return (await queryRows(r, sql`
            SELECT
              c.id as case_id,
              c.reference_no as reference_no,
              kd.completion_sla_activated_at as activated_at,
              EXTRACT(epoch FROM (now() - kd.completion_sla_activated_at)) / 3600.0 as hours_elapsed
            FROM case_key_dates kd
            JOIN cases c ON c.id = kd.case_id AND c.firm_id = kd.firm_id
            WHERE kd.firm_id = ${firmId}
              AND c.deleted_at IS NULL
              AND kd.completion_sla_activated_at IS NOT NULL
              AND kd.advice_to_bank_date IS NULL
              AND (now() - kd.completion_sla_activated_at) >= interval '72 hours'
            ORDER BY kd.completion_sla_activated_at ASC
            LIMIT 20
          `))
            .map((x) => ({
              caseId: toNumber0((x as any).case_id),
              referenceNo: String((x as any).reference_no ?? ""),
              activatedAt: (x as any).activated_at ? new Date(String((x as any).activated_at)).toISOString() : null,
              hoursElapsed: toNumber0((x as any).hours_elapsed),
            }))
            .filter((x) => x.caseId > 0);
        } catch (err) {
          if (!isMissingRelationOrColumnError(err)) throw err;
          return [];
        }
      })()
    : [];

  const debugDumpEnabled = process.env.DEBUG_DATA_DUMP === "1" && process.env.NODE_ENV !== "production";
  if (debugDumpEnabled) {
    console.log(
      "!!! DEBUG_DATA_DUMP:",
      JSON.stringify({
        module: "computeDashboardStats",
        firmId,
        totals: {
          totalCases,
          activeCases,
          completedCases,
          totalClients,
          totalDevelopers,
          totalProjects,
        },
        flags: {
          hasKeyDates,
          hasBillingEntries,
          hasCommunications,
          hasCaseLedgers,
        },
        shapes: {
          recentCases: recentCases.length,
          completionSlaOverdue: completionSlaOverdue.length,
        },
      })
    );
  }

  const degraded = warnings.length > 0 || unavailableFields.length > 0;
  return {
    ok: !degraded,
    degraded,
    warnings,
    unavailableFields,
    totalCases,
    activeCases,
    completedCases,
    totalClients,
    totalDevelopers,
    totalProjects,
    cashCases,
    loanCases,
    masterTitleCases,
    individualTitleCases,
    strataTitleCases,
    recentCases,
    billing: (() => {
      const row = billing as Record<string, unknown>;
      return {
        totalBilled: toNumber0(row.total_billed),
        totalPaid: toNumber0(row.total_paid),
        totalOutstanding: toNumber0(row.total_outstanding),
      };
    })(),
    outstandingAdvances,
    commsThisMonth,
    completionSlaOverdue,
    milestoneSections,
    milestoneCards,
  };
}
