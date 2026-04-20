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
  const isProd = process.env.NODE_ENV === "production";
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
