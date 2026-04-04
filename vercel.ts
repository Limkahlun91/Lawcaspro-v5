function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

const upstream = process.env.API_SERVER_ORIGIN || process.env.VITE_API_BASE_URL;
const origin = upstream ? normalizeOrigin(upstream) : null;

const rewrites = [
  origin
    ? { source: "/api/:path*", destination: `${origin}/api/:path*` }
    : { source: "/api/:path*", destination: "/api/:path*" },
  { source: "/(.*)", destination: "/index.html" },
];

export default {
  version: 2,
  framework: "vite",
  installCommand: "pnpm install",
  buildCommand: "pnpm run build",
  outputDirectory: "artifacts/lawcaspro/dist/public",
  rewrites,
};

