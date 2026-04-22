const rewrites = [
  { source: "/api/:path*", destination: "/api/:path*" },
  { source: "/((?!api(?:/|$)).*)", destination: "/index.html" },
];

export default {
  version: 2,
  framework: "vite",
  installCommand: "pnpm install",
  buildCommand: "pnpm run build",
  outputDirectory: "artifacts/lawcaspro/dist/public",
  rewrites,
};

