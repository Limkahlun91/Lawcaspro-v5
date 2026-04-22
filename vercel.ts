const rewrites = [{ source: "/((?!api(?:/|$)).*)", destination: "/index.html" }];

export default {
  version: 2,
  framework: "vite",
  installCommand: "pnpm install",
  buildCommand: "pnpm run build",
  outputDirectory: "artifacts/lawcaspro/dist/public",
  functions: {
    "api/[...path].ts": {
      runtime: "nodejs20.x",
    },
  },
  rewrites,
};
