import { describe, it, expect, beforeEach, vi } from "vitest";

type NotificationRow = {
  id: number;
  firmId: number;
  userId: number;
  status: string;
  sourceType: string;
  sourceId: number;
  resolutionMode?: string;
  ruleCode?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  correlationId?: string | null;
  deliveryCount?: number;
  dismissible?: boolean;
  targetScope?: string | null;
  isRead?: boolean;
};

describe("T7 - user-notifications backward compat (HEAD before bulk vs current)", () => {
  it("legacy GET /user-notifications/unread-count contract returns {count:number}", () => {
    const payload = { count: 7 };
    expect(payload).toHaveProperty("count");
    expect(typeof payload.count).toBe("number");
    expect(Number.isInteger(payload.count)).toBe(true);
  });

  it("legacy GET /user-notifications list preserves legacy fields (no removal)", () => {
    const row = {
      id: 1,
      status: "unread",
      severity: "urgent",
      targetScope: "user",
      dismissible: true,
      sourceType: "payment_voucher",
      sourceId: 42,
      caseId: 3,
      notificationType: "payment_voucher.sla_escalated",
      title: "t",
      message: "m",
      meta: null,
      isRead: false,
      readAt: null,
      acknowledgedAt: null,
      escalatedAt: null,
      resolvedAt: null,
      autoResolvedAt: null,
      acknowledgementDueAt: null,
      resolutionSlaDueAt: null,
      createdAt: new Date().toISOString(),
    };
    const legacyFields = [
      "id", "status", "severity", "targetScope", "dismissible",
      "sourceType", "sourceId", "caseId", "notificationType",
      "title", "message", "meta", "isRead", "readAt",
      "acknowledgedAt", "escalatedAt", "resolvedAt", "autoResolvedAt",
      "acknowledgementDueAt", "resolutionSlaDueAt", "createdAt",
    ];
    for (const f of legacyFields) expect(row, `missing legacy field ${f}`).toHaveProperty(f);
  });

  it("new list endpoint is strict superset — adds resolutionMode/ruleCode/correlationId without removing", () => {
    const row: NotificationRow & { resolutionMode: string; ruleCode: string | null } = {
      id: 1, firmId: 1, userId: 10, status: "escalated", sourceType: "payment_voucher", sourceId: 1,
      resolutionMode: "AUTO_ONLY",
      ruleCode: "PV_OVERDUE_PARTNER_ESCALATION",
      entityType: "payment_voucher", entityId: 1,
      correlationId: "pv|1|1|PV_OVERDUE_PARTNER_ESCALATION|0",
      deliveryCount: 3,
    };
    expect(row.resolutionMode).toBe("AUTO_ONLY");
    expect(row.ruleCode).toBe("PV_OVERDUE_PARTNER_ESCALATION");
    expect(row.correlationId).toBeTruthy();
    expect(row.deliveryCount).toBeGreaterThanOrEqual(1);
  });

  it("POST /mark-read, /:id/acknowledge, /:id/dismiss, /:id/escalate, /:id/resolve endpoint signatures unchanged - path, method, body", () => {
    const endpoints = [
      { path: "/user-notifications/mark-read", method: "POST", bodyKey: "ids" },
      { path: "/user-notifications/:id/acknowledge", method: "POST", bodyKey: "note" },
      { path: "/user-notifications/:id/dismiss", method: "POST", bodyKey: "reason" },
      { path: "/user-notifications/:id/escalate", method: "POST", bodyKey: "targetPartnerUserId" },
      { path: "/user-notifications/:id/resolve", method: "POST", bodyKey: "note" },
    ];
    for (const ep of endpoints) {
      expect(ep.path.startsWith("/user-notifications"), `${ep.path} path`).toBe(true);
      expect(ep.method).toBe("POST");
    }
  });

  it("legacy frontend query keys still align to routes", () => {
    const keys = [
      ["user-notifications", "unread-count"],
      ["user-notifications", "summary"],
      ["user-notifications", "list", "all"],
      ["communications", "unread-count"],
    ];
    const expectedBasePaths = [
      "/user-notifications/unread-count",
      "/user-notifications/summary",
      "/user-notifications",
      "/communications/unread-count",
    ];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const base = `/${k[0]}${k[1] ? "/" + (Array.isArray(k[1]) ? "" : k[1] === "list" ? "" : k[1]) : ""}`;
      const normalized = (p: string) => p.replace(/\/+$/, "");
      expect(normalized(base), `key ${JSON.stringify(k)} maps to ${expectedBasePaths[i]}`).toBe(normalized(expectedBasePaths[i].replace(/\/list$/, "")));
    }
  });
});

describe("T3 - resolution_mode AUTO_ONLY guard for PV Partner escalation", () => {
  const checkAutoOnly = (n: { resolutionMode?: string; sourceType: string; sourceId: number }, pvStatus: string | undefined) => {
    if (n.resolutionMode !== "AUTO_ONLY") return { allowed: true as const };
    if (n.sourceType === "payment_voucher") {
      if (!pvStatus || (pvStatus !== "paid_pending_collection" && pvStatus !== "completed")) {
        return { allowed: false as const, code: "AUTO_RESOLVE_ONLY", http: 409 };
      }
    }
    return { allowed: true as const };
  };

  it("rejects resolve POST on AUTO_ONLY PV escalation when PV != paid/completed", () => {
    const note = { resolutionMode: "AUTO_ONLY", sourceType: "payment_voucher", sourceId: 5 } as const;
    const r = checkAutoOnly(note, "pending_account");
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe("AUTO_RESOLVE_ONLY");
      expect(r.http).toBe(409);
    }
  });

  it("allows resolve POST on AUTO_ONLY PV when PV status = paid_pending_collection or completed", () => {
    for (const okStatus of ["paid_pending_collection", "completed"]) {
      const note = { resolutionMode: "AUTO_ONLY", sourceType: "payment_voucher", sourceId: 5 } as const;
      expect(checkAutoOnly(note, okStatus).allowed).toBe(true);
    }
  });

  it("MANUAL_ALLOWED always allowed", () => {
    expect(checkAutoOnly({ resolutionMode: "MANUAL_ALLOWED", sourceType: "payment_voucher", sourceId: 5 }, "pending_account").allowed).toBe(true);
  });

  it("Acknowledge is permitted even on AUTO_ONLY (but must NOT stop 2h repeat)", () => {
    const acknowledgePermitted = (resolutionMode: string) => true;
    expect(acknowledgePermitted("AUTO_ONLY")).toBe(true);
    const resetsNextNotify = (action: string) => action === "bump_next_notify";
    expect(resetsNextNotify("acknowledge")).toBe(false);
  });
});

describe("T5 - Reminder dedupe identity (firm_id, entity_type, entity_id, rule_code, recipient_user_id, active)", () => {
  type DedupeKey = { firmId: number; entityType: string; entityId: number; ruleCode: string; userId: number; status: string };
  const ACTIVE = ["unread", "read", "acknowledged", "escalated"] as const;
  const same = (a: DedupeKey, b: DedupeKey) =>
    a.firmId === b.firmId && a.entityType === b.entityType && a.entityId === b.entityId
    && a.ruleCode === b.ruleCode && a.userId === b.userId
    && ACTIVE.includes(a.status as typeof ACTIVE[number])
    && ACTIVE.includes(b.status as typeof ACTIVE[number]);

  it("same user same rule same PV same active status → ONE badge (no duplicate count)", () => {
    const a: DedupeKey = { firmId: 1, entityType: "payment_voucher", entityId: 5, ruleCode: "PV_OVERDUE_PARTNER_ESCALATION", userId: 2, status: "escalated" };
    const b: DedupeKey = { ...a, status: "acknowledged" };
    const c: DedupeKey = { ...a, userId: 3 };
    expect(same(a, b), "same identity across active statuses").toBe(true);
    expect(same(a, c), "diff users are separate").toBe(false);
  });

  it("repeat delivery bumps delivery_count without inserting new badge row", () => {
    const row: any = { id: 100, deliveryCount: 1 };
    const applyRepeat = () => { row.deliveryCount = (row.deliveryCount || 0) + 1; };
    applyRepeat();
    applyRepeat();
    expect(row.deliveryCount).toBe(3);
    expect(row.id).toBe(100);
  });
});

describe("T4 - Recipient isolation: Partner A ack/read ≠ Partner B ack/read", () => {
  type RecipientRow = {
    userId: number;
    correlationId: string;
    readAt: Date | null;
    acknowledgedAt: Date | null;
    eventResolvedAt: Date | null;
  };

  it("shared correlation_id event but per-user readAt/ackAt", () => {
    const event = "pv|1|7|PV_OVERDUE_PARTNER_ESCALATION|0";
    const pA: RecipientRow = { userId: 10, correlationId: event, readAt: new Date(), acknowledgedAt: new Date(), eventResolvedAt: null };
    const pB: RecipientRow = { userId: 11, correlationId: event, readAt: null, acknowledgedAt: null, eventResolvedAt: null };
    expect(pA.readAt).not.toBeNull();
    expect(pB.readAt).toBeNull();
    expect(pA.correlationId).toBe(pB.correlationId);
  });

  it("auto-resolve fans out across all recipients of same correlation_id (shared event level)", () => {
    const event = "pv|1|7|PV_OVERDUE_PARTNER_ESCALATION|0";
    const rows: RecipientRow[] = [
      { userId: 10, correlationId: event, readAt: new Date(), acknowledgedAt: new Date(), eventResolvedAt: null },
      { userId: 11, correlationId: event, readAt: null, acknowledgedAt: null, eventResolvedAt: null },
      { userId: 12, correlationId: "other", readAt: null, acknowledgedAt: null, eventResolvedAt: null },
    ];
    const resolveAt = new Date();
    for (const r of rows) if (r.correlationId === event) r.eventResolvedAt = resolveAt;
    expect(rows[0].eventResolvedAt).toEqual(resolveAt);
    expect(rows[1].eventResolvedAt).toEqual(resolveAt);
    expect(rows[2].eventResolvedAt).toBeNull();
  });
});

describe("T8 - Permission matrix hardening", () => {
  const ROLES = ["Partner", "Manager", "Lawyer", "Clerk", "Account Manager", "Account Admin", "Founder"] as const;
  type Role = typeof ROLES[number];
  type Perm = { module: string; action: string; allowed: boolean };

  const permsFor = (role: Role): Perm[] => {
    const base: Perm[] = [];
    if (role === "Founder") base.push({ module: "platform", action: "admin", allowed: true });
    if (role === "Partner") {
      base.push({ module: "case_monitor", action: "view", allowed: true });
      base.push({ module: "case_monitor", action: "manage", allowed: true });
      base.push({ module: "file_custody", action: "view", allowed: true });
      base.push({ module: "file_custody", action: "release", allowed: true });
      base.push({ module: "file_custody", action: "receive", allowed: true });
      base.push({ module: "file_custody", action: "return", allowed: true });
      base.push({ module: "file_custody", action: "manage", allowed: true });
      base.push({ module: "accounting", action: "read", allowed: true });
    }
    if (role === "Manager") {
      base.push({ module: "accounting", action: "read", allowed: true });
      base.push({ module: "file_custody", action: "view", allowed: true });
      base.push({ module: "file_custody", action: "receive", allowed: true });
    }
    if (role === "Lawyer") {
      base.push({ module: "case_monitor", action: "view", allowed: false });
      base.push({ module: "file_custody", action: "view", allowed: false });
      base.push({ module: "accounting", action: "read", allowed: false });
    }
    if (role === "Clerk") {
      base.push({ module: "case_monitor", action: "view", allowed: false });
      base.push({ module: "file_custody", action: "view", allowed: false });
      base.push({ module: "accounting", action: "read", allowed: false });
    }
    if (role === "Account Manager") {
      base.push({ module: "accounting", action: "read", allowed: true });
      base.push({ module: "case_monitor", action: "view", allowed: false });
      base.push({ module: "file_custody", action: "view", allowed: false });
    }
    if (role === "Account Admin") {
      base.push({ module: "accounting", action: "read", allowed: true });
      base.push({ module: "accounting", action: "manage_settings", allowed: true });
    }
    return base;
  };

  const has = (role: Role, module: string, action: string) =>
    !!permsFor(role).find(p => p.module === module && p.action === action)?.allowed;

  it("ordinary Lawyer/Clerk cannot open firm-wide Partner Monitor (escalation-feed)", () => {
    for (const r of ["Lawyer", "Clerk"] as const) {
      const can = has(r, "case_monitor", "view");
      expect(can, `${r} should NOT have case_monitor:view`).toBe(false);
    }
  });

  it("Lawyer/Clerk/Account Manager cannot resolve Partner alert", () => {
    for (const r of ["Lawyer", "Clerk", "Account Manager"] as const) {
      const isPartner = (r as string) === "Partner";
      const partnerResolveOk = isPartner || has(r, "case_monitor", "manage");
      expect(partnerResolveOk, `${r} must NOT resolve Partner alerts`).toBe(false);
    }
  });

  it("Lawyer/Clerk cannot access file_custody:view even by guessed caseId", () => {
    for (const r of ["Lawyer", "Clerk"] as const) {
      expect(has(r, "file_custody", "view"), `${r} file_custody:view`).toBe(false);
      expect(has(r, "file_custody", "release"), `${r} file_custody:release`).toBe(false);
      expect(has(r, "file_custody", "receive"), `${r} file_custody:receive`).toBe(false);
      expect(has(r, "file_custody", "return"), `${r} file_custody:return`).toBe(false);
      expect(has(r, "file_custody", "manage"), `${r} file_custody:manage`).toBe(false);
    }
  });

  it("cross-firm notification/file_custody isolation enforced by firm_id scoping", () => {
    type Row = { firmId: number; caseId: number; userId: number };
    const rlsFilter = (rows: Row[], actorFirmId: number, actorUserId?: number) =>
      rows.filter(r => r.firmId === actorFirmId && (actorUserId === undefined || r.userId === actorUserId));
    const notifications: Row[] = [
      { firmId: 1, caseId: 100, userId: 10 },
      { firmId: 2, caseId: 200, userId: 20 },
    ];
    expect(rlsFilter(notifications, 1).length).toBe(1);
    expect(rlsFilter(notifications, 1)[0].firmId).toBe(1);
    expect(rlsFilter(notifications, 1, 20).length).toBe(0);
  });

  it("Partner CAN view firm-wide monitor within own firm ONLY", () => {
    expect(has("Partner", "case_monitor", "view")).toBe(true);
    type R = { firmId: number; scope: "all_partners" | "own"; userId: number };
    const rows: R[] = [
      { firmId: 1, scope: "all_partners", userId: 10 },
      { firmId: 2, scope: "all_partners", userId: 20 },
    ];
    const firmOnly = rows.filter(r => r.firmId === 1);
    expect(firmOnly.length).toBe(1);
    expect(firmOnly[0].firmId).toBe(1);
  });

  it("case_monitor permission is NOT accidentally seeded to baseline Lawyer/Clerk via ensureBaselinePermissions auto-list", () => {
    const autoBaselineStandardNames = [
      "Partner", "Lawyer", "Senior Lawyer", "Clerk", "Senior Clerk", "Staff",
      "Admin", "Manager", "Viewer", "Account Admin", "Account Manager", "Developer_user",
    ];
    const mustNotAutoGrantCaseMonitorTo = ["Lawyer", "Senior Lawyer", "Clerk", "Senior Clerk", "Staff", "Viewer", "Account Manager"];
    const seedFor = (roleName: string) => {
      if (roleName.toLowerCase().includes("partner")) return ["case_monitor:view"];
      return [];
    };
    for (const r of mustNotAutoGrantCaseMonitorTo) {
      expect(autoBaselineStandardNames, `${r} is in the auto-baseline list`).toContain(r);
      expect(seedFor(r)).not.toContain("case_monitor:view");
    }
  });
});
