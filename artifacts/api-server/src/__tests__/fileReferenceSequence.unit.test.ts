import { describe, expect, it } from "vitest";
import {
  computeEffectiveNextNumber,
  extractRunningNumber,
  renderFileReferencePattern,
} from "../lib/fileReferenceSequence";

describe("file reference sequence", () => {
  const now = new Date("2026-01-15T09:00:00Z");

  it("renders developer sales starting number 4000", () => {
    const sequence = computeEffectiveNextNumber({
      startingSequence: 4000,
      currentSequence: 4000,
      highestExistingNumber: null,
    });
    const reference = renderFileReferencePattern(
      "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
      {
        now,
        seq: sequence.nextNumber,
        developerCode: "MS",
        projectCode: "LEGASI",
        lawyerInitials: "FYS",
        clerkInitials: "GHY",
      },
    );

    expect(sequence.startingNumber).toBe(4000);
    expect(sequence.nextNumber).toBe(4000);
    expect(reference).toBe("CON/MS-LEGASI/4000/26(FYS)GHY");
  });

  it("continues from highest existing approved number", () => {
    const pattern = "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}";
    const existing = "CON/MS-LEGASI/4005/26(FYS)GHY";

    expect(extractRunningNumber(existing, pattern)).toBe(4005);

    const sequence = computeEffectiveNextNumber({
      startingSequence: 4000,
      currentSequence: 4000,
      highestExistingNumber: 4005,
    });
    const reference = renderFileReferencePattern(pattern, {
      now,
      seq: sequence.nextNumber,
      developerCode: "MS",
      projectCode: "LEGASI",
      lawyerInitials: "FYS",
      clerkInitials: "GHY",
    });

    expect(sequence.nextNumber).toBe(4006);
    expect(sequence.sequenceWarning).toBe("This number is lower than existing references. The system will continue from the highest existing number.");
    expect(reference).toBe("CON/MS-LEGASI/4006/26(FYS)GHY");
  });

  it("renders subsale and perfection starting numbers", () => {
    const subsale = renderFileReferencePattern(
      "CON/SS/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
      {
        now,
        seq: 1000,
        lawyerInitials: "FYS",
        clerkInitials: "LKL",
      },
    );
    const perfection = renderFileReferencePattern(
      "CON/PFT/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
      {
        now,
        seq: 2000,
        lawyerInitials: "FYS",
        clerkInitials: "LKL",
      },
    );

    expect(subsale).toBe("CON/SS/1000/26(FYS)LKL");
    expect(perfection).toBe("CON/PFT/2000/26(FYS)LKL");
  });

  it("pads sequence numbers for SEQ:3 and SEQ:4 without truncating larger values", () => {
    expect(renderFileReferencePattern("REF/{SEQ:3}", { now, seq: 1 })).toBe("REF/001");
    expect(renderFileReferencePattern("REF/{SEQ:3}", { now, seq: 25 })).toBe("REF/025");
    expect(renderFileReferencePattern("REF/{SEQ:3}", { now, seq: 1000 })).toBe("REF/1000");
    expect(renderFileReferencePattern("REF/{SEQ:4}", { now, seq: 1 })).toBe("REF/0001");
    expect(renderFileReferencePattern("REF/{SEQ:4}", { now, seq: 25 })).toBe("REF/0025");
    expect(renderFileReferencePattern("REF/{SEQ:4}", { now, seq: 1000 })).toBe("REF/1000");
  });
});
