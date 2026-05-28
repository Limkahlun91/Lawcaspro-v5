import { describe, expect, it } from "vitest";
import { milestonePresenceWhereSql, normalizeMilestoneFilter } from "../lib/caseListLogic";

describe("caseListLogic milestone normalization", () => {
  it("maps step milestone + filled/missing to date milestone", () => {
    const out = normalizeMilestoneFilter("lof_stamped", "filled");
    expect(out.milestone).toBe("letter_of_offer_stamped_date");
    expect(out.presence).toBe("filled");
  });

  it("maps date milestone + completed/pending to step milestone", () => {
    const out = normalizeMilestoneFilter("letter_of_offer_stamped_date", "completed");
    expect(out.milestone).toBe("lof_stamped");
    expect(out.presence).toBe("completed");
  });

  it("builds workflow presence SQL for completed/pending", () => {
    const completed = milestonePresenceWhereSql("lof_stamped", "completed");
    const pending = milestonePresenceWhereSql("lof_stamped", "pending");
    expect(completed).toBeTruthy();
    expect(pending).toBeTruthy();
    expect(completed).not.toBe(pending);
  });
});

