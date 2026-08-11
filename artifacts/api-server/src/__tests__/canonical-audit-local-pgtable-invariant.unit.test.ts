/**
 * PART 1 D - Invariant tests: service-local pgTable declaration removal
 *
 * The 3 audit tables MUST be declared canonically in @workspace/db schema.
 * No service file is allowed to declare its own pgTable() for:
 *   - hims_notification_audit
 *   - communication_case_task_link_audit
 *   - einvoice_submission_audit
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "modules");

const FILES: Array<{ rel: string; forbiddenSubstrings: string[] }> = [
  {
    rel: "hims/hims-notification-idempotency.service.ts",
    forbiddenSubstrings: ['pgTable("hims_notification_audit"', "pgTable('hims_notification_audit'"],
  },
  {
    rel: "communication/email-case-task-link.service.ts",
    forbiddenSubstrings: [
      'pgTable("communication_case_task_link_audit"',
      "pgTable('communication_case_task_link_audit'",
    ],
  },
  {
    rel: "accounting/einvoice-adapter-boundary.service.ts",
    forbiddenSubstrings: ['pgTable("einvoice_submission_audit"', "pgTable('einvoice_submission_audit'"],
  },
];

describe("PART 1D — Canonical Audit Table invariant: no local pgTable in services", () => {
  for (const entry of FILES) {
    it(`${entry.rel}: does not declare its own audit pgTable`, () => {
      const full = path.join(ROOT, entry.rel);
      expect(fs.existsSync(full)).toBe(true);
      const src = fs.readFileSync(full, "utf8");
      for (const needle of entry.forbiddenSubstrings) {
        expect(src).not.toContain(needle);
      }
    });

    it(`${entry.rel}: imports audit table via @workspace/db canonical export`, () => {
      const full = path.join(ROOT, entry.rel);
      const src = fs.readFileSync(full, "utf8");
      expect(src).toContain('from "@workspace/db"');
    });
  }
});
