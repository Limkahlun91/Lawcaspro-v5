import { describe, it, expect } from "vitest";
import {
  autoMapHeaders,
  applyRowMapping,
  type MappingTemplateDefinition,
} from "../modules/cases/legacy-import/mapping-engine.js";
import { M_LEGASI_PRESET_MAPPING } from "../modules/cases/legacy-import/legacy-case-field-catalog.js";
import { parseLegacyDate } from "../modules/cases/legacy-import/legacy-date-parser.js";

describe("legacy field mapping unit tests", () => {
  describe("autoMapHeaders", () => {
    it("autoMapHeaders maps M LEGASI Purchaser 1/2 with arrayIndex 0/1", () => {
      const headers = ["Purchaser 1", "Purchaser 1 IC", "Purchaser 2", "Purchaser 2 IC"];
      const result = autoMapHeaders(headers, M_LEGASI_PRESET_MAPPING);

      expect(result.columns.length).toBe(4);

      const p1Name = result.columns.find(
        (c) => c.excelHeader === "Purchaser 1"
      );
      expect(p1Name).toBeDefined();
      expect(p1Name?.target).toBe("purchaser.name");
      expect(p1Name?.arrayIndex).toBe(0);

      const p1Ic = result.columns.find(
        (c) => c.excelHeader === "Purchaser 1 IC"
      );
      expect(p1Ic).toBeDefined();
      expect(p1Ic?.target).toBe("purchaser.ic");
      expect(p1Ic?.arrayIndex).toBe(0);

      const p2Name = result.columns.find(
        (c) => c.excelHeader === "Purchaser 2"
      );
      expect(p2Name).toBeDefined();
      expect(p2Name?.target).toBe("purchaser.name");
      expect(p2Name?.arrayIndex).toBe(1);

      const p2Ic = result.columns.find(
        (c) => c.excelHeader === "Purchaser 2 IC"
      );
      expect(p2Ic).toBeDefined();
      expect(p2Ic?.target).toBe("purchaser.ic");
      expect(p2Ic?.arrayIndex).toBe(1);
    });

    it("autoMapHeaders maps Borrower 1/2/3/4 correctly with arrayIndex", () => {
      const headers = [
        "Borrower 1",
        "Borrower 1 IC",
        "Borrower 2",
        "Borrower 2 IC",
        "Borrower 3",
        "Borrower 3 IC",
        "Borrower 4",
        "Borrower 4 IC",
      ];
      const result = autoMapHeaders(headers, M_LEGASI_PRESET_MAPPING);

      expect(result.columns.length).toBe(8);

      for (let i = 1; i <= 4; i++) {
        const bName = result.columns.find(
          (c) => c.excelHeader === `Borrower ${i}`
        );
        expect(bName).toBeDefined();
        expect(bName?.target).toBe("borrower.name");
        expect(bName?.arrayIndex).toBe(i - 1);

        const bIc = result.columns.find(
          (c) => c.excelHeader === `Borrower ${i} IC`
        );
        expect(bIc).toBeDefined();
        expect(bIc?.target).toBe("borrower.ic");
        expect(bIc?.arrayIndex).toBe(i - 1);
      }
    });

    it("autoMapHeaders unknown headers do not crash - returns empty columns", () => {
      const headers = ["Random Column A", "Some Other Field", "Unknown Data"];
      const result = autoMapHeaders(headers, M_LEGASI_PRESET_MAPPING);
      expect(Array.isArray(result.columns)).toBe(true);
      expect(result.columns.length).toBe(0);
    });
  });

  describe("applyRowMapping", () => {
    it("applyRowMapping: propertyDetails.type maps to property.propertyType", () => {
      const rawRow = {
        type: "Terrace House",
      };
      const mapping: MappingTemplateDefinition = {
        columns: [{ excelHeader: "type", target: "property.propertyType" }],
      };
      const result = applyRowMapping(rawRow, mapping, parseLegacyDate);
      expect(result.property.propertyType).toBe("Terrace House");
    });

    it("applyRowMapping: unknown columns produce UNKNOWN_COLUMN warning + go to rawSnapshot", () => {
      const rawRow = {
        "weird column": "some value",
        type: "Terrace House",
      };
      const mapping: MappingTemplateDefinition = {
        columns: [{ excelHeader: "type", target: "property.propertyType" }],
      };
      const result = applyRowMapping(rawRow, mapping, parseLegacyDate);
      expect(result.warnings).toContain('UNKNOWN_COLUMN: header="weird column"');
      expect(result.rawSnapshot["weird column"]).toBe("some value");
      expect(result.rawSnapshot["type"]).toBe("Terrace House");
    });

    it("applyRowMapping: IGNORE target produces no structured output", () => {
      const rawRow = {
        developer: "Some Developer Sdn Bhd",
        type: "Condo",
      };
      const mapping: MappingTemplateDefinition = {
        columns: [
          { excelHeader: "developer", target: "IGNORE" },
          { excelHeader: "type", target: "property.propertyType" },
        ],
      };
      const result = applyRowMapping(rawRow, mapping, parseLegacyDate);
      expect(result.property.propertyType).toBe("Condo");
      expect(result.case).toEqual({});
      expect(result.property).not.toHaveProperty("developer");
      expect(result.rawSnapshot["developer"]).toBe("Some Developer Sdn Bhd");
      expect(result.warnings).not.toContain(
        expect.stringContaining("UNKNOWN_COLUMN")
      );
    });

    it("applyRowMapping: numeric RM stripping - spaPrice with 'RM 500,000.00' -> case.spaPrice = 500000", () => {
      const rawRow = {
        "purchase price": "RM 500,000.00",
      };
      const mapping: MappingTemplateDefinition = {
        columns: [{ excelHeader: "purchase price", target: "case.spaPrice" }],
      };
      const result = applyRowMapping(rawRow, mapping, parseLegacyDate);
      expect(result.case.spaPrice).toBe(500000);
    });

    it("applyRowMapping: keydate passes through dateParser", () => {
      const blankRow = { "spa date": "" };
      const unknownRow = { "spa date": "?" };
      const mapping: MappingTemplateDefinition = {
        columns: [{ excelHeader: "spa date", target: "keydate.spa_date" }],
      };

      const blankResult = applyRowMapping(blankRow, mapping, parseLegacyDate);
      expect(blankResult.keyDates).not.toHaveProperty("spa_date");
      const hasDateParseWarningBlank = blankResult.warnings.some((w) =>
        w.includes("DATE_PARSE_WARNING")
      );
      expect(hasDateParseWarningBlank).toBe(false);

      const unknownResult = applyRowMapping(unknownRow, mapping, parseLegacyDate);
      expect(unknownResult.keyDates).not.toHaveProperty("spa_date");
      const hasDateParseWarningUnknown = unknownResult.warnings.some((w) =>
        w.includes("DATE_PARSE_WARNING")
      );
      expect(hasDateParseWarningUnknown).toBe(false);
    });

    it("applyRowMapping: purchaser fields routed correctly with arrayIndex", () => {
      const rawRow = {
        "Purchaser 1": "John Doe",
        "Purchaser 1 IC": "800101-01-1234",
      };
      const mapping: MappingTemplateDefinition = {
        columns: [
          {
            excelHeader: "Purchaser 1",
            target: "purchaser.name",
            arrayIndex: 0,
          },
          {
            excelHeader: "Purchaser 1 IC",
            target: "purchaser.ic",
            arrayIndex: 0,
          },
        ],
      };
      const result = applyRowMapping(rawRow, mapping, parseLegacyDate);
      expect(result.purchasers[0].name).toBe("John Doe");
      expect(result.purchasers[0].ic).toBe("800101-01-1234");
      expect(result.purchasers[1]).toEqual({});
      expect(result.purchasers[2]).toEqual({});
      expect(result.purchasers[3]).toEqual({});
    });

    it("applyRowMapping: fixedValues merged into case/property", () => {
      const rawRow = {
        type: "Semi-D",
      };
      const mapping: MappingTemplateDefinition = {
        columns: [{ excelHeader: "type", target: "property.propertyType" }],
        fixedValues: {
          "case.caseType": "developer_sales",
          "property.description": "Premium unit",
        },
      };
      const result = applyRowMapping(rawRow, mapping, parseLegacyDate);
      expect(result.case.caseType).toBe("developer_sales");
      expect(result.property.propertyType).toBe("Semi-D");
      expect(result.property.description).toBe("Premium unit");
    });
  });
});
