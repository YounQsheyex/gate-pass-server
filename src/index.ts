import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { connectDb, disconnectDb } from "./lib/db.js";
import { connectRedis, redis } from "./lib/redis.js";
import { assertSigningKey } from "./lib/ticketToken.js";
import { expireStaleOrders } from "./services/orders.js";
import { imageStorage } from "./lib/imageStorage.js";
import { mailProvider } from "./services/mailTransport.js";

const EXPIRY_SWEEP_MS = 5 * 60_000;

async function main() {
  assertSigningKey();
  await Promise.all([connectDb(), connectRedis()]);

  const server = createApp().listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
    console.log(`Event images are stored in: ${imageStorage}`);
    console.log(`Ticket emails: ${mailProvider}`);
  });

  // Release tickets held by unpaid orders. Safe to run on several instances at once:
  // each order is moved to "expired" with a conditional update, so it's only released once.
  const sweep = async () => {
    try {
      const n = await expireStaleOrders();
      if (n) console.log(`Expired ${n} unpaid order(s)`);
    } catch (err) {
      console.error("Order expiry sweep failed:", err);
    }
  };
  void sweep();
  const timer = setInterval(sweep, EXPIRY_SWEEP_MS);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    clearInterval(timer);
    server.close();
    await Promise.allSettled([disconnectDb(), redis.quit()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
