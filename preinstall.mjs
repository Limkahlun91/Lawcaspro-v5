import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();

const rmIfExists = (p) => {
  const abs = path.join(cwd, p);
  try {
    fs.rmSync(abs, { force: true });
  } catch {
  }
};

rmIfExists("package-lock.json");
rmIfExists("yarn.lock");

const ua = process.env.npm_config_user_agent ?? "";
if (!ua.startsWith("pnpm/")) {
  process.stderr.write("Use pnpm instead\n");
  process.exit(1);
}

