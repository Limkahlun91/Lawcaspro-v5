import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "node:url";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const isBuild = process.argv.includes("build");

const rawPort = process.env.PORT;
let port = 3000;

if (rawPort) {
  const parsed = Number(rawPort);
  if (!Number.isNaN(parsed) && parsed > 0) {
    port = parsed;
  }
} else if (!isBuild) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const basePath = process.env.BASE_PATH || "/";

export default defineConfig(async () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const isProd = process.env.NODE_ENV === "production" || isBuild;
  const isReplit = process.env.REPL_ID !== undefined;

  const plugins: PluginOption[] = [
    react(),
    tailwindcss(),
    ...(!isProd ? [runtimeErrorOverlay()] : []),
    ...(isProd || !isReplit
      ? []
      : [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]),
  ];


  return {
    base: basePath,
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(dirname, "src"),
        "@assets": path.resolve(dirname, "..", "..", "attached_assets"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(dirname),
    build: {
      outDir: path.resolve(dirname, "dist/public"),
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, "/");

            if (normalized.includes("node_modules/")) {
              const after = normalized.split("node_modules/").pop() ?? "";
              const top = after.split("/")[0] ?? "";
              return top || undefined;
            }

            if (normalized.includes("/src/components/ui/")) return "ui-components";
            if (normalized.includes("/src/pages/app/documents/")) return "page_documents";
            if (normalized.includes("/src/pages/app/cases/")) return "page_cases";
            if (normalized.includes("/src/pages/app/accounting/")) return "page_accounting";
            if (normalized.includes("/src/pages/app/")) return "page_app";
            if (normalized.includes("/src/pages/")) return "page_misc";
          },
        },
      },
    },
    server: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
