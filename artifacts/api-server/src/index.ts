import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";
import { startSnapshotScheduler } from "./jobs/snapshot-scheduler";
import { startSnapshotRetentionCleanup } from "./jobs/snapshot-retention";
import { startCompletionSlaMonitor } from "./jobs/completion-sla-monitor";
import { startPaymentVoucherSlaMonitor } from "./jobs/payment-voucher-sla-monitor";
import { startCaseBottleneckMonitor } from "./jobs/case-bottleneck-monitor";

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
