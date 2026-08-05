import { describe, it, expect, vi } from "vitest";
import { handleAccountingCaseSearch } from "../routes/accounting";

function makeRes() {
  return { json: vi.fn() } as any;
}

describe("GET /api/accounting/cases/search contract", () => {
  it("returns wrapped contract with items[] and pagination", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { id: 1, reference_no: "CON-001", status: "open", project_name: "P1", developer_name: "D1" },
      ],
    });
    const req = {
      id: "req_test",
      firmId: 123,
      query: { query: "CON", limit: "20" },
      rlsDb: { execute },
    } as any;
    const res = makeRes();

    await handleAccountingCaseSearch(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveProperty("items");
    expect(Array.isArray(payload.data.items)).toBe(true);
    expect(payload.data).toHaveProperty("pagination");
    expect(payload.meta).toHaveProperty("duration_ms");

    const item = payload.data.items[0];
    expect(Object.keys(item).sort()).toEqual(["developerName", "id", "projectName", "purchaserLabel", "purchaserNames", "referenceNo", "shortLabel", "status"].sort());
  });

  it("enforces max limit=50", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const req = {
      firmId: 123,
      query: { query: "CON", limit: "999" },
      rlsDb: { execute },
    } as any;
    const res = makeRes();

    await handleAccountingCaseSearch(req, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.pagination.limit).toBe(50);
  });

  it("returns empty items when query is too short", async () => {
    const execute = vi.fn();
    const req = {
      firmId: 123,
      query: { query: "C", limit: "20" },
      rlsDb: { execute },
    } as any;
    const res = makeRes();

    await handleAccountingCaseSearch(req, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.data.items).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
