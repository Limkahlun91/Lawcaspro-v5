import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  setFounderContextMock,
  makeRlsDbMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  setFounderContextMock: vi.fn(),
  makeRlsDbMock: vi.fn((client: unknown) => client),
}));

vi.mock("@workspace/db", () => ({
  pool: { connect: connectMock },
  setFounderContext: setFounderContextMock,
  makeRlsDb: makeRlsDbMock,
}));

import { withAuthSafeDb } from "../lib/auth-safe-db";

function makeClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

describe("withAuthSafeDb", () => {
  beforeEach(() => {
    connectMock.mockReset();
    setFounderContextMock.mockReset();
    makeRlsDbMock.mockClear();
  });

  it("retries once and destroys the broken client on transient connection errors", async () => {
    const firstClient = makeClient();
    const secondClient = makeClient();

    connectMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockResolvedValueOnce("ok");

    const result = await withAuthSafeDb(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(setFounderContextMock).toHaveBeenCalledTimes(2);

    expect(firstClient.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(firstClient.query).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(firstClient.release).toHaveBeenCalledWith(true);

    expect(secondClient.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(secondClient.query).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(secondClient.release).toHaveBeenCalledWith(false);
  });

  it("does not retry non-transient errors", async () => {
    const client = makeClient();
    connectMock.mockResolvedValue(client);

    const err = new Error("permission denied for relation users");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withAuthSafeDb(fn)).rejects.toThrow(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(false);
  });
});
