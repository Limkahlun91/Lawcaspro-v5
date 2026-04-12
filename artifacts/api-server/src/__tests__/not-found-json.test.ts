import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("API not found handler", () => {
  it("returns JSON 404 for unknown /api routes", async () => {
    const res = await request(app).get("/api/__does_not_exist__");
    expect(res.status).toBe(404);
    expect(String(res.headers["content-type"] ?? "")).toContain("application/json");
    expect(res.body.error).toBe("Not Found");
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

