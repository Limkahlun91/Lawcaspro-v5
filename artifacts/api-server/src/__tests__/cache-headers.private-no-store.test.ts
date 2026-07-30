import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../routes/index.js", () => {
  const router = express.Router();
  router.get("/cases/workbench", (_req, res) => res.json({ ok: true }));
  router.get("/payment-vouchers", (_req, res) => res.json([]));
  router.get("/accounting/bank-accounts", (_req, res) => res.json([]));
  return { default: router };
});

import app from "../app";
import { mergeVaryHeader } from "../app";

describe("private cache headers", () => {
  it("does not force private caching for /api/health", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(String(res.headers["cache-control"] ?? "")).not.toMatch(/private,\s*no-store/i);
  });

  it("does not force private caching for /api/health even when authenticated", async () => {
    const res = await request(app).get("/api/health").set("Authorization", "Bearer any");
    expect(res.status).toBe(200);
    expect(String(res.headers["cache-control"] ?? "")).not.toMatch(/private,\s*no-store/i);
  });

  it("does not mark unauthenticated /api/* responses as private", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(String(res.headers["cache-control"] ?? "")).not.toMatch(/private,\s*no-store/i);
  });

  it("sets private no-store for /api/* when Authorization header is present", async () => {
    const res = await request(app).get("/api/does-not-exist").set("Authorization", "Bearer any");
    expect(res.status).toBe(404);
    expect(String(res.headers["cache-control"] ?? "")).toMatch(/private,\s*no-store/i);
    expect(String(res.headers["vary"] ?? "")).toMatch(/cookie/i);
    expect(String(res.headers["vary"] ?? "")).toMatch(/authorization/i);
  });

  it("appends Cookie/Authorization to existing Vary without duplicating", () => {
    expect(mergeVaryHeader("Accept-Encoding")).toMatch(/Accept-Encoding/i);
    const merged = mergeVaryHeader("Accept-Encoding, Cookie, Authorization, Cookie");
    const parts = merged
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    expect(parts.filter((p) => p === "cookie").length).toBe(1);
    expect(parts.filter((p) => p === "authorization").length).toBe(1);
    expect(parts.filter((p) => p === "accept-encoding").length).toBe(1);
  });

  it("sets private no-store for authenticated workbench/payment-voucher/accounting endpoints", async () => {
    const workbench = await request(app).get("/api/cases/workbench").set("Authorization", "Bearer any");
    expect(workbench.status).toBe(200);
    expect(String(workbench.headers["cache-control"] ?? "")).toMatch(/private,\s*no-store/i);
    expect(String(workbench.headers["vary"] ?? "")).toMatch(/cookie/i);
    expect(String(workbench.headers["vary"] ?? "")).toMatch(/authorization/i);
    const workbenchParts = String(workbench.headers["vary"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    expect(workbenchParts.filter((p) => p === "cookie").length).toBe(1);
    expect(workbenchParts.filter((p) => p === "authorization").length).toBe(1);

    const pv = await request(app).get("/api/payment-vouchers").set("Authorization", "Bearer any");
    expect(pv.status).toBe(200);
    expect(String(pv.headers["cache-control"] ?? "")).toMatch(/private,\s*no-store/i);
    expect(String(pv.headers["vary"] ?? "")).toMatch(/cookie/i);
    expect(String(pv.headers["vary"] ?? "")).toMatch(/authorization/i);
    const pvParts = String(pv.headers["vary"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    expect(pvParts.filter((p) => p === "cookie").length).toBe(1);
    expect(pvParts.filter((p) => p === "authorization").length).toBe(1);

    const accounting = await request(app).get("/api/accounting/bank-accounts").set("Authorization", "Bearer any");
    expect(accounting.status).toBe(200);
    expect(String(accounting.headers["cache-control"] ?? "")).toMatch(/private,\s*no-store/i);
    expect(String(accounting.headers["vary"] ?? "")).toMatch(/cookie/i);
    expect(String(accounting.headers["vary"] ?? "")).toMatch(/authorization/i);
    const accountingParts = String(accounting.headers["vary"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    expect(accountingParts.filter((p) => p === "cookie").length).toBe(1);
    expect(accountingParts.filter((p) => p === "authorization").length).toBe(1);
  });

  it("sets private no-store for /api/* when auth cookie is present", async () => {
    const res = await request(app).get("/api/does-not-exist").set("Cookie", "auth_token=any");
    expect(res.status).toBe(404);
    expect(String(res.headers["cache-control"] ?? "")).toMatch(/private,\s*no-store/i);
    expect(String(res.headers["vary"] ?? "")).toMatch(/cookie/i);
    expect(String(res.headers["vary"] ?? "")).toMatch(/authorization/i);
  });
});
