const rewrites = [
  { source: "/api", destination: "/api" },
  { source: "/api/(.*)", destination: "/api?__path=$1" },
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
