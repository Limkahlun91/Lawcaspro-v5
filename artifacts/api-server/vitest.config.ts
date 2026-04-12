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
        "src/__tests__/sql-regression.test.ts",
        "src/__tests__/runtime-500-regression.test.ts",
        "src/__tests__/not-found-json.test.ts",
      ],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
