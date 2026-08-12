import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCaseCanonical,
  CanonicalCaseCreateError,
  type CanonicalCaseCreateContext,
  type CanonicalCaseCreateInput,
} from "../modules/cases/create-case-canonical.service.js";

process.env.NODE_ENV = "test";
process.env.VITEST_SKIP_DB = "1";

import {
  projectsTable,
  developersTable,
  casesTable,
  clientsTable,
  usersTable,
  rolesTable,
  permissionsTable,
  casePurchasersTable,
  caseAssignmentsTable,
  caseKeyDatesTable,
  auditLogsTable,
  caseNotificationsTable,
} from "@workspace/db";

type FakeDbChain = {
  select: (cols?: unknown) => FakeDbChain;
  from: (tbl: unknown) => FakeDbChain;
  where: (...args: unknown[]) => FakeDbChain;
  innerJoin: (...args: unknown[]) => FakeDbChain;
  leftJoin: (...args: unknown[]) => FakeDbChain;
  and: (...args: unknown[]) => FakeDbChain;
  or: (...args: unknown[]) => FakeDbChain;
  limit: (n?: number) => Promise<unknown[]>;
  insert: (tbl: unknown) => FakeDbInsertChain;
  update: (tbl: unknown) => FakeDbUpdateChain;
  transaction: <T>(fn: (db: FakeDbChain) => Promise<T>) => Promise<T>;
  then: <TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: (value: unknown[]) => TResult1 | PromiseLike<TResult1>,
    onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ) => Promise<TResult1 | TResult2>;
};

type FakeDbInsertChain = {
  values: (v: unknown) => FakeDbInsertChain;
  returning: (cols?: unknown) => Promise<unknown[]>;
  then: undefined;
};

type FakeDbUpdateChain = {
  set: (v: unknown) => FakeDbUpdateChain;
  where: (...args: unknown[]) => Promise<unknown>;
};

type TestArtifacts = {
  db: FakeDbChain;
  capturedCaseInserts: unknown[];
  capturedCaseAssignmentsInserts: unknown[];
  capturedCasePurchasersInserts: unknown[];
  capturedClientsInserts: unknown[];
  capturedAuditInserts: unknown[];
  capturedNotificationsInserts: unknown[];
  capturedClientsUpdates: unknown[];
};

function buildFakeDb(responses: {
  projectSelect?: unknown[];
  developerSelect?: unknown[];
  usersSelect?: unknown[];
  rolesSelect?: unknown[];
  permissionsSelect?: unknown[];
  permissionsSelect2?: unknown[];
  usersSelectAssign?: unknown[];
  casesByTrackingToken?: unknown[];
  casesByRef?: unknown[];
  clientsByIc?: unknown[];
  clientsByName?: unknown[];
  clientsByIdSelect?: unknown[];
  clientsInsertReturning?: unknown[];
  casesInsertReturning?: unknown[];
  casePurchasersInsertReturning?: unknown[];
  caseAssignmentsInsertReturning?: unknown[];
  caseKeyDatesInsert?: unknown;
  auditInsert?: unknown;
  notificationsInsert?: unknown;
}): TestArtifacts {
  const artifacts: TestArtifacts = {
    db: null as unknown as FakeDbChain,
    capturedCaseInserts: [],
    capturedCaseAssignmentsInserts: [],
    capturedCasePurchasersInserts: [],
    capturedClientsInserts: [],
    capturedAuditInserts: [],
    capturedNotificationsInserts: [],
    capturedClientsUpdates: [],
  };

  const permissionsSelectCounter = { value: 0 };
  const usedCaseCounter = { value: 0 };
  const usedClientsCounter = { value: 0 };
  const permissionsHasRoleCounter = { value: 0 };

  let currentTable: unknown = null;

  const makeInsert = (tbl: unknown): FakeDbInsertChain => {
    const chain: Partial<FakeDbInsertChain> = {};
    chain.values = (v: unknown) => {
      if (tbl === casesTable) artifacts.capturedCaseInserts.push(v);
      if (tbl === caseAssignmentsTable) artifacts.capturedCaseAssignmentsInserts.push(v);
      if (tbl === casePurchasersTable) artifacts.capturedCasePurchasersInserts.push(v);
      if (tbl === clientsTable) artifacts.capturedClientsInserts.push(v);
      if (tbl === auditLogsTable) artifacts.capturedAuditInserts.push(v);
      if (tbl === caseNotificationsTable) artifacts.capturedNotificationsInserts.push(v);
      return chain as FakeDbInsertChain;
    };
    chain.returning = async (): Promise<unknown[]> => {
      if (tbl === casesTable) {
        return Promise.resolve(responses.casesInsertReturning ?? [{ id: 1001 }]);
      }
      if (tbl === casePurchasersTable) {
        return Promise.resolve(responses.casePurchasersInsertReturning ?? [{ id: 1 }]);
      }
      if (tbl === caseAssignmentsTable) {
        return Promise.resolve(responses.caseAssignmentsInsertReturning ?? [{ id: 1, assignedAt: new Date("2026-01-01T00:00:00.000Z") }]);
      }
      if (tbl === clientsTable) {
        return Promise.resolve(responses.clientsInsertReturning ?? [{ id: 5001 }]);
      }
      return Promise.resolve([{ id: 1 }]);
    };
    return chain as FakeDbInsertChain;
  };

  const makeUpdate = (tbl: unknown): FakeDbUpdateChain => {
    const chain: Partial<FakeDbUpdateChain> = {};
    chain.set = (v: unknown) => {
      if (tbl === clientsTable) artifacts.capturedClientsUpdates.push(v);
      return chain as FakeDbUpdateChain;
    };
    chain.where = async (): Promise<unknown> => undefined;
    return chain as FakeDbUpdateChain;
  };

  const chain: Partial<FakeDbChain> = {};

  const resolve = (): Promise<unknown[]> => {
    const tbl = currentTable;
    if (tbl === projectsTable) return Promise.resolve(responses.projectSelect ?? []);
    if (tbl === developersTable) return Promise.resolve(responses.developerSelect ?? []);
    if (tbl === rolesTable) {
      permissionsHasRoleCounter.value++;
      return Promise.resolve(responses.rolesSelect ?? [{ id: 1, name: "Partner" }]);
    }
    if (tbl === permissionsTable) {
      const firstTime = (permissionsSelectCounter.value === 0);
      permissionsSelectCounter.value++;
      return Promise.resolve(firstTime ? (responses.permissionsSelect ?? [{ allowed: true }]) : (responses.permissionsSelect2 ?? responses.permissionsSelect ?? [{ allowed: true }]));
    }
    if (tbl === usersTable) return Promise.resolve(responses.usersSelectAssign ?? responses.usersSelect ?? []);
    if (tbl === casesTable) {
      usedCaseCounter.value++;
      if (usedCaseCounter.value === 1) return Promise.resolve(responses.casesByTrackingToken ?? []);
      if (usedCaseCounter.value === 2) return Promise.resolve(responses.casesByRef ?? []);
      return Promise.resolve([]);
    }
    if (tbl === clientsTable) {
      usedClientsCounter.value++;
      if (usedClientsCounter.value === 1) return Promise.resolve(responses.clientsByIc ?? []);
      if (usedClientsCounter.value === 2) return Promise.resolve(responses.clientsByName ?? []);
      if (usedClientsCounter.value === 3) return Promise.resolve(responses.clientsByIdSelect ?? []);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };

  chain.select = () => chain as FakeDbChain;

  chain.from = (tbl: unknown) => {
    currentTable = tbl;
    return chain as FakeDbChain;
  };

  chain.where = () => chain as FakeDbChain;
  chain.innerJoin = () => chain as FakeDbChain;
  chain.leftJoin = () => chain as FakeDbChain;
  chain.and = () => chain as FakeDbChain;
  chain.or = () => chain as FakeDbChain;

  chain.limit = async (): Promise<unknown[]> => {
    return resolve();
  };

  chain.then = <TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: (value: unknown[]) => TResult1 | PromiseLike<TResult1>,
    onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ): Promise<TResult1 | TResult2> => {
    return resolve().then(onfulfilled as any, onrejected as any);
  };

  chain.insert = makeInsert;
  chain.update = makeUpdate;
  chain.transaction = async <T>(fn: (db: FakeDbChain) => Promise<T>): Promise<T> => fn(chain as FakeDbChain);

  return {
    ...artifacts,
    db: chain as FakeDbChain,
  };
}

function defaultContext(fakeDb: FakeDbChain, overrides: Partial<CanonicalCaseCreateContext> = {}): CanonicalCaseCreateContext {
  return {
    db: fakeDb,
    firmId: 1,
    actorUserId: 42,
    actorRoleId: 5,
    canAssignAny: false,
    source: "web_create",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    logger: null,
    ...overrides,
  } as CanonicalCaseCreateContext;
}

type AnyInput = CanonicalCaseCreateInput;

function baseDevSalesInput(overrides: Partial<AnyInput> = {}): AnyInput {
  return {
    caseType: "developer_sales",
    projectId: 10,
    developerId: 20,
    purchaseMode: "cash",
    titleType: "master",
    parcelNo: "TEST-PARCEL",
    ...overrides,
  } as AnyInput;
}

describe("createCaseCanonical — characterization unit tests (100% mocked, no DB)", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("NORMAL-1: purchaser structure input accepted inline", async () => {
    const { db, capturedCasePurchasersInserts, capturedClientsInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      clientsInsertReturning: [{ id: 777 }],
      casesInsertReturning: [{ id: 9000, firmId: 1, approvalStatus: "pending_approval", approvedBy: null }],
      casePurchasersInsertReturning: [{ id: 55 }],
      caseAssignmentsInsertReturning: [{ id: 77, assignedAt: null }],
    });

    const ctx = defaultContext(db);
    const input = baseDevSalesInput({
      purchasers: [{ name: " Purchaser Alpha " }],
    });

    const result = await createCaseCanonical(ctx, input);

    expect(result.duplicate).toBe(false);
    expect(result.purchasersCreated).toBe(1);
    expect(capturedClientsInserts.length).toBeGreaterThanOrEqual(1);
    expect(capturedCasePurchasersInserts.length).toBe(1);
  });

  it("NORMAL-2: 1st-party borrower mirrors purchaser names", async () => {
    const { db, capturedCaseInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      clientsByIc: [],
      clientsByName: [],
      clientsInsertReturning: [{ id: 888 }],
      clientsByIdSelect: [
        { id: 888, name: "P1", ic: "ic1", tin: null, phone: null, email: null, address: null },
      ],
      casesInsertReturning: [{ id: 9002, firmId: 1 }],
      casePurchasersInsertReturning: [{ id: 10 }],
      caseAssignmentsInsertReturning: [{ id: 20, assignedAt: null }],
    });

    const ctx = defaultContext(db);
    const input = baseDevSalesInput({
      purchaseMode: "loan",
      loanPartyType: "1st_party",
      purchasers: [{ name: "P1", ic: "ic1" }],
    });

    const result = await createCaseCanonical(ctx, input);

    expect(result.duplicate).toBe(false);
    expect(capturedCaseInserts.length).toBe(1);
    const inserted = capturedCaseInserts[0] as any;
    const borrowers = inserted.borrowers ?? [];
    const borrowerNames = borrowers.map((b: any) => b?.name).filter(Boolean);
    expect(borrowerNames).toContain("P1");
  });

  it("NORMAL-3: 3rd-party borrowers retained as separate", async () => {
    const { db, capturedCaseInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      casesInsertReturning: [{ id: 9003, firmId: 1 }],
      caseAssignmentsInsertReturning: [{ id: 30, assignedAt: null }],
    });

    const ctx = defaultContext(db);
    const input = baseDevSalesInput({
      purchaseMode: "loan",
      loanPartyType: "3rd_party",
      borrowers: [{ name: "BorrowerSeparate", ic: "b1" }],
    });

    const result = await createCaseCanonical(ctx, input);

    expect(result.duplicate).toBe(false);
    expect(capturedCaseInserts.length).toBe(1);
    const inserted = capturedCaseInserts[0] as any;
    const borrowers = inserted.borrowers ?? [];
    const names = borrowers.map((b: any) => b?.name);
    expect(names).toContain("BorrowerSeparate");
  });

  it("NORMAL-4: propertyDetails retained in case insert", async () => {
    const { db, capturedCaseInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      casesInsertReturning: [{ id: 9004, firmId: 1 }],
      caseAssignmentsInsertReturning: [{ id: 40, assignedAt: null }],
    });

    const ctx = defaultContext(db);
    const input = baseDevSalesInput({
      propertyDetails: { foo: "bar", areaSqm: 100 },
    });

    await createCaseCanonical(ctx, input);

    expect(capturedCaseInserts.length).toBe(1);
    const inserted = capturedCaseInserts[0] as any;
    expect(inserted.propertyDetails).toBeDefined();
    expect((inserted.propertyDetails as any).foo).toBe("bar");
  });

  it("NORMAL-5: loanDetails retained (bankRef ABC123)", async () => {
    const { db, capturedCaseInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      casesInsertReturning: [{ id: 9005, firmId: 1 }],
      caseAssignmentsInsertReturning: [{ id: 50, assignedAt: null }],
    });

    const ctx = defaultContext(db);
    const input = baseDevSalesInput({
      purchaseMode: "loan",
      loanDetails: { bankRef: "ABC123" },
    });

    await createCaseCanonical(ctx, input);

    expect(capturedCaseInserts.length).toBe(1);
    const inserted = capturedCaseInserts[0] as any;
    expect(inserted.loanDetails).toBeDefined();
    expect((inserted.loanDetails as any).bankRef).toBe("ABC123");
  });

  it("NORMAL-6: default assignment = self clerk when canAssignAny=false", async () => {
    const { db, capturedCaseAssignmentsInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      casesInsertReturning: [{ id: 9006, firmId: 1 }],
      caseAssignmentsInsertReturning: [{ id: 60, assignedAt: null }],
    });

    const ctx = defaultContext(db, { canAssignAny: false, actorUserId: 42 });
    const input = baseDevSalesInput();

    await createCaseCanonical(ctx, input);

    expect(capturedCaseAssignmentsInserts.length).toBe(1);
    const assignment = capturedCaseAssignmentsInserts[0] as any;
    expect(assignment.roleInCase).toBe("clerk");
    expect(assignment.userId).toBe(42);
  });

  it("NORMAL-6b: explicit assignment=lawyer when canAssignAny=true", async () => {
    const { db, capturedCaseAssignmentsInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 55 }],
      casesInsertReturning: [{ id: 9007, firmId: 1 }],
      caseAssignmentsInsertReturning: [{ id: 61, assignedAt: null }],
    });

    const ctx = defaultContext(db, { canAssignAny: true });
    const input = baseDevSalesInput({
      assignedLawyerId: 55,
    });

    await createCaseCanonical(ctx, input);

    const lawyerAssignments = capturedCaseAssignmentsInserts.filter((a: any) => a?.roleInCase === "lawyer");
    expect(lawyerAssignments.length).toBeGreaterThanOrEqual(1);
    const assignment = lawyerAssignments[0] as any;
    expect(assignment.userId).toBe(55);
  });

  it("NORMAL-7: trackingToken duplicate returns existing case early", async () => {
    const existingCase = { id: 999, firmId: 1, trackingToken: "aaaa-bbbb-cccc-dddd", deletedAt: null };
    const { db, capturedCaseInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      casesByTrackingToken: [existingCase],
    });

    const ctx = defaultContext(db);
    const input = baseDevSalesInput({
      trackingToken: "aaaa-bbbb-cccc-dddd",
    });

    const result = await createCaseCanonical(ctx, input);

    expect(result.duplicate).toBe(true);
    expect(result.case.id).toBe(999);
    expect(capturedCaseInserts.length).toBe(0);
  });

  it("NORMAL-8: normal create defaults approvalStatus=pending_approval and no approvedBy", async () => {
    const { db, capturedCaseInserts } = buildFakeDb({
      projectSelect: [{ id: 10, firmId: 1, developerId: 20, tenure: "freehold", isEncumbered: false }],
      developerSelect: [{ id: 20 }],
      usersSelectAssign: [{ id: 42 }],
      casesInsertReturning: [{ id: 9008, firmId: 1 }],
      caseAssignmentsInsertReturning: [{ id: 80, assignedAt: null }],
    });

    const ctx = defaultContext(db);
    const input = baseDevSalesInput();

    await createCaseCanonical(ctx, input);

    expect(capturedCaseInserts.length).toBe(1);
    const inserted = capturedCaseInserts[0] as any;
    expect(inserted.approvalStatus).toBe("pending_approval");
    expect(inserted.approvedBy).toBeNull();
  });
});
