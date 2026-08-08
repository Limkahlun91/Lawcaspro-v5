import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

// Product policy: authentication is route-level (middleware attached per route),
// NOT global pre-dispatch authentication. Therefore unknown /api routes MUST
// resolve to 404 NOT_FOUND regardless of whether the request carries invalid
// cookies or bearer tokens. We deliberately do not leak "this would have been
// a 401 if the route existed" because it discloses route existence to
// unauthenticated probes.

describe("API not found handler", () => {
  it("returns JSON 404 for unknown unauthenticated /api routes", async () => {
    const res = await request(app).get("/api/__does_not_exist__");
    expect(res.status).toBe(404);
    expect(String(res.headers["content-type"] ?? "")).toContain("application/json");
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("NOT_FOUND");
  });

  it("still returns JSON 404 for unknown /api routes even when invalid auth credentials are provided (route-level auth only; no global existence disclosure)", async () => {
    // Unknown routes do not enter route-specific authentication middleware.
    // Any garbage token or expired cookie MUST NOT convert a 404 into a 401,
    // otherwise an attacker can enumerate existing routes via status codes.
    const res = await request(app)
      .get("/api/__does_not_exist__")
      .set("Cookie", "auth_token=invalid-token")
      .set("Authorization", "Bearer invalid-token-2");
    expect(res.status).toBe(404);
    expect(String(res.headers["content-type"] ?? "")).toContain("application/json");
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("NOT_FOUND");
  });
});

