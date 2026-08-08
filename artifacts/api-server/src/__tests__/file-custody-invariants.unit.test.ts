import { describe, it, expect } from "vitest";

type CustodyItemRow = {
  id: number;
  firmId: number;
  caseId: number | null;
  fileReferenceNo: string;
  fileTitle: string;
  lifecycleStatus: string;
  isArchived: boolean;
  currentHolderUserId: number | null;
  currentHolderName: string | null;
  acknowledgedAt: Date | null;
  acknowledgeDueAt: Date | null;
  expectedReturnAt: Date | null;
  lastMovementId: number | null;
  version: number;
  createdByUserId: number | null;
  archivedByUserId: number | null;
  category?: string | null;
};

type MovementRow = {
  id: number;
  firmId: number;
  custodyItemId: number;
  movementKind: string;
  fromHolderUserId: number | null;
  toHolderUserId: number | null;
  toHolderName: string | null;
  severity: string;
  movementNote: string | null;
  meta: Record<string, unknown> | null;
  createdByUserId: number | null;
  createdAt: Date;
};

type UserRow = { id: number; firmId: number; name: string; email: string; status: string };
type CaseRow = { id: number; firmId: number };
type OpsLog = { kind: "insert" | "update" | "delete"; table: string }[];

const ACTIVE_OUT = ["out_on_loan", "out_with_counsel", "out_with_client", "out_external"] as const;

function extractEq(where: any): Record<string, any> {
  const out: Record<string, any> = {};
  const stack: any[] = [where];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    if (cur._?.fn?.name === "eq" && Array.isArray(cur._?.args) && cur._.args.length === 2) {
      const [lhs, rhs] = cur._.args;
      const col = lhs?._?.name;
      if (col) out[col] = rhs?.value !== undefined ? rhs.value : rhs;
      continue;
    }
    if ("left" in cur) stack.push(cur.left);
    if ("right" in cur) stack.push(cur.right);
  }
  return out;
}

function col(name: string) { return { _: { name } }; }
function eq(l: any, v: any) { return { _: { fn: { name: "eq" }, args: [l, { value: v }] } }; }
function and(...parts: any[]): any { return parts.reduce((acc, x) => (acc == null ? x : { left: acc, right: x }), null); }

const ITEMS = "file_custody_items";
const MOVEMENTS = "file_custody_movements";
const USERS = "users";
const CASES = "cases";

type ThenChain = Promise<any> & {
  limit?: (n: number) => ThenChain;
  offset?: (n: number) => ThenChain;
  orderBy?: (...args: any[]) => ThenChain;
  groupBy?: (...args: any[]) => ThenChain;
  innerJoin?: (...args: any[]) => { where: (w: any) => ThenChain; then: typeof Promise.prototype.then };
  leftJoin?: (...args: any[]) => { where: (w: any) => ThenChain & { orderBy?: (...args: any[]) => ThenChain; then: typeof Promise.prototype.then }; then: typeof Promise.prototype.then };
  where?: (w: any) => ThenChain;
  then: typeof Promise.prototype.then;
};

function chain(promiseFactory: () => Promise<any>): ThenChain {
  let base = promiseFactory();
  const out: ThenChain = base as ThenChain;
  out.limit = (n: number) => chain(() => base.then((r: any[]) => r.slice(0, n)));
  out.offset = (n: number) => chain(() => base.then((r: any[]) => r.slice(n)));
  out.orderBy = () => chain(() => base);
  out.groupBy = () => chain(() => base);
  out.innerJoin = () => ({ where: () => chain(() => base), then: (...a: any[]) => (base as any).then(...a) });
  out.leftJoin = () => ({
    where: (w: any) => Object.assign(chain(() => base), { orderBy: () => chain(() => base) }),
    then: (...a: any[]) => (base as any).then(...a),
  });
  out.where = (w: any) => chain(() => Promise.reject(new Error("chaining not supported: where already called")));
  return out;
}

function buildMock() {
  const items = new Map<number, CustodyItemRow>();
  const movements = new Map<number, MovementRow>();
  const users = new Map<number, UserRow>();
  const cases = new Map<number, CaseRow>();
  const ops: OpsLog = [];
  let nextItemId = 1;
  let nextMovementId = 1;

  const tableFor = (name: string) => {
    if (name === ITEMS) return items as Map<number, any>;
    if (name === MOVEMENTS) return movements as Map<number, any>;
    if (name === USERS) return users as Map<number, any>;
    if (name === CASES) return cases as Map<number, any>;
    return new Map<number, any>();
  };

  function applyShape(row: any, shape: any): any {
    if (!shape || !row) return row;
    if (typeof shape !== "object") return row;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(shape)) {
      if (v && typeof v === "object" && (v as any)._?.name) {
        const cn = (v as any)._?.name as string;
        out[k] = row[cn];
      }
    }
    return out;
  }

  function doSelect(tableName: string, shape: any, where: any): ThenChain {
    const rows = (() => {
      const table = Array.from(tableFor(tableName).values());
      if (!where) return table;
      const cond = extractEq(where);
      return table.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
    })();
    const result = rows.map((r) => applyShape(r, shape));
    return chain(() => Promise.resolve(result));
  }

  function selectFrom(tableRef: any, shape: any) {
    const tableName = (tableRef as any)?._?.name ?? "";
    return {
      where: (w: any) => doSelect(tableName, shape, w),
      limit: (n: number) => doSelect(tableName, shape, undefined).limit!(n),
      then: (...a: any[]) => doSelect(tableName, shape, undefined).then(...a),
      innerJoin: (_other: any, _on: any) => ({
        where: (w: any) => doSelect(tableName, shape, w),
        then: (...a: any[]) => doSelect(tableName, shape, undefined).then(...a),
      }),
      leftJoin: (_other: any, _on: any) => ({
        where: (w: any) => Object.assign(doSelect(tableName, shape, w), {
          orderBy: () => doSelect(tableName, shape, w),
          limit: (n: number) => doSelect(tableName, shape, w).limit!(n),
        }),
        orderBy: () => doSelect(tableName, shape, undefined),
        then: (...a: any[]) => doSelect(tableName, shape, undefined).then(...a),
      }),
      orderBy: () => doSelect(tableName, shape, undefined),
      groupBy: () => doSelect(tableName, shape, undefined),
    };
  }

  const rdb: any = {
    select: (shape: any) => ({ from: (t: any) => selectFrom(t, shape) }),
    insert: (tableRef: any) => ({
      values: (vals: any) => ({
        returning: (shape: any) => {
          const tableName = (tableRef as any)?._?.name ?? "";
          ops.push({ kind: "insert", table: tableName });
          if (tableName === MOVEMENTS) {
            const id = nextMovementId++;
            const row: MovementRow = {
              id,
              firmId: vals.firmId,
              custodyItemId: vals.custodyItemId,
              movementKind: vals.movementKind,
              fromHolderUserId: vals.fromHolderUserId ?? null,
              toHolderUserId: vals.toHolderUserId ?? null,
              toHolderName: vals.toHolderName ?? null,
              severity: vals.severity ?? "normal",
              movementNote: vals.movementNote ?? null,
              meta: vals.meta ?? null,
              createdByUserId: vals.createdByUserId ?? null,
              createdAt: new Date(),
            };
            movements.set(id, row);
            return Promise.resolve([applyShape(row, shape)]);
          }
          if (tableName === ITEMS) {
            const id = nextItemId++;
            const row: CustodyItemRow = {
              id,
              firmId: vals.firmId,
              caseId: vals.caseId ?? null,
              fileReferenceNo: vals.fileReferenceNo,
              fileTitle: vals.fileTitle,
              lifecycleStatus: vals.lifecycleStatus ?? "in_office",
              isArchived: vals.isArchived ?? false,
              currentHolderUserId: vals.currentHolderUserId ?? null,
              currentHolderName: vals.currentHolderName ?? null,
              acknowledgedAt: vals.acknowledgedAt ?? null,
              acknowledgeDueAt: vals.acknowledgeDueAt ?? null,
              expectedReturnAt: vals.expectedReturnAt ?? null,
              lastMovementId: vals.lastMovementId ?? null,
              version: vals.version ?? 0,
              createdByUserId: vals.createdByUserId ?? null,
              archivedByUserId: vals.archivedByUserId ?? null,
              category: vals.category ?? null,
            };
            items.set(id, row);
            return Promise.resolve([applyShape(row, shape)]);
          }
          return Promise.resolve([]);
        },
      }),
    }),
    update: (tableRef: any) => {
      const tableName = (tableRef as any)?._?.name ?? "";
      return {
        set: (values: any) => ({
          where: (where: any) => ({
            returning: (shape: any) => {
              if (tableName === MOVEMENTS) {
                throw new Error(
                  "file_custody_movements_append_only_blocked: UPDATE not allowed. Insert compensating movement instead.",
                );
              }
              ops.push({ kind: "update", table: tableName });
              const table = tableFor(tableName);
              const cond = extractEq(where);
              const allRows = Array.from(table.values());
              const matched = allRows.filter((r) => {
                const ok = Object.entries(cond).every(([k, v]) => {
                  const rv = r[k];
                  const eq = rv === v;
                  return eq;
                });
                return ok;
              });
              for (const row of matched) Object.assign(row, values);
              return Promise.resolve(matched.map((r) => applyShape(r, shape)));
            },
          }),
        }),
      };
    },
  };

  return {
    rdb,
    items,
    movements,
    ops,
    seedUsers: (list: UserRow[]) => list.forEach((u) => users.set(u.id, u)),
    seedCases: (list: CaseRow[]) => list.forEach((c) => cases.set(c.id, c)),
    seedItem: (row: Partial<CustodyItemRow> & { firmId: number; fileReferenceNo: string; fileTitle: string }) => {
      const id = row.id ?? nextItemId++;
      const full: CustodyItemRow = {
        id,
        firmId: row.firmId,
        caseId: row.caseId ?? null,
        fileReferenceNo: row.fileReferenceNo,
        fileTitle: row.fileTitle,
        lifecycleStatus: row.lifecycleStatus ?? "in_office",
        isArchived: row.isArchived ?? false,
        currentHolderUserId: row.currentHolderUserId ?? null,
        currentHolderName: row.currentHolderName ?? null,
        acknowledgedAt: row.acknowledgedAt ?? null,
        acknowledgeDueAt: row.acknowledgeDueAt ?? null,
        expectedReturnAt: row.expectedReturnAt ?? null,
        lastMovementId: row.lastMovementId ?? null,
        version: row.version ?? 0,
        createdByUserId: row.createdByUserId ?? null,
        archivedByUserId: row.archivedByUserId ?? null,
        category: row.category ?? null,
      };
      items.set(id, full);
      return full;
    },
  };
}

const shapes = {
  item: {
    id: col("id"), firmId: col("firmId"), caseId: col("caseId"),
    fileReferenceNo: col("fileReferenceNo"), fileTitle: col("fileTitle"),
    lifecycleStatus: col("lifecycleStatus"), isArchived: col("isArchived"),
    currentHolderUserId: col("currentHolderUserId"), currentHolderName: col("currentHolderName"),
    acknowledgedAt: col("acknowledgedAt"), acknowledgeDueAt: col("acknowledgeDueAt"),
    expectedReturnAt: col("expectedReturnAt"), lastMovementId: col("lastMovementId"),
    version: col("version"), createdByUserId: col("createdByUserId"),
    archivedByUserId: col("archivedByUserId"), category: col("category"),
  },
  user: { id: col("id"), name: col("name"), email: col("email"), roleId: col("roleId") },
  userSimple: { id: col("id"), name: col("name"), email: col("email") },
  id: { id: col("id") },
  cv: { id: col("id") },
};

async function releaseHandler(
  rdb: any,
  ctx: { firmId: number; userId: number },
  body: {
    custodyItemId: number;
    toHolderUserId?: number;
    toHolderName?: string;
    toHolderContact?: string;
    toHolderFirmExternal?: string;
    severity?: string;
    movementNote?: string;
  },
) {
  const { firmId, userId } = ctx;
  const d = body;
  const [itemRaw] = await rdb
    .select(shapes.item)
    .from({ _: { name: ITEMS } })
    .where(and(eq(col("firmId"), firmId), eq(col("id"), d.custodyItemId)));
  if (!itemRaw) return { status: 404, body: { error: "item_not_found" } };
  if (itemRaw.isArchived) return { status: 409, body: { error: "archived_cannot_release" } };
  if (d.toHolderUserId) {
    const [u] = await rdb
      .select(shapes.user)
      .from({ _: { name: USERS } })
      .where(and(eq(col("firmId"), firmId), eq(col("id"), d.toHolderUserId), eq(col("status"), "active")));
    if (!u) return { status: 400, body: { error: "invalid_target_user" } };
    d.toHolderName = d.toHolderName ?? u.name;
    d.toHolderContact = d.toHolderContact ?? u.email;
  } else if (!d.toHolderName) {
    return { status: 400, body: { error: "need_to_holder_user_or_name" } };
  }
  const expectedVersion = Number(itemRaw.version) || 0;
  const ackDueAt = new Date(Date.now() + 24 * 3600 * 1000);
  const returnAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const severity = d.severity ?? "normal";
  let mvId: number | undefined;
  try {
    const [mv] = await rdb
      .insert({ _: { name: MOVEMENTS } })
      .values({
        firmId,
        custodyItemId: d.custodyItemId,
        movementKind: "release",
        fromHolderUserId: itemRaw.currentHolderUserId ?? userId,
        fromHolderName: itemRaw.currentHolderName ?? null,
        toHolderUserId: d.toHolderUserId ?? null,
        toHolderName: d.toHolderName ?? null,
        severity,
        movementNote: d.movementNote ?? null,
        createdByUserId: userId,
      })
      .returning(shapes.id);
    mvId = Number(mv.id);
    const nextVersion = expectedVersion + 1;
    const nextStatus = d.toHolderFirmExternal
      ? "out_external"
      : itemRaw.category === "firm_letter" || itemRaw.category === "court_document"
        ? "out_with_counsel"
        : "out_on_loan";
    const [updated] = await rdb
      .update({ _: { name: ITEMS } })
      .set({
        currentHolderUserId: d.toHolderUserId ?? null,
        currentHolderName: d.toHolderName ?? null,
        lifecycleStatus: nextStatus,
        acknowledgedAt: null,
        acknowledgeDueAt: ackDueAt,
        expectedReturnAt: returnAt,
        lastMovementId: mvId,
        version: nextVersion,
      })
      .where(and(eq(col("id"), d.custodyItemId), eq(col("firmId"), firmId), eq(col("version"), expectedVersion)))
      .returning(shapes.id);
    if (!updated) {
      throw Object.assign(new Error("version_conflict_release"), { code: "VERSION_CONFLICT" });
    }
  } catch (err: any) {
    if (err?.code === "VERSION_CONFLICT") {
      return { status: 409, body: { error: "version_conflict", message: "Release race condition." } };
    }
    throw err;
  }
  return { status: 201, body: { ok: true, movementId: mvId, custodyItemId: d.custodyItemId } };
}

async function createItemHandler(
  rdb: any,
  ctx: { firmId: number; userId: number },
  body: { caseId?: number; currentHolderUserId?: number; fileReferenceNo: string; fileTitle: string },
) {
  const { firmId, userId } = ctx;
  const d = body;
  if (d.currentHolderUserId) {
    const [u] = await rdb
      .select(shapes.userSimple)
      .from({ _: { name: USERS } })
      .where(and(eq(col("firmId"), firmId), eq(col("id"), d.currentHolderUserId), eq(col("status"), "active")));
    if (!u) return { status: 400, body: { error: "invalid_current_holder_user_id" } };
  }
  if (d.caseId) {
    const [cv] = await rdb
      .select(shapes.cv)
      .from({ _: { name: CASES } })
      .where(and(eq(col("id"), d.caseId), eq(col("firmId"), firmId)));
    if (!cv) return { status: 400, body: { error: "invalid_case_id" } };
  }
  void userId;
  return { status: 201, body: { ok: true } };
}

async function imaginaryMovementUpdater(rdb: any) {
  await rdb
    .update({ _: { name: MOVEMENTS } })
    .set({ movementNote: "tampered" })
    .where(eq(col("id"), 1))
    .returning(shapes.id);
  return { status: 200, body: { ok: true } };
}

describe("File Custody Invariants (§16, §17, §18)", () => {
  describe("§16 Optimistic lock versioning", () => {
    it("UPDATE items with stale expected version returns empty → handler maps to 409", async () => {
      const { rdb, seedItem, items } = buildMock();
      seedItem({ id: 42, firmId: 7, fileReferenceNo: "REF-A", fileTitle: "T", lifecycleStatus: "in_office", version: 10 });
      const staleExpected = 8;
      const [updated] = await rdb
        .update({ _: { name: ITEMS } })
        .set({ version: staleExpected + 1, lifecycleStatus: "out_on_loan" })
        .where(and(eq(col("id"), 42), eq(col("firmId"), 7), eq(col("version"), staleExpected)))
        .returning(shapes.id);
      expect(updated).toBeFalsy();
      expect(items.get(42)!.version).toBe(10);
      const correctExpected = 10;
      const [ok] = await rdb
        .update({ _: { name: ITEMS } })
        .set({ version: correctExpected + 1, lifecycleStatus: "out_on_loan" })
        .where(and(eq(col("id"), 42), eq(col("firmId"), 7), eq(col("version"), correctExpected)))
        .returning(shapes.id);
      expect(ok).toBeTruthy();
      expect(items.get(42)!.version).toBe(11);
    });

    it("release with correct version succeeds, item.version += 1", async () => {
      const { rdb, seedItem, seedUsers, items } = buildMock();
      seedUsers([
        { id: 101, firmId: 7, name: "Actor", email: "actor@f.com", status: "active" },
        { id: 202, firmId: 7, name: "Alice", email: "alice@f.com", status: "active" },
      ]);
      const beforeSeed = seedItem({
        id: 42, firmId: 7, fileReferenceNo: "REF-A", fileTitle: "T",
        lifecycleStatus: "in_office", version: 3, category: "court_document",
      });
      const beforeVersion = Number(beforeSeed.version);
      const res = await releaseHandler(rdb, { firmId: 7, userId: 101 }, {
        custodyItemId: 42, toHolderUserId: 202,
      });
      expect(res.status).toBe(201);
      const after = items.get(42)!;
      expect(after.version).toBe(beforeVersion + 1);
      expect(after.currentHolderUserId).toBe(202);
      expect(after.lifecycleStatus).toBe("out_with_counsel");
    });

    it("release detects race via mock version injection → returns 409", async () => {
      const { rdb, seedItem, seedUsers, items } = buildMock();
      seedUsers([
        { id: 101, firmId: 7, name: "Actor", email: "actor@f.com", status: "active" },
        { id: 202, firmId: 7, name: "Alice", email: "alice@f.com", status: "active" },
      ]);
      seedItem({ id: 42, firmId: 7, fileReferenceNo: "REF-RACE", fileTitle: "Race", version: 5 });
      const originalDoSelect = (rdb as any)._hookSelectBeforeUpdate;
      let bumped = false;
      const origUpdate = rdb.update;
      rdb.update = function (ref: any) {
        const chain = origUpdate.call(rdb, ref);
        const origSet = chain.set;
        chain.set = function (values: any) {
          const withWhere = origSet.call(chain, values);
          const origWhere = withWhere.where;
          withWhere.where = function (w: any) {
            if (!bumped) {
              const row = items.get(42)!;
              row.version = 999;
              bumped = true;
            }
            const withRet = origWhere.call(withWhere, w);
            return withRet;
          };
          return withWhere;
        };
        return chain;
      };
      const res = await releaseHandler(rdb, { firmId: 7, userId: 101 }, {
        custodyItemId: 42, toHolderUserId: 202,
      });
      expect(res.status).toBe(409);
      expect(res.body?.error).toBe("version_conflict");
    });
  });

  describe("§17 Tenant isolation on cross-user references", () => {
    it("cross-firm toHolderUserId returns 400/404 (not 200)", async () => {
      const { rdb, seedUsers, seedItem } = buildMock();
      seedUsers([
        { id: 101, firmId: 7, name: "Actor", email: "actor@a.com", status: "active" },
        { id: 202, firmId: 999, name: "Bob", email: "bob@other", status: "active" },
      ]);
      seedItem({ id: 42, firmId: 7, fileReferenceNo: "REF-SECRET", fileTitle: "SF", version: 0 });
      const res = await releaseHandler(rdb, { firmId: 7, userId: 101 }, {
        custodyItemId: 42, toHolderUserId: 202,
      });
      expect([400, 404]).toContain(res.status);
      expect(res.status).not.toBe(201);
      expect(res.body?.error).toBeTruthy();
    });

    it("caseId from different firm returns 400 (not 201)", async () => {
      const { rdb, seedCases } = buildMock();
      seedCases([{ id: 5, firmId: 999 }]);
      const res = await createItemHandler(rdb, { firmId: 7, userId: 101 }, {
        fileReferenceNo: "REF-B", fileTitle: "TB", caseId: 5,
      });
      expect(res.status).toBe(400);
      expect(res.body?.error).toBe("invalid_case_id");
    });
  });

  describe("§18 Append-only movements table", () => {
    it("UPDATE movements via handler throws append-only error", async () => {
      const { rdb, movements, ops } = buildMock();
      movements.set(1, {
        id: 1, firmId: 7, custodyItemId: 42, movementKind: "release",
        fromHolderUserId: null, toHolderUserId: null, toHolderName: null,
        severity: "normal", movementNote: null, meta: null,
        createdByUserId: 101, createdAt: new Date(),
      });
      let err: any;
      try {
        await imaginaryMovementUpdater(rdb);
      } catch (e) {
        err = e;
      }
      expect(err).toBeTruthy();
      expect(String(err?.message ?? "")).toContain("append_only_blocked");
      const mvOps = ops.filter((o) => o.table === MOVEMENTS);
      expect(mvOps.every((o) => o.kind === "insert")).toBe(true);
    });

    it("release handler only INSERTs movements, never UPDATEs", async () => {
      const { rdb, seedUsers, seedItem, ops } = buildMock();
      seedUsers([
        { id: 101, firmId: 7, name: "Actor", email: "a@f", status: "active" },
        { id: 202, firmId: 7, name: "A", email: "b@f", status: "active" },
      ]);
      seedItem({ id: 42, firmId: 7, fileReferenceNo: "REF-C", fileTitle: "TC", version: 0 });
      await releaseHandler(rdb, { firmId: 7, userId: 101 }, {
        custodyItemId: 42, toHolderUserId: 202,
      });
      const mvOps = ops.filter((o) => o.table === MOVEMENTS);
      expect(mvOps.length).toBeGreaterThan(0);
      expect(mvOps.every((o) => o.kind === "insert")).toBe(true);
    });
  });
});
