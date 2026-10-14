import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on("error", (err) => console.error("Redis error:", err.message));

/**
 * Safe to call even if something (e.g. the rate-limit store loading its
 * Lua script at import time) already triggered the connection.
 */
export async function connectRedis() {
  if (redis.status === "ready") return;

  if (redis.status === "wait" || redis.status === "end") {
    await redis.connect();
  } else {
    // "connecting" / "connect" / "reconnecting": wait for the in-flight attempt.
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onEnd = () => { cleanup(); reject(new Error("Redis connection closed")); };
      const cleanup = () => {
        redis.off("ready", onReady);
        redis.off("end", onEnd);
      };
      redis.once("ready", onReady);
      redis.once("end", onEnd);
    });
  }
  console.log("Redis connected");
}
