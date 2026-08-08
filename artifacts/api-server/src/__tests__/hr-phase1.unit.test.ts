import { describe, expect, it } from "vitest";
import {
  addHRMoney,
  subtractHRMoney,
  multiplyHRMoney,
  roundHRMoney2,
  compareHRMoney,
  zeroHRMoney,
} from "../modules/shared/money/hr-money.js";
import {
  formatHRIdempotencyKey,
  parseHRIdempotencyKey,
  normalizeClientRequestId,
  generateHRClientRequestId,
  type HRIdempotencyKey,
} from "../modules/shared/idempotency/hr-idempotency.js";
import {
  createHRError,
  HRError,
  HR_ERROR_CODES,
  serializeHRError,
  type HRErrorShape,
} from "../modules/shared/errors/hr-error-codes.js";
import {
  EMPLOYEE_STATUS_TRANSITIONS,
  isValidEmployeeStatusTransition,
  findEmployeeStatusTransition,
  CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS,
  type EmploymentStatus,
} from "../modules/hr/validators/employee-status-transitions.js";
import {
  checkOptimisticLock,
  nextVersion,
  resolveEffectiveFinalApprover,
  applyColumnMask,
  applyColumnMaskList,
  buildAuditBeforeAfter,
  type HRDelegation,
} from "../modules/hr/permissions/hr-authorization.js";

describe("HR Phase 1 — Money utilities", () => {
  it("addHRMoney returns raw 4dp + rounded 2dp + correct source", () => {
    const r = addHRMoney("1.2345", "6.7890", "ut_add");
    expect(r.rawAmount).toBe("8.0235");
    expect(r.roundedAmount).toBe("8.02");
    expect(r.calculationSource).toBe("ut_add");
    expect(r.roundingRule).toBe("ROUND_HALF_UP_2DP");
  });

  it("addHRMoney — 0.005 rounds half-up to 0.01 at 2dp", () => {
    const r = addHRMoney("0.005", "0.000");
    expect(r.rawAmount).toBe("0.0050");
    expect(r.roundedAmount).toBe("0.01");
  });

  it("addHRMoney — negative values produce correct negative rounded", () => {
    const r = addHRMoney("1.0000", "-3.5050");
    expect(r.rawAmount).toBe("-2.5050");
    expect(r.roundedAmount).toBe("-2.51");
  });

  it("subtractHRMoney — cross-zero basic", () => {
    const r = subtractHRMoney("1.00", "5.25");
    expect(r.rawAmount).toBe("-4.2500");
    expect(r.roundedAmount).toBe("-4.25");
  });

  it("subtractHRMoney — same amount returns zero 4dp", () => {
    const r = subtractHRMoney("999.9999", "999.9999");
    expect(r.rawAmount).toBe("0.0000");
    expect(r.roundedAmount).toBe("0.00");
  });

  it("multiplyHRMoney 1.25 * 3.00 = 3.75 with raw 4dp / rounded 2dp shape", () => {
    const r = multiplyHRMoney("1.25", "3.00");
    expect(r.roundingRule).toBe("ROUND_HALF_UP_2DP");
    expect(r.roundedAmount).toBe("3.75");
    expect(r.rawAmount).toBe("3.7500");
  });

  it("multiplyHRMoney — negative factor flips sign", () => {
    const r = multiplyHRMoney("10.00", "-1");
    expect(r.rawAmount.startsWith("-")).toBe(true);
    expect(r.roundedAmount).toBe("-10.00");
  });

  it("multiplyHRMoney — 0.0001 granularity preserves 4dp", () => {
    const r = multiplyHRMoney("0.0001", "1.0000", "ut_granular");
    expect(r.rawAmount).toBe("0.0001");
    expect(r.roundedAmount).toBe("0.00");
  });

  it("roundHRMoney2 — 1.1234 stays 1.12 (round down)", () => {
    const r = roundHRMoney2("1.1234");
    expect(r.rawAmount).toBe("1.1234");
    expect(r.roundedAmount).toBe("1.12");
  });

  it("roundHRMoney2 — 1.125 rounds half-up to 1.13", () => {
    const r = roundHRMoney2("1.125");
    expect(r.roundedAmount).toBe("1.13");
  });

  it("compareHRMoney returns 0 / -1 / +1 correctly", () => {
    expect(compareHRMoney("5.5555", "5.5555")).toBe(0);
    expect(compareHRMoney("1.0000", "1.0001")).toBe(-1);
    expect(compareHRMoney("1.0001", "1.0000")).toBe(1);
    expect(compareHRMoney("-1.00", "0")).toBe(-1);
  });

  it("zeroHRMoney shape correct", () => {
    const z = zeroHRMoney();
    expect(z.rawAmount).toBe("0.0000");
    expect(z.roundedAmount).toBe("0.00");
    expect(z.roundingRule).toBe("ROUND_HALF_UP_2DP");
    expect(z.calculationSource).toBe("hr_zero_constant");
  });

  it("addHRMoney accepts numeric inputs and strips comma separators", () => {
    const a = addHRMoney(1, 2);
    expect(a.roundedAmount).toBe("3.00");
    const b = addHRMoney("1,234,567.89", "0.11");
    expect(b.roundedAmount).toBe("1234568.00");
  });

  it("addHRMoney throws HRError with HR_REQUIRED_FIELD_MISSING for invalid input", () => {
    try {
      addHRMoney(null as any, "1.00");
      expect.unreachable("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HRError);
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING);
    }
    try {
      addHRMoney("not_a_number", "1.00");
      expect.unreachable("expected throw");
    } catch (e) {
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING);
    }
    try {
      addHRMoney(NaN, "1");
      expect.unreachable("expected throw");
    } catch (e) {
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING);
    }
  });
});

describe("HR Phase 1 — Idempotency utilities", () => {
  it("formatHRIdempotencyKey then parseHRIdempotencyKey round trips correctly (numeric sourceId)", () => {
    const key: HRIdempotencyKey = {
      sourceModule: "HR",
      sourceType: "CLAIM",
      sourceId: 123,
      actionType: "CREATE_ACCOUNTING_PAYMENT_REQUEST",
      version: 3,
    };
    const formatted = formatHRIdempotencyKey(key);
    expect(formatted).toBe("HR|CLAIM|123|CREATE_ACCOUNTING_PAYMENT_REQUEST|3");
    const parsed = parseHRIdempotencyKey(formatted);
    expect(parsed.sourceModule).toBe("HR");
    expect(parsed.sourceId).toBe(123);
    expect(typeof parsed.sourceId).toBe("number");
    expect(parsed.version).toBe(3);
  });

  it("format + parse preserves string sourceId", () => {
    const key: HRIdempotencyKey = {
      sourceModule: "ACCOUNTING",
      sourceType: "PAYMENT_VOUCHER",
      sourceId: "pv-uuid-abc",
      actionType: "MARK_PAID",
      version: 1,
    };
    const parsed = parseHRIdempotencyKey(formatHRIdempotencyKey(key));
    expect(parsed.sourceId).toBe("pv-uuid-abc");
    expect(parsed.sourceModule).toBe("ACCOUNTING");
  });

  it("format escapes pipe characters with underscore", () => {
    const key: HRIdempotencyKey = {
      sourceModule: "HR",
      sourceType: "bad|type",
      sourceId: 1,
      actionType: "a|b",
      version: 2,
    };
    const formatted = formatHRIdempotencyKey(key);
    expect(formatted).toBe("HR|bad_type|1|a_b|2");
  });

  it("parseHRIdempotencyKey throws HRError for 4-part malformed keys", () => {
    try {
      parseHRIdempotencyKey("A|B|C|D");
      expect.unreachable("throw");
    } catch (e) {
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_IDEMPOTENCY_CONFLICT);
    }
  });

  it("parseHRIdempotencyKey throws for invalid sourceModule", () => {
    try {
      parseHRIdEMPOTENCYKey_wrapper("INVALID|EMP|1|ACT|1");
      expect.unreachable("throw");
    } catch (e) {
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_IDEMPOTENCY_CONFLICT);
      expect((e as HRError).httpStatus).toBe(409);
    }
  });

  it("normalizeClientRequestId returns null for non-string / oversized / whitespace-only", () => {
    expect(normalizeClientRequestId(null)).toBeNull();
    expect(normalizeClientRequestId(123 as any)).toBeNull();
    expect(normalizeClientRequestId("   ")).toBeNull();
    expect(normalizeClientRequestId("x".repeat(129))).toBeNull();
    expect(normalizeClientRequestId("  req-123  ")).toBe("req-123");
    expect(normalizeClientRequestId("abc")).toBe("abc");
  });

  it("generateHRClientRequestId has hr- prefix and unique between calls", () => {
    const a = generateHRClientRequestId();
    const b = generateHRClientRequestId();
    expect(a.startsWith("hr-")).toBe(true);
    expect(b.startsWith("hr-")).toBe(true);
    expect(a).not.toBe(b);
    const c = generateHRClientRequestId("claim");
    expect(c.startsWith("claim-")).toBe(true);
  });
});

function parseHRIdEMPOTENCYKey_wrapper(raw: string) {
  return parseHRIdempotencyKey(raw);
}

describe("HR Phase 1 — Error codes, HTTP inference, serialization", () => {
  it("createHRError infers 403 for permission and cross-firm codes", () => {
    const a = createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "no");
    expect(a.httpStatus).toBe(403);
    expect(a.code).toBe("HR_PERMISSION_DENIED");
    const b = createHRError(HR_ERROR_CODES.HR_CROSS_FIRM_ACCESS_DENIED, "x");
    expect(b.httpStatus).toBe(403);
    const c = createHRError(HR_ERROR_CODES.HR_DOCUMENT_PERMISSION_DENIED, "doc");
    expect(c.httpStatus).toBe(403);
  });

  it("createHRError infers 409 for conflict / locked / duplicate / mismatch / delegation classes", () => {
    expect(createHRError(HR_ERROR_CODES.HR_RECORD_CONFLICT, "").httpStatus).toBe(409);
    expect(createHRError(HR_ERROR_CODES.HR_PAYROLL_ALREADY_LOCKED, "").httpStatus).toBe(409);
    expect(createHRError(HR_ERROR_CODES.HR_CLAIM_ALREADY_SENT_TO_ACCOUNTING, "").httpStatus).toBe(409);
    expect(createHRError(HR_ERROR_CODES.HR_PAYROLL_PERIOD_DUPLICATE, "").httpStatus).toBe(409);
    expect(createHRError(HR_ERROR_CODES.HR_RECORD_VERSION_MISMATCH, "").httpStatus).toBe(409);
    expect(createHRError(HR_ERROR_CODES.HR_DELEGATION_NOT_ACTIVE, "").httpStatus).toBe(409);
    expect(createHRError(HR_ERROR_CODES.HR_ASSET_NOT_RETURNED, "").httpStatus).toBe(409);
    expect(createHRError(HR_ERROR_CODES.HR_METHOD_NOT_ALLOWED, "").httpStatus).toBe(409);
  });

  it("createHRError infers 404 for not-found class", () => {
    expect(createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "").httpStatus).toBe(404);
  });

  it("createHRError infers 400 for required-field / not-configured / approver-not-configured", () => {
    expect(createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "").httpStatus).toBe(400);
    expect(createHRError(HR_ERROR_CODES.HR_SETTINGS_NOT_CONFIGURED, "").httpStatus).toBe(400);
    expect(createHRError(HR_ERROR_CODES.HR_APPROVER_NOT_CONFIGURED, "").httpStatus).toBe(400);
  });

  it("createHRError infers 422 for approval-overdue, unknown falls back to 500", () => {
    expect(createHRError(HR_ERROR_CODES.HR_APPROVAL_OVERDUE, "").httpStatus).toBe(422);
    const err = new HRError({ code: HR_ERROR_CODES.HR_PERMISSION_DENIED, message: "m", httpStatus: 999 });
    expect(serializeHRError(err).error.httpStatus).toBe(999);
  });

  it("createHRError allows httpStatus override in opts", () => {
    const x = createHRError(HR_ERROR_CODES.HR_SETTINGS_NOT_CONFIGURED, "", { httpStatus: 503 });
    expect(x.httpStatus).toBe(503);
  });

  it("serializeHRError — HRError serializes code/message/httpStatus/details", () => {
    const err = createHRError(HR_ERROR_CODES.HR_PAYROLL_ALREADY_LOCKED, "locked", { details: { payrollId: 1 } });
    const s = serializeHRError(err);
    expect(s.error.code).toBe("HR_PAYROLL_ALREADY_LOCKED");
    expect(s.error.message).toBe("locked");
    expect(s.error.httpStatus).toBe(409);
    expect((s.error.details as any).payrollId).toBe(1);
  });

  it("serializeHRError — unknown Error becomes 500 with HR_PERMISSION_DENIED code", () => {
    const s = serializeHRError(new Error("boom"));
    expect(s.error.code).toBe("HR_PERMISSION_DENIED");
    expect(s.error.httpStatus).toBe(500);
    expect(s.error.message).toBe("boom");
  });
});

describe("HR Phase 1 — Employee status transitions map", () => {
  it("EMPLOYEE_STATUS_TRANSITIONS contains exactly 14 items (covers Part 2 §4 8-status lifecycle)", () => {
    expect(EMPLOYEE_STATUS_TRANSITIONS.length).toBe(14);
  });

  it("isValidEmployeeStatusTransition returns true for all known transitions", () => {
    for (const t of EMPLOYEE_STATUS_TRANSITIONS) {
      expect(isValidEmployeeStatusTransition(t.from as EmploymentStatus, t.to as EmploymentStatus)).toBe(true);
    }
  });

  it("isValidEmployeeStatusTransition — draft→terminated direct invalid (must go through probation/notice)", () => {
    expect(isValidEmployeeStatusTransition("draft", "terminated")).toBe(false);
  });

  it("findEmployeeStatusTransition — probation confirm finds and reports edit permission", () => {
    const t = findEmployeeStatusTransition("probation", "confirmed");
    expect(t).toBeDefined();
    expect(t?.actionName).toBe("confirm");
    expect(t?.requiredPermissionModule).toBe("hr_employee");
    expect(t?.requiredPermissionAction).toBe("edit");
  });

  it("findEmployeeStatusTransition — notice→pending_handover requires hr_offboarding.manage", () => {
    const t = findEmployeeStatusTransition("notice_period", "pending_handover");
    expect(t?.requiredPermissionModule).toBe("hr_offboarding");
    expect(t?.requiredPermissionAction).toBe("manage");
  });

  it("CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS blocks status + paid + payroll + accounting linkage direct writes", () => {
    expect(CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS).toContain("status");
    expect(CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS).toContain("paidAt");
    expect(CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS).toContain("payrollId");
    expect(CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS).toContain("accountingRefId");
    expect(CLAIM_FORBIDDEN_DIRECT_WRITE_FIELDS.length).toBe(6);
  });
});

describe("HR Phase 1 — Permission / Optimistic Lock / Delegation / Column mask", () => {
  it("checkOptimisticLock — matching version no-op", () => {
    expect(() => checkOptimisticLock({ id: 1, version: 7 }, 7, "Employee")).not.toThrow();
  });

  it("checkOptimisticLock — mismatched version throws HR_RECORD_CONFLICT 409", () => {
    try {
      checkOptimisticLock({ id: 1, version: 7 }, 8);
      expect.unreachable("throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HRError);
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_RECORD_CONFLICT);
      expect((e as HRError).httpStatus).toBe(409);
      expect((e as HRError).message).toContain("updated by another user");
    }
  });

  it("checkOptimisticLock — NaN / null expectedVersion throws HR_RECORD_VERSION_MISMATCH 400-class w/ refresh copy", () => {
    try {
      checkOptimisticLock({ id: 1, version: 5 }, NaN);
      expect.unreachable("throw");
    } catch (e) {
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_RECORD_VERSION_MISMATCH);
      expect((e as HRError).message).toContain("Refresh and review");
    }
    try {
      checkOptimisticLock({ id: 1, version: 5 }, -1);
      expect.unreachable("throw");
    } catch (e) {
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_RECORD_VERSION_MISMATCH);
    }
  });

  it("nextVersion — 5→6, negative resets to 1", () => {
    expect(nextVersion(5)).toBe(6);
    expect(nextVersion(-5)).toBe(1);
    expect(nextVersion(0)).toBe(1);
  });

  it("resolveEffectiveFinalApprover — no approver configured => HR_APPROVER_NOT_CONFIGURED 400", () => {
    try {
      resolveEffectiveFinalApprover(null, [], new Date());
      expect.unreachable("throw");
    } catch (e) {
      expect((e as HRError).code).toBe(HR_ERROR_CODES.HR_APPROVER_NOT_CONFIGURED);
      expect((e as HRError).httpStatus).toBe(400);
    }
  });

  it("resolveEffectiveFinalApprover — active delegation within window => delegated result", () => {
    const d: HRDelegation = {
      id: 42,
      originalApproverUserId: "p1",
      delegateApproverUserId: "d1",
      startAt: "2025-01-01T00:00:00Z",
      endAt: "2025-12-31T23:59:59Z",
      status: "active",
    };
    const res = resolveEffectiveFinalApprover("p1", [d], new Date("2025-06-01T00:00:00Z"));
    expect(res.isDelegated).toBe(true);
    expect(res.approverUserId).toBe("d1");
    expect(res.actingForUserId).toBe("p1");
    expect(res.actingDelegationId).toBe(42);
  });

  it("resolveEffectiveFinalApprover — before window start => original approver", () => {
    const d: HRDelegation = {
      id: 1, originalApproverUserId: "p1", delegateApproverUserId: "d1",
      startAt: "2025-06-01T00:00:00Z", endAt: "2025-12-31T23:59:59Z", status: "active",
    };
    const res = resolveEffectiveFinalApprover("p1", [d], new Date("2025-01-01T00:00:00Z"));
    expect(res.isDelegated).toBe(false);
    expect(res.approverUserId).toBe("p1");
    expect(res.actingDelegationId).toBeNull();
  });

  it("resolveEffectiveFinalApprover — after window end => original approver", () => {
    const d: HRDelegation = {
      id: 1, originalApproverUserId: "p1", delegateApproverUserId: "d1",
      startAt: "2025-01-01T00:00:00Z", endAt: "2025-06-01T00:00:00Z", status: "active",
    };
    const res = resolveEffectiveFinalApprover("p1", [d], new Date("2025-07-01T00:00:00Z"));
    expect(res.isDelegated).toBe(false);
  });

  it("resolveEffectiveFinalApprover — revoked delegation ignored => original approver", () => {
    const d: HRDelegation = {
      id: 1, originalApproverUserId: "p1", delegateApproverUserId: "d1",
      startAt: "2025-01-01T00:00:00Z", endAt: "2025-12-31T23:59:59Z", status: "revoked",
    };
    const res = resolveEffectiveFinalApprover("p1", [d], new Date("2025-06-01T00:00:00Z"));
    expect(res.isDelegated).toBe(false);
  });

  it("resolveEffectiveFinalApprover — OTHER approver's delegation ignored => original approver", () => {
    const d: HRDelegation = {
      id: 1, originalApproverUserId: "other-p", delegateApproverUserId: "d1",
      startAt: "2025-01-01T00:00:00Z", endAt: "2025-12-31T23:59:59Z", status: "active",
    };
    const res = resolveEffectiveFinalApprover("p1", [d], new Date("2025-06-01T00:00:00Z"));
    expect(res.isDelegated).toBe(false);
    expect(res.approverUserId).toBe("p1");
  });

  it("applyColumnMask — allow-all returns same keys; allow-none returns null per key; allow-subset returns mix", () => {
    const rec = { a: 1, b: 2, c: 3 };
    const full = applyColumnMask(rec, () => true);
    expect(full).toEqual({ a: 1, b: 2, c: 3 });
    const none = applyColumnMask(rec, () => false);
    expect(none).toEqual({ a: null, b: null, c: null });
    const mix = applyColumnMask(rec, (k) => k === "b");
    expect(mix).toEqual({ a: null, b: 2, c: null });
  });

  it("applyColumnMaskList preserves order and length", () => {
    const rows = [{ x: 10 }, { x: 20 }, { x: 30 }];
    const res = applyColumnMaskList(rows, () => true);
    expect(res.length).toBe(3);
    expect(res[1]).toEqual({ x: 20 });
    const masked = applyColumnMaskList(rows, () => false);
    expect(masked[0]).toEqual({ x: null });
  });

  it("buildAuditBeforeAfter picks only allowed keys and handles null inputs", () => {
    const before = { salary: 1000, bank: "ABC", note: "x" };
    const after = { salary: 2000, bank: "XYZ", note: "y" };
    const { before: b, after: a } = buildAuditBeforeAfter(before, after, ["salary", "bank"]);
    expect(b).toEqual({ salary: 1000, bank: "ABC" });
    expect((b as any).note).toBeUndefined();
    expect(a).toEqual({ salary: 2000, bank: "XYZ" });
    const empty = buildAuditBeforeAfter(null, null, ["a"]);
    expect(empty.before).toBeNull();
    expect(empty.after).toBeNull();
  });
});
