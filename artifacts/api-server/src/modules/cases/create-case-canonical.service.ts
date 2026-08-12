import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  casesTable,
  casePurchasersTable,
  caseAssignmentsTable,
  projectsTable,
  developersTable,
  clientsTable,
  usersTable,
  rolesTable,
  permissionsTable,
  caseKeyDatesTable,
  auditLogsTable,
  caseNotificationsTable,
} from "@workspace/db";

type AppDb = typeof db;
type DbConnLike = AppDb | NonNullable<any>;

export type CanonicalCaseCreateMode = "normal" | "legacy_import";

export type CanonicalCaseCreateSource = "web_create" | "legacy_excel_import";

export type CanonicalCaseCreateContext = {
  db: DbConnLike;
  firmId: number;
  actorUserId: number;
  actorRoleId?: number | null;
  canAssignAny: boolean;
  source: CanonicalCaseCreateSource;
  ipAddress?: string | null;
  userAgent?: string | null;
  logger?: {
    warn?: (msg: Record<string, unknown>, text?: string) => void;
    error?: (msg: Record<string, unknown>, text?: string) => void;
    info?: (msg: Record<string, unknown>, text?: string) => void;
  } | null;
};

export type CanonicalPurchaserInput = {
  isCompany?: boolean;
  name: string;
  ic?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  tin?: string | null;
};

export type CanonicalBorrowerInput = {
  name: string;
  ic?: string | null;
  tin?: string | null;
  hp?: string | null;
  email?: string | null;
  address?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  addressLine4?: string | null;
  addressLine5?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
};

export type CanonicalCaseCreateInput = {
  caseType: "developer_sales" | "subsale" | "perfection";
  projectId?: number | null;
  developerId?: number | null;
  referenceNo?: string | null;
  proposedReferenceNo?: string | null;
  trackingToken?: string | null;
  purchaseMode?: "cash" | "loan";
  titleType?: string | null;
  landCondition?: string | null;
  encumbrances?: string | null;
  actingFor?: string | null;
  perfectionType?: string | null;
  assignedLawyerId?: number | null;
  assignedClerkId?: number | null;
  purchaserIds?: number[];
  purchasers?: CanonicalPurchaserInput[];
  borrowerMode?: "same_as_purchaser" | "separate" | "none";
  loanPartyType?: "1st_party" | "3rd_party";
  borrowers?: CanonicalBorrowerInput[];
  parcelNo?: string | null;
  spaDetails?: Record<string, unknown> | null;
  propertyAddress?: string | null;
  propertyDetails?: Record<string, unknown> | null;
  loanDetails?: Record<string, unknown> | null;
  companyDetails?: Record<string, unknown> | null;
  spaPrice?: number | null;
  apdlPrice?: number | null;
  developerDiscount?: number | null;
  bumiputraDiscount?: number | null;
  mappedKeyDates?: Partial<{
    spa_date: string | null;
    spa_stamped_date: string | null;
    letter_of_offer_date: string | null;
    loan_docs_signed_date: string | null;
    completion_date: string | null;
  }> | null;
  migration?: {
    mode: "legacy_existing_case";
    sourceBatchId: number;
    sourceRowNo: number;
    preserveReferenceNo: boolean;
    approvalMode: "already_approved" | "pending_approval";
    suppressNewCaseNotifications: boolean;
  } | null;
};

export type CanonicalCreateCaseResult = {
  case: typeof casesTable.$inferSelect;
  purchasersCreated: number;
  purchasersReused: number;
  purchasers: Array<{
    id: number;
    clientId: number;
    clientName: string;
    icNo: string | null;
    tin?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    role: string;
    orderNo: number;
  }>;
  assignments: Array<{
    id: number;
    userId: number;
    userName: string;
    roleInCase: string;
    assignedAt: string | null;
  }>;
  duplicate: boolean;
};

type CanonicalBorrowerInternal = {
  name: string;
  ic?: string | null;
  tin?: string | null;
  hp?: string | null;
  phone?: string | null;
  email?: string | null;
  address: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  addressLine4?: string | null;
  addressLine5?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
};

function normalizeTitleType(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;
  if (s === "master" || s === "master title") return "master";
  if (s === "strata" || s === "strata title") return "strata";
  if (s === "individual" || s === "individual title") return "individual";
  if (s === "land" || s === "land title") return "land";
  return s;
}

function normalizeCaseType(v: unknown): "developer_sales" | "subsale" | "perfection" | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;
  if (s === "developer_sales" || s === "developer sales" || s === "primary market" || s === "primary_market") return "developer_sales";
  if (s === "subsale" || s === "sub sale" || s === "sub_sale" || s === "secondary market" || s === "secondary_market") return "subsale";
  if (s === "perfection") return "perfection";
  return null;
}

function toIsoStringSafe(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return typeof v === "string" ? v : String(v);
  }
  return String(v ?? "");
}

function toIsoStringSafeOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = toIsoStringSafe(v);
  return s ? s : null;
}

function normalizeCanonicalBorrowers(raw: unknown): CanonicalBorrowerInternal[] {
  if (!Array.isArray(raw)) return [];
  const out: CanonicalBorrowerInternal[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const name = String((v as any).name ?? "").trim();
    if (!name) continue;
    const getOpt = (k: string): string | null => {
      const val = (v as any)[k];
      if (val === null || val === undefined) return null;
      const s = String(val).trim();
      return s ? s : null;
    };
    const addressLine1 = getOpt("addressLine1") ?? null;
    const addressLine2 = getOpt("addressLine2") ?? null;
    const addressLine3 = getOpt("addressLine3") ?? null;
    const addressLine4 = getOpt("addressLine4") ?? null;
    const addressLine5 = getOpt("addressLine5") ?? null;
    const composedLines: string[] = [
      addressLine1, addressLine2, addressLine3, addressLine4, addressLine5,
    ].filter((x): x is string => Boolean(x && x.trim()));
    const postcode = getOpt("postcode");
    const city = getOpt("city");
    const state = getOpt("state");
    const tailParts: string[] = [];
    if (postcode && city) tailParts.push(`${postcode} ${city}`);
    else if (postcode) tailParts.push(postcode);
    else if (city) tailParts.push(city);
    if (state) tailParts.push(state);
    const composedFromStructured = [...composedLines, ...tailParts].join(", ");
    const rawAddress = getOpt("address");
    const address = (rawAddress && rawAddress.trim()) ? rawAddress.trim() : composedFromStructured;
    const borrower: CanonicalBorrowerInternal = { name, address };
    const ic = getOpt("ic");
    if (ic) borrower.ic = ic;
    const tin = getOpt("tin");
    if (tin) borrower.tin = tin;
    const hp = getOpt("hp") ?? getOpt("phone");
    if (hp) { borrower.hp = hp; borrower.phone = hp; }
    const email = getOpt("email");
    if (email) borrower.email = email;
    if (addressLine1) borrower.addressLine1 = addressLine1;
    if (addressLine2) borrower.addressLine2 = addressLine2;
    if (addressLine3) borrower.addressLine3 = addressLine3;
    if (addressLine4) borrower.addressLine4 = addressLine4;
    if (addressLine5) borrower.addressLine5 = addressLine5;
    if (postcode) borrower.postcode = postcode;
    if (city) borrower.city = city;
    if (state) borrower.state = state;
    out.push(borrower);
  }
  return out;
}

function mirrorCanonicalToLoanBorrowers(canonical: CanonicalBorrowerInternal[]): Array<Record<string, unknown>> {
  return canonical.map((b) => {
    const m: Record<string, unknown> = { name: b.name, address: b.address };
    if (b.ic) m.ic = b.ic;
    if (b.tin) m.tin = b.tin;
    if (b.hp) m.hp = b.hp;
    if (b.email) m.email = b.email;
    if (b.addressLine1) m.addressLine1 = b.addressLine1;
    if (b.addressLine2) m.addressLine2 = b.addressLine2;
    if (b.addressLine3) m.addressLine3 = b.addressLine3;
    if (b.addressLine4) m.addressLine4 = b.addressLine4;
    if (b.addressLine5) m.addressLine5 = b.addressLine5;
    if (b.postcode) m.postcode = b.postcode;
    if (b.city) m.city = b.city;
    if (b.state) m.state = b.state;
    return m;
  });
}

function isCaseApprovalRoleName(roleName: string): boolean {
  const n = roleName.trim().toLowerCase();
  if (!n) return false;
  if (n.includes("partner")) return true;
  if (n === "account admin" || n === "account manager") return true;
  if (n.includes("account") && n.includes("admin")) return true;
  if (n.includes("account") && n.includes("manager")) return true;
  return false;
}

async function hasRolePermission(
  r: DbConnLike,
  firmId: number,
  roleId: number | null | undefined,
  module: string,
  action: string,
): Promise<boolean> {
  if (!roleId) return false;
  const [role] = await r
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)));
  if (!role) return false;
  const [perm] = await r
    .select({ allowed: permissionsTable.allowed })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, roleId),
      eq(permissionsTable.module, module),
      eq(permissionsTable.action, action),
    ));
  return Boolean(perm?.allowed);
}

async function listCaseApproverUserIds(r: DbConnLike, firmId: number): Promise<number[]> {
  const rows = await r
    .select({
      userId: usersTable.id,
      roleName: rolesTable.name,
    })
    .from(usersTable)
    .innerJoin(rolesTable, and(eq(usersTable.roleId, rolesTable.id), eq(rolesTable.firmId, firmId)))
    .innerJoin(permissionsTable, and(
      eq(permissionsTable.roleId, rolesTable.id),
      eq(permissionsTable.module, "cases"),
      eq(permissionsTable.action, "update"),
      eq(permissionsTable.allowed, true),
    ))
    .where(and(
      eq(usersTable.firmId, firmId),
      sql`COALESCE(${usersTable.status}, 'active') = 'active'`,
    ))
    .limit(500);

  const out: number[] = [];
  for (const row of rows) {
    if (!isCaseApprovalRoleName(String(row.roleName ?? ""))) continue;
    out.push(row.userId);
  }
  return Array.from(new Set(out));
}

async function insertCaseNotifications(r: DbConnLike, args: {
  firmId: number;
  caseId: number;
  recipientUserIds: number[];
  actorUserId: number | null;
  type: "OPEN_FILE_PENDING_APPROVAL" | "CASE_DETAILS_TO_AMEND" | "CASE_APPROVED" | "REFERENCE_NO_CHANGED";
  title: string;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  const recipients = Array.from(new Set(args.recipientUserIds.filter((x) => Number.isFinite(x))));
  if (recipients.length === 0) return;
  await r.insert(caseNotificationsTable).values(
    recipients.map((uid) => ({
      firmId: args.firmId,
      caseId: args.caseId,
      recipientUserId: uid,
      actorUserId: args.actorUserId,
      type: args.type,
      title: args.title,
      message: args.message ?? null,
      meta: args.meta ?? null,
      isRead: false,
      readAt: null,
    }))
  );
}

async function getRoleName(r: DbConnLike, firmId: number, roleId: number | null | undefined): Promise<string> {
  if (!roleId) return "";
  const [row] = await r
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)))
    .limit(1);
  return typeof row?.name === "string" ? row.name : "";
}

async function hasCasesFirmwideScopeInternal(r: DbConnLike, firmId: number, roleId: number | null | undefined): Promise<boolean> {
  if (!roleId) return false;
  const canBypassViaRole = await hasRolePermission(r, firmId, roleId, "cases", "assign_any");
  if (canBypassViaRole) return true;
  const roleName = await getRoleName(r, firmId, roleId);
  const n = String(roleName ?? "").trim().toLowerCase();
  if (n.includes("partner")) return true;
  if (n.includes("admin")) return true;
  if (n === "account manager") return true;
  return false;
}

export type CanonicalCaseCreateServiceError =
  | { code: "INVALID_CASE_TYPE" }
  | { code: "PROJECT_REQUIRED" }
  | { code: "PROJECT_NOT_FOUND" }
  | { code: "DEVELOPER_NOT_FOUND" }
  | { code: "DEVELOPER_REQUIRED" }
  | { code: "TITLE_TYPE_REQUIRED" }
  | { code: "LAND_CONDITION_REQUIRED" }
  | { code: "ENCUMBRANCES_REQUIRED" }
  | { code: "ACTING_FOR_REQUIRED" }
  | { code: "PERFECTION_TYPE_REQUIRED" }
  | { code: "SPA_PRICE_MISMATCH" }
  | { code: "BORROWER_REQUIRED_FOR_3RD_PARTY" }
  | { code: "CANNOT_ASSIGN_OTHER_USERS" }
  | { code: "ASSIGNED_LAWYER_NOT_FOUND" }
  | { code: "ASSIGNED_CLERK_NOT_FOUND" }
  | { code: "TRACKING_TOKEN_DUPLICATE" }
  | { code: "REFERENCE_NO_DUPLICATE" }
  | { code: "QUOTA_EXCEEDED"; error: string; code_extra?: string }
  | { code: "INTERNAL"; message: string; detail?: unknown };

export class CanonicalCaseCreateError extends Error {
  readonly code: CanonicalCaseCreateServiceError["code"];
  readonly detail?: unknown;
  constructor(err: CanonicalCaseCreateServiceError) {
    const msg = "code" in err && err.code === "INTERNAL"
      ? err.message
      : err.code;
    super(msg);
    this.name = "CanonicalCaseCreateError";
    this.code = err.code;
    this.detail = "detail" in err ? (err as any).detail : undefined;
  }
}

export async function createCaseCanonical(
  context: CanonicalCaseCreateContext,
  input: CanonicalCaseCreateInput,
): Promise<CanonicalCreateCaseResult> {
  const { db: r, firmId, actorUserId, actorRoleId, canAssignAny, source } = context;
  const isLegacyMode = input.migration?.mode === "legacy_existing_case";
  const legacy = isLegacyMode ? input.migration! : null;

  const normalizedCaseType = normalizeCaseType(input.caseType);
  if (!normalizedCaseType) {
    throw new CanonicalCaseCreateError({ code: "INVALID_CASE_TYPE" });
  }

  const purchaseMode = (input.purchaseMode === "loan" || input.purchaseMode === "cash")
    ? input.purchaseMode
    : "cash";

  const loanPartyType: "1st_party" | "3rd_party" = purchaseMode === "loan"
    ? (input.loanPartyType ?? "1st_party")
    : "1st_party";

  const landConditionNorm = typeof input.landCondition === "string" ? input.landCondition.trim().toLowerCase() : "";
  const encumbrancesNorm = typeof input.encumbrances === "string" ? input.encumbrances.trim().toLowerCase() : "";
  const actingForNorm = typeof input.actingFor === "string" ? input.actingFor.trim().toLowerCase() : "";
  const perfectionTypeNorm = typeof input.perfectionType === "string" ? input.perfectionType.trim().toLowerCase() : "";

  if (normalizedCaseType === "subsale") {
    const ntt = normalizeTitleType(input.titleType ?? "");
    if (!ntt) throw new CanonicalCaseCreateError({ code: "TITLE_TYPE_REQUIRED" });
    if (landConditionNorm !== "freehold" && landConditionNorm !== "leasehold") {
      throw new CanonicalCaseCreateError({ code: "LAND_CONDITION_REQUIRED" });
    }
    if (encumbrancesNorm !== "no_encumbrance" && encumbrancesNorm !== "has_encumbrance" && encumbrancesNorm !== "to_confirm") {
      throw new CanonicalCaseCreateError({ code: "ENCUMBRANCES_REQUIRED" });
    }
    if (actingForNorm !== "vendor" && actingForNorm !== "purchaser" && actingForNorm !== "both") {
      throw new CanonicalCaseCreateError({ code: "ACTING_FOR_REQUIRED" });
    }
  } else if (normalizedCaseType === "perfection") {
    if (perfectionTypeNorm !== "transfer_and_charge" && perfectionTypeNorm !== "transfer" && perfectionTypeNorm !== "charge") {
      throw new CanonicalCaseCreateError({ code: "PERFECTION_TYPE_REQUIRED" });
    }
  }

  if (
    input.apdlPrice !== null && input.apdlPrice !== undefined &&
    input.spaPrice !== null && input.spaPrice !== undefined
  ) {
    const expected = input.apdlPrice - (input.developerDiscount ?? 0) - (input.bumiputraDiscount ?? 0);
    if (Math.abs(expected - input.spaPrice) > 0.009) {
      throw new CanonicalCaseCreateError({ code: "SPA_PRICE_MISMATCH" });
    }
  }

  if (purchaseMode === "loan" && loanPartyType === "3rd_party") {
    const hasExplicit = (input.borrowers ?? []).some((b) => String(b.name ?? "").trim().length > 0);
    const fromLd = (() => {
      const ld = input.loanDetails;
      if (!ld || typeof ld !== "object" || Array.isArray(ld)) return false;
      const inner = (ld as any).borrowers;
      return Array.isArray(inner) && inner.some((b) => String(b?.name ?? "").trim().length > 0);
    })();
    if (!hasExplicit && !fromLd) {
      throw new CanonicalCaseCreateError({ code: "BORROWER_REQUIRED_FOR_3RD_PARTY" });
    }
  }

  if (!canAssignAny) {
    if (input.assignedLawyerId !== undefined && input.assignedLawyerId !== null && input.assignedLawyerId !== actorUserId) {
      throw new CanonicalCaseCreateError({ code: "CANNOT_ASSIGN_OTHER_USERS" });
    }
    if (input.assignedClerkId !== undefined && input.assignedClerkId !== null && input.assignedClerkId !== actorUserId) {
      throw new CanonicalCaseCreateError({ code: "CANNOT_ASSIGN_OTHER_USERS" });
    }
  }

  let effectiveProjectId: number | null = null;
  let effectiveDeveloperId: number | null = null;
  let effectiveTenure: "freehold" | "leasehold" = "freehold";
  let effectiveIsEncumbered = false;

  const normalizedTitleType = (() => {
    if (normalizedCaseType === "developer_sales") {
      const n = normalizeTitleType(input.titleType ?? "");
      return n ?? "master";
    }
    if (normalizedCaseType === "subsale") {
      const n = normalizeTitleType(input.titleType ?? "");
      return n ?? "master";
    }
    return "master";
  })();

  if (normalizedCaseType === "developer_sales") {
    if (!input.projectId) {
      throw new CanonicalCaseCreateError({ code: "PROJECT_REQUIRED" });
    }
    const [project] = await r.select().from(projectsTable).where(eq(projectsTable.id, input.projectId));
    if (!project || project.firmId !== firmId) {
      throw new CanonicalCaseCreateError({ code: "PROJECT_NOT_FOUND" });
    }
    effectiveProjectId = input.projectId;
    if (input.developerId !== undefined && input.developerId !== null) {
      const [dev] = await r
        .select({ id: developersTable.id })
        .from(developersTable)
        .where(and(eq(developersTable.firmId, firmId), eq(developersTable.id, input.developerId)))
        .limit(1);
      if (!dev) {
        throw new CanonicalCaseCreateError({ code: "DEVELOPER_NOT_FOUND" });
      }
      effectiveDeveloperId = input.developerId;
    } else if (project.developerId) {
      effectiveDeveloperId = project.developerId;
    }
    if (!effectiveDeveloperId) {
      throw new CanonicalCaseCreateError({ code: "DEVELOPER_REQUIRED" });
    }
    effectiveIsEncumbered = Boolean((project as any).isEncumbered ?? false);
    const projectTenure = String((project as any).tenure ?? "").trim().toLowerCase();
    effectiveTenure = projectTenure === "leasehold" ? "leasehold" : "freehold";
  } else if (normalizedCaseType === "subsale") {
    effectiveTenure = landConditionNorm === "leasehold" ? "leasehold" : "freehold";
    effectiveIsEncumbered = encumbrancesNorm === "has_encumbrance";
  }

  const usersToCheck = [
    ...(input.assignedLawyerId !== undefined && input.assignedLawyerId !== null ? [input.assignedLawyerId] : []),
    ...(input.assignedClerkId !== undefined && input.assignedClerkId !== null ? [input.assignedClerkId] : []),
  ];
  if (usersToCheck.length > 0) {
    const found = await r
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, firmId), inArray(usersTable.id, usersToCheck)));
    const foundIds = new Set(found.map((u) => u.id));
    if (input.assignedLawyerId !== undefined && input.assignedLawyerId !== null && !foundIds.has(input.assignedLawyerId)) {
      throw new CanonicalCaseCreateError({ code: "ASSIGNED_LAWYER_NOT_FOUND" });
    }
    if (input.assignedClerkId !== undefined && input.assignedClerkId !== null && !foundIds.has(input.assignedClerkId)) {
      throw new CanonicalCaseCreateError({ code: "ASSIGNED_CLERK_NOT_FOUND" });
    }
  }

  if (input.trackingToken) {
    const [existingByTrackingToken] = await r
      .select()
      .from(casesTable)
      .where(and(
        eq(casesTable.firmId, firmId),
        eq(casesTable.trackingToken, input.trackingToken),
        sql`${casesTable.deletedAt} IS NULL`,
      ))
      .limit(1);
    if (existingByTrackingToken) {
      return {
        case: existingByTrackingToken,
        purchasersCreated: 0,
        purchasersReused: 0,
        purchasers: [],
        assignments: [],
        duplicate: true,
      };
    }
  }

  if (legacy && legacy.preserveReferenceNo && input.referenceNo && input.referenceNo.trim()) {
    const trimmedRef = input.referenceNo.trim();
    const normRef = trimmedRef.toLowerCase();
    const [existingByRef] = await r
      .select()
      .from(casesTable)
      .where(and(
        eq(casesTable.firmId, firmId),
        sql`LOWER(COALESCE(${casesTable.referenceNo}, '')) = ${normRef}`,
        sql`${casesTable.deletedAt} IS NULL`,
      ))
      .limit(1);
    if (existingByRef) {
      return {
        case: existingByRef,
        purchasersCreated: 0,
        purchasersReused: 0,
        purchasers: [],
        assignments: [],
        duplicate: true,
      };
    }
  }

  let resolvedPurchaserIds: number[] = input.purchaserIds ?? [];
  let purchasersCreated = 0;
  let purchasersReused = 0;
  const responsePurchasers: Array<{
    id: number;
    clientId: number;
    clientName: string;
    icNo: string | null;
    tin?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    role: string;
    orderNo: number;
  }> = [];

  if (resolvedPurchaserIds.length === 0 && input.purchasers && input.purchasers.length > 0) {
    for (const p of input.purchasers) {
      const trimmedName = String(p.name ?? "").trim();
      if (!trimmedName) continue;
      const trimmedIc = typeof p.ic === "string" ? p.ic.trim() : null;
      const trimmedTin = typeof p.tin === "string" ? p.tin.trim() : null;
      const trimmedPhone = typeof p.phone === "string" ? p.phone.trim() : null;
      const trimmedEmail = typeof p.email === "string" ? p.email.trim() : null;
      const trimmedAddress = typeof p.address === "string" ? p.address.trim() : null;

      let existingClientId: number | null = null;

      if (trimmedIc) {
        const [byIc] = await r
          .select()
          .from(clientsTable)
          .where(and(eq(clientsTable.firmId, firmId), eq(clientsTable.icNo, trimmedIc)));
        if (byIc) {
          existingClientId = byIc.id;
        }
      }

      if (!existingClientId) {
        const byName = await r
          .select()
          .from(clientsTable)
          .where(and(
            eq(clientsTable.firmId, firmId),
            sql`LOWER(${clientsTable.name}) = LOWER(${trimmedName})`
          ));
        if (byName.length === 1) {
          existingClientId = byName[0].id;
        }
      }

      if (existingClientId) {
        resolvedPurchaserIds.push(existingClientId);
        purchasersReused++;
        responsePurchasers.push({
          id: 0,
          clientId: existingClientId,
          clientName: trimmedName,
          icNo: trimmedIc,
          tin: trimmedTin,
          phone: trimmedPhone,
          email: trimmedEmail,
          address: trimmedAddress,
          role: "joint",
          orderNo: resolvedPurchaserIds.length,
        });
        if (trimmedTin || trimmedPhone || trimmedEmail || trimmedAddress) {
          const [existing] = await r
            .select({ id: clientsTable.id, tin: clientsTable.tin, phone: clientsTable.phone, email: clientsTable.email, address: clientsTable.address })
            .from(clientsTable)
            .where(and(eq(clientsTable.firmId, firmId), eq(clientsTable.id, existingClientId)))
            .limit(1);
          if (existing) {
            const patch: Record<string, unknown> = {};
            if (trimmedTin && !String(existing.tin ?? "").trim()) patch.tin = trimmedTin;
            if (trimmedPhone && !String(existing.phone ?? "").trim()) patch.phone = trimmedPhone;
            if (trimmedEmail && !String(existing.email ?? "").trim()) patch.email = trimmedEmail;
            if (trimmedAddress && !String(existing.address ?? "").trim()) patch.address = trimmedAddress;
            if (Object.keys(patch).length > 0) {
              await r.update(clientsTable).set(patch).where(and(eq(clientsTable.firmId, firmId), eq(clientsTable.id, existingClientId)));
            }
          }
        }
      } else {
        const insertBase = {
          firmId,
          name: trimmedName,
          icNo: trimmedIc,
          tin: trimmedTin,
          phone: trimmedPhone,
          email: trimmedEmail,
          address: trimmedAddress,
          createdBy: actorUserId ?? null,
        } satisfies typeof clientsTable.$inferInsert;

        const [client] = await r
          .insert(clientsTable)
          .values(insertBase)
          .returning();
        resolvedPurchaserIds.push(client.id);
        purchasersCreated++;
        responsePurchasers.push({
          id: 0,
          clientId: client.id,
          clientName: trimmedName,
          icNo: trimmedIc,
          tin: trimmedTin,
          phone: trimmedPhone,
          email: trimmedEmail,
          address: trimmedAddress,
          role: "joint",
          orderNo: resolvedPurchaserIds.length,
        });
      }
    }
  }

  const borrowerPayloadRaw = (
    Array.isArray(input.borrowers) && input.borrowers.length > 0
      ? input.borrowers
      : (input.loanDetails && typeof input.loanDetails === "object" && !Array.isArray(input.loanDetails) && Array.isArray((input.loanDetails as any).borrowers))
        ? (input.loanDetails as any).borrowers
        : []
  );
  const normalizedBorrowerPayload = normalizeCanonicalBorrowers(borrowerPayloadRaw);
  const isLoan = purchaseMode === "loan";
  let canonicalBorrowers: CanonicalBorrowerInternal[] = [];

  if (isLoan) {
    if (loanPartyType === "1st_party") {
      if (normalizedBorrowerPayload.length > 0) {
        canonicalBorrowers = normalizedBorrowerPayload;
      } else if (resolvedPurchaserIds.length === 0) {
        canonicalBorrowers = [];
      } else {
        const rows = await r
          .select({ id: clientsTable.id, name: clientsTable.name, ic: clientsTable.icNo, tin: clientsTable.tin, phone: clientsTable.phone, email: clientsTable.email, address: clientsTable.address })
          .from(clientsTable)
          .where(and(eq(clientsTable.firmId, firmId), inArray(clientsTable.id, resolvedPurchaserIds)));
        const byId = new Map<number, { name: string; ic: string | null; tin: string | null; phone: string | null; email: string | null; address: string | null }>();
        for (const row of rows) byId.set(row.id, { name: String(row.name ?? ""), ic: row.ic ?? null, tin: (row as any).tin ?? null, phone: row.phone ?? null, email: row.email ?? null, address: row.address ?? null });
        canonicalBorrowers = resolvedPurchaserIds
          .map((id): CanonicalBorrowerInternal | null => {
            const v = byId.get(id);
            const name = v?.name?.trim() ?? "";
            if (!name) return null;
            const ic = v?.ic ? String(v.ic).trim() : null;
            const tin = v?.tin ? String(v.tin).trim() : null;
            const hp = v?.phone ? String(v.phone).trim() : null;
            const email = v?.email ? String(v.email).trim() : null;
            const address = v?.address ? String(v.address).trim() : "";
            const out: CanonicalBorrowerInternal = { name, address };
            if (ic) out.ic = ic;
            if (tin) out.tin = tin;
            if (hp) { out.hp = hp; out.phone = hp; }
            if (email) out.email = email;
            return out;
          })
          .filter((b): b is CanonicalBorrowerInternal => b !== null);
      }
    } else {
      canonicalBorrowers = normalizedBorrowerPayload;
      if (canonicalBorrowers.length === 0 && input.loanDetails && typeof input.loanDetails === "object") {
        const ld: any = input.loanDetails as any;
        const b1 = typeof ld.borrower1Name === "string" ? ld.borrower1Name.trim() : "";
        const i1 = typeof ld.borrower1Ic === "string" ? ld.borrower1Ic.trim() : "";
        const b2 = typeof ld.borrower2Name === "string" ? ld.borrower2Name.trim() : "";
        const i2 = typeof ld.borrower2Ic === "string" ? ld.borrower2Ic.trim() : "";
        const fallback: CanonicalBorrowerInternal[] = [];
        if (b1) fallback.push(i1 ? { name: b1, ic: i1, address: "" } : { name: b1, address: "" });
        if (b2) fallback.push(i2 ? { name: b2, ic: i2, address: "" } : { name: b2, address: "" });
        canonicalBorrowers = fallback;
      }
    }
  }

  const normalizedPropertyDetails = (() => {
    if (!input.propertyDetails || typeof input.propertyDetails !== "object" || Array.isArray(input.propertyDetails)) {
      return input.propertyAddress ? ({ propertyAddress: String(input.propertyAddress).trim() } as Record<string, unknown>) : null;
    }
    const base = { ...(input.propertyDetails as Record<string, unknown>) };
    if (input.propertyAddress !== undefined) base.propertyAddress = String(input.propertyAddress).trim();
    return base;
  })();

  const incomingLoanDetails = (input.loanDetails && typeof input.loanDetails === "object" && !Array.isArray(input.loanDetails))
    ? { ...(input.loanDetails as Record<string, unknown>) }
    : {};
  const mirroredLoanBorrowers = mirrorCanonicalToLoanBorrowers(canonicalBorrowers);
  if (mirroredLoanBorrowers.length > 0 || canonicalBorrowers.length > 0) {
    incomingLoanDetails.borrowers = mirroredLoanBorrowers;
  }
  const normalizedLoanDetails = Object.keys(incomingLoanDetails).length > 0 ? incomingLoanDetails : null;

  const spaPriceToInsert = input.spaPrice !== undefined && input.spaPrice !== null ? String(input.spaPrice) : null;
  const apdlPriceToInsert = input.apdlPrice !== undefined && input.apdlPrice !== null ? String(input.apdlPrice) : null;
  const developerDiscountToInsert = input.developerDiscount !== undefined && input.developerDiscount !== null ? String(input.developerDiscount) : null;
  const bumiputraDiscountToInsert = input.bumiputraDiscount !== undefined && input.bumiputraDiscount !== null ? String(input.bumiputraDiscount) : null;

  const isAlreadyApproved = legacy && legacy.approvalMode === "already_approved";
  const importedAt = new Date();

  const insertCaseBase: Omit<typeof casesTable.$inferInsert, "referenceNo"> = {
    firmId,
    projectId: effectiveProjectId,
    developerId: effectiveDeveloperId,
    proposedReferenceNo: input.proposedReferenceNo ? input.proposedReferenceNo.trim() : null,
    purchaseMode,
    titleType: normalizedTitleType,
    isEncumbered: effectiveIsEncumbered,
    tenure: effectiveTenure,
    spaPrice: spaPriceToInsert,
    apdlPrice: apdlPriceToInsert,
    developerDiscount: developerDiscountToInsert,
    bumiputraDiscount: bumiputraDiscountToInsert,
    status: isAlreadyApproved ? "Active / In Progress" : "Pending Approval",
    caseType: normalizedCaseType,
    parcelNo: input.parcelNo ?? null,
    spaDetails: input.spaDetails ? JSON.stringify(input.spaDetails) : null,
    propertyDetails: normalizedPropertyDetails,
    loanDetails: normalizedLoanDetails,
    loanPartyType: isLoan ? loanPartyType : "1st_party",
    borrowers: canonicalBorrowers,
    companyDetails: input.companyDetails ? JSON.stringify(input.companyDetails) : null,
    createdBy: actorUserId ?? null,
    approvalStatus: isAlreadyApproved ? "approved" : "pending_approval",
    submittedBy: actorUserId ?? null,
    submittedAt: importedAt,
    approvedBy: isAlreadyApproved ? actorUserId : null,
    approvedAt: isAlreadyApproved ? importedAt : null,
    approvalNote: isAlreadyApproved
      ? "Legacy case migration — existing historical case imported from firm source data"
      : null,
    encumbrances: normalizedCaseType === "subsale" ? (encumbrancesNorm || null) : null,
    actingFor: normalizedCaseType === "subsale" ? (actingForNorm || null) : null,
    perfectionType: normalizedCaseType === "perfection" ? (perfectionTypeNorm || null) : null,
  };

  const wantsPreserveRef = legacy && legacy.preserveReferenceNo;
  const refNoForInsert = wantsPreserveRef && input.referenceNo && input.referenceNo.trim()
    ? input.referenceNo.trim()
    : null;

  const [newCase] = await r
    .insert(casesTable)
    .values({
      ...insertCaseBase,
      referenceNo: refNoForInsert,
      trackingToken: input.trackingToken ?? undefined,
    } satisfies typeof casesTable.$inferInsert)
    .returning();
  if (!newCase) {
    throw new CanonicalCaseCreateError({ code: "INTERNAL", message: "Insert returned no row" });
  }

  try {
    if (!legacy || !legacy.suppressNewCaseNotifications) {
      if (!isAlreadyApproved) {
        const approverUserIds = await listCaseApproverUserIds(r, firmId);
        const recipients = approverUserIds.filter((id) => id !== actorUserId);
        await insertCaseNotifications(r, {
          firmId,
          caseId: newCase.id,
          recipientUserIds: recipients,
          actorUserId: actorUserId ?? null,
          type: "OPEN_FILE_PENDING_APPROVAL",
          title: "Open file pending approval",
          message: `Case #${newCase.id} submitted for approval`,
          meta: { caseId: newCase.id, approvalStatus: "pending_approval" },
        });
      }
    }
  } catch (err) {
    if (context.logger?.error) {
      context.logger.error({ err, caseId: newCase.id, firmId, userId: actorUserId }, "cases canonical: notification create failed");
    }
  }

  const responseAssignments: Array<{
    id: number;
    userId: number;
    userName: string;
    roleInCase: string;
    assignedAt: string | null;
  }> = [];

  for (let i = 0; i < resolvedPurchaserIds.length; i++) {
    const [casePurchaser] = await r.insert(casePurchasersTable).values({
      caseId: newCase.id,
      clientId: resolvedPurchaserIds[i],
      role: i === 0 ? "main" : "joint",
      orderNo: i + 1,
    }).returning({ id: casePurchasersTable.id });
    if (responsePurchasers[i]) {
      responsePurchasers[i] = {
        ...responsePurchasers[i],
        id: casePurchaser?.id ?? 0,
        role: i === 0 ? "main" : "joint",
        orderNo: i + 1,
      };
    }
  }

  const wantsExplicitAssignments = Boolean(canAssignAny && (input.assignedLawyerId !== null && input.assignedLawyerId !== undefined) || (input.assignedClerkId !== null && input.assignedClerkId !== undefined));
  if (!wantsExplicitAssignments) {
    const [assignment] = await r.insert(caseAssignmentsTable).values({
      caseId: newCase.id,
      userId: actorUserId!,
      roleInCase: "clerk",
      assignedBy: actorUserId,
    }).returning({ id: caseAssignmentsTable.id, assignedAt: caseAssignmentsTable.assignedAt });
    responseAssignments.push({
      id: assignment?.id ?? 0,
      userId: actorUserId!,
      userName: "",
      roleInCase: "clerk",
      assignedAt: assignment?.assignedAt ? toIsoStringSafe(assignment.assignedAt) : null,
    });
  } else {
    if (input.assignedLawyerId !== undefined && input.assignedLawyerId !== null) {
      const [assignment] = await r.insert(caseAssignmentsTable).values({
        caseId: newCase.id,
        userId: input.assignedLawyerId,
        roleInCase: "lawyer",
        assignedBy: actorUserId,
      }).returning({ id: caseAssignmentsTable.id, assignedAt: caseAssignmentsTable.assignedAt });
      responseAssignments.push({
        id: assignment?.id ?? 0,
        userId: input.assignedLawyerId,
        userName: "",
        roleInCase: "lawyer",
        assignedAt: assignment?.assignedAt ? toIsoStringSafe(assignment.assignedAt) : null,
      });
    }
    if (input.assignedClerkId !== undefined && input.assignedClerkId !== null) {
      const [assignment] = await r.insert(caseAssignmentsTable).values({
        caseId: newCase.id,
        userId: input.assignedClerkId,
        roleInCase: "clerk",
        assignedBy: actorUserId,
      }).returning({ id: caseAssignmentsTable.id, assignedAt: caseAssignmentsTable.assignedAt });
      responseAssignments.push({
        id: assignment?.id ?? 0,
        userId: input.assignedClerkId,
        userName: "",
        roleInCase: "clerk",
        assignedAt: assignment?.assignedAt ? toIsoStringSafe(assignment.assignedAt) : null,
      });
    }
  }

  if (input.mappedKeyDates && Object.keys(input.mappedKeyDates).length > 0) {
    const kdInsert: Partial<typeof caseKeyDatesTable.$inferInsert> = {
      firmId,
      caseId: newCase.id,
    };
    const kd = input.mappedKeyDates;
    if (kd.spa_date) kdInsert.spaDate = kd.spa_date;
    if (kd.spa_stamped_date) kdInsert.spaStampedDate = kd.spa_stamped_date;
    if (kd.letter_of_offer_date) kdInsert.letterOfOfferDate = kd.letter_of_offer_date;
    if (kd.loan_docs_signed_date) kdInsert.loanDocsSignedDate = kd.loan_docs_signed_date;
    if (kd.completion_date) kdInsert.completionDate = kd.completion_date;
    try {
      await r.insert(caseKeyDatesTable).values(kdInsert as any);
    } catch (kdErr) {
      if (context.logger?.warn) {
        context.logger.warn({ err: kdErr, caseId: newCase.id }, "cases canonical: key-dates insert failed (non-fatal)");
      }
    }
  }

  try {
    const auditAction = legacy ? "cases.legacy_import" : "cases.create";
    const auditDetail = legacy
      ? `source=legacy_excel_import batch=${legacy.sourceBatchId} row=${legacy.sourceRowNo} preserveRef=${legacy.preserveReferenceNo} approval=${legacy.approvalMode} purchasersCreated=${purchasersCreated} purchasersReused=${purchasersReused} approvalStatus=${isAlreadyApproved ? "approved" : "pending_approval"}`
      : `referenceNo=${newCase.referenceNo ?? "null"} purchasersCreated=${purchasersCreated} purchasersReused=${purchasersReused} approvalStatus=${newCase.approvalStatus ?? "pending_approval"}`;
    await r.insert(auditLogsTable).values({
      firmId,
      actorId: actorUserId,
      actorType: "firm_user",
      action: auditAction,
      entityType: "case",
      entityId: newCase.id,
      detail: auditDetail,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });
    if (legacy) {
      await r.insert(auditLogsTable).values({
        firmId,
        actorId: actorUserId,
        actorType: "firm_user",
        action: "cases.create",
        entityType: "case",
        entityId: newCase.id,
        detail: auditDetail,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      });
    }
  } catch (auditErr) {
    if (context.logger?.error) {
      context.logger.error({ err: auditErr, caseId: newCase.id }, "cases canonical: audit write failed (non-fatal)");
    }
  }

  return {
    case: newCase,
    purchasersCreated,
    purchasersReused,
    purchasers: responsePurchasers,
    assignments: responseAssignments,
    duplicate: false,
  };
}
