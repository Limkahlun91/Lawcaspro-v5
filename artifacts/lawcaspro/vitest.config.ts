import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV ??= "test";

export default defineConfig({
  test: {
    environment: "jsdom",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
    env: {
      NODE_ENV: "test",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
});
