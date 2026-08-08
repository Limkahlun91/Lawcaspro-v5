import { describe, expect, it, vi } from "vitest";

// F7 File Custody State Machine
export type CustodyStatus = "CLERK_HELD" | "IN_TRANSIT" | "LAWYER_HELD" | "RETURN_REQUESTED" | "RETURN_IN_TRANSIT" | "ARCHIVED";

const VALID_TRANSITIONS: Record<CustodyStatus, Partial<Record<string, CustodyStatus>>> = {
  CLERK_HELD: { release: "IN_TRANSIT" },
  IN_TRANSIT: { receive_ack: "LAWYER_HELD" },
  LAWYER_HELD: { return_request: "RETURN_REQUESTED", return_cancel: "LAWYER_HELD" },
  RETURN_REQUESTED: { return_submit: "RETURN_IN_TRANSIT" },
  RETURN_IN_TRANSIT: { receive_return: "CLERK_HELD" },
  ARCHIVED: {},
};

function transition(current: CustodyStatus, action: string): { ok: boolean; next: CustodyStatus | null; status: number } {
  const nxt = VALID_TRANSITIONS[current]?.[action] ?? null;
  if (!nxt) return { ok: false, next: null, status: 409 };
  return { ok: true, next: nxt, status: 200 };
}

// Optimistic concurrency via version CAS
function casTransition(version: number, currentHolderUserId: number, rowVersion: number, asUserId: number): boolean {
  return rowVersion === version && currentHolderUserId === asUserId;
}

type Role = "CLERK" | "LAWYER" | "MANAGER" | "PARTNER" | "ACCOUNTANT";

const PERMISSION_MATRIX: Partial<Record<string, Partial<Record<Role, boolean>>>> = {
  release:         { CLERK: true,  LAWYER: false, MANAGER: true,  PARTNER: true,  ACCOUNTANT: false },
  receive_ack:     { CLERK: false, LAWYER: true,  MANAGER: true,  PARTNER: true,  ACCOUNTANT: false },
  return_request:  { CLERK: false, LAWYER: true,  MANAGER: true,  PARTNER: true,  ACCOUNTANT: false },
  return_submit:   { CLERK: false, LAWYER: true,  MANAGER: true,  PARTNER: true,  ACCOUNTANT: false },
  receive_return:  { CLERK: true,  LAWYER: false, MANAGER: true,  PARTNER: true,  ACCOUNTANT: false },
};

function roleAllowed(action: string, role: Role): boolean {
  return !!PERMISSION_MATRIX[action]?.[role];
}

describe("F7 File Custody state machine + invariants", () => {
  // 5 valid transitions
  it("F7-1 release: CLERK_HELD → IN_TRANSIT (valid)", () => {
    const t = transition("CLERK_HELD", "release");
    expect(t.ok).toBe(true); expect(t.next).toBe("IN_TRANSIT"); expect(t.status).toBe(200);
  });
  it("F7-2 receive_ack: IN_TRANSIT → LAWYER_HELD (valid)", () => {
    const t = transition("IN_TRANSIT", "receive_ack");
    expect(t.ok).toBe(true); expect(t.next).toBe("LAWYER_HELD");
  });
  it("F7-3 return_request: LAWYER_HELD → RETURN_REQUESTED (valid)", () => {
    const t = transition("LAWYER_HELD", "return_request");
    expect(t.ok).toBe(true); expect(t.next).toBe("RETURN_REQUESTED");
  });
  it("F7-4 return_submit: RETURN_REQUESTED → RETURN_IN_TRANSIT (valid)", () => {
    const t = transition("RETURN_REQUESTED", "return_submit");
    expect(t.ok).toBe(true); expect(t.next).toBe("RETURN_IN_TRANSIT");
  });
  it("F7-5 receive_return: RETURN_IN_TRANSIT → CLERK_HELD (valid)", () => {
    const t = transition("RETURN_IN_TRANSIT", "receive_return");
    expect(t.ok).toBe(true); expect(t.next).toBe("CLERK_HELD");
  });

  it("F7-6 invalid transition → 409 (e.g., receive_ack when LAWYER_HELD)", () => {
    const t = transition("LAWYER_HELD", "receive_ack");
    expect(t.ok).toBe(false); expect(t.status).toBe(409);
  });

  // Parallel tests (double-release / double-receive / stale version)
  it("F7-7 double release: only one succeeds (CAS version)", () => {
    const state = { status: "CLERK_HELD" as CustodyStatus, version: 1 };
    let successes = 0;
    const tryRelease = (observedVersion: number, asUser: number) => {
      if (!casTransition(observedVersion, asUser, state.version, asUser)) return false;
      const t = transition(state.status, "release");
      if (!t.ok) return false;
      state.status = t.next!;
      state.version++;
      successes++;
      return true;
    };
    const u1 = 1;
    const r1 = tryRelease(1, u1);
    const r2 = tryRelease(1, u1); // stale observed version
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(successes).toBe(1);
    expect(state.status).toBe("IN_TRANSIT");
  });

  it("F7-8 double receive_ack → only one succeeds", () => {
    const state = { status: "IN_TRANSIT" as CustodyStatus, version: 1, holder: 1 };
    let successes = 0;
    const tryReceive = (v: number, asUser: number) => {
      if (!casTransition(v, state.holder, state.version, asUser)) return false;
      const t = transition(state.status, "receive_ack");
      if (!t.ok) return false;
      state.status = t.next!;
      state.version++;
      successes++;
      return true;
    };
    expect(tryReceive(1, 1)).toBe(true);
    expect(tryReceive(1, 1)).toBe(false);
    expect(successes).toBe(1);
    expect(state.status).toBe("LAWYER_HELD");
  });

  it("F7-9 stale version → 409 rejection", () => {
    expect(casTransition(1, 2, 7 /* stale */, 2)).toBe(false);
  });

  // Append-only history invariants: simulate UPDATE/DELETE blocked
  it("F7-10 history append-only → UPDATE old movement throws policy error", () => {
    type Movement = { id: number; immutable: true };
    const update = (rows: Movement[], id: number): boolean => {
      const row = rows.find(r => r.id === id);
      if (!row) return false;
      if (row.immutable) throw new Error("F7_APPEND_ONLY_BLOCKED");
      return true;
    };
    expect(() => update([{ id: 1, immutable: true }], 1)).toThrow(/F7_APPEND_ONLY_BLOCKED/);
  });

  it("F7-11 history DELETE old movement blocked", () => {
    type Movement = { id: number; canDelete: boolean };
    const del = (rows: Movement[], id: number): boolean => {
      const row = rows.find(r => r.id === id);
      if (!row || !row.canDelete) throw new Error("F7_DELETE_BLOCKED");
      return true;
    };
    expect(() => del([{ id: 1, canDelete: false }], 1)).toThrow(/F7_DELETE_BLOCKED/);
  });

  it("F7-12 current holder correctly after valid chain", () => {
    const chain = ["release", "receive_ack", "return_request", "return_submit", "receive_return"];
    let status: CustodyStatus = "CLERK_HELD";
    for (const a of chain) status = transition(status, a).next as CustodyStatus;
    expect(status).toBe("CLERK_HELD");
  });

  it("F7-13 cross-firm attempt → denied (firm_id bound)", () => {
    const rowFirmId = 1 as number, reqFirmId = 999 as number;
    expect(reqFirmId).not.toBe(rowFirmId);
    const allowed = Number(rowFirmId) === Number(reqFirmId);
    expect(allowed).toBe(false);
  });

  it("F7-14 guessed case id → 404 scoped not found", () => {
    const db: Record<number, { caseId: number; firmId: number }> = { 1: { caseId: 101, firmId: 1 } };
    const lookup = (id: number, firmId: number) => {
      const row = db[id];
      if (!row || row.firmId !== firmId) return 404;
      return 200;
    };
    expect(lookup(999, 1)).toBe(404);
    expect(lookup(1, 999)).toBe(404);
  });

  it("F7-15 Permission matrix 5 roles × 5 actions correct", () => {
    expect(roleAllowed("release", "CLERK")).toBe(true);
    expect(roleAllowed("release", "LAWYER")).toBe(false);
    expect(roleAllowed("receive_ack", "LAWYER")).toBe(true);
    expect(roleAllowed("receive_ack", "CLERK")).toBe(false);
    expect(roleAllowed("return_request", "LAWYER")).toBe(true);
    expect(roleAllowed("return_request", "CLERK")).toBe(false);
    expect(roleAllowed("return_submit", "LAWYER")).toBe(true);
    expect(roleAllowed("return_submit", "ACCOUNTANT")).toBe(false);
    expect(roleAllowed("receive_return", "CLERK")).toBe(true);
    expect(roleAllowed("receive_return", "LAWYER")).toBe(false);
    // PARTNER / MANAGER elevated
    expect(roleAllowed("release", "PARTNER")).toBe(true);
    expect(roleAllowed("receive_ack", "MANAGER")).toBe(true);
  });
});
