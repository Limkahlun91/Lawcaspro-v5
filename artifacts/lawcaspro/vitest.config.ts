import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
});
