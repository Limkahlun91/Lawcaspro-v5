import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";
import { startSnapshotScheduler } from "./jobs/snapshot-scheduler";
import { startSnapshotRetentionCleanup } from "./jobs/snapshot-retention";
import { startCompletionSlaMonitor } from "./jobs/completion-sla-monitor";
import { startPaymentVoucherSlaMonitor } from "./jobs/payment-voucher-sla-monitor";
import { startCaseBottleneckMonitor } from "./jobs/case-bottleneck-monitor";

(function registerDeprecationSuppressions() {
  try {
    const suppressCodes = new Set(["DEP0169"]);
    const suppressMessageContains = ["url.parse() behavior is not standardized"];
    process.on("warning", (warning: Error & { code?: string; name?: string }) => {
      const code = warning?.code;
      const msg = typeof warning?.message === "string" ? warning.message : "";
      if (
        code &&
        suppressCodes.has(code) &&
        suppressMessageContains.some((needle) => msg.includes(needle))
      ) {
        return;
      }
      if (
        warning &&
        typeof process.emitWarning === "function" &&
        warning.name &&
        warning.message &&
        warning.name !== "DeprecationWarning"
      ) {
        console.warn(warning);
        return;
      }
      if (!code || !suppressCodes.has(code)) {
        console.warn(warning);
      }
    });
  } catch {
    // best-effort; ignore if process warning listener cannot be attached
  }
})();

console.log("!!! VERSION_CHECK: 43ca81e_DEB_LOG !!!");

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

seedIfEmpty().catch((err) => {
  logger.error({ err }, "Seed failed — continuing anyway");
});

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});

startSnapshotScheduler();
startSnapshotRetentionCleanup();
startCompletionSlaMonitor();
startPaymentVoucherSlaMonitor();
startCaseBottleneckMonitor();

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
