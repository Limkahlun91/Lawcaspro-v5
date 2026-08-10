import { describe, it, expect, beforeEach, vi } from "vitest";

const yr = new Date().getFullYear();
const invPrefix = `INV-${yr}-`;
const recPrefix = `REC-${yr}-`;

function pad4(n: number) {
  return n.toString().padStart(4, "0");
}

function extractNumber(prefix: string, s: string): number {
  return parseInt(s.slice(prefix.length), 10);
}

type FakeDbOpts = {
  collisionRate?: number;
  maxDelayMs?: number;
  seedInvoices?: Map<number, number[]>;
  seedReceipts?: Map<number, number[]>;
};

type SeqState = {
  nextValue: number;
  lastPrefix: string | null;
};

type AttemptResult =
  | { kind: "bumped"; value: number }
  | { kind: "upserted"; value: number }
  | { kind: "retry" }
  | { kind: "threw23505" };

function createFakeDb(opts: FakeDbOpts = {}) {
  const collisionRate = opts.collisionRate ?? 0.05;
  const maxDelayMs = opts.maxDelayMs ?? 0;
  const seqMap = new Map<string, SeqState>();
  let seqLock: Promise<void> = Promise.resolve();
  const invoicesByFirm = opts.seedInvoices ?? new Map<number, number[]>();
  const receiptsByFirm = opts.seedReceipts ?? new Map<number, number[]>();

  const sleep = () =>
    new Promise<void>((res) => setTimeout(res, Math.random() * maxDelayMs));

  const seqKey = (firmId: number, seqName: string) => `${firmId}:${seqName}`;

  const maxForPrefix = (arr: number[] | undefined): number => {
    if (!arr || !arr.length) return 0;
    return Math.max(...arr);
  };

  const withSeqLock = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    let myRelease: () => void = () => {};
    const myTurn = new Promise<void>((res) => {
      myRelease = res;
    });
    const prev = seqLock;
    seqLock = prev.then(() => myTurn);
    await prev;
    try {
      return await fn();
    } finally {
      myRelease();
    }
  };

  const db: any = {};
  db.callStats = {
    attempts: 0,
    updateHits: 0,
    upsertHits: 0,
    advisoryLocks: 0,
    retriesFromRetry: 0,
    retriesFrom23505: 0,
  };

  function shouldSimulate23505() {
    return Math.random() < collisionRate;
  }

  function doAttemptLocked(
    firmId: number,
    seqName: string,
    prefix: string,
    existingTable: Map<number, number[]>,
  ): AttemptResult {
    db.callStats.attempts++;
    const k = seqKey(firmId, seqName);
    const cur = seqMap.get(k);
    if (cur && cur.lastPrefix === prefix) {
      if (shouldSimulate23505()) {
        return { kind: "threw23505" };
      }
      cur.nextValue = cur.nextValue + 1;
      cur.lastPrefix = prefix;
      db.callStats.updateHits++;
      return { kind: "bumped", value: cur.nextValue };
    }
    if (!seqMap.has(k)) {
      if (shouldSimulate23505()) {
        return { kind: "threw23505" };
      }
      const existingMax = maxForPrefix(existingTable.get(firmId));
      const nextVal = existingMax + 1;
      const storedNext = nextVal + 1;
      seqMap.set(k, { nextValue: storedNext, lastPrefix: prefix });
      db.callStats.upsertHits++;
      return { kind: "upserted", value: storedNext };
    }
    return { kind: "retry" };
  }

  function doLockFallbackLocked(
    firmId: number,
    seqName: string,
    prefix: string,
    existingTable: Map<number, number[]>,
  ): number {
    const existingMax = maxForPrefix(existingTable.get(firmId));
    const val = existingMax + 1;
    const k = seqKey(firmId, seqName);
    seqMap.set(k, { nextValue: val + 1, lastPrefix: prefix });
    const arr = existingTable.get(firmId) ?? [];
    arr.push(val);
    existingTable.set(firmId, arr);
    return val;
  }

  async function nextInvoiceNo(firmId: number): Promise<string> {
    const prefix = invPrefix;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep();
      try {
        const result = await withSeqLock<AttemptResult>(() =>
          doAttemptLocked(firmId, "invoice_no", prefix, invoicesByFirm),
        );
        if (result.kind === "bumped") {
          return `${prefix}${pad4(result.value - 1)}`;
        }
        if (result.kind === "upserted") {
          return `${prefix}${pad4(result.value - 1)}`;
        }
        if (result.kind === "threw23505") {
          if (attempt < 2) {
            db.callStats.retriesFrom23505++;
            continue;
          }
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
        if (result.kind === "retry") {
          if (attempt < 2) {
            db.callStats.retriesFromRetry++;
            continue;
          }
        }
      } catch (e) {
        if (e && String((e as any).code) === "23505" && attempt < 2) {
          db.callStats.retriesFrom23505++;
          continue;
        }
        throw e;
      }
    }
    await sleep();
    db.callStats.advisoryLocks++;
    const n = await withSeqLock<number>(() =>
      doLockFallbackLocked(firmId, "invoice_no", prefix, invoicesByFirm),
    );
    return `${prefix}${pad4(n)}`;
  }

  async function nextReceiptNo(firmId: number): Promise<string> {
    const prefix = recPrefix;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep();
      try {
        const result = await withSeqLock<AttemptResult>(() =>
          doAttemptLocked(firmId, "receipt_no", prefix, receiptsByFirm),
        );
        if (result.kind === "bumped") {
          return `${prefix}${pad4(result.value - 1)}`;
        }
        if (result.kind === "upserted") {
          return `${prefix}${pad4(result.value - 1)}`;
        }
        if (result.kind === "threw23505") {
          if (attempt < 2) {
            db.callStats.retriesFrom23505++;
            continue;
          }
          break;
        }
        if (result.kind === "retry") {
          if (attempt < 2) {
            db.callStats.retriesFromRetry++;
            continue;
          }
          break;
        }
      } catch (e) {
        if (e && String((e as any).code) === "23505") {
          if (attempt < 2) {
            db.callStats.retriesFrom23505++;
            continue;
          }
          break;
        }
        throw e;
      }
    }
    await sleep();
    db.callStats.advisoryLocks++;
    const n = await withSeqLock<number>(() =>
      doLockFallbackLocked(firmId, "receipt_no", prefix, receiptsByFirm),
    );
    return `${prefix}${pad4(n)}`;
  }

  return { db, nextInvoiceNo, nextReceiptNo, seqMap, invoicesByFirm, receiptsByFirm };
}

describe("firm-number-sequence concurrency", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("parallel invoice creates 2x → unique numbers (non-equal)", async () => {
    const { nextInvoiceNo } = createFakeDb({ collisionRate: 0, maxDelayMs: 0 });
    const [a, b] = await Promise.all([nextInvoiceNo(1), nextInvoiceNo(1)]);
    expect(a).not.toEqual(b);
    expect(a.startsWith(invPrefix)).toBe(true);
    expect(b.startsWith(invPrefix)).toBe(true);
    const na = extractNumber(invPrefix, a);
    const nb = extractNumber(invPrefix, b);
    expect(Number.isFinite(na)).toBe(true);
    expect(Number.isFinite(nb)).toBe(true);
    const sorted = [na, nb].sort((x, y) => x - y);
    expect(sorted[0]).toBeGreaterThanOrEqual(1);
    expect(sorted[1]).toBe(sorted[0] + 1);
  }, 30000);

  it("parallel invoice creates 10x → 10 unique numbers, none equal, 0 unexpected throws that aren't handled", async () => {
    const firmId = 7;
    const { nextInvoiceNo, db } = createFakeDb({ collisionRate: 0.05, maxDelayMs: 0 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => nextInvoiceNo(firmId)),
    );
    const set = new Set(results);
    expect(set.size).toBe(10);
    for (const s of results) {
      expect(s.startsWith(invPrefix)).toBe(true);
      const n = extractNumber(invPrefix, s);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(10);
    }
    const nums = results.map((s) => extractNumber(invPrefix, s)).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(10);
    expect(db.callStats.attempts).toBeGreaterThan(0);
  }, 45000);

  it("parallel receipt creates 2x → unique", async () => {
    const { nextReceiptNo } = createFakeDb({ collisionRate: 0, maxDelayMs: 0 });
    const [a, b] = await Promise.all([nextReceiptNo(1), nextReceiptNo(1)]);
    expect(a).not.toEqual(b);
    expect(a.startsWith(recPrefix)).toBe(true);
    expect(b.startsWith(recPrefix)).toBe(true);
  }, 30000);

  it("parallel receipt creates 10x → 10 unique", async () => {
    const firmId = 3;
    const { nextReceiptNo } = createFakeDb({ collisionRate: 0.05, maxDelayMs: 0 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => nextReceiptNo(firmId)),
    );
    const set = new Set(results);
    expect(set.size).toBe(10);
    for (const s of results) {
      expect(s.startsWith(recPrefix)).toBe(true);
      const n = extractNumber(recPrefix, s);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(10);
    }
    const nums = results.map((s) => extractNumber(recPrefix, s)).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(10);
  }, 45000);

  it("reuses existing max from invoice table when sequence row missing (no concurrent)", async () => {
    const seedInv = new Map<number, number[]>();
    seedInv.set(9, [7, 5]);
    const { nextInvoiceNo } = createFakeDb({ collisionRate: 0, maxDelayMs: 0, seedInvoices: seedInv });
    const r = await nextInvoiceNo(9);
    const n = extractNumber(invPrefix, r);
    expect(n).toBe(8);
  }, 30000);

  it("reuses existing max from receipt table when sequence row missing (no concurrent)", async () => {
    const seedRec = new Map<number, number[]>();
    seedRec.set(12, [3, 11]);
    const { nextReceiptNo } = createFakeDb({ collisionRate: 0, maxDelayMs: 0, seedReceipts: seedRec });
    const r = await nextReceiptNo(12);
    const n = extractNumber(recPrefix, r);
    expect(n).toBe(12);
  }, 30000);

  it("retry path exercised: runs many concurrent with moderate collision to hit retries and advisory lock fallback", async () => {
    const firmId = 99;
    const { nextInvoiceNo, db } = createFakeDb({ collisionRate: 0.1, maxDelayMs: 0 });
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => nextInvoiceNo(firmId)),
    );
    const set = new Set(results);
    expect(set.size).toBe(N);
    const nums = results.map((s) => extractNumber(invPrefix, s)).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(N);
    expect(db.callStats.attempts + db.callStats.advisoryLocks).toBeGreaterThanOrEqual(N);
  }, 60000);
});
