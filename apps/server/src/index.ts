import "dotenv/config";
import app, { prisma, scannerReady } from "./app.js";
import { startBackupScheduler } from "./backups.js";

await scannerReady;
startBackupScheduler();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () =>
  console.log(`FGP API on http://${host}:${port}`),
);

async function close() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
