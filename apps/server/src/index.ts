import "dotenv/config";
import app, { prisma, scannerReady } from "./app.js";
import { startBackupScheduler } from "./backups.js";
import { bootstrapLztTracker, shutdownLztTracker } from "./lzt-tracker.js";
import { bootstrapRustPriceScanner } from "./rust-price-scanner.js";
import { reconcileLegacyFailureLabels } from "./failure-label-reconciliation.js";
import { reconcileSharedFileStorage } from "./file-sharing.js";

await scannerReady;
const maintenanceProbe = process.env.FGP_MAINTENANCE_PROBE === "true";
if (!maintenanceProbe) {
  const sharedFileStorage = await reconcileSharedFileStorage();
  if (Object.values(sharedFileStorage).some((value) => value > 0)) {
    console.log(
      `Reconciled shared-file storage: ${JSON.stringify(sharedFileStorage)}`,
    );
  }
  try {
    const outcome = await reconcileLegacyFailureLabels();
    if (outcome.corrected > 0) {
      console.log(
        `Reclassified ${outcome.corrected} legacy scanner failure labels: ${JSON.stringify(outcome.byReason)}`,
      );
    }
  } catch (error) {
    console.error("Legacy failure label reconciliation skipped:", error);
  }
  await bootstrapRustPriceScanner();
  startBackupScheduler();
  await bootstrapLztTracker();
}
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () =>
  console.log(`FGP API on http://${host}:${port}`),
);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const forcedExit = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 80_000);
  forcedExit.unref();
  try {
    const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    const closeActiveConnections = setTimeout(
      () => server.closeAllConnections(),
      10_000,
    );
    closeActiveConnections.unref();
    if (!maintenanceProbe) await shutdownLztTracker();
    await serverClosed;
    await prisma.$disconnect();
    clearTimeout(closeActiveConnections);
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    console.error("Graceful shutdown failed", error);
    process.exit(1);
  }
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
