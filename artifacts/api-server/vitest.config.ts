import { defineConfig } from "vitest/config";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 15000,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: hasDatabaseUrl
      ? ["src/__tests__/**/*.test.ts"]
      : [
        "src/__tests__/auth-mocked-regression.test.ts",
        "src/__tests__/users-hub-regression.test.ts",
        "src/__tests__/sql-regression.test.ts",
        "src/__tests__/runtime-500-regression.test.ts",
        "src/__tests__/not-found-json.test.ts",
        "src/__tests__/dateOnly.test.ts",
        "src/__tests__/caseWorkflowDocuments.unit.test.ts",
        "src/__tests__/loanStamping.unit.test.ts",
        "src/__tests__/workflowAutomation.unit.test.ts",
        "src/__tests__/documentApplicability.unit.test.ts",
        "src/__tests__/documentReadiness.unit.test.ts",
        "src/__tests__/documentNaming.unit.test.ts",
      ],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
