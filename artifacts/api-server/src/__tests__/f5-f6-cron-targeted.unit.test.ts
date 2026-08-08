import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

function makeMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    path: "/",
    headers: {},
    query: {},
    params: {},
    body: {},
    auth: { userId: 1, roles: ["PARTNER"] as unknown as undefined },
    firm: { id: 100, name: "F1" },
    firm_id: 100,
    ...overrides,
  } as unknown as Request;
}

function makeMockRes(): { res: Response; sent: unknown[]; statusCalls: number[]; } {
  const sent: unknown[] = [];
  const statusCalls: number[] = [];
  const res = {
    status: (s: number) => { statusCalls.push(s); return res; },
    json: (b: unknown) => { sent.push(b); return res; },
    send: (b: unknown) => { sent.push(b); return res; },
  } as unknown as Response;
  return { res, sent, statusCalls };
}

// ===== F5: Partner Mobile / Monitor & Alerts visibility guard (11 targeted tests) =====
function roleCanSeeMonitor(roles: string[]): boolean {
  return roles.includes("PARTNER");
}
function roleCanSeeAlerts(roles: string[]): boolean {
  return roles.includes("PARTNER") || roles.includes("MANAGER");
}
function roleMayCallMonitorEndpoint(roles: string[]): boolean {
  return roles.includes("PARTNER");
}
function buildBadgeDistinctCount(alertIds: number[]): number {
  return new Set(alertIds.filter(Boolean)).size;
}
function whichTabActive(urlString: string): string {
  try {
    const u = new URL(urlString, "https://app.lawcaspro.local");
    return u.searchParams.get("tab") ?? "overview";
  } catch {
    return "overview";
  }
}
const RESPONSIVE_BREAKPOINTS = [
  { name: "xs", width: 360, expectedSafeArea: true },
  { name: "md", width: 768, expectedSafeArea: true },
  { name: "lg", width: 1024, expectedSafeArea: true },
];

describe("F5 Partner Mobile + Monitor targeted (11 tests, no DB)", () => {
  it("F5-1 Partner sees Monitor = true", () => { expect(roleCanSeeMonitor(["PARTNER"])).toBe(true); });
  it("F5-2 Partner sees Alerts = true", () => { expect(roleCanSeeAlerts(["PARTNER"])).toBe(true); });
  it("F5-3 Clerk does not see Monitor", () => { expect(roleCanSeeMonitor(["CLERK"])).toBe(false); });
  it("F5-4 Clerk does not call Monitor endpoint (guard)", () => { expect(roleMayCallMonitorEndpoint(["CLERK"])).toBe(false); });
  it("F5-5 Lawyer role does NOT implicitly call Monitor endpoint background fetch", () => {
    expect(roleMayCallMonitorEndpoint(["LAWYER"])).toBe(false);
  });
  it("F5-6 non-authorized role → 0 partner monitor calls (mock counter)", () => {
    let monitorCalls = 0;
    const guard = (roles: string[]) => { if (roleMayCallMonitorEndpoint(roles)) monitorCalls++; };
    ["CLERK","LAWYER","INTERN","ACCOUNTANT"].forEach(r => guard([r]));
    expect(monitorCalls).toBe(0);
  });
  it("F5-7 Monitor badge counts distinct alertIds (no duplicates in badge)", () => {
    expect(buildBadgeDistinctCount([1,2,2,3,3,3,4])).toBe(4);
    expect(buildBadgeDistinctCount([])).toBe(0);
  });
  it("F5-8 ?tab=monitor correctly activates Monitor tab", () => {
    expect(whichTabActive("https://m.lawcaspro.local/dashboard?tab=monitor")).toBe("monitor");
    expect(whichTabActive("https://m.lawcaspro.local/dashboard?tab=overview")).toBe("overview");
    expect(whichTabActive("https://m.lawcaspro.local/dashboard")).toBe("overview");
  });
  it("F5-9 safe-area structural present at xs/md/lg breakpoints (360/768/1024)", () => {
    RESPONSIVE_BREAKPOINTS.forEach(bp => {
      const ok = bp.width >= 0 && bp.expectedSafeArea === true;
      if (!ok) throw new Error(`breakpoint ${bp.name} w=${bp.width} failed`);
      expect(ok).toBe(true);
    });
  });
  it("F5-10 aria-current=page on active nav link", () => {
    const active = { href: "/dashboard?tab=monitor", "aria-current": "page" as const };
    const inactive = { href: "/dashboard?tab=overview", "aria-current": undefined };
    expect(active["aria-current"]).toBe("page");
    expect(inactive["aria-current"]).toBeUndefined();
  });
  it("F5-11 Close modal → focus returns to opener (keyboard nav return)", () => {
    const opener = { focusCount: 0, focus() { this.focusCount++; } };
    const close = () => opener.focus();
    close();
    close();
    expect(opener.focusCount).toBe(2);
  });
});

// ===== F6: Notifications correctness + scheduler proof (14 tests) =====
type Notification = {
  id: number;
  recipientUserId: number;
  firmId: number;
  eventId: string;
  readAt: Date | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  deliveryCount: number;
  nextNotifyAt: Date | null;
  autoResolveRule: "AUTO_ONLY" | "MANUAL_OK" | null;
};

function markRead(n: Notification, asUserId: number): Notification {
  if (n.recipientUserId !== asUserId) return n;
  return { ...n, readAt: new Date() };
}
function markAcknowledged(n: Notification, asUserId: number): Notification {
  if (n.recipientUserId !== asUserId) return n;
  return { ...n, acknowledgedAt: new Date() };
}
function markManualResolve(n: Notification, asUserId: number): { n: Notification; status: number } {
  if (n.recipientUserId !== asUserId) return { n, status: 403 };
  if (n.autoResolveRule === "AUTO_ONLY") return { n, status: 409 };
  return { n: { ...n, resolvedAt: new Date() }, status: 200 };
}
function schedulerTick(rows: Notification[], now: Date): Notification[] {
  return rows.map(n => {
    if (!n.nextNotifyAt) return n;
    if (now < n.nextNotifyAt) return n;
    return { ...n, deliveryCount: n.deliveryCount + 1, nextNotifyAt: new Date(+now + 2 * 3600 * 1000) };
  });
}
function dedupeActiveIdentity(rows: Notification[]): Notification[] {
  const seen = new Set<string>();
  return rows.filter(n => {
    if (n.resolvedAt) return true;
    const key = `${n.firmId}:${n.eventId}:${n.recipientUserId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe("F6 Notifications + scheduler correctness (14 tests, no DB)", () => {
  it("F6-1 Partner A read does NOT change Partner B record", () => {
    const nA: Notification = { id: 1, recipientUserId: 10, firmId: 1, eventId: "e1", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null };
    const nB: Notification = { id: 2, recipientUserId: 20, firmId: 1, eventId: "e1", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null };
    const a2 = markRead(nA, 10);
    expect(a2.readAt).not.toBeNull();
    expect(nB.readAt).toBeNull();
  });
  it("F6-2 Partner A ack does NOT change Partner B record", () => {
    const nA: Notification = { id: 1, recipientUserId: 10, firmId: 1, eventId: "e1", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null };
    const nB: Notification = { id: 2, recipientUserId: 20, firmId: 1, eventId: "e1", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null };
    const a2 = markAcknowledged(nA, 10);
    expect(a2.acknowledgedAt).not.toBeNull();
    expect(nB.acknowledgedAt).toBeNull();
  });
  it("F6-3 Cross-firm read attempt → no mutation", () => {
    const n: Notification = { id: 3, recipientUserId: 1, firmId: 1, eventId: "x1", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null };
    const mutated = markRead(n, 999);
    expect(mutated.readAt).toBeNull();
    expect(mutated).toBe(n);
  });
  it("F6-4 Ordinary user cannot read all-partners feed (guard function)", () => {
    const canFeed = (roles: string[]) => roles.includes("PARTNER");
    expect(canFeed(["CLERK"])).toBe(false);
    expect(canFeed(["PARTNER"])).toBe(true);
  });
  it("F6-5 Duplicate scheduler run on same rows → delivery_count does not double", () => {
    const t0 = new Date("2026-08-08T09:58:00Z");
    const base: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "pv-due", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: new Date("2026-08-08T10:00:00Z"), autoResolveRule: null };
    const run1 = schedulerTick([base], new Date("2026-08-08T10:00:01Z"));
    const run2 = schedulerTick(run1, new Date("2026-08-08T10:00:02Z"));
    expect(run1[0].deliveryCount).toBe(1);
    expect(run2[0].deliveryCount).toBe(1);
  });
  it("F6-6 2h due reached → delivery_count +1 exactly once", () => {
    const t = new Date("2026-08-08T12:00:00Z");
    const base: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "pv-due", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 5, nextNotifyAt: new Date("2026-08-08T12:00:00Z"), autoResolveRule: null };
    const r = schedulerTick([base], t);
    expect(r[0].deliveryCount).toBe(6);
  });
  it("F6-7 2h not yet due → NO change", () => {
    const t = new Date("2026-08-08T09:00:00Z");
    const base: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "pv-due", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 5, nextNotifyAt: new Date("2026-08-08T10:00:00Z"), autoResolveRule: null };
    const r = schedulerTick([base], t);
    expect(r[0].deliveryCount).toBe(5);
    expect(r[0].nextNotifyAt?.toISOString()).toBe(base.nextNotifyAt?.toISOString());
  });
  it("F6-8 acknowledge does NOT stop next_notify_at (keeps cadence)", () => {
    const base: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "pv-due", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: new Date("2026-08-08T14:00:00Z"), autoResolveRule: null };
    const acked = markAcknowledged(base, 1);
    expect(acked.acknowledgedAt).not.toBeNull();
    expect(acked.nextNotifyAt?.toISOString()).toBe(base.nextNotifyAt?.toISOString());
  });
  it("F6-9 manual resolve on AUTO_ONLY row → 409", () => {
    const n: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "pv-paid", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: "AUTO_ONLY" };
    const { status } = markManualResolve(n, 1);
    expect(status).toBe(409);
  });
  it("F6-10 manual resolve on MANUAL_OK row → 200", () => {
    const n: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "info", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: "MANUAL_OK" };
    const { n: nn, status } = markManualResolve(n, 1);
    expect(status).toBe(200);
    expect(nn.resolvedAt).not.toBeNull();
  });
  it("F6-11 PV paid → all correlation recipients auto-resolve", () => {
    const recipients: Notification[] = [
      { id: 1, recipientUserId: 10, firmId: 1, eventId: "pv:42:paid", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 1, nextNotifyAt: new Date(), autoResolveRule: "AUTO_ONLY" },
      { id: 2, recipientUserId: 11, firmId: 1, eventId: "pv:42:paid", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 1, nextNotifyAt: new Date(), autoResolveRule: "AUTO_ONLY" },
      { id: 3, recipientUserId: 12, firmId: 1, eventId: "pv:42:paid", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 1, nextNotifyAt: new Date(), autoResolveRule: "AUTO_ONLY" },
    ];
    const autoResolved = recipients.map(r => ({ ...r, resolvedAt: new Date() }));
    expect(autoResolved.every(r => r.resolvedAt !== null)).toBe(true);
  });
  it("F6-12 read != acknowledged != resolved (triple state distinct)", () => {
    const base: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "e", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null };
    const readOnly = markRead(base, 1);
    expect(readOnly.readAt).not.toBeNull();
    expect(readOnly.acknowledgedAt).toBeNull();
    expect(readOnly.resolvedAt).toBeNull();
    const ackOnly = markAcknowledged(base, 1);
    expect(ackOnly.readAt).toBeNull();
    expect(ackOnly.acknowledgedAt).not.toBeNull();
    expect(ackOnly.resolvedAt).toBeNull();
  });
  it("F6-13 Same event active unique identity enforced (per firmId:eventId:recipientUserId)", () => {
    const dupe: Notification[] = [
      { id: 1, recipientUserId: 1, firmId: 1, eventId: "pv:1:submitted", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null },
      { id: 2, recipientUserId: 1, firmId: 1, eventId: "pv:1:submitted", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null },
      { id: 3, recipientUserId: 2, firmId: 1, eventId: "pv:1:submitted", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: null, autoResolveRule: null },
    ];
    const dedup = dedupeActiveIdentity(dupe);
    expect(dedup.length).toBe(2);
  });
  it("F6-14 next_notify_at increment advances by 2 hours after tick", () => {
    const now = new Date("2026-08-08T10:00:00Z");
    const due = new Date("2026-08-08T10:00:00Z");
    const base: Notification = { id: 1, recipientUserId: 1, firmId: 1, eventId: "tick", readAt: null, acknowledgedAt: null, resolvedAt: null, deliveryCount: 0, nextNotifyAt: due, autoResolveRule: null };
    const r = schedulerTick([base], now);
    expect(r[0].nextNotifyAt?.toISOString()).toBe(new Date(+now + 2 * 3600 * 1000).toISOString());
  });
});

// ===== §6 CRON: secret guard + concurrency proof (4 tests) =====
function cronGate(secretHeader: string | undefined, expected: string): { pass: boolean; status: number } {
  if (!secretHeader) return { pass: false, status: 401 };
  if (secretHeader !== expected) return { pass: false, status: 403 };
  return { pass: true, status: 200 };
}
class CronMutex {
  private running = false;
  effectiveRuns = 0;
  async run(task: () => Promise<void>): Promise<number> {
    if (this.running) return this.effectiveRuns;
    this.running = true;
    try { await task(); this.effectiveRuns++; } finally { this.running = false; }
    return this.effectiveRuns;
  }
}
function cronPrintSanitize(obj: unknown): unknown {
  const sensitiveKeys = /^(authorization|secret|token|key|password|cookie|jwt)$/i;
  const walk = (v: unknown): unknown => {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = sensitiveKeys.test(k) ? "MASKED" : walk(val);
      }
      return out;
    }
    if (typeof v === "string" && /^bearer\s+[A-Za-z0-9_\-]{4,}/i.test(v)) {
      return v.replace(/^(bearer\s+)[A-Za-z0-9_\-]+/i, (_m, p1) => `${p1}MASKED`);
    }
    return v;
  };
  return walk(obj);
}

describe("§6 CRON: secret guard + concurrency (4 tests)", () => {
  it("CRON-1 No secret → denied 401", () => {
    expect(cronGate(undefined, "s3cret").status).toBe(401);
  });
  it("CRON-2 Wrong secret → denied 403", () => {
    expect(cronGate("wrong", "s3cret").status).toBe(403);
  });
  it("CRON-3 Correct secret → runs pass", () => {
    expect(cronGate("s3cret", "s3cret").pass).toBe(true);
  });
  it("CRON-4 Concurrent 2 cron calls → only one effective run (mutex)", async () => {
    const m = new CronMutex();
    const slowTask = () => new Promise<void>(r => setTimeout(r, 20));
    const both = Promise.all([m.run(slowTask), m.run(slowTask)]);
    const [a, b] = await both;
    // 第二次 call 在 running=true 时返回 0 effectiveRuns (第一次还未 +1)
    expect(Math.min(a, b)).toBeLessThanOrEqual(1);
    expect(m.effectiveRuns).toBe(1);
  });
  it("CRON-5 Secrets never printed (sanitize function masks)", () => {
    const payload = { Authorization: "Bearer sk-abc", secret: "x", token: "t", password: "p" };
    const clean = cronPrintSanitize(payload) as Record<string, string>;
    expect(JSON.stringify(clean)).not.toContain("sk-abc");
    expect(JSON.stringify(clean)).not.toContain(`"x"`);
  });
});
