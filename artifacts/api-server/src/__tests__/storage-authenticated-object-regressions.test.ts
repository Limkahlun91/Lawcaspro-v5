import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectNotFoundError, SupabaseStorageService } from "../lib/objectStorage";

function setFakeSupabaseEnv() {
  process.env.SUPABASE_URL = "https://test-proj-ref.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_TEST_ONLY_FAKE_ABC123";
  process.env.SUPABASE_STORAGE_BUCKET_PRIVATE = "test-private-bucket";
}

function makeFakeResponse(
  status: number,
  opts?: { jsonBody?: unknown; textBody?: string; headers?: Record<string, string>; bodyStream?: any },
) {
  const { jsonBody, textBody = "", headers = {} } = opts ?? {};
  const usedText = jsonBody !== undefined ? JSON.stringify(jsonBody) : textBody;
  const clone = () => makeFakeResponse(status, { textBody: usedText, headers, ...(opts ?? {}) });
  const resp = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers ?? {})),
    text: async () => usedText,
    json: async () => JSON.parse(usedText),
    clone,
    body: opts?.bodyStream ?? {
      cancel: async () => undefined,
      getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }),
    },
  };
  return resp as unknown as Response;
}

describe("Supabase authenticated object storage regressions", () => {
  // Full env snapshot + full restore — no test leaves SUPABASE env / fetch installed
  let fullEnvSnapshot: NodeJS.ProcessEnv;
  let fetchMock: ReturnType<typeof vi.fn>;
  let svc: SupabaseStorageService;

  beforeEach(() => {
    fullEnvSnapshot = { ...process.env };
    setFakeSupabaseEnv();
    fetchMock = vi.fn(async (_url: unknown, _init: RequestInit | undefined) => {
      return makeFakeResponse(200, { jsonBody: { bytes: "fake" } });
    });
    // vi.stubGlobal install — restored by vi.unstubAllGlobals in afterEach
    // (Direct globalThis.fetch assignment is NOT restored by restoreAllMocks.)
    vi.stubGlobal("fetch", fetchMock);
    svc = new SupabaseStorageService();
  });
  afterEach(() => {
    // 1) Unstub globals (removes fetch mock)
    vi.unstubAllGlobals();
    // 2) Restore vitest mocks
    vi.restoreAllMocks();
    // 3) Clear current env + restore full snapshot from beforeEach
    for (const k of Object.keys(process.env)) {
      if (k !== "PATH" && k !== "SYSTEMROOT" && k !== "SystemRoot") {
        delete process.env[k];
      }
    }
    Object.assign(process.env, fullEnvSnapshot);
  });

  function getLastCall() {
    const calls = fetchMock.mock.calls as Array<[any, any]>;
    const [url, init] = calls[calls.length - 1] ?? [undefined, undefined];
    const urlStr = String(url ?? "");
    const method = String(init?.method ?? "GET");
    const headers = init?.headers
      ? Object.fromEntries(
          Object.entries(init.headers as any).map(([k, v]) => [k, String(v)]),
        )
      : undefined;
    return { url: urlStr, method, headers };
  }

  const EXPECTED_PREFIX =
    "https://test-proj-ref.supabase.co/storage/v1/object/authenticated/test-private-bucket";

  it("private GET URL uses /object/authenticated/<bucket>/<encoded-key>", async () => {
    await svc.fetchPrivateObjectResponse("dir/sub with space/a.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = getLastCall().url;
    expect(url.startsWith(EXPECTED_PREFIX)).toBe(true);
    expect(url).toContain("/dir/sub%20with%20space/a.png");
    expect(url).not.toMatch(/\/object\/test-private-bucket/); // should NOT match generic /object/<bucket>
    expect(url).toMatch(/\/object\/authenticated\//);
  });

  it("private GET keeps current secure auth header builder (apikey + Bearer for legacy service_role)", async () => {
    // Legacy service_role keys — NOT new sb_secret_ — get BOTH apikey + Bearer Authorization.
    // Use a LOCAL variable (NOT overwrite of outer env snapshot var) so afterEach can cleanly
    // restore the true beforeEach snapshot.
    const localPrev = { ...process.env };
    try {
      process.env.SUPABASE_URL = "https://legacy-test.supabase.co";
      process.env.SUPABASE_SECRET_KEY = "SERVICE_ROLE_FAKE_LEGACYKEY12345";
      const legacy = new SupabaseStorageService();
      fetchMock.mockClear();
      await legacy.fetchPrivateObjectResponse("dir/x.pdf");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = getLastCall().headers ?? {};
      expect(headers.apikey).toBe("SERVICE_ROLE_FAKE_LEGACYKEY12345");
      expect(String(headers.Authorization ?? "")).toBe("Bearer SERVICE_ROLE_FAKE_LEGACYKEY12345");
    } finally {
      Object.keys(process.env).forEach((k) => {
        if (k !== "PATH" && k !== "SYSTEMROOT" && k !== "SystemRoot") delete process.env[k];
      });
      Object.assign(process.env, localPrev);
    }
  });

  it("private GET HTTP 404 => ObjectNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(404, { jsonBody: { error: "Not Found", statusCode: 404 } }),
    );
    await expect(svc.fetchPrivateObjectResponse("missing.dat")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("private GET code:NoSuchKey (in JSON body) => ObjectNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(500, {
        jsonBody: { code: "NoSuchKey", host: "should-not-leak.invalid", message: "Key missing" },
      }),
    );
    await expect(svc.fetchPrivateObjectResponse("missing.dat")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("private GET statusCode=404 inside wrapped body => ObjectNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(400, {
        jsonBody: { error: "object-not-found", statusCode: 404, message: "does not exist" },
      }),
    );
    await expect(svc.fetchPrivateObjectResponse("gone.dat")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("private GET HTTP status 500 + JSON body { statusCode: 404 } => ObjectNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(500, {
        jsonBody: { statusCode: 404, error: "not found", message: "missing" },
      }),
    );
    await expect(svc.fetchPrivateObjectResponse("hidden.dat")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("private GET string statusCode '404' in JSON body => ObjectNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(502, {
        jsonBody: { statusCode: "404", code: "NotFound", message: "no object" },
      }),
    );
    await expect(svc.fetchPrivateObjectResponse("a/b.dat")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("private GET malformed JSON generic 500 => generic Error, not ObjectNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(500, { textBody: '{ "this is": "not valid JSON",,broken,' }),
    );
    let thrown: unknown = null;
    try {
      await svc.fetchPrivateObjectResponse("broken-body.dat");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ObjectNotFoundError);
    expect(String((thrown as Error)?.message ?? "")).toMatch(
      /Supabase storage download failed \(500\)/,
    );
  });

  it("private GET generic other 5xx => throws generic Error, not ObjectNotFound", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(500, { jsonBody: { error: "Internal server error", code: "INTERNAL" } }),
    );
    let thrown: unknown = null;
    try {
      await svc.fetchPrivateObjectResponse("broken.dat");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ObjectNotFoundError);
  });

  it("privateObjectExists does NOT perform HEAD, reuses authenticated GET", async () => {
    fetchMock.mockResolvedValueOnce(makeFakeResponse(200, { textBody: "fake-bytes" }));
    const result = await svc.privateObjectExists("hello/world.pdf");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = getLastCall();
    expect(req.method).toBe("GET");
    expect(req.url.startsWith(EXPECTED_PREFIX)).toBe(true);
    expect(result).toBe(true);
  });

  it("privateObjectExists => false on ObjectNotFoundError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(404, { jsonBody: { error: "Not found" } }),
    );
    const exists = await svc.privateObjectExists("nope.pdf");
    expect(exists).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("privateObjectExists rethrows non-missing errors", async () => {
    fetchMock.mockResolvedValueOnce(
      makeFakeResponse(503, { jsonBody: { error: "Down" } }),
    );
    let thrown: unknown = null;
    try {
      await svc.privateObjectExists("any.dat");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ObjectNotFoundError);
  });
});
