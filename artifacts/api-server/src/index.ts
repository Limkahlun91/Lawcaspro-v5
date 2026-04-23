import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";
import { startSnapshotScheduler } from "./jobs/snapshot-scheduler";
import { startSnapshotRetentionCleanup } from "./jobs/snapshot-retention";

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

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
