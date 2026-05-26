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
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("/src/pages/app/documents/")) return "page_documents";
            if (id.includes("/src/pages/app/cases/")) return "page_cases";
            if (id.includes("/src/pages/app/accounting/")) return "page_accounting";
            if (id.includes("/src/pages/app/")) return "page_app";
            if (id.includes("/src/pages/")) return "page_misc";
            if (id.includes("/src/components/")) return "components";
            if (id.includes("/src/lib/")) return "lib";
            if (id.includes("/src/")) return "app_shared";

            if (!id.includes("node_modules")) return;

            if (id.includes("/node_modules/lucide-react/")) return "vendor_lucide";
            if (id.includes("/node_modules/recharts/")) return "vendor_recharts";
            if (id.includes("/node_modules/lodash-es/") || id.includes("/node_modules/lodash/")) return "vendor_lodash";
            if (id.includes("/node_modules/@mui/") || id.includes("/node_modules/mui/")) return "vendor_mui";

            const parts = id.split("node_modules/");
            const pkgPath = parts[parts.length - 1] || "";
            const pkgName = pkgPath.startsWith("@") ? pkgPath.split("/").slice(0, 2).join("/") : pkgPath.split("/")[0];
            if (!pkgName) return;
            return `vendor_${pkgName.replace(/^@/, "").replace(/[\/@]/g, "_")}`;
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
