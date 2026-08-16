import type { InferSelectModel, SQL } from "drizzle-orm";
import { caseAssignmentsTable, caseKeyDatesTable, casePurchasersTable, casesTable, caseWorkflowStepsTable, clientsTable, developersTable, projectsTable, usersTable, type RlsDb, db } from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

export type DevPortalStatus =
  | "Completed"
  | "In Progress"
  | "Pending"
  | "Not Yet Required"
  | "Attention Required";

export type DevPortalStageFilter =
  | "all"
  | "spa"
  | "spa_stamped"
  | "loan"
  | "attention"
  | "completed";

export type UnitLabelPrioritySource = {
  parcelNo?: string | null;
  propertyDetails?: {
    unitNo?: string | null;
    parcelNo?: string | null;
    lotNo?: string | null;
    hakmilikNo?: string | null;
    titleNo?: string | null;
    address?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    addressLine3?: string | null;
    addressLine4?: string | null;
    addressLine5?: string | null;
  } | null;
  projectName?: string | null;
  phase?: string | null;
  referenceNo?: string | null;
};

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function getDeveloperPortalUnitLabel(c: UnitLabelPrioritySource): string {
  const pd = c.propertyDetails;

  const unitNo = isNonEmptyString(pd?.unitNo) ? pd!.unitNo : null;
  if (unitNo) return `Unit ${unitNo}`.trim();

  const parcelFromDetails = isNonEmptyString(pd?.parcelNo) ? pd!.parcelNo : null;
  const parcelDirect = isNonEmptyString(c.parcelNo) ? c.parcelNo : null;
  const parcel = parcelFromDetails ?? parcelDirect;
  const lot = isNonEmptyString(pd?.lotNo) ? pd!.lotNo : null;
  const hak = isNonEmptyString(pd?.hakmilikNo) ? pd!.hakmilikNo : null;
  const title = isNonEmptyString(pd?.titleNo) ? pd!.titleNo : null;

  if (parcel && lot) return `${parcel} (${lot})`;
  if (parcel) return parcel;
  if (lot) return `Lot ${lot}`;
  if (hak) return `Hakmilik ${hak}`;
  if (title) return `Title ${title}`;

  const addr = [pd?.address, pd?.addressLine1, pd?.addressLine2, pd?.addressLine3, pd?.addressLine4, pd?.addressLine5]
    .map((v) => (isNonEmptyString(v) ? v!.trim() : null))
    .filter((v): v is string => !!v);
  if (addr.length) return addr[0].length > 60 ? `${addr[0].slice(0, 57)}...` : addr[0];

  const proj = isNonEmptyString(c.projectName) ? c.projectName!.trim() : null;
  const phase = isNonEmptyString(c.phase) ? c.phase!.trim() : null;
  const ref = isNonEmptyString(c.referenceNo) ? c.referenceNo!.trim() : null;
  if (proj && ref) return phase ? `${proj} · ${phase} · ${ref}` : `${proj} · ${ref}`;
  if (ref) return phase ? `Ref ${ref} · ${phase}` : `Ref ${ref}`;
  if (proj) return phase ? `${proj} · ${phase}` : proj!;
  if (phase) return phase!;

  return "Unit";
}

export type KeyDatesRow = Partial<
  InferSelectModel<typeof caseKeyDatesTable> & Record<string, unknown>
>;

export function ageDays(from: Date | string | null | undefined, now: Date = new Date()): number {
  if (!from) return 0;
  const d = typeof from === "string" ? new Date(from) : from;
  if (!Number.isFinite(d.getTime())) return 0;
  const ms = now.getTime() - d.getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

export type SpaLoanStage = "pre_spa" | "spa" | "spa_stamped" | "loan" | "mot" | "completed";

export function classifySpaLoanStage(kd: KeyDatesRow): SpaLoanStage {
  if (kd.completionDate) return "completed";
  if (
    kd.motReceivedDate ||
    kd.motSignedDate ||
    kd.motStampedDate ||
    kd.motRegisteredDate ||
    kd.dischargeTitleReceivedOn ||
    kd.consentToTransferDate
  ) {
    return "mot";
  }
  if (
    kd.actingLetterIssuedDate ||
    kd.bankLuReceivedDate ||
    kd.adviceToBankDate ||
    kd.letterOfOfferDate ||
    kd.letterOfOfferStampedDate ||
    kd.loanDocsSignedDate ||
    kd.loanDocsPendingDate ||
    kd.loanAgreementDated
  ) {
    return "loan";
  }
  if (kd.spaStampedDate) return "spa_stamped";
  if (kd.spaSignedDate || kd.spaDate) return "spa";
  return "pre_spa";
}

export function classifyCurrentStageLabel(
  stage: SpaLoanStage,
  status?: string | null,
): string {
  switch (stage) {
    case "completed":
      return "Completed / Handover";
    case "mot":
      return "MOT / Title";
    case "loan":
      return status && isNonEmptyString(status) ? status : "Loan Documentation";
    case "spa_stamped":
      return "SPA Stamped";
    case "spa":
      return "SPA Signing";
    case "pre_spa":
    default:
      return status && isNonEmptyString(status) ? status : "File Opened";
  }
}

function dateOrNull(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

function ymdOrNull(v: unknown): string | null {
  const d = dateOrNull(v);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type StatusWithDate = {
  status: DevPortalStatus;
  label: string;
  date?: string | null;
  attention?: boolean;
  waitingFor?: string | null;
  ageDays?: number;
};

const ATTENTION_THRESHOLD_DAYS = 5;

export function deriveSpaStatus(kd: KeyDatesRow): StatusWithDate {
  const stamped = ymdOrNull(kd.spaStampedDate);
  if (stamped) return { status: "Completed", label: "SPA Stamped", date: stamped };
  const signed = ymdOrNull(kd.spaSignedDate);
  if (signed) return { status: "In Progress", label: "SPA Signing", date: signed };
  const fwdExec = dateOrNull(kd.spaForwardToDeveloperExecutionOn);
  if (fwdExec) {
    const d = ageDays(fwdExec);
    if (d > ATTENTION_THRESHOLD_DAYS) {
      return {
        status: "Attention Required",
        label: "SPA Signing",
        date: ymdOrNull(fwdExec),
        waitingFor: "Purchaser execution",
        ageDays: d,
        attention: true,
      };
    }
    return {
      status: "In Progress",
      label: "SPA Signing",
      date: ymdOrNull(fwdExec),
      waitingFor: "Purchaser execution",
      ageDays: d,
    };
  }
  const spaD = ymdOrNull(kd.spaDate);
  if (spaD) return { status: "Pending", label: "SPA Date", date: spaD };
  return { status: "In Progress", label: "SPA Preparation" };
}

export function deriveLoanStatus(kd: KeyDatesRow, mode?: string | null): StatusWithDate {
  const purchaseMode = String(mode ?? "cash");
  if (purchaseMode === "cash" && !kd.letterOfOfferDate && !kd.bankLuReceivedDate && !kd.actingLetterIssuedDate) {
    return { status: "Not Yet Required", label: "Loan (Cash Purchase)" };
  }
  const bankLu = ymdOrNull(kd.bankLuReceivedDate);
  if (bankLu) return { status: "Completed", label: "Bank LU Received", date: bankLu };
  const acting = ymdOrNull(kd.actingLetterIssuedDate);
  if (acting) {
    const bankLuPending = dateOrNull(kd.actingLetterIssuedDate);
    const d = bankLuPending ? ageDays(bankLuPending) : 0;
    if (d > ATTENTION_THRESHOLD_DAYS) {
      return {
        status: "Attention Required",
        label: "Acting Letter Issued",
        date: acting,
        waitingFor: "Bank (LU)",
        ageDays: d,
        attention: true,
      };
    }
    return {
      status: "In Progress",
      label: "Acting Letter Issued",
      date: acting,
      waitingFor: "Bank (LU)",
      ageDays: d,
    };
  }
  const loStamp = ymdOrNull(kd.letterOfOfferStampedDate);
  if (loStamp) return { status: "In Progress", label: "Loan Documentation", date: loStamp };
  const lo = ymdOrNull(kd.letterOfOfferDate);
  if (lo) return { status: "In Progress", label: "Letter of Offer", date: lo };
  if (kd.spaSignedDate || kd.spaStampedDate) {
    return { status: "Pending", label: "Loan Documentation" };
  }
  return { status: "Not Yet Required", label: "Loan Documentation" };
}

export function deriveMotStatus(kd: KeyDatesRow, stage: SpaLoanStage): StatusWithDate {
  if (stage !== "mot" && stage !== "completed") {
    return { status: "Not Yet Required", label: "MOT / Title" };
  }
  const motReg = ymdOrNull(kd.motRegisteredDate);
  if (motReg) return { status: "Completed", label: "MOT Registered", date: motReg };
  const motStamp = ymdOrNull(kd.motStampedDate);
  if (motStamp) return { status: "In Progress", label: "MOT Stamped", date: motStamp };
  const motSigned = ymdOrNull(kd.motSignedDate);
  if (motSigned) return { status: "In Progress", label: "MOT Signed", date: motSigned };
  const motRecv = ymdOrNull(kd.motReceivedDate);
  if (motRecv) return { status: "In Progress", label: "MOT Received", date: motRecv };
  return { status: "Pending", label: "MOT / Title" };
}

export type NextAction = {
  label: string;
  waitingFor: string;
  since: string | null;
  ageDays: number;
  attentionRequired: boolean;
};

export function deriveNextAction(kd: KeyDatesRow, mode?: string | null): NextAction | null {
  const spa = deriveSpaStatus(kd);
  if (spa.attention || spa.status === "In Progress") {
    if (spa.date || spa.waitingFor) {
      return {
        label: spa.label,
        waitingFor: spa.waitingFor ?? "Law Firm",
        since: spa.date ?? null,
        ageDays: spa.ageDays ?? 0,
        attentionRequired: !!spa.attention,
      };
    }
  }
  const loan = deriveLoanStatus(kd, mode);
  if (loan.attention || (loan.status === "In Progress" && spa.status === "Completed")) {
    return {
      label: loan.label,
      waitingFor: loan.waitingFor ?? "Bank",
      since: loan.date ?? null,
      ageDays: loan.ageDays ?? 0,
      attentionRequired: !!loan.attention,
    };
  }
  const stage = classifySpaLoanStage(kd);
  const mot = deriveMotStatus(kd, stage);
  if ((mot.status === "In Progress" || mot.status === "Pending") && (stage === "mot" || stage === "completed")) {
    return {
      label: mot.label,
      waitingFor: "Land Office / Parties",
      since: mot.date ?? null,
      ageDays: 0,
      attentionRequired: !!mot.attention,
    };
  }
  if (stage === "completed") {
    return {
      label: "Handover / Completed",
      waitingFor: "—",
      since: ymdOrNull(kd.completionDate) ?? null,
      ageDays: 0,
      attentionRequired: false,
    };
  }
  return {
    label: classifyCurrentStageLabel(stage),
    waitingFor: "Law Firm",
    since: null,
    ageDays: 0,
    attentionRequired: false,
  };
}

export function isAttentionNeeded(kd: KeyDatesRow, mode?: string | null): boolean {
  const spa = deriveSpaStatus(kd);
  if (spa.attention) return true;
  const loan = deriveLoanStatus(kd, mode);
  if (loan.attention) return true;
  return false;
}

export type SummaryCards = {
  totalUnits: number;
  spaInProgress: number;
  spaStamped: number;
  loanInProgress: number;
  needsAttention: number;
  completedHandover: number;
};

const ATTENTION_SQL_DAYS = ATTENTION_THRESHOLD_DAYS;

function sqlIsAttentionSpa(): SQL {
  return sql<boolean>`(
    ${caseKeyDatesTable.spaForwardToDeveloperExecutionOn} IS NOT NULL
    AND ${caseKeyDatesTable.spaSignedDate} IS NULL
    AND ${caseKeyDatesTable.spaStampedDate} IS NULL
    AND (extract(epoch from (now() - ${caseKeyDatesTable.spaForwardToDeveloperExecutionOn}))::int / 86400) > ${ATTENTION_SQL_DAYS}
  )`;
}

function sqlIsAttentionLoan(): SQL {
  return sql<boolean>`(
    ${caseKeyDatesTable.actingLetterIssuedDate} IS NOT NULL
    AND ${caseKeyDatesTable.bankLuReceivedDate} IS NULL
    AND (extract(epoch from (now() - ${caseKeyDatesTable.actingLetterIssuedDate}))::int / 86400) > ${ATTENTION_SQL_DAYS}
  )`;
}

function sqlIsInProgressSpa(): SQL {
  const attention = sqlIsAttentionSpa();
  return sql<boolean>`(
    (${caseKeyDatesTable.spaStampedDate} IS NULL)
    AND (
      ${caseKeyDatesTable.spaSignedDate} IS NOT NULL
      OR (
        ${caseKeyDatesTable.spaForwardToDeveloperExecutionOn} IS NOT NULL
        AND ${caseKeyDatesTable.spaSignedDate} IS NULL
        AND ${caseKeyDatesTable.spaStampedDate} IS NULL
        AND (NOT (${attention}))
      )
      OR (${attention})
      OR (
        ${caseKeyDatesTable.spaDate} IS NOT NULL
        AND ${caseKeyDatesTable.spaSignedDate} IS NULL
        AND ${caseKeyDatesTable.spaStampedDate} IS NULL
        AND ${caseKeyDatesTable.spaForwardToDeveloperExecutionOn} IS NULL
      )
      OR (
        ${caseKeyDatesTable.spaDate} IS NULL
        AND ${caseKeyDatesTable.spaSignedDate} IS NULL
        AND ${caseKeyDatesTable.spaStampedDate} IS NULL
        AND ${caseKeyDatesTable.spaForwardToDeveloperExecutionOn} IS NULL
      )
    )
  )`;
}

function sqlLoanStatusCompleted(): SQL<boolean> {
  return sql<boolean>`${caseKeyDatesTable.bankLuReceivedDate} IS NOT NULL`;
}

function sqlLoanStatusAttention(): SQL<boolean> {
  return sqlIsAttentionLoan() as SQL<boolean>;
}

function sqlLoanStatusInProgress(): SQL<boolean> {
  return sql<boolean>`(
    (
      ${caseKeyDatesTable.actingLetterIssuedDate} IS NOT NULL
      AND ${caseKeyDatesTable.bankLuReceivedDate} IS NULL
      AND (NOT (${sqlIsAttentionLoan()}))
    )
    OR ${caseKeyDatesTable.letterOfOfferStampedDate} IS NOT NULL
    OR ${caseKeyDatesTable.letterOfOfferDate} IS NOT NULL
    OR (
      (${caseKeyDatesTable.spaSignedDate} IS NOT NULL OR ${caseKeyDatesTable.spaStampedDate} IS NOT NULL)
      AND ${caseKeyDatesTable.actingLetterIssuedDate} IS NULL
      AND ${caseKeyDatesTable.bankLuReceivedDate} IS NULL
      AND ${caseKeyDatesTable.adviceToBankDate} IS NULL
      AND ${caseKeyDatesTable.letterOfOfferDate} IS NULL
      AND ${caseKeyDatesTable.letterOfOfferStampedDate} IS NULL
      AND ${caseKeyDatesTable.loanDocsSignedDate} IS NULL
      AND ${caseKeyDatesTable.loanDocsPendingDate} IS NULL
      AND ${caseKeyDatesTable.loanAgreementStampedDate} IS NULL
    )
  )`;
}

function sqlSpaCompleted(): SQL<boolean> {
  return sql<boolean>`${caseKeyDatesTable.spaStampedDate} IS NOT NULL`;
}

function sqlSpaCompletedOrSigned(): SQL<boolean> {
  return sql<boolean>`(${caseKeyDatesTable.spaSignedDate} IS NOT NULL OR ${caseKeyDatesTable.spaStampedDate} IS NOT NULL)`;
}

export function portalSummaryAggregateSelect() {
  const spaStamped = sqlSpaCompleted();
  const loanInProgressCase = sql<boolean>`(${sqlLoanStatusInProgress()} OR ${sqlLoanStatusAttention()})`;
  const attentionCase = sql<boolean>`(${sqlIsAttentionSpa()} OR ${sqlIsAttentionLoan()})`;
  const completedCase = sql<boolean>`${caseKeyDatesTable.completionDate} IS NOT NULL`;

  const spaInProgressCase = sql<boolean>`(
    (NOT ${spaStamped})
    AND (
      ${sqlIsAttentionSpa()}
      OR ${sqlIsInProgressSpa()}
    )
  )`;

  return {
    totalUnits: sql<number>`COUNT(${casesTable.id})::int`.as("total_units"),
    spaInProgress: sql<number>`COUNT(*) FILTER (WHERE ${spaInProgressCase})::int`.as("spa_in_progress"),
    spaStamped: sql<number>`COUNT(*) FILTER (WHERE ${spaStamped})::int`.as("spa_stamped"),
    loanInProgress: sql<number>`COUNT(*) FILTER (WHERE ${loanInProgressCase})::int`.as("loan_in_progress"),
    needsAttention: sql<number>`COUNT(*) FILTER (WHERE ${attentionCase})::int`.as("needs_attention"),
    completedHandover: sql<number>`COUNT(*) FILTER (WHERE ${completedCase})::int`.as("completed_handover"),
    lastUpdatedAt: sql<string | null>`MAX(${casesTable.updatedAt})::text`.as("last_updated_at"),
  };
}

export function portalProgressAggregateSelect() {
  const completedStage = sql<boolean>`${caseKeyDatesTable.completionDate} IS NOT NULL`;
  const motStage = sql<boolean>`(
    NOT ${completedStage}
    AND (
      ${caseKeyDatesTable.motReceivedDate} IS NOT NULL
      OR ${caseKeyDatesTable.motSignedDate} IS NOT NULL
      OR ${caseKeyDatesTable.motStampedDate} IS NOT NULL
      OR ${caseKeyDatesTable.motRegisteredDate} IS NOT NULL
      OR ${caseKeyDatesTable.dischargeTitleReceivedOn} IS NOT NULL
      OR ${caseKeyDatesTable.consentToTransferDate} IS NOT NULL
    )
  )`;
  const loanStage = sql<boolean>`(
    (NOT ${completedStage})
    AND (NOT ${motStage})
    AND (
      ${sqlLoanStatusInProgress()}
      OR ${sqlLoanStatusAttention()}
      OR ${sqlLoanStatusCompleted()}
    )
    AND ${sqlSpaCompleted()}
  )`;
  const spaStage = sql<boolean>`(
    (NOT ${completedStage})
    AND (NOT ${motStage})
    AND (
      ${sqlSpaCompleted()}
      AND (NOT (
        (${sqlLoanStatusInProgress()} OR ${sqlLoanStatusAttention()} OR ${sqlLoanStatusCompleted()})
      ))
    )
    OR (
      (NOT ${sqlSpaCompleted()})
    )
  )`;

  return {
    spa: sql<number>`COUNT(*) FILTER (WHERE (NOT ${completedStage}) AND (NOT ${motStage}) AND (NOT ${loanStage}))::int`.as("spa_progressing"),
    loan: sql<number>`COUNT(*) FILTER (WHERE ${loanStage})::int`.as("loan_progressing"),
    mot: sql<number>`COUNT(*) FILTER (WHERE ${motStage})::int`.as("mot_progressing"),
    completed: sql<number>`COUNT(*) FILTER (WHERE ${completedStage})::int`.as("completed_progressing"),
    total: sql<number>`COUNT(*)::int`.as("total"),
  };
}

function classifyStageSqlCaseExpr(): SQL {
  return sql`CASE
    WHEN ${caseKeyDatesTable.completionDate} IS NOT NULL THEN 'completed'
    WHEN (
      ${caseKeyDatesTable.motReceivedDate} IS NOT NULL
      OR ${caseKeyDatesTable.motSignedDate} IS NOT NULL
      OR ${caseKeyDatesTable.motStampedDate} IS NOT NULL
      OR ${caseKeyDatesTable.motRegisteredDate} IS NOT NULL
      OR ${caseKeyDatesTable.dischargeTitleReceivedOn} IS NOT NULL
      OR ${caseKeyDatesTable.consentToTransferDate} IS NOT NULL
    ) THEN 'mot'
    WHEN (
      ${caseKeyDatesTable.actingLetterIssuedDate} IS NOT NULL
      OR ${caseKeyDatesTable.bankLuReceivedDate} IS NOT NULL
      OR ${caseKeyDatesTable.adviceToBankDate} IS NOT NULL
      OR ${caseKeyDatesTable.letterOfOfferDate} IS NOT NULL
      OR ${caseKeyDatesTable.letterOfOfferStampedDate} IS NOT NULL
      OR ${caseKeyDatesTable.loanDocsSignedDate} IS NOT NULL
      OR ${caseKeyDatesTable.loanDocsPendingDate} IS NOT NULL
      OR ${caseKeyDatesTable.loanAgreementStampedDate} IS NOT NULL
    ) THEN 'loan'
    WHEN ${caseKeyDatesTable.spaStampedDate} IS NOT NULL THEN 'spa_stamped'
    WHEN ${caseKeyDatesTable.spaSignedDate} IS NOT NULL OR ${caseKeyDatesTable.spaDate} IS NOT NULL OR ${caseKeyDatesTable.spaForwardToDeveloperExecutionOn} IS NOT NULL THEN 'spa'
    ELSE 'pre_spa'
  END`;
}

export function portalStagePredicateSql(stage: DevPortalStageFilter): SQL<unknown> | null {
  switch (stage) {
    case "all":
      return null;
    case "spa": {
      const spaStageLabelCase = classifyStageSqlCaseExpr();
      const jsBranch1or2 = sql<boolean>`(
        (NOT ${sqlSpaCompleted()})
        AND (${sqlIsInProgressSpa()} OR ${sqlIsAttentionSpa()})
      )`;
      const jsBranch3 = sql<boolean>`(${spaStageLabelCase} = 'spa')`;
      return sql<boolean>`(${jsBranch1or2} OR ${jsBranch3})`;
    }
    case "spa_stamped":
      return sqlSpaCompleted();
    case "loan":
      return sql<boolean>`(
        (${sqlLoanStatusInProgress()} OR ${sqlLoanStatusAttention()} OR ${sqlLoanStatusCompleted()})
      )`;
    case "attention": {
      return sql<boolean>`(${sqlIsAttentionSpa()} OR ${sqlIsAttentionLoan()})`;
    }
    case "completed":
      return sql<boolean>`${caseKeyDatesTable.completionDate} IS NOT NULL`;
    default:
      return null;
  }
}

export type DeveloperPortalCaseJoin = {
  id: number;
  referenceNo: string | null;
  parcelNo: string | null;
  purchaseMode: string;
  status: string;
  updatedAt: Date | null;
  createdAt: Date | null;
  propertyDetails: unknown;
  loanDetails: unknown;
  titleType: string;
  spaPrice: string | number | null;
  endFinancierBank?: string | null;
  "projects.name"?: string | null;
  "projects.phase"?: string | null;
  projectName?: string | null;
  phase?: string | null;
  kd_spaStampedDate?: unknown;
  kd_spaSignedDate?: unknown;
  kd_spaDate?: unknown;
  kd_spaForwardToDeveloperExecutionOn?: unknown;
  kd_spaReceivedDevReturnSpaOn?: unknown;
  kd_letterOfOfferDate?: unknown;
  kd_letterOfOfferStampedDate?: unknown;
  kd_actingLetterIssuedDate?: unknown;
  kd_bankLuReceivedDate?: unknown;
  kd_adviceToBankDate?: unknown;
  kd_motReceivedDate?: unknown;
  kd_motSignedDate?: unknown;
  kd_motStampedDate?: unknown;
  kd_motRegisteredDate?: unknown;
  kd_completionDate?: unknown;
  kd_loanDocsPendingDate?: unknown;
  kd_loanDocsSignedDate?: unknown;
  kd_loanAgreementStampedDate?: unknown;
  kd_dischargeTitleReceivedOn?: unknown;
  kd_consentToTransferDate?: unknown;
  purchaserNames?: string | null;
  lawyerName?: string | null;
  clerkName?: string | null;
};

export function kdFromJoined(c: DeveloperPortalCaseJoin): KeyDatesRow {
  return {
    spaStampedDate: c.kd_spaStampedDate as any,
    spaSignedDate: c.kd_spaSignedDate as any,
    spaDate: c.kd_spaDate as any,
    spaForwardToDeveloperExecutionOn: c.kd_spaForwardToDeveloperExecutionOn as any,
    spaReceivedDevReturnSpaOn: c.kd_spaReceivedDevReturnSpaOn as any,
    letterOfOfferDate: c.kd_letterOfOfferDate as any,
    letterOfOfferStampedDate: c.kd_letterOfOfferStampedDate as any,
    actingLetterIssuedDate: c.kd_actingLetterIssuedDate as any,
    bankLuReceivedDate: c.kd_bankLuReceivedDate as any,
    adviceToBankDate: c.kd_adviceToBankDate as any,
    motReceivedDate: c.kd_motReceivedDate as any,
    motSignedDate: c.kd_motSignedDate as any,
    motStampedDate: c.kd_motStampedDate as any,
    motRegisteredDate: c.kd_motRegisteredDate as any,
    completionDate: c.kd_completionDate as any,
    loanDocsPendingDate: c.kd_loanDocsPendingDate as any,
    loanDocsSignedDate: c.kd_loanDocsSignedDate as any,
    loanAgreementStampedDate: c.kd_loanAgreementStampedDate as any,
    dischargeTitleReceivedOn: c.kd_dischargeTitleReceivedOn as any,
    consentToTransferDate: c.kd_consentToTransferDate as any,
  };
}

export type PurchaserDto = { displayName: string };

export function sanitizePurchasers(row: { purchaserNames?: string | null }): PurchaserDto[] {
  if (!row.purchaserNames) return [];
  return row.purchaserNames
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => ({ displayName: n }));
}

export function toBankName(loanDetails: unknown, endFinancierBank?: string | null): string | null {
  if (isNonEmptyString(endFinancierBank)) return endFinancierBank!;
  if (loanDetails && typeof loanDetails === "object") {
    const anyLd = loanDetails as Record<string, unknown>;
    if (isNonEmptyString(anyLd.bankName)) return String(anyLd.bankName);
    if (isNonEmptyString(anyLd.endFinancierBank)) return String(anyLd.endFinancierBank);
  }
  return null;
}

export type UnitListDto = {
  caseId: number;
  referenceNo: string | null;
  projectName: string | null;
  phase: string | null;
  unitLabel: string;
  propertySummary: string | null;
  purchasers: PurchaserDto[];
  spa: { status: DevPortalStatus; label: string; date: string | null };
  loan: { status: DevPortalStatus; label: string; bankName: string | null; date: string | null };
  mot: { status: DevPortalStatus; label: string; date: string | null };
  currentStage: string;
  nextAction: NextAction | null;
  lastUpdatedAt: string | null;
};

export function mapJoinedCaseToListDto(c: DeveloperPortalCaseJoin): UnitListDto {
  const propertyDetails = (c.propertyDetails && typeof c.propertyDetails === "object"
    ? c.propertyDetails
    : null) as UnitLabelPrioritySource["propertyDetails"] | null;
  const projectName = c.projectName ?? c["projects.name"] ?? null;
  const phase = c.phase ?? c["projects.phase"] ?? null;
  const unitLabel = getDeveloperPortalUnitLabel({
    parcelNo: c.parcelNo,
    propertyDetails,
    projectName,
    phase,
    referenceNo: c.referenceNo,
  });
  const kd = kdFromJoined(c);
  const stage = classifySpaLoanStage(kd);
  const spa = deriveSpaStatus(kd);
  const loan = deriveLoanStatus(kd, c.purchaseMode);
  const mot = deriveMotStatus(kd, stage);
  const nextAction = deriveNextAction(kd, c.purchaseMode);
  const pdAddr = propertyDetails?.address
    ? String(propertyDetails.address).slice(0, 120)
    : (propertyDetails?.addressLine1 ?? null);

  return {
    caseId: c.id,
    referenceNo: c.referenceNo ?? null,
    projectName: projectName ?? null,
    phase: phase ?? null,
    unitLabel,
    propertySummary: pdAddr ? String(pdAddr) : null,
    purchasers: sanitizePurchasers(c),
    spa: { status: spa.status, label: spa.label, date: spa.date ?? null },
    loan: {
      status: loan.status,
      label: loan.label,
      bankName: toBankName(c.loanDetails, c.endFinancierBank ?? null),
      date: loan.date ?? null,
    },
    mot: { status: mot.status, label: mot.label, date: mot.date ?? null },
    currentStage: classifyCurrentStageLabel(stage, c.status),
    nextAction,
    lastUpdatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
  };
}

export type ProgressStrip = {
  spa: { progressing: number };
  loan: { progressing: number };
  mot: { progressing: number };
  completed: { progressing: number };
  total: number;
};

export function summarizeProgress(list: UnitListDto[]): ProgressStrip {
  let spa = 0;
  let loan = 0;
  let mot = 0;
  let completed = 0;
  const total = list.length;
  for (const u of list) {
    if (u.currentStage === "Completed / Handover") completed++;
    else if (u.currentStage === "MOT / Title") mot++;
    else if (u.spa.status === "Completed" && (u.loan.status === "In Progress" || u.loan.status === "Attention Required" || u.loan.status === "Completed")) loan++;
    else if (u.spa.status === "Completed") spa++;
    else spa++;
    if (u.currentStage === "Completed / Handover") {
      /* completed counted above */
    }
  }
  return { spa: { progressing: spa }, loan: { progressing: loan }, mot: { progressing: mot }, completed: { progressing: completed }, total };
}

export function summarizeCards(list: UnitListDto[]): SummaryCards {
  let spaInProgress = 0;
  let spaStamped = 0;
  let loanInProgress = 0;
  let needsAttention = 0;
  let completedHandover = 0;
  for (const u of list) {
    if (u.currentStage === "Completed / Handover") {
      completedHandover++;
    }
    if (u.spa.label === "SPA Stamped" && u.spa.status === "Completed") {
      spaStamped++;
    } else if (u.spa.status === "In Progress" || u.spa.status === "Attention Required") {
      spaInProgress++;
    }
    if (u.loan.status === "In Progress" || u.loan.status === "Attention Required") {
      loanInProgress++;
    }
    if (u.nextAction?.attentionRequired || u.spa.status === "Attention Required" || u.loan.status === "Attention Required") {
      needsAttention++;
    }
  }
  return {
    totalUnits: list.length,
    spaInProgress,
    spaStamped,
    loanInProgress,
    needsAttention,
    completedHandover,
  };
}

export type AttentionItem = {
  caseId: number;
  unitLabel: string;
  referenceNo: string | null;
  label: string;
  waitingFor: string;
  since: string | null;
  ageDays: number;
};

export function collectAttentionItems(list: UnitListDto[], limit = 5): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const u of list) {
    if (u.nextAction?.attentionRequired || u.spa.status === "Attention Required" || u.loan.status === "Attention Required") {
      const next = u.nextAction ?? {
        label: u.spa.label,
        waitingFor: u.spa.status === "Attention Required" ? "Purchaser" : "Law Firm",
        since: u.spa.date,
        ageDays: 0,
        attentionRequired: true,
      };
      items.push({
        caseId: u.caseId,
        unitLabel: u.unitLabel,
        referenceNo: u.referenceNo,
        label: next.label,
        waitingFor: next.waitingFor || "Law Firm",
        since: next.since ?? null,
        ageDays: next.ageDays ?? 0,
      });
    }
  }
  items.sort((a, b) => b.ageDays - a.ageDays);
  return items.slice(0, limit);
}

export type TimelineEntry = {
  key: string;
  label: string;
  date: string | null;
  state: "done" | "active" | "pending" | "not_required";
};

export function buildSpaLoanTimeline(kd: KeyDatesRow, mode?: string | null): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  entries.push({ key: "file_opened", label: "File Opened", date: null, state: "done" });
  const spaSign = ymdOrNull(kd.spaSignedDate) || ymdOrNull(kd.spaForwardToDeveloperExecutionOn);
  entries.push({ key: "spa_signed", label: "SPA Signed", date: spaSign, state: kd.spaSignedDate ? "done" : (kd.spaForwardToDeveloperExecutionOn ? "active" : "pending") });
  entries.push({
    key: "spa_stamped",
    label: "SPA Stamped",
    date: ymdOrNull(kd.spaStampedDate),
    state: kd.spaStampedDate ? "done" : (kd.spaSignedDate ? "active" : "pending"),
  });
  if (String(mode ?? "cash") !== "cash" || kd.letterOfOfferDate || kd.bankLuReceivedDate || kd.actingLetterIssuedDate) {
    entries.push({
      key: "lo_stamped",
      label: "Letter of Offer Stamped",
      date: ymdOrNull(kd.letterOfOfferStampedDate),
      state: kd.letterOfOfferStampedDate ? "done" : (kd.letterOfOfferDate ? "active" : "pending"),
    });
    entries.push({
      key: "acting_letter",
      label: "Acting Letter Issued",
      date: ymdOrNull(kd.actingLetterIssuedDate),
      state: kd.actingLetterIssuedDate ? "done" : (kd.letterOfOfferStampedDate ? "active" : "pending"),
    });
    entries.push({
      key: "bank_lu",
      label: "Bank LU Received",
      date: ymdOrNull(kd.bankLuReceivedDate),
      state: kd.bankLuReceivedDate ? "done" : (kd.actingLetterIssuedDate ? "active" : "pending"),
    });
  }
  return entries;
}

export function buildMotTimeline(kd: KeyDatesRow, stage: SpaLoanStage): TimelineEntry[] {
  if (stage !== "mot" && stage !== "completed") {
    return [{ key: "mot_not_yet", label: "Title / MOT", date: null, state: "not_required" }];
  }
  return [
    { key: "mot_received", label: "MOT Received", date: ymdOrNull(kd.motReceivedDate), state: kd.motReceivedDate ? "done" : "pending" },
    { key: "mot_signed", label: "MOT Signed", date: ymdOrNull(kd.motSignedDate), state: kd.motSignedDate ? "done" : (kd.motReceivedDate ? "active" : "pending") },
    { key: "mot_stamped", label: "MOT Stamped", date: ymdOrNull(kd.motStampedDate), state: kd.motStampedDate ? "done" : (kd.motSignedDate ? "active" : "pending") },
    { key: "mot_registered", label: "MOT Registered", date: ymdOrNull(kd.motRegisteredDate), state: kd.motRegisteredDate ? "done" : (kd.motStampedDate ? "active" : "pending") },
    { key: "completion", label: "Completion / Handover", date: ymdOrNull(kd.completionDate), state: kd.completionDate ? "done" : (kd.motRegisteredDate ? "active" : "pending") },
  ];
}

export type ActivityDto = { dateLabel: string; label: string };

export function buildRecentActivity(
  kd: KeyDatesRow,
  stage: SpaLoanStage,
  workflowSteps: Array<{ stepName: string | null; status: string; completedAt: unknown }> | undefined,
  now: Date = new Date(),
): ActivityDto[] {
  type Candidate = { at: Date | null; label: string };
  const candidates: Candidate[] = [];
  const add = (at: unknown, label: string) => {
    const d = dateOrNull(at);
    if (d) candidates.push({ at: d, label });
  };
  add(kd.actingLetterIssuedDate, "Acting Letter issued");
  add(kd.spaStampedDate, "SPA stamped");
  add(kd.spaSignedDate, "SPA signed");
  add(kd.letterOfOfferStampedDate, "Letter of Offer stamped");
  add(kd.bankLuReceivedDate, "Bank undertaking received");
  add(kd.adviceToBankDate, "Advice to bank issued");
  add(kd.loanDocsSignedDate, "Loan documents signed");
  add(kd.motStampedDate, "MOT stamped");
  add(kd.motRegisteredDate, "MOT registered");
  add(kd.completionDate, "Completion / Handover");
  if (Array.isArray(workflowSteps)) {
    for (const s of workflowSteps) {
      if (s.status === "completed" && s.stepName) add(s.completedAt, String(s.stepName));
    }
  }
  candidates.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const seen = new Set<string>();
  const result: ActivityDto[] = [];
  for (const c of candidates) {
    if (!c.at) continue;
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    result.push({
      dateLabel: shortActivityDate(c.at, now),
      label: c.label,
    });
    if (result.length >= 5) break;
  }
  return result;
}

function shortActivityDate(d: Date, now: Date): string {
  const days = ageDays(d, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const months = Math.floor(days / 30);
  if (months < 1) return `${days}d ago`;
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
}

export type UnitDetailDto = UnitListDto & {
  property: {
    address: string | null;
    addressLines: string[];
    titleType: string | null;
    titleNo: string | null;
    lotNo: string | null;
    hakmilikNo: string | null;
  };
  purchasePrice: string | null;
  endFinancier: string | null;
  responsibleLawyer: string | null;
  assignedClerk: string | null;
  fileOpenedAt: string | null;
  lastActivity: string | null;
  spaLoanTimeline: TimelineEntry[];
  motTimeline: TimelineEntry[];
  recentActivity: ActivityDto[];
  currentAction: NextAction | null;
};

export function buildPropertyFields(c: DeveloperPortalCaseJoin): UnitDetailDto["property"] {
  const pd = c.propertyDetails && typeof c.propertyDetails === "object"
    ? c.propertyDetails as Record<string, unknown>
    : {};
  const addressLines = [pd.addressLine1, pd.addressLine2, pd.addressLine3, pd.addressLine4, pd.addressLine5]
    .map((v) => (typeof v === "string" && v.trim() ? v.trim() : null))
    .filter((v): v is string => !!v);
  const address = typeof pd.address === "string" && pd.address.trim()
    ? pd.address.trim()
    : (addressLines.join(", ") || null);
  return {
    address,
    addressLines,
    titleType: typeof pd.titleType === "string" ? pd.titleType : (isNonEmptyString(c.titleType) ? c.titleType : null),
    titleNo: typeof pd.titleNo === "string" ? pd.titleNo : null,
    lotNo: typeof pd.lotNo === "string" ? pd.lotNo : null,
    hakmilikNo: typeof pd.hakmilikNo === "string" ? pd.hakmilikNo : null,
  };
}

export function formatPurchasePrice(spaPrice: unknown): string | null {
  if (spaPrice == null || spaPrice === "") return null;
  if (typeof spaPrice === "number") return `RM ${spaPrice.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const s = String(spaPrice).replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return `RM ${s}`;
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function mapJoinedCaseToDetailDto(
  c: DeveloperPortalCaseJoin,
  workflowSteps?: Array<{ stepName: string | null; status: string; completedAt: unknown }>,
): UnitDetailDto {
  const base = mapJoinedCaseToListDto(c);
  const kd = kdFromJoined(c);
  const stage = classifySpaLoanStage(kd);
  const property = buildPropertyFields(c);
  return {
    ...base,
    property,
    purchasePrice: formatPurchasePrice(c.spaPrice),
    endFinancier: toBankName(c.loanDetails, c.endFinancierBank ?? null),
    responsibleLawyer: c.lawyerName ?? null,
    assignedClerk: c.clerkName ?? null,
    fileOpenedAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
    lastActivity: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
    spaLoanTimeline: buildSpaLoanTimeline(kd, c.purchaseMode),
    motTimeline: buildMotTimeline(kd, stage),
    recentActivity: buildRecentActivity(kd, stage, workflowSteps),
    currentAction: deriveNextAction(kd, c.purchaseMode),
  };
}

export type DevCaseAssignmentRow = { userId: number | null; name: string | null; roleInCase: string | null };
export function extractLawyerClerk(rows: DevCaseAssignmentRow[]): { lawyer: string | null; clerk: string | null } {
  let lawyer: string | null = null;
  let clerk: string | null = null;
  for (const r of rows) {
    const role = String(r.roleInCase ?? "").toLowerCase();
    const name = r.name ? String(r.name).trim() : null;
    if (!name) continue;
    if (role.includes("lawyer") || role === "lead" || role.includes("partner")) lawyer = lawyer ?? name;
    if (role.includes("clerk") || role.includes("legal_assistant") || role.includes("assistant")) clerk = clerk ?? name;
  }
  return { lawyer, clerk };
}

