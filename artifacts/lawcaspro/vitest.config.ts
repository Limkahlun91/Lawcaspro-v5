import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DATABASE_URL ??= "postgresql://fake:fake@localhost:5432/fake";
process.env.NODE_ENV ??= "test";
process.env.VITEST_SKIP_DB ??= "1";

export default defineConfig({
  test: {
    environment: "jsdom",
    env: {
      DATABASE_URL: "postgresql://fake:fake@localhost:5432/fake",
      VITEST_SKIP_DB: "1",
      NODE_ENV: "test",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
});
