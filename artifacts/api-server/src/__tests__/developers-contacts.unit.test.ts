import { describe, expect, it } from "vitest";
import { __test__ } from "../routes/developers";

describe("developers contacts parsing (no 500)", () => {
  it("parseContacts returns [] for empty/invalid inputs", () => {
    expect(__test__.parseContacts(null)).toEqual([]);
    expect(__test__.parseContacts("")).toEqual([]);
    expect(__test__.parseContacts("not-json")).toEqual([]);
    expect(__test__.parseContacts("{")).toEqual([]);
    expect(__test__.parseContacts("null")).toEqual([]);
    expect(__test__.parseContacts("{}")).toEqual([]);
    expect(__test__.parseContacts('{"name":"A"}')).toEqual([]);
  });

  it("parseContacts normalizes list and never returns null salutation", () => {
    const out = __test__.parseContacts(JSON.stringify([
      { name: " Alice ", salutation: undefined, department: null, phone: 123, phoneExt: undefined, email: "a@test.com" },
      { name: "Bob", salutation: "mr.", department: "Sales", phone: "+60", phoneExt: null, email: "" },
    ]));
    expect(out).toHaveLength(2);
    expect(out[0]?.salutation).toBe("");
    expect(out[0]?.name).toBe("Alice");
    expect(out[1]?.salutation).toBe("MR.");
  });

  it("normalizeContacts caps at 5 and drops empty names", () => {
    const out = __test__.normalizeContacts([
      { name: "" },
      { name: "A" },
      { name: "B" },
      { name: "C" },
      { name: "D" },
      { name: "E" },
      { name: "F" },
    ]);
    expect(out.map((c) => c.name)).toEqual(["A", "B", "C", "D", "E"]);
  });
});

